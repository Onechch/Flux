// pages/index/index.js —— 瓶颈仪表盘（首页）
//
// 两级任务模型下的首页规则（约束理论 TOC + 利特尔法则）：
// 1. 首页只展示大目标（level 0）；点击大目标可展开查看其子任务列表
// 2. analyzeBottleneck：瓶颈识别只看未完成的大目标 —— > 1 个时按
//    "预计耗时最长"锁定唯一焦点（in_progress），其余大目标 locked；
//    子任务不参与锁定流转（锁定大目标的子任务同样不可推进）
// 3. checkMultiTasking：在办计数只统计大目标（10 个子任务只算 1 个在办），
//    > 3 个大目标才触发警告
// 4. completeSubtask：完成子任务后，若所属大目标下全部子任务完成 →
//    大目标自动完成（结算耗时 + 破裂动画 + 重算瓶颈），无需手动点击
// 5. syncTasksToCloud：状态流转批量同步云端（countModification: false，
//    不污染 modificationCount，为牛鞭效应检测保留干净数据）
//
// 云函数 analyzeBottleneck / checkMultiTasking 已同步相同规则；
// 页面内为满足首页 < 1.5s 性能要求采用同规则的本地计算。

const api = require('../../utils/api')

const TICK_MS = 10 * 1000        // 专注计时显示刷新间隔
const PERSIST_EVERY_TICKS = 6    // 每 6 次刷新（约 60s）将已耗时落库一次
const BURST_MS = 600             // 瓶颈破裂动画时长

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

  isGoal(t) {
    return api.isGoal(t)
  },

  onLoad() {
    wx.showLoading({ title: '初始化中', mask: true })
    this.bootstrap().finally(() => wx.hideLoading())
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

  /** 初始化：建集合 → 加载任务（空则种入示例）→ 应用规则 */
  async bootstrap() {
    await api.initDatabase()
    this.setData({ mode: api.getMode() })
    await this.loadTasks()
    this.setData({ loading: false })
  },

  /** 从数据层加载任务并依次应用瓶颈规则与多任务检测 */
  async loadTasks() {
    await this.flushElapsed()
    try {
      let tasks = await api.loadTasks()
      if (!tasks.length) {
        tasks = await api.seedDefaultTasks()
      }
      tasks = await this.reconcileGoals(tasks)
      const withDisplay = tasks.map((t) =>
        Object.assign({}, t, {
          displayHours: (t.actualHours || 0).toFixed(1),
          progress: this.calcProgress(t.actualHours || 0, t.estimatedHours),
        })
      )
      this.setData({ tasks: withDisplay })
      this.analyzeBottleneck(withDisplay)
      this.checkMultiTasking(withDisplay)
    } catch (e) {
      console.error('[index] 任务加载失败', e)
      wx.showToast({ title: '任务加载失败', icon: 'none' })
    }
  },

  /**
   * 数据一致性联动：子任务可能在页面流程之外被置为完成（云端同步/导入补录等），
   * 加载时统一收敛 —— "全部子任务已完成"的大目标自动标记完成（无需动画，静默落库）。
   */
  async reconcileGoals(tasks) {
    const subsByGoal = {}
    tasks.forEach((t) => {
      if (t.parentGoalId) {
        subsByGoal[t.parentGoalId] = subsByGoal[t.parentGoalId] || []
        subsByGoal[t.parentGoalId].push(t)
      }
    })
    let changed = false
    const reconciled = tasks.map((t) => {
      if (!this.isGoal(t) || t.status === 'completed') return t
      const subs = subsByGoal[t._id]
      if (subs && subs.length && subs.every((s) => s.status === 'completed')) {
        changed = true
        return Object.assign({}, t, { status: 'completed', isBottleneck: false, _dirty: true })
      }
      return t
    })
    if (changed) await this.syncTasksToCloud(reconciled)
    return reconciled
  },

  /**
   * 大目标渲染视图：大目标卡片 + 嵌套子任务（含展开状态、完成计数、卡点高亮）。
   * - 子任务的锁定状态由父目标推导：父目标非当前瓶颈时，子任务同样锁定
   * - 每个大目标内部用橙色高亮自己的"卡点子任务"（目标内的最慢环节）：
   *   在未完成子任务中，可推进（依赖已全部完成）的优先，
   *   再按"预估耗时 + 被阻塞子任务数 × 2"得分最高者当选
   */
  buildGoalView(tasks) {
    const bottleneckId = this.data.bottleneckId
    // 已完成的大目标不进入视图（空状态判断因此正确）
    const goals = tasks.filter((t) => this.isGoal(t) && t.status !== 'completed')
    const subs = tasks.filter((t) => !this.isGoal(t))
    return goals.map((g) => {
      const subtasks = subs
        .filter((s) => s.parentGoalId === g._id)
        .map((s) =>
          Object.assign({}, s, {
            locked: !!bottleneckId && g._id !== bottleneckId,
            isBottleneck: false,
          })
        )

      // 目标内卡点子任务识别（约束理论在目标内部的投影）
      const open = subtasks.filter((s) => s.status !== 'completed')
      if (open.length) {
        const byId = {}
        subtasks.forEach((s) => { byId[s._id] = s })
        const isReady = (s) =>
          (s.dependencies || []).every((d) => !byId[d] || byId[d].status === 'completed')
        // 有多少未完成子任务直接依赖它（阻塞面）
        const blockedCount = (s) =>
          open.filter((o) => (o.dependencies || []).indexOf(s._id) > -1).length
        const score = (s) => (s.estimatedHours || 0) + blockedCount(s) * 2

        const clog = open.reduce((best, s) => {
          if (!best) return s
          if (isReady(s) !== isReady(best)) return isReady(s) ? s : best // 可推进的优先
          if (score(s) !== score(best)) return score(s) > score(best) ? s : best
          return best // 得分相同保持先出现者优先
        }, null)
        if (clog) clog.isBottleneck = true
      }

      return {
        _id: g._id,
        title: g.title,
        status: g.status,
        isBottleneck: g.isBottleneck,
        estimatedHours: g.estimatedHours,
        displayHours: g.displayHours,
        progress: g.progress,
        expanded: !!g._expanded,
        subtasks: subtasks,
        subDone: subtasks.filter((s) => s.status === 'completed').length,
        subTotal: subtasks.length,
      }
    })
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

  /** 展开/收起大目标的子任务列表 */
  toggleGoal(e) {
    const { id } = e.currentTarget.dataset
    const tasks = this.data.tasks.map((t) =>
      t._id === id ? Object.assign({}, t, { _expanded: !t._expanded }) : t
    )
    this.setData({ tasks })
    this.rerender()
  },

  /**
   * 子任务状态切换（点击开关）：
   * - 已完成 → 恢复为未完成（父大目标若已自动完成，则重新拉回在办并重算瓶颈）
   * - 未完成 → 完成（父目标被锁定时不可完成）；
   *   完成后若所属大目标下全部子任务完成 → 自动完成大目标（破裂动画）
   */
  async completeSubtask(e) {
    if (this.data.submitting) return
    const { id } = e.currentTarget.dataset
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
        // 父大目标已自动完成时，恢复为在办（重新参与瓶颈排序与在办计数）
        const parent = tasks.find((t) => t._id === sub.parentGoalId)
        if (parent && parent.status === 'completed') {
          tasks = tasks.map((t) =>
            t._id === parent._id
              ? Object.assign({}, t, {
                  status: 'pending',
                  isBottleneck: false,
                  _dirty: true,
                })
              : t
          )
        }
        this.setData({ tasks })
        this.rerender()
        await this.syncTasksToCloud(tasks)
        // 重算瓶颈与在办计数（父目标重新进入在办池，可能触发锁定切换）
        this.analyzeBottleneck(tasks)
        this.checkMultiTasking(tasks)
        wx.showToast({ title: '已恢复为未完成', icon: 'none' })
      } catch (err) {
        console.error('[index] 恢复子任务失败', err)
        wx.showToast({ title: '操作失败，请重试', icon: 'none' })
      } finally {
        this.setData({ submitting: false })
      }
      return
    }

    // 分支二：未完成 → 完成
    const parent = this.data.tasks.find((t) => t._id === sub.parentGoalId)
    if (parent && this.data.bottleneckId && parent._id !== this.data.bottleneckId) {
      wx.showToast({ title: '该目标已锁定，请先推进瓶颈目标', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    try {
      const tasks = this.data.tasks.map((t) =>
        t._id === id
          ? Object.assign({}, t, { status: 'completed', _dirty: true })
          : t
      )
      this.setData({ tasks })
      this.rerender()
      await this.syncTasksToCloud(tasks)

      // 联动：父大目标下全部子任务完成 → 大目标自动完成
      const parentTask = tasks.find((t) => t._id === sub.parentGoalId)
      const siblings = tasks.filter((t) => t.parentGoalId === sub.parentGoalId)
      if (
        parentTask &&
        parentTask.status !== 'completed' &&
        siblings.length &&
        siblings.every((s) => s.status === 'completed')
      ) {
        await this.autoCompleteGoal(parentTask)
      } else {
        wx.showToast({ title: '子任务已完成', icon: 'success' })
      }
    } catch (e) {
      console.error('[index] 子任务完成失败', e)
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  /**
   * 大目标自动完成（全部子任务完成后触发）：
   * 结算实际耗时 → 破裂动画 → 同步云端 → 重算瓶颈与在办计数。
   */
  async autoCompleteGoal(goalTask) {
    // 结算实际耗时（累计落库值 + 本次会话专注增量）
    let actualHours = (goalTask && goalTask.actualHours) || 0
    if (goalTask && goalTask.status === 'in_progress' && this.focusStartTs) {
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
   * 手动完成大目标：仅适用于"无子任务"的大目标（有子任务的由联动自动完成）。
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

    // 有未完成子任务的大目标不允许手动完成（由子任务联动自动完成）
    const subs = this.data.tasks.filter((t) => t.parentGoalId === id)
    if (subs.length && subs.some((s) => s.status !== 'completed')) {
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
