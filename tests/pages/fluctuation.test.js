/**
 * tests/pages/fluctuation.test.js —— 波动预警页（pages/fluctuation）
 *
 * 用真实 utils/api.js（本地降级模式）+ 内存 Storage 驱动整页逻辑：
 * 分析结果 → 视图模型（标签/证据/层级文案）、重新排期的"先算后写"两段式流程、
 * 写库时不计入 modificationCount、以及空状态/失败态/重复点击等边界。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createStorage, createWxMock, loadPage } = require('../helpers/runtime')
const fluctuation = require('../../miniprogram/utils/fluctuation')

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

/** 以给定任务列表加载波动页并完成首次分析 */
async function loadFluctuationPage(tasks) {
  const storage = createStorage({ po_tasks: tasks || [] })
  const wx = createWxMock({ storage: storage, cloud: null })
  const page = loadPage('pages/fluctuation/index.js', { wx: wx })
  await page.onLoad()
  return { page: page, storage: storage, wx: wx }
}

/** 读取当前 storage 中的任务 */
function tasksOf(storage) {
  return storage.get('po_tasks') || []
}

function byId(storage, id) {
  return tasksOf(storage).find((t) => t._id === id)
}

/* ==================== 空状态与加载 ==================== */

test('空库：ready 为 false，不产生风险也不报错', async () => {
  const { page } = await loadFluctuationPage([])
  assert.equal(page.data.loading, false)
  assert.equal(page.data.ready, false)
  assert.equal(page.data.summary.taskCount, 0)
  assert.equal(page.data.summary.riskCount, 0)
  assert.deepEqual(page.data.risks, [])
  assert.deepEqual(page.data.goals, [])
})

test('有任务但无变更：ready 为 true、风险列表为空、层级分布已生成', async () => {
  const { page } = await loadFluctuationPage([
    raw('g'),
    raw('a', { parentGoalId: 'g' }),
  ])
  assert.equal(page.data.ready, true)
  assert.equal(page.data.summary.taskCount, 2)
  assert.equal(page.data.summary.goalCount, 1)
  assert.equal(page.data.summary.totalChanges, 0)
  assert.equal(page.data.summary.riskCount, 0)
  assert.deepEqual(page.data.risks, [])
  assert.equal(page.data.depthBars.length, 2)
  assert.equal(page.data.depthBars[0].depthText, '大目标')
  assert.equal(page.data.depthBars[1].depthText, '第 1 层')
})

test('加载失败：toast 提示且 loading 复位（不会永久卡在分析中）', async () => {
  const storage = createStorage()
  // 让读取任务列表时抛错，模拟数据层异常
  storage.get = function (k) {
    if (k === 'po_tasks') throw new Error('storage boom')
    return ''
  }
  const wx = createWxMock({ storage: storage, cloud: null })
  const page = loadPage('pages/fluctuation/index.js', { wx: wx })
  await page.onLoad()
  assert.equal(page.data.loading, false)
  assert.equal(wx.__calls.toast.length, 1)
  assert.ok(wx.__calls.toast[0].title.indexOf('storage boom') > -1)
})

/* ==================== 视图模型 ==================== */

test('风险条目：类型标签/配色类/层级文案/证据行齐备', async () => {
  const { page } = await loadFluctuationPage([
    raw('g', { title: '做实验' }),
    raw('a', { title: '跑通流程', parentGoalId: 'g', modificationCount: 3 }),
  ])
  assert.equal(page.data.risks.length, 1)
  const r = page.data.risks[0]
  assert.equal(r.key, 'amplified-a')
  assert.equal(r.title, '跑通流程')
  assert.equal(r.goalTitle, '做实验')
  assert.equal(r.kindLabel, '计划被放大')
  assert.equal(r.kindClass, 'k-amp')
  assert.equal(r.depthText, '第 1 层')
  assert.ok(r.evidence.indexOf('本层 3 次 / 源头 0 次') > -1)
  assert.ok(r.evidence.indexOf('放大 3×') > -1)
  assert.ok(r.advice.length > 0)
})

test('风险条目：大目标自身的风险标为「大目标」，配色类为 k-root', async () => {
  const { page } = await loadFluctuationPage([raw('g', { modificationCount: 4 })])
  const r = page.data.risks[0]
  assert.equal(r.depthText, '大目标')
  assert.equal(r.kindLabel, '需求源头反复变更')
  assert.equal(r.kindClass, 'k-root')
  assert.ok(r.evidence.indexOf('自身变更 4 次') > -1)
})

test('工时反复调整：证据行含调整次数与幅度', async () => {
  const { page } = await loadFluctuationPage([
    raw('g'),
    raw('a', {
      parentGoalId: 'g',
      estimatedHours: 9,
      modificationCount: 2,
      changeLog: [
        { ts: Date.now(), field: 'estimatedHours', from: 1, to: 3 },
        { ts: Date.now() - 1000, field: 'estimatedHours', from: 3, to: 9 },
      ],
    }),
  ])
  const r = page.data.risks.find((x) => x.kind === 'estimate_churn')
  assert.ok(r, '应生成工时估算风险')
  assert.equal(r.kindClass, 'k-est')
  assert.ok(r.evidence.indexOf('调整 2 次') > -1)
  assert.ok(r.evidence.indexOf('幅度 8h') > -1)
})

test('概览与排行：变更最多的节点按变更量降序、最多 8 条', async () => {
  const tasks = [raw('g')]
  for (let i = 0; i < 10; i++) {
    tasks.push(raw('c' + i, { parentGoalId: 'g', modificationCount: i }))
  }
  const { page } = await loadFluctuationPage(tasks)
  assert.equal(page.data.topChanges.length, 8)
  assert.equal(page.data.topChanges[0].taskId, 'c9')
  assert.equal(page.data.topChanges[0].ownChanges, 9)
  assert.equal(page.data.summary.totalChanges, 45) // 0+1+...+9
})

test('按大目标：展示子树规模、累计变更、总工作量与变更热区', async () => {
  const { page } = await loadFluctuationPage([
    raw('g', { title: '目标1', estimatedHours: 999 }),
    raw('a', { title: 'A', parentGoalId: 'g', estimatedHours: 2, modificationCount: 5 }),
    raw('b', { title: 'B', parentGoalId: 'g', estimatedHours: 3 }),
  ])
  const g = page.data.goals[0]
  assert.equal(g.title, '目标1')
  assert.equal(g.subtreeNodes, 3)
  assert.equal(g.subtreeChanges, 5)
  assert.equal(g.totalHours, 5) // 忽略父节点陈旧值 999，按叶子求和
  assert.equal(g.hotText, 'A(5)')
})

/* ==================== 交互：说明 / 跳转 ==================== */

test('onToggleThresholds：展开/收起判定口径', async () => {
  const { page } = await loadFluctuationPage([raw('g')])
  assert.equal(page.data.showThresholds, false)
  assert.ok(page.data.thresholdText.indexOf('放大') > -1)
  page.onToggleThresholds()
  assert.equal(page.data.showThresholds, true)
  page.onToggleThresholds()
  assert.equal(page.data.showThresholds, false)
})

test('goIndex：空状态跳首页', async () => {
  const { page, wx } = await loadFluctuationPage([])
  page.goIndex()
  assert.equal(wx.__calls.switchTab.length, 1)
  assert.equal(wx.__calls.switchTab[0].url, '/pages/index/index')
})

test('onRefine：暂存目标 ID 并跳转拆解页（与首页同一入口）', async () => {
  const { page, wx, storage } = await loadFluctuationPage([
    raw('g'),
    raw('a', { parentGoalId: 'g', modificationCount: 3 }),
  ])
  page.onRefine({ currentTarget: { dataset: { goal: 'g' } } })
  assert.equal(storage.get('po_pending_refine'), 'g')
  assert.equal(wx.__calls.switchTab.length, 1)
  assert.equal(wx.__calls.switchTab[0].url, '/pages/breakdown/index')
})

test('onRefine：缺少目标 ID 时不跳转（防御性）', async () => {
  const { page, wx } = await loadFluctuationPage([raw('g')])
  page.onRefine({ currentTarget: { dataset: {} } })
  assert.equal(wx.__calls.switchTab.length, 0)
})

test('onShow：返回本页时刷新数据', async () => {
  const { page, storage } = await loadFluctuationPage([raw('g')])
  assert.equal(page.data.summary.taskCount, 1)
  const list = tasksOf(storage)
  list.push(raw('g2'))
  storage.set('po_tasks', list)
  await page.onShow()
  assert.equal(page.data.summary.taskCount, 2)
})

/* ==================== 重新排期 ==================== */

test('onPlanTap：父节点耗时与子合计不一致 → 弹层列出修正项与各层关键路径', async () => {
  const { page } = await loadFluctuationPage([
    raw('g', { title: '目标', estimatedHours: 10 }),
    raw('a', { title: 'A', parentGoalId: 'g', estimatedHours: 3 }),
    raw('b', { title: 'B', parentGoalId: 'g', estimatedHours: 4 }),
  ])
  page.onPlanTap({ currentTarget: { dataset: { id: 'g' } } })
  assert.ok(page.data.plan, '应弹出排期方案')
  assert.equal(page.data.plan.title, '目标')
  assert.equal(page.data.plan.totalHours, 7) // 总工作量 = 叶子相加
  assert.equal(page.data.plan.updates.length, 1)
  assert.equal(page.data.plan.updates[0].from, 10)
  assert.equal(page.data.plan.updates[0].to, 7)
  // 同层无依赖 → 允许并行，关键路径取最长的那条（B 4h），与总工作量 7h 不同
  assert.ok(page.data.plan.layerText.indexOf('第 1 层：关键路径 4h（B）') > -1)
})

test('onPlanTap：同层有依赖时关键路径为链长（A→B 7h）', async () => {
  const { page, storage } = await loadFluctuationPage([
    raw('g', { estimatedHours: 7 }),
    raw('a', { title: 'A', parentGoalId: 'g', estimatedHours: 3 }),
    raw('b', { title: 'B', parentGoalId: 'g', estimatedHours: 4, dependencies: ['a'] }),
  ])
  page.onPlanTap({ currentTarget: { dataset: { id: 'g' } } })
  assert.equal(page.data.plan, null) // 排期已一致 → 不弹层
  const plan = fluctuation.planReschedule(tasksOf(storage), 'g')
  assert.equal(plan.layers[0].layerHours, 7)
  assert.deepEqual(plan.layers[0].criticalPath, ['A', 'B'])
})

test('onPlanTap：排期已一致时只提示、不弹层', async () => {
  const { page, wx } = await loadFluctuationPage([
    raw('g', { estimatedHours: 7 }),
    raw('a', { parentGoalId: 'g', estimatedHours: 3 }),
    raw('b', { parentGoalId: 'g', estimatedHours: 4 }),
  ])
  page.onPlanTap({ currentTarget: { dataset: { id: 'g' } } })
  assert.equal(page.data.plan, null)
  assert.equal(wx.__calls.toast.length, 1)
  assert.equal(wx.__calls.toast[0].title, '排期已一致，无需重排')
})

test('onPlanTap：目标不存在时提示且不弹层', async () => {
  const { page, wx } = await loadFluctuationPage([raw('g')])
  page.onPlanTap({ currentTarget: { dataset: { id: 'ghost' } } })
  assert.equal(page.data.plan, null)
  assert.equal(wx.__calls.toast.length, 1)
  assert.equal(wx.__calls.toast[0].title, '目标不存在或已被删除')
})

test('onPlanApply：按修正项写库、关闭弹层并重新分析；不计入 modificationCount', async () => {
  const { page, storage, wx } = await loadFluctuationPage([
    raw('g', { estimatedHours: 10 }),
    raw('a', { parentGoalId: 'g', estimatedHours: 3 }),
    raw('b', { parentGoalId: 'g', estimatedHours: 4 }),
  ])
  page.onPlanTap({ currentTarget: { dataset: { id: 'g' } } })
  await page.onPlanApply()

  assert.equal(byId(storage, 'g').estimatedHours, 7)
  // 重新排期是系统行为：不得计入波动数据
  assert.equal(byId(storage, 'g').modificationCount, 0)
  assert.deepEqual(byId(storage, 'g').changeLog, [])
  assert.equal(page.data.plan, null)
  assert.equal(page.data.applying, false)
  assert.equal(wx.__calls.loading.length, 1)
  assert.equal(wx.__calls.hideLoading, 1)
  assert.equal(wx.__calls.toast[0].title, '已按最新耗时重排')
  // 重排后再点应提示"已一致"
  page.onPlanTap({ currentTarget: { dataset: { id: 'g' } } })
  assert.equal(page.data.plan, null)
})

test('onPlanApply：多层修正一次写完（自底向上冒烟）', async () => {
  const { page, storage } = await loadFluctuationPage([
    raw('g', { estimatedHours: 100 }),
    raw('a', { parentGoalId: 'g', estimatedHours: 50 }),
    raw('a1', { parentGoalId: 'a', estimatedHours: 2 }),
    raw('a2', { parentGoalId: 'a', estimatedHours: 3 }),
  ])
  page.onPlanTap({ currentTarget: { dataset: { id: 'g' } } })
  assert.equal(page.data.plan.updates.length, 2)
  await page.onPlanApply()
  assert.equal(byId(storage, 'a').estimatedHours, 5)
  assert.equal(byId(storage, 'g').estimatedHours, 5)
})

test('onPlanApply：处理中重复点击不重复提交', async () => {
  const { page, storage, wx } = await loadFluctuationPage([
    raw('g', { estimatedHours: 10 }),
    raw('a', { parentGoalId: 'g', estimatedHours: 3 }),
  ])
  page.onPlanTap({ currentTarget: { dataset: { id: 'g' } } })
  page.setData({ applying: true })
  await page.onPlanApply()
  assert.equal(byId(storage, 'g').estimatedHours, 10) // 未被修改
  assert.equal(wx.__calls.loading.length, 0)
})

test('onPlanApply：没有方案时直接返回（防御性）', async () => {
  const { page, wx } = await loadFluctuationPage([raw('g')])
  await page.onPlanApply()
  assert.equal(wx.__calls.loading.length, 0)
})

test('onPlanCancel：关闭弹层', async () => {
  const { page } = await loadFluctuationPage([
    raw('g', { estimatedHours: 10 }),
    raw('a', { parentGoalId: 'g', estimatedHours: 3 }),
  ])
  page.onPlanTap({ currentTarget: { dataset: { id: 'g' } } })
  assert.ok(page.data.plan)
  page.onPlanCancel()
  assert.equal(page.data.plan, null)
})

test('onNoop：弹层内部点击不关闭弹层', async () => {
  const { page } = await loadFluctuationPage([
    raw('g', { estimatedHours: 10 }),
    raw('a', { parentGoalId: 'g', estimatedHours: 3 }),
  ])
  page.onPlanTap({ currentTarget: { dataset: { id: 'g' } } })
  page.onNoop()
  assert.ok(page.data.plan)
})

test('onPullDownRefresh：下拉刷新后停止刷新动画', async () => {
  const { page } = await loadFluctuationPage([raw('g')])
  await page.onPullDownRefresh()
  assert.equal(page.data.loading, false)
  assert.equal(page.data.summary.taskCount, 1)
})
