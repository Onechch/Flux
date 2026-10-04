/**
 * utils/dberrors.js —— 云数据库错误分类 + 读操作退避重试
 *
 * 职责：
 * 1. 把云数据库/云函数抛出的各种原始错误（errMsg 英文串、errCode 数字）归类为
 *    固定类型：validation / network / permission / notfound / collection / limit / unknown，
 *    并给出面向用户的中文提示（DbError.friendlyMessage）——页面 catch 后可直接 toast。
 * 2. withRetry：仅对幂等读操作做网络类错误自动重试（默认 1 次、间隔 1s），
 *    写操作不自动重试（add 重试有重复写入风险，失败上抛由用户手动重试）。
 *
 * 常见云数据库错误特征（errCode / errMsg 模式）：
 * - 权限：-502001 / permission denied / AUTHENTICATION
 * - 文档不存在：document not exists / -502005
 * - 集合不存在：collection not exists / -501001
 * - 网络：request:fail / timeout / network error
 */

/** 分类后的数据库错误：type 见上，message 为中文提示，raw/errCode 保留原始信息 */
function DbError(type, message, raw, errCode) {
  this.name = 'DbError'
  this.type = type
  this.message = message
  this.raw = raw
  this.errCode = errCode
  this.retryable = type === 'network' || type === 'limit'
}
DbError.prototype = Object.create(Error.prototype)
DbError.prototype.constructor = DbError

/** 各类型默认中文提示 */
const FRIENDLY_MESSAGES = {
  validation: '数据不合法，请检查后重试',
  network: '网络不稳定，请稍后重试',
  permission: '没有操作权限，请检查云数据库安全规则',
  notfound: '数据不存在或已被删除',
  collection: '数据集合未初始化，请重新进入页面',
  limit: '操作过于频繁，请稍后重试',
  unknown: '操作失败，请重试',
}

/**
 * 错误归类。优先识别本模块/ validation 抛出的带类型错误，
 * 再按 errCode / errMsg 特征匹配，兜底 unknown。
 * @param {Error|Object|string} e 原始错误
 * @returns {DbError}
 */
function classifyDbError(e) {
  // 已是 DbError / ValidationError（validation.js），直接包装透传
  if (e && e.name === 'ValidationError') {
    return new DbError('validation', e.message, e.message, e.errCode)
  }
  if (e && e.name === 'DbError') return e

  const msg = String((e && (e.errMsg || e.message)) || e || '')
  const code = e && e.errCode

  // 数据校验错误（云数据库 schema 校验）
  if (code === -502004 || /invalid data|schema/i.test(msg)) {
    return new DbError('validation', '数据不合法：' + msg.slice(0, 60), msg, code)
  }
  // 权限问题（安全规则拒绝）
  if (
    code === -502001 ||
    code === -502002 ||
    /permission|denied|not authorized|auth/i.test(msg)
  ) {
    return new DbError('permission', FRIENDLY_MESSAGES.permission, msg, code)
  }
  // 集合不存在（未初始化）—— 需先于"文档不存在"检查，避免 "collection not exists" 被误吞
  if (code === -501001 || /collection.*not exist|COLLECTION_NOT_EXIST/i.test(msg)) {
    return new DbError('collection', FRIENDLY_MESSAGES.collection, msg, code)
  }
  // 文档不存在
  if (code === -502005 || /not exist|not found|DOCUMENT_NOT_FOUND/i.test(msg)) {
    return new DbError('notfound', FRIENDLY_MESSAGES.notfound, msg, code)
  }
  // 限流（429）
  if (code === 429 || /429|too many requests|rate.?limit|EXCEED_CONCURRENT/i.test(msg)) {
    return new DbError('limit', FRIENDLY_MESSAGES.limit, msg, code)
  }
  // 网络异常（超时/断网/请求失败）
  if (
    code === -1 ||
    /request:fail|network|timeout|abort|conn(ect)?ion|ENET|ECONN/i.test(msg)
  ) {
    return new DbError('network', FRIENDLY_MESSAGES.network, msg, code)
  }
  return new DbError('unknown', FRIENDLY_MESSAGES.unknown, msg, code)
}

/**
 * 幂等读操作自动重试：仅网络/限流类错误重试（其他类型立即上抛）。
 * @param {Function} fn 返回 Promise 的读操作
 * @param {Object} opts { retries: 1, backoffMs: 1000 }
 *   重试节奏遵循项目约定：首错退避 1s（数据量小、单次读成本低，快失败快重试）。
 */
async function withRetry(fn, opts = {}) {
  const retries = opts.retries === undefined ? 1 : opts.retries
  const backoffMs = opts.backoffMs === undefined ? 1000 : opts.backoffMs
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastError = e
      const c = e && e.name === 'DbError' ? e : classifyDbError(e)
      if (!c.retryable || attempt === retries) break
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
    }
  }
  throw lastError
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

module.exports = {
  DbError,
  classifyDbError,
  withRetry,
  FRIENDLY_MESSAGES,
}
