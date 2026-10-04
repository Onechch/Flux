/**
 * tests/pages/index-scenarios.test.js —— 首页（瓶颈仪表盘）典型使用场景测试
 *
 * 与 index.test.js 的分工：
 * - index.test.js      → 「展开状态跨刷新保留」单点回归
 * - 本文件             → 按真实使用场景铺开，三类划分：
 *      A 正常路径：多目标锁定与切换、任务树完成联动、添加/删除、补充情况、建议采纳
 *      B 边界条件：在办数量阈值、耗时/标题/标签/文本的长度与取值边界、防重提交
 *      C 异常情况：数据层失败、AI 失败、锁定拦截、并发变更（卡点被删）、存储写入失败
 *
 * 驱动方式：真实 utils/api.js（本地降级模式）+ 内存 Storage。
 * 通过 `require(mini('utils/xxx.js'))` 拿到页面内部依赖的**同一模块实例**，
 * 用于注入失败与统计调用次数（比替换 wx 更贴近真实故障点）。
 *
 * 注意：completeTask / autoCompleteGoal 内含 600ms 破裂动画，涉及完成的用例
 * 会真实等待动画时长（保证"动画确实播放过"可被断言）。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createStorage, createWxMock, loadPage, mini } = require('../helpers/runtime')

/* ==================== 夹具 ==================== */

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
 * @param {Object} [t] node:test 上下文（传入则用例结束后卸载页面，停掉专注计时器）
 * @param {Object} [opts] { storage: 额外预置键, modalConfirm, modalResults, cloud }
 * @returns {Object} { page, storage, wx, api, ai, suggestions, treeUtils, knowledge }
 */
async function loadIndexPage(tasks, t, opts) {
  const o = opts || {}
  const storage = createStorage(Object.assign({ po_tasks: tasks || [] }, o.storage || {}))
  const wx = createWxMock({
    storage: storage,
    cloud: o.cloud === undefined ? null : o.cloud,
    modalConfirm: o.modalConfirm,
    modalResults: o.modalResults,
  })
  const page = loadPage('pages/index/index.js', { wx: wx })
  // 页面内部 require 的模块实例（同一份缓存，可注入失败 / 统计调用）
  const mods = {
    api: require(mini('utils/api.js')),
    ai: require(mini('utils/ai.js')),
    suggestions: require(mini('utils/suggestions.js')),
    treeUtils: require(mini('utils/tree.js')),
    knowledge: require(mini('utils/knowledge.js')),
  }
  if (t && typeof t.after === 'function') t.after(() => page.onUnload())
  // 走真实入口 onLoad（内部 bootstrap）：api 模块级 mode 初值为 'cloud'，
  // 不先 initDatabase 会走云路径并失败；同时 onLoad 负责 loading 复位，需被覆盖。
  page.onLoad()
  await flush(60)
  return Object.assign({ page: page, storage: storage, wx: wx }, mods)
}

/* ---------------- 视图 / 事件构造 ---------------- */

const viewOf = (page, id) => page.data.tasks.find((t) => t._id === id)
const goalOf = (page, id) => page.data.goals.find((g) => g._id === id)
const storedTasks = (storage) => storage.get('po_tasks')
const storedOf = (storage, id) => storedTasks(storage).find((t) => t._id === id)
const toasts = (wx) => wx.__calls.toast.map((o) => o.title)
const hasToast = (wx, kw) => toasts(wx).some((s) => String(s || '').indexOf(kw) > -1)
const ds = (id) => ({ currentTarget: { dataset: { id: id } } })
const dsGoal = (goalId) => ({ currentTarget: { dataset: { goal: goalId } } })
const dsTag = (goalId, tag) => ({ currentTarget: { dataset: { goal: goalId, tag: tag } } })
const dsRow = (goalId, row) =>
  ({ currentTarget: { dataset: { key: row.key, has: row.hasChildren, goal: goalId, id: row._id } } })
const rowOf = (page, goalId, id) => goalOf(page, goalId).treeRows.find((r) => r._id === id)
const sugOf = (page, goalId, key) => goalOf(page, goalId).suggestions.find((s) => s.key === key)

/** 等待微任务/定时器排空（fire-and-forget 链路落定用） */
const flush = (ms) => new Promise((r) => setTimeout(r, ms === undefined ? 20 : ms))

/** 记录 setData 调用（断言"破裂动画确实播放过"这类瞬态 UI 状态） */
function recordSetData(page) {
  const log = []
  const orig = page.setData
  page.setData = function (patch, cb) {
    log.push(Object.assign({}, patch))
    return orig.call(this, patch, cb)
  }
  return log
}

const burstPlayed = (log, id) =>
  log.some((p) => p.showBurst === true && p.burstTaskId === id)

/* ---------------- 任务树场景 ---------------- */

/** 两个大目标：g1(10h) 无子任务 → 瓶颈；g2(6h)、g3(2h) → 锁定 */
function threeGoals() {
  return [
    raw('g1', { title: '目标A', estimatedHours: 10 }),
    raw('g2', { title: '目标B', estimatedHours: 6 }),
    raw('g3', { title: '目标C', estimatedHours: 2 }),
  ]
}

/** 三层任务树：g1(4h) → m1(4h) → [a(2h), b(2h)]；卡点在叶子 a */
function deepTree() {
  return [
    raw('g1', { title: '完成投稿', estimatedHours: 4 }),
    raw('m1', { title: '补实验', estimatedHours: 4, parentGoalId: 'g1', level: 1 }),
    raw('a', { title: '调超参', estimatedHours: 2, parentGoalId: 'm1', level: 2 }),
    raw('b', { title: '跑基线', estimatedHours: 2, parentGoalId: 'm1', level: 2 }),
  ]
}

/**
 * 带卡点的大目标 + 一个陪跑目标（≥2 个大目标才有瓶颈锁定，卡点建议才生成）。
 * g1(4h) → [a(2h，实际 5h 严重超时 → 规则命中 focus+breakdown), b(2h)]；g2(1h)
 */
function sugTree() {
  return [
    raw('g1', { title: '完成投稿', estimatedHours: 4 }),
    raw('a', { title: '写摘要', estimatedHours: 2, parentGoalId: 'g1', level: 1, actualHours: 5 }),
    raw('b', { title: '画图', estimatedHours: 2, parentGoalId: 'g1', level: 1 }),
    raw('g2', { title: '陪跑目标', estimatedHours: 1 }),
  ]
}

/* ==================================================================== *
 * A. 正常路径
 * ==================================================================== */

test('A1 多目标：耗时最长者成为唯一瓶颈并进入进行中，其余锁定且状态落库', async (t) => {
  const { page, storage } = await loadIndexPage(threeGoals(), t)

  assert.equal(page.data.bottleneckId, 'g1')
  assert.equal(page.data.bottleneckReason, '该目标耗时最长，是当前系统瓶颈')
  assert.equal(viewOf(page, 'g1').status, 'in_progress')
  assert.equal(viewOf(page, 'g1').isBottleneck, true)
  assert.equal(viewOf(page, 'g2').status, 'locked')
  assert.equal(viewOf(page, 'g3').status, 'locked')

  // 系统自动流转必须落库（否则下次进来锁定状态丢失）
  assert.equal(storedOf(storage, 'g1').status, 'in_progress')
  assert.equal(storedOf(storage, 'g2').status, 'locked')
  // 自动流转不计入 modificationCount（保持牛鞭效应数据干净）
  assert.equal(storedOf(storage, 'g2').modificationCount, 0)
})

test('A2 完成无子任务的瓶颈目标：播放破裂动画 → 下一个最长目标接任 → 已完成目标退出视图', async (t) => {
  const { page, storage, wx } = await loadIndexPage(threeGoals(), t)
  const log = recordSetData(page)

  await page.completeTask(ds('g1'))

  assert.equal(viewOf(page, 'g1').status, 'completed')
  assert.equal(viewOf(page, 'g1').isBottleneck, false)
  assert.equal(page.data.bottleneckId, 'g2', '剩余目标中最长者接任瓶颈')
  assert.equal(viewOf(page, 'g2').status, 'in_progress')
  assert.equal(viewOf(page, 'g3').status, 'locked')
  assert.equal(page.data.goals.length, 2, '已完成的大目标不再出现在卡片列表')

  assert.ok(burstPlayed(log, 'g1'), '应播放过一次针对 g1 的破裂动画')
  assert.equal(page.data.showBurst, false, '动画结束后必须复位，否则卡片一直闪')
  assert.equal(page.data.burstTaskId, null)
  assert.equal(page.data.submitting, false, '完成后必须解除提交锁')
  assert.ok(hasToast(wx, '瓶颈已突破'), '应提示瓶颈已突破')
  assert.equal(storedOf(storage, 'g1').status, 'completed')
})

test('A3 有子任务的大目标：完成计数正确，且不出现"手动完成"入口', async (t) => {
  const { page } = await loadIndexPage(sugTree(), t)
  const g1 = goalOf(page, 'g1')

  // 完成计数统计全部层级后代（WXML 用 subTotal===0 决定是否显示"完成"按钮）
  assert.equal(g1.subTotal, 2)
  assert.equal(g1.subDone, 0)
  assert.notEqual(g1.subTotal, 0, '有子任务 → 不显示手动完成按钮，由联动自动完成')

  await page.completeSubtaskById('b')
  assert.equal(goalOf(page, 'g1').subDone, 1)
})

test('A4 树行点击：有下级的行切换展开/折叠，并从此不再被"自动展开到卡点"覆盖', async (t) => {
  const { page } = await loadIndexPage(deepTree(), t)

  // 默认展开到卡点：m1 展开 → 叶子 a/b 可见
  assert.ok(rowOf(page, 'g1', 'a'), '默认应展开到卡点所在层级')
  assert.ok(rowOf(page, 'g1', 'm1'))
  assert.equal(rowOf(page, 'g1', 'm1').expanded, true)

  page.onTreeRowTap(dsRow('g1', rowOf(page, 'g1', 'm1'))) // 点击 m1 折叠
  assert.equal(page.userToggledTree['g1'], true, '记录用户手动操作过该树')
  assert.equal(rowOf(page, 'g1', 'a'), undefined, '折叠后叶子不再渲染')
  assert.equal(rowOf(page, 'g1', 'm1').expanded, false)

  page.onTreeRowTap(dsRow('g1', rowOf(page, 'g1', 'm1'))) // 再点展开
  assert.ok(rowOf(page, 'g1', 'a'), '再次点击应重新展开')
  assert.equal(rowOf(page, 'g1', 'm1').expanded, true)

  // 跨刷新保留：用户操作过之后，重新加载不应回到"自动展开到卡点"
  page.onTreeRowTap(dsRow('g1', rowOf(page, 'g1', 'm1'))) // 折叠
  await page.loadTasks()
  assert.equal(rowOf(page, 'g1', 'a'), undefined, '用户折叠的选择必须保留')
})

test('A5 叶子任务全部完成 → 中间层静默完成 → 大目标自动达成（结算耗时 + 破裂动画）', async (t) => {
  const { page, storage, wx } = await loadIndexPage(deepTree(), t)
  const log = recordSetData(page)

  await page.completeSubtaskById('a')
  assert.equal(viewOf(page, 'a').status, 'completed')
  assert.equal(viewOf(page, 'm1').status, 'pending', '还有 b 未完成，中间层不应提前完成')

  await page.completeSubtaskById('b')
  assert.equal(viewOf(page, 'b').status, 'completed')
  assert.equal(viewOf(page, 'm1').status, 'completed', '子任务全完成 → 中间层静默完成')
  assert.equal(viewOf(page, 'g1').status, 'completed', '全部后代完成 → 大目标自动达成')

  assert.ok(burstPlayed(log, 'g1'), '大目标达成应播放破裂动画')
  assert.equal(page.data.showBurst, false)
  assert.ok(hasToast(wx, '大目标达成'))
  assert.equal(page.data.goals.length, 0, '所有目标完成 → 卡片列表为空（空状态）')
  assert.equal(page.data.bottleneckId, null)
  assert.equal(storedOf(storage, 'g1').status, 'completed')
  assert.equal(storedOf(storage, 'm1').status, 'completed')
})

test('A6 恢复已完成的叶子：沿祖先链把自动完成的中间层与大目标一起拉回在办', async (t) => {
  const { page, storage } = await loadIndexPage(deepTree(), t)

  await page.completeSubtaskById('a')
  await page.completeSubtaskById('b')
  assert.equal(viewOf(page, 'g1').status, 'completed')
  assert.equal(page.data.goals.length, 0)

  // 误点补救：把 a 恢复为未完成
  await page.completeSubtaskById('a')

  assert.equal(viewOf(page, 'a').status, 'pending')
  assert.equal(viewOf(page, 'm1').status, 'pending', '中间层必须一起拉回，避免"父已完成但子未完成"')
  assert.equal(viewOf(page, 'g1').status, 'pending', '大目标同样拉回在办')
  assert.equal(page.data.goals.length, 1, '大目标重新回到卡片列表')
  assert.ok(hasToast(page.__wx, '已恢复为未完成'))
  assert.equal(storedOf(storage, 'a').status, 'pending')
  assert.equal(storedOf(storage, 'g1').status, 'pending')
})

test('A7 添加目标：合法输入落库并重算瓶颈，表单与开关复位', async (t) => {
  const { page, storage, wx } = await loadIndexPage([raw('g1', { title: '已有目标', estimatedHours: 1 })], t)

  page.toggleAddForm()
  assert.equal(page.data.showAddForm, true)
  page.onTitleInput({ detail: { value: '  新目标  ' } })
  page.onHoursInput({ detail: { value: '8' } })
  await page.submitTask()

  const added = storedTasks(storage).filter((x) => x.title === '新目标')
  assert.equal(added.length, 1, '标题应被 trim 后落库')
  assert.equal(added[0].estimatedHours, 8)
  assert.equal(page.data.form.title, '')
  assert.equal(page.data.form.estimatedHours, '')
  assert.equal(page.data.showAddForm, false)
  assert.equal(page.data.bottleneckId, added[0]._id, '8h 的新目标应立刻成为瓶颈')
  assert.equal(viewOf(page, 'g1').status, 'locked')
  assert.equal(page.data.submitting, false)
  assert.equal(wx.__calls.toast.length, 0, '正常添加不应有任何错误提示')
})

test('A8 删除目标：确认后递归删除整棵子树、清理页面缓存、下一个目标接任瓶颈', async (t) => {
  const tasks = [
    raw('g1', { title: '要删的目标', estimatedHours: 10 }),
    raw('m1', { title: '中间层', estimatedHours: 4, parentGoalId: 'g1', level: 1 }),
    raw('a', { title: '叶子', estimatedHours: 4, parentGoalId: 'm1', level: 2 }),
    raw('g2', { title: '剩余目标', estimatedHours: 2 }),
    raw('g3', { title: '剩余目标2', estimatedHours: 1 }),
  ]
  const { page, storage, wx } = await loadIndexPage(tasks, t)
  page.userToggledGoals['g1'] = true
  page.treeExpanded['g1'] = { m1: true }
  page.aiSugCache['g1'] = { clogId: 'a', ts: Date.now(), suggestions: [{}] }

  page.onDeleteGoal(ds('g1'))
  assert.equal(wx.__calls.modal.length, 1)
  assert.ok(String(wx.__calls.modal[0].content).indexOf('2 个各级子任务') > -1, '确认文案应说明会连带删除的子任务数')

  await flush(30) // 确认弹窗回调是同步的，但 executeDeleteGoal 是异步的
  await page.executeDeleteGoal('g1')

  const ids = storedTasks(storage).map((x) => x._id)
  assert.deepEqual(ids.sort(), ['g2', 'g3'], '大目标与其全部层级后代都应从库里删除')
  assert.equal(viewOf(page, 'g1'), undefined)
  assert.equal(viewOf(page, 'a'), undefined)
  assert.equal(page.userToggledGoals['g1'], undefined, '页面级缓存需一并清理')
  assert.equal(page.treeExpanded['g1'], undefined)
  assert.equal(page.aiSugCache['g1'], undefined)
  assert.equal(page.data.bottleneckId, 'g2', '剩余目标自动接任瓶颈')
  assert.equal(page.data.submitting, false)
  assert.ok(hasToast(wx, '已删除'))
})

test('A9 补充情况（AI 不可用 → 规则降级）：建议切换为针对性版本并落库', async (t) => {
  const { page, storage, api } = await loadIndexPage(sugTree(), t)
  const clogId = goalOf(page, 'g1').clogId
  assert.equal(goalOf(page, 'g1').suggestionSource, 'rule', 'AI 不可用时初始应为规则建议')

  page.onToggleCtxPanel(dsGoal('g1'))
  assert.equal(goalOf(page, 'g1').ctxOpen, true)
  page.onCtxTagTap(dsTag('g1', '缺资源'))
  page.onCtxTagTap(dsTag('g1', '没时间'))
  page.onCtxTextInput({ currentTarget: { dataset: { goal: 'g1' } }, detail: { value: '设备排不上队' } })
  // 输入走页面级暂存（不 setData，避免 10s 心跳 rerender 重置输入光标），断言草稿本身
  assert.equal(page.ctxPanel['g1'].text, '设备排不上队')
  assert.equal(goalOf(page, 'g1').ctxTagItems.filter((x) => x.active).length, 2)

  await page.onCtxSubmit(dsGoal('g1'))

  const g1 = goalOf(page, 'g1')
  assert.equal(g1.suggestionSource, 'refined', '提交补充后应展示补充情况版建议')
  assert.equal(g1.ctxOpen, false, '提交后面板应收起')
  assert.equal(g1.hasUserContext, true)
  assert.ok(g1.suggestions.length > 0 && g1.suggestions.length <= 2, '建议最多展示 2 条')
  assert.ok(g1.suggestions.every((s) => s.taskId === clogId), '建议应挂在卡点上')

  // 落库 + 加密往返
  const stored = storedOf(storage, clogId)
  assert.deepEqual(stored.userContext.tags, ['缺资源', '没时间'])
  assert.notEqual(stored.userContext.text, '设备排不上队', 'userContext.text 应加密落库')
  assert.equal(stored.suggestionHistory.length, 1)
  assert.equal(stored.suggestionHistory[0].basedOn, 'user_context')
  assert.equal(stored.userContext.version, 1)
  assert.equal(stored.modificationCount, 0, '补充情况不计入修改次数')

  const reloaded = await api.loadTasks()
  const clog = reloaded.find((x) => x._id === clogId)
  assert.equal(clog.userContext.text, '设备排不上队', '重新读取应透明解密回原文')
  assert.equal(clog.modificationCount, 0, '补充情况不计入修改次数')
})

test('A10 补充情况可反复调整：版本号递增、建议历史只保留最近 5 条', async (t) => {
  const { page, storage } = await loadIndexPage(sugTree(), t)
  const clogId = goalOf(page, 'g1').clogId

  for (let i = 1; i <= 6; i++) {
    page.onToggleCtxPanel(dsGoal('g1'))
    if (i > 1) page.onCtxTagTap(dsTag('g1', '缺资源')) // 第 2 次起标签已在面板里，再点一次取消
    else page.onCtxTagTap(dsTag('g1', '缺资源'))
    page.onCtxTextInput({
      currentTarget: { dataset: { goal: 'g1' } },
      detail: { value: '第 ' + i + ' 次补充' },
    })
    await page.onCtxSubmit(dsGoal('g1'))
  }

  const stored = storedOf(storage, clogId)
  assert.equal(stored.userContext.version, 6, '每次提交版本号递增')
  assert.equal(stored.suggestionHistory.length, 5, '建议历史上限 5 条（环形裁剪）')
  assert.equal(
    stored.suggestionHistory[4].version,
    6,
    '裁剪后保留的是最新一条'
  )
  assert.equal(goalOf(page, 'g1').suggestionSource, 'refined')
})

test('A11 采纳建议：拆解类跳转拆解页并预填卡点，其余类型仅记录', async (t) => {
  const { page, storage, wx } = await loadIndexPage(sugTree(), t)
  const g1 = goalOf(page, 'g1')
  const focusSug = g1.suggestions.find((s) => s.type === 'focus')
  const breakdownSug = g1.suggestions.find((s) => s.type === 'breakdown')
  assert.ok(focusSug && breakdownSug, '严重超时的卡点应同时给出 focus 与 breakdown 两条规则建议')

  // 非拆解类：记录采纳 + 从视图消失
  page.onAdoptSuggestion({ currentTarget: { dataset: { goal: 'g1', key: focusSug.key } } })
  assert.equal(wx.__calls.modal.length, 1)
  assert.equal(sugOf(page, 'g1', focusSug.key), undefined, '采纳后该条不再展示')
  assert.ok(hasToast(wx, '已锁定专注模式'))

  // 拆解类：预填卡点任务名并跳转拆解页
  page.onAdoptSuggestion({ currentTarget: { dataset: { goal: 'g1', key: breakdownSug.key } } })
  assert.equal(storage.get('po_pending_breakdown'), breakdownSug.taskTitle)
  assert.equal(wx.__calls.switchTab.length, 1)
  assert.equal(wx.__calls.switchTab[0].url, '/pages/breakdown/index')
  // 采纳日志留痕
  const adopted = storage.get('po_sug_adopted')
  assert.equal(adopted.length, 2)
  assert.equal(adopted[1].key, breakdownSug.key)
})

test('A12 忽略建议：该条不再出现，并跨刷新保持忽略', async (t) => {
  const { page, storage } = await loadIndexPage(sugTree(), t)
  const target = goalOf(page, 'g1').suggestions[0]

  page.onDismissSuggestion({ currentTarget: { dataset: { key: target.key } } })

  assert.equal(sugOf(page, 'g1', target.key), undefined)
  assert.ok(storage.get('po_sug_ignored').indexOf(target.key) > -1, '忽略名单应落库')

  await page.loadTasks()
  assert.equal(sugOf(page, 'g1', target.key), undefined, '刷新后仍不展示')
})

test('A13 多任务警告：在办大目标超过 3 个时提示并给出数量', async (t) => {
  const tasks = [
    raw('g1', { title: 'A', estimatedHours: 8 }),
    raw('g2', { title: 'B', estimatedHours: 6 }),
    raw('g3', { title: 'C', estimatedHours: 4 }),
    raw('g4', { title: 'D', estimatedHours: 2 }),
  ]
  const { page } = await loadIndexPage(tasks, t)

  assert.equal(page.data.activeTaskCount, 4)
  assert.equal(page.data.showWarning, true)
  assert.ok(page.data.warningMessage.indexOf('4') > -1)
  assert.ok(page.data.warningMessage.indexOf('40%') > -1)
})

test('A14 数据一致性收敛：子任务在页面外被置完成，刷新后大目标自动完成', async (t) => {
  const tasks = [
    raw('g1', { title: '目标', estimatedHours: 4 }),
    raw('a', { title: '子A', estimatedHours: 2, parentGoalId: 'g1', level: 1, status: 'completed' }),
    raw('b', { title: '子B', estimatedHours: 2, parentGoalId: 'g1', level: 1, status: 'completed' }),
    raw('g2', { title: '陪跑', estimatedHours: 1 }),
    raw('g3', { title: '陪跑2', estimatedHours: 1 }),
  ]
  const { page, storage } = await loadIndexPage(tasks, t)

  assert.equal(viewOf(page, 'g1').status, 'completed', '加载时应收敛为已完成')
  assert.equal(goalOf(page, 'g1'), undefined, '已完成的大目标不进视图')
  assert.equal(page.data.bottleneckId, 'g2')
  assert.equal(storedOf(storage, 'g1').status, 'completed', '收敛结果应落库')
})

test('A15 知识库入口跳转；A16 下拉刷新结束后收起刷新态', async (t) => {
  const { page, wx } = await loadIndexPage([raw('g1', {})], t)

  page.goKnowledge()
  assert.equal(wx.__calls.navigate.length, 1)
  assert.equal(wx.__calls.navigate[0].url, '/pages/knowledge/index')

  let stopped = 0
  wx.stopPullDownRefresh = () => {
    stopped += 1
  }
  page.onPullDownRefresh() // 非 async：刷新态在 loadTasks 结束后才收起
  await flush(60)
  assert.equal(stopped, 1)
  assert.equal(page.data.loading, false)
})

test('A17 正常路径：提交补充后再次点「编辑补充」，面板应回填已提交内容', async (t) => {
  const { page } = await loadIndexPage(sugTree(), t)

  page.onToggleCtxPanel(dsGoal('g1'))
  page.onCtxTagTap(dsTag('g1', '缺资源'))
  page.onCtxTagTap(dsTag('g1', '等别人'))
  page.onCtxTextInput({ currentTarget: { dataset: { goal: 'g1' } }, detail: { value: '设备排不上队' } })
  await page.onCtxSubmit(dsGoal('g1'))
  assert.equal(goalOf(page, 'g1').ctxOpen, false)

  // WXML 上该入口文案是「编辑补充」→ 用户预期是"看到并修改已提交内容"，
  // 打开后若标签全未选中、描述为空，用户只能重打一遍，且再次提交会静默覆盖旧内容。
  page.onToggleCtxPanel(dsGoal('g1'))
  const g1 = goalOf(page, 'g1')
  assert.equal(g1.ctxOpen, true)
  assert.equal(g1.ctxText, '设备排不上队', '「编辑补充」应回填已提交的描述')
  assert.deepEqual(
    g1.ctxTagItems.filter((x) => x.active).map((x) => x.label),
    ['缺资源', '等别人'],
    '「编辑补充」应回填已提交的标签'
  )

  // 取消后草稿保留（文档化行为：再次打开可继续编辑）
  page.onCtxCancel(dsGoal('g1'))
  page.onToggleCtxPanel(dsGoal('g1'))
  assert.equal(goalOf(page, 'g1').ctxText, '设备排不上队')
})

/* ==================================================================== *
 * B. 边界条件
 * ==================================================================== */

test('B1 边界：只有 1 个大目标时不锁定（避免自我阻塞），遗留锁定状态回退为待办', async (t) => {
  const tasks = [raw('g1', { title: '唯一目标', estimatedHours: 5, status: 'locked', isBottleneck: true })]
  const { page, storage } = await loadIndexPage(tasks, t)

  assert.equal(page.data.bottleneckId, null)
  assert.equal(page.data.bottleneckReason, '')
  assert.equal(viewOf(page, 'g1').status, 'pending')
  assert.equal(viewOf(page, 'g1').isBottleneck, false)
  assert.equal(page.timer, null, '无瓶颈时不应启动专注计时')
  assert.equal(storedOf(storage, 'g1').status, 'pending', '回退结果应落库')
})

test('B2 边界：在办大目标恰好 3 个不警告，第 4 个才警告', async (t) => {
  const three = await loadIndexPage(
    [raw('g1', { estimatedHours: 3 }), raw('g2', { estimatedHours: 2 }), raw('g3', { estimatedHours: 1 })],
    t
  )
  assert.equal(three.page.data.activeTaskCount, 3)
  assert.equal(three.page.data.showWarning, false)
  assert.equal(three.page.data.warningMessage, '')

  const four = await loadIndexPage(
    [
      raw('g1', { estimatedHours: 4 }),
      raw('g2', { estimatedHours: 3 }),
      raw('g3', { estimatedHours: 2 }),
      raw('g4', { estimatedHours: 1 }),
    ],
    t
  )
  assert.equal(four.page.data.showWarning, true)
})

test('B3 边界：子任务不计入在办数量（拆 8 个子任务仍只算 1 个在办）', async (t) => {
  const tasks = [raw('g1', { title: '大目标', estimatedHours: 8 })]
  for (let i = 0; i < 8; i++) {
    tasks.push(raw('s' + i, { title: '子' + i, estimatedHours: 1, parentGoalId: 'g1', level: 1 }))
  }
  const { page } = await loadIndexPage(tasks, t)

  assert.equal(page.data.activeTaskCount, 1, '利特尔法则：在办只算大目标')
  assert.equal(page.data.showWarning, false)
})

test('B4 边界：耗时相同的多个目标，瓶颈选取稳定（保持库中顺序）', async (t) => {
  const { page } = await loadIndexPage(
    [raw('g1', { title: '先', estimatedHours: 5 }), raw('g2', { title: '后', estimatedHours: 5 })],
    t
  )
  assert.equal(page.data.bottleneckId, 'g1')
})

test('B5 边界：新增目标的标题与耗时校验（空白/0/负数/非数字/超上限）', async (t) => {
  const { page, storage, wx } = await loadIndexPage([], t)

  const cases = [
    { title: '   ', hours: '2', kw: '请输入任务名称' },
    { title: '有效标题', hours: '', kw: '请输入有效耗时' },
    { title: '有效标题', hours: '0', kw: '请输入有效耗时' },
    { title: '有效标题', hours: '-1', kw: '请输入有效耗时' },
    { title: '有效标题', hours: 'abc', kw: '请输入有效耗时' },
    { title: '有效标题', hours: '1000.1', kw: '请输入有效耗时' },
  ]
  for (const c of cases) {
    page.onTitleInput({ detail: { value: c.title } })
    page.onHoursInput({ detail: { value: c.hours } })
    await page.submitTask()
    assert.ok(hasToast(wx, c.kw), '输入 ' + JSON.stringify(c) + ' 应提示「' + c.kw + '」')
    assert.equal(storedTasks(storage).length, 0, '非法输入不得落库')
    assert.equal(page.data.submitting, false, '校验失败不得留下提交锁')
  }

  // 上边界：恰好 1000 小时合法
  page.onTitleInput({ detail: { value: '边界目标' } })
  page.onHoursInput({ detail: { value: '1000' } })
  await page.submitTask()
  assert.equal(storedTasks(storage).length, 1)
  assert.equal(storedTasks(storage)[0].estimatedHours, 1000)
})

test('B6 边界：提交进行中重复点击只新增一条', async (t) => {
  const { page, storage } = await loadIndexPage([], t)

  page.onTitleInput({ detail: { value: '并发目标' } })
  page.onHoursInput({ detail: { value: '3' } })
  page.setData({ submitting: true }) // 模拟第一次点击后仍在途
  await page.submitTask()

  assert.equal(storedTasks(storage).length, 0, 'submitting 为真时必须直接返回')
})

test('B7 边界：补充标签恰好 3 个可提交，选第 4 个被拦截', async (t) => {
  const { page, storage, wx } = await loadIndexPage(sugTree(), t)
  page.onToggleCtxPanel(dsGoal('g1'))

  page.onCtxTagTap(dsTag('g1', '缺资源'))
  page.onCtxTagTap(dsTag('g1', '不会做'))
  page.onCtxTagTap(dsTag('g1', '没时间'))
  assert.equal(goalOf(page, 'g1').ctxTagItems.filter((x) => x.active).length, 3)

  page.onCtxTagTap(dsTag('g1', '等别人'))
  assert.ok(hasToast(wx, '最多选3个标签'))
  assert.equal(goalOf(page, 'g1').ctxTagItems.filter((x) => x.active).length, 3, '第 4 个不得选中')

  // 取消选中后可以再选别的
  page.onCtxTagTap(dsTag('g1', '缺资源'))
  page.onCtxTagTap(dsTag('g1', '等别人'))
  assert.equal(goalOf(page, 'g1').ctxTagItems.filter((x) => x.active).length, 3)

  await page.onCtxSubmit(dsGoal('g1'))
  const clogId = goalOf(page, 'g1').clogId
  assert.equal(storedOf(storage, clogId).userContext.tags.length, 3)
})

test('B8 边界：补充内容全空时不提交，仅提示', async (t) => {
  const { page, storage, wx } = await loadIndexPage(sugTree(), t)
  const clogId = goalOf(page, 'g1').clogId
  page.onToggleCtxPanel(dsGoal('g1'))

  await page.onCtxSubmit(dsGoal('g1'))

  assert.ok(hasToast(wx, '请选择标签或补充描述'))
  assert.equal(storedOf(storage, clogId).userContext, null, '不得写入空补充')
  assert.equal(page.refiningGoalId, '', '不得残留加载态（否则建议区永远转圈）')
})

test('B9 边界：补充描述超 200 字被截断后落库', async (t) => {
  const { page, api } = await loadIndexPage(sugTree(), t)
  const clogId = goalOf(page, 'g1').clogId
  const long = 'A'.repeat(260)

  page.onToggleCtxPanel(dsGoal('g1'))
  page.onCtxTextInput({ currentTarget: { dataset: { goal: 'g1' } }, detail: { value: long } })
  await page.onCtxSubmit(dsGoal('g1'))

  assert.equal(viewOf(page, clogId).userContext.text.length, 200, '内存态应为截断后的 200 字')
  const reloaded = await api.loadTasks()
  assert.equal(
    reloaded.find((x) => x._id === clogId).userContext.text.length,
    200,
    '加密落库后重新读取也应还原为 200 字'
  )
})

test('B10 边界：异常入参（标签超过 3 个）提交时仍只保留前 3 个', async (t) => {
  const { page, storage } = await loadIndexPage(sugTree(), t)
  const clogId = goalOf(page, 'g1').clogId
  // 绕过 UI 直接构造超量草稿（模拟历史脏数据 / 程序化调用）
  page.ctxPanel['g1'] = { open: true, tags: ['缺资源', '不会做', '没时间', '等别人'], text: '' }

  await page.onCtxSubmit(dsGoal('g1'))

  assert.deepEqual(storedOf(storage, clogId).userContext.tags, ['缺资源', '不会做', '没时间'])
})

test('B11 边界：已完成的大目标不进入视图；全部完成时列表为空', async (t) => {
  const { page } = await loadIndexPage(
    [raw('g1', { title: '已完成', estimatedHours: 5, status: 'completed' }), raw('g2', { title: '进行中', estimatedHours: 1 })],
    t
  )

  assert.equal(page.data.goals.length, 1)
  assert.equal(page.data.goals[0]._id, 'g2')
  assert.equal(page.data.bottleneckId, null, '只剩 1 个未完成目标 → 不锁定')

  await page.completeTask(ds('g2'))
  assert.equal(page.data.goals.length, 0)
  assert.equal(page.data.activeTaskCount, 0)
  assert.equal(page.data.bottleneckId, null)
})

test('B12 边界：提交锁生效期间，完成操作与补充提交都被拒绝', async (t) => {
  const { page, storage } = await loadIndexPage(deepTree(), t)
  page.setData({ submitting: true })

  await page.completeSubtaskById('a')
  assert.equal(viewOf(page, 'a').status, 'pending', 'submitting 为真时不得改动状态')
  assert.equal(storedOf(storage, 'a').status, 'pending')

  page.onToggleCtxPanel(dsGoal('g1'))
  await page.onCtxSubmit(dsGoal('g1'))
  assert.equal(page.refiningGoalId, '', '被拒绝时不得进入加载态')
})

test('B13 边界：进度百分比（预估为 0 / 实际超过预估）', async (t) => {
  const { page } = await loadIndexPage(
    [raw('g1', { estimatedHours: 0, actualHours: 3 }), raw('g2', { estimatedHours: 2, actualHours: 9 })],
    t
  )

  assert.equal(viewOf(page, 'g1').progress, 0, '预估为 0 时进度按 0 处理，不得出现 Infinity/NaN')
  assert.equal(viewOf(page, 'g2').progress, 100, '实际超过预估时封顶 100')
  assert.equal(page.calcProgress(0, 0), 0)
  assert.equal(page.calcProgress(1, 4), 25)
})

/* ==================================================================== *
 * C. 异常情况
 * ==================================================================== */

test('C1 异常：任务读取失败 → 提示可重试，页面不崩、loading 已复位', async (t) => {
  const { page, wx, api } = await loadIndexPage([raw('g1', {})], t)
  api.loadTasks = () => Promise.reject(new Error('network down'))

  await page.loadTasks()

  assert.ok(hasToast(wx, '任务加载失败'))
  assert.equal(page.data.loading, false, 'loading 必须复位，否则 onShow 之后再不刷新')
  assert.equal(page.data.tasks.length, 1, '失败时保留上一次的内存态，不清空界面')
})

test('C2 异常：新增失败 → 提示重试并解除提交锁，草稿保留', async (t) => {
  const { page, wx, api } = await loadIndexPage([], t)
  api.addTask = () => Promise.reject(new Error('write failed'))

  page.onTitleInput({ detail: { value: '写不进去的目标' } })
  page.onHoursInput({ detail: { value: '2' } })
  await page.submitTask()

  assert.ok(hasToast(wx, '添加失败'))
  assert.equal(page.data.submitting, false, '必须解除提交锁，否则按钮永久不可点')
  assert.equal(page.data.form.title, '写不进去的目标', '失败时保留草稿，便于重试')
})

test('C3 异常：删除失败（可能部分成功）→ 提示并回源收敛真实状态', async (t) => {
  const tasks = [
    raw('g1', { title: '要删的', estimatedHours: 10 }),
    raw('a', { title: '叶子', estimatedHours: 10, parentGoalId: 'g1', level: 1 }),
    raw('g2', { title: '陪跑', estimatedHours: 1 }),
  ]
  const { page, storage, wx, api } = await loadIndexPage(tasks, t)
  api.removeTask = () => Promise.reject(new Error('delete failed'))

  await page.executeDeleteGoal('g1')

  assert.ok(hasToast(wx, '删除失败'))
  assert.equal(page.data.submitting, false)
  assert.equal(storedTasks(storage).length, 3, '删除失败不应破坏数据')
  assert.ok(viewOf(page, 'g1'), '回源后界面与数据源一致')
  assert.equal(page.data.bottleneckId, 'g1', '回源后瓶颈重算正确')
})

test('C4 异常：删除确认弹窗点"取消" → 不做任何删除', async (t) => {
  const { page, storage, wx } = await loadIndexPage(threeGoals(), t, { modalConfirm: false })

  page.onDeleteGoal(ds('g1'))
  await flush(30)

  assert.equal(wx.__calls.modal.length, 1)
  assert.equal(storedTasks(storage).length, 3)
  assert.ok(viewOf(page, 'g1'))
})

test('C5 异常：AI 建议失败 → 静默降级为规则建议并进入冷却，不重复请求', async (t) => {
  const { page, ai } = await loadIndexPage(sugTree(), t)
  await flush(40) // 等 bootstrap 期间那次 fire-and-forget 落定

  const cache = page.aiSugCache['g1']
  assert.ok(cache && cache.failedAt, 'AI 失败应记录冷却时间戳')
  assert.equal(goalOf(page, 'g1').suggestionSource, 'rule', '失败时保持规则建议，不得空着')

  let calls = 0
  ai.suggestForBottleneck = async () => {
    calls += 1
    return []
  }
  await page.enhanceSuggestionsWithAI()
  assert.equal(calls, 0, '冷却期内不得再次请求 AI（避免 onShow 重试风暴）')
})

test('C5b 异常恢复：冷却结束后 AI 生成成功 → 建议来源切换为 AI', async (t) => {
  const { page, ai } = await loadIndexPage(sugTree(), t)
  await flush(40)

  // 清掉失败冷却，模拟 5 分钟后再进首页
  page.aiSugCache = {}
  ai.suggestForBottleneck = async (info, taskId) => [
    { key: taskId + ':ai:help', type: 'help', action: '找师兄要一版模板', reason: '自己搭太慢', effect: '当天就能交', taskId: taskId },
  ]

  await page.enhanceSuggestionsWithAI()

  assert.ok(page.aiSugCache['g1'].suggestions.length, 'AI 建议应写入缓存')
  assert.equal(page.aiSugCache['g1'].failedAt, undefined)
  const g1 = goalOf(page, 'g1')
  assert.equal(g1.suggestionSource, 'ai')
  assert.equal(g1.suggestions[0].action, '找师兄要一版模板')
  assert.equal(page.aiSugInFlight, false, '请求结束必须清除在途标记')
})

test('C6 异常：知识库检索失败不阻塞补充提交', async (t) => {
  const { page, storage, api } = await loadIndexPage(sugTree(), t)
  const clogId = goalOf(page, 'g1').clogId
  api.loadKnowledge = () => Promise.reject(new Error('knowledge down'))

  page.onToggleCtxPanel(dsGoal('g1'))
  page.onCtxTagTap(dsTag('g1', '缺资源'))
  await page.onCtxSubmit(dsGoal('g1'))

  assert.equal(goalOf(page, 'g1').suggestionSource, 'refined', '检索失败仍应出建议（规则降级）')
  assert.equal(storedOf(storage, clogId).suggestionHistory.length, 1)
  assert.equal(page.refiningGoalId, '', '不得卡在加载态')
})

test('C7 异常：锁定目标下的叶子不允许完成，仅提示先推进瓶颈', async (t) => {
  const tasks = [
    raw('g1', { title: '瓶颈目标', estimatedHours: 10 }),
    raw('g2', { title: '锁定目标', estimatedHours: 2 }),
    raw('x', { title: '锁定的子任务', estimatedHours: 2, parentGoalId: 'g2', level: 1 }),
  ]
  const { page, storage, wx } = await loadIndexPage(tasks, t)
  assert.equal(page.data.bottleneckId, 'g1')
  assert.equal(viewOf(page, 'g2').status, 'locked')

  page.onTreeRowTap(dsRow('g2', rowOf(page, 'g2', 'x')))

  assert.ok(hasToast(wx, '该目标已锁定'))
  assert.equal(viewOf(page, 'x').status, 'pending')
  assert.equal(storedOf(storage, 'x').status, 'pending')
})

test('C8 异常：删除当前瓶颈前先结算专注时长，再由剩余目标接任', async (t) => {
  const tasks = [
    raw('g1', { title: '瓶颈', estimatedHours: 10, actualHours: 1, status: 'in_progress', isBottleneck: true }),
    raw('a', { title: '叶子', estimatedHours: 10, parentGoalId: 'g1', level: 1 }),
    raw('g2', { title: '陪跑', estimatedHours: 2 }),
    raw('g3', { title: '陪跑2', estimatedHours: 1 }),
  ]
  const { page, storage, api } = await loadIndexPage(tasks, t)
  assert.ok(page.focusStartTs, '瓶颈存在时应已开始专注计时')

  const patches = []
  const origUpdate = api.updateTask
  api.updateTask = (id, patch, opts) => {
    patches.push({ id: id, patch: patch })
    return origUpdate(id, patch, opts)
  }

  // 模拟本次会话已专注 1 小时（未落库的增量）
  page.focusStartTs = Date.now() - 3600 * 1000
  await page.executeDeleteGoal('g1')

  const settle = patches.find((p) => p.id === 'g1' && p.patch.actualHours !== undefined)
  assert.ok(settle, '删除前必须先把未落库的专注增量结算到该目标')
  assert.ok(
    settle.patch.actualHours > 1.9 && settle.patch.actualHours < 2.1,
    '应为 1h 基数 + 1h 增量，实际 ' + settle.patch.actualHours
  )
  assert.equal(page.data.bottleneckId, 'g2', '剩余目标中最长者接任瓶颈')
  assert.ok(page.timer, '新瓶颈应重新开始计时')
  assert.equal(storedTasks(storage).length, 2)
})

test('C10 异常：本地存储写入失败（调优入口）→ 静默降级但仍完成跳转', async (t) => {
  const { page, wx } = await loadIndexPage([raw('g1', {})], t)
  const origSet = wx.setStorageSync
  wx.setStorageSync = (k, v) => {
    if (k === 'po_pending_refine') throw new Error('storage full')
    return origSet(k, v)
  }

  page.onRefineGoal(ds('g1'))

  assert.equal(wx.__calls.switchTab.length, 1, '存储失败不应阻断跳转')
  assert.equal(wx.__calls.switchTab[0].url, '/pages/breakdown/index')

  wx.setStorageSync = origSet
  // 不存在的目标不应跳转
  wx.__calls.switchTab.length = 0
  page.onRefineGoal(ds('ghost'))
  assert.equal(wx.__calls.switchTab.length, 0)
})

test('C11 异常：云同步失败时本地状态仍生效，不误报错误（下次刷新重试）', async (t) => {
  const { page, wx, api } = await loadIndexPage(threeGoals(), t)
  api.updateTask = () => Promise.reject(new Error('cloud down'))

  await page.completeTask(ds('g1'))

  assert.equal(viewOf(page, 'g1').status, 'completed', '本地状态必须生效')
  assert.equal(page.data.bottleneckId, 'g2', '瓶颈重算不依赖云写入结果')
  assert.equal(page.data.submitting, false, '不得因同步失败卡住整页')
  assert.equal(hasToast(wx, '操作失败'), false, '系统自动流转失败不打扰用户')
  assert.ok(hasToast(wx, '瓶颈已突破'))
})

test('C12 异常：提交补充时卡点已被删除 → 收起面板、不报错、不残留加载态', async (t) => {
  const { page, wx } = await loadIndexPage(sugTree(), t)
  const clogId = goalOf(page, 'g1').clogId

  page.onToggleCtxPanel(dsGoal('g1'))
  page.onCtxTagTap(dsTag('g1', '缺资源'))
  // 模拟并发：卡点任务在提交前被删除
  page.setData({ tasks: page.data.tasks.filter((x) => x._id !== clogId) })

  await page.onCtxSubmit(dsGoal('g1'))

  assert.equal(page.refiningGoalId, '', '不得残留加载态')
  assert.equal(goalOf(page, 'g1').ctxOpen, false, '面板应收起')
  assert.equal(page.ctxPanel['g1'], undefined, '草稿应丢弃，下次打开按当前数据重建')
  assert.equal(wx.__calls.toast.length, 0, '这种情况属于用户已处理的并发变更，不应弹错')
})

test('C13 异常：脏数据（悬挂父引用 / 未知状态 / 依赖为字符串）不导致首页崩溃', async (t) => {
  const tasks = [
    raw('g1', { title: '目标', estimatedHours: 4 }),
    raw('a', { title: '正常子任务', estimatedHours: 4, parentGoalId: 'g1', level: 1 }),
    raw('orphan', { title: '悬挂节点', estimatedHours: 1, parentGoalId: 'ghost', level: 1 }),
    raw('weird', { title: '未知状态', estimatedHours: 1, parentGoalId: 'g1', level: 1, status: 'zzz' }),
    raw('g2', { title: '陪跑', estimatedHours: 1 }),
  ]
  const { page, wx } = await loadIndexPage(tasks, t)

  assert.equal(wx.__calls.toast.length, 0, '脏数据不应触发错误提示')
  assert.equal(page.data.bottleneckId, 'g1')
  assert.ok(goalOf(page, 'g1'))
  // 悬挂节点不属于任何目标树 → 不可见但也不影响渲染
  assert.equal(goalOf(page, 'g1').treeRows.some((r) => r._id === 'orphan'), false)
  assert.equal(goalOf(page, 'g1').subTotal, 2, '悬挂节点不计入完成计数')
})

test('C14 异常：任务加载期间再次触发加载（下拉刷新与 onShow 竞争）结果一致', async (t) => {
  const { page, storage } = await loadIndexPage(threeGoals(), t)

  await Promise.all([page.loadTasks(), page.loadTasks(), page.loadTasks()])

  assert.equal(page.data.bottleneckId, 'g1')
  assert.equal(page.data.tasks.length, 3)
  assert.equal(storedOf(storage, 'g1').status, 'in_progress')
  assert.equal(storedOf(storage, 'g2').status, 'locked')
})
