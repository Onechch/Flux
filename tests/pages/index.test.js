/**
 * tests/pages/index.test.js —— 首页（pages/index）页面级逻辑
 *
 * 用真实 utils/api.js（本地降级模式）+ 内存 Storage 驱动 loadTasks 全链路：
 * 瓶颈锁定流转 → 视图字段生成 → 大目标展开/收起状态。
 *
 * 重点覆盖「展开状态跨刷新保留」：_expanded 是纯视图字段（不落库），
 * 每次 loadTasks 从 DB 重建任务对象都会丢失，必须由 userToggledGoals 回填。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createStorage, createWxMock, loadPage } = require('../helpers/runtime')

/** 造一条原始任务文档（api.js 本地存储格式） */
function raw(id, extra) {
  return Object.assign(
    {
      _id: id,
      title: id,
      description: '',
      estimatedHours: 1,
      actualHours: 0,
      status: 'pending',
      isBottleneck: false,
      dependencies: [],
      projectId: '',
      parentGoalId: '',
      level: 0,
      aiHint: '',
      userContext: null,
      suggestionHistory: [],
      createdAt: 1,
      updatedAt: 1,
      modificationCount: 0,
      changeLog: [],
    },
    extra || {}
  )
}

/**
 * 加载首页并完成 bootstrap。
 * @param {Array} tasks 初始任务
 * @param {Object} [t] node:test 上下文；传入后会在用例结束时卸载页面（停掉专注计时器，
 *   否则 setInterval 会让测试进程无法退出）
 */
async function loadIndexPage(tasks, t) {
  const storage = createStorage({ po_tasks: tasks || [] })
  const wx = createWxMock({ storage: storage, cloud: null })
  const page = loadPage('pages/index/index.js', { wx: wx })
  if (t && typeof t.after === 'function') {
    t.after(() => page.onUnload())
  }
  // 必须走 bootstrap：api 模块级 mode 初始为 'cloud'，
  // 不先 initDatabase（无云能力时降级 local）会走云路径并失败
  await page.bootstrap()
  return { page: page, storage: storage, wx: wx }
}

/** 取页面 data.tasks 中某个任务的视图对象 */
function viewOf(page, id) {
  return page.data.tasks.find((t) => t._id === id)
}

/** 两个大目标：g1 耗时更长 → 应成为瓶颈并被锁定为 in_progress */
function twoGoals() {
  return [raw('g1', { title: '大目标1', estimatedHours: 10 }), raw('g2', { title: '大目标2', estimatedHours: 2 })]
}

/* ==================== 加载与瓶颈流转 ==================== */

test('loadTasks：空库不报错，任务列表为空', async (t) => {
  const { page, wx } = await loadIndexPage([], t)
  assert.equal(page.data.mode, 'local')
  assert.deepEqual(page.data.tasks, [])
  assert.equal(page.data.bottleneckId, null)
  assert.equal(wx.__calls.toast.length, 0)
})

test('loadTasks：多个大目标时耗时最长者成为瓶颈并进入 in_progress', async (t) => {
  const { page } = await loadIndexPage(twoGoals(), t)
  assert.equal(page.data.bottleneckId, 'g1')
  assert.equal(viewOf(page, 'g1').status, 'in_progress')
  assert.equal(viewOf(page, 'g1').isBottleneck, true)
  assert.equal(viewOf(page, 'g2').status, 'locked')
})

test('loadTasks：视图字段（displayHours / progress）已生成', async (t) => {
  const { page } = await loadIndexPage([raw('g1', { estimatedHours: 4, actualHours: 2 })], t)
  const g1 = viewOf(page, 'g1')
  assert.equal(g1.displayHours, '2.0')
  assert.equal(g1.progress, 50)
})

/* ==================== 大目标展开状态 ==================== */

test('loadTasks：瓶颈目标自动展开、其余默认收起', async (t) => {
  const { page } = await loadIndexPage(twoGoals(), t)
  assert.equal(viewOf(page, 'g1')._expanded, true)
  assert.equal(viewOf(page, 'g2')._expanded, false)
})

test('展开状态跨刷新保留：手动展开非瓶颈目标后重新加载仍是展开的（回归）', async (t) => {
  const { page } = await loadIndexPage(twoGoals(), t)
  assert.equal(viewOf(page, 'g2')._expanded, false)

  page.toggleGoal({ currentTarget: { dataset: { id: 'g2' } } })
  assert.equal(viewOf(page, 'g2')._expanded, true)
  assert.equal(page.userToggledGoals['g2'], true)

  // 模拟切走再切回首页（onShow → loadTasks 从 DB 重建任务对象）
  await page.loadTasks()
  assert.equal(viewOf(page, 'g2')._expanded, true, '用户手动展开的选择必须保留')
  assert.equal(viewOf(page, 'g1')._expanded, true, '瓶颈目标仍保持展开')
})

test('展开状态跨刷新保留：手动收起瓶颈目标后重新加载不被自动展开', async (t) => {
  const { page } = await loadIndexPage(twoGoals(), t)
  assert.equal(viewOf(page, 'g1')._expanded, true)

  page.toggleGoal({ currentTarget: { dataset: { id: 'g1' } } })
  assert.equal(viewOf(page, 'g1')._expanded, false)

  await page.loadTasks()
  assert.equal(viewOf(page, 'g1')._expanded, false, '尊重用户收起的选择')
})

test('展开状态跨刷新保留：多次切换后以最后一次选择为准', async (t) => {
  const { page } = await loadIndexPage(twoGoals(), t)
  const tap = (id) => page.toggleGoal({ currentTarget: { dataset: { id: id } } })

  tap('g2') // 展开
  await page.loadTasks()
  assert.equal(viewOf(page, 'g2')._expanded, true)

  tap('g2') // 收起
  await page.loadTasks()
  assert.equal(viewOf(page, 'g2')._expanded, false)
})

test('loadTasks：未手动操作过的目标不保留 _expanded（默认规则生效）', async (t) => {
  const { page } = await loadIndexPage(twoGoals(), t)
  // 让 g2 成为瓶颈：提高其耗时后重新加载，自动展开应转移到 g2
  const list = page.__storage.get('po_tasks').map((t) =>
    t._id === 'g2' ? Object.assign({}, t, { estimatedHours: 99 }) : t
  )
  page.__storage.set('po_tasks', list)
  await page.loadTasks()
  assert.equal(page.data.bottleneckId, 'g2')
  assert.equal(viewOf(page, 'g2')._expanded, true)
})
