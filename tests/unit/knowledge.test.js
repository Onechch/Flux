/**
 * tests/unit/knowledge.test.js —— 知识库检索与预筛（utils/knowledge.js）
 *
 * 覆盖：子串双向匹配打分（标签 3 / 标题 2 / 内容 1）、类型权重、
 * usageCount 微弱加成、只检索 active、单字噪声过滤、limit 截断、
 * 提取预筛（worthExtracting）与类型中文标签。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const knowledge = require(path.join(__dirname, '..', '..', 'miniprogram', 'utils', 'knowledge'))

function k(over) {
  return Object.assign(
    {
      _id: 'k1',
      title: '标题',
      content: '内容',
      type: 'theory',
      tags: [],
      status: 'active',
      usageCount: 0,
    },
    over || {}
  )
}

test('searchKnowledge：空关键词或非数组知识返回空', () => {
  assert.deepEqual(knowledge.searchKnowledge([k({})], [], 3), [])
  assert.deepEqual(knowledge.searchKnowledge([k({})], ['', '  '], 3), [])
  assert.deepEqual(knowledge.searchKnowledge(null, ['关键词'], 3), [])
})

test('searchKnowledge：单字关键词被过滤（噪声太大）', () => {
  const list = [k({ title: '瓶颈', content: '瓶颈就是约束' })]
  assert.deepEqual(knowledge.searchKnowledge(list, ['瓶'], 3), [])
  assert.equal(knowledge.searchKnowledge(list, ['瓶颈'], 3).length, 1)
})

test('searchKnowledge：标签命中权重最高（+3）', () => {
  const list = [
    k({ _id: 'tagHit', title: '无关标题', content: '无关内容', tags: ['瓶颈'] }),
    k({ _id: 'titleHit', title: '瓶颈管理', content: '无关内容', tags: [] }),
    k({ _id: 'contentHit', title: '无关标题', content: '瓶颈就是约束', tags: [] }),
  ]
  const out = knowledge.searchKnowledge(list, ['瓶颈'], 3)
  assert.deepEqual(
    out.map((x) => x._id),
    ['tagHit', 'titleHit', 'contentHit']
  )
})

test('searchKnowledge：命中越多分越高（标签+标题+内容可叠加）', () => {
  const list = [
    k({ _id: 'all', title: '瓶颈', content: '瓶颈', tags: ['瓶颈'] }),
    k({ _id: 'one', title: '瓶颈', content: '无关', tags: [] }),
  ]
  const out = knowledge.searchKnowledge(list, ['瓶颈'], 3)
  assert.equal(out[0]._id, 'all')
})

test('searchKnowledge：标题双向包含都算命中', () => {
  const list = [k({ title: 'WIP限制（在制品限制）', content: 'x' })]
  assert.equal(knowledge.searchKnowledge(list, ['WIP'], 3).length, 1)
  assert.equal(knowledge.searchKnowledge(list, ['WIP限制（在制品限制）'], 3).length, 1)
})

test('searchKnowledge：只检索 status=active 的知识', () => {
  const list = [
    k({ _id: 'active', status: 'active' }),
    k({ _id: 'pending', status: 'pending' }),
    k({ _id: 'ignored', status: 'ignored' }),
  ]
  const out = knowledge.searchKnowledge(list, ['标题'], 3)
  assert.deepEqual(
    out.map((x) => x._id),
    ['active']
  )
})

test('searchKnowledge：个人经验权重高于理论（同分下经验优先）', () => {
  const list = [
    k({ _id: 'theory', type: 'theory', tags: ['瓶颈'] }),
    k({ _id: 'exp', type: 'user_experience', tags: ['瓶颈'] }),
    k({ _id: 'bp', type: 'best_practice', tags: ['瓶颈'] }),
    k({ _id: 'tpl', type: 'task_template', tags: ['瓶颈'] }),
  ]
  const out = knowledge.searchKnowledge(list, ['瓶颈'], 4)
  assert.deepEqual(
    out.map((x) => x._id),
    ['exp', 'bp', 'tpl', 'theory']
  )
})

test('searchKnowledge：usageCount 有微弱加成但不超过权重差', () => {
  const list = [
    k({ _id: 'theoryHot', type: 'theory', tags: ['瓶颈'], usageCount: 100 }),
    k({ _id: 'expCold', type: 'user_experience', tags: ['瓶颈'], usageCount: 0 }),
  ]
  const out = knowledge.searchKnowledge(list, ['瓶颈'], 2)
  assert.equal(out[0]._id, 'expCold', '引用次数加成（上限 +1）不应盖过类型权重')
})

test('searchKnowledge：limit 生效，默认 3 条', () => {
  const list = []
  for (let i = 0; i < 6; i++) list.push(k({ _id: 'k' + i, tags: ['瓶颈'] }))
  assert.equal(knowledge.searchKnowledge(list, ['瓶颈']).length, 3)
  assert.equal(knowledge.searchKnowledge(list, ['瓶颈'], 5).length, 5)
})

test('searchKnowledge：未命中任何关键词的知识不返回', () => {
  const list = [k({ title: '完全无关', content: '完全无关', tags: ['无关'] })]
  assert.deepEqual(knowledge.searchKnowledge(list, ['瓶颈'], 3), [])
})

test('searchKnowledge：多个关键词命中数累加', () => {
  const list = [
    k({ _id: 'both', title: '瓶颈', content: '瓶颈' }),
    k({ _id: 'only', title: '瓶颈', content: '无关' }),
  ]
  const out = knowledge.searchKnowledge(list, ['瓶颈', '无关'], 2)
  assert.equal(out[0]._id, 'both', '同时命中两个关键词的应排前')
})

test('searchKnowledge：不修改传入的知识对象（无 _score 残留）', () => {
  const item = k({ tags: ['瓶颈'] })
  knowledge.searchKnowledge([item], ['瓶颈'], 3)
  assert.equal(item._score, undefined)
  assert.deepEqual(Object.keys(item).indexOf('score'), -1)
})

/* ---------------- 提取预筛 ---------------- */

test('worthExtracting：过短文本不触发提取', () => {
  assert.equal(knowledge.worthExtracting('删除XX'), false)
  assert.equal(knowledge.worthExtracting(''), false)
  assert.equal(knowledge.worthExtracting(null), false)
})

test('worthExtracting：无提示词的纯操作指令不触发提取', () => {
  assert.equal(knowledge.worthExtracting('把收集数据这个任务删掉吧'), false)
})

test('worthExtracting：含习惯/经验/资源类提示词且长度达标时触发', () => {
  assert.equal(knowledge.worthExtracting('我一般上午效率比较高，重要的事放上午做'), true)
  assert.equal(knowledge.worthExtracting('上次因为没有提前准备数据导致返工了'), true)
  assert.equal(knowledge.worthExtracting('我没有设计师配合，只能自己做'), true)
})

/* ---------------- 其他 ---------------- */

test('typeLabel：类型映射为中文，未知类型兜底「其他」', () => {
  assert.equal(knowledge.typeLabel('theory'), '理论')
  assert.equal(knowledge.typeLabel('user_experience'), '经验')
  assert.equal(knowledge.typeLabel('best_practice'), '经验')
  assert.equal(knowledge.typeLabel('task_template'), '模板')
  assert.equal(knowledge.typeLabel('unknown'), '其他')
})

test('PRESET_THEORY：预置理论完整且字段合法（与写库校验规则一致）', () => {
  assert.ok(knowledge.PRESET_THEORY.length >= 6)
  const titles = {}
  knowledge.PRESET_THEORY.forEach((p) => {
    assert.equal(p.type, 'theory')
    assert.ok(p.title && p.title.length <= 50, p.title + ' 标题超长')
    assert.ok(p.content && p.content.length <= 500, p.title + ' 内容超长')
    assert.ok(Array.isArray(p.tags) && p.tags.length <= 5, p.title + ' 标签应不超过 5 个')
    assert.ok(
      p.tags.every((t) => t.length <= 10),
      p.title + ' 单个标签应不超过 10 字（与 validation 的 itemMax 一致）'
    )
    assert.equal(titles[p.title], undefined, '预置理论标题不应重复：' + p.title)
    titles[p.title] = true
  })
})

test('TYPE_WEIGHTS：个人经验 > 模板 > 理论', () => {
  assert.ok(knowledge.TYPE_WEIGHTS.user_experience > knowledge.TYPE_WEIGHTS.task_template)
  assert.ok(knowledge.TYPE_WEIGHTS.task_template > knowledge.TYPE_WEIGHTS.theory)
  assert.equal(knowledge.TYPE_WEIGHTS.best_practice, knowledge.TYPE_WEIGHTS.user_experience)
})
