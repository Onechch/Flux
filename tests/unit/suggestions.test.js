/**
 * tests/unit/suggestions.test.js —— 瓶颈智能建议规则引擎（utils/suggestions.js）
 *
 * 覆盖：规则优先级（锁定 > 严重超时 > 前置阻塞 > 下游堆积 > 就绪待启动 > 整体偏慢）、
 * 每卡点条数上限、已完成卡点不产建议、补充情况标签规则、忽略/反馈存储。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { createStorage, createWxMock } = require('../helpers/runtime')

const suggestions = require(path.join(__dirname, '..', '..', 'miniprogram', 'utils', 'suggestions'))

/** 每个用例独立的 wx（storage 隔离） */
function useWx() {
  const storage = createStorage()
  global.wx = createWxMock({ storage })
  return storage
}

function clogOf(over) {
  return Object.assign(
    {
      _id: 'c1',
      title: '卡点任务',
      status: 'in_progress',
      estimatedHours: 4,
      actualHours: 0,
      dependencies: [],
    },
    over || {}
  )
}

test('无卡点或卡点已完成时不产生建议', () => {
  useWx()
  assert.deepEqual(suggestions.generateSuggestions({ clog: null }), [])
  assert.deepEqual(suggestions.generateSuggestions({}), [])
  assert.deepEqual(
    suggestions.generateSuggestions({ clog: clogOf({ status: 'completed' }) }),
    []
  )
})

test('规则0：所属目标被锁定时，只给出「先攻瓶颈目标」', () => {
  useWx()
  const out = suggestions.generateSuggestions({
    clog: clogOf({ actualHours: 99 }), // 即便严重超时，锁定优先级更高
    goal: { _id: 'g1', status: 'locked' },
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'focus')
  assert.ok(out[0].reason.indexOf('40%') > -1)
})

test('规则1：实际耗时超预估 1.5 倍 → 集中攻坚；预估≥2h 时附带拆解建议', () => {
  useWx()
  const out = suggestions.generateSuggestions({
    clog: clogOf({ estimatedHours: 4, actualHours: 7 }),
    goal: { _id: 'g1', status: 'in_progress' },
  })
  assert.equal(out.length, 2)
  assert.equal(out[0].type, 'focus')
  assert.equal(out[1].type, 'breakdown')

  const small = suggestions.generateSuggestions({
    clog: clogOf({ estimatedHours: 1, actualHours: 5 }),
    goal: { _id: 'g1', status: 'in_progress' },
  })
  assert.equal(small.length, 1, '小任务超时不建议拆解')
  assert.equal(small[0].type, 'focus')
})

test('规则1 边界：刚好等于 1.5 倍不触发（严格大于）', () => {
  useWx()
  const out = suggestions.generateSuggestions({
    clog: clogOf({ estimatedHours: 2, actualHours: 3 }),
    goal: { _id: 'g1', status: 'in_progress' },
  })
  assert.equal(out[0].type, 'speedup', '等于阈值不算超时，应落到兜底规则')
  assert.equal(out.length, 1)
})

test('规则2：存在未完成前置 → 建议切去干前置', () => {
  useWx()
  const out = suggestions.generateSuggestions({
    clog: clogOf({ dependencies: ['p1'] }),
    goal: { _id: 'g1', status: 'in_progress' },
    tasks: [{ _id: 'p1', title: '前置任务名很长需要截断', status: 'pending' }],
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'switch')
  assert.ok(out[0].action.indexOf('前置') > -1)
})

test('规则2：前置已完成时不再拦截（继续往下走规则）', () => {
  useWx()
  const out = suggestions.generateSuggestions({
    clog: clogOf({ dependencies: ['p1'], status: 'pending' }),
    goal: { _id: 'g1', status: 'in_progress' },
    tasks: [{ _id: 'p1', title: '前置', status: 'completed' }],
  })
  assert.equal(out[0].type, 'start')
})

test('规则3：压着 3 个及以上未完成下游 → 优先处理', () => {
  useWx()
  const siblings = [
    { _id: 'c1', title: '卡点任务', status: 'in_progress', dependencies: [] },
    { _id: 'd1', title: '下游1', status: 'pending', dependencies: ['c1'] },
    { _id: 'd2', title: '下游2', status: 'pending', dependencies: ['c1'] },
    { _id: 'd3', title: '下游3', status: 'pending', dependencies: ['c1'] },
  ]
  const out = suggestions.generateSuggestions({
    clog: siblings[0],
    goal: { _id: 'g1', status: 'in_progress' },
    siblings: siblings,
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'expedite')
  assert.ok(out[0].reason.indexOf('3') > -1)
})

test('规则3：下游恰好 2 个时不触发（严格 >=3）', () => {
  useWx()
  const siblings = [
    { _id: 'c1', title: '卡点任务', status: 'pending', dependencies: [] },
    { _id: 'd1', title: '下游1', status: 'pending', dependencies: ['c1'] },
    { _id: 'd2', title: '下游2', status: 'pending', dependencies: ['c1'] },
  ]
  const out = suggestions.generateSuggestions({
    clog: siblings[0],
    goal: { _id: 'g1', status: 'in_progress' },
    siblings: siblings,
  })
  assert.equal(out[0].type, 'start', '未达到阈值时应落到「立即开始」')
})

test('规则3：已完成的下游不计数', () => {
  useWx()
  const siblings = [
    { _id: 'c1', title: '卡点任务', status: 'pending', dependencies: [] },
    { _id: 'd1', title: '下游1', status: 'completed', dependencies: ['c1'] },
    { _id: 'd2', title: '下游2', status: 'completed', dependencies: ['c1'] },
    { _id: 'd3', title: '下游3', status: 'completed', dependencies: ['c1'] },
  ]
  const out = suggestions.generateSuggestions({
    clog: siblings[0],
    goal: { _id: 'g1', status: 'in_progress' },
    siblings: siblings,
  })
  assert.equal(out[0].type, 'start')
})

test('规则4：前置就绪且未开始 → 立即开始', () => {
  useWx()
  const out = suggestions.generateSuggestions({
    clog: clogOf({ status: 'pending' }),
    goal: { _id: 'g1', status: 'in_progress' },
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'start')
})

test('规则5：兜底给出「固定节奏推进」', () => {
  useWx()
  const out = suggestions.generateSuggestions({
    clog: clogOf({ status: 'in_progress', estimatedHours: 3, actualHours: 1 }),
    goal: { _id: 'g1', status: 'in_progress' },
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'speedup')
})

test('建议 key 为「任务ID:类型」且不超过 2 条', () => {
  useWx()
  const out = suggestions.generateSuggestions({
    clog: clogOf({ _id: 'abc', estimatedHours: 5, actualHours: 20 }),
    goal: { _id: 'g1', status: 'in_progress' },
  })
  assert.ok(out.length <= 2)
  out.forEach((s) => {
    assert.equal(s.key, 'abc:' + s.type)
    assert.ok(s.action && s.reason && s.effect, '每条建议都应含 action/reason/effect')
  })
})

test('建议类型都在白名单内（采纳动作映射依赖它）', () => {
  useWx()
  const scenarios = [
    { clog: clogOf({ actualHours: 99, estimatedHours: 9 }), goal: { status: 'in_progress' } },
    { clog: clogOf({ status: 'pending' }), goal: { status: 'in_progress' } },
    { clog: clogOf({ status: 'in_progress' }), goal: { status: 'in_progress' } },
    { clog: clogOf({}), goal: { status: 'locked' } },
    {
      clog: clogOf({ dependencies: ['p'] }),
      goal: { status: 'in_progress' },
      tasks: [{ _id: 'p', title: 'P', status: 'pending' }],
    },
  ]
  scenarios.forEach((ctx) => {
    suggestions.generateSuggestions(ctx).forEach((s) => {
      assert.ok(suggestions.TYPES.indexOf(s.type) > -1, s.type + ' 不在白名单')
    })
  })
})

/* ---------------- 补充情况标签规则 ---------------- */

test('CTX_TAGS：7 个快速标签，且每个都有对应规则', () => {
  assert.equal(suggestions.CTX_TAGS.length, 7)
  suggestions.CTX_TAGS.forEach((t) => {
    assert.ok(suggestions.CTX_TAG_RULES[t], '标签「' + t + '」缺少规则')
    assert.ok(suggestions.TYPES.indexOf(suggestions.CTX_TAG_RULES[t].type) > -1)
  })
})

test('generateCtxSuggestions：按选中标签给出对应策略（最多 2 条，同类型去重）', () => {
  const clog = { _id: 'c1', title: '卡点' }
  const out = suggestions.generateCtxSuggestions(clog, { tags: ['等别人', '缺资源'], version: 1 })
  assert.equal(out.length, 2)
  assert.equal(out[0].type, 'urge')
  assert.equal(out[1].type, 'outsource')
  out.forEach((s) => assert.equal(s.key, 'c1:ctx1:' + s.type))
})

test('generateCtxSuggestions：无标签时兜底「其他」规则', () => {
  const out = suggestions.generateCtxSuggestions({ _id: 'c1' }, { tags: [] })
  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'focus')
})

test('generateCtxSuggestions：未识别的标签被忽略，全部未知时兜底', () => {
  const out = suggestions.generateCtxSuggestions({ _id: 'c1' }, { tags: ['瞎写的标签'] })
  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'focus')
})

test('generateCtxSuggestions：version 递增会改变 key（旧忽略记录不误伤新建议）', () => {
  const clog = { _id: 'c1' }
  const v1 = suggestions.generateCtxSuggestions(clog, { tags: ['不会做'], version: 1 })
  const v2 = suggestions.generateCtxSuggestions(clog, { tags: ['不会做'], version: 2 })
  assert.notEqual(v1[0].key, v2[0].key)
})

test('generateCtxSuggestions：无卡点返回空数组', () => {
  assert.deepEqual(suggestions.generateCtxSuggestions(null, { tags: ['等别人'] }), [])
})

/* ---------------- 存储层 ---------------- */

test('filterVisible：过滤已忽略建议并最多展示 2 条', () => {
  useWx()
  const list = [
    { key: 'k1' },
    { key: 'k2' },
    { key: 'k3' },
  ]
  assert.equal(suggestions.filterVisible(list).length, 2)
  suggestions.ignoreKey('k1')
  const out = suggestions.filterVisible(list)
  assert.deepEqual(
    out.map((s) => s.key),
    ['k2', 'k3']
  )
})

test('filterVisible：非数组输入返回空数组', () => {
  useWx()
  assert.deepEqual(suggestions.filterVisible(null), [])
})

test('ignoreKey：重复忽略同一 key 不产生重复记录', () => {
  const storage = useWx()
  suggestions.ignoreKey('dup')
  suggestions.ignoreKey('dup')
  assert.deepEqual(storage.peek('po_sug_ignored'), ['dup'])
})

test('recordAdopted / recordFeedback：追加日志并带时间戳', () => {
  const storage = useWx()
  suggestions.recordAdopted({ key: 'k1', type: 'start' })
  const adopted = storage.peek('po_sug_adopted')
  assert.equal(adopted.length, 1)
  assert.ok(adopted[0].ts > 0)

  suggestions.recordFeedback({ key: 'k1' }, true)
  suggestions.recordFeedback({ key: 'k2' })
  const fb = storage.peek('po_sug_feedback')
  assert.equal(fb.length, 2)
  assert.equal(fb[0].helpful, true)
  assert.equal(fb[1].helpful, false, '未显式传有用时应记为没帮助')
})
