/**
 * utils/api.js —— 数据访问层（MVP）
 *
 * 策略：云数据库优先（wx.cloud.database），云环境/云函数不可用时自动降级为本地存储，
 * 保证开发工具中未部署云函数时页面仍可完整体验（约束4：错误降级方案）。
 *
 * 数据模型与云数据库 tasks 集合 schema 保持一致：
 * { _id, title, description, estimatedHours, actualHours, status,
 *   isBottleneck, dependencies, projectId, parentGoalId, level,
 *   createdAt, updatedAt, modificationCount }
 *
 * 两级任务模型：
 * - 大目标（level 0，parentGoalId 为空）：首页展示与瓶颈识别的基本单位
 * - 子任务（level 1，parentGoalId 指向所属大目标 _id）：全部完成后大目标自动完成
 *
 * status 取值：'pending' | 'locked' | 'in_progress' | 'completed'
 */

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

// 首次打开自动创建的默认任务示例（约束3：数据持久化 + 示例任务）
const DEFAULT_TASKS = [
  { title: '完成季度汇报PPT', description: '整理上季度数据，产出汇报材料', estimatedHours: 4 },
  { title: '回复重点客户邮件', description: '', estimatedHours: 0.5 },
  { title: '整理会议纪要', description: '', estimatedHours: 1.5 },
]

// 当前数据模式：'cloud' | 'local'
let mode = 'cloud'

function getMode() {
  return mode
}

/**
 * 调用云函数 initDatabase 创建 tasks / projects 集合（幂等）。
 * 失败（未部署/无环境）则降级为本地存储模式。
 */
async function initDatabase() {
  try {
    const res = await wx.cloud.callFunction({ name: 'initDatabase' })
    if (res.result && res.result.success) {
      mode = 'cloud'
      return true
    }
  } catch (e) {
    console.warn('[api] initDatabase 云函数不可用，降级为本地存储模式', e)
  }
  mode = 'local'
  return false
}

/** 归一化文档字段，兜底默认值（缺 parentGoalId/level 的旧数据按大目标处理） */
function normalize(doc) {
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
    createdAt: doc.createdAt || 0,
    updatedAt: doc.updatedAt || 0,
    modificationCount: doc.modificationCount || 0,
  }
}

/** 是否大目标（level 0） */
function isGoal(task) {
  return !task.parentGoalId
}

/** 读取全部任务（按创建时间升序） */
async function loadTasks() {
  if (mode === 'local') {
    return (wx.getStorageSync(LOCAL_KEY) || []).map(normalize)
  }
  const db = wx.cloud.database()
  const res = await db.collection(COLLECTION).orderBy('createdAt', 'asc').limit(100).get()
  return (res.data || []).map(normalize)
}

/**
 * 新增任务。
 * level 0（默认）= 大目标；level 1 = 子任务，需传 parentGoalId 指向所属大目标。
 * dependencies 传入"任务ID列表"（与 tasks 集合 schema 一致）；
 * 从流程拆解页导入时，由页面负责将"任务名"映射为已创建任务的 _id 后再回填。
 */
async function addTask({
  title,
  description = '',
  estimatedHours = 1,
  dependencies = [],
  projectId = '',
  parentGoalId = '',
  level = 0,
}) {
  const now = Date.now()
  const doc = {
    title,
    description,
    estimatedHours,
    actualHours: 0,
    status: 'pending',
    isBottleneck: false,
    dependencies,
    projectId,
    parentGoalId,
    level,
    createdAt: now,
    updatedAt: now,
    modificationCount: 0,
  }
  if (mode === 'local') {
    doc._id = 'local_' + now + '_' + Math.floor(Math.random() * 10000)
    const list = wx.getStorageSync(LOCAL_KEY) || []
    list.push(doc)
    wx.setStorageSync(LOCAL_KEY, list)
    return normalize(doc)
  }
  const db = wx.cloud.database()
  const res = await db.collection(COLLECTION).add({ data: doc })
  return normalize(Object.assign({}, doc, { _id: res._id }))
}

/**
 * 更新任务（partial patch）。
 * 仅当修改了"有业务含义"的字段时才累加 modificationCount（牛鞭效应检测用）。
 * opts.countModification === false 时表示系统自动流转（如瓶颈锁定/解锁），
 * 不计入修改次数。默认 true（用户主动编辑）。
 */
async function updateTask(id, patch = {}, opts = {}) {
  const countModification = opts.countModification !== false
  const bump =
    countModification && Object.keys(patch).some((k) => MEANINGFUL_FIELDS.indexOf(k) > -1)
  const now = Date.now()
  if (mode === 'local') {
    const list = wx.getStorageSync(LOCAL_KEY) || []
    const i = list.findIndex((t) => t._id === id)
    if (i === -1) return
    list[i] = Object.assign({}, list[i], patch, {
      updatedAt: now,
      modificationCount: (list[i].modificationCount || 0) + (bump ? 1 : 0),
    })
    wx.setStorageSync(LOCAL_KEY, list)
    return
  }
  const db = wx.cloud.database()
  const data = Object.assign({}, patch, { updatedAt: now })
  if (bump) data.modificationCount = db.command.inc(1)
  await db.collection(COLLECTION).doc(id).update({ data })
}

/** 删除任务 */
async function removeTask(id) {
  if (mode === 'local') {
    const list = (wx.getStorageSync(LOCAL_KEY) || []).filter((t) => t._id !== id)
    wx.setStorageSync(LOCAL_KEY, list)
    return
  }
  const db = wx.cloud.database()
  await db.collection(COLLECTION).doc(id).remove()
}

/**
 * 瓶颈识别（约束理论 TOC）—— 只认大目标：
 * - 若有进行中的大目标，它就是唯一焦点（杜绝多任务切换）
 * - 否则取"预估耗时 + 依赖数量 × 2"得分最高的未完成大目标作为瓶颈
 */
function computeBottleneck(unfinishedTasks) {
  if (!unfinishedTasks || !unfinishedTasks.length) return null
  const goals = unfinishedTasks.filter(isGoal)
  if (!goals.length) return null
  const running = goals.find((t) => t.status === 'in_progress')
  if (running) return running
  const score = (t) => (t.estimatedHours || 0) + (t.dependencies || []).length * 2
  return goals.reduce((a, b) => (score(b) > score(a) ? b : a))
}

/** 首次打开写入默认任务示例（幂等：仅当任务列表为空时写入） */
async function seedDefaultTasks() {
  const existing = await loadTasks()
  if (existing.length) return existing
  const seeded = []
  for (const t of DEFAULT_TASKS) {
    seeded.push(await addTask(t))
  }
  return seeded
}

module.exports = {
  getMode,
  initDatabase,
  loadTasks,
  addTask,
  updateTask,
  removeTask,
  computeBottleneck,
  seedDefaultTasks,
  isGoal,
}
