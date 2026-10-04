/**
 * tests/unit/validation.test.js —— 写库前 Schema 校验（utils/validation.js）
 *
 * 覆盖：必填/类型/枚举/范围/超长截断、partial 模式、错误汇总、
 * 复合字段（userContext / suggestionHistory）的规范化、文档 ID 校验。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const v = require(path.join(__dirname, '..', '..', 'miniprogram', 'utils', 'validation'))

/* ---------------- 任务输入 ---------------- */

test('title 必填：缺失或空串都抛 ValidationError', () => {
  assert.throws(() => v.validateTaskInput({ estimatedHours: 1 }), (e) => {
    assert.equal(e.name, 'ValidationError')
    assert.equal(e.type, 'validation')
    assert.ok(e.message.indexOf('任务名称') > -1)
    assert.deepEqual(e.fields, ['title'])
    return true
  })
  assert.throws(() => v.validateTaskInput({ title: '   ' }), v.ValidationError)
})

test('title 类型错误被拒绝，超长被静默截断到 100 字', () => {
  assert.throws(() => v.validateTaskInput({ title: 123 }), v.ValidationError)
  const long = '标'.repeat(150)
  const out = v.validateTaskInput({ title: long })
  assert.equal(out.title.length, 100)
})

test('title 首尾空白被去除', () => {
  const out = v.validateTaskInput({ title: '  写周报  ' })
  assert.equal(out.title, '写周报')
})

test('estimatedHours 类型与范围校验（0 合法、负数与超上限非法）', () => {
  assert.equal(v.validateTaskInput({ title: 'A', estimatedHours: 0 }).estimatedHours, 0)
  assert.throws(() => v.validateTaskInput({ title: 'A', estimatedHours: -1 }), v.ValidationError)
  assert.throws(() => v.validateTaskInput({ title: 'A', estimatedHours: 99999 }), v.ValidationError)
  assert.throws(() => v.validateTaskInput({ title: 'A', estimatedHours: '2' }), v.ValidationError)
  assert.throws(() => v.validateTaskInput({ title: 'A', estimatedHours: NaN }), v.ValidationError)
})

test('status 只接受四种枚举值', () => {
  ;['pending', 'locked', 'in_progress', 'completed'].forEach((s) => {
    assert.equal(v.validateTaskInput({ title: 'A', status: s }).status, s)
  })
  assert.throws(() => v.validateTaskInput({ title: 'A', status: 'done' }), v.ValidationError)
})

test('level 必须是 0-5 的整数', () => {
  assert.equal(v.validateTaskInput({ title: 'A', level: 0 }).level, 0)
  assert.equal(v.validateTaskInput({ title: 'A', level: 5 }).level, 5)
  assert.throws(() => v.validateTaskInput({ title: 'A', level: 6 }), v.ValidationError)
  assert.throws(() => v.validateTaskInput({ title: 'A', level: 1.5 }), v.ValidationError)
})

test('dependencies 必须是数组，且受条数与单条长度限制', () => {
  const ok = v.validateTaskInput({ title: 'A', dependencies: ['id1', 'id2'] })
  assert.deepEqual(ok.dependencies, ['id1', 'id2'])
  assert.throws(
    () =>
      v.validateTaskInput({
        title: 'A',
        dependencies: new Array(21).fill('x'),
      }),
    v.ValidationError,
    '超过 20 条应被拒绝'
  )
  assert.throws(() => v.validateTaskInput({ title: 'A', dependencies: 'id1' }), v.ValidationError)
})

test('dependencies 单条超长被截断到 64 字符', () => {
  const out = v.validateTaskInput({ title: 'A', dependencies: ['y'.repeat(80)] })
  assert.equal(out.dependencies[0].length, 64)
})

test('isBottleneck 必须是布尔值', () => {
  assert.equal(v.validateTaskInput({ title: 'A', isBottleneck: true }).isBottleneck, true)
  assert.throws(() => v.validateTaskInput({ title: 'A', isBottleneck: 1 }), v.ValidationError)
})

test('未知字段不出现在校验结果中（schema 白名单）', () => {
  const out = v.validateTaskInput({ title: 'A', 未知字段: 1, _dirty: true })
  assert.equal(out.未知字段, undefined)
  assert.equal(out._dirty, undefined)
})

test('partial 模式跳过必填检查（patch 局部更新允许字段缺席）', () => {
  const out = v.validateTaskPatch({ estimatedHours: 3 })
  assert.deepEqual(out, { estimatedHours: 3 })
  assert.equal(out.title, undefined)
})

test('partial 模式下已传入字段仍做类型校验', () => {
  assert.throws(() => v.validateTaskPatch({ estimatedHours: '3' }), v.ValidationError)
})

test('错误一次性汇总多个字段（message 拼接 + fields 列表）', () => {
  try {
    v.validateTaskInput({ estimatedHours: -1, status: 'bad' })
    assert.fail('应当抛出')
  } catch (e) {
    assert.equal(e.fields.length, 3) // title 缺失 + estimatedHours + status
    assert.ok(e.message.indexOf('；') > -1, '多条错误应用分号连接')
  }
})

test('非对象输入被拒绝', () => {
  assert.throws(() => v.validateTaskInput(null), v.ValidationError)
  assert.throws(() => v.validateTaskInput([]), v.ValidationError)
  assert.throws(() => v.validateTaskInput('abc'), v.ValidationError)
})

/* ---------------- userContext ---------------- */

test('userContext：tags 截断到 3 个、单标签 10 字，text 截断到 200 字', () => {
  const out = v.validateTaskInput({
    title: 'A',
    userContext: {
      tags: ['标签一', '标签二', '标签三', '标签四'],
      text: '字'.repeat(300),
    },
  })
  assert.equal(out.userContext.tags.length, 3)
  assert.equal(out.userContext.text.length, 200)
})

test('userContext：缺失 version 时兜底为 1，非法 version 也被纠正', () => {
  const a = v.validateTaskInput({ title: 'A', userContext: { tags: [], text: '' } })
  assert.equal(a.userContext.version, 1)
  const b = v.validateTaskInput({ title: 'A', userContext: { version: 0 } })
  assert.equal(b.userContext.version, 1)
  const c = v.validateTaskInput({ title: 'A', userContext: { version: 2.5 } })
  assert.equal(c.userContext.version, 1)
  const d = v.validateTaskInput({ title: 'A', userContext: { version: 3 } })
  assert.equal(d.userContext.version, 3)
})

test('userContext：数组或字符串等非对象格式被拒绝', () => {
  assert.throws(() => v.validateTaskInput({ title: 'A', userContext: [] }), v.ValidationError)
  assert.throws(() => v.validateTaskInput({ title: 'A', userContext: 'abc' }), v.ValidationError)
})

test('userContext：空标签被过滤', () => {
  const out = v.validateTaskInput({ title: 'A', userContext: { tags: ['缺资源', '  ', ''] } })
  assert.deepEqual(out.userContext.tags, ['缺资源'])
})

/* ---------------- suggestionHistory ---------------- */

test('suggestionHistory：保留最近 5 条，非对象项被过滤', () => {
  const history = []
  for (let i = 1; i <= 7; i++) history.push({ version: i, suggestions: [{ key: 'k' + i }] })
  history.push(null, 'bad', [1, 2])
  const out = v.validateTaskInput({ title: 'A', suggestionHistory: history })
  assert.equal(out.suggestionHistory.length, 5)
  assert.equal(out.suggestionHistory[0].version, 3, '应保留最后 5 条（version 3..7）')
  assert.equal(out.suggestionHistory[4].version, 7)
})

test('suggestionHistory：单条内 suggestions 最多 3 条，字段缺失有默认值', () => {
  const out = v.validateTaskInput({
    title: 'A',
    suggestionHistory: [{ suggestions: [1, 2, 3, 4, 5] }],
  })
  assert.equal(out.suggestionHistory[0].suggestions.length, 3)
  assert.equal(out.suggestionHistory[0].version, 1)
  assert.deepEqual(out.suggestionHistory[0].relatedKnowledge, [])
  assert.equal(out.suggestionHistory[0].basedOn, '')
})

test('suggestionHistory：非数组被拒绝', () => {
  assert.throws(() => v.validateTaskInput({ title: 'A', suggestionHistory: {} }), v.ValidationError)
})

/* ---------------- 知识库 ---------------- */

test('知识条目：title 与 content 均必填', () => {
  assert.throws(() => v.validateKnowledgeInput({ content: '内容' }), v.ValidationError)
  assert.throws(() => v.validateKnowledgeInput({ title: '标题' }), v.ValidationError)
  const ok = v.validateKnowledgeInput({ title: '标题', content: '内容' })
  assert.deepEqual(ok, { title: '标题', content: '内容' })
})

test('知识条目：type/status/source 枚举校验', () => {
  assert.equal(
    v.validateKnowledgeInput({ title: 't', content: 'c', type: 'theory' }).type,
    'theory'
  )
  assert.throws(
    () => v.validateKnowledgeInput({ title: 't', content: 'c', type: 'unknown' }),
    v.ValidationError
  )
  assert.throws(
    () => v.validateKnowledgeInput({ title: 't', content: 'c', status: 'done' }),
    v.ValidationError
  )
  assert.throws(
    () => v.validateKnowledgeInput({ title: 't', content: 'c', source: 'auto' }),
    v.ValidationError
  )
})

test('知识条目：title 50 字上限、content 500 字上限', () => {
  const out = v.validateKnowledgeInput({
    title: '标'.repeat(80),
    content: '内'.repeat(600),
  })
  assert.equal(out.title.length, 50)
  assert.equal(out.content.length, 500)
})

test('知识条目：tags 上限 5 项（与知识库页手动添加的输入上限一致）', () => {
  assert.equal(
    v.validateKnowledgeInput({ title: 't', content: 'c', tags: ['a', 'b', 'c', 'd', 'e'] }).tags.length,
    5
  )
  assert.throws(
    () =>
      v.validateKnowledgeInput({
        title: 't',
        content: 'c',
        tags: ['a', 'b', 'c', 'd', 'e', 'f'],
      }),
    v.ValidationError
  )
})

test('知识条目：rating 必须是 0-5 整数', () => {
  assert.equal(v.validateKnowledgeInput({ title: 't', content: 'c', rating: 5 }).rating, 5)
  assert.throws(
    () => v.validateKnowledgeInput({ title: 't', content: 'c', rating: 6 }),
    v.ValidationError
  )
})

/* ---------------- 文档 ID ---------------- */

test('validateDocId：空值与超长被拒绝，正常 ID 原样返回', () => {
  assert.throws(() => v.validateDocId('', '任务'), v.ValidationError)
  assert.throws(() => v.validateDocId(null), v.ValidationError)
  assert.throws(() => v.validateDocId('x'.repeat(65)), v.ValidationError)
  assert.equal(v.validateDocId('  abc123  ', '任务'), 'abc123')
})
