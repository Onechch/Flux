/**
 * tests/unit/api.test.js —— 数据访问层（utils/api.js）
 *
 * 本地降级模式：内存 Storage 代替云数据库，验证完整的数据管道
 * 校验 → 加密 → 写入 → 归一化读取，以及 modificationCount 的计数口径
 * （状态流转不计入，供牛鞭效应检测保留干净数据）。
 *
 * 云模式：云数据库替身驱动，覆盖只在云路径上才会走到的分支
 * （分页取全、command.inc / command.push）。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const {
  clearMiniProgramCache,
  createDbMock,
  createStorage,
  createWxMock,
} = require('../helpers/runtime')
const knowledgeUtil = require(path.join(
  __dirname,
  '..',
  '..',
  'miniprogram',
  'utils',
  'knowledge'
))

const API_PATH = path.join(__dirname, '..', '..', 'miniprogram', 'utils', 'api')

/**
 * 载入一份全新的 api 模块（清缓存 + 注入无云能力的 wx），并切到本地模式。
 * 模块级 mode 是 api.js 的状态，必须每次重建以保证用例隔离。
 */
async function loadApi(opts = {}) {
  clearMiniProgramCache()
  const storage = opts.storage || createStorage()
  global.wx = createWxMock({ storage: storage, cloud: null })
  const api = require(API_PATH)
  await api.initDatabase()
  return { api: api, storage: storage }
}

/**
 * 载入一份云模式 api（云数据库替身可用 → initDatabase 成功 → mode = 'cloud'）。
 * @param {Object} collections 各集合的初始文档
 */
async function loadCloudApi(collections) {
  clearMiniProgramCache()
  const db = createDbMock(collections || {})
  const storage = createStorage()
  global.wx = createWxMock({
    storage: storage,
    cloud: {
      database: () => db,
      callFunction: () => Promise.resolve({ result: { success: true } }),
    },
  })
  const api = require(API_PATH)
  const ok = await api.initDatabase()
  return { api: api, db: db, storage: storage, ok: ok }
}

/* ==================== 初始化与降级 ==================== */

test('无云能力时 initDatabase 降级为本地模式', async () => {
  const { api } = await loadApi()
  assert.equal(api.getMode(), 'local')
})

test('云能力可用时 initDatabase 切换到云模式', async () => {
  const { api, ok } = await loadCloudApi({})
  assert.equal(ok, true)
  assert.equal(api.getMode(), 'cloud')
})

/* ==================== 任务：新增与读取 ==================== */

test('addTask：写入前校验，空标题与纯空白标题都被拒绝', async () => {
  const { api } = await loadApi()
  await assert.rejects(() => api.addTask({ estimatedHours: 1 }), (e) => {
    assert.equal(e.name, 'ValidationError')
    assert.ok(e.message.indexOf('任务名称') > -1)
    return true
  })
  await assert.rejects(() => api.addTask({ title: '   ' }), (e) => {
    assert.equal(e.name, 'ValidationError')
    return true
  })
})

test('addTask：默认值正确（pending / actualHours 0 / level 0 / modificationCount 0）', async () => {
  const { api } = await loadApi()
  const doc = await api.addTask({ title: '完成季度汇报', estimatedHours: 11 })
  assert.ok(doc._id, '应返回带 _id 的文档')
  assert.equal(doc.status, 'pending')
  assert.equal(doc.actualHours, 0)
  assert.equal(doc.level, 0)
  assert.equal(doc.parentGoalId, '')
  assert.equal(doc.modificationCount, 0)
  assert.equal(doc.estimatedHours, 11)
  assert.equal(doc.isBottleneck, false)
  assert.deepEqual(doc.dependencies, [])
})

test('addTask：estimatedHours 缺省为 1', async () => {
  const { api } = await loadApi()
  const doc = await api.addTask({ title: 'A' })
  assert.equal(doc.estimatedHours, 1)
})

test('loadTasks：读回写入的任务，字段完整且顺序稳定', async () => {
  const { api } = await loadApi()
  await api.addTask({ title: 'A', estimatedHours: 1 })
  await api.addTask({ title: 'B', estimatedHours: 2 })
  const list = await api.loadTasks()
  assert.deepEqual(
    list.map((t) => t.title),
    ['A', 'B']
  )
})

test('loadTasks：空库返回空数组', async () => {
  const { api } = await loadApi()
  assert.deepEqual(await api.loadTasks(), [])
})

/* ==================== 任务：更新与计数口径 ==================== */

test('updateTask：修改有意义字段（estimatedHours）时 modificationCount +1', async () => {
  const { api } = await loadApi()
  const doc = await api.addTask({ title: 'A', estimatedHours: 1 })
  await api.updateTask(doc._id, { estimatedHours: 5 })
  const after = (await api.loadTasks())[0]
  assert.equal(after.estimatedHours, 5)
  assert.equal(after.modificationCount, 1)
})

test('updateTask：仅改 status 不计入 modificationCount（牛鞭效应检测需干净数据）', async () => {
  const { api } = await loadApi()
  const doc = await api.addTask({ title: 'A' })
  await api.updateTask(doc._id, { status: 'in_progress' })
  await api.updateTask(doc._id, { status: 'completed' })
  const after = (await api.loadTasks())[0]
  assert.equal(after.status, 'completed')
  assert.equal(after.modificationCount, 0)
})

test('updateTask：仅改 actualHours / isBottleneck 不计入 modificationCount', async () => {
  const { api } = await loadApi()
  const doc = await api.addTask({ title: 'A' })
  await api.updateTask(doc._id, { actualHours: 3, isBottleneck: true })
  const after = (await api.loadTasks())[0]
  assert.equal(after.actualHours, 3)
  assert.equal(after.modificationCount, 0)
})

test('updateTask：countModification:false 时即便改有意义字段也不计数', async () => {
  const { api } = await loadApi()
  const doc = await api.addTask({ title: 'A', estimatedHours: 1 })
  await api.updateTask(doc._id, { estimatedHours: 9 }, { countModification: false })
  const after = (await api.loadTasks())[0]
  assert.equal(after.estimatedHours, 9)
  assert.equal(after.modificationCount, 0)
})

test('updateTask：多次修改累计计数', async () => {
  const { api } = await loadApi()
  const doc = await api.addTask({ title: 'A' })
  await api.updateTask(doc._id, { title: 'A1' })
  await api.updateTask(doc._id, { estimatedHours: 2 })
  await api.updateTask(doc._id, { status: 'in_progress' })
  await api.updateTask(doc._id, { dependencies: ['x'] })
  const after = (await api.loadTasks())[0]
  assert.equal(after.modificationCount, 3)
})

/* ==================== 变更明细 changeLog（波动预警数据基础） ==================== */

test('addTask：changeLog 初始化为空数组', async () => {
  const { api } = await loadApi()
  await api.addTask({ title: 'A' })
  const after = (await api.loadTasks())[0]
  assert.deepEqual(after.changeLog, [])
})

test('updateTask：修改有意义字段时追加变更明细（含 field/from/to/ts）', async () => {
  const { api } = await loadApi()
  const doc = await api.addTask({ title: 'A', estimatedHours: 1 })
  const t0 = Date.now()
  await api.updateTask(doc._id, { estimatedHours: 5 })
  const after = (await api.loadTasks())[0]
  assert.equal(after.changeLog.length, 1)
  const e = after.changeLog[0]
  assert.equal(e.field, 'estimatedHours')
  assert.equal(e.from, 1)
  assert.equal(e.to, 5)
  assert.ok(e.ts >= t0 && e.ts <= Date.now())
})

test('updateTask：一次 patch 改多个有意义字段 → 每个字段各一条明细', async () => {
  const { api } = await loadApi()
  const doc = await api.addTask({ title: 'A', estimatedHours: 1 })
  await api.updateTask(doc._id, { title: 'A2', estimatedHours: 3 })
  const after = (await api.loadTasks())[0]
  assert.equal(after.changeLog.length, 2)
  const fields = after.changeLog.map((e) => e.field).sort()
  assert.deepEqual(fields, ['estimatedHours', 'title'])
  assert.equal(after.modificationCount, 1) // 同一次修改只计 1 次
})

test('updateTask：仅改 status 不产生变更明细（与 modificationCount 同口径）', async () => {
  const { api } = await loadApi()
  const doc = await api.addTask({ title: 'A' })
  await api.updateTask(doc._id, { status: 'in_progress' })
  await api.updateTask(doc._id, { status: 'completed' })
  const after = (await api.loadTasks())[0]
  assert.deepEqual(after.changeLog, [])
  assert.equal(after.modificationCount, 0)
})

test('updateTask：countModification:false 时也不记录变更明细（系统流转不污染波动数据）', async () => {
  const { api } = await loadApi()
  const doc = await api.addTask({ title: 'A', estimatedHours: 1 })
  await api.updateTask(doc._id, { estimatedHours: 8 }, { countModification: false })
  const after = (await api.loadTasks())[0]
  assert.equal(after.estimatedHours, 8)
  assert.deepEqual(after.changeLog, [])
})

test('updateTask：同值重写不算变更（重复提交不虚增波动信号）', async () => {
  const { api } = await loadApi()
  const doc = await api.addTask({ title: 'A', estimatedHours: 4 })
  await api.updateTask(doc._id, { estimatedHours: 4 })
  const after = (await api.loadTasks())[0]
  assert.equal(after.modificationCount, 1) // 计数按"改了这个字段"口径，仍 +1
  assert.deepEqual(after.changeLog, []) // 但明细里没有真实变化
})

test('updateTask：变更明细超过上限时只保留最近 CHANGE_LOG_MAX 条', async () => {
  const { api } = await loadApi()
  const max = api.CHANGE_LOG_MAX
  const doc = await api.addTask({ title: 'A', estimatedHours: 1 })
  for (let i = 1; i <= max + 5; i++) {
    await api.updateTask(doc._id, { estimatedHours: i })
  }
  const after = (await api.loadTasks())[0]
  assert.equal(after.modificationCount, max + 5)
  assert.equal(after.changeLog.length, max)
  // 保留的是最近 max 条：最后一条 = 最后一次修改，最早一条已被丢弃
  assert.equal(after.changeLog[after.changeLog.length - 1].to, max + 5)
  assert.equal(after.changeLog[0].to, 6)
})

test('updateTask：changeLog 脏数据在读取时被归一化（不抛错）', async () => {
  const { api, storage } = await loadApi()
  const doc = await api.addTask({ title: 'A' })
  const raw = storage.get('po_tasks')
  raw[0].changeLog = [null, 'x', { ts: 'abc', field: 1 }, { ts: 123, field: 'title', from: 'a', to: 'b' }]
  storage.set('po_tasks', raw)
  const after = (await api.loadTasks())[0]
  assert.equal(after.changeLog.length, 2)
  assert.equal(after.changeLog[0].ts, 0)
  assert.equal(after.changeLog[0].field, '')
  assert.equal(after.changeLog[1].ts, 123)
  assert.equal(after.changeLog[1].to, 'b')
})

test('updateTask：校验失败的字段不写库', async () => {
  const { api } = await loadApi()
  const doc = await api.addTask({ title: 'A' })
  await assert.rejects(() => api.updateTask(doc._id, { estimatedHours: -5 }))
  const after = (await api.loadTasks())[0]
  assert.equal(after.estimatedHours, 1)
})

test('updateTask：文档 ID 非法直接拒绝', async () => {
  const { api } = await loadApi()
  await assert.rejects(() => api.updateTask('', { status: 'pending' }))
  await assert.rejects(() => api.updateTask('x'.repeat(65), { status: 'pending' }))
})

/* ==================== 敏感字段加密 ==================== */

test('userContext.text 落库为密文（enc1: 前缀），读回为明文', async () => {
  const { api, storage } = await loadApi()
  const doc = await api.addTask({ title: 'A' })
  const ctx = { tags: ['缺资源'], text: '我只有一台设备，做不了高通量筛选', submittedAt: 1, version: 1 }
  await api.updateTask(doc._id, { userContext: ctx })

  const raw = storage.peek('po_tasks')[0].userContext
  assert.ok(raw.text.indexOf('enc1:') === 0, '落库必须是密文')
  assert.ok(raw.text.indexOf('高通量') === -1, '明文不应出现在存储中')
  assert.deepEqual(raw.tags, ['缺资源'], '标签不加密（非敏感）')

  const back = (await api.loadTasks())[0]
  assert.equal(back.userContext.text, '我只有一台设备，做不了高通量筛选')
})

test('userContext.text 重复更新不二次加密（幂等）', async () => {
  const { api, storage } = await loadApi()
  const doc = await api.addTask({ title: 'A' })
  const ctx = { tags: [], text: '同样的文本', submittedAt: 1, version: 1 }
  await api.updateTask(doc._id, { userContext: ctx })
  const first = storage.peek('po_tasks')[0].userContext.text
  // 用读回的明文再次写入（模拟"读取→编辑→保存"）
  const readBack = (await api.loadTasks())[0].userContext
  await api.updateTask(doc._id, { userContext: readBack })
  const second = storage.peek('po_tasks')[0].userContext.text
  assert.equal(second, first)
  assert.equal((await api.loadTasks())[0].userContext.text, '同样的文本')
})

test('suggestionHistory 落库并读回', async () => {
  const { api } = await loadApi()
  const doc = await api.addTask({ title: 'A' })
  const history = [
    { version: 1, suggestions: [{ key: 'k', type: 'start' }], relatedKnowledge: [], generatedAt: 1, basedOn: 'user_context', source: 'ai' },
  ]
  await api.updateTask(doc._id, { suggestionHistory: history })
  const back = (await api.loadTasks())[0]
  assert.equal(back.suggestionHistory.length, 1)
  assert.equal(back.suggestionHistory[0].basedOn, 'user_context')
})

/* ==================== 删除 ==================== */

test('removeTask：删除后读不到，且重复删除不报错（幂等）', async () => {
  const { api } = await loadApi()
  const doc = await api.addTask({ title: 'A' })
  await api.removeTask(doc._id)
  assert.deepEqual(await api.loadTasks(), [])
  await assert.doesNotReject(() => api.removeTask(doc._id))
})

/* ==================== 瓶颈识别 ==================== */

test('computeBottleneck：无任务或只有子任务时返回 null', async () => {
  const { api } = await loadApi()
  assert.equal(api.computeBottleneck([]), null)
  assert.equal(
    api.computeBottleneck([{ _id: 's', title: '子任务', parentGoalId: 'g', status: 'pending' }]),
    null
  )
})

test('computeBottleneck：存在 in_progress 大目标时它就是唯一焦点', async () => {
  const { api } = await loadApi()
  const goals = [
    { _id: 'g1', title: '短目标', status: 'pending', estimatedHours: 1, dependencies: [] },
    { _id: 'g2', title: '进行中目标', status: 'in_progress', estimatedHours: 2, dependencies: [] },
    { _id: 'g3', title: '超长目标', status: 'locked', estimatedHours: 100, dependencies: [] },
  ]
  assert.equal(api.computeBottleneck(goals)._id, 'g2')
})

test('computeBottleneck：无 in_progress 时取「耗时 + 依赖数×2」最高者', async () => {
  const { api } = await loadApi()
  const goals = [
    { _id: 'g1', title: 'A', status: 'pending', estimatedHours: 10, dependencies: [] },
    { _id: 'g2', title: 'B', status: 'pending', estimatedHours: 8, dependencies: ['x', 'y', 'z'] },
    { _id: 'g3', title: 'C', status: 'pending', estimatedHours: 5, dependencies: [] },
  ]
  assert.equal(api.computeBottleneck(goals)._id, 'g2', '8 + 3*2 = 14 > 10')
})

test('computeBottleneck：已完成的大目标被排除（即使传入全量任务列表）', async () => {
  const { api } = await loadApi()
  const goals = [
    { _id: 'g1', title: '已完成', status: 'completed', estimatedHours: 100, dependencies: [] },
    { _id: 'g2', title: '待办', status: 'pending', estimatedHours: 1, dependencies: [] },
  ]
  assert.equal(api.computeBottleneck(goals)._id, 'g2')
  // 全部已完成时无瓶颈
  assert.equal(
    api.computeBottleneck([
      { _id: 'g1', title: '已完成', status: 'completed', estimatedHours: 1, dependencies: [] },
    ]),
    null
  )
})

test('isGoal：只有无 parentGoalId 的才是大目标', async () => {
  const { api } = await loadApi()
  assert.equal(api.isGoal({ _id: 'g', parentGoalId: '' }), true)
  assert.equal(api.isGoal({ _id: 's', parentGoalId: 'g' }), false)
})

/* ==================== 知识库 ==================== */

test('initKnowledge：预置理论全部写入（标签 4 个不应导致整批失败）', async () => {
  const { api } = await loadApi()
  const ok = await api.initKnowledge(knowledgeUtil.PRESET_THEORY)
  assert.equal(ok, true)
  const list = await api.loadKnowledge()
  assert.equal(
    list.length,
    knowledgeUtil.PRESET_THEORY.length,
    '预置理论应全部落库（此前因标签超限在第一条就整体中断）'
  )
  list.forEach((k) => {
    assert.equal(k.status, 'active')
    assert.equal(k.source, 'preset')
    assert.equal(k.type, 'theory')
  })
})

test('initKnowledge：幂等，重复调用不产生重复条目', async () => {
  const { api } = await loadApi()
  await api.initKnowledge(knowledgeUtil.PRESET_THEORY)
  await api.initKnowledge(knowledgeUtil.PRESET_THEORY)
  const list = await api.loadKnowledge()
  assert.equal(list.length, knowledgeUtil.PRESET_THEORY.length)
})

test('initKnowledge：单条数据非法只跳过该条，不影响其余条目', async () => {
  const { api } = await loadApi()
  const ok = await api.initKnowledge([
    { title: '坏数据', content: '内容', type: 'theory', tags: ['a', 'b', 'c', 'd', 'e', 'f'] },
    { title: '好数据', content: '内容', type: 'theory', tags: ['a'] },
  ])
  assert.equal(ok, true, '整批不应因单条失败而返回 false')
  const titles = (await api.loadKnowledge()).map((k) => k.title)
  assert.deepEqual(titles, ['好数据'])
})

test('知识库：新增 / 读取 / 更新 / 删除 往返', async () => {
  const { api } = await loadApi()
  const doc = await api.addKnowledge({
    title: '上午效率高',
    content: '我一般上午效率比较高，重要的事放上午做',
    type: 'user_experience',
    tags: ['习惯'],
    status: 'pending',
    source: 'extracted',
  })
  assert.ok(doc._id)
  assert.equal(doc.usageCount, 0)
  assert.equal(doc.rating, 0)

  await api.updateKnowledge(doc._id, { status: 'active' })
  await api.updateKnowledge(doc._id, { usageCount: 3 })
  await api.updateKnowledge(doc._id, { rating: 5 })
  let list = await api.loadKnowledge()
  assert.equal(list[0].status, 'active')
  assert.equal(list[0].usageCount, 3)
  assert.equal(list[0].rating, 5)

  await api.removeKnowledge(doc._id)
  list = await api.loadKnowledge()
  assert.deepEqual(list, [])
  await assert.doesNotReject(() => api.removeKnowledge(doc._id))
})

test('知识库：title/content 必填，缺失时拒绝写入', async () => {
  const { api } = await loadApi()
  await assert.rejects(() => api.addKnowledge({ content: '只有内容' }), (e) => {
    assert.equal(e.name, 'ValidationError')
    return true
  })
  await assert.rejects(() => api.addKnowledge({ title: '只有标题' }))
})

test('知识库：读取时兜底默认值', async () => {
  const { api } = await loadApi()
  await api.addKnowledge({ title: 'T', content: 'C' })
  const k = (await api.loadKnowledge())[0]
  assert.equal(k.type, 'user_experience')
  assert.equal(k.status, 'active')
  assert.equal(k.source, 'manual')
  assert.deepEqual(k.tags, [])
})

/* ==================== 云模式：分页取全 ==================== */

/** 造 n 条云数据库文档 */
function bulk(n, prefix, extra) {
  const out = []
  for (let i = 1; i <= n; i++) {
    out.push(
      Object.assign(
        { _id: prefix + i, title: prefix + i, createdAt: i, updatedAt: i },
        extra || {}
      )
    )
  }
  return out
}

test('云模式：loadTasks 超过 100 条时分页取全', async () => {
  const { api } = await loadCloudApi({ tasks: bulk(150, 't') })
  const tasks = await api.loadTasks()
  assert.equal(tasks.length, 150)
  assert.equal(tasks[149]._id, 't150')
})

test('云模式：loadKnowledge 超过 100 条时分页取全（旧实现硬编码 limit(100) 会截断）', async () => {
  const { api } = await loadCloudApi({ knowledge: bulk(150, 'k') })
  const list = await api.loadKnowledge()
  assert.equal(list.length, 150)
  assert.equal(list[149]._id, 'k150')
})

test('云模式：initKnowledge 在知识超 100 条时仍能正确去重（不重复写入预置理论）', async () => {
  const { api, db } = await loadCloudApi({
    knowledge: bulk(150, 'k').concat([
      { _id: 'preset1', title: '关键路径法', content: '已有', createdAt: 200, updatedAt: 200 },
    ]),
  })
  await api.initKnowledge([{ title: '关键路径法', content: '预置内容' }])
  // 已存在 → 不应新增；列表被截断时旧实现会误判为"不存在"而重复写入
  assert.equal(db.__dump('knowledge').filter((k) => k.title === '关键路径法').length, 1)
  assert.equal(db.__dump('knowledge').length, 151)
})

test('云模式：分页取全按 _id 去重（同 createdAt 边界不重复）', async () => {
  const { api } = await loadCloudApi({
    tasks: bulk(100, 'a', { createdAt: 1 }).concat(bulk(50, 'b', { createdAt: 1 })),
  })
  const tasks = await api.loadTasks()
  assert.equal(tasks.length, 150)
})

/* ==================== 云模式：command.inc / command.push ==================== */

test('云模式：updateTask 用 inc 累加 modificationCount，并 push 追加变更明细', async () => {
  const { api, db } = await loadCloudApi({
    tasks: [
      { _id: 't1', title: 'A', estimatedHours: 1, modificationCount: 0, changeLog: [], createdAt: 1 },
    ],
  })
  await api.updateTask('t1', { estimatedHours: 5 })
  const doc = db.__dump('tasks')[0]
  assert.equal(doc.modificationCount, 1)
  assert.equal(doc.estimatedHours, 5)
  assert.equal(doc.changeLog.length, 1)
  assert.equal(doc.changeLog[0].field, 'estimatedHours')
  assert.equal(doc.changeLog[0].from, 1)
  assert.equal(doc.changeLog[0].to, 5)
})

test('云模式：changeLog 字段不存在时 push 自动创建数组（MongoDB $push 语义）', async () => {
  const { api, db } = await loadCloudApi({
    tasks: [{ _id: 't1', title: 'A', estimatedHours: 1, modificationCount: 0, createdAt: 1 }],
  })
  await api.updateTask('t1', { estimatedHours: 3 })
  const doc = db.__dump('tasks')[0]
  assert.equal(doc.changeLog.length, 1)
  assert.equal(doc.changeLog[0].to, 3)
})

test('云模式：仅改 status 不 inc 也不 push（不污染波动数据）', async () => {
  const { api, db } = await loadCloudApi({
    tasks: [{ _id: 't1', title: 'A', status: 'pending', modificationCount: 0, changeLog: [], createdAt: 1 }],
  })
  await api.updateTask('t1', { status: 'completed' })
  const doc = db.__dump('tasks')[0]
  assert.equal(doc.status, 'completed')
  assert.equal(doc.modificationCount, 0)
  assert.deepEqual(doc.changeLog, [])
})
