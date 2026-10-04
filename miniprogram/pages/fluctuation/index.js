// pages/fluctuation/index.js —— 波动预警页（需求波动 / 牛鞭效应检测）
//
// 功能：
// 1. 概览：总变更数、近 7 天变更数、风险数；日志被截断时显式提示"计数为下界"
// 2. 变更分布：按层级聚合（定位"变更集中在哪一层"）+ 变更最多的节点排行
// 3. 风险列表：四类风险（源头反复变 / 计划被放大 / 近期集中变更 / 工时估不准），
//    每条给出结构化证据 + 中文解释 + 可执行建议
// 4. 重新排期：按「父节点耗时 = 子合计」不变式重算目标子树，先列出修正项，
//    用户确认后一次性写库（countModification:false —— 系统行为不计入波动数据）
// 5. 去调优：跳转流程拆解页对该目标进入对话调优（与首页同一入口）
//
// 数据全部来自 utils/api.js（云优先 + 本地降级），算法在 utils/fluctuation.js（纯逻辑）。
// 本页只读不写：唯一的写操作是用户主动确认的"重新排期"。
//
// MVP 边界：不做跨目标对比、不做历史趋势图（changeLog 上限 20 条，样本不足以画趋势）。

const api = require('../../utils/api')
const fluctuation = require('../../utils/fluctuation')

/** 风险类型 → 样式类名（颜色区分，配合 index.wxss） */
const KIND_CLASS = {
  unstable_root: 'k-root',
  amplified: 'k-amp',
  burst: 'k-burst',
  estimate_churn: 'k-est',
}

Page({
  data: {
    loading: true,
    mode: 'cloud',
    ready: false,          // 有任务数据才渲染正文
    summary: null,
    risks: [],
    goals: [],
    depthBars: [],
    topChanges: [],
    showThresholds: false,
    thresholdText: '',
    // 重新排期弹层
    plan: null,
    applying: false,
  },

  onLoad() {
    // 返回 Promise 便于测试 await；小程序运行时忽略返回值
    return this.bootstrap()
  },

  onShow() {
    // 从首页/拆解页返回时刷新（数据可能已变）；首次加载由 onLoad 负责
    if (!this.data.loading) return this.reload()
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh())
  },

  async bootstrap() {
    try {
      await api.initDatabase()
      this.setData({ mode: api.getMode() })
    } catch (e) {
      console.error('[fluctuation] 初始化失败', e)
    }
    await this.reload()
  },

  /** 加载任务 → 跑波动分析 → 生成视图模型 */
  async reload() {
    this.setData({ loading: true })
    try {
      const tasks = await api.loadTasks()
      this.tasks = tasks // 留在实例上，避免大数组进 setData
      this.render(tasks)
    } catch (e) {
      console.error('[fluctuation] 加载失败', e)
      wx.showToast({ title: e.message || '加载失败，可下拉重试', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  /** 纯函数：分析结果 → 视图模型（WXML 无法调用函数，全部在这里算好） */
  render(tasks) {
    const res = fluctuation.analyzeFluctuation(tasks)
    const s = res.summary

    const risks = res.risks.map((r) => ({
      key: r.kind + '-' + r.taskId,
      taskId: r.taskId,
      title: r.title || '(未命名)',
      goalTitle: r.goalTitle || '(未命名)',
      kind: r.kind,
      kindLabel: fluctuation.riskKindLabel(r.kind),
      kindClass: KIND_CLASS[r.kind] || 'k-est',
      depthText: r.isRoot ? '大目标' : '第 ' + r.depth + ' 层',
      message: r.message,
      advice: r.advice,
      evidence: evidenceOf(r),
    }))

    const goals = res.goals.map((g) => ({
      goalId: g.goalId,
      title: g.title || '(未命名)',
      subtreeChanges: g.subtreeChanges,
      ownChanges: g.ownChanges,
      subtreeNodes: g.subtreeNodes,
      riskCount: g.riskCount,
      totalHours: g.totalHours,
      hotText: g.hotNodes.length
        ? g.hotNodes.map((h) => h.title + '(' + h.ownChanges + ')').join('、')
        : '暂无变更',
    }))

    let maxDepthChanges = 1
    res.byDepth.forEach((d) => {
      if (d.changes > maxDepthChanges) maxDepthChanges = d.changes
    })
    const depthBars = res.byDepth.map((d) => ({
      depth: d.depth,
      depthText: d.depth === 0 ? '大目标' : '第 ' + d.depth + ' 层',
      nodes: d.nodes,
      changes: d.changes,
      percent: Math.round((d.changes / maxDepthChanges) * 100),
    }))

    const topChanges = res.metrics
      .filter((m) => m.ownChanges > 0)
      .slice(0, 8)
      .map((m) => ({
        taskId: m.taskId,
        title: m.title || '(未命名)',
        depthText: m.isRoot ? '大目标' : '第 ' + m.depth + ' 层',
        ownChanges: m.ownChanges,
        recentChanges: m.recentChanges,
      }))

    const t = res.thresholds
    this.setData({
      ready: s.taskCount > 0,
      summary: {
        taskCount: s.taskCount,
        goalCount: s.goalCount,
        totalChanges: s.totalChanges,
        recentChanges: s.recentChanges,
        riskCount: s.riskCount,
        logTruncated: s.logTruncated,
        windowDays: res.windowDays,
      },
      risks: risks,
      goals: goals,
      depthBars: depthBars,
      topChanges: topChanges,
      thresholdText:
        '变更次数 ≥ ' + t.minChanges + ' 且达到需求源头变更量的 ' + t.ampRatio +
        ' 倍 → 判为「计划被放大」；' + res.windowDays + ' 天内变更 ≥ ' + t.burst +
        ' 次 → 判为「近期集中变更」；预估工时被调整 ≥ ' + t.estimateChurn +
        ' 次 → 判为「工时估算反复调整」；大目标自身变更 ≥ ' + t.rootUnstable +
        ' 次 → 判为「需求源头反复变更」。状态流转不计入变更次数。',
    })
  },

  /* ---------------- 交互 ---------------- */

  onToggleThresholds() {
    this.setData({ showThresholds: !this.data.showThresholds })
  },

  /** 弹层内部点击不关闭弹层（配合 catchtap 阻断冒泡到遮罩） */
  onNoop() {},

  /** 空状态：去首页创建目标 */
  goIndex() {
    wx.switchTab({ url: '/pages/index/index' })
  },

  /** 风险卡「去调优」：暂存目标 ID，跳转拆解页进入对话调优模式 */
  onRefine(e) {
    const goalId = e.currentTarget.dataset.goal
    if (!goalId) return
    try {
      wx.setStorageSync('po_pending_refine', goalId)
    } catch (err) {
      console.warn('[fluctuation] 调优目标 ID 写入失败', err)
    }
    wx.switchTab({ url: '/pages/breakdown/index' })
  },

  /** 「重新排期」：先算方案（不写库），弹层展示修正项供用户确认 */
  onPlanTap(e) {
    const goalId = e.currentTarget.dataset.id
    const plan = fluctuation.planReschedule(this.tasks || [], goalId)
    if (!plan.ok) {
      wx.showToast({ title: plan.reason || '无法重排', icon: 'none' })
      return
    }
    if (!plan.updates.length) {
      wx.showToast({ title: '排期已一致，无需重排', icon: 'none' })
      return
    }
    this.setData({
      plan: {
        goalId: plan.goalId,
        title: plan.title || '(未命名)',
        totalHours: plan.totalHours,
        updates: plan.updates,
        layers: plan.layers,
        layerText: plan.layers.length
          ? plan.layers
              .map(
                (l) =>
                  '第 ' + l.depth + ' 层：关键路径 ' + l.layerHours + 'h（' + l.criticalPath.join(' → ') + '）'
              )
              .join('；')
          : '无子任务',
      },
    })
  },

  onPlanCancel() {
    this.setData({ plan: null })
  },

  /** 确认重排：按修正项写库。必须 countModification:false（系统行为不污染波动数据） */
  async onPlanApply() {
    const plan = this.data.plan
    if (!plan || !plan.updates.length || this.data.applying) return
    this.setData({ applying: true })
    wx.showLoading({ title: '重新排期中…', mask: true })
    try {
      for (const u of plan.updates) {
        await api.updateTask(u.taskId, { estimatedHours: u.to }, { countModification: false })
      }
      wx.hideLoading()
      wx.showToast({ title: '已按最新耗时重排', icon: 'success' })
      this.setData({ plan: null })
      await this.reload()
    } catch (e) {
      wx.hideLoading()
      console.error('[fluctuation] 重新排期失败', e)
      wx.showToast({ title: e.message || '重新排期失败', icon: 'none' })
    } finally {
      this.setData({ applying: false })
    }
  },
})

/** 把结构化证据拼成一行"凭什么判它"（与 message 互补：这里是数字，message 是解释） */
function evidenceOf(r) {
  const parts = []
  if (r.kind === 'unstable_root') {
    parts.push('自身变更 ' + r.ownChanges + ' 次')
    if (r.recentChanges) parts.push('近期 ' + r.recentChanges + ' 次')
  } else if (r.kind === 'amplified') {
    parts.push('本层 ' + r.ownChanges + ' 次 / 源头 ' + r.rootChanges + ' 次')
    parts.push('放大 ' + r.pathAmp + '×')
    parts.push('本层子树累计 ' + r.subtreeChanges + ' 次')
  } else if (r.kind === 'burst') {
    parts.push('近期 ' + r.recentChanges + ' 次')
    parts.push('累计 ' + r.ownChanges + ' 次')
  } else if (r.kind === 'estimate_churn') {
    parts.push('调整 ' + r.estimateChanges + ' 次')
    if (r.estimateSpread > 0) parts.push('幅度 ' + r.estimateSpread + 'h')
  }
  if (r.subtreeNodes > 1) parts.push('子树 ' + r.subtreeNodes + ' 个节点')
  return parts.join(' · ')
}
