/**
 * utils/api.js —— 数据访问层（校验 → 加密 → 写入 → 日志）
 *
 * 策略：云数据库优先（wx.cloud.database），云环境/云函数不可用时自动降级为本地存储，
 * 保证开发工具中未部署云函数时页面仍可完整体验（约束4：错误降级方案）。
 *
 * 数据管道（本次加固，详见各子模块）：
 * 1. 写入前置校验（utils/validation.js）：脏数据不落库，文本超长自动截断
 * 2. 敏感字段加密（utils/crypto.js）：userContext.text 落库密文（XXTEA），
 *    读取时透明解密；云函数直写的明文（无 enc1: 前缀）原样兼容
 * 3. 错误分类（utils/dberrors.js）：网络/权限/校验/不存在归类为 DbError，
 *    中文提示可直接 toast；读操作网络错误自动重试 1 次
 * 4. 操作日志（utils/oplog.js）：每次读写记录到本地环形缓冲（断网不丢），
 *    攒批上报云端 op_logs 集合，供后期维护排查
 *
 * 数据模型与云数据库 tasks 集合 schema 保持一致：
 * { _id, title, description, estimatedHours, actualHours, status,
 *   isBottleneck, dependencies, projectId, parentGoalId, level, aiHint,
 *   userContext, suggestionHistory,
 *   createdAt, updatedAt, modificationCount }
 *
 * 多层级任务树（动态拆解 1-5 层，见 utils/tree.js）：
 * - 大目标（level 0，parentGoalId 为空）：首页展示与瓶颈识别的基本单位
 * - 子任务（level 1..5，parentGoalId 指向直接父节点）：
 *   全部直接子任务完成后父节点自动完成，逐层向上传播
 *
 * status 取值：'pending' | 'locked' | 'in_progress' | 'completed'
 */

const validation = require('./validation')
const crypto = require('./crypto')
const dberrors = require('./dberrors')
const oplog = require('./oplog')

const COLLECTION = 'tasks'
const LOCAL_KEY = 'po_tasks'

// 会触发"修改次数"计数的字段（供波动预警页做牛鞭效应检测）。
// 注意：status 不在其中 —— 瓶颈自动流转（pending/locked/in_progress/completed）
// 属于系统行为，不应计入人工修改次数，否则会污染牛鞭效应检测。
const MEANINGFUL_FIELDS = [
  'title',
  'description',
  'estimatedHours',
  'dependencies',
  'projectId',
]

// 当前数据模式：'cloud' | 'local'
let mode = 'cloud'

function getMode() {
  return mode
}

/**
 * 执行一次数据库操作并记录操作日志。
 * 失败时错误归类为 DbError（含中文提示）上抛，页面 catch 后可直接 toast e.message。
 * @param {string} collection 集合名（日志用）
 * @param {string} action 动作：create | update | delete | read
 * @param {string} docId 文档 ID（可为空）
 * @param {Function} fn 实际执行的操作（返回 Promise）
 * @param {Object} opts { retry: true } 时对网络类错误自动重试（仅幂等读操作使用）
 */
async function runLogged(collection, action, docId, fn, opts = {}) {
  const start = Date.now()
  const run = opts.retry ? () => dberrors.withRetry(fn) : fn
  try {
    const result = await run()
    oplog.logOp({ collection, action, docId, ok: true, costMs: Date.now() - start })
    if (action !== 'read' && oplog.shouldFlush()) {
      oplog.flushOpLogs() // 机会式批量上报（fire-and-forget，失败本地保留）
    }
    return result
  } catch (e) {
    const c = dberrors.classifyDbError(e)
    oplog.logOp({
      collection,
      action,
      docId,
      ok: false,
      errType: c.type,
      errMsg: c.raw || c.message,
      costMs: Date.now() - start,
    })
    throw c
  }
}

/**
 * 调用云函数 initDatabase 创建 tasks / projects / knowledge / op_logs 集合（幂等）。
 * 失败（未部署/无环境）则降级为本地存储模式。
 */
async function initDatabase() {
  try {
    const res = await wx.cloud.callFunction({ name: 'initDatabase' })
    if (res.result && res.result.success) {
      mode = 'cloud'
      // 补报上次积累的操作日志（fire-and-forget，失败静默保留待下次）
      oplog.flushOpLogs()
      return true
    }
  } catch (e) {
    console.warn('[api] initDatabase 云函数不可用，降级为本地存储模式', e)
  }
  mode = 'local'
  return false
}

/**
 * 归一化文档字段，兜底默认值（缺 parentGoalId/level 的旧数据按大目标处理）。
 * userContext.text 若为密文（enc1: 前缀）则透明解密；解密失败（换设备/密钥丢失）返回空串。
 */
function normalize(doc) {
  const rawCtx = doc.userContext
  const userContext = rawCtx
    ? {
        tags: rawCtx.tags || [],
        text:
          typeof rawCtx.text === 'string' && rawCtx.text
            ? crypto.decryptText(rawCtx.text)
            : '',
        submittedAt: rawCtx.submittedAt || 0,
        version: rawCtx.version || 1,
      }
    : null
  return {
    _id: doc._id,
    title: doc.title || '',
    description: doc.description || '',
    estimatedHours: doc.estimatedHours || 0,
    actualHours: doc.actualHours || 0,
    status: doc.status || 'pending',
    isBottleneck: !!doc.isBottleneck,
    dependencies: doc.dependencies || [],
    projectId: doc.projectId || '',
    parentGoalId: doc.parentGoalId || '',
    level: doc.level || 0,
    aiHint: doc.aiHint || '',
    // 补充情况（用户在瓶颈卡片就地补充的上下文，Agent 据此重新生成建议）：
    // { tags: ['试过没用','等别人'], text, submittedAt, version }
    userContext: userContext,
    // 建议生成历史（每次基于补充情况重新生成时追加，保留最近 5 条）：
    // [{ version, suggestions, generatedAt, basedOn: 'user_context', source: 'ai'|'rule' }]
    suggestionHistory: Array.isArray(doc.suggestionHistory) ? doc.suggestionHistory : [],
    createdAt: doc.createdAt || 0,
    updatedAt: doc.updatedAt || 0,
    modificationCount: doc.modificationCount || 0,
  }
}

/** 是否大目标（level 0） */
function isGoal(task) {
  return !task.parentGoalId
}

// 云数据库单次查询上限 100 条；分页取全（多层级任务树单个目标就可能有几十个节点，
// 不分页会把最新创建的任务截断掉，表现为"采纳后目标在首页消失"）
const PAGE_SIZE = 100
const MAX_PAGES = 20 // 分页安全上限（2000 条），异常时避免无限翻页

/**
 * 读取全部任务（按创建时间升序；网络错误自动重试 1 次，失败记日志并抛 DbError）。
 * 分页取全：只用 orderBy + skip + limit（云开发最基础、无额外索引要求的组合），
 * 按 _id 去重防止同 createdAt 边界重复。多层级任务树单个目标就可能有几十个节点，
 * 不分页会把最新创建的任务截断掉，表现为"采纳后目标在首页消失"。
 */
async function loadTasks() {
  if (mode === 'local') {
    return (wx.getStorageSync(LOCAL_KEY) || []).map(normalize)
  }
  const db = wx.cloud.database()
  const rows = []
  const seen = {}
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await runLogged(COLLECTION, 'read', '', () =>
      db
        .collection(COLLECTION)
        .orderBy('createdAt', 'asc')
        .skip(page * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .get()
    , { retry: true })
    const batch = res.data || []
    batch.forEach((d) => {
      if (seen[d._id]) return
      seen[d._id] = true
      rows.push(d)
    })
    if (batch.length < PAGE_SIZE) break // 已取完
  }
  return rows.map(normalize)
}

/**
 * 新增任务。
 * 写入前经 validation.validateTaskInput 校验（title 必填、类型/范围检查、超长截断），
 * 非法数据抛 ValidationError（中文提示）。
 * level 0（默认）= 大目标；level 1..5 = 各层子任务，parentGoalId 指向直接父节点
 * （多层级任务树：动态拆解 1-5 层，见 utils/tree.js）。
 * dependencies 传入"任务ID列表"（与 tasks 集合 schema 一致，仅同层引用）；
 * 从流程拆解页导入时，由页面负责将"任务名"映射为已创建任务的 _id 后再回填。
 * aiHint：AI 拆解标记的卡点原因（如"表达量不达标，需优化条件"），
 * 供首页每层瓶颈识别（"被标记为卡住"优先级最高）。
 */
async function addTask(params) {
  const input = validation.validateTaskInput(params || {})
  const now = Date.now()
  const doc = {
    title: input.title,
    description: input.description || '',
    estimatedHours: input.estimatedHours === undefined ? 1 : input.estimatedHours,
    actualHours: 0,
    status: 'pending',
    isBottleneck: false,
    dependencies: input.dependencies || [],
    projectId: input.projectId || '',
    parentGoalId: input.parentGoalId || '',
    level: input.level === undefined ? 0 : input.level,
    aiHint: input.aiHint || '',
    createdAt: now,
    updatedAt: now,
    modificationCount: 0,
  }
  if (mode === 'local') {
    doc._id = 'local_' + now + '_' + Math.floor(Math.random() * 10000)
    return runLogged(COLLECTION, 'create', doc._id, () => {
      const list = wx.getStorageSync(LOCAL_KEY) || []
      list.push(doc)
      wx.setStorageSync(LOCAL_KEY, list)
      return Promise.resolve(normalize(doc))
    })
  }
  const db = wx.cloud.database()
  const res = await runLogged(COLLECTION, 'create', '', () =>
    db.collection(COLLECTION).add({ data: doc })
  )
  return normalize(Object.assign({}, doc, { _id: res._id }))
}

/**
 * 更新任务（partial patch）。
 * - 写入前经 validateTaskPatch 校验已知字段（未知字段透传，兼容内部调用）
 * - userContext.text 落库前加密（enc1: 前缀密文），读取时由 normalize 透明解密
 * - 仅当修改了"有业务含义"的字段时才累加 modificationCount（牛鞭效应检测用）。
 *   opts.countModification === false 时表示系统自动流转（如瓶颈锁定/解锁），
 *   不计入修改次数。默认 true（用户主动编辑）。
 */
async function updateTask(id, patch = {}, opts = {}) {
  const docId = validation.validateDocId(id, '任务')
  // 已知字段规范化（trim/截断/结构校验），未知字段保留原值
  const known = validation.validateTaskPatch(patch)
  const clean = Object.assign({}, patch, known)
  // 敏感字段加密：userContext.text 密文落库（已加密则跳过，防二次加密）
  if (clean.userContext && typeof clean.userContext.text === 'string' && clean.userContext.text) {
    clean.userContext = Object.assign({}, clean.userContext, {
      text: crypto.encryptText(clean.userContext.text),
    })
  }

  const countModification = opts.countModification !== false
  const bump =
    countModification && Object.keys(clean).some((k) => MEANINGFUL_FIELDS.indexOf(k) > -1)
  const now = Date.now()
  if (mode === 'local') {
    return runLogged(COLLECTION, 'update', docId, () => {
      const list = wx.getStorageSync(LOCAL_KEY) || []
      const i = list.findIndex((t) => t._id === docId)
      if (i === -1) return Promise.resolve()
      list[i] = Object.assign({}, list[i], clean, {
        updatedAt: now,
        modificationCount: (list[i].modificationCount || 0) + (bump ? 1 : 0),
      })
      wx.setStorageSync(LOCAL_KEY, list)
      return Promise.resolve()
    })
  }
  const db = wx.cloud.database()
  const data = Object.assign({}, clean, { updatedAt: now })
  if (bump) data.modificationCount = db.command.inc(1)
  await runLogged(COLLECTION, 'update', docId, () =>
    db.collection(COLLECTION).doc(docId).update({ data })
  )
}

/**
 * 删除任务（幂等：文档已不存在视为删除成功，不报错）。
 */
async function removeTask(id) {
  const docId = validation.validateDocId(id, '任务')
  if (mode === 'local') {
    return runLogged(COLLECTION, 'delete', docId, () => {
      const list = (wx.getStorageSync(LOCAL_KEY) || []).filter((t) => t._id !== docId)
      wx.setStorageSync(LOCAL_KEY, list)
      return Promise.resolve()
    })
  }
  const db = wx.cloud.database()
  try {
    await runLogged(COLLECTION, 'delete', docId, () =>
      db.collection(COLLECTION).doc(docId).remove()
    )
  } catch (e) {
    if (e && e.type === 'notfound') return // 已被删除 → 目标已达成
    throw e
  }
}

/**
 * 瓶颈识别（约束理论 TOC）—— 只认未完成的大目标：
 * - 若有进行中的大目标，它就是唯一焦点（杜绝多任务切换）
 * - 否则取"预估耗时 + 依赖数量 × 2"得分最高的未完成大目标作为瓶颈
 * 已完成的大目标在此处显式排除：调用方可能直接传入全量任务列表，
 * 不能依赖"只传未完成任务"的调用约定（否则已完成的目标会被选为瓶颈）。
 */
function computeBottleneck(unfinishedTasks) {
  if (!unfinishedTasks || !unfinishedTasks.length) return null
  const goals = unfinishedTasks.filter((t) => isGoal(t) && t.status !== 'completed')
  if (!goals.length) return null
  const running = goals.find((t) => t.status === 'in_progress')
  if (running) return running
  const score = (t) => (t.estimatedHours || 0) + (t.dependencies || []).length * 2
  return goals.reduce((a, b) => (score(b) > score(a) ? b : a))
}

/* ==================== 知识库（Agent 长期记忆） ==================== */

/**
 * knowledge 集合 schema（与 tasks 同模式：云优先，本地降级）：
 * { _id, title, content, type, tags, status, source, usageCount, rating,
 *   createdAt, updatedAt }
 *
 * - type:   'theory'（理论） | 'user_experience'（习惯/偏好/资源/约束）
 *           | 'best_practice'（经验教训） | 'task_template'（任务特征/技巧）
 * - status: 'active'（已采纳） | 'pending'（待确认） | 'ignored'（已忽略）
 * - source: 'preset'（预置理论） | 'manual'（手动添加） | 'extracted'（对话提取）
 * - usageCount: 被 Agent 建议引用的次数（检索命中并用于生成建议时 +1）
 * - rating: 用户评分 0-5（0 = 未评分）
 */
const KNOWLEDGE_COLLECTION = 'knowledge'
const LOCAL_KNOWLEDGE_KEY = 'po_knowledge'

/** 归一化知识文档字段，兜底默认值 */
function normalizeKnowledge(doc) {
  return {
    _id: doc._id,
    title: doc.title || '',
    content: doc.content || '',
    type: doc.type || 'user_experience',
    tags: doc.tags || [],
    status: doc.status || 'active',
    source: doc.source || 'manual',
    usageCount: doc.usageCount || 0,
    rating: doc.rating || 0,
    createdAt: doc.createdAt || 0,
    updatedAt: doc.updatedAt || 0,
  }
}

/**
 * 知识库初始化：幂等写入预置理论知识（title 去重，已存在不重复写入）。
 * 预置理论由客户端写入（集合"仅创建者可读写"权限下，云函数种的
 * 数据客户端不可见，与示例任务同一策略）；可在 onLaunch / 知识库页首次打开时调用。
 * @param {Array} presetTheory 预置理论列表（utils/knowledge.js 的 PRESET_THEORY）
 */
async function initKnowledge(presetTheory) {
  const presets = Array.isArray(presetTheory) ? presetTheory : []
  try {
    const existing = await loadKnowledge()
    const titles = {}
    existing.forEach((k) => {
      titles[k.title] = true
    })
    for (const p of presets) {
      if (titles[p.title]) continue
      // 逐条容错：单条预置数据不合法时只跳过它，不能让整批初始化中断
      // （否则一条脏数据会让知识库长期停留在空状态且无任何提示）
      try {
        await addKnowledge(Object.assign({}, p, { status: 'active', source: 'preset' }))
        titles[p.title] = true
      } catch (e) {
        console.warn('[api] 预置知识写入失败，跳过该条：' + (p && p.title), e)
      }
    }
    return true
  } catch (e) {
    console.warn('[api] 知识库初始化失败（下次打开重试）', e)
    return false
  }
}

/** 读取全部知识（按创建时间升序；网络错误自动重试 1 次；各 status 均返回，由调用方筛选） */
async function loadKnowledge() {
  if (mode === 'local') {
    return (wx.getStorageSync(LOCAL_KNOWLEDGE_KEY) || []).map(normalizeKnowledge)
  }
  const db = wx.cloud.database()
  const res = await runLogged(KNOWLEDGE_COLLECTION, 'read', '', () =>
    db
      .collection(KNOWLEDGE_COLLECTION)
      .orderBy('createdAt', 'asc')
      .limit(100)
      .get()
  , { retry: true })
  return (res.data || []).map(normalizeKnowledge)
}

/**
 * 新增知识条目（写入前经 validateKnowledgeInput 校验：title/content 必填、
 * type/status/source 枚举检查、超长截断）。
 * 对话提取的传 status: 'pending'（待确认）；手动添加默认 'active'。
 */
async function addKnowledge(params) {
  const input = validation.validateKnowledgeInput(params || {})
  const now = Date.now()
  const doc = {
    title: input.title,
    content: input.content,
    type: input.type === undefined ? 'user_experience' : input.type,
    tags: input.tags || [],
    status: input.status === undefined ? 'active' : input.status,
    source: input.source === undefined ? 'manual' : input.source,
    usageCount: 0,
    rating: 0,
    createdAt: now,
    updatedAt: now,
  }
  if (mode === 'local') {
    doc._id = 'klocal_' + now + '_' + Math.floor(Math.random() * 10000)
    return runLogged(KNOWLEDGE_COLLECTION, 'create', doc._id, () => {
      const list = wx.getStorageSync(LOCAL_KNOWLEDGE_KEY) || []
      list.push(doc)
      wx.setStorageSync(LOCAL_KNOWLEDGE_KEY, list)
      return Promise.resolve(normalizeKnowledge(doc))
    })
  }
  const db = wx.cloud.database()
  const res = await runLogged(KNOWLEDGE_COLLECTION, 'create', '', () =>
    db.collection(KNOWLEDGE_COLLECTION).add({ data: doc })
  )
  return normalizeKnowledge(Object.assign({}, doc, { _id: res._id }))
}

/**
 * 更新知识条目（partial patch，写入前经 validateKnowledgePatch 校验）。
 * 常见 patch：采纳 { status: 'active' } / 忽略 { status: 'ignored' } /
 * 引用计数 { usageCount: n } / 评分 { rating: n } / 编辑 { title, content, tags }
 */
async function updateKnowledge(id, patch = {}) {
  const docId = validation.validateDocId(id, '知识条目')
  const known = validation.validateKnowledgePatch(patch)
  const data = Object.assign({}, patch, known, { updatedAt: Date.now() })
  if (mode === 'local') {
    return runLogged(KNOWLEDGE_COLLECTION, 'update', docId, () => {
      const list = wx.getStorageSync(LOCAL_KNOWLEDGE_KEY) || []
      const i = list.findIndex((k) => k._id === docId)
      if (i === -1) return Promise.resolve()
      list[i] = Object.assign({}, list[i], data)
      wx.setStorageSync(LOCAL_KNOWLEDGE_KEY, list)
      return Promise.resolve()
    })
  }
  const db = wx.cloud.database()
  await runLogged(KNOWLEDGE_COLLECTION, 'update', docId, () =>
    db.collection(KNOWLEDGE_COLLECTION).doc(docId).update({ data })
  )
}

/** 删除知识条目（幂等：已不存在视为成功） */
async function removeKnowledge(id) {
  const docId = validation.validateDocId(id, '知识条目')
  if (mode === 'local') {
    return runLogged(KNOWLEDGE_COLLECTION, 'delete', docId, () => {
      const list = (wx.getStorageSync(LOCAL_KNOWLEDGE_KEY) || []).filter(
        (k) => k._id !== docId
      )
      wx.setStorageSync(LOCAL_KNOWLEDGE_KEY, list)
      return Promise.resolve()
    })
  }
  const db = wx.cloud.database()
  try {
    await runLogged(KNOWLEDGE_COLLECTION, 'delete', docId, () =>
      db.collection(KNOWLEDGE_COLLECTION).doc(docId).remove()
    )
  } catch (e) {
    if (e && e.type === 'notfound') return
    throw e
  }
}

module.exports = {
  getMode,
  initDatabase,
  loadTasks,
  addTask,
  updateTask,
  removeTask,
  computeBottleneck,
  isGoal,
  initKnowledge,
  loadKnowledge,
  addKnowledge,
  updateKnowledge,
  removeKnowledge,
}
