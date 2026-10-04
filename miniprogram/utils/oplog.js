/**
 * utils/oplog.js —— 数据操作日志（本地环形缓冲 + 云端批量上报）
 *
 * 职责：记录 tasks / knowledge 集合的每次读写结果（动作/文档ID/成败/错误类型/耗时），
 * 用于后期维护与问题排查（如"某条任务为何丢失""某次写入为何失败"）。
 *
 * 设计（写失败时日志也不能丢）：
 * 1. 本地先行：每次操作追加到 Storage 环形缓冲（key: po_op_logs，最多 200 条，满则淘汰最旧）
 *    —— Storage 持久化，断网/写库失败/小程序被杀日志都在
 * 2. 机会式上云：缓冲攒够 FLUSH_THRESHOLD（20 条）或 initDatabase 成功后，
 *    批量写入云端 op_logs 集合并清空已上报部分；失败静默保留（下次再试）
 * 3. 上云节流：两次 flush 至少间隔 60s，避免高频小批量写入
 *
 * op_logs 集合文档结构（客户端写入，_openid 自动附加，"仅创建者可读写"）：
 * { _openid, collection, action, docId, ok, errType, errMsg, costMs, clientTs, createdAt }
 * 建议索引：(_openid 升序, createdAt 降序) —— 按用户查最近日志
 */

const STORAGE_KEY = 'po_op_logs'
const FLUSH_TS_KEY = 'po_op_flush_ts'
const MAX_LOCAL = 200 // 本地环形缓冲上限
const FLUSH_THRESHOLD = 20 // 攒够多少条触发机会式上云
const FLUSH_MIN_INTERVAL = 60 * 1000 // 两次上云最小间隔
const CHUNK_SIZE = 10 // 每批并发写入条数
const OP_LOGS_COLLECTION = 'op_logs'

/** 读取本地日志缓冲（异常兜底空数组） */
function readBuffer() {
  try {
    const list = wx.getStorageSync(STORAGE_KEY)
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

/** 写回本地日志缓冲（环形裁剪到 MAX_LOCAL） */
function writeBuffer(list) {
  try {
    wx.setStorageSync(STORAGE_KEY, list.slice(-MAX_LOCAL))
  } catch (e) {
    console.warn('[oplog] 日志写入本地存储失败', e)
  }
}

/**
 * 记录一条操作日志（同步、廉价，不抛错——日志永远不能影响主流程）。
 * @param {Object} op { collection, action, docId?, ok, errType?, errMsg?, costMs? }
 */
function logOp(op) {
  try {
    const entry = {
      collection: String((op && op.collection) || ''),
      action: String((op && op.action) || ''),
      docId: op && op.docId ? String(op.docId).slice(0, 64) : '',
      ok: op && op.ok === true,
      errType: (op && op.errType) || '',
      errMsg: op && op.errMsg ? String(op.errMsg).slice(0, 120) : '',
      costMs: Number((op && op.costMs) || 0),
      clientTs: Date.now(),
    }
    const list = readBuffer()
    list.push(entry)
    writeBuffer(list)
  } catch (e) {
    // 日志自身失败仅打印，不上抛
  }
}

/** 读取最近 n 条日志（排查用，控制台/未来调试页可调用） */
function getRecentOps(n) {
  const list = readBuffer()
  return n ? list.slice(-n) : list
}

let flushing = false

/**
 * 批量上报日志到云端 op_logs 集合（fire-and-forget，调用方无需 await）。
 * 仅云模式下有意义；本地模式下日志只留在本机（云端不可见，属预期降级）。
 * @param {Function} getDb 可选，注入 wx.cloud.database（便于测试）；缺省自行获取
 */
async function flushOpLogs(getDb) {
  if (flushing) return
  // 节流：距上次成功发起不足间隔则跳过
  try {
    const last = Number(wx.getStorageSync(FLUSH_TS_KEY) || 0)
    if (Date.now() - last < FLUSH_MIN_INTERVAL) return
  } catch (e) {
    /* 读取失败继续尝试 */
  }

  const list = readBuffer()
  if (!list.length) return

  flushing = true
  try {
    const db = typeof getDb === 'function' ? getDb() : wx.cloud.database()
    wx.setStorageSync(FLUSH_TS_KEY, Date.now())
    let uploaded = 0
    // 分批并发写入（每批 CHUNK_SIZE 条）
    for (let i = 0; i < list.length; i += CHUNK_SIZE) {
      const chunk = list.slice(i, i + CHUNK_SIZE)
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(
        chunk.map((entry) =>
          db.collection(OP_LOGS_COLLECTION).add({
            data: Object.assign({}, entry, { createdAt: Date.now() }),
          })
        )
      )
      uploaded += chunk.length
    }
    // 仅清空已成功上报部分（失败时保留，下次重试）
    writeBuffer(list.slice(uploaded))
  } catch (e) {
    console.warn('[oplog] 日志上报云端失败（本地保留，稍后重试）', e)
  } finally {
    flushing = false
  }
}

/** 本地缓冲是否已攒够触发阈值（供 api.js 写操作后机会式 flush 判断） */
function shouldFlush() {
  return readBuffer().length >= FLUSH_THRESHOLD
}

module.exports = {
  logOp,
  getRecentOps,
  flushOpLogs,
  shouldFlush,
}
