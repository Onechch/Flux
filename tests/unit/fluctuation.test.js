/**
 * tests/unit/fluctuation.test.js —— 需求波动 / 牛鞭效应检测（utils/fluctuation.js）
 *
 * 覆盖：森林构建的兜底（悬挂父引用 / 自环 / 成环 / 重复 _id / 无 _id）、
 * 四类风险的触发与不触发边界、聚合口径（目标 / 层级 / 子树）、
 * 重新排期方案的修正项与关键路径。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const fluctuation = require(path.join(
  __dirname,
  '..',
  '..',
  'miniprogram',
  'utils',
  'fluctuation'
))
const api = require(path.join(__dirname, '..', '..', 'miniprogram', 'utils', 'api'))

const NOW = 1700000000000
const DAY = 24 * 3600 * 1000

/** 造一个任务（只填测试关心的字段） */
function task(id, extra) {
  return Object.assign(
    {
      _id: id,
      title: id,
      estimatedHours: 1,
      status: 'pending',
      parentGoalId: '',
      modificationCount: 0,
      changeLog: [],
      dependencies: [],
    },
    extra || {}
  )
}

/** 造 n 条变更明细（默认全在窗口内、字段为 estimatedHours 之外的字段） */
function log(n, extra) {
  const out = []
  for (let i = 0; i < n; i++) {
    out.push(
      Object.assign(
        { ts: NOW - i * 1000, field: 'title', from: 'a' + i, to: 'b' + i },
        extra || {}
      )
    )
  }
  return out
}

function kindsOf(res) {
  return res.risks.map((r) => r.kind)
}

/* ==================== 常量交叉校验 ==================== */

test('CHANGE_LOG_MAX 与 api 层保持一致（防止两处漂移）', () => {
  assert.equal(fluctuation.DEFAULT_CHANGE_LOG_MAX, api.CHANGE_LOG_MAX)
})

test('riskKindLabel：已知类型返回中文标签，未知类型回退原值', () => {
  assert.equal(fluctuation.riskKindLabel('amplified'), '计划被放大')
  assert.equal(fluctuation.riskKindLabel('whatever'), 'whatever')
  assert.equal(fluctuation.riskKindLabel(null), '')
})

/* ==================== buildForest：结构与兜底 ==================== */

test('buildForest：父子关系、depth、_rootId、同层依赖名映射', () => {
  const forest = fluctuation.buildForest([
    task('g', { title: '目标' }),
    task('a', { title: 'A', parentGoalId: 'g', dependencies: ['b'] }),
    task('b', { title: 'B', parentGoalId: 'g' }),
    task('a1', { title: 'A1', parentGoalId: 'a' }),
  ])
  assert.equal(forest.roots.length, 1)
  assert.equal(forest.roots[0]._id, 'g')
  assert.equal(forest.nodes['g'].depth, 0)
  assert.equal(forest.nodes['a'].depth, 1)
  assert.equal(forest.nodes['a1'].depth, 2)
  assert.equal(forest.nodes['a1']._rootId, 'g')
  assert.deepEqual(forest.nodes['g'].children.map((c) => c._id), ['a', 'b'])
  assert.deepEqual(forest.nodes['a'].depTitles, ['B'])
})

test('buildForest：同层依赖映射丢弃跨层/自依赖/不存在引用', () => {
  const forest = fluctuation.buildForest([
    task('g'),
    task('a', { title: 'A', parentGoalId: 'g', dependencies: ['b', 'a', 'a1', 'ghost'] }),
    task('b', { title: 'B', parentGoalId: 'g' }),
    task('a1', { title: 'A1', parentGoalId: 'a' }),
  ])
  // b 是同层 → 保留；a 是自依赖 → 丢弃；a1 是下层 → 丢弃；ghost 不存在 → 丢弃
  assert.deepEqual(forest.nodes['a'].depTitles, ['B'])
})

test('buildForest：parentGoalId 指向不存在的节点时视为根（不丢节点）', () => {
  const forest = fluctuation.buildForest([task('x', { parentGoalId: 'ghost' })])
  assert.equal(forest.roots.length, 1)
  assert.equal(forest.nodes['x'].depth, 0)
  assert.equal(forest.nodes['x']._parent, '')
})

test('buildForest：自环（自己是自己的父）视为根', () => {
  const forest = fluctuation.buildForest([task('x', { parentGoalId: 'x' })])
  assert.equal(forest.roots.length, 1)
  assert.equal(forest.nodes['x'].depth, 0)
  assert.equal(forest.nodes['x']._cyclic, false)
})

test('buildForest：成环（a→b→a）不丢节点，断开父边提为根并标记 _cyclic', () => {
  const forest = fluctuation.buildForest([
    task('a', { parentGoalId: 'b' }),
    task('b', { parentGoalId: 'a' }),
  ])
  assert.equal(forest.ids.length, 2)
  assert.equal(forest.roots.length, 1) // 提为根的那个
  const cyc = forest.ids.filter((id) => forest.nodes[id]._cyclic)
  assert.equal(cyc.length, 1)
  // 未成环的那一半仍挂在提为根的节点下
  const root = forest.roots[0]
  assert.equal(root.children.length, 1)
  assert.equal(root.depth, 0)
  assert.equal(root.children[0].depth, 1)
})

test('buildForest：无 _id 的节点被丢弃，重复 _id 只保留首个', () => {
  const forest = fluctuation.buildForest([
    { title: 'no-id' },
    task('dup', { title: '第一个' }),
    task('dup', { title: '第二个' }),
  ])
  assert.deepEqual(forest.ids, ['dup'])
  assert.equal(forest.nodes['dup'].title, '第一个')
})

test('buildForest：容忍非数组输入与 null 元素', () => {
  assert.deepEqual(fluctuation.buildForest(null).ids, [])
  assert.deepEqual(fluctuation.buildForest([null, undefined, 1]).ids, [])
})

/* ==================== analyzeFluctuation：空与干净数据 ==================== */

test('analyzeFluctuation：空输入返回全 0 结构，不抛错', () => {
  const res = fluctuation.analyzeFluctuation([], { now: NOW })
  assert.equal(res.summary.taskCount, 0)
  assert.equal(res.summary.goalCount, 0)
  assert.equal(res.summary.totalChanges, 0)
  assert.equal(res.summary.riskCount, 0)
  assert.equal(res.summary.topRisk, null)
  assert.equal(res.summary.logTruncated, false)
  assert.deepEqual(res.risks, [])
  assert.deepEqual(res.goals, [])
  assert.deepEqual(res.byDepth, [])
})

test('analyzeFluctuation：零变更的树不产生任何风险', () => {
  const res = fluctuation.analyzeFluctuation(
    [task('g'), task('a', { parentGoalId: 'g' }), task('b', { parentGoalId: 'a' })],
    { now: NOW }
  )
  assert.equal(res.summary.riskCount, 0)
  assert.equal(res.summary.taskCount, 3)
  assert.equal(res.summary.goalCount, 1)
})

/* ==================== R1 unstable_root ==================== */

test('unstable_root：根节点自身变更达阈值即判定（含"下游任何排期都会被推翻"的提示）', () => {
  const res = fluctuation.analyzeFluctuation([task('g', { title: '目标', modificationCount: 4 })], {
    now: NOW,
  })
  assert.deepEqual(kindsOf(res), ['unstable_root'])
  const r = res.risks[0]
  assert.equal(r.isRoot, true)
  assert.equal(r.taskId, 'g')
  assert.ok(r.message.indexOf('4 次') > -1)
  assert.ok(r.advice.length > 0)
})

test('unstable_root：低于阈值（3 次）不判定', () => {
  const res = fluctuation.analyzeFluctuation([task('g', { modificationCount: 3 })], { now: NOW })
  assert.equal(res.summary.riskCount, 0)
})

test('unstable_root：与 burst 互斥（根节点近期高频变更只报一次）', () => {
  const res = fluctuation.analyzeFluctuation(
    [task('g', { modificationCount: 5, changeLog: log(5) })],
    { now: NOW }
  )
  assert.deepEqual(kindsOf(res), ['unstable_root'])
})

test('unstable_root：根节点仍可叠加 estimate_churn（工时估不准是独立信号）', () => {
  const res = fluctuation.analyzeFluctuation(
    [
      task('g', {
        modificationCount: 5,
        changeLog: [
          { ts: NOW, field: 'estimatedHours', from: 1, to: 3 },
          { ts: NOW - 1000, field: 'estimatedHours', from: 3, to: 9 },
        ],
      }),
    ],
    { now: NOW }
  )
  assert.deepEqual(kindsOf(res).sort(), ['estimate_churn', 'unstable_root'])
})

/* ==================== R2 amplified ==================== */

test('amplified：需求源头 0 次变更、子节点 3 次 → 判定放大（pathAmp = 3）', () => {
  const res = fluctuation.analyzeFluctuation(
    [task('g', { title: '目标' }), task('a', { title: 'A', parentGoalId: 'g', modificationCount: 3 })],
    { now: NOW }
  )
  assert.deepEqual(kindsOf(res), ['amplified'])
  const r = res.risks[0]
  assert.equal(r.pathAmp, 3)
  assert.equal(r.localAmp, 3)
  assert.equal(r.rootChanges, 0) // 放大比的分母，供页面直接展示
  assert.equal(r.parentChanges, 0)
  assert.equal(r.goalId, 'g')
  assert.equal(r.goalTitle, '目标')
  assert.ok(r.message.indexOf('3 倍') > -1)
})

test('amplified：证据字段 rootChanges / parentChanges 如实反映分母', () => {
  const res = fluctuation.analyzeFluctuation(
    [
      task('g', { modificationCount: 3 }), // 源头 3 次（未达 unstable_root 阈值 4）
      task('a', { parentGoalId: 'g', modificationCount: 3 }),
      task('a1', { parentGoalId: 'a', modificationCount: 9 }),
    ],
    { now: NOW }
  )
  const a1 = res.risks.find((r) => r.taskId === 'a1')
  assert.ok(a1, 'a1 相对源头放大 3 倍应判定')
  assert.equal(a1.rootChanges, 3)
  assert.equal(a1.parentChanges, 3)
  assert.equal(a1.localAmp, 3)
})

test('amplified：子节点变更 2 次低于噪声地板（minChanges=3）不判定', () => {
  const res = fluctuation.analyzeFluctuation(
    [task('g'), task('a', { parentGoalId: 'g', modificationCount: 2 })],
    { now: NOW }
  )
  assert.equal(res.summary.riskCount, 0)
})

test('amplified：源头也在变（6 次）时子节点 3 次不算放大（pathAmp = 0.5）', () => {
  const res = fluctuation.analyzeFluctuation(
    [task('g', { modificationCount: 6 }), task('a', { parentGoalId: 'g', modificationCount: 3 })],
    { now: NOW }
  )
  // 源头 6 次已触发 unstable_root，但子节点的 3 次相对源头是 0.5 倍，不应判为"被放大"
  assert.deepEqual(kindsOf(res), ['unstable_root'])
  assert.equal(kindsOf(res).indexOf('amplified'), -1)
})

test('amplified：阈值可通过 options 调整（ampRatio = 2 时 4/2 判定）', () => {
  const tasks = [
    task('g', { modificationCount: 2 }),
    task('a', { parentGoalId: 'g', modificationCount: 4 }),
  ]
  assert.equal(fluctuation.analyzeFluctuation(tasks, { now: NOW }).summary.riskCount, 0)
  const res = fluctuation.analyzeFluctuation(tasks, { now: NOW, ampRatio: 2 })
  assert.deepEqual(kindsOf(res), ['amplified'])
  assert.equal(res.thresholds.ampRatio, 2)
})

test('amplified：根节点自身不会被判为"被放大"（isRoot 排除）', () => {
  const res = fluctuation.analyzeFluctuation([task('g', { modificationCount: 9 })], { now: NOW })
  assert.equal(kindsOf(res).indexOf('amplified'), -1)
})

test('amplified：多层时按"相对需求源头"判定，localAmp 单独反映是哪一跳放大', () => {
  // g(1) → a(6) → a1(6)：a 相对 g 放大 6 倍；a1 相对 g 也是 6 倍，但相对 a 只有 1 倍
  const res = fluctuation.analyzeFluctuation(
    [
      task('g', { modificationCount: 1 }),
      task('a', { parentGoalId: 'g', modificationCount: 6 }),
      task('a1', { parentGoalId: 'a', modificationCount: 6 }),
    ],
    { now: NOW }
  )
  const a = res.risks.find((r) => r.taskId === 'a')
  const a1 = res.risks.find((r) => r.taskId === 'a1')
  assert.equal(a.pathAmp, 6)
  assert.equal(a.localAmp, 6) // 放大发生在这一跳
  assert.equal(a1.pathAmp, 6)
  assert.equal(a1.localAmp, 1) // 这一跳没有放大，只是继承
  assert.equal(a.depth, 1)
  assert.equal(a1.depth, 2)
})

/* ==================== R3 burst ==================== */

test('burst：窗口内 4 次变更判定为动荡期', () => {
  const res = fluctuation.analyzeFluctuation(
    [task('g'), task('a', { title: 'A', parentGoalId: 'g', modificationCount: 4, changeLog: log(4) })],
    { now: NOW }
  )
  const kinds = kindsOf(res)
  assert.ok(kinds.indexOf('burst') > -1)
  const r = res.risks.find((x) => x.kind === 'burst')
  assert.equal(r.recentChanges, 4)
  assert.ok(r.message.indexOf('7 天内') > -1)
})

test('burst：窗口外的变更不计入（8 天前的 4 次不判定）', () => {
  const old = log(4).map((e, i) => Object.assign({}, e, { ts: NOW - 8 * DAY - i }))
  const res = fluctuation.analyzeFluctuation(
    [task('g'), task('a', { parentGoalId: 'g', modificationCount: 4, changeLog: old })],
    { now: NOW }
  )
  assert.equal(kindsOf(res).indexOf('burst'), -1)
})

test('burst：窗口天数可配置（windowDays = 1 时 3 天前的变更不算）', () => {
  const entries = log(4).map((e, i) => Object.assign({}, e, { ts: NOW - 3 * DAY - i }))
  const res = fluctuation.analyzeFluctuation(
    [task('a', { modificationCount: 4, changeLog: entries })],
    { now: NOW, windowDays: 1 }
  )
  assert.equal(res.summary.recentChanges, 0)
  assert.equal(kindsOf(res).indexOf('burst'), -1)
})

/* ==================== R4 estimate_churn ==================== */

test('estimate_churn：工时被调整 2 次 → 判定，并给出调整幅度', () => {
  const res = fluctuation.analyzeFluctuation(
    [
      task('g'),
      task('a', {
        title: 'A',
        parentGoalId: 'g',
        estimatedHours: 9,
        modificationCount: 2,
        changeLog: [
          { ts: NOW, field: 'estimatedHours', from: 1, to: 3 },
          { ts: NOW - 1000, field: 'estimatedHours', from: 3, to: 9 },
        ],
      }),
    ],
    { now: NOW }
  )
  const r = res.risks.find((x) => x.kind === 'estimate_churn')
  assert.ok(r, '应判定 estimate_churn')
  assert.equal(r.estimateChanges, 2)
  assert.equal(r.estimateSpread, 8) // 1 → 9
  assert.ok(r.message.indexOf('幅度 8h') > -1)
  assert.ok(r.message.indexOf('当前 9h') > -1)
})

test('estimate_churn：只调整 1 次不判定', () => {
  const res = fluctuation.analyzeFluctuation(
    [
      task('g'),
      task('a', {
        parentGoalId: 'g',
        modificationCount: 1,
        changeLog: [{ ts: NOW, field: 'estimatedHours', from: 1, to: 3 }],
      }),
    ],
    { now: NOW }
  )
  assert.equal(kindsOf(res).indexOf('estimate_churn'), -1)
})

test('estimate_churn：非数值 to 不参与幅度计算（spread = 0）', () => {
  const res = fluctuation.analyzeFluctuation(
    [
      task('a', {
        modificationCount: 2,
        changeLog: [
          { ts: NOW, field: 'estimatedHours', from: 1, to: 'x' },
          { ts: NOW - 1, field: 'estimatedHours', from: 1, to: null },
        ],
      }),
    ],
    { now: NOW }
  )
  const r = res.risks.find((x) => x.kind === 'estimate_churn')
  assert.ok(r)
  assert.equal(r.estimateSpread, 0)
  assert.equal(r.message.indexOf('幅度'), -1) // 无幅度时不展示该片段
})

/* ==================== 多信号叠加与排序 ==================== */

test('同一节点可同时命中 amplified / burst / estimate_churn（三个信号互不掩盖）', () => {
  const res = fluctuation.analyzeFluctuation(
    [
      task('g'),
      task('a', {
        title: 'A',
        parentGoalId: 'g',
        modificationCount: 4,
        changeLog: [
          { ts: NOW, field: 'estimatedHours', from: 1, to: 2 },
          { ts: NOW - 1, field: 'estimatedHours', from: 2, to: 5 },
          { ts: NOW - 2, field: 'title', from: 'x', to: 'y' },
          { ts: NOW - 3, field: 'description', from: 'x', to: 'y' },
        ],
      }),
    ],
    { now: NOW }
  )
  assert.deepEqual(kindsOf(res).sort(), ['amplified', 'burst', 'estimate_churn'])
})

test('risks 按 score 降序（源头问题优先于执行层问题）', () => {
  const res = fluctuation.analyzeFluctuation(
    [
      task('g', { modificationCount: 5 }), // unstable_root：50+40 = 90
      task('a', { parentGoalId: 'g', modificationCount: 3 }), // amplified：30+30+30 = 90? 见下断言
      task('b', { parentGoalId: 'g', modificationCount: 3, changeLog: log(4) }), // amplified + burst
    ],
    { now: NOW }
  )
  for (let i = 1; i < res.risks.length; i++) {
    assert.ok(res.risks[i - 1].score >= res.risks[i].score, '应保持 score 降序')
  }
  assert.equal(res.risks[0].taskId, 'g')
})

test('risks 受 maxRisks 限制（防止页面过长）', () => {
  const tasks = [task('g')]
  for (let i = 0; i < 10; i++) {
    tasks.push(task('c' + i, { parentGoalId: 'g', modificationCount: 3 }))
  }
  const all = fluctuation.analyzeFluctuation(tasks, { now: NOW })
  assert.equal(all.summary.riskCount, 10)
  assert.equal(all.risks.length, 10)
  const capped = fluctuation.analyzeFluctuation(tasks, { now: NOW, maxRisks: 3 })
  assert.equal(capped.summary.riskCount, 10) // 总数仍如实上报
  assert.equal(capped.risks.length, 3) // 只截断展示列表
})

test('summary.topRisk 与 risks[0] 一致，byKind 计数正确', () => {
  const res = fluctuation.analyzeFluctuation(
    [
      task('g1', { modificationCount: 5 }), // 源头自身反复变
      task('g2', { modificationCount: 3 }), // 源头相对稳定
      task('a', { parentGoalId: 'g2', modificationCount: 9 }), // 相对源头放大 3 倍
    ],
    { now: NOW }
  )
  assert.equal(res.summary.topRisk.taskId, res.risks[0].taskId)
  assert.equal(res.summary.byKind.unstable_root, 1)
  assert.equal(res.summary.byKind.amplified, 1)
  assert.equal(res.summary.byKind.burst, 0)
  assert.equal(res.summary.byKind.estimate_churn, 0)
})

/* ==================== 聚合口径 ==================== */

test('summary：totalChanges / recentChanges / logTruncated 口径', () => {
  const res = fluctuation.analyzeFluctuation(
    [
      task('g', { modificationCount: 2 }),
      task('a', { parentGoalId: 'g', modificationCount: 3, changeLog: log(2) }),
    ],
    { now: NOW }
  )
  assert.equal(res.summary.totalChanges, 5)
  assert.equal(res.summary.recentChanges, 2)
  assert.equal(res.summary.logTruncated, false)
})

test('summary.logTruncated：存在达到日志上限的节点时为 true（计数是下界）', () => {
  const res = fluctuation.analyzeFluctuation(
    [task('g', { modificationCount: 25, changeLog: log(api.CHANGE_LOG_MAX) })],
    { now: NOW }
  )
  assert.equal(res.summary.logTruncated, true)
})

test('goals：按子树变更量降序，含子树规模、总工作量与变更热区', () => {
  const res = fluctuation.analyzeFluctuation(
    [
      task('g1', { title: '目标1', modificationCount: 1 }),
      task('a', { title: 'A', parentGoalId: 'g1', modificationCount: 5 }),
      task('a1', { title: 'A1', parentGoalId: 'a', modificationCount: 2, estimatedHours: 2 }),
      task('g2', { title: '目标2', modificationCount: 1, estimatedHours: 3 }),
    ],
    { now: NOW }
  )
  assert.equal(res.goals.length, 2)
  assert.equal(res.goals[0].goalId, 'g1') // 子树 1+5+2 = 8 > g2 的 1
  const g1 = res.goals[0]
  assert.equal(g1.subtreeChanges, 8)
  assert.equal(g1.subtreeNodes, 3)
  assert.equal(g1.ownChanges, 1)
  assert.equal(g1.totalHours, 2) // 叶子 A1 的 2h
  // 热区 = 变更数 > 0 的节点按变更量降序取前 3：A(5) / A1(2) / 目标1自身(1)
  assert.equal(g1.hotNodes.length, 3)
  assert.deepEqual(g1.hotNodes.map((h) => h.taskId), ['a', 'a1', 'g1'])
  assert.equal(g1.riskCount, 1) // A 的 amplified
})

test('goals：无变更节点不进热区；总工作量按叶子求和', () => {
  const res = fluctuation.analyzeFluctuation(
    [
      task('g', { modificationCount: 0, estimatedHours: 999 }),
      task('a', { parentGoalId: 'g', estimatedHours: 2 }),
      task('b', { parentGoalId: 'g', estimatedHours: 3 }),
    ],
    { now: NOW }
  )
  assert.equal(res.goals[0].totalHours, 5) // 忽略父节点陈旧值 999，按叶子求和
  assert.deepEqual(res.goals[0].hotNodes, [])
})

test('byDepth：按层级聚合节点数与变更数（定位变更集中在哪一层）', () => {
  const res = fluctuation.analyzeFluctuation(
    [
      task('g', { modificationCount: 1 }),
      task('a', { parentGoalId: 'g', modificationCount: 2 }),
      task('b', { parentGoalId: 'g', modificationCount: 3 }),
      task('a1', { parentGoalId: 'a', modificationCount: 4 }),
    ],
    { now: NOW }
  )
  assert.deepEqual(res.byDepth, [
    { depth: 0, nodes: 1, changes: 1 },
    { depth: 1, nodes: 2, changes: 5 },
    { depth: 2, nodes: 1, changes: 4 },
  ])
})

test('metrics：按 ownChanges 降序，含子树聚合与层级', () => {
  const res = fluctuation.analyzeFluctuation(
    [
      task('g', { title: '目标' }),
      task('a', { title: 'A', parentGoalId: 'g', modificationCount: 5 }),
      task('b', { title: 'B', parentGoalId: 'g', modificationCount: 1 }),
    ],
    { now: NOW }
  )
  assert.equal(res.metrics[0].taskId, 'a')
  assert.equal(res.metrics[0].subtreeChanges, 5)
  assert.equal(res.metrics[0].subtreeNodes, 1)
  const g = res.metrics.find((m) => m.taskId === 'g')
  assert.equal(g.subtreeChanges, 6)
  assert.equal(g.subtreeNodes, 3)
  assert.equal(g.isRoot, true)
  assert.equal(g.depth, 0)
})

test('analyzeFluctuation：容忍 changeLog 中的脏条目（null / 非对象）', () => {
  const res = fluctuation.analyzeFluctuation(
    [task('a', { modificationCount: 1, changeLog: [null, 'x', 3, { ts: NOW, field: 'title' }] })],
    { now: NOW }
  )
  assert.equal(res.summary.recentChanges, 1)
})

/* ==================== planReschedule ==================== */

test('planReschedule：父节点耗时与子合计不一致时给出修正项', () => {
  const res = fluctuation.planReschedule(
    [
      task('g', { title: '目标', estimatedHours: 10 }),
      task('a', { title: 'A', parentGoalId: 'g', estimatedHours: 3 }),
      task('b', { title: 'B', parentGoalId: 'g', estimatedHours: 4 }),
    ],
    'g'
  )
  assert.equal(res.ok, true)
  assert.equal(res.title, '目标')
  assert.equal(res.totalHours, 7)
  assert.equal(res.updates.length, 1)
  assert.deepEqual(res.updates[0], { taskId: 'g', title: '目标', depth: 0, from: 10, to: 7 })
})

test('planReschedule：数据一致时无修正项（幂等）', () => {
  const res = fluctuation.planReschedule(
    [
      task('g', { estimatedHours: 7 }),
      task('a', { parentGoalId: 'g', estimatedHours: 3 }),
      task('b', { parentGoalId: 'g', estimatedHours: 4 }),
    ],
    'g'
  )
  assert.equal(res.ok, true)
  assert.deepEqual(res.updates, [])
  assert.equal(res.totalHours, 7)
})

test('planReschedule：多层自底向上冒烟修正（叶子改了，逐级重算）', () => {
  const res = fluctuation.planReschedule(
    [
      task('g', { estimatedHours: 100 }),
      task('a', { title: 'A', parentGoalId: 'g', estimatedHours: 50 }),
      task('a1', { title: 'A1', parentGoalId: 'a', estimatedHours: 2 }),
      task('a2', { title: 'A2', parentGoalId: 'a', estimatedHours: 3 }),
      task('b', { title: 'B', parentGoalId: 'g', estimatedHours: 4 }),
    ],
    'g'
  )
  assert.equal(res.totalHours, 9) // 2 + 3 + 4
  assert.deepEqual(
    res.updates.map((u) => [u.taskId, u.from, u.to]),
    [
      ['g', 100, 9], // 深度优先：根先出（depth 0）
      ['a', 50, 5],
    ]
  )
})

test('planReschedule：给出每层关键路径与层内工期', () => {
  const res = fluctuation.planReschedule(
    [
      task('g', { estimatedHours: 9 }),
      task('a', { title: 'A', parentGoalId: 'g', estimatedHours: 5 }),
      task('b', { title: 'B', parentGoalId: 'g', estimatedHours: 4, dependencies: ['a'] }),
      task('a1', { title: 'A1', parentGoalId: 'a', estimatedHours: 5 }),
    ],
    'g'
  )
  assert.equal(res.layers.length, 2)
  assert.equal(res.layers[0].depth, 1)
  assert.equal(res.layers[0].parentId, 'g')
  assert.equal(res.layers[0].layerHours, 9) // B 依赖 A：5 + 4
  assert.deepEqual(res.layers[0].criticalPath, ['A', 'B'])
  assert.equal(res.layers[1].depth, 2)
  assert.equal(res.layers[1].parentId, 'a')
  assert.deepEqual(res.layers[1].criticalPath, ['A1'])
})

test('planReschedule：目标不存在返回 ok:false 且结构完整（页面可直接渲染）', () => {
  const res = fluctuation.planReschedule([task('g')], 'ghost')
  assert.equal(res.ok, false)
  assert.equal(res.reason, '目标不存在或已被删除')
  assert.deepEqual(res.updates, [])
  assert.deepEqual(res.layers, [])
  assert.equal(res.totalHours, 0)
})

test('planReschedule：对叶子目标重排 = 自身耗时，无修正项', () => {
  const res = fluctuation.planReschedule([task('g', { estimatedHours: 6 })], 'g')
  assert.equal(res.ok, true)
  assert.equal(res.totalHours, 6)
  assert.deepEqual(res.updates, [])
  assert.deepEqual(res.layers, [])
})

test('planReschedule：容忍空输入', () => {
  const res = fluctuation.planReschedule(null, 'g')
  assert.equal(res.ok, false)
  assert.equal(res.totalHours, 0)
})
