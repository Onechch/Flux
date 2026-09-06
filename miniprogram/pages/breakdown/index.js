// pages/breakdown/index.js —— 流程拆解页
//
// 第三步实现：
// 1. 输入目标 → 三层降级获取子任务列表：
//    层1 云函数 breakdownTask（服务端 AI）
//    层2 客户端直调 wx.cloud.extend.AI（云函数未部署/服务端 AI 失败时）
//    层3 预设示例数据（AI 全链路不可用）
// 2. utils/cpm.js 计算关键路径，红色高亮 + 总工期
// 3. 一键导入首页：按任务名去重 → 创建任务 → 回填依赖（任务名 → 任务ID）
//
// MVP 边界：不做拖拽排序、甘特图、实时流式输出（等待完整结果）。

const cpm = require('../../utils/cpm')
const api = require('../../utils/api')
const ai = require('../../utils/ai')

// 第三层降级：与云函数 breakdownTask 的 FALLBACK_TASKS 保持一致
const FALLBACK_TASKS = [
  { name: '明确目标范围', estimatedHours: 1, dependencies: [] },
  { name: '收集资料', estimatedHours: 2, dependencies: ['明确目标范围'] },
  { name: '撰写初稿', estimatedHours: 4, dependencies: ['收集资料'] },
  { name: '修改完善', estimatedHours: 2, dependencies: ['撰写初稿'] },
  { name: '最终审核', estimatedHours: 1, dependencies: ['修改完善'] },
]

Page({
  data: {
    goal: '',             // 用户输入的目标
    tasks: [],            // 拆解结果（含 isCritical / depText）
    criticalPathText: '', // 关键路径链文本（A → B → C）
    totalDuration: 0,     // 关键路径总工期（小时）
    isLoading: false,     // 拆解中（AI 调用限流：防重复点击）
    hasResult: false,     // 是否已有拆解结果
    importing: false,     // 导入中（防重复点击）
    aiFallback: false,    // 是否使用了降级示例数据
  },

  onGoalInput(e) {
    this.setData({ goal: e.detail.value })
  },

  /** 智能拆解：获取子任务 → 计算关键路径 → 渲染 */
  async handleBreakdown() {
    if (this.data.isLoading) return // AI 调用限流
    const goal = (this.data.goal || '').trim()
    if (!goal) {
      wx.showToast({ title: '请输入目标', icon: 'none' })
      return
    }
    this.setData({ isLoading: true })
    try {
      const { tasks, source, reason } = await this.requestBreakdown(goal)
      const result = cpm.calculateCriticalPath(tasks)
      if (!result.tasks.length) throw new Error('拆解结果为空')
      this.setData({
        tasks: result.tasks,
        criticalPathText: result.criticalPath.join(' → '),
        totalDuration: result.totalDuration,
        hasResult: true,
        aiFallback: source === 'fallback',
      })
      if (source === 'fallback') {
        wx.showToast({
          title:
            reason === 'rate-limit'
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

  /**
   * 三层降级获取拆解结果：
   * 层1 客户端直调 wx.cloud.extend.AI（官方明确支持的路径，无需部署云函数）
   * 层2 云函数 breakdownTask（服务端 AI，适合未来逻辑复杂化时）
   * 层3 预设示例数据
   */
  async requestBreakdown(goal) {
    // 层1：客户端直调（官方文档路径，基础库 ≥ 3.7.1 + 环境开通 AI+）
    let clientError = null
    try {
      const tasks = await ai.breakdownGoal(goal)
      return { tasks: tasks, source: 'ai' }
    } catch (e) {
      clientError = e
      console.warn('[breakdown] 客户端 AI 直调失败', e)
    }

    // 429 限流：额度按环境计，立即调云函数只会叠加请求，直接降级示例
    if (clientError && ai.isRateLimited(clientError)) {
      return { tasks: FALLBACK_TASKS, source: 'fallback', reason: 'rate-limit' }
    }

    // 层2：云函数 breakdownTask
    let preset = null
    try {
      const res = await wx.cloud.callFunction({
        name: 'breakdownTask',
        data: { goal: goal },
      })
      const r = res && res.result
      if (r && r.success && Array.isArray(r.tasks) && r.tasks.length) {
        return { tasks: r.tasks, source: 'ai' }
      }
      // 云函数内部 AI 失败：结果已带预设示例，记下备用后继续走层3
      if (r && Array.isArray(r.tasks) && r.tasks.length) {
        preset = r.tasks
      }
    } catch (e) {
      console.warn('[breakdown] 云函数不可用，使用预设示例', e)
    }

    // 层3：预设示例数据
    return { tasks: preset || FALLBACK_TASKS, source: 'fallback' }
  },

  /**
   * 一键导入首页任务列表（两级任务模型）：
   * 1. 创建/复用"大目标"（level 0，预估耗时 = 子任务合计）
   * 2. 逐项创建子任务（level 1，parentGoalId 挂到大目标；按任务名与现有任务去重）
   * 3. 回填子任务间依赖（任务名 → 已创建任务 _id，与 tasks 集合 schema 对齐）
   */
  async handleImport() {
    if (this.data.importing || !this.data.tasks.length) return
    this.setData({ importing: true })
    wx.showLoading({ title: '导入中…', mask: true })
    try {
      const existing = await api.loadTasks()
      const idByName = {}
      existing.forEach((t) => {
        if (t.title) idByName[t.title] = t._id
      })

      // 1. 创建/复用大目标（按目标名去重；耗时取拆解结果合计）
      const goalTitle = (this.data.goal || '').trim()
      const goalHours =
        Math.round(
          this.data.tasks.reduce((sum, t) => sum + (t.estimatedHours || 0), 0) * 10
        ) / 10
      let goalId = idByName[goalTitle]
      let imported = 0
      let skipped = 0
      if (!goalId) {
        const goalDoc = await api.addTask({
          title: goalTitle,
          estimatedHours: goalHours,
        })
        goalId = goalDoc._id
        idByName[goalTitle] = goalId
        imported++
      } else {
        skipped++ // 大目标已存在：复用，只补子任务
      }

      // 2. 创建子任务（level 1，挂到 goalId；按名称全局去重）
      for (const t of this.data.tasks) {
        if (idByName[t.name]) {
          skipped++
          continue
        }
        const doc = await api.addTask({
          title: t.name,
          estimatedHours: t.estimatedHours,
          parentGoalId: goalId,
          level: 1,
        })
        idByName[t.name] = doc._id
        imported++
      }

      // 3. 回填子任务间依赖（创建动作的一部分，不计入修改次数）
      for (const t of this.data.tasks) {
        const id = idByName[t.name]
        if (!id || id === goalId) continue
        const depIds = (t.dependencies || [])
          .map((d) => idByName[d])
          .filter((id2) => !!id2 && id2 !== id)
        if (depIds.length) {
          await api.updateTask(id, { dependencies: depIds }, { countModification: false })
        }
      }

      wx.hideLoading()
      if (imported > 0) {
        wx.showToast({
          title: '已导入目标及 ' + imported + ' 项子任务',
          icon: 'success',
        })
        // 跳回首页，onShow 会自动刷新并重算瓶颈
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
})
