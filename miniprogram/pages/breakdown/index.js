// pages/breakdown/index.js —— 流程拆解页（批量识别 + 多层级树拆解 + 对话调优）
//
// 工作流：
// 0. 批量识别：一段自然语言 → 三层降级识别独立目标列表（依赖关系优先：
//    A 是 B 的前置条件、或多个任务指向同一交付物 → 合并为一个目标）
//    层1 客户端直调 ai.parseGoals（提示词引导合并 + postProcessGoals 依赖兜底合并）
//    层2 云函数 parseGoals（服务端 AI + 规则切分降级，同样带依赖合并后处理）
//    层3 客户端规则切分 + ai.postProcessGoals 依赖合并
//    每个目标带 suggestedDepth（建议拆解深度 1-4），拆解时作为深度提示传给 AI
//    单目标 → 透明进入单目标拆解；多目标 → 确认阶段（可编辑）→ 批量拆解
// 1. 生成初稿（多层级任务树）：层级深度由目标复杂度自适应（1-5 层），
//    拆到"可执行"和"卡点暴露"为止；归一化强制 ≤5 层 / 每节点 ≤8 子 / 全树 ≤40 节点
//    层1 客户端直调 ai.breakdownGoal（返回任务树）
//    层2 云函数 breakdownTask（返回任务树，内部自带预设降级）
//    层3 预设两层树 + 预设信息缺口（AI 全链路不可用）
//    批量模式：前端串行逐个调用 requestBreakdown（AI 串行队列硬约束）
//    渲染：utils/tree.js computeTreeMeta（每层 CPM + 每层瓶颈 + 卡点链）
//    → flattenForDisplay 拍平为缩进列表（WXML 单层 wx:for），预览默认全展开、可点击折叠
// 2. 对话调优：反馈 → 三层降级获取新版任务树 + 调整说明
//    层1 客户端直调 ai.refineTasks（传 toAITree 剥离后的干净树）
//    层2 云函数 refineTask（服务端 AI + 规则降级）
//    层3 utils/tree.js ruleRefineTree（正则意图：删除/增加/改耗时，递归作用整树）
// 3. 采纳导入：确认弹窗 → utils/tree.js importTreeToDb 递归导入首页
//    （大目标 level 0 + 各层子任务 level 1..5 + 同层依赖回填）
//    批量模式：逐个采纳 / 全部采纳（串行共享去重映射）
// 4. 已有目标调优（首页"✨ AI调优"入口）：buildTreeFromTasks 从 DB 重建任务树
//    载入调优 → syncTreeToDb 差异同步（新增/更新/递归删除，已完成子任务保留）
//
// 卡点链展示：computeTreeMeta 的 chain = 每层瓶颈逐层向下（目标→阶段→子任务→步骤），
// 最深者即"当前具体卡点"（红色高亮），各层瓶颈橙色高亮。
//
// MVP 边界：不做拖拽调整层级、甘特图、实时流式输出、初稿云端持久化。

const cpm = require('../../utils/cpm')
const api = require('../../utils/api')
const ai = require('../../utils/ai')
const treeUtils = require('../../utils/tree')
const knowledge = require('../../utils/knowledge')

// 第三层降级：预设两层树（与云函数 breakdownTask 的 FALLBACK_CHILDREN 保持一致）
const FALLBACK_CHILDREN = [
  { title: '明确目标范围', estimatedHours: 1, dependencies: [], isExecutable: true },
  { title: '收集资料', estimatedHours: 2, dependencies: ['明确目标范围'], isExecutable: true },
  { title: '撰写初稿', estimatedHours: 4, dependencies: ['收集资料'], isExecutable: true },
  { title: '修改完善', estimatedHours: 2, dependencies: ['撰写初稿'], isExecutable: true },
  { title: '最终审核', estimatedHours: 1, dependencies: ['修改完善'], isExecutable: true },
]

// 本地降级时的预设信息缺口（与云函数 breakdownTask 保持一致）
const PRESET_INFO_GAPS = [
  '是否有固定的截止日期？',
  '是否有可用的数据或模板？',
  '是否有其他人员配合？',
]

// 批量拆解两级时间预算（防止通道慢/挂起时批量循环无上界，表现为"一直正在拆解"）：
// - 单目标层1 AI 预算 35s：覆盖 3 入口×2 方法最坏情形的前几个尝试，超时走降级
// - 整批总预算 90s：耗尽后剩余目标直接预设降级，保证必然收敛
const GOAL_AI_BUDGET_MS = 35 * 1000
const BATCH_TOTAL_BUDGET_MS = 90 * 1000

/**
 * 规则切分降级（层3）：按强标记把一段自然语言切分为独立目标。
 * 与云函数 parseGoals 的 ruleParseGoals 保持一致（与 AI 提示词"依赖关系优先合并"对齐）：
 * - 切分标记：枚举（第N、数字列表 1. / 1、）、并列连接词（另外/还有/还要/以及/同时/再者）
 *   —— 并列词指向不同交付物，切分
 * - 顺序词（首先/其次/然后/接着/最后）不切分
 *   —— 顺序词通常是同一目标的步骤，保守合并不切
 * - 首个标记前的内容：以冒号结尾视为开场白丢弃，否则作为第一个目标
 * - 无任何强标记时保守视为单目标（避免逗号误切）
 * - 标题 = 段落首个软标点前的内容（≤20字），其余作为补充描述
 * - suggestedDepth：内容越长结构越可能复杂（无法语义判断，保守给 2/3）
 * 切分结果再经 ai.postProcessGoals 按依赖关系合并相邻目标（见 requestParseGoals）
 */
function ruleParseGoals(text) {
  const msg = String(text || '').trim()
  if (!msg) return { goals: [], summary: '' }

  const markerRe =
    /第[一二三四五六七八九十\d]+\s*[，,、.．:：]?|(?:^|[，,。；;：:\s])(?:另外|还有|还要|以及|同时|再者)|(?:^|[，,。；;\s])\d+\s*[.、）)]/g

  const points = []
  let m
  while ((m = markerRe.exec(msg)) !== null) {
    points.push({ start: m.index, end: m.index + m[0].length })
  }

  const segments = []
  if (points.length) {
    // 首个标记前的内容视为开场白丢弃的条件（两种冒号形态都覆盖）：
    // - 顺序词分支消耗了冒号（如"下周计划：首先…"）→ 标记以冒号开头
    // - 第N分支不消耗冒号（如"我下周要做几件事：第一，…"）→ 冒号留在前缀末尾
    // 否则是实质内容（如"完成PPT，还要整理绩效"的第一个目标），保留
    const preamble = msg.slice(0, points[0].start).trim()
    const startsWithColon = /^[：:]/.test(msg.slice(points[0].start))
    if (preamble && !startsWithColon && !/[：:]$/.test(preamble) && preamble.length >= 2) {
      segments.push(preamble)
    }
    for (let i = 0; i < points.length; i++) {
      const from = points[i].end
      const to = i + 1 < points.length ? points[i + 1].start : msg.length
      const seg = msg.slice(from, to).replace(/^[，,。；;、\s]+|[，,。；;\s]+$/g, '')
      if (seg) segments.push(seg)
    }
  }
  if (!segments.length) segments.push(msg)

  const goals = segments.slice(0, 8).map((seg) => {
    // 标题 = 首个软标点前的内容；其余为补充描述
    const soft = seg.split(/[，,。；;：:]/)
    const head = (soft[0] || '').trim()
    const title = (head || seg).slice(0, 20)
    const description = head
      ? seg.slice(head.length).replace(/^[，,。；;：:\s]+/, '').slice(0, 60)
      : ''
    return {
      title: title,
      description: description,
      complexity: seg.length >= 12 || description ? 'complex' : 'simple',
      // 规则切分默认深度：内容越长结构越可能复杂（无法语义判断，保守给 2/3）
      suggestedDepth: seg.length >= 30 ? 3 : 2,
      reason: '规则切分（AI 不可用）',
    }
  })

  return {
    goals: goals,
    summary:
      goals.length > 1
        ? '识别到 ' + goals.length + ' 个目标（规则切分，请确认）'
        : '识别到 1 个目标',
  }
}

Page({
  data: {
    goal: '',             // 用户输入的目标
    tree: null,           // 当前任务树（utils/tree.js 归一化结构）
    treeRows: [],         // 拍平显示行（缩进 + 展开/折叠 + 卡点/瓶颈/关键路径标记）
    expandedMap: {},      // 展开集合 { key: true }（预览默认全展开）
    criticalPathText: '', // 第一层关键路径链文本（A → B → C）
    totalDuration: 0,     // 第一层关键路径总工期（小时）
    clogInfo: null,       // 卡点链摘要 { title, hint, chainText }
    isLoading: false,     // 拆解中（AI 调用限流：防重复点击）
    hasResult: false,     // 是否已有拆解结果
    importing: false,     // 导入中（防重复点击）
    aiFallback: false,    // 是否使用了降级示例数据
    // ---- 初稿 + 对话调优 ----
    infoGaps: [],             // 信息缺口提示 [string]
    feedback: '',             // 用户反馈输入
    refining: false,          // 调整中（防重复点击）
    adjustments: [],          // 调整记录 [{ key, text }]（仅当前会话）
    draftCount: 1,            // 初稿为第 1 版，每次调优 +1
    editing: false,           // 是否为"已有目标调优"模式（差异同步回首页）
    editingGoalId: '',        // 调优模式对应的首页大目标 _id
    editingGoalTitle: '',     // 载入时的目标名（判断用户是否改写了目标）
    // ---- 批量目标模式（识别 → 确认 → 批量拆解 → 逐个/全部采纳） ----
    batchStage: '',           // '' 单目标模式 | 'confirm' 目标确认 | 'results' 批量结果
    parsing: false,           // 目标识别中（parseGoals 三层降级）
    parsedGoals: [],          // 确认阶段目标列表（可编辑）[{ key, title, description, complexity, suggestedDepth, reason }]
    batchLoading: false,      // 批量拆解中（串行逐个，遵守 AI 串行队列约束）
    batchProgress: '',        // 拆解进度文案 "正在拆解 2/3：xxx"
    batchResults: [],         // 每目标拆解结果 [{ key, title, description, tree, treeRows,
                              //   expandedMap, clogInfo, totalDuration, criticalPathText,
                              //   aiFallback, pending, adopted, adopting, feedback, refining, adjustments }]
    batchDoneCount: 0,        // 已拆解完成的目标数（含降级；头部统计用，不含排队占位）
    batchActiveIndex: -1,     // 当前正在拆解的目标下标（-1 = 无；区分"正在拆解"与"排队等待"）
    adoptingAll: false,       // 全部采纳中（防重复点击）
  },

  onShow() {
    // 接收首页"✨ AI调优"入口：载入已有目标进入对话调优模式
    try {
      const refineId = wx.getStorageSync('po_pending_refine')
      if (refineId) {
        wx.removeStorageSync('po_pending_refine')
        // 退出批量模式（单目标调优与批量模式互斥）
        this.setData({
          batchStage: '',
          parsedGoals: [],
          batchResults: [],
          batchProgress: '',
          batchDoneCount: 0,
          batchActiveIndex: -1,
        })
        this.loadExistingGoal(String(refineId))
        return
      }
    } catch (e) {
      console.warn('[breakdown] 读取待调优目标失败', e)
    }
    // 接收首页"采纳拆解建议"的预填任务（storage 传递，tabBar 页无法带参数跳转）
    try {
      const pending = wx.getStorageSync('po_pending_breakdown')
      if (pending) {
        wx.removeStorageSync('po_pending_breakdown')
        // 新目标预填：清空上一轮初稿与批量状态，避免误导入
        this.setData({
          goal: String(pending),
          tree: null,
          treeRows: [],
          expandedMap: {},
          hasResult: false,
          aiFallback: false,
          clogInfo: null,
          infoGaps: [],
          feedback: '',
          adjustments: [],
          draftCount: 1,
          editing: false,
          editingGoalId: '',
          editingGoalTitle: '',
          batchStage: '',
          parsedGoals: [],
          batchResults: [],
          batchProgress: '',
          batchDoneCount: 0,
          batchActiveIndex: -1,
        })
        wx.showToast({ title: '已填入任务，点击智能识别与拆解', icon: 'none', duration: 2000 })
      }
    } catch (e) {
      console.warn('[breakdown] 读取预填任务失败', e)
    }
  },

  onGoalInput(e) {
    this.setData({ goal: e.detail.value })
  },

  /* ---------------- 树视图构建（拆解结果统一渲染入口） ---------------- */

  /**
   * 任务树 → 页面视图：每层 CPM + 每层瓶颈 + 卡点链 + 拍平行 + 第一层关键路径。
   * 预览场景默认全展开（节点 ≤40，方便审阅整个结构）；首页才用"展开到卡点"策略。
   */
  buildTreeView(goalTree) {
    const meta = treeUtils.computeTreeMeta(goalTree)
    const expandedMap = treeUtils.collectKeys(meta.tree)
    const rows = treeUtils.flattenForDisplay(meta.tree, expandedMap)
    // 第一层关键路径（根 → 一级子任务，整体工期口径）
    const rootCpm = cpm.calculateCriticalPath(
      (meta.tree.children || []).map((c) => ({
        name: c.title,
        estimatedHours: c.estimatedHours,
        dependencies: c.dependencies,
      }))
    )
    const chain = meta.chain
    const clogInfo = chain.length
      ? {
          title: meta.clog.title,
          hint: meta.clog.aiHint || '各层瓶颈中最具体的环节，建议立即从它入手',
          chainText: chain.map((n) => n.title).join(' → '),
        }
      : null
    return {
      tree: meta.tree,
      rows: rows,
      expandedMap: expandedMap,
      totalDuration: rootCpm.totalDuration,
      criticalPathText: rootCpm.criticalPath.join(' → '),
      clogInfo: clogInfo,
    }
  },

  /** 树视图写入页面（单目标模式） */
  applyTreeView(goalTree, extra) {
    const view = this.buildTreeView(goalTree)
    this.setData(
      Object.assign(
        {
          tree: view.tree,
          treeRows: view.rows,
          expandedMap: view.expandedMap,
          totalDuration: view.totalDuration,
          criticalPathText: view.criticalPathText,
          clogInfo: view.clogInfo,
          hasResult: true,
        },
        extra || {}
      )
    )
  },

  /**
   * 树视图写入批量结果卡片。
   * 注意：extra 中的键会统一挂到 `batchResults[idx]` 下（如 pending/aiFallback/
   * feedback/adjustments），不能直接把 extra 合并到顶层 —— 否则写的是页面级同名字段，
   * 卡片自身的 pending 永远清不掉（表现为拆解完成后仍显示"正在拆解…"）。
   */
  applyBatchTreeView(idx, goalTree, extra) {
    const view = this.buildTreeView(goalTree)
    const patch = {
      ['batchResults[' + idx + '].tree']: view.tree,
      ['batchResults[' + idx + '].treeRows']: view.rows,
      ['batchResults[' + idx + '].expandedMap']: view.expandedMap,
      ['batchResults[' + idx + '].totalDuration']: view.totalDuration,
      ['batchResults[' + idx + '].criticalPathText']: view.criticalPathText,
      ['batchResults[' + idx + '].clogInfo']: view.clogInfo,
    }
    Object.keys(extra || {}).forEach((k) => {
      patch['batchResults[' + idx + '].' + k] = extra[k]
    })
    this.setData(patch)
  },

  /** 展开/折叠树节点（预览树与批量卡片共用；叶子节点无下级，忽略点击） */
  toggleTreeNode(e) {
    const key = e.currentTarget.dataset.key
    if (!key || !e.currentTarget.dataset.has) return
    const idx = e.currentTarget.dataset.index
    if (idx !== undefined && idx !== null && this.data.batchStage === 'results') {
      const item = this.data.batchResults[idx]
      if (!item || !item.tree) return
      const map = Object.assign({}, item.expandedMap)
      if (map[key]) delete map[key]
      else map[key] = true
      this.setData({
        ['batchResults[' + idx + '].expandedMap']: map,
        ['batchResults[' + idx + '].treeRows']: treeUtils.flattenForDisplay(item.tree, map),
      })
      return
    }
    if (!this.data.tree) return
    const map = Object.assign({}, this.data.expandedMap)
    if (map[key]) delete map[key]
    else map[key] = true
    this.setData({
      expandedMap: map,
      treeRows: treeUtils.flattenForDisplay(this.data.tree, map),
    })
  },

  /** 统计树节点总数（含根，导入确认弹窗文案用） */
  countNodes(goalTree) {
    let n = 0
    ;(function walk(node) {
      n++
      ;(node.children || []).forEach(walk)
    })(goalTree)
    return n
  },

  /**
   * 智能拆解（生成初稿）：获取任务树 → 每层CPM+卡点链 → 渲染。
   * 可传入 breakdownText（批量识别出的"目标+补充描述"）与 depthHint（建议深度）。
   */
  async handleBreakdown(breakdownText, depthHint) {
    if (this.data.isLoading) return // AI 调用限流
    const goal = String(breakdownText || this.data.goal || '').trim()
    if (!goal) {
      wx.showToast({ title: '请输入目标', icon: 'none' })
      return
    }
    // 手动重新拆解：目标名被改写则退出调优模式（回到"新拆解导入"流程）
    if (this.data.editing && goal !== this.data.editingGoalTitle) {
      this.setData({ editing: false, editingGoalId: '', editingGoalTitle: '' })
    }
    this.setData({ isLoading: true })
    try {
      const draft = await this.requestBreakdown(goal, depthHint)
      if (!draft.goal || !draft.goal.children || !draft.goal.children.length) {
        throw new Error('拆解结果为空')
      }
      this.applyTreeView(draft.goal, {
        aiFallback: draft.source === 'fallback',
        infoGaps: draft.infoGaps || [],
        feedback: '',
        adjustments: [],
        draftCount: 1,
      })
      if (draft.source === 'fallback') {
        wx.showToast({
          title:
            draft.reason === 'rate-limit'
              ? 'AI 限流中，请稍等片刻重试，已显示示例数据'
              : 'AI 服务不可用，已使用示例数据',
          icon: 'none',
          duration: 2500,
        })
      }
    } catch (e) {
      console.error('[breakdown] 拆解失败', e)
      wx.showToast({ title: '拆解失败，请重试', icon: 'none' })
    } finally {
      this.setData({ isLoading: false })
    }
  },

  /** 构建本地降级两层树（AI 全链路不可用时的示例数据） */
  buildFallbackTree(goal) {
    const stats = { count: 0 }
    return treeUtils.normalizeNode(
      {
        title: goal.slice(0, 30),
        estimatedHours: 10,
        children: FALLBACK_CHILDREN,
      },
      0,
      stats
    )
  },

  /**
   * 三层降级获取拆解初稿（多层级任务树）：
   * 层1 客户端直调 ai.breakdownGoal（官方明确支持的路径，返回任务树）
   * 层2 云函数 breakdownTask（返回任务树，内部自带预设降级）
   * 层3 预设两层树 + 预设信息缺口
   * @param {Object} [opts] { budgetMs: 层1 AI 预算；skipCloud: 跳过层2（批量中连续失败后） }
   */
  async requestBreakdown(goal, depthHint, opts) {
    const budgetMs = opts && opts.budgetMs
    // 熔断冷却中：层1必失败；额度级冷却下云端同环境同样失败，直接用预设降级
    // （批量拆解场景下，后续目标不再重复全量失败循环，单目标耗时从分钟级降到毫秒级）
    if (ai.isAiTemporarilyDown()) {
      console.warn('[breakdown] AI 熔断冷却中，直接使用预设降级')
      return {
        goal: this.buildFallbackTree(goal),
        infoGaps: PRESET_INFO_GAPS,
        source: 'fallback',
        reason: 'rate-limit',
      }
    }
    // 层1：客户端直调（官方文档路径，基础库 ≥ 3.7.1 + 环境开通 AI+）
    let clientError = null
    try {
      const r = await ai.breakdownGoal(goal, depthHint, budgetMs ? { budgetMs } : undefined)
      return { goal: r.goal, infoGaps: r.infoGaps || [], source: 'ai' }
    } catch (e) {
      clientError = e
      console.warn('[breakdown] 客户端 AI 直调失败', e)
    }

    // 429 限流/预算耗尽：立即调云函数只会叠加等待，直接降级示例
    if (clientError && (ai.isRateLimited(clientError) || ai.isBudgetError(clientError))) {
      return {
        goal: this.buildFallbackTree(goal),
        infoGaps: PRESET_INFO_GAPS,
        source: 'fallback',
        reason: ai.isBudgetError(clientError) ? 'slow' : 'rate-limit',
      }
    }

    // 层2：云函数 breakdownTask（客户端侧加超时：云函数总超时 30s，
    // 网络异常时避免无限等待阻塞批量循环）
    // 批量模式连续失败 ≥2 次后跳过（云端同环境 AI 大概率同样不可用）
    if (opts && opts.skipCloud) {
      console.warn('[breakdown] 云函数连续失败，跳过层2直接预设降级')
    } else {
      let preset = null
      try {
        const res = await Promise.race([
          wx.cloud.callFunction({
            name: 'breakdownTask',
            data: { goal: goal, depthHint: depthHint },
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('云函数响应超时')), 35 * 1000)
          ),
        ])
        const r = res && res.result
        if (r && r.goal && Array.isArray(r.goal.children) && r.goal.children.length) {
          if (r.success) {
            return { goal: r.goal, infoGaps: r.infoGaps || [], source: 'ai' }
          }
          // 云函数内部 AI 失败：结果已带预设降级树 + 预设缺口，记下备用
          preset = { goal: r.goal, infoGaps: r.infoGaps || [] }
        }
      } catch (e) {
        console.warn('[breakdown] 云函数不可用，使用预设示例', e)
        if (opts && typeof opts.onCloudFail === 'function') opts.onCloudFail()
      }

      // 层3：预设两层树（优先用云函数带回的降级数据）
      return {
        goal: (preset && preset.goal) || this.buildFallbackTree(goal),
        infoGaps: (preset && preset.infoGaps.length && preset.infoGaps) || PRESET_INFO_GAPS,
        source: 'fallback',
      }
    }

    // 层3（skipCloud 分支）：预设两层树
    return {
      goal: this.buildFallbackTree(goal),
      infoGaps: PRESET_INFO_GAPS,
      source: 'fallback',
    }
  },

  /* ---------------- 批量目标：识别 → 确认 → 批量拆解 → 采纳 ---------------- */

  /**
   * 智能识别与拆解入口：先识别目标数再分流。
   * - 单目标：透明进入单目标拆解流程（suggestedDepth 一并传入，引导拆解深度）
   * - 多目标：进入确认阶段（可编辑/删除/添加），用户确认后再批量拆解，
   *   避免识别错误浪费 AI 调用
   */
  async handleSmartParse() {
    if (this.data.parsing || this.data.isLoading || this.data.batchLoading) return
    const text = (this.data.goal || '').trim()
    if (!text) {
      wx.showToast({ title: '请输入要做的事情', icon: 'none' })
      return
    }
    this.setData({ parsing: true })
    try {
      const parsed = await this.requestParseGoals(text)
      if (!parsed.goals.length) throw new Error('未识别出目标')

      if (parsed.goals.length === 1) {
        // 单目标：目标名回填输入框，补充描述 + 建议深度一并传入拆解（更精准）
        const g = parsed.goals[0]
        const goalText = g.description ? g.title + '，' + g.description : g.title
        this.setData({
          goal: g.title,
          batchStage: '',
          parsedGoals: [],
          batchResults: [],
          batchProgress: '',
          batchDoneCount: 0,
          batchActiveIndex: -1,
          editing: false,
          editingGoalId: '',
          editingGoalTitle: '',
        })
        this.handleBreakdown(goalText, g.suggestedDepth)
        return
      }

      // 多目标：进入确认阶段
      const goals = parsed.goals.map((g, i) => Object.assign({ key: 'pg-' + i }, g))
      this.setData({
        batchStage: 'confirm',
        parsedGoals: goals,
        batchResults: [],
        batchProgress: '',
        batchDoneCount: 0,
        batchActiveIndex: -1,
        hasResult: false,
        editing: false,
        editingGoalId: '',
        editingGoalTitle: '',
      })
      wx.showToast({
        title:
          parsed.source === 'ai'
            ? '已识别 ' + goals.length + ' 个目标，请确认'
            : 'AI 暂不可用，已按规则切分，请确认',
        icon: 'none',
        duration: 2000,
      })
    } catch (e) {
      console.error('[breakdown] 目标识别失败', e)
      wx.showToast({ title: '识别失败，请重试或分开输入', icon: 'none' })
    } finally {
      this.setData({ parsing: false })
    }
  },

  /**
   * 三层降级获取目标识别结果：
   * 层1 客户端直调 ai.parseGoals
   * 层2 云函数 parseGoals（服务端 AI + 规则切分降级）
   * 层3 客户端规则切分（与云函数 ruleParseGoals 同逻辑）
   */
  async requestParseGoals(text) {
    // 层1：客户端直调
    let clientError = null
    try {
      const r = await ai.parseGoals(text)
      return { goals: r.goals, summary: r.summary, source: 'ai' }
    } catch (e) {
      clientError = e
      console.warn('[breakdown] 客户端目标识别失败', e)
    }

    // 429 限流：额度按环境计，立即调云函数只会叠加请求，直接规则切分 + 依赖合并
    if (clientError && ai.isRateLimited(clientError)) {
      const rule = ruleParseGoals(text)
      return { goals: ai.postProcessGoals(rule.goals), summary: rule.summary, source: 'rule' }
    }

    // 层2：云函数 parseGoals（内部自带规则切分降级 + 依赖合并后处理）
    // 客户端侧加超时：云函数默认超时远小于此值，防网络异常时无限等待
    try {
      const res = await Promise.race([
        wx.cloud.callFunction({
          name: 'parseGoals',
          data: { text: text },
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('云函数响应超时')), 35 * 1000)
        ),
      ])
      const r = res && res.result
      if (r && Array.isArray(r.goals) && r.goals.length) {
        return { goals: r.goals, summary: r.summary || '', source: r.source || 'ai' }
      }
    } catch (e) {
      console.warn('[breakdown] 云函数目标识别不可用，使用规则切分', e)
    }

    // 层3：客户端规则切分 + 依赖合并后处理（与云函数保持一致）
    const rule = ruleParseGoals(text)
    return { goals: ai.postProcessGoals(rule.goals), summary: rule.summary, source: 'rule' }
  },

  /* ---- 确认阶段：目标列表可编辑（识别有误时手动修正，避免浪费 AI 调用） ---- */

  onParsedTitleInput(e) {
    const idx = e.currentTarget.dataset.index
    this.setData({ ['parsedGoals[' + idx + '].title']: e.detail.value })
  },

  onParsedDescInput(e) {
    const idx = e.currentTarget.dataset.index
    this.setData({ ['parsedGoals[' + idx + '].description']: e.detail.value })
  },

  /** 删除识别出的目标（全删光则退回输入阶段） */
  removeParsedGoal(e) {
    if (this.data.batchLoading) return
    const idx = e.currentTarget.dataset.index
    const goals = this.data.parsedGoals.filter((_, i) => i !== idx)
    if (!goals.length) {
      this.setData({ batchStage: '', parsedGoals: [] })
      return
    }
    this.setData({ parsedGoals: goals })
  },

  /** 手动添加目标（上限 8 个，与识别截断一致） */
  addParsedGoal() {
    if (this.data.parsedGoals.length >= 8) {
      wx.showToast({ title: '最多支持 8 个目标', icon: 'none' })
      return
    }
    this.setData({
      parsedGoals: this.data.parsedGoals.concat([
        {
          key: 'pg-add-' + Date.now(),
          title: '',
          description: '',
          complexity: 'complex',
          suggestedDepth: 2,
          reason: '手动添加',
        },
      ]),
    })
  },

  /** 重新识别 / 重新输入：保留输入文本，清空批量状态回到输入阶段 */
  reparseGoals() {
    if (this.data.batchLoading || this.data.adoptingAll) return
    this.setData({
      batchStage: '',
      parsedGoals: [],
      batchResults: [],
      batchProgress: '',
      batchDoneCount: 0,
      batchActiveIndex: -1,
    })
  },

  /**
   * 确认并拆解：校验目标名 → 串行逐个拆解（AI 串行队列约束，
   * 同一时刻只允许一个 AI 请求在途）。
   * 卡片先以 pending 占位，逐个完成后增量渲染（用户无需等全部完成）。
   * 拆解输入带 suggestedDepth（parseGoals 的建议深度）。
   */
  async confirmBatchBreakdown() {
    if (this.data.batchLoading) return
    const goals = this.data.parsedGoals
      .map((g) => ({
        title: String(g.title || '').trim().slice(0, 30),
        description: String(g.description || '').trim().slice(0, 60),
        complexity: g.complexity === 'simple' ? 'simple' : 'complex',
        suggestedDepth: Number(g.suggestedDepth) >= 1 && Number(g.suggestedDepth) <= 4
          ? Number(g.suggestedDepth)
          : 2,
      }))
      .filter((g) => !!g.title)
    if (!goals.length) {
      wx.showToast({ title: '请至少填写一个目标名', icon: 'none' })
      return
    }

    // 先渲染 pending 占位卡片，再逐个拆解增量填充
    const results = goals.map((g, i) => ({
      key: 'br-' + i,
      title: g.title,
      description: g.description,
      complexity: g.complexity,
      tree: null,
      treeRows: [],
      expandedMap: {},
      clogInfo: null,
      totalDuration: 0,
      criticalPathText: '',
      aiFallback: false,
      pending: true,
      adopted: false,
      adopting: false,
      feedback: '',
      refining: false,
      adjustments: [],
    }))
    this.setData({
      batchStage: 'results',
      parsedGoals: [],
      batchResults: results,
      batchLoading: true,
      batchProgress: '正在拆解 1/' + goals.length + '…',
      batchDoneCount: 0,
      batchActiveIndex: 0,
    })

    try {
      // 两级时间预算：整批 90s / 单目标层1 35s。
      // 保证任何网络/通道异常下批量循环必然收敛（此前最坏 3入口×2方法×超时
      // 叠加可达分钟级且无上界，表现为"一直显示正在拆解"）
      const batchDeadline = Date.now() + BATCH_TOTAL_BUDGET_MS
      let cloudFails = 0
      let done = 0 // 已处理目标数（成功或降级都算；驱动头部"已拆解 x/n"）
      for (let i = 0; i < goals.length; i++) {
        // 整批预算耗尽：剩余目标直接预设降级（保留卡片可单独重拆）
        if (Date.now() >= batchDeadline) {
          console.warn('[breakdown] 整批时间预算耗尽，剩余目标直接降级', goals[i].title)
          done++
          this.setData({
            batchDoneCount: done,
            batchActiveIndex: -1,
            ['batchResults[' + i + '].aiFallback']: true,
            ['batchResults[' + i + '].pending']: false,
          })
          continue
        }
        this.setData({
          batchActiveIndex: i,
          batchProgress: '正在拆解 ' + (i + 1) + '/' + goals.length + '：' + goals[i].title,
        })
        try {
          // 拆解输入带上补充描述 + 建议深度（更精准）；复用单目标三层降级
          const goalText = goals[i].description
            ? goals[i].title + '，' + goals[i].description
            : goals[i].title
          const draft = await this.requestBreakdown(goalText, goals[i].suggestedDepth, {
            budgetMs: GOAL_AI_BUDGET_MS,
            skipCloud: cloudFails >= 2, // 云函数连续失败 2 次：云端同环境大概率同样不可用
            onCloudFail: () => {
              cloudFails += 1
            },
          })
          if (draft.goal && draft.goal.children && draft.goal.children.length) {
            cloudFails = 0 // 云函数成功则重置失败计数
            done++
            this.applyBatchTreeView(i, draft.goal, {
              aiFallback: draft.source === 'fallback',
              pending: false,
            })
            this.setData({ batchDoneCount: done })
            continue
          }
          throw new Error('拆解结果为空')
        } catch (e) {
          // 单个目标拆解失败不中断整批：标记降级，用户可单独重新拆解
          console.warn('[breakdown] 目标拆解失败，跳过', goals[i].title, e)
          done++
          this.setData({
            batchDoneCount: done,
            ['batchResults[' + i + '].aiFallback']: true,
            ['batchResults[' + i + '].pending']: false,
          })
        }
      }
    } finally {
      this.setData({ batchLoading: false, batchProgress: '', batchActiveIndex: -1 })
    }
  },

  /* ---- 批量结果：单目标对话调优（仅作用于该目标，其他目标不受影响） ---- */

  onBatchFeedbackInput(e) {
    const idx = e.currentTarget.dataset.index
    this.setData({ ['batchResults[' + idx + '].feedback']: e.detail.value })
  },

  /** 发送单目标调整意见：检索知识库 → 三层降级树形调优 → 重算该目标树视图 */
  async sendBatchFeedback(e) {
    const idx = e.currentTarget.dataset.index
    const item = this.data.batchResults[idx]
    if (!item || item.refining || item.pending || !item.tree) return
    const feedback = (item.feedback || '').trim()
    if (!feedback) {
      wx.showToast({ title: '请输入调整意见', icon: 'none' })
      return
    }
    this.setData({ ['batchResults[' + idx + '].refining']: true })
    try {
      const relatedKnowledge = await this.searchRelatedKnowledge(feedback, item.title, '')
      const refined = await this.requestRefine(item.title, item.tree, feedback, relatedKnowledge)

      // 规则未能理解反馈（AI 不可用）：不更新树，提示用户换个说法
      if (refined.source === 'rule-none') {
        wx.showToast({
          title: refined.adjustmentSummary || 'AI 暂不可用，试试"删除XX"或"增加XX"',
          icon: 'none',
          duration: 3000,
        })
        return
      }

      this.applyBatchTreeView(idx, refined.goal, {
        feedback: '',
        adjustments: item.adjustments.concat([
          { key: 'adj-' + Date.now(), text: refined.adjustmentSummary || '已根据反馈调整' },
        ]),
      })
      wx.showToast({
        title: refined.source === 'rule' ? 'AI 暂不可用，已按规则简单调整' : '已调整',
        icon: refined.source === 'rule' ? 'none' : 'success',
        duration: refined.source === 'rule' ? 2500 : 1500,
      })

      // 对话知识提取（fire-and-forget）
      if (knowledge.worthExtracting(feedback)) {
        this.triggerKnowledgeExtraction(feedback)
      }
    } catch (e) {
      console.error('[breakdown] 批量调优失败', e)
      wx.showToast({ title: '调整失败，请重试', icon: 'none' })
    } finally {
      this.setData({ ['batchResults[' + idx + '].refining']: false })
    }
  },

  /* ---- 批量结果：逐个采纳 / 全部采纳 ---- */

  /** 采纳单个目标：递归导入该目标任务树，卡片标记"已采纳"（不可重复采纳） */
  async adoptBatchGoal(e) {
    if (this.data.adoptingAll || this.data.batchLoading) return
    const idx = e.currentTarget.dataset.index
    const item = this.data.batchResults[idx]
    if (!item || item.adopted || item.pending || item.adopting || !item.tree) return
    this.setData({ ['batchResults[' + idx + '].adopting']: true })
    wx.showLoading({ title: '导入中…', mask: true })
    try {
      const r = await treeUtils.importTreeToDb(item.title, item.tree, api)
      wx.hideLoading()
      this.setData({ ['batchResults[' + idx + '].adopted']: true })
      wx.showToast({
        title: r.imported > 0 ? '已采纳「' + item.title + '」' : '「' + item.title + '」任务均已存在',
        icon: r.imported > 0 ? 'success' : 'none',
      })
    } catch (err) {
      wx.hideLoading()
      console.error('[breakdown] 采纳目标失败', err)
      // 带上可读原因（DbError/ValidationError 的 message 已是中文），便于定位是读还是写失败
      const reason = err && err.message ? String(err.message).slice(0, 24) : '请重试'
      wx.showToast({ title: '导入失败：' + reason, icon: 'none', duration: 3000 })
    } finally {
      this.setData({ ['batchResults[' + idx + '].adopting']: false })
    }
  },

  /**
   * 全部采纳：串行导入所有未采纳目标（递归任务树导入）。
   * 逐目标容错：单个目标导入失败只标记该目标，其余继续（避免"一个出错整批不落库"，
   * 表现为点了全部采纳但首页一个新目标都看不到）；结束后按成功/失败数如实提示。
   * 共享 importCtx 映射跨目标累积（一次全量查询 + 防重名重复导入）。
   */
  async adoptAllBatchGoals() {
    if (this.data.adoptingAll || this.data.batchLoading) return
    const pending = this.data.batchResults
      .map((item, idx) => ({ item: item, idx: idx }))
      .filter((x) => !x.item.adopted && !x.item.pending && x.item.tree)
    if (!pending.length) {
      wx.showToast({ title: '没有可采纳的目标', icon: 'none' })
      return
    }
    this.setData({ adoptingAll: true })
    wx.showLoading({ title: '批量导入 0/' + pending.length + '…', mask: true })
    let importCtx = null // 首个目标内部建立映射，后续目标复用并累积
    let done = 0
    let failed = 0
    try {
      for (const x of pending) {
        try {
          const r = await treeUtils.importTreeToDb(x.item.title, x.item.tree, api, importCtx)
          importCtx = r.ctx
          this.setData({ ['batchResults[' + x.idx + '].adopted']: true })
          done++
        } catch (err) {
          failed++
          console.error('[breakdown] 采纳目标失败（继续处理其余目标）', x.item.title, err)
        }
        wx.showLoading({ title: '批量导入 ' + (done + failed) + '/' + pending.length + '…', mask: true })
      }
      wx.hideLoading()
      if (failed) {
        wx.showToast({
          title: '已采纳 ' + done + ' 个，' + failed + ' 个失败（未标记，可单独重试）',
          icon: 'none',
          duration: 3000,
        })
      } else {
        wx.showToast({ title: '已采纳全部 ' + done + ' 个目标', icon: 'success' })
      }
    } catch (e) {
      wx.hideLoading()
      console.error('[breakdown] 批量采纳异常中断', e)
      wx.showToast({ title: '导入异常，可单独采纳未标记的目标', icon: 'none', duration: 2500 })
    } finally {
      this.setData({ adoptingAll: false })
    }
  },

  /* ---------------- 对话调优 ---------------- */

  onFeedbackInput(e) {
    this.setData({ feedback: e.detail.value })
  },

  /** 发送反馈：检索知识库 → 三层降级树形调优 → 重算树视图 → 更新调整记录 → 异步提取知识 */
  async sendFeedback() {
    if (this.data.refining || !this.data.hasResult) return
    const feedback = (this.data.feedback || '').trim()
    if (!feedback) {
      wx.showToast({ title: '请输入调整意见', icon: 'none' })
      return
    }
    this.setData({ refining: true })
    try {
      // 0. 检索知识库（Agent 长期记忆）：目标 + 反馈 + 当前卡点作为关键词
      //    命中知识拼进 AI 上下文（个人经验优先于理论）；检索失败静默跳过，不影响调优
      const clogTitle = this.data.clogInfo ? this.data.clogInfo.title : ''
      const relatedKnowledge = await this.searchRelatedKnowledge(
        feedback,
        this.data.goal,
        clogTitle
      )

      const refined = await this.requestRefine(
        this.data.goal,
        this.data.tree,
        feedback,
        relatedKnowledge
      )

      // 规则未能理解反馈（AI 不可用）：不更新树，提示用户换个说法
      if (refined.source === 'rule-none') {
        wx.showToast({
          title: refined.adjustmentSummary || 'AI 暂不可用，试试"删除XX"或"增加XX"',
          icon: 'none',
          duration: 3000,
        })
        return
      }

      const adjustments = this.data.adjustments.concat([
        {
          key: 'adj-' + Date.now(),
          text: refined.adjustmentSummary || '已根据反馈调整',
        },
      ])
      this.applyTreeView(refined.goal, {
        feedback: '',
        adjustments: adjustments,
        draftCount: this.data.draftCount + 1,
      })
      wx.showToast({
        title: refined.source === 'rule' ? 'AI 暂不可用，已按规则简单调整' : '已调整',
        icon: refined.source === 'rule' ? 'none' : 'success',
        duration: refined.source === 'rule' ? 2500 : 1500,
      })

      // 对话知识提取（fire-and-forget）：预筛通过才触发，失败静默
      if (knowledge.worthExtracting(feedback)) {
        this.triggerKnowledgeExtraction(feedback)
      }
    } catch (e) {
      console.error('[breakdown] 调整失败', e)
      wx.showToast({ title: '调整失败，请重试', icon: 'none' })
    } finally {
      this.setData({ refining: false })
    }
  },

  /**
   * 检索知识库相关知识（最多 3 条，个人经验优先于理论）：
   * 命中的知识 usageCount +1（fire-and-forget 落库，不计入等待）。
   * 知识库不可用（未初始化/降级中）时返回空数组，调优自动退回无参考模式。
   * goalTitle / bottleneckTask 由调用方传入（单目标模式传页面字段，批量模式传目标卡片字段）。
   */
  async searchRelatedKnowledge(feedback, goalTitle, bottleneckTask) {
    try {
      const all = await api.loadKnowledge()
      const keywords = [goalTitle || '', feedback, bottleneckTask || '']
      const hits = knowledge.searchKnowledge(all, keywords, 3)
      hits.forEach((k) => {
        api
          .updateKnowledge(k._id, { usageCount: (k.usageCount || 0) + 1 })
          .catch(() => {}) // 计数失败不影响主流程
      })
      return hits
    } catch (e) {
      console.warn('[breakdown] 知识库检索失败（跳过知识参考）', e)
      return []
    }
  },

  /**
   * 对话知识提取（fire-and-forget，不阻塞调优结果展示）：
   * 层1 客户端直调 ai.extractKnowledge → 层2 云函数 extractKnowledge → 失败静默跳过。
   * 提取结果写入知识库 status: 'pending'，用户在知识库页确认后 Agent 才会引用。
   */
  async triggerKnowledgeExtraction(feedback) {
    try {
      const context =
        '目标：' + this.data.goal +
        '；当前子任务：' + this.data.treeRows.map((t) => t.title).join('、')
      let items = null
      try {
        items = await ai.extractKnowledge(feedback, context)
      } catch (e) {
        if (ai.isRateLimited(e)) return // 限流：直接放弃，不叠加云函数请求
        try {
          const res = await wx.cloud.callFunction({
            name: 'extractKnowledge',
            data: { userMessage: feedback, context: context },
          })
          const r = res && res.result
          if (r && r.success && Array.isArray(r.items)) items = r.items
        } catch (e2) {
          console.warn('[breakdown] 云函数知识提取不可用，跳过', e2)
        }
      }
      if (items === null || !items.length) return

      for (const item of items.slice(0, 3)) {
        await api.addKnowledge({
          title: item.title,
          content: item.content,
          type: item.type,
          tags: item.tags,
          status: 'pending',
          source: 'extracted',
        })
      }
      wx.showToast({
        title: '已从对话提取 ' + Math.min(items.length, 3) + ' 条知识，待确认',
        icon: 'none',
        duration: 2500,
      })
    } catch (e) {
      console.warn('[breakdown] 知识提取失败（静默跳过）', e)
    }
  },

  /**
   * 三层降级获取调优结果（多层级任务树版）：
   * 层1 客户端直调 ai.refineTasks（知识参考拼进 prompt；传 toAITree 剥离后的干净树）
   * 层2 云函数 refineTask（knowledge 随 data 传入；服务端 AI + 规则降级）
   * 层3 utils/tree.js ruleRefineTree（正则意图解析，知识不参与）
   */
  async requestRefine(goal, currentTree, feedback, relatedKnowledge) {
    // 层1：客户端直调
    let clientError = null
    try {
      const r = await ai.refineTasks(
        goal,
        treeUtils.toAITree(currentTree),
        feedback,
        relatedKnowledge
      )
      return {
        goal: r.goal,
        adjustmentSummary: r.adjustmentSummary,
        source: 'ai',
      }
    } catch (e) {
      clientError = e
      console.warn('[breakdown] 客户端 AI 调优失败', e)
    }

    // 429 限流：额度按环境计，立即调云函数只会叠加请求，直接规则降级
    if (clientError && ai.isRateLimited(clientError)) {
      return treeUtils.ruleRefineTree(currentTree, feedback)
    }

    // 层2：云函数 refineTask（内部自带 AI → 规则降级）
    try {
      const res = await wx.cloud.callFunction({
        name: 'refineTask',
        data: {
          goal: goal,
          currentTree: treeUtils.toAITree(currentTree),
          userFeedback: feedback,
          knowledge: relatedKnowledge || [],
        },
      })
      const r = res && res.result
      if (r && r.goal && Array.isArray(r.goal.children) && r.goal.children.length) {
        return {
          goal: r.goal,
          adjustmentSummary: r.adjustmentSummary,
          source: r.source || 'ai',
        }
      }
    } catch (e) {
      console.warn('[breakdown] 云函数调优不可用，使用规则降级', e)
    }

    // 层3：客户端规则降级（树版：删除/增加/改耗时，递归作用整树）
    return treeUtils.ruleRefineTree(currentTree, feedback)
  },

  /* ---------------- 采纳导入 / 重新拆解 ---------------- */

  /** 重新拆解：换个角度重新生成初稿（清空调整记录，回到第 1 版） */
  handleRedo() {
    if (this.data.isLoading) return
    this.handleBreakdown(null, null)
  },

  /** 采纳导入：确认弹窗防误操作 → 递归导入首页 */
  handleImport() {
    if (this.data.importing || !this.data.tree) return
    // 调优模式：差异同步回已有目标（已完成子任务不丢失）
    if (this.data.editing) {
      wx.showModal({
        title: '同步更新',
        content:
          '将把调优后的任务树同步到首页：新增/更新未完成节点，已删除的未完成节点连同子树移除，已完成节点保留。确认？',
        confirmText: '同步',
        cancelText: '再想想',
        success: (res) => {
          if (res.confirm) this.syncToExisting()
        },
      })
      return
    }
    const nodeCount = this.countNodes(this.data.tree) - 1 // 去掉根（目标本身）
    wx.showModal({
      title: '采纳并导入',
      content: '将导入「' + this.data.goal + '」及 ' + nodeCount + ' 个多层级子任务到首页，确认？',
      confirmText: '导入',
      cancelText: '再想想',
      success: (res) => {
        if (res.confirm) this.executeImport()
      },
    })
  },

  /** 单目标采纳导入（批量模式走 adoptBatchGoal / adoptAllBatchGoals） */
  async executeImport() {
    if (this.data.importing || !this.data.tree) return
    this.setData({ importing: true })
    wx.showLoading({ title: '导入中…', mask: true })
    try {
      const r = await treeUtils.importTreeToDb(
        (this.data.goal || '').trim(),
        this.data.tree,
        api
      )
      wx.hideLoading()
      if (r.imported > 0) {
        wx.showToast({
          title: '已导入目标及 ' + (r.imported - 1) + ' 个子任务',
          icon: 'success',
        })
        // 跳回首页，onShow 会自动刷新
        setTimeout(() => {
          wx.switchTab({ url: '/pages/index/index' })
        }, 600)
      } else {
        wx.showToast({ title: '任务均已存在，无需重复导入', icon: 'none' })
      }
    } catch (e) {
      wx.hideLoading()
      console.error('[breakdown] 导入失败', e)
      wx.showToast({ title: '导入失败，请重试', icon: 'none' })
    } finally {
      this.setData({ importing: false })
    }
  },

  /* ---------------- 已有目标调优（首页"✨ AI调优"入口） ---------------- */

  /** 载入已有大目标的任务树，进入对话调优模式（无子任务时退回新拆解预填） */
  async loadExistingGoal(goalId) {
    try {
      const all = await api.loadTasks()
      const goal = all.find((t) => t._id === goalId)
      if (!goal) {
        wx.showToast({ title: '目标不存在或已删除', icon: 'none' })
        return
      }
      const goalTree = treeUtils.buildTreeFromTasks(goal, all)
      if (!goalTree.children.length) {
        // 还没有子任务：预填目标名，走正常智能拆解流程
        this.setData({
          goal: goal.title,
          tree: null,
          treeRows: [],
          expandedMap: {},
          hasResult: false,
          editing: false,
          editingGoalId: '',
          editingGoalTitle: '',
          batchStage: '',
          parsedGoals: [],
          batchResults: [],
          batchProgress: '',
          batchDoneCount: 0,
          batchActiveIndex: -1,
        })
        wx.showToast({ title: '该目标还没有子任务，点击智能识别与拆解', icon: 'none', duration: 2000 })
        return
      }
      this.applyTreeView(goalTree, {
        goal: goal.title,
        aiFallback: false,
        infoGaps: [],
        feedback: '',
        adjustments: [],
        draftCount: 1,
        editing: true,
        editingGoalId: goalId,
        editingGoalTitle: goal.title,
        batchStage: '',
        parsedGoals: [],
        batchResults: [],
        batchProgress: '',
        batchDoneCount: 0,
        batchActiveIndex: -1,
      })
      wx.showToast({ title: '已载入目标，可直接对话调优', icon: 'none', duration: 2000 })
    } catch (e) {
      console.error('[breakdown] 载入已有目标失败', e)
      wx.showToast({ title: '载入失败，请重试', icon: 'none' })
    }
  },

  /**
   * 调优树差异同步回首页（编辑模式专用，已完成节点不丢失）：
   * utils/tree.js syncTreeToDb 递归处理：
   * 1. 草稿新增节点 → 递归创建（含 aiHint）
   * 2. 未完成节点耗时变化 → 更新；已完成节点不动
   * 3. 草稿中删除且未完成的节点 → 连同子树删除；已完成保留
   * 4. 回填同层依赖（变化才写库）+ 根耗时 = 草稿树根合计
   */
  async syncToExisting() {
    this.setData({ importing: true })
    wx.showLoading({ title: '同步中…', mask: true })
    try {
      const all = await api.loadTasks()
      const goal = all.find((t) => t._id === this.data.editingGoalId)
      if (!goal) {
        wx.hideLoading()
        this.setData({ editing: false, editingGoalId: '', editingGoalTitle: '' })
        wx.showToast({ title: '目标不存在或已删除', icon: 'none' })
        return
      }
      const r = await treeUtils.syncTreeToDb(goal, this.data.tree, api)
      wx.hideLoading()
      wx.showToast({
        title: '已同步：新增' + r.added + ' 更新' + r.updated + ' 删除' + r.removed,
        icon: 'none',
        duration: 2000,
      })
      // 跳回首页，onShow 会自动刷新并重算卡点链
      setTimeout(() => {
        wx.switchTab({ url: '/pages/index/index' })
      }, 800)
    } catch (e) {
      wx.hideLoading()
      console.error('[breakdown] 同步已有目标失败', e)
      wx.showToast({ title: '同步失败，请重试', icon: 'none' })
    } finally {
      this.setData({ importing: false })
    }
  },
})
