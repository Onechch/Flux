/**
 * utils/fluctuation.js —— 需求波动 / 牛鞭效应检测（纯逻辑，不依赖 wx、不做 IO）
 *
 * 问题：任务树里"大目标"代表相对稳定的需求，越往下越接近具体做法。
 * 当上游要求基本没变、下游却反复重写时，说明这一层的方案/拆解不稳定，
 * 投入的执行量被反复推翻 —— 这就是供应链里的"牛鞭效应"在个人计划上的对应物。
 *
 * 数据来源（均由 utils/api.js 维护，口径一致）：
 * - modificationCount：该节点"有业务含义"字段的人工修改次数（状态流转不计）
 * - changeLog：变更明细 [{ ts, field, from, to }]（最近 CHANGE_LOG_MAX 条）
 *   注意：日志是环形缓冲，条数达到上限时由它推导的计数是**下界**，
 *   故结果里用 summary.logTruncated 显式标记，避免把下界当成精确值。
 *
 * 四类风险（kind）：
 * - unstable_root  需求源头自身在反复变（根节点高频修改）→ 应回到源头澄清需求
 * - amplified      上游相对稳定、本层反复重写（路径放大比超阈值）→ 拆解口径不稳
 * - burst          窗口期内集中多次变更 → 需求处于动荡期，不宜继续投入
 * - estimate_churn 预估工时被反复调整 → 工作量还没估准
 *
 * 放大比定义（两个都要看，含义不同）：
 * - localAmp(N) = intensity(N) / max(intensity(parent(N)), 1)  本层相对上一层的放大
 * - pathAmp(N)  = intensity(N) / max(intensity(root(N)), 1)     本层相对需求源头的放大
 * 判定用 pathAmp（"相对需求源头放大"才是牛鞭效应要回答的问题），
 * localAmp 作为证据一并返回，便于解释"是哪一跳放大的"。
 *
 * 阈值都是可解释的启发式（不是概率模型）：宁可少报，不制造焦虑。
 */

const cpm = require('./cpm')

const EPS = 1e-6

/** 与 api.js 的 CHANGE_LOG_MAX 保持一致（有单测交叉校验，防止两处漂移） */
const DEFAULT_CHANGE_LOG_MAX = 20

const DEFAULTS = {
  windowDays: 7,          // "近期"窗口（burst 判定用）
  minChanges: 3,          // 变更次数噪声地板：低于它不判 amplified
  ampRatio: 3,            // 路径放大比阈值
  burst: 4,               // 窗口内变更次数阈值
  estimateChurn: 2,       // 预估工时被调整的次数阈值
  rootUnstable: 4,        // 根节点累计变更次数阈值
  maxRisks: 50,           // 风险条目上限（按 score 截断，防页面过长）
}

/** 风险类型中文标签（页面与云函数共用，避免文案漂移） */
const RISK_KIND_LABELS = {
  unstable_root: '需求源头反复变更',
  amplified: '计划被放大',
  burst: '近期集中变更',
  estimate_churn: '工时估算反复调整',
}

/** 风险类型排序权重（同类证据下，源头问题优先于执行层问题） */
const RISK_KIND_BONUS = {
  unstable_root: 40,
  amplified: 30,
  burst: 20,
  estimate_churn: 10,
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10
}

/** 归一化单个任务（容忍脏数据；无 _id 的节点无法建树，调用方会丢弃） */
function normalizeTask(t) {
  const src = t && typeof t === 'object' ? t : {}
  return {
    _id: src._id === undefined || src._id === null ? '' : String(src._id),
    title: typeof src.title === 'string' ? src.title : '',
    estimatedHours: Number(src.estimatedHours) || 0,
    status: src.status || 'pending',
    parentGoalId: src.parentGoalId ? String(src.parentGoalId) : '',
    modificationCount: Number(src.modificationCount) || 0,
    createdAt: Number(src.createdAt) || 0,
    updatedAt: Number(src.updatedAt) || 0,
    dependencies: Array.isArray(src.dependencies) ? src.dependencies.slice() : [],
    changeLog: Array.isArray(src.changeLog) ? src.changeLog : [],
  }
}

/**
 * 扁平任务列表 → 森林（含环与悬挂引用的兜底）。
 * 兜底规则：
 * - 无 _id 的节点丢弃（无法被引用）；重复 _id 只保留首个
 * - parentGoalId 指向不存在的节点 → 视为根（不丢节点）
 * - 自环（自己是自己的父）→ 视为根
 * - 成环（a→b→a，无任何根可达）→ 断开该节点的父边、提为根并标 _cyclic
 * 同时回填：children / _parent / _rootId / depth / depTitles（同层依赖名）
 */
function buildForest(tasks) {
  const nodes = {}
  const ids = []
  const list = Array.isArray(tasks) ? tasks : []
  list.forEach((raw) => {
    const t = normalizeTask(raw)
    if (!t._id || nodes[t._id]) return
    t.children = []
    t._parent = ''
    t._rootId = t._id
    t.depth = 0
    t.depTitles = []
    t._cyclic = false
    nodes[t._id] = t
    ids.push(t._id)
  })

  const roots = []
  ids.forEach((id) => {
    const n = nodes[id]
    const pid = n.parentGoalId
    if (pid && pid !== id && nodes[pid]) {
      n._parent = pid
      nodes[pid].children.push(n)
    } else {
      roots.push(n)
    }
  })

  // 可达性标记（从根出发），用于识别成环导致不可达的节点
  const reached = {}
  function mark(nodeList) {
    nodeList.forEach((n) => {
      if (reached[n._id]) return
      reached[n._id] = true
      mark(n.children)
    })
  }
  mark(roots)

  // 成环兜底：不可达节点断开父边提为根（保证每个节点都被分析到）
  ids.forEach((id) => {
    if (reached[id]) return
    const n = nodes[id]
    const p = n._parent ? nodes[n._parent] : null
    if (p) {
      const i = p.children.indexOf(n)
      if (i > -1) p.children.splice(i, 1)
    }
    n._parent = ''
    n._cyclic = true
    roots.push(n)
    mark([n])
  })

  // depth 与 rootId
  function walk(nodeList, depth, rootId) {
    nodeList.forEach((n) => {
      n.depth = depth
      n._rootId = rootId
      walk(n.children, depth + 1, rootId)
    })
  }
  roots.forEach((r) => walk([r], 0, r._id))

  // 同层依赖：_id → 同层任务名（与 tree.buildTreeFromTasks 口径一致，仅同层可依赖）
  ids.forEach((id) => {
    const n = nodes[id]
    const siblings = n._parent ? nodes[n._parent].children : roots
    const idToTitle = {}
    siblings.forEach((s) => {
      idToTitle[s._id] = s.title
    })
    n.depTitles = n.dependencies
      .map((d) => idToTitle[d])
      .filter((t) => !!t && t !== n.title)
  })

  return { nodes: nodes, ids: ids, roots: roots }
}

/** 只接受真正的数字（null/''/布尔/数字字符串都不算，避免 Number(null)=0 污染幅度计算） */
function numericOf(v) {
  return typeof v === 'number' && isFinite(v) ? v : null
}

/** 单节点指标 */
function metricsOf(node, now, windowMs) {
  const log = node.changeLog
  let estimateChanges = 0
  let recentChanges = 0
  let firstChangeAt = 0
  let lastChangeAt = 0
  const estimateValues = []
  log.forEach((e) => {
    if (!e || typeof e !== 'object') return
    const ts = Number(e.ts) || 0
    if (ts) {
      if (!firstChangeAt || ts < firstChangeAt) firstChangeAt = ts
      if (ts > lastChangeAt) lastChangeAt = ts
      if (ts >= now - windowMs) recentChanges++
    }
    if (e.field === 'estimatedHours') {
      estimateChanges++
      // 幅度 = 历史估算值的极差：同时收集 from 与 to，
      // 才能覆盖"第一次估算"到"最新估算"的全区间（只收 to 会漏掉起点）
      const from = numericOf(e.from)
      const to = numericOf(e.to)
      if (from !== null) estimateValues.push(from)
      if (to !== null) estimateValues.push(to)
    }
  })
  let estimateSpread = 0
  if (estimateValues.length >= 2) {
    estimateSpread = round1(Math.max.apply(null, estimateValues) - Math.min.apply(null, estimateValues))
  }
  return {
    ownChanges: node.modificationCount,
    recentChanges: recentChanges,
    estimateChanges: estimateChanges,
    estimateSpread: estimateSpread,
    logCount: log.length,
    firstChangeAt: firstChangeAt,
    lastChangeAt: lastChangeAt,
    subtreeChanges: node.modificationCount,
    subtreeNodes: 1,
  }
}

/** 自底向上聚合子树指标 */
function aggregate(node, metrics) {
  let changes = metrics[node._id].ownChanges
  let count = 1
  node.children.forEach((c) => {
    const sub = aggregate(c, metrics)
    changes += sub.changes
    count += sub.count
  })
  metrics[node._id].subtreeChanges = changes
  metrics[node._id].subtreeNodes = count
  return { changes: changes, count: count }
}

/**
 * 风险判定（每条风险都带结构化 evidence，便于页面解释"为什么判它"）
 */
function detectRisks(forest, metrics, opts) {
  const risks = []
  forest.ids.forEach((id) => {
    const node = forest.nodes[id]
    const m = metrics[id]
    const isRoot = !node._parent
    const parentM = node._parent ? metrics[node._parent] : null
    const rootM = metrics[node._rootId] || m
    const rootNode = forest.nodes[node._rootId] || node
    const pathAmp = round1(m.ownChanges / Math.max(rootM.ownChanges, 1) * 100) / 100
    const localAmp = round1(m.ownChanges / Math.max(parentM ? parentM.ownChanges : 0, 1) * 100) / 100
    const base = {
      taskId: id,
      title: node.title,
      depth: node.depth,
      isRoot: isRoot,
      goalId: node._rootId,
      goalTitle: rootNode.title,
      ownChanges: m.ownChanges,
      // 放大比的分母（页面直接展示"本层 N 次 / 源头 M 次"，无需再查一次数据）
      rootChanges: rootM.ownChanges,
      parentChanges: parentM ? parentM.ownChanges : 0,
      subtreeChanges: m.subtreeChanges,
      subtreeNodes: m.subtreeNodes,
      recentChanges: m.recentChanges,
      estimateChanges: m.estimateChanges,
      estimateSpread: m.estimateSpread,
      pathAmp: pathAmp,
      localAmp: localAmp,
      cyclic: node._cyclic,
    }

    // R1 需求源头自身在反复变（仅根节点；与 burst 互斥 —— 同一件事用更贴切的标签说一次）
    const rootUnstable = isRoot && m.ownChanges >= opts.rootUnstable
    if (rootUnstable) {
      risks.push(
        Object.assign({}, base, {
          kind: 'unstable_root',
          score: m.ownChanges * 10 + RISK_KIND_BONUS.unstable_root,
          message:
            '大目标「' + node.title + '」自身被修改 ' + m.ownChanges + ' 次：需求源头还在变，' +
            '此时下游任何排期都会被推翻。',
          advice: '先把目标边界定下来（写成一句话 + 明确的完成标准），再往下拆；期间不要开工。',
        })
      )
    }

    // R2 计划被放大：上游（需求源头）相对稳定，本层却反复重写
    if (!isRoot && m.ownChanges >= opts.minChanges && pathAmp >= opts.ampRatio) {
      risks.push(
        Object.assign({}, base, {
          kind: 'amplified',
          score: m.ownChanges * 10 + Math.min(Math.round(pathAmp * 10), 100) + RISK_KIND_BONUS.amplified,
          message:
            '「' + node.title + '」被修改 ' + m.ownChanges + ' 次，是需求源头「' + rootNode.title +
            '」（' + rootM.ownChanges + ' 次）的 ' + pathAmp + ' 倍：上游没变，这一层的做法在反复重写。',
          advice: '问题多半出在拆解粒度：把反复变的那部分单独下钻一层，让"稳定的"和"还在试的"分开排期。',
        })
      )
    }

    // R3 近期集中变更（需求动荡期）；根节点的"近期反复变"已由 R1 表达，不重复报
    if (!rootUnstable && m.recentChanges >= opts.burst) {
      risks.push(
        Object.assign({}, base, {
          kind: 'burst',
          score: m.ownChanges * 10 + m.recentChanges * 5 + RISK_KIND_BONUS.burst,
          message:
            '「' + node.title + '」最近 ' + opts.windowDays + ' 天内被修改 ' + m.recentChanges +
            ' 次：需求正处于动荡期。',
          advice: '暂缓执行。先把还在变的那一项确定下来（在首页补充情况里写清楚约束），再重新排期。',
        })
      )
    }

    // R4 工时估算反复调整（工作量没估准）
    if (m.estimateChanges >= opts.estimateChurn) {
      risks.push(
        Object.assign({}, base, {
          kind: 'estimate_churn',
          score: m.ownChanges * 10 + m.estimateChanges * 5 + RISK_KIND_BONUS.estimate_churn,
          message:
            '「' + node.title + '」的预估工时被调整 ' + m.estimateChanges + ' 次' +
            (m.estimateSpread > 0 ? '（幅度 ' + m.estimateSpread + 'h）' : '') +
            '，当前 ' + round1(node.estimatedHours) + 'h：这项工作的工作量还没估准。',
          advice: '先用最小可验证的一步（≤1h 的原型/试跑）把不确定性打掉，再回头估整体工时。',
        })
      )
    }
  })

  risks.sort((a, b) => b.score - a.score || b.ownChanges - a.ownChanges || a.taskId.localeCompare(b.taskId))
  return risks
}

/**
 * 波动分析主入口。
 * @param {Array} tasks 扁平任务列表（api.loadTasks() 的返回即可）
 * @param {Object} [options] { now, windowDays, minChanges, ampRatio, burst,
 *                             estimateChurn, rootUnstable, maxRisks, changeLogMax }
 * @returns {Object} {
 *   generatedAt, windowDays, thresholds,
 *   summary: { taskCount, goalCount, totalChanges, recentChanges, riskCount,
 *              byKind, topRisk, logTruncated },
 *   goals:   [ { goalId, title, ownChanges, subtreeChanges, subtreeNodes,
 *                riskCount, totalHours, hotNodes } ],
 *   byDepth: [ { depth, nodes, changes } ],
 *   metrics: [ 每个节点的指标（按 ownChanges 降序） ],
 *   risks:   [ 风险条目（按 score 降序） ]
 * }
 */
function analyzeFluctuation(tasks, options) {
  const o = Object.assign({}, DEFAULTS, options || {})
  const now = Number(o.now) || Date.now()
  const windowMs = Math.max(1, o.windowDays) * 24 * 3600 * 1000
  const changeLogMax = Number(o.changeLogMax) || DEFAULT_CHANGE_LOG_MAX

  const forest = buildForest(tasks)
  const metrics = {}
  forest.ids.forEach((id) => {
    metrics[id] = metricsOf(forest.nodes[id], now, windowMs)
  })
  forest.roots.forEach((r) => aggregate(r, metrics))

  const risks = detectRisks(forest, metrics, o)

  // 按目标聚合
  const goals = []
  const goalRiskCount = {}
  risks.forEach((r) => {
    goalRiskCount[r.goalId] = (goalRiskCount[r.goalId] || 0) + 1
  })
  forest.roots.forEach((r) => {
    const m = metrics[r._id]
    // 变更最集中的后代节点（含自身），供页面直接展示"热区"
    const hot = []
    ;(function collect(n) {
      hot.push({ taskId: n._id, title: n.title, depth: n.depth, ownChanges: metrics[n._id].ownChanges })
      n.children.forEach(collect)
    })(r)
    hot.sort((a, b) => b.ownChanges - a.ownChanges || a.depth - b.depth || a.taskId.localeCompare(b.taskId))
    goals.push({
      goalId: r._id,
      title: r.title,
      ownChanges: m.ownChanges,
      subtreeChanges: m.subtreeChanges,
      subtreeNodes: m.subtreeNodes,
      riskCount: goalRiskCount[r._id] || 0,
      totalHours: round1(computeSubtreeHours(r)),
      hotNodes: hot.filter((h) => h.ownChanges > 0).slice(0, 3),
    })
  })
  goals.sort((a, b) => b.subtreeChanges - a.subtreeChanges || a.goalId.localeCompare(b.goalId))

  // 按层级聚合（页面用条形展示"变更集中在哪一层"）
  const depthMap = {}
  forest.ids.forEach((id) => {
    const d = forest.nodes[id].depth
    if (!depthMap[d]) depthMap[d] = { depth: d, nodes: 0, changes: 0 }
    depthMap[d].nodes++
    depthMap[d].changes += metrics[id].ownChanges
  })
  const byDepth = Object.keys(depthMap)
    .map((k) => depthMap[k])
    .sort((a, b) => a.depth - b.depth)

  const rows = forest.ids
    .map((id) => {
      const n = forest.nodes[id]
      return Object.assign(
        {
          taskId: id,
          title: n.title,
          depth: n.depth,
          goalId: n._rootId,
          isRoot: !n._parent,
          cyclic: n._cyclic,
          estimatedHours: round1(n.estimatedHours),
        },
        metrics[id]
      )
    })
    .sort((a, b) => b.ownChanges - a.ownChanges || a.depth - b.depth || a.taskId.localeCompare(b.taskId))

  const byKind = {}
  Object.keys(RISK_KIND_LABELS).forEach((k) => {
    byKind[k] = 0
  })
  risks.forEach((r) => {
    byKind[r.kind] = (byKind[r.kind] || 0) + 1
  })

  const totalChanges = forest.ids.reduce((s, id) => s + metrics[id].ownChanges, 0)
  const recentChanges = forest.ids.reduce((s, id) => s + metrics[id].recentChanges, 0)
  const logTruncated = forest.ids.some((id) => metrics[id].logCount >= changeLogMax)

  const limited = risks.slice(0, Math.max(1, o.maxRisks))

  return {
    generatedAt: now,
    windowDays: o.windowDays,
    thresholds: {
      minChanges: o.minChanges,
      ampRatio: o.ampRatio,
      burst: o.burst,
      estimateChurn: o.estimateChurn,
      rootUnstable: o.rootUnstable,
    },
    summary: {
      taskCount: forest.ids.length,
      goalCount: forest.roots.length,
      totalChanges: totalChanges,
      recentChanges: recentChanges,
      riskCount: risks.length,
      byKind: byKind,
      topRisk: limited.length ? limited[0] : null,
      // true 表示存在 changeLog 已达上限的节点 → 由日志推导的计数是下界
      logTruncated: logTruncated,
    },
    goals: goals,
    byDepth: byDepth,
    metrics: rows,
    risks: limited,
  }
}

/** 子树总工作量（叶子耗时求和；父节点耗时按不变式应为子合计） */
function computeSubtreeHours(node) {
  if (!node.children || !node.children.length) return Number(node.estimatedHours) || 0
  return node.children.reduce((s, c) => s + computeSubtreeHours(c), 0)
}

/**
 * 重新排期方案（纯计算，不写库）。
 *
 * 不变式：「父节点耗时 = 直接子任务耗时合计」（normalizeNode / resumHours 同口径）。
 * 用户在首页或拆解页直接改叶子耗时后，上层节点的存量值会变陈旧，
 * 表现为"大目标显示的总工时与子任务对不上"，进而让瓶颈识别与工期判断失真。
 * 本函数自底向上重算目标子树，返回需要写库的修正项，交由页面执行
 * （写库时必须 countModification:false —— 重新排期是系统行为，不能计入波动数据）。
 *
 * @param {Array} tasks 扁平任务列表
 * @param {string} goalId 大目标 _id
 * @returns {Object} {
 *   ok, reason?, goalId, title, totalHours,
 *   updates: [ { taskId, title, depth, from, to } ],
 *   layers:  [ { depth, parentId, parentTitle, layerHours, criticalPath } ]
 * }
 */
function planReschedule(tasks, goalId) {
  const forest = buildForest(tasks)
  const goal = forest.nodes[goalId]
  if (!goal) {
    return { ok: false, reason: '目标不存在或已被删除', goalId: goalId, updates: [], layers: [], totalHours: 0 }
  }
  const updates = []
  const layers = []

  function walk(node) {
    let sum = 0
    node.children.forEach((c) => {
      sum += walk(c)
    })
    if (!node.children.length) return Number(node.estimatedHours) || 0

    const expected = round1(sum)
    const current = round1(node.estimatedHours)
    if (Math.abs(current - expected) > EPS) {
      updates.push({ taskId: node._id, title: node.title, depth: node.depth, from: current, to: expected })
    }
    // 该层关键路径（同层依赖）：让用户看到"重排后哪条链最长"
    const res = cpm.calculateCriticalPath(
      node.children.map((c) => ({
        name: c.title,
        estimatedHours: c.estimatedHours || 0,
        dependencies: c.depTitles || [],
      }))
    )
    layers.push({
      depth: node.depth + 1,
      parentId: node._id,
      parentTitle: node.title,
      layerHours: res.totalDuration,
      criticalPath: res.criticalPath,
    })
    return expected
  }

  const totalHours = round1(walk(goal))
  layers.sort((a, b) => a.depth - b.depth || a.parentId.localeCompare(b.parentId))
  updates.sort((a, b) => a.depth - b.depth || a.taskId.localeCompare(b.taskId))

  return {
    ok: true,
    goalId: goal._id,
    title: goal.title,
    totalHours: totalHours,
    updates: updates,
    layers: layers,
  }
}

/** 风险类型中文标签（未知类型回退原值） */
function riskKindLabel(kind) {
  return RISK_KIND_LABELS[kind] || String(kind || '')
}

module.exports = {
  DEFAULT_CHANGE_LOG_MAX,
  DEFAULTS,
  RISK_KIND_LABELS,
  RISK_KIND_BONUS,
  normalizeTask,
  buildForest,
  analyzeFluctuation,
  planReschedule,
  riskKindLabel,
}
