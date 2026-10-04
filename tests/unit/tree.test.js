/**
 * tests/unit/tree.test.js —— 多层级任务树工具集（utils/tree.js）
 *
 * 覆盖：归一化约束（层/宽/总量）、AI 输出解析（围栏/前后缀/旧格式）、
 * DB↔树转换、每层 CPM 与瓶颈标注、卡点链、拍平渲染、完成联动、
 * 递归导入去重口径、调优差异同步、规则调优降级。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const tree = require(path.join(__dirname, '..', '..', 'miniprogram', 'utils', 'tree'))
const { createFakeApi } = require('../helpers/fake-api')

/* ==================== normalizeNode / 归一化约束 ==================== */

test('normalizeNode：空标题返回 null，标题截断到 30 字', () => {
  const stats = { count: 0 }
  assert.equal(tree.normalizeNode({ title: '   ' }, 0, { count: 0 }), null)
  assert.equal(tree.normalizeNode(null, 0, { count: 0 }), null)
  const n = tree.normalizeNode({ title: '标'.repeat(50) }, 0, stats)
  assert.equal(n.title.length, 30)
})

test('normalizeNode：叶子耗时 clamp 到 0.5~200 小时', () => {
  const cases = [
    [0, 1],
    [0.1, 0.5],
    [0.5, 0.5],
    [200, 200],
    [500, 200],
    [-3, 1],
    [NaN, 1],
    ['abc', 1],
  ]
  cases.forEach(([input, expected]) => {
    const n = tree.normalizeNode({ title: 'T', estimatedHours: input }, 0, { count: 0 })
    assert.equal(n.estimatedHours, expected, '耗时 ' + input + ' 应归一为 ' + expected)
  })
})

test('normalizeNode：父节点耗时强制等于直接子任务合计', () => {
  const n = tree.normalizeNode(
    {
      title: '根',
      estimatedHours: 9999,
      children: [
        { title: 'A', estimatedHours: 2 },
        { title: 'B', estimatedHours: 3 },
      ],
    },
    0,
    { count: 0 }
  )
  assert.equal(n.estimatedHours, 5, 'AI 给出的父耗时不可信，必须重算')
  assert.equal(n.isExecutable, false)
})

test('normalizeNode：同父同名子任务去重（保留首个）', () => {
  const n = tree.normalizeNode(
    {
      title: '根',
      children: [
        { title: '收集资料', estimatedHours: 1 },
        { title: '收集资料', estimatedHours: 9 },
        { title: '撰写', estimatedHours: 2 },
      ],
    },
    0,
    { count: 0 }
  )
  assert.deepEqual(
    n.children.map((c) => c.title),
    ['收集资料', '撰写']
  )
  assert.equal(n.children[0].estimatedHours, 1)
})

test('normalizeNode：每节点最多 8 个子任务', () => {
  const children = []
  for (let i = 0; i < 12; i++) children.push({ title: '子' + i, estimatedHours: 1 })
  const n = tree.normalizeNode({ title: '根', children: children }, 0, { count: 0 })
  assert.equal(n.children.length, 8)
})

test('normalizeNode：深度上限 5（根为 0 层，更深节点被丢弃）', () => {
  // 构造 8 层链：root(0) → 1 → 2 → 3 → 4 → 5 → 6
  let leaf = { title: '最深', estimatedHours: 1 }
  for (let d = 6; d >= 0; d--) leaf = { title: 'L' + d, children: [leaf] }
  const n = tree.normalizeNode(leaf, 0, { count: 0 })
  let depth = 0
  let cur = n
  while (cur.children && cur.children.length) {
    cur = cur.children[0]
    depth += 1
  }
  assert.equal(depth, 5, '最深节点应位于第 5 层（与 DB level 上限 5 一致）')
  assert.equal(cur.children.length, 0)
})

test('normalizeNode：全树节点数不超过 40', () => {
  // 根 + 每层 8 个子节点，展开 3 层即 1 + 8 + 64 > 40
  const kids = []
  for (let i = 0; i < 8; i++) {
    const grand = []
    for (let j = 0; j < 8; j++) grand.push({ title: 'G' + i + '_' + j, estimatedHours: 1 })
    kids.push({ title: 'C' + i, children: grand })
  }
  const n = tree.normalizeNode({ title: '根', children: kids }, 0, { count: 0 })
  let total = 0
  ;(function walk(node) {
    total += 1
    ;(node.children || []).forEach(walk)
  })(n)
  assert.ok(total <= 40, '实际节点数 ' + total + ' 应 ≤ 40')
})

test('normalizeNode：dependencies 剔除自引用并截断到 30 字', () => {
  const n = tree.normalizeNode(
    { title: 'A', dependencies: ['A', '  ', 'B'.repeat(40), 'C'] },
    0,
    { count: 0 }
  )
  assert.deepEqual(n.dependencies, ['B'.repeat(30), 'C'])
})

test('normalizeNode：父节点 bottleneck 提示转移到命中子任务的 aiHint', () => {
  // 命中口径（与 AI 提示词约定一致）：子任务名 === bottleneck，或子任务名包含 bottleneck
  const exact = tree.normalizeNode(
    {
      title: '蛋白表达',
      bottleneck: '诱导表达条件优化',
      bottleneckReason: '表达量不达标，需优化诱导条件',
      children: [
        { title: '载体构建', estimatedHours: 1 },
        { title: '诱导表达条件优化', estimatedHours: 2 },
      ],
    },
    0,
    { count: 0 }
  )
  assert.equal(exact.children[1].aiHint, '表达量不达标，需优化诱导条件')
  assert.equal(exact.children[0].aiHint, '')

  const partial = tree.normalizeNode(
    {
      title: '实验执行',
      bottleneck: '蛋白表达',
      bottleneckReason: '表达量不达标',
      children: [{ title: '蛋白表达条件摸索', estimatedHours: 2 }],
    },
    0,
    { count: 0 }
  )
  assert.equal(partial.children[0].aiHint, '表达量不达标')

  // 完全匹配不上的 bottleneck 不产生 aiHint（不误标）
  const miss = tree.normalizeNode(
    {
      title: '实验执行',
      bottleneck: '完全不存在的任务',
      bottleneckReason: '原因',
      children: [{ title: '蛋白表达', estimatedHours: 2 }],
    },
    0,
    { count: 0 }
  )
  assert.equal(miss.children[0].aiHint, '')
})

/* ==================== extractTreeResult ==================== */

test('extractTreeResult：纯 JSON 正常解析', () => {
  const r = tree.extractTreeResult(
    JSON.stringify({ goal: { title: '目标', children: [{ title: 'A', estimatedHours: 2 }] } }),
    '目标'
  )
  assert.equal(r.goal.title, '目标')
  assert.equal(r.goal.children.length, 1)
  assert.deepEqual(r.infoGaps, [])
})

test('extractTreeResult：兼容代码块围栏与前后缀解释文字', () => {
  const raw =
    '好的，以下是拆解结果：\n```json\n{"goal":{"title":"目标","children":[{"title":"A","estimatedHours":1}]}}\n```\n希望有帮助。'
  const r = tree.extractTreeResult(raw, '目标')
  assert.equal(r.goal.children.length, 1)
})

test('extractTreeResult：旧版扁平格式（tasks）转为两层树', () => {
  const r = tree.extractTreeResult(
    JSON.stringify({
      tasks: [{ name: '第一步', estimatedHours: 2, dependencies: [] }],
      infoGaps: ['有截止日期吗？'],
    }),
    '旧目标'
  )
  assert.equal(r.goal.title, '旧目标')
  assert.equal(r.goal.children[0].title, '第一步')
  assert.deepEqual(r.infoGaps, ['有截止日期吗？'])
})

test('extractTreeResult：infoGaps 截断为 3 条、单项 40 字', () => {
  const r = tree.extractTreeResult(
    JSON.stringify({
      goal: { title: '目标', children: [{ title: 'A', estimatedHours: 1 }] },
      infoGaps: ['一', '二', '三', '四', '五'],
    }),
    '目标'
  )
  assert.equal(r.infoGaps.length, 3)
})

test('extractTreeResult：解析失败 / 无子任务 / 空输入均返回 null', () => {
  assert.equal(tree.extractTreeResult('', '目标'), null)
  assert.equal(tree.extractTreeResult('完全不是 JSON', '目标'), null)
  assert.equal(tree.extractTreeResult('{"goal":{"title":"只有根"}}', '目标'), null)
  assert.equal(tree.extractTreeResult(null, '目标'), null)
})

test('treeToFlatTasks：只取第一层子任务', () => {
  const flat = tree.treeToFlatTasks({
    title: '根',
    children: [
      { title: 'A', estimatedHours: 1, dependencies: [] },
      { title: 'B', estimatedHours: 2, dependencies: ['A'] },
    ],
  })
  assert.deepEqual(flat, [
    { name: 'A', estimatedHours: 1, dependencies: [] },
    { name: 'B', estimatedHours: 2, dependencies: ['A'] },
  ])
  assert.deepEqual(tree.treeToFlatTasks(null), [])
})

/* ==================== buildTreeFromTasks ==================== */

test('buildTreeFromTasks：依赖 _id 映射为同层任务名', () => {
  const all = [
    { _id: 'g1', title: '目标', estimatedHours: 5, status: 'in_progress' },
    { _id: 'a', title: 'A', estimatedHours: 2, parentGoalId: 'g1', dependencies: [] },
    { _id: 'b', title: 'B', estimatedHours: 3, parentGoalId: 'g1', dependencies: ['a'] },
  ]
  const t = tree.buildTreeFromTasks(all[0], all)
  assert.equal(t.children.length, 2)
  assert.deepEqual(t.children[1].dependencies, ['A'], '_id 应映射为同层任务名')
})

test('buildTreeFromTasks：映射不到的依赖（跨层/悬空）被丢弃', () => {
  const all = [
    { _id: 'g1', title: '目标' },
    { _id: 'a', title: 'A', parentGoalId: 'g1', dependencies: ['不存在的id', 'g1'] },
    { _id: 'x', title: '别的目标的子任务', parentGoalId: 'g9' },
  ]
  const t = tree.buildTreeFromTasks(all[0], all)
  assert.deepEqual(t.children[0].dependencies, [], '悬空与跨层引用都应被丢弃')
})

test('buildTreeFromTasks：自引用依赖被丢弃', () => {
  const all = [
    { _id: 'g1', title: '目标' },
    { _id: 'a', title: 'A', parentGoalId: 'g1', dependencies: ['a'] },
  ]
  const t = tree.buildTreeFromTasks(all[0], all)
  assert.deepEqual(t.children[0].dependencies, [])
})

/* ==================== 每层 CPM / 瓶颈 / 卡点链 ==================== */

/** 构造一棵带 _id 的树（模拟 DB 树） */
function makeTree(spec, parentId, level) {
  return spec.map((s, i) => {
    const id = s._id || (parentId ? parentId + '-' + i : 'n' + i)
    const node = {
      _id: id,
      title: s.title,
      estimatedHours: s.estimatedHours === undefined ? 1 : s.estimatedHours,
      actualHours: s.actualHours || 0,
      status: s.status || 'pending',
      aiHint: s.aiHint || '',
      dependencies: s.dependencies || [],
      children: [],
    }
    node.children = makeTree(s.children || [], id, (level || 0) + 1)
    if (node.children.length) {
      node.estimatedHours =
        Math.round(node.children.reduce((sum, c) => sum + c.estimatedHours, 0) * 10) / 10
    }
    return node
  })
}

test('computeTreeMeta：每层都标注一个瓶颈，卡点链逐层向下', () => {
  const root = {
    _id: 'root',
    title: '推进课题',
    children: makeTree(
      [
        {
          title: '实验执行',
          estimatedHours: 10,
          children: [{ title: '蛋白表达', estimatedHours: 8 }, { title: '功能验证', estimatedHours: 2 }],
        },
        { title: '论文撰写', estimatedHours: 3 },
      ],
      'root'
    ),
  }
  const meta = tree.computeTreeMeta(root)
  // 第一层：实验执行(10) 比 论文撰写(3) 分高
  assert.equal(meta.tree.children[0].isBottleneck, true)
  assert.equal(meta.tree.children[1].isBottleneck, false)
  // 第二层：蛋白表达(8) 比 功能验证(2) 分高
  const 实验执行 = meta.tree.children[0]
  assert.equal(实验执行.children[0].isBottleneck, true)
  // 卡点链 = [实验执行, 蛋白表达]
  assert.deepEqual(
    meta.chain.map((n) => n.title),
    ['实验执行', '蛋白表达']
  )
  assert.equal(meta.clog.title, '蛋白表达')
  assert.equal(meta.clog.isClog, true)
  // expandedIds 以节点 _id 为 key（供 flattenForDisplay 使用）
  assert.equal(meta.expandedIds[实验执行._id], true)
  assert.equal(meta.expandedIds[meta.clog._id], true)
  assert.equal(Object.keys(meta.expandedIds).length, 2, '链上两个节点都应标记展开')
})

test('computeTreeMeta：aiHint（AI 标记卡住）优先级高于耗时', () => {
  const root = {
    _id: 'root',
    title: '目标',
    children: makeTree(
      [
        { title: '普通大任务', estimatedHours: 100 },
        { title: '被标记卡住', estimatedHours: 1, aiHint: '表达量不达标' },
      ],
      'root'
    ),
  }
  const meta = tree.computeTreeMeta(root)
  assert.equal(meta.clog.title, '被标记卡住')
})

test('computeTreeMeta：实际耗时超预估 1.5 倍的任务优先成为瓶颈', () => {
  const root = {
    _id: 'root',
    title: '目标',
    children: makeTree(
      [
        { title: '预计很久', estimatedHours: 10 },
        { title: '已经严重超时', estimatedHours: 2, actualHours: 9 },
      ],
      'root'
    ),
  }
  const meta = tree.computeTreeMeta(root)
  assert.equal(meta.clog.title, '已经严重超时')
})

test('computeTreeMeta：已完成任务不参与瓶颈评选', () => {
  const root = {
    _id: 'root',
    title: '目标',
    children: makeTree(
      [
        { title: '已完成的大任务', estimatedHours: 100, status: 'completed' },
        { title: '未完成的小任务', estimatedHours: 1 },
      ],
      'root'
    ),
  }
  const meta = tree.computeTreeMeta(root)
  assert.equal(meta.clog.title, '未完成的小任务')
  assert.equal(meta.tree.children[0].isBottleneck, false, '已完成任务不应被标为瓶颈')
})

test('computeTreeMeta：重复调用不残留脏标记（幂等）', () => {
  const root = {
    _id: 'root',
    title: '目标',
    children: makeTree(
      [
        { title: 'A', estimatedHours: 5 },
        { title: 'B', estimatedHours: 1 },
      ],
      'root'
    ),
  }
  const first = tree.computeTreeMeta(root).chain.map((n) => n.title)
  const second = tree.computeTreeMeta(root).chain.map((n) => n.title)
  assert.deepEqual(first, second)
  // 非链上节点不应带 isClog
  assert.equal(root.children[1].isClog, false)
  assert.equal(root.children[1].isBottleneck, false)
})

test('findBottleneckChain：无瓶颈时返回空链', () => {
  const root = { _id: 'root', title: '目标', children: [] }
  tree.annotateTreeCPM(root)
  assert.deepEqual(tree.findBottleneckChain(root), [])
})

/* ==================== 拍平显示 ==================== */

test('flattenForDisplay：展开节点输出后代，折叠节点不输出后代', () => {
  const root = {
    _id: 'root',
    title: '目标',
    children: makeTree(
      [
        { title: 'A', children: [{ title: 'A1' }, { title: 'A2' }] },
        { title: 'B' },
      ],
      'root'
    ),
  }
  tree.computeTreeMeta(root)
  const collapsed = tree.flattenForDisplay(root, {})
  assert.deepEqual(
    collapsed.map((r) => r.title),
    ['A', 'B'],
    '未展开时不应出现 A 的后代'
  )
  assert.equal(collapsed[0].hasChildren, true)
  assert.equal(collapsed[0].expanded, false)
  assert.equal(collapsed[0].depth, 1)

  const expanded = tree.flattenForDisplay(root, { [root.children[0]._id]: true })
  assert.deepEqual(
    expanded.map((r) => r.title),
    ['A', 'A1', 'A2', 'B']
  )
  assert.equal(expanded[1].depth, 2, '缩进层级应逐层 +1')
})

test('collectKeys：收集全树 key（与 flattenForDisplay 同规则）', () => {
  const root = {
    _id: 'root',
    title: '目标',
    children: makeTree([{ title: 'A', children: [{ title: 'A1' }] }], 'root'),
  }
  const keys = tree.collectKeys(root)
  const rows = tree.flattenForDisplay(root, keys)
  assert.deepEqual(
    rows.map((r) => r.title),
    ['A', 'A1'],
    'collectKeys 全展开后应能看到全部节点'
  )
  Object.keys(keys).forEach((k) => assert.equal(keys[k], true))
})

test('flattenForDisplay：无 _id 的预览树用路径 key（避免 AI 树 key 冲突）', () => {
  const root = {
    title: '目标',
    children: [
      { title: '同名', estimatedHours: 1, children: [] },
      { title: '同名', estimatedHours: 2, children: [] },
    ],
  }
  const rows = tree.flattenForDisplay(root, {})
  assert.equal(rows.length, 2)
  assert.notEqual(rows[0].key, rows[1].key, '同名兄弟节点必须有不同 key')
})

test('toAITree：剥离运行时字段，保留结构与依赖', () => {
  const node = {
    _id: 'x',
    title: 'A',
    estimatedHours: 2,
    dependencies: ['B'],
    status: 'completed',
    actualHours: 5,
    isCritical: true,
    isBottleneck: true,
    isClog: true,
    depth: 3,
    _score: 999,
    aiHint: '提示',
    children: [{ _id: 'y', title: 'A1', estimatedHours: 1, dependencies: [], children: [] }],
  }
  const out = tree.toAITree(node)
  assert.deepEqual(Object.keys(out).sort(), ['aiHint', 'children', 'dependencies', 'estimatedHours', 'isExecutable', 'title'])
  assert.equal(out.isExecutable, false)
  assert.equal(out.children[0].isExecutable, true)
  assert.equal(out._id, undefined)
  assert.equal(out.status, undefined)
})

/* ==================== 完成联动 ==================== */

test('computeAutoCompleted：全部子任务完成后逐层向上自动完成', () => {
  const tasks = [
    { _id: 'g', title: '目标', status: 'in_progress' },
    { _id: 'a', title: 'A', parentGoalId: 'g', status: 'pending' },
    { _id: 'b', title: 'B', parentGoalId: 'g', status: 'completed' },
    { _id: 'a1', title: 'A1', parentGoalId: 'a', status: 'completed' },
  ]
  const autos = tree.computeAutoCompleted(tasks)
  assert.deepEqual(
    autos.map((t) => t._id).sort(),
    ['a', 'g'],
    'A 与目标都应被联动完成（A 的子任务已完成，且 A 完成后目标子任务全完成）'
  )
})

test('computeAutoCompleted：存在未完成子任务时父节点不自动完成', () => {
  const tasks = [
    { _id: 'g', title: '目标', status: 'in_progress' },
    { _id: 'a', title: 'A', parentGoalId: 'g', status: 'completed' },
    { _id: 'b', title: 'B', parentGoalId: 'g', status: 'pending' },
  ]
  assert.deepEqual(tree.computeAutoCompleted(tasks), [])
})

test('computeAutoCompleted：已完成的节点不重复返回', () => {
  const tasks = [
    { _id: 'g', title: '目标', status: 'completed' },
    { _id: 'a', title: 'A', parentGoalId: 'g', status: 'completed' },
  ]
  assert.deepEqual(tree.computeAutoCompleted(tasks), [])
})

test('computeAutoCompleted：叶子节点（无子任务）不会被联动完成', () => {
  const tasks = [{ _id: 'g', title: '目标', status: 'pending' }]
  assert.deepEqual(tree.computeAutoCompleted(tasks), [])
})

test('computeAutoCompleted：四层链一次收敛（不动点迭代）', () => {
  const tasks = [
    { _id: 'l0', title: '目标', status: 'in_progress' },
    { _id: 'l1', title: '阶段', parentGoalId: 'l0', status: 'in_progress' },
    { _id: 'l2', title: '任务', parentGoalId: 'l1', status: 'in_progress' },
    { _id: 'l3', title: '步骤', parentGoalId: 'l2', status: 'completed' },
  ]
  const autos = tree.computeAutoCompleted(tasks).map((t) => t._id)
  assert.deepEqual(autos.sort(), ['l0', 'l1', 'l2'])
})

/* ==================== 递归导入 ==================== */

function draftTree() {
  return {
    title: '完成季度汇报',
    estimatedHours: 6,
    dependencies: [],
    isExecutable: false,
    aiHint: '',
    children: [
      {
        title: '准备数据',
        estimatedHours: 2,
        dependencies: [],
        isExecutable: false,
        aiHint: '',
        children: [
          { title: '收集资料', estimatedHours: 1, dependencies: [], isExecutable: true, aiHint: '', children: [] },
          { title: '整理表格', estimatedHours: 1, dependencies: ['收集资料'], isExecutable: true, aiHint: '', children: [] },
        ],
      },
      {
        title: '撰写PPT',
        estimatedHours: 4,
        dependencies: ['准备数据'],
        isExecutable: false,
        aiHint: '',
        children: [
          { title: '收集资料', estimatedHours: 2, dependencies: [], isExecutable: true, aiHint: '', children: [] },
          { title: '排版美化', estimatedHours: 2, dependencies: ['收集资料'], isExecutable: true, aiHint: '', children: [] },
        ],
      },
    ],
  }
}

test('importTreeToDb：递归创建大目标与全部层级子任务，并回填同层依赖', async () => {
  const api = createFakeApi()
  const r = await tree.importTreeToDb('完成季度汇报', draftTree(), api)
  assert.equal(r.imported, 7, '大目标 + 6 个各级子任务')
  assert.equal(r.skipped, 0)

  const goal = api.__byId(r.goalId)
  assert.equal(goal.title, '完成季度汇报')
  assert.equal(goal.estimatedHours, 6)

  const 整理表格 = api.__byTitle('整理表格')[0]
  const 收集资料 = api.__children(api.__byTitle('准备数据')[0]._id).find((t) => t.title === '收集资料')
  assert.deepEqual(整理表格.dependencies, [收集资料._id], '同层依赖应回填为 _id')

  const 撰写PPT = api.__byTitle('撰写PPT')[0]
  const 准备数据 = api.__byTitle('准备数据')[0]
  assert.deepEqual(撰写PPT.dependencies, [准备数据._id])
})

test('importTreeToDb：不同父节点下的同名子任务各自创建', async () => {
  const api = createFakeApi()
  await tree.importTreeToDb('完成季度汇报', draftTree(), api)
  const 同名 = api.__byTitle('收集资料')
  assert.equal(同名.length, 2, '「收集资料」在不同父节点下应各建一个，不能全局去重')
  assert.notEqual(同名[0].parentGoalId, 同名[1].parentGoalId)
})

test('importTreeToDb：重复导入同一目标不产生重复节点', async () => {
  const api = createFakeApi()
  // 单目标采纳路径：每次调用不传 ctx（内部自行读取 DB 建立去重映射）
  const first = await tree.importTreeToDb('完成季度汇报', draftTree(), api)
  const second = await tree.importTreeToDb('完成季度汇报', draftTree(), api)
  assert.equal(second.imported, 0, '第二次导入应全部命中已有节点')
  assert.equal(second.goalId, first.goalId, '应复用已有大目标')
  assert.equal(api.__tasks.length, 7, '不应产生任何重复文档')
})

test('importTreeToDb：已存在的子任务同名同父不重复创建', async () => {
  const api = createFakeApi([
    { _id: 'g1', title: '完成季度汇报', estimatedHours: 6 },
    { _id: 'c1', title: '准备数据', parentGoalId: 'g1', estimatedHours: 2 },
  ])
  const r = await tree.importTreeToDb('完成季度汇报', draftTree(), api)
  assert.equal(r.goalId, 'g1')
  assert.equal(api.__byTitle('准备数据').length, 1, '同父同名应复用而非新建')
})

test('importTreeToDb：一批同名大目标各自成目标（不被并进第一个）', async () => {
  const api = createFakeApi()
  let ctx = null
  const a = await tree.importTreeToDb('整理数据', draftTree(), api, ctx)
  ctx = a.ctx
  const b = await tree.importTreeToDb('整理数据', draftTree(), api, ctx)
  assert.notEqual(a.goalId, b.goalId, '同一批识别出的同名目标必须各自成目标')
  assert.equal(api.__byTitle('整理数据').length, 2)
})

test('importTreeToDb：读取已有任务失败不阻断导入（退化为不做去重）', async () => {
  const api = createFakeApi()
  api.loadTasks = async () => {
    throw new Error('网络错误')
  }
  const r = await tree.importTreeToDb('完成季度汇报', draftTree(), api)
  assert.ok(r.goalId, '目标仍应被创建')
  assert.equal(r.imported, 7)
})

test('importTreeToDb：aiHint 随节点写入（供瓶颈识别）', async () => {
  const d = draftTree()
  d.children[0].aiHint = '数据口径未定'
  const api = createFakeApi()
  await tree.importTreeToDb('完成季度汇报', d, api)
  assert.equal(api.__byTitle('准备数据')[0].aiHint, '数据口径未定')
})

/* ==================== 递归删除 ==================== */

test('removeSubtreeById：递归删除整棵子树', async () => {
  const api = createFakeApi([
    { _id: 'g1', title: '目标' },
    { _id: 'a', title: 'A', parentGoalId: 'g1' },
    { _id: 'a1', title: 'A1', parentGoalId: 'a' },
    { _id: 'b', title: 'B', parentGoalId: 'g1' },
    { _id: 'other', title: '其他目标' },
  ])
  const victims = await tree.removeSubtreeById('a', api)
  assert.deepEqual(victims.sort(), ['a', 'a1'])
  assert.deepEqual(
    api.__tasks.map((t) => t._id).sort(),
    ['b', 'g1', 'other']
  )
})

/* ==================== 调优差异同步 ==================== */

test('syncTreeToDb：新增草稿节点 / 更新未完成耗时 / 删除草稿缺失的未完成节点', async () => {
  const api = createFakeApi([
    { _id: 'g1', title: '目标', estimatedHours: 3, status: 'in_progress' },
    { _id: 'a', title: 'A', parentGoalId: 'g1', level: 1, estimatedHours: 1, status: 'pending' },
    { _id: 'b', title: 'B', parentGoalId: 'g1', level: 1, estimatedHours: 2, status: 'pending' },
  ])
  const goal = api.__byId('g1')
  const draft = {
    title: '目标',
    estimatedHours: 5,
    dependencies: [],
    children: [
      { title: 'A', estimatedHours: 3, dependencies: [], children: [] },
      { title: 'C', estimatedHours: 2, dependencies: [], children: [] },
    ],
  }
  const r = await tree.syncTreeToDb(goal, draft, api)
  assert.equal(r.added, 1, 'C 是新增')
  assert.equal(r.updated, 1, 'A 耗时 1 → 3')
  assert.equal(r.removed, 1, 'B 在草稿中缺失且未完成 → 删除')
  assert.equal(api.__byId('a').estimatedHours, 3)
  assert.equal(api.__byId('b'), undefined)
  assert.ok(api.__byTitle('C').length === 1)
  assert.equal(api.__byId('g1').estimatedHours, 5, '根耗时同步为草稿树合计')
})

test('syncTreeToDb：已完成的节点不被更新、不被删除', async () => {
  const api = createFakeApi([
    { _id: 'g1', title: '目标', estimatedHours: 5, status: 'in_progress' },
    { _id: 'a', title: 'A', parentGoalId: 'g1', level: 1, estimatedHours: 1, status: 'completed' },
    { _id: 'b', title: 'B', parentGoalId: 'g1', level: 1, estimatedHours: 2, status: 'completed' },
  ])
  const goal = api.__byId('g1')
  const draft = {
    title: '目标',
    estimatedHours: 9,
    dependencies: [],
    children: [{ title: 'A', estimatedHours: 7, dependencies: [], children: [] }],
  }
  const r = await tree.syncTreeToDb(goal, draft, api)
  assert.equal(r.updated, 0, '已完成节点耗时不应被覆盖')
  assert.equal(r.removed, 0, '已完成节点不应被删除')
  assert.equal(api.__byId('a').estimatedHours, 1)
  assert.ok(api.__byId('b'), 'B 虽不在草稿中，但已完成，必须保留')
})

/* ==================== 规则调优（降级） ==================== */

test('ruleRefineTree：删除命中的节点及其子树', () => {
  const t = draftTree()
  const r = tree.ruleRefineTree(t, '删除准备数据')
  assert.equal(r.source, 'rule')
  assert.equal(
    r.goal.children.some((c) => c.title === '准备数据'),
    false
  )
  assert.ok(r.adjustmentSummary.indexOf('准备数据') > -1)
})

test('ruleRefineTree：增加新任务并向上重算父耗时', () => {
  const t = draftTree()
  const before = t.estimatedHours
  const r = tree.ruleRefineTree(t, '增加一个内部预演')
  assert.equal(r.source, 'rule')
  const added = r.goal.children.find((c) => c.title === '内部预演')
  assert.ok(added, '新任务应追加到第一层')
  assert.equal(r.goal.estimatedHours, Math.round((before + 1) * 10) / 10, '父耗时应重算')
})

test('ruleRefineTree：修改叶子任务耗时并向上冒烟', () => {
  const t = draftTree()
  const r = tree.ruleRefineTree(t, '把排版美化改成6小时')
  assert.equal(r.source, 'rule')
  const 撰写PPT = r.goal.children.find((c) => c.title === '撰写PPT')
  const hit = 撰写PPT.children.find((c) => c.title === '排版美化')
  assert.equal(hit.estimatedHours, 6)
  assert.equal(撰写PPT.estimatedHours, 8, '父耗时应随子任务重算（收集资料 2 + 排版美化 6）')
  assert.ok(r.goal.estimatedHours > 6, '根耗时应随之向上冒烟')
})

test('ruleRefineTree：无法理解反馈时返回 rule-none 且原树不变', () => {
  const t = draftTree()
  const r = tree.ruleRefineTree(t, '帮我做得更好一点')
  assert.equal(r.source, 'rule-none')
  assert.deepEqual(r.goal, t)
  assert.equal(r.adjustmentSummary, '')
})

test('ruleRefineTree：删光全部子任务时保留原树并给出提示', () => {
  const t = {
    title: '目标',
    estimatedHours: 2,
    children: [{ title: '唯一子任务', estimatedHours: 2, dependencies: [], children: [] }],
  }
  const r = tree.ruleRefineTree(t, '删除唯一子任务')
  assert.equal(r.source, 'rule-none')
  assert.deepEqual(r.goal, t, '至少保留一个子任务')
  assert.ok(r.adjustmentSummary.indexOf('至少') > -1)
})

test('ruleRefineTree：不修改传入的任务树（深拷贝）', () => {
  const t = draftTree()
  const snapshot = JSON.parse(JSON.stringify(t))
  tree.ruleRefineTree(t, '删除准备数据，增加预演')
  assert.deepEqual(t, snapshot)
})

test('resumHours：递归重算父节点耗时', () => {
  const node = {
    title: '根',
    estimatedHours: 0,
    children: [
      { title: 'A', estimatedHours: 1.5, children: [] },
      { title: 'B', estimatedHours: 0, children: [{ title: 'B1', estimatedHours: 2, children: [] }] },
    ],
  }
  const total = tree.resumHours(node)
  assert.equal(node.children[1].estimatedHours, 2)
  assert.equal(total, 3.5)
})
