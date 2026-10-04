// pages/index/index.js —— 瓶颈仪表盘（首页）
//
// 多层级任务树（1-5 层动态拆解，见 utils/tree.js）下的首页规则（TOC + 利特尔法则）：
// 1. 首页只展示大目标（level 0）；点击展开查看其多层级任务树（缩进列表；
//    叶子行点击切换完成，有下级的行点击展开/折叠）
// 2. analyzeBottleneck：瓶颈识别只看未完成的大目标 —— > 1 个时按
//    "预计耗时最长"锁定唯一焦点（in_progress），其余大目标 locked；
//    锁定目标的全部层级后代同样锁定（祖先链锁定）
// 3. checkMultiTasking：在办计数只统计大目标（10 个子任务只算 1 个在办），
//    > 3 个大目标才触发警告
// 4. 任务树分析（computeTreeMeta）：每个目标每层跑 CPM、每层识别瓶颈，
//    卡点链逐层向下，最深层瓶颈 = 当前具体卡点（红色高亮），
//    各层瓶颈橙色高亮；默认展开到卡点所在层级（树超过 4 层时默认只展开到第 3 层）
// 5. completeSubtaskById：完成叶子任务后，"全部子任务已完成"的各级祖先逐层
//    自动完成（递归完成联动；大目标完成走破裂动画）；恢复未完成时沿祖先链逆转
// 6. syncTasksToCloud：状态流转批量同步云端（countModification: false，
//    不污染 modificationCount，为牛鞭效应检测保留干净数据）
//
// 智能建议（Agent 行动层）：瓶颈识别回答"卡在哪"，建议回答"现在怎么办"。
// 7. 每个目标的卡点（卡点链最深处，最具体可行动点）自动生成 1-2 条建议
//    （utils/suggestions 规则引擎，永远可用）；全局瓶颈目标的卡点额外用 AI
//    增强（utils/ai，30 分钟缓存，失败静默回退规则建议，5 分钟失败冷却防重试风暴）
// 8. 建议交互：采纳（确认弹窗 + 按类型自动处理，如跳转拆解页）/ 忽略 /
//    反馈有用/没帮助（日志保留，供后续优化建议质量）
// 9. 补充情况（userContext）：用户觉得建议不具体时，在瓶颈卡片就地补充
//    "缺资源/不会做/试过没用…"等标签 + 文字描述，Agent 结合知识库重新生成
//    针对性建议（三层降级：客户端 AI → 云函数 refineSuggestion → 标签规则）；
//    补充与建议历史存 tasks.userContext/suggestionHistory（刷新不丢失），
//    有价值的补充自动提取进知识库待确认区（越用越懂你）
//
// 云函数 analyzeBottleneck / checkMultiTasking 已同步相同规则；
// 页面内为满足首页 < 1.5s 性能要求采用同规则的本地计算。

const api = require('../../utils/api')
const suggestions = require('../../utils/suggestions')
const ai = require('../../utils/ai')
const knowledge = require('../../utils/knowledge')
const treeUtils = require('../../utils/tree')

const TICK_MS = 10 * 1000        // 专注计时显示刷新间隔
const PERSIST_EVERY_TICKS = 6    // 每 6 次刷新（约 60s）将已耗时落库一次
const BURST_MS = 600             // 瓶颈破裂动画时长
const AI_SUG_TTL_MS = 30 * 60 * 1000      // AI 建议缓存有效期
const AI_SUG_FAIL_COOLDOWN_MS = 5 * 60 * 1000 // AI 失败冷却（避免重试风暴）

// 采纳建议后的自动动作描述（确认弹窗文案）+ 执行映射见 executeAdoptedSuggestion
const ADOPT_ACTION_DESC = {
  breakdown: '跳转流程拆解页，自动拆解该任务',
  parallel: '跳转流程拆解页，重新拆解（并行安排）',
  scope: '跳转流程拆解页，缩小任务范围',
  focus: '保持专注锁定，屏蔽其他目标',
  urge: '记录一条催办事件',
  delegate: '标记该任务为待委派',
  help: '标记该任务为待求助',
  outsource: '标记该任务为待外包',
}

Page({
  data: {
    mode: 'cloud',            // 数据模式：cloud | local
    loading: true,
    tasks: [],                // 全量任务（大目标 + 子任务，扁平内存态）
    goals: [],                // 大目标渲染视图（嵌套子任务、展开状态、完成计数）
    bottleneckId: null,       // 当前瓶颈大目标 ID
    bottleneckReason: '',     // 瓶颈判定理由
    activeTaskCount: 0,       // 在办大目标数（子任务不计入）
    showWarning: false,       // 多任务警告横幅开关
    warningMessage: '',       // 警告文案
    showAddForm: false,       // 添加任务表单开关
    form: { title: '', estimatedHours: '' },
    submitting: false,        // 防重复提交（AI/DB 调用期间锁定按钮）
    showBurst: false,         // 破裂动画开关
    burstTaskId: null,        // 正在播放破裂动画的大目标 ID
  },

  focusStartTs: null, // 瓶颈大目标专注计时起点（毫秒时间戳）
  timer: null,
  tickCount: 0,
  unloaded: false,
  aiSugCache: {},       // AI 建议缓存 { [goalId]: { clogId, cacheKey, ts, suggestions, failedAt } }
  aiSugInFlight: false, // AI 建议请求在途标记（防重复触发）
  userToggledGoals: {}, // 用户手动展开/收起过的目标（尊重用户选择，不再自动展开）
  treeExpanded: {},     // 各目标树节点展开集合 { [goalId]: { 节点key: true } }
  userToggledTree: {},  // 用户手动展开/折叠过树节点的目标（之后不再自动展开到卡点）
  ctxPanel: {},         // 补充情况面板状态 { [goalId]: { open, tags: [], text: '' } }
  refiningGoalId: '',   // 正在根据补充重新生成建议的目标 ID（加载态标记）

  isGoal(t) {
    return api.isGoal(t)
  },

  onLoad() {
    wx.showLoading({ title: '初始化中', mask: true })
    // loading 必须在 finally 里复位：否则初始化异常时它会永久停在 true，
    // onShow 的 if(!loading) 判断会让首页之后再也不刷新（表现为新导入的目标不出现）
    this.bootstrap().finally(() => {
      wx.hideLoading()
      this.setData({ loading: false })
    })
  },

  onShow() {
    if (!this.data.loading) this.loadTasks()
  },

  onHide() {
    this.flushElapsed()
  },

  onUnload() {
    this.unloaded = true
    this.flushElapsed()
    this.stopTimer()
  },

  onPullDownRefresh() {
    this.loadTasks().finally(() => wx.stopPullDownRefresh())
  },

  /** 跳转知识库页（Agent 长期记忆：理论 + 个人经验） */
  goKnowledge() {
    wx.navigateTo({ url: '/pages/knowledge/index' })
  },

  /** 初始化：建集合 → 加载任务（空则种入示例）→ 应用规则（loading 复位见 onLoad） */
  async bootstrap() {
    try {
      await api.initDatabase()
      this.setData({ mode: api.getMode() })
      // 预置理论写入知识库（幂等；fire-and-forget，不阻塞首页 < 1.5s 加载）
      api.initKnowledge(knowledge.PRESET_THEORY)
      await this.loadTasks()
    } catch (e) {
      console.error('[index] 初始化失败', e)
      wx.showToast({ title: '初始化失败，可下拉刷新重试', icon: 'none' })
    }
  },

  /** 从数据层加载任务并依次应用瓶颈规则与多任务检测 */
  async loadTasks() {
    await this.flushElapsed()
    try {
      const tasks = await api.loadTasks()
      const reconciled = await this.reconcileGoals(tasks)
      // 用户手动展开/收起过的目标：跨刷新保留其选择。
      // _expanded 是纯视图字段（不落库），每次 loadTasks 从 DB 重建任务对象时都会丢失，
      // 只记录 userToggledGoals 却不用它回填，会让"手动展开的目标每次回首页又被收起"。
      const prevExpanded = {}
      ;(this.data.tasks || []).forEach((t) => {
        prevExpanded[t._id] = !!t._expanded
      })
      const withDisplay = reconciled.map((t) =>
        Object.assign({}, t, {
          displayHours: (t.actualHours || 0).toFixed(1),
          progress: this.calcProgress(t.actualHours || 0, t.estimatedHours),
          _expanded: this.userToggledGoals[t._id] ? !!prevExpanded[t._id] : !!t._expanded,
        })
      )
      this.setData({ tasks: withDisplay })
      this.analyzeBottleneck(withDisplay)
      this.checkMultiTasking(withDisplay)
      // 自动展开瓶颈目标（建议与卡点直接可见；用户手动收起过则尊重选择）。
      // 注意：必须基于 this.data.tasks（analyzeBottleneck 已写入锁定流转后的最新状态），
      // 不能用 withDisplay（旧数组会覆盖回锁定前状态）
      if (
        this.data.bottleneckId &&
        !this.userToggledGoals[this.data.bottleneckId]
      ) {
        const expanded = this.data.tasks.map((t) =>
          t._id === this.data.bottleneckId
            ? Object.assign({}, t, { _expanded: true })
            : t
        )
        this.setData({ tasks: expanded })
        this.rerender()
      }
    } catch (e) {
      console.error('[index] 任务加载失败', e)
      wx.showToast({ title: '任务加载失败', icon: 'none' })
    }
  },

  /**
   * 数据一致性联动：子任务可能在页面流程之外被置为完成（云端同步/导入补录等），
   * 加载时统一收敛 —— "全部子任务已完成"的各级祖先（含大目标）自动完成
   * （utils/tree.js computeAutoCompleted 不动点迭代，多层级逐层向上传播）。
   */
  async reconcileGoals(tasks) {
    const autos = treeUtils.computeAutoCompleted(tasks)
    if (!autos.length) return tasks
    const autoIds = {}
    autos.forEach((t) => {
      autoIds[t._id] = true
    })
    const reconciled = tasks.map((t) =>
      autoIds[t._id]
        ? Object.assign({}, t, { status: 'completed', isBottleneck: false, _dirty: true })
        : t
    )
    await this.syncTasksToCloud(reconciled)
    return reconciled
  },

  /**
   * 大目标渲染视图：卡片 + 多层级任务树（utils/tree.js 每层 CPM + 每层瓶颈 + 卡点链）。
   * - 树行拍平渲染（缩进 + 展开/折叠）；锁定由根目标推导（祖先链锁定）
   * - 各层瓶颈橙色高亮、卡点链最深层红色高亮；默认展开到卡点所在层级
   *   （卡点深于第 3 层时默认只展开到第 3 层，用户可手动展开）
   * - 完成计数统计全部层级后代节点
   * - 卡点（卡点链最深处，最具体的行动点）附带 1-2 条智能建议，优先级：
   *   补充情况版（suggestionHistory 最新，用户补充后 Agent 重新生成）>
   *   AI 缓存（新鲜时）> 规则建议
   */
  buildGoalView(tasks) {
    const bottleneckId = this.data.bottleneckId
    // 已完成的大目标不进入视图（空状态判断因此正确）
    const goals = tasks.filter((t) => this.isGoal(t) && t.status !== 'completed')

    return goals.map((g) => {
      // 1. 任务树分析：每层 CPM + 每层瓶颈 + 卡点链
      const meta = treeUtils.computeTreeMeta(treeUtils.buildTreeFromTasks(g, tasks))

      // 2. 展开集合：用户手动操作过则尊重，否则默认展开到卡点层级（≤3 层）
      if (!this.userToggledTree[g._id]) {
        this.treeExpanded[g._id] = this.defaultExpandedKeys(meta)
      }
      const expandedMap = this.treeExpanded[g._id] || {}
      const locked = !!bottleneckId && g._id !== bottleneckId
      const treeRows = treeUtils
        .flattenForDisplay(meta.tree, expandedMap)
        .map((r) => Object.assign({}, r, { locked: locked }))

      // 3. 完成计数：统计全部层级后代
      let subTotal = 0
      let subDone = 0
      ;(function count(node) {
        ;(node.children || []).forEach((c) => {
          subTotal++
          if (c.status === 'completed') subDone++
          count(c)
        })
      })(meta.tree)

      // 4. 卡点 = 卡点链最深处（树节点 → 扁平任务，依赖为 _id 口径）；建议基于它
      const clogTask = meta.clog ? tasks.find((t) => t._id === meta.clog._id) : null
      let goalSuggestions = []
      let suggestionSource = 'rule'
      const clogHistory =
        clogTask && Array.isArray(clogTask.suggestionHistory) ? clogTask.suggestionHistory : []
      const latestHist = clogHistory.length ? clogHistory[clogHistory.length - 1] : null
      const refinedHist =
        latestHist &&
        latestHist.basedOn === 'user_context' &&
        Array.isArray(latestHist.suggestions) &&
        latestHist.suggestions.length
          ? latestHist
          : null
      if (refinedHist) {
        // 4a. 补充情况版建议（用户提交过补充 → 建议历史最新版，优先级最高）
        suggestionSource = 'refined'
        goalSuggestions = suggestions
          .filterVisible(refinedHist.suggestions)
          .map((s) => Object.assign({}, s, { taskId: clogTask._id, taskTitle: clogTask.title }))
      } else if (clogTask) {
        // 4b. AI 缓存新鲜时用 AI 建议，否则用规则建议
        const siblings = tasks.filter((t) => t.parentGoalId === clogTask.parentGoalId)
        const cached = this.aiSugCache[g._id]
        const fresh =
          cached &&
          cached.clogId === clogTask._id &&
          Array.isArray(cached.suggestions) &&
          cached.suggestions.length &&
          Date.now() - cached.ts < AI_SUG_TTL_MS
        const raw = fresh
          ? cached.suggestions
          : suggestions.generateSuggestions({
              clog: clogTask,
              goal: g,
              siblings: siblings,
              tasks: tasks,
            })
        suggestionSource = fresh ? 'ai' : 'rule'
        goalSuggestions = suggestions
          .filterVisible(raw)
          .map((s) =>
            Object.assign({}, s, { taskId: clogTask._id, taskTitle: clogTask.title })
          )
      }

      // 5. 补充情况：已提交的标签展示 + 面板状态（页面级暂存，跨 rerender 保留）
      const userContext = clogTask && clogTask.userContext ? clogTask.userContext : null
      const panel = this.ctxPanel[g._id] || { open: false, tags: [], text: '' }

      return {
        _id: g._id,
        title: g.title,
        status: g.status,
        isBottleneck: g.isBottleneck,
        estimatedHours: g.estimatedHours,
        displayHours: g.displayHours,
        progress: g.progress,
        expanded: !!g._expanded,
        treeRows: treeRows,
        clogTitle: clogTask ? clogTask.title : '',
        clogId: clogTask ? clogTask._id : '',
        clogChainText: meta.chain.map((n) => n.title).join(' → '),
        subDone: subDone,
        subTotal: subTotal,
        suggestions: goalSuggestions,
        suggestionSource: suggestionSource,
        suggestionCount: goalSuggestions.length,
        hasUserContext: !!userContext,
        userContextTagsText:
          userContext && userContext.tags && userContext.tags.length
            ? userContext.tags.join(' · ')
            : '',
        ctxOpen: !!panel.open,
        ctxTagItems: suggestions.CTX_TAGS.map((t) => ({
          label: t,
          active: panel.tags.indexOf(t) > -1,
        })),
        ctxText: panel.text || '',
        refining: this.refiningGoalId === g._id,
      }
    })
  },

  /**
   * 默认展开集合：展开卡点的全部祖先（一路看到卡点行）；
   * 树超过 4 层时默认只展开到第 3 层（祖先深度 ≤ 2），更深的折叠待用户手动展开。
   */
  defaultExpandedKeys(meta) {
    const keys = {}
    // chain 末位 = 卡点本身（祖先展开后即已可见，无需展开它）
    meta.chain.slice(0, -1).forEach((n) => {
      if (n.depth <= 2 && n._id) keys[n._id] = true
    })
    return keys
  },

  /** 以内存 tasks + bottleneckId 重建大目标视图 */
  rerender() {
    this.setData({ goals: this.buildGoalView(this.data.tasks) })
  },

  /**
   * 瓶颈识别与锁定（约束理论）—— 只认大目标：
   * - 过滤未完成的大目标；≤ 1 个时不锁定（避免自我阻塞），遗留 locked 回退 pending
   * - > 1 个时按预计耗时降序，第一名为瓶颈（in_progress + isBottleneck），其余锁定
   * - 子任务状态不参与流转；状态变化的大目标打 _dirty 标记批量同步云端
   */
  analyzeBottleneck(tasks) {
    const activeGoals = tasks.filter((t) => this.isGoal(t) && t.status !== 'completed')

    // 0 或 1 个大目标：无瓶颈锁定，所有大目标都可操作
    if (activeGoals.length <= 1) {
      let changed = false
      const updatedTasks = tasks.map((t) => {
        if (this.isGoal(t) && (t.status === 'locked' || t.isBottleneck)) {
          changed = true
          return Object.assign({}, t, { status: 'pending', isBottleneck: false, _dirty: true })
        }
        return t
      })
      this.setData({
        tasks: updatedTasks,
        bottleneckId: null,
        bottleneckReason: '',
      })
      this.rerender()
      this.stopTimer()
      this.focusStartTs = null
      if (changed) this.syncTasksToCloud(updatedTasks)
      return
    }

    // 按预计耗时降序，取第一个作为瓶颈
    const sorted = [...activeGoals].sort(
      (a, b) => (b.estimatedHours || 0) - (a.estimatedHours || 0)
    )
    const bottleneck = sorted[0]

    let changed = false
    const updatedTasks = tasks.map((t) => {
      if (!this.isGoal(t)) return t // 子任务不参与锁定流转
      if (t._id === bottleneck._id) {
        if (t.status !== 'in_progress' || !t.isBottleneck) {
          changed = true
          return Object.assign({}, t, { status: 'in_progress', isBottleneck: true, _dirty: true })
        }
        return t
      }
      if (t.status !== 'completed' && (t.status !== 'locked' || t.isBottleneck)) {
        changed = true
        return Object.assign({}, t, { status: 'locked', isBottleneck: false, _dirty: true })
      }
      return t
    })

    this.setData({
      tasks: updatedTasks,
      bottleneckId: bottleneck._id,
      bottleneckReason: '该目标耗时最长，是当前系统瓶颈',
    })
    this.rerender()

    // 状态变化才同步，避免每次刷新都写库
    if (changed) this.syncTasksToCloud(updatedTasks)

    // 专注计时：瓶颈大目标处于进行中状态时启动（flushElapsed 已落库，从当前时刻续计）
    this.focusStartTs = Date.now()
    this.ensureTimer()

    // 瓶颈切换后尝试 AI 增强建议（fire-and-forget，失败静默保持规则建议）
    this.enhanceSuggestionsWithAI()
  },

  /**
   * AI 建议增强：仅针对全局瓶颈目标的卡点（控制 AI 调用量）。
   * - 卡点 = 该目标任务树卡点链的最深处（最具体、可立即行动的点）
   * - 缓存 30 分钟；影响建议的要素（卡点/状态/未完成前置数/超时）变化才重新生成
   * - 失败进入 5 分钟冷却（避免 onShow 反复触发重试风暴），期间保持规则建议
   * - 生成成功后 rerender，buildGoalView 自动用 AI 建议替换规则建议
   */
  async enhanceSuggestionsWithAI() {
    if (this.aiSugInFlight) return
    const goalId = this.data.bottleneckId
    if (!goalId) return

    const goal = this.data.tasks.find((t) => t._id === goalId)
    if (!goal) return

    // 多层级卡点：树分析取卡点链最深处
    const meta = treeUtils.computeTreeMeta(
      treeUtils.buildTreeFromTasks(goal, this.data.tasks)
    )
    const clogNode = meta.clog
    if (!clogNode) return
    const clog = this.data.tasks.find((t) => t._id === clogNode._id)
    if (!clog || clog.status === 'completed') return
    // 已有"补充情况版"建议（用户补充过、建议历史有效）：不再消耗 AI 生成初始建议
    if (
      clog.userContext &&
      Array.isArray(clog.suggestionHistory) &&
      clog.suggestionHistory.length
    ) {
      return
    }

    const est = clog.estimatedHours || 0
    const openPrereqCount = (clog.dependencies || []).filter((d) => {
      const dep = this.data.tasks.find((t) => t._id === d)
      return dep && dep.status !== 'completed'
    }).length
    const timedOut = est > 0 && (clog.actualHours || 0) > est * 1.5 ? 1 : 0
    const cacheKey = [clog._id, clog.status, openPrereqCount, timedOut].join(':')

    const cached = this.aiSugCache[goalId]
    if (cached) {
      if (cached.cacheKey === cacheKey && Date.now() - cached.ts < AI_SUG_TTL_MS) return
      if (cached.failedAt && Date.now() - cached.failedAt < AI_SUG_FAIL_COOLDOWN_MS) return
    }

    // 同层兄弟（与建议规则引擎的依赖分析口径一致）
    const siblings = this.data.tasks.filter(
      (t) => t.parentGoalId === clog.parentGoalId && t._id !== clog._id
    )
    const blockedCount = siblings.filter(
      (s) => s.status !== 'completed' && (s.dependencies || []).indexOf(clog._id) > -1
    ).length
    const prereqList = (clog.dependencies || []).map((d) => {
      const dep = this.data.tasks.find((t) => t._id === d)
      return { 任务: dep ? dep.title : d, 状态: dep ? dep.status : '未知' }
    })

    this.aiSugInFlight = true
    try {
      const aiSuggestions = await ai.suggestForBottleneck(
        {
          所属目标: goal.title,
          瓶颈任务: clog.title,
          任务描述: clog.description || '（无）',
          状态: clog.status,
          预估耗时小时: est,
          实际耗时小时: clog.actualHours || 0,
          前置任务: prereqList.length ? prereqList : '（无）',
          被阻塞的后续任务数: blockedCount,
        },
        clog._id
      )
      this.aiSugCache[goalId] = {
        clogId: clog._id,
        cacheKey: cacheKey,
        ts: Date.now(),
        suggestions: aiSuggestions,
      }
      this.rerender() // buildGoalView 检测到新鲜缓存，自动切换为 AI 建议
    } catch (e) {
      // 静默降级：保持规则建议，进入失败冷却
      this.aiSugCache[goalId] = { clogId: clog._id, cacheKey: cacheKey, failedAt: Date.now() }
      console.warn('[index] AI 建议生成失败，保持规则建议', e)
    } finally {
      this.aiSugInFlight = false
    }
  },

  /**
   * 多任务检测（利特尔法则）：在办只统计大目标（子任务不算数），
   * > 3 个大目标才触发警告 —— 拆 10 个子任务仍只算 1 个在办。
   */
  checkMultiTasking(tasks) {
    const activeCount = tasks.filter(
      (t) => this.isGoal(t) && t.status !== 'completed'
    ).length
    const isOverLimit = activeCount > 3
    this.setData({
      activeTaskCount: activeCount,
      showWarning: isOverLimit,
      warningMessage: isOverLimit
        ? '在办大目标已超过3个（当前' + activeCount + '个），多任务将导致效率下降约40%。建议先完成瓶颈目标。'
        : '',
    })
  },

  /**
   * 批量同步任务状态到云端（仅同步 _dirty 的任务）。
   * 系统自动流转不计入 modificationCount（保持牛鞭效应检测数据干净）。
   */
  async syncTasksToCloud(tasks) {
    const dirty = tasks.filter((t) => t._dirty)
    if (!dirty.length) return
    try {
      await Promise.all(
        dirty.map((t) => {
          const patch = { status: t.status, isBottleneck: !!t.isBottleneck }
          if (t.status === 'completed') patch.actualHours = t.actualHours || 0
          return api.updateTask(t._id, patch, { countModification: false })
        })
      )
    } catch (e) {
      console.warn('[index] 状态同步云端失败（本地已更新，下次刷新重试）', e)
    }
  },

  /* ---------------- 计时（实际已耗时，跟随瓶颈大目标） ---------------- */

  calcProgress(elapsed, estimated) {
    if (!estimated) return 0
    return Math.min(100, Math.round(((elapsed || 0) / estimated) * 100))
  },

  ensureTimer() {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.updateLiveElapsed()
      this.tickCount += 1
      if (this.tickCount >= PERSIST_EVERY_TICKS) {
        this.tickCount = 0
        this.flushElapsed()
      }
    }, TICK_MS)
  },

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.tickCount = 0
  },

  /** 刷新瓶颈卡片上的"实际已耗时"读数与进度条（平滑过渡） */
  updateLiveElapsed() {
    const id = this.data.bottleneckId
    if (!id || !this.focusStartTs) return
    const idx = this.data.tasks.findIndex((t) => t._id === id)
    if (idx === -1 || this.data.tasks[idx].status !== 'in_progress') return
    const t = this.data.tasks[idx]
    const h = (t.actualHours || 0) + (Date.now() - this.focusStartTs) / 3600000
    this.setData({
      ['tasks[' + idx + '].displayHours']: h.toFixed(1),
      ['tasks[' + idx + '].progress']: this.calcProgress(h, t.estimatedHours),
    })
    this.rerender()
  },

  /** 将本次专注增量写入内存并落库（actualHours 不计入修改次数） */
  async flushElapsed() {
    const id = this.data.bottleneckId
    if (!id || !this.focusStartTs) return
    const idx = this.data.tasks.findIndex((t) => t._id === id)
    if (idx === -1 || this.data.tasks[idx].status !== 'in_progress') return
    const base = this.data.tasks[idx].actualHours || 0
    const h = +(base + (Date.now() - this.focusStartTs) / 3600000).toFixed(4)
    this.focusStartTs = Date.now()
    if (!this.unloaded) {
      this.setData({
        ['tasks[' + idx + '].actualHours']: h,
        ['tasks[' + idx + '].displayHours']: h.toFixed(1),
      })
    }
    try {
      await api.updateTask(id, { actualHours: h }, { countModification: false })
    } catch (e) {
      console.warn('[index] 专注时长落库失败（稍后自动重试）', e)
    }
  },

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  },

  /* ---------------- 交互 ---------------- */

  toggleAddForm() {
    this.setData({ showAddForm: !this.data.showAddForm })
  },

  onTitleInput(e) {
    this.setData({ 'form.title': e.detail.value })
  },

  onHoursInput(e) {
    this.setData({ 'form.estimatedHours': e.detail.value })
  },

  /** 添加任务（大目标）：成功后 loadTasks 刷新 → 瓶颈重算 → 多任务检测联动 */
  async submitTask() {
    if (this.data.submitting) return // 防重复点击
    const title = (this.data.form.title || '').trim()
    const hours = parseFloat(this.data.form.estimatedHours)
    if (!title) {
      wx.showToast({ title: '请输入任务名称', icon: 'none' })
      return
    }
    if (!(hours > 0) || hours > 1000) {
      wx.showToast({ title: '请输入有效耗时（小时）', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    try {
      await api.addTask({ title, estimatedHours: hours })
      this.setData({ form: { title: '', estimatedHours: '' }, showAddForm: false })
      await this.loadTasks()
    } catch (e) {
      console.error('[index] 添加任务失败', e)
      wx.showToast({ title: '添加失败，请重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  /** 展开/收起大目标的子任务列表（记录用户操作，之后不再自动展开该目标） */
  toggleGoal(e) {
    const { id } = e.currentTarget.dataset
    this.userToggledGoals[id] = true
    const tasks = this.data.tasks.map((t) =>
      t._id === id ? Object.assign({}, t, { _expanded: !t._expanded }) : t
    )
    this.setData({ tasks })
    this.rerender()
  },

  /** AI调优已有目标：暂存目标 ID，跳转拆解页进入对话调优模式（breakdown onShow 接收） */
  onRefineGoal(e) {
    const { id } = e.currentTarget.dataset
    if (!this.data.tasks.some((t) => t._id === id)) return
    try {
      wx.setStorageSync('po_pending_refine', id)
    } catch (err) {
      console.warn('[index] 调优目标 ID 写入失败', err)
    }
    wx.switchTab({ url: '/pages/breakdown/index' })
  },

  /* ---------------- 删除目标 ---------------- */

  /** 收集任务的全部层级后代任务（含各层子任务；删除/完成检查共用） */
  descendantsOf(taskId, tasks) {
    const byParent = {}
    tasks.forEach((t) => {
      const pid = t.parentGoalId || ''
      if (!byParent[pid]) byParent[pid] = []
      byParent[pid].push(t)
    })
    const out = []
    ;(function collect(pid) {
      ;(byParent[pid] || []).forEach((c) => {
        out.push(c)
        collect(c._id)
      })
    })(taskId)
    return out
  },

  /**
   * 删除大目标：确认弹窗（防误操作）→ 递归删除整棵任务树（全部层级后代）→ 刷新列表。
   * 删除的若是当前瓶颈目标，先停表结算专注时长，再由瓶颈规则自动锁定下一个。
   */
  onDeleteGoal(e) {
    if (this.data.submitting) return
    const { id } = e.currentTarget.dataset
    const goal = this.data.tasks.find((t) => t._id === id)
    if (!goal) return
    const subCount = this.descendantsOf(id, this.data.tasks).length
    wx.showModal({
      title: '删除目标',
      content:
        '「' +
        goal.title +
        '」' +
        (subCount > 0 ? '及其 ' + subCount + ' 个各级子任务' : '') +
        '将被删除，且不可恢复。',
      confirmText: '删除',
      confirmColor: '#E5484D',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) this.executeDeleteGoal(id)
      },
    })
  },

  /** 执行删除：递归删除大目标 + 全部层级后代，成功后重算瓶颈/在办计数；失败提示并回源刷新 */
  async executeDeleteGoal(id) {
    this.setData({ submitting: true })
    wx.showLoading({ title: '删除中…', mask: true })
    try {
      // 先结算瓶颈未落库的专注增量，再动数据。
      // 原因：删除后紧接着的 analyzeBottleneck 会重设专注计时起点（瓶颈切换）
      // 或在只剩 1 个目标时直接停表 —— 两者都会丢弃 focusStartTs 以来的增量。
      // 原先只在"删的就是瓶颈"时结算，删除其他目标时增量会被静默丢掉。
      await this.flushElapsed()
      // 删除的是当前瓶颈：停表（避免增量写到已删除的文档）
      if (id === this.data.bottleneckId) {
        this.stopTimer()
        this.focusStartTs = null
      }

      // 递归删除整棵子树（逐条删除；云端权限"仅创建者可读写"）
      const victims = await treeUtils.removeSubtreeById(id, api, this.data.tasks)

      wx.hideLoading()
      // 内存同步移除（含展开态缓存），清理页面级缓存后重算规则
      const removedIds = {}
      victims.forEach((v) => {
        removedIds[v] = true
      })
      const tasks = this.data.tasks.filter((t) => !removedIds[t._id])
      delete this.userToggledGoals[id]
      delete this.aiSugCache[id]
      delete this.treeExpanded[id]
      delete this.userToggledTree[id]
      this.setData({ tasks })
      this.analyzeBottleneck(tasks) // 剩余目标自动锁定下一个瓶颈
      this.checkMultiTasking(tasks)
      this.rerender()
      wx.showToast({ title: '已删除', icon: 'success' })
    } catch (err) {
      console.error('[index] 删除目标失败', err)
      wx.hideLoading()
      wx.showToast({ title: '删除失败，请重试', icon: 'none', duration: 2500 })
      // 可能已部分删除：以数据源真实状态收敛（同时重算瓶颈）
      await this.loadTasks()
    } finally {
      this.setData({ submitting: false })
    }
  },

  /* ---------------- 智能建议交互（采纳 / 忽略 / 反馈） ---------------- */

  /** 从渲染视图中查找建议对象 */
  findSuggestion(goalId, key) {
    const g = this.data.goals.find((x) => x._id === goalId)
    if (!g || !Array.isArray(g.suggestions)) return null
    return g.suggestions.find((s) => s.key === key) || null
  },

  /** 采纳建议：确认弹窗（防误操作）→ 记录日志 → 按类型执行自动动作 */
  onAdoptSuggestion(e) {
    const { goal: goalId, key } = e.currentTarget.dataset
    const sug = this.findSuggestion(goalId, key)
    if (!sug) return
    const desc = ADOPT_ACTION_DESC[sug.type] || '记录该建议'
    wx.showModal({
      title: '采纳建议',
      content: '采纳后将' + desc + '，确认执行？',
      confirmText: '采纳',
      cancelText: '再想想',
      success: (res) => {
        if (!res.confirm) return
        this.executeAdoptedSuggestion(sug)
      },
    })
  },

  /** 执行采纳的自动动作（按建议类型分派） */
  executeAdoptedSuggestion(sug) {
    suggestions.recordAdopted({
      key: sug.key,
      type: sug.type,
      taskId: sug.taskId,
      taskTitle: sug.taskTitle,
    })
    suggestions.ignoreKey(sug.key) // 已处理，从展示中移除

    // 拆解类：跳转流程拆解页并预填卡点任务（breakdown 页 onShow 接收）
    if (sug.type === 'breakdown' || sug.type === 'parallel' || sug.type === 'scope') {
      try {
        wx.setStorageSync('po_pending_breakdown', sug.taskTitle)
      } catch (e) {
        console.warn('[index] 拆解预填写入失败', e)
      }
      wx.switchTab({ url: '/pages/breakdown/index' })
      return
    }

    // 其余类型：记录 + 对应提示（催办/委派/求助/外包等，动作本身留待后续迭代）
    const toasts = {
      focus: '已锁定专注模式，其他目标已让路',
      urge: '已记录催办，记得主动联系依赖方',
      delegate: '已标记待委派',
      help: '已标记待求助',
      outsource: '已标记待外包',
    }
    wx.showToast({ title: toasts[sug.type] || '已采纳', icon: 'none' })
    this.rerender() // 建议从卡片消失
  },

  /** 忽略建议：不再显示该条（同一卡点同一类型不会重复出现） */
  onDismissSuggestion(e) {
    const { key } = e.currentTarget.dataset
    suggestions.ignoreKey(key)
    this.rerender()
    wx.showToast({ title: '已忽略', icon: 'none' })
  },

  /** 反馈没帮助：记录反馈日志（后续优化建议质量）并隐藏该条 */
  onFeedbackSuggestion(e) {
    const { goal: goalId, key } = e.currentTarget.dataset
    const sug = this.findSuggestion(goalId, key)
    suggestions.recordFeedback(
      sug
        ? { key: sug.key, type: sug.type, taskId: sug.taskId, taskTitle: sug.taskTitle }
        : { key: key }
    )
    suggestions.ignoreKey(key)
    this.rerender()
    wx.showToast({ title: '感谢反馈，建议会越来越准', icon: 'none' })
  },

  /* ---------------- 补充情况（用户上下文 → Agent 重新生成建议） ---------------- */

  /** 打开/收起补充面板；首次打开用已提交的补充预填（编辑场景） */
  onToggleCtxPanel(e) {
    const { goal: goalId } = e.currentTarget.dataset
    const view = this.data.goals.find((g) => g._id === goalId)
    if (!view || !view.clogId) return
    if (!this.ctxPanel[goalId]) {
      const clog = this.data.tasks.find((t) => t._id === view.clogId)
      const uc = clog && clog.userContext
      this.ctxPanel[goalId] = {
        open: true,
        tags: uc && uc.tags ? uc.tags.slice() : [],
        text: uc && uc.text ? uc.text : '',
      }
    } else {
      this.ctxPanel[goalId].open = !this.ctxPanel[goalId].open
    }
    this.rerender()
  },

  /** 快速标签多选（最多 3 个，再选提示） */
  onCtxTagTap(e) {
    const { goal: goalId, tag } = e.currentTarget.dataset
    const panel = this.ctxPanel[goalId]
    if (!panel || !panel.open) return
    const i = panel.tags.indexOf(tag)
    if (i > -1) {
      panel.tags.splice(i, 1)
    } else {
      if (panel.tags.length >= 3) {
        wx.showToast({ title: '最多选3个标签', icon: 'none' })
        return
      }
      panel.tags.push(tag)
    }
    this.rerender()
  },

  /** 补充描述输入（页面级暂存：10s 心跳 rerender 不会重置输入内容） */
  onCtxTextInput(e) {
    const { goal: goalId } = e.currentTarget.dataset
    const panel = this.ctxPanel[goalId]
    if (!panel) return
    panel.text = e.detail.value
  },

  /** 取消：收起面板（草稿保留在页面级状态，再次打开可继续编辑） */
  onCtxCancel(e) {
    const { goal: goalId } = e.currentTarget.dataset
    if (this.ctxPanel[goalId]) this.ctxPanel[goalId].open = false
    this.rerender()
  },

  /** 构建卡点任务信息（refineSuggestion 的任务侧输入，口径同 AI 建议增强） */
  buildCtxTaskInfo(goal, clog) {
    const siblings = this.data.tasks.filter(
      (t) => t.parentGoalId === clog.parentGoalId && t._id !== clog._id
    )
    const blockedCount = siblings.filter(
      (s) => s.status !== 'completed' && (s.dependencies || []).indexOf(clog._id) > -1
    ).length
    const prereqList = (clog.dependencies || []).map((d) => {
      const dep = this.data.tasks.find((t) => t._id === d)
      return { 任务: dep ? dep.title : d, 状态: dep ? dep.status : '未知' }
    })
    return {
      所属目标: goal.title,
      瓶颈任务: clog.title,
      任务描述: clog.description || '（无）',
      状态: clog.status,
      预估耗时小时: clog.estimatedHours || 0,
      实际耗时小时: clog.actualHours || 0,
      前置任务: prereqList.length ? prereqList : '（无）',
      被阻塞的后续任务数: blockedCount,
    }
  },

  /** 补充情况的知识库检索（关键词：卡点名/目标名/补充描述；命中知识引用计数 +1） */
  async searchCtxKnowledge(clogTitle, goalTitle, text) {
    try {
      const all = await api.loadKnowledge()
      const hits = knowledge.searchKnowledge(all, [clogTitle, goalTitle, text], 3)
      hits.forEach((k) => {
        api
          .updateKnowledge(k._id, { usageCount: (k.usageCount || 0) + 1 })
          .catch(() => {}) // 计数失败不影响主流程
      })
      return hits
    } catch (e) {
      console.warn('[index] 知识库检索失败（跳过知识参考）', e)
      return []
    }
  },

  /**
   * 提交补充情况 → Agent 重新生成建议（三层降级，与拆解页调优同模式）：
   * 层1 客户端直调 ai.refineSuggestion（知识库检索拼进 prompt，走串行队列）
   * 层2 云函数 refineSuggestion（服务端任务查询+知识检索+AI+历史落库一体；
   *      本地模式下云端写入客户端不可见，跳过本层）
   * 层3 规则降级 suggestions.generateCtxSuggestions（按标签给策略，永不出错）
   * 成功后：userContext + suggestionHistory 落库（建议替换展示，刷新不丢失），
   * 有价值的补充 fire-and-forget 提取进知识库待确认区。
   */
  async onCtxSubmit(e) {
    if (this.data.submitting || this.refiningGoalId) return // 防重复提交
    const { goal: goalId } = e.currentTarget.dataset
    const view = this.data.goals.find((g) => g._id === goalId)
    const panel = this.ctxPanel[goalId]
    if (!view || !view.clogId || !panel) return

    const tags = panel.tags || []
    const text = (panel.text || '').trim()
    if (!tags.length && !text) {
      wx.showToast({ title: '请选择标签或补充描述', icon: 'none' })
      return
    }

    this.refiningGoalId = goalId
    this.rerender() // 建议区切换为"正在根据你的情况调整建议…"

    const clog = this.data.tasks.find((t) => t._id === view.clogId)
    const goal = this.data.tasks.find((t) => t._id === goalId)
    if (!clog || !goal) {
      // 提交期间卡点/目标已被删除或变更：丢弃草稿并收起面板（下次打开按当前数据重建）
      this.refiningGoalId = ''
      delete this.ctxPanel[goalId]
      this.rerender()
      return
    }
    try {
      const version =
        (clog.userContext && clog.userContext.version ? clog.userContext.version : 0) + 1
      const userContext = {
        tags: tags.slice(0, 3),
        text: text.slice(0, 200),
        submittedAt: Date.now(),
        version: version,
      }

      let result = null // { suggestions, relatedKnowledge }
      let source = ''
      let dbWritten = false // 云函数路径已落库，客户端跳过写入

      // 层1：客户端直调（检索知识库拼进 prompt）
      try {
        const knowledgeHits = await this.searchCtxKnowledge(clog.title, goal.title, text)
        const taskInfo = this.buildCtxTaskInfo(goal, clog)
        result = await ai.refineSuggestion(taskInfo, userContext, clog._id, knowledgeHits)
        source = 'ai'
      } catch (e1) {
        console.warn('[index] 客户端 AI 重新生成失败，尝试云函数', e1)
        // 层2：云函数（服务端全流程；云端写入对客户端可见才走这层）
        if (api.getMode() === 'cloud') {
          try {
            const res = await wx.cloud.callFunction({
              name: 'refineSuggestion',
              data: {
                taskId: clog._id,
                userContext: { tags: userContext.tags, text: userContext.text },
              },
            })
            const r = res && res.result
            if (r && r.success && Array.isArray(r.suggestions) && r.suggestions.length) {
              result = { suggestions: r.suggestions, relatedKnowledge: r.relatedKnowledge || [] }
              source = r.source || 'ai'
              dbWritten = true
              Object.assign(userContext, r.userContext) // 版本号以服务端为准
            }
          } catch (e2) {
            console.warn('[index] 云函数 refineSuggestion 不可用，规则降级', e2)
          }
        }
      }

      // 层3：规则降级（按标签给策略，永不出错）
      if (!result || !result.suggestions || !result.suggestions.length) {
        result = {
          suggestions: suggestions.generateCtxSuggestions(clog, userContext),
          relatedKnowledge: [],
        }
        source = 'rule'
      }

      // 落库 + 内存同步（userContext/suggestionHistory 不计入修改次数）
      const history = (
        Array.isArray(clog.suggestionHistory) ? clog.suggestionHistory : []
      ).slice()
      history.push({
        version: userContext.version,
        suggestions: result.suggestions,
        relatedKnowledge: result.relatedKnowledge,
        generatedAt: Date.now(),
        basedOn: 'user_context',
        source: source,
      })
      const trimmedHistory = history.slice(-5) // 建议历史保留最近 5 条
      if (!dbWritten) {
        await api.updateTask(
          clog._id,
          { userContext: userContext, suggestionHistory: trimmedHistory },
          { countModification: false }
        )
      }
      const idx = this.data.tasks.findIndex((t) => t._id === clog._id)
      this.setData({
        ['tasks[' + idx + '].userContext']: userContext,
        ['tasks[' + idx + '].suggestionHistory']: trimmedHistory,
      })

      // 收起面板 + 清加载态 + 丢弃草稿（下次打开「编辑补充」时，
      // onToggleCtxPanel 走"首次打开"分支，从刚落库的 userContext 回填，可继续编辑）
      delete this.ctxPanel[goalId]
      this.refiningGoalId = ''
      this.rerender() // buildGoalView 自动用建议历史最新版替换旧建议
      wx.showToast({ title: '已根据你的补充调整建议', icon: 'none' })

      // 知识提取联动（fire-and-forget）：有价值的补充 → 待确认知识库
      if (text && knowledge.worthExtracting(text)) {
        this.triggerCtxKnowledgeExtraction(text, goal.title, clog.title)
      }
    } catch (err) {
      console.error('[index] 补充情况提交失败', err)
      this.refiningGoalId = ''
      this.rerender()
      wx.showToast({ title: '提交失败，请重试', icon: 'none' })
    }
  },

  /**
   * 补充信息知识提取（fire-and-forget，不阻塞建议展示）：
   * 层1 客户端直调 ai.extractKnowledge → 层2 云函数 extractKnowledge → 失败静默跳过。
   * "试过xxx没用/我只有xxx/导师要求xxx/用xxx成功了"等沉淀为用户经验，
   * 写入知识库 status: 'pending'，用户确认后 Agent 引用（越用越懂你）。
   */
  async triggerCtxKnowledgeExtraction(text, goalTitle, clogTitle) {
    try {
      const context =
        '目标：' + goalTitle + '；卡点任务：' + clogTitle + '；用户补充了卡点的具体情况'
      let items = null
      try {
        items = await ai.extractKnowledge(text, context)
      } catch (e) {
        if (ai.isRateLimited(e)) return // 限流：直接放弃，不叠加云函数请求
        try {
          const res = await wx.cloud.callFunction({
            name: 'extractKnowledge',
            data: { userMessage: text, context: context },
          })
          const r = res && res.result
          if (r && r.success && Array.isArray(r.items)) items = r.items
        } catch (e2) {
          console.warn('[index] 云函数知识提取不可用，跳过', e2)
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
        title: '已从补充提取 ' + Math.min(items.length, 3) + ' 条知识，待确认',
        icon: 'none',
        duration: 2500,
      })
    } catch (e) {
      console.warn('[index] 知识提取失败（静默跳过）', e)
    }
  },

  /** 有用反馈（补充情况版建议整组）：记录 helpful 日志，供后续优化建议质量 */
  onHelpfulYes(e) {
    const { goal: goalId } = e.currentTarget.dataset
    const view = this.data.goals.find((g) => g._id === goalId)
    if (!view || !Array.isArray(view.suggestions) || !view.suggestions.length) return
    view.suggestions.forEach((s) => {
      suggestions.recordFeedback(
        { key: s.key, type: s.type, taskId: s.taskId, taskTitle: s.taskTitle },
        true
      )
    })
    wx.showToast({ title: '感谢反馈，建议会越来越准', icon: 'none' })
  },

  /** 没帮助反馈（补充情况版建议整组）：记录日志 + 引导继续补充让建议更准 */
  onHelpfulNo(e) {
    const { goal: goalId } = e.currentTarget.dataset
    const view = this.data.goals.find((g) => g._id === goalId)
    if (!view || !Array.isArray(view.suggestions) || !view.suggestions.length) return
    view.suggestions.forEach((s) => {
      suggestions.recordFeedback(
        { key: s.key, type: s.type, taskId: s.taskId, taskTitle: s.taskTitle },
        false
      )
    })
    wx.showToast({ title: '可点"编辑补充"再补充，建议会更准', icon: 'none', duration: 2500 })
  },

  /**
   * 树行点击：有下级的行切换展开/折叠；叶子行切换完成状态。
   * 中间层节点由"全部子任务完成"联动自动完成，不支持手动完成
   * （避免出现"父已完成但子未完成"的不一致状态）。
   */
  onTreeRowTap(e) {
    const { key, has, goal, id } = e.currentTarget.dataset
    if (has) {
      if (!this.treeExpanded[goal]) this.treeExpanded[goal] = {}
      const map = this.treeExpanded[goal]
      if (map[key]) delete map[key]
      else map[key] = true
      this.userToggledTree[goal] = true // 尊重用户选择，之后不再自动展开到卡点
      this.rerender()
      return
    }
    this.completeSubtaskById(id)
  },

  /** 找任务的根目标 ID（沿 parentGoalId 祖先链上溯；guard 防环） */
  rootGoalIdOf(task, tasks) {
    const seen = {}
    let cur = task
    while (cur && cur.parentGoalId && !seen[cur._id]) {
      seen[cur._id] = true
      cur = tasks.find((t) => t._id === cur.parentGoalId)
    }
    return cur ? cur._id : ''
  },

  /**
   * 叶子任务状态切换（点击行）：
   * - 已完成 → 恢复为未完成（沿祖先链逆转自动完成联动：已完成的各级祖先拉回在办）
   * - 未完成 → 完成（根目标被锁定时不可完成：祖先链锁定）；
   *   完成后 computeAutoCompleted 递归联动 —— 中间层祖先静默完成，
   *   大目标全部后代完成 → 破裂动画自动完成（结算耗时 + 重算瓶颈）
   */
  async completeSubtaskById(id) {
    if (this.data.submitting) return
    const sub = this.data.tasks.find((t) => t._id === id)
    if (!sub) return

    // 分支一：已完成 → 恢复为未完成（允许自由切换，含误点补救）
    if (sub.status === 'completed') {
      this.setData({ submitting: true })
      try {
        // 先落库当前瓶颈的专注增量（后续重算瓶颈会重置计时器起点）
        await this.flushElapsed()
        let tasks = this.data.tasks.map((t) =>
          t._id === id
            ? Object.assign({}, t, { status: 'pending', _dirty: true })
            : t
        )
        // 沿祖先链向上：已完成的祖先（含大目标）拉回在办（逆转自动完成联动）
        const reviveIds = {}
        let pid = sub.parentGoalId
        const guard = {}
        while (pid && !guard[pid]) {
          guard[pid] = true
          const p = tasks.find((t) => t._id === pid)
          if (!p) break
          if (p.status === 'completed') reviveIds[p._id] = true
          pid = p.parentGoalId
        }
        if (Object.keys(reviveIds).length) {
          tasks = tasks.map((t) =>
            reviveIds[t._id]
              ? Object.assign({}, t, { status: 'pending', isBottleneck: false, _dirty: true })
              : t
          )
        }
        this.setData({ tasks })
        this.rerender()
        await this.syncTasksToCloud(tasks)
        // 重算瓶颈与在办计数（祖先目标重新进入在办池，可能触发锁定切换）
        this.analyzeBottleneck(tasks)
        this.checkMultiTasking(tasks)
        wx.showToast({ title: '已恢复为未完成', icon: 'none' })
      } catch (err) {
        console.error('[index] 恢复任务失败', err)
        wx.showToast({ title: '操作失败，请重试', icon: 'none' })
      } finally {
        this.setData({ submitting: false })
      }
      return
    }

    // 分支二：未完成 → 完成（祖先链锁定检查：根目标非当前瓶颈则拦截）
    const rootId = this.rootGoalIdOf(sub, this.data.tasks)
    if (this.data.bottleneckId && rootId !== this.data.bottleneckId) {
      wx.showToast({ title: '该目标已锁定，请先推进瓶颈目标', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    try {
      let tasks = this.data.tasks.map((t) =>
        t._id === id
          ? Object.assign({}, t, { status: 'completed', _dirty: true })
          : t
      )

      // 递归完成联动：全部子任务已完成的各级祖先自动完成（不动点迭代逐层向上）
      const autos = treeUtils.computeAutoCompleted(tasks)
      const midAutos = autos.filter((t) => !this.isGoal(t))
      if (midAutos.length) {
        const autoIds = {}
        midAutos.forEach((t) => {
          autoIds[t._id] = true
        })
        tasks = tasks.map((t) =>
          autoIds[t._id]
            ? Object.assign({}, t, { status: 'completed', isBottleneck: false, _dirty: true })
            : t
        )
      }
      this.setData({ tasks })
      this.rerender()
      await this.syncTasksToCloud(tasks)

      // 大目标全部后代完成 → 破裂动画自动完成
      const goalAuto = autos.find((t) => this.isGoal(t))
      if (goalAuto) {
        // goalAuto 是完成前的旧引用；从最新 tasks 取（状态/耗时口径最新）
        const latestGoal = tasks.find((t) => t._id === goalAuto._id)
        await this.autoCompleteGoal(latestGoal)
      } else {
        wx.showToast({
          title: midAutos.length ? '已完成，父级任务同步完成' : '任务已完成',
          icon: 'success',
        })
      }
    } catch (e) {
      console.error('[index] 任务完成失败', e)
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  /**
   * 大目标自动完成（全部层级后代完成后触发）：
   * 结算实际耗时 → 破裂动画 → 同步云端 → 重算瓶颈与在办计数。
   */
  async autoCompleteGoal(goalTask) {
    if (!goalTask) return
    // 结算实际耗时（累计落库值 + 本次会话专注增量）
    let actualHours = goalTask.actualHours || 0
    if (goalTask.status === 'in_progress' && this.focusStartTs) {
      actualHours += (Date.now() - this.focusStartTs) / 3600000
    }
    this.focusStartTs = null
    actualHours = +actualHours.toFixed(2)

    // 播放破裂动画（0.6s）
    this.setData({ showBurst: true, burstTaskId: goalTask._id })
    await this.delay(BURST_MS)

    const tasks = this.data.tasks.map((t) =>
      t._id === goalTask._id
        ? Object.assign({}, t, {
            status: 'completed',
            isBottleneck: false,
            actualHours,
            displayHours: actualHours.toFixed(1),
            _dirty: true,
          })
        : t
    )
    await this.syncTasksToCloud(tasks)
    this.setData({ tasks, showBurst: false, burstTaskId: null })

    // 重新分析瓶颈 + 多任务检测
    this.analyzeBottleneck(tasks)
    this.checkMultiTasking(tasks)
    wx.showToast({ title: '大目标达成！', icon: 'success' })
  },

  /**
   * 手动完成大目标：仅适用于"无后代任务"的大目标（有后代的由联动自动完成）。
   * 只有瓶颈目标（或无锁定时的唯一目标）可以完成。
   */
  async completeTask(e) {
    if (this.data.submitting) return
    const { id } = e.currentTarget.dataset
    const task = this.data.tasks.find((t) => t._id === id)
    if (!task || task.status === 'completed') return

    // 存在瓶颈锁定时，非瓶颈目标不允许完成
    if (this.data.bottleneckId && id !== this.data.bottleneckId) {
      wx.showToast({ title: '请先完成瓶颈目标', icon: 'none' })
      return
    }

    // 有未完成后代任务的大目标不允许手动完成（由子任务联动自动完成）
    const descendants = this.descendantsOf(id, this.data.tasks)
    if (descendants.length && descendants.some((s) => s.status !== 'completed')) {
      wx.showToast({ title: '完成全部子任务后，大目标自动完成', icon: 'none' })
      return
    }

    this.setData({ submitting: true })

    // 结算实际耗时（累计落库值 + 本次会话专注增量）
    let actualHours = task.actualHours || 0
    if (task.status === 'in_progress' && this.focusStartTs) {
      actualHours += (Date.now() - this.focusStartTs) / 3600000
    }
    this.focusStartTs = null
    actualHours = +actualHours.toFixed(2)

    // 播放破裂动画（0.6s）
    this.setData({ showBurst: true, burstTaskId: id })
    await this.delay(BURST_MS)

    // 更新任务状态并同步云端
    const tasks = this.data.tasks.map((t) => {
      if (t._id === id) {
        return Object.assign({}, t, {
          status: 'completed',
          isBottleneck: false,
          actualHours,
          displayHours: actualHours.toFixed(1),
          _dirty: true,
        })
      }
      return t
    })
    await this.syncTasksToCloud(tasks)
    this.setData({ tasks, showBurst: false, burstTaskId: null })

    // 重新分析瓶颈 + 多任务检测
    this.analyzeBottleneck(tasks)
    this.checkMultiTasking(tasks)
    wx.showToast({ title: '瓶颈已突破！', icon: 'success' })
    this.setData({ submitting: false })
  },
})
