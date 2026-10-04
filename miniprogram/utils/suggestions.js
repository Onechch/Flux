/**
 * utils/suggestions.js —— 瓶颈智能建议（Agent 行动层）
 *
 * 定位：瓶颈识别只回答"卡在哪"，本模块回答"现在怎么办"。
 *
 * 组成：
 * 1. 规则引擎 generateSuggestions(ctx)：基于瓶颈特征匹配预设建议。
 *    AI 不可用时它是降级方案，AI 可用时它仍是兜底保障。
 *    规则优先级：目标被锁定 > 严重超时 > 被前置阻塞 > 阻塞多条下游 > 就绪待启动 > 整体偏慢
 * 2. 补充情况规则引擎 generateCtxSuggestions(clog, userContext)：用户在瓶颈卡片
 *    就地补充"缺资源/不会做/试过没用…"等标签后，按标签给针对性建议
 *    （refineSuggestion 三层降级的第三层；建议历史见 tasks.suggestionHistory）
 * 3. 建议生命周期存储：采纳（adopted）/ 忽略（ignored）/ 反馈（有用/没帮助）日志，
 *    数据结构保留，供后续优化建议质量。
 *
 * 建议数据结构：{ key, type, action, reason, effect, taskId, taskTitle }
 * - key = taskId:type（稳定标识，跨刷新用于忽略/采纳去重；AI 建议为 taskId:ai:type）
 * - action ≤20字"做什么"；reason"为什么"；effect"会怎样"
 *
 * 建议类型 → 采纳后自动处理（见 pages/index onAdoptSuggestion）：
 * - breakdown / parallel / scope：跳转流程拆解页预填该任务（自动拆解）
 * - focus：确认专注锁定（系统已实现锁定机制）
 * - urge：记录催办事件
 * - delegate / help / outsource：标记为待委派/求助
 * - 其余类型：记录采纳
 */

const IGNORED_KEY = 'po_sug_ignored'
const ADOPTED_KEY = 'po_sug_adopted'
const FEEDBACK_KEY = 'po_sug_feedback'

// 三个日志列表的保留上限（写入时环形裁剪，只留最近 N 条）：
// - ignored 会影响建议是否展示，留宽一些（500 条约 12KB）
// - adopted / feedback 目前只写不读（保留给后续建议质量分析），
//   只需要最近一批，200 条足够
// 不设上限的话，列表会随使用次数无限增长，最终吃掉 Storage 配额。
const IGNORED_MAX = 500
const LOG_MAX = 200

// 建议类型白名单（AI 输出校验 / 采纳动作映射）
const TYPES = [
  'breakdown', 'parallel', 'scope',           // 耗时太长：拆解/并行/砍需求
  'urge', 'prepare', 'backup',                // 等待外部输入：催办/提前准备/预备方案
  'focus', 'delegate', 'postpone',            // 资源不足：专注/委派/延后
  'help', 'learn', 'outsource',               // 技能不足：求助/学习/外包
  'switch', 'start', 'expedite', 'speedup',   // 前置未完成/就绪/阻塞面大/整体偏慢
]

function truncate(str, n) {
  const s = String(str || '')
  return s.length > n ? s.slice(0, n) + '…' : s
}

/* ---------------- 规则引擎 ---------------- */

/**
 * 基于瓶颈特征的规则建议（每卡点最多 2 条）。
 * @param {Object} ctx
 *   - clog：卡点子任务（必传）
 *   - goal：所属大目标（用于锁定判断）
 *   - siblings：同目标下的全部子任务（用于依赖分析）
 *   - tasks：全量任务（依赖可能跨目标时兜底查找）
 * @returns {Array} [{ key, type, action, reason, effect }]
 */
function generateSuggestions(ctx) {
  const { clog, goal, siblings = [], tasks = [] } = ctx || {}
  if (!clog || clog.status === 'completed') return []

  const est = clog.estimatedHours || 0
  const actual = clog.actualHours || 0
  const byId = {}
  siblings.concat(tasks).forEach((t) => {
    if (t && t._id) byId[t._id] = t
  })

  // 未完成的前置任务（阻塞卡点推进）
  const openPrereqs = (clog.dependencies || [])
    .map((d) => byId[d])
    .filter((t) => t && t.status !== 'completed')
  // 被卡点直接阻塞的未完成下游子任务数
  const openDownstream = siblings.filter(
    (s) => s.status !== 'completed' && (s.dependencies || []).indexOf(clog._id) > -1
  )

  const out = []
  const push = (type, action, reason, effect) => {
    out.push({ key: clog._id + ':' + type, type: type, action: action, reason: reason, effect: effect })
  }

  // 规则0：所属大目标被锁定（非全局瓶颈）→ 先攻瓶颈目标（约束理论：唯一焦点）
  if (goal && goal.status === 'locked') {
    push('focus', '先攻瓶颈目标再回来', '同时推进多个目标，效率下降约40%', '瓶颈突破后此卡点自动解锁')
    return out
  }

  // 规则1：严重超时（实际 > 预估 × 1.5）→ 集中攻坚；大任务附带拆解建议
  if (est > 0 && actual > est * 1.5) {
    push('focus', '停下其他事，集中攻它', '实际耗时已超预估一半以上，越拖越堵', '今天内突破卡点，整条链路松开')
    if (est >= 2) {
      push('breakdown', '把它拆成2-3个小步', '大块任务超时多半是粒度太粗', '小步快跑，每步都有完成感')
    }
    return out
  }

  // 规则2：被未完成前置阻塞 → 切换去干前置（干等没有产出）
  if (openPrereqs.length) {
    const name = truncate(openPrereqs[0].title, 8)
    push('switch', '先去做前置「' + name + '」', '卡点被前置挡住，干等没有产出', '前置清掉后，卡点立即可推进')
    return out
  }

  // 规则3：压着 3 个以上后续任务 → 优先处理（避免延误放大）
  if (openDownstream.length >= 3) {
    push('expedite', '把它提到今天第一位', '它压着' + openDownstream.length + '个后续任务，等不起', '避免延误沿流程放大数倍')
    return out
  }

  // 规则4：前置全部就绪、尚未开始 → 立即开始（等待就是浪费）
  if (clog.status !== 'in_progress') {
    push('start', '现在就开始这个卡点', '前置已全部就绪，等待就是浪费', '最慢环节先动，工期立即收缩')
    return out
  }

  // 规则5：各环节正常但整体偏慢 → 固定节奏推进
  push('speedup', '每天固定时段推进它', '各环节正常但整体节奏偏慢', '稳定投入让工期可控不返工')
  return out
}

/* ---------------- 补充情况（用户上下文） ---------------- */

// 补充情况快速标签（多选，最多 3 个）
const CTX_TAGS = ['缺资源', '不会做', '没时间', '等别人', '试过没用', '要求变了', '其他']

// 标签 → 规则建议映射（AI 不可用时的降级：按用户选中的标签给对应策略，最多 2 条）
const CTX_TAG_RULES = {
  缺资源: { type: 'outsource', action: '列出缺的具体资源，找替代或外包', reason: '资源缺口不补上，卡点会一直卡着', effect: '资源到位后可立即恢复推进' },
  不会做: { type: 'help', action: '找做过的人请教一次，比自学快', reason: '不熟悉的方法摸索成本最高', effect: '少走弯路，当天就能开工' },
  没时间: { type: 'delegate', action: '把其他任务让路或委派，给卡点留整块时间', reason: '碎片时间推进不动复杂卡点', effect: '集中精力突破，工期可控' },
  等别人: { type: 'urge', action: '现在就去催，并约定明确回复时间', reason: '干等没有产出，主动催办才有节奏', effect: '拿到回复即可恢复推进' },
  试过没用: { type: 'breakdown', action: '换思路：把卡点拆小，先做能验证的一小步', reason: '老方法重复试意义不大，需要新切入点', effect: '小步验证找到可行路径' },
  要求变了: { type: 'scope', action: '跟需求方重新对齐范围和交付标准', reason: '要求变了还按旧的做只会返工', effect: '对齐后按新要求直接推进' },
  其他: { type: 'focus', action: '写下卡住的具体原因，再定下一步', reason: '模糊的卡点最耗时间，先写清楚', effect: '问题明确后往往就有解法' },
}

/**
 * 基于用户补充标签的规则建议（refineSuggestion 第三层降级）。
 * 按用户选中的标签顺序取对应规则（去重 type，最多 2 条）；
 * 无命中标签时兜底「其他」规则。
 * @param {Object} clog 卡点任务（_id 用于生成稳定 key）
 * @param {Object} userContext { tags, text, version }
 * @returns {Array} [{ key, type, action, reason, effect }]
 */
function generateCtxSuggestions(clog, userContext) {
  if (!clog) return []
  const tags = (userContext && userContext.tags) || []
  const version = (userContext && userContext.version) || 1
  const rules = []
  tags.forEach((tag) => {
    if (CTX_TAG_RULES[tag]) rules.push(CTX_TAG_RULES[tag])
  })
  if (!rules.length) rules.push(CTX_TAG_RULES['其他'])

  const out = []
  rules.slice(0, 2).forEach((r) => {
    if (out.some((x) => x.type === r.type)) return // 同类型只留一条
    out.push({
      key: clog._id + ':ctx' + version + ':' + r.type,
      type: r.type,
      action: r.action,
      reason: r.reason,
      effect: r.effect,
    })
  })
  return out
}

/* ---------------- 存储层（采纳 / 忽略 / 反馈日志） ---------------- */

/**
 * 读取日志列表。
 * 必须校验是否为数组：Storage 里的值可能被历史版本/外部写入成非数组，
 * 而 filterVisible 会对它调 .indexOf() —— 不校验会让 buildGoalView 抛错，
 * 表现为整个首页白屏（只弹一次"任务加载失败"，下拉刷新也救不回来）。
 */
function getList(key) {
  try {
    const v = wx.getStorageSync(key)
    return Array.isArray(v) ? v : []
  } catch (e) {
    return []
  }
}

/** 写入日志列表：环形裁剪到 max 条（只保留最近的一批） */
function setList(key, v, max) {
  try {
    const list = Array.isArray(v) ? v : []
    wx.setStorageSync(key, list.slice(-(max || LOG_MAX)))
  } catch (e) {
    console.warn('[suggestions] 存储写入失败', e)
  }
}

/** 过滤已忽略的建议，最多展示 2 条（不刷屏） */
function filterVisible(suggestions) {
  if (!Array.isArray(suggestions)) return []
  const ignored = getList(IGNORED_KEY)
  return suggestions.filter((s) => ignored.indexOf(s.key) === -1).slice(0, 2)
}

/** 忽略建议：该 key 不再显示（用户自己解决） */
function ignoreKey(key) {
  const list = getList(IGNORED_KEY)
  if (list.indexOf(key) > -1) return
  list.push(key)
  setList(IGNORED_KEY, list, IGNORED_MAX)
}

/** 记录采纳日志（供后续分析哪类建议被采纳得多） */
function recordAdopted(rec) {
  const list = getList(ADOPTED_KEY)
  list.push(Object.assign({ ts: Date.now() }, rec))
  setList(ADOPTED_KEY, list, LOG_MAX)
}

/**
 * 记录建议反馈日志（供后续优化建议质量）。
 * @param {Object} rec { key, type, taskId, taskTitle }
 * @param {boolean} [helpful=false] 有用（true）/ 没帮助（false）
 */
function recordFeedback(rec, helpful) {
  const list = getList(FEEDBACK_KEY)
  list.push(Object.assign({ ts: Date.now(), helpful: helpful === true }, rec))
  setList(FEEDBACK_KEY, list, LOG_MAX)
}

module.exports = {
  TYPES: TYPES,
  CTX_TAGS: CTX_TAGS,
  CTX_TAG_RULES: CTX_TAG_RULES,
  generateSuggestions: generateSuggestions,
  generateCtxSuggestions: generateCtxSuggestions,
  filterVisible: filterVisible,
  ignoreKey: ignoreKey,
  recordAdopted: recordAdopted,
  recordFeedback: recordFeedback,
}
