/**
 * tests/unit/api.test.js —— 数据访问层（utils/api.js，本地降级模式）
 *
 * 用内存 Storage 代替云数据库，验证完整的数据管道：
 * 校验 → 加密 → 写入 → 归一化读取，以及 modificationCount 的计数口径
 * （状态流转不计入，供牛鞭效应检测保留干净数据）。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { clearMiniProgramCache, createStorage, createWxMock } = require('../helpers/runtime')
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

/* ==================== 初始化与降级 ==================== */

test('无云能力时 initDatabase 降级为本地模式', async () => {
  const { api } = await loadApi()
  assert.equal(api.getMode(), 'local')
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
