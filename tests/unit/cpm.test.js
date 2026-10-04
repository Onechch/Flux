/**
 * tests/unit/cpm.test.js —— 关键路径法（utils/cpm.js）
 *
 * 覆盖：归一化与脏数据兜底、拓扑排序最早开始时间、总工期、
 * 关键路径回溯（菱形/多分支取最长）、成环保护、标记与展示文本。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const cpm = require(path.join(__dirname, '..', '..', 'miniprogram', 'utils', 'cpm'))

test('空输入 / 非数组输入返回空结构', () => {
  assert.deepEqual(cpm.calculateCriticalPath([]), {
    tasks: [],
    criticalPath: [],
    totalDuration: 0,
  })
  assert.deepEqual(cpm.calculateCriticalPath(null), {
    tasks: [],
    criticalPath: [],
    totalDuration: 0,
  })
  assert.deepEqual(cpm.calculateCriticalPath('not-an-array').tasks, [])
})

test('串行链：关键路径 = 全链，总工期 = 各环节之和', () => {
  const r = cpm.calculateCriticalPath([
    { name: 'A', estimatedHours: 1, dependencies: [] },
    { name: 'B', estimatedHours: 2, dependencies: ['A'] },
    { name: 'C', estimatedHours: 3, dependencies: ['B'] },
  ])
  assert.deepEqual(r.criticalPath, ['A', 'B', 'C'])
  assert.equal(r.totalDuration, 6)
  assert.deepEqual(
    r.tasks.map((t) => t.isCritical),
    [true, true, true]
  )
})

test('并行分支：关键路径取最长分支，短分支不计入', () => {
  //   A(1) → B(2) → D(1)
  //        ↘ C(9) ↗
  const r = cpm.calculateCriticalPath([
    { name: 'A', estimatedHours: 1, dependencies: [] },
    { name: 'B', estimatedHours: 2, dependencies: ['A'] },
    { name: 'C', estimatedHours: 9, dependencies: ['A'] },
    { name: 'D', estimatedHours: 1, dependencies: ['B', 'C'] },
  ])
  assert.deepEqual(r.criticalPath, ['A', 'C', 'D'])
  assert.equal(r.totalDuration, 11)
  const b = r.tasks.find((t) => t.name === 'B')
  assert.equal(b.isCritical, false, '短分支不应被标记为关键')
})

test('菱形依赖：回溯选择完成时间最晚的前置', () => {
  // A(1) → B(5) → D(2)，同时 A → D 直接依赖
  const r = cpm.calculateCriticalPath([
    { name: 'A', estimatedHours: 1, dependencies: [] },
    { name: 'B', estimatedHours: 5, dependencies: ['A'] },
    { name: 'D', estimatedHours: 2, dependencies: ['A', 'B'] },
  ])
  assert.deepEqual(r.criticalPath, ['A', 'B', 'D'])
  assert.equal(r.totalDuration, 8)
})

test('多个终点任务：总工期取最大值所在链', () => {
  const r = cpm.calculateCriticalPath([
    { name: '短链', estimatedHours: 2, dependencies: [] },
    { name: '长链', estimatedHours: 7, dependencies: [] },
    { name: '另一条', estimatedHours: 5, dependencies: [] },
  ])
  assert.deepEqual(r.criticalPath, ['长链'])
  assert.equal(r.totalDuration, 7)
})

test('依赖指向不存在的任务 → 该依赖被剔除', () => {
  const r = cpm.calculateCriticalPath([
    { name: 'A', estimatedHours: 2, dependencies: ['幽灵任务'] },
  ])
  assert.deepEqual(r.tasks[0].dependencies, [])
  assert.equal(r.tasks[0].depText, '无')
  assert.equal(r.totalDuration, 2)
})

test('自依赖被剔除（避免自我阻塞）', () => {
  const r = cpm.calculateCriticalPath([
    { name: 'A', estimatedHours: 2, dependencies: ['A'] },
  ])
  assert.deepEqual(r.tasks[0].dependencies, [])
})

test('重复任务名去重，首个定义生效', () => {
  const r = cpm.calculateCriticalPath([
    { name: 'A', estimatedHours: 1, dependencies: [] },
    { name: 'A', estimatedHours: 99, dependencies: [] },
  ])
  assert.equal(r.tasks.length, 1)
  assert.equal(r.tasks[0].estimatedHours, 1)
})

test('重复依赖去重', () => {
  const r = cpm.calculateCriticalPath([
    { name: 'A', estimatedHours: 1, dependencies: [] },
    { name: 'B', estimatedHours: 1, dependencies: ['A', 'A', ' A '] },
  ])
  assert.deepEqual(r.tasks.find((t) => t.name === 'B').dependencies, ['A'])
})

test('非法耗时兜底为 1 小时（0 / 负数 / NaN / 字符串 / 缺失）', () => {
  const r = cpm.calculateCriticalPath([
    { name: '零', estimatedHours: 0, dependencies: [] },
    { name: '负', estimatedHours: -5, dependencies: [] },
    { name: 'NaN', estimatedHours: NaN, dependencies: [] },
    { name: '字符串', estimatedHours: 'abc', dependencies: [] },
    { name: '缺失', dependencies: [] },
    { name: '字符串数字', estimatedHours: '3', dependencies: [] },
  ])
  const hours = {}
  r.tasks.forEach((t) => {
    hours[t.name] = t.estimatedHours
  })
  assert.equal(hours['零'], 1)
  assert.equal(hours['负'], 1)
  assert.equal(hours['NaN'], 1)
  assert.equal(hours['字符串'], 1)
  assert.equal(hours['缺失'], 1)
  assert.equal(hours['字符串数字'], 3, '可转数字的字符串应被接受')
})

test('空名 / 非字符串名任务被丢弃', () => {
  const r = cpm.calculateCriticalPath([
    { name: '', estimatedHours: 1 },
    { name: '   ', estimatedHours: 1 },
    { estimatedHours: 1 },
    null,
    { name: '有效', estimatedHours: 1 },
  ])
  assert.deepEqual(
    r.tasks.map((t) => t.name),
    ['有效']
  )
})

test('成环依赖不阻塞渲染：所有任务都被保留且总工期有限', () => {
  const r = cpm.calculateCriticalPath([
    { name: 'A', estimatedHours: 1, dependencies: ['C'] },
    { name: 'B', estimatedHours: 1, dependencies: ['A'] },
    { name: 'C', estimatedHours: 1, dependencies: ['B'] },
  ])
  assert.equal(r.tasks.length, 3)
  assert.ok(Number.isFinite(r.totalDuration))
  assert.ok(r.totalDuration > 0)
  // 成环节点最早开始兜底为 0 → 每个任务各自 1 小时
  assert.equal(r.totalDuration, 1)
  assert.ok(Array.isArray(r.criticalPath))
  assert.ok(r.criticalPath.length >= 1)
})

test('depText：有依赖时用顿号连接，无依赖显示「无」', () => {
  const r = cpm.calculateCriticalPath([
    { name: 'A', estimatedHours: 1, dependencies: [] },
    { name: 'B', estimatedHours: 1, dependencies: [] },
    { name: 'C', estimatedHours: 1, dependencies: ['A', 'B'] },
  ])
  assert.equal(r.tasks.find((t) => t.name === 'C').depText, 'A、B')
  assert.equal(r.tasks.find((t) => t.name === 'A').depText, '无')
})

test('总工期保留 1 位小数（浮点耗时求和）', () => {
  const r = cpm.calculateCriticalPath([
    { name: 'A', estimatedHours: 0.1, dependencies: [] },
    { name: 'B', estimatedHours: 0.2, dependencies: ['A'] },
  ])
  assert.equal(r.totalDuration, 0.3)
})

test('单项任务：自身即关键路径', () => {
  const r = cpm.calculateCriticalPath([{ name: '唯一', estimatedHours: 4 }])
  assert.deepEqual(r.criticalPath, ['唯一'])
  assert.equal(r.totalDuration, 4)
  assert.equal(r.tasks[0].isCritical, true)
})

test('输入对象不被就地修改（纯函数）', () => {
  const input = [
    { name: 'A', estimatedHours: 1, dependencies: ['不存在'] },
  ]
  cpm.calculateCriticalPath(input)
  assert.deepEqual(input[0].dependencies, ['不存在'], '原始依赖数组不应被过滤掉')
})
