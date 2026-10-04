// pages/knowledge/index.js —— 知识库页（Agent 长期记忆）
//
// 功能：
// 1. 首次打开：api.initKnowledge 幂等写入预置理论（WIP/TOC/利特尔法则等 6 条）
// 2. Tabs：全部 / 待确认(N) / 理论 / 经验 / 模板（标签筛选）
// 3. 搜索框：关键词过滤 title/content/tags（前端内存过滤，数据量小）
// 4. 待确认条目：采纳（→active）/ 忽略（→ignored）/ 编辑
// 5. 已采纳条目：编辑 / 删除 / 评分（1-5星，再点同星取消）/ 引用次数展示
// 6. 手动添加知识：title + content + type + tags
//
// 数据操作全部走 utils/api.js（云优先 + 本地降级）；
// 提取类条目由拆解页对话后异步写入（status: 'pending'），在此确认。
//
// MVP 边界：不做语义检索、批量操作、云端共享。

const api = require('../../utils/api')
const knowledge = require('../../utils/knowledge')

Page({
  data: {
    loading: true,
    mode: 'cloud',
    all: [],              // 全部知识（内存态）
    list: [],             // 当前 tab + 搜索过滤后的展示列表
    pendingCount: 0,      // 待确认数
    activeCount: 0,       // 已采纳数
    tab: 'all',           // all | pending | theory | experience | template
    keyword: '',          // 搜索关键词
    // 添加 / 编辑表单
    showForm: false,
    formMode: 'add',      // add | edit
    editId: '',
    form: { title: '', content: '', type: 'user_experience', tagsText: '' },
    submitting: false,
  },

  onLoad() {
    this.bootstrap()
  },

  /** 初始化：预置理论（幂等）→ 加载全量 → 渲染 */
  async bootstrap() {
    this.setData({ mode: api.getMode() })
    await api.initKnowledge(knowledge.PRESET_THEORY)
    await this.reload()
  },

  async reload() {
    try {
      const all = await api.loadKnowledge()
      this.setData({ all, loading: false })
      this.applyFilter()
    } catch (e) {
      console.error('[knowledge] 加载失败', e)
      this.setData({ loading: false })
      wx.showToast({ title: '知识库加载失败', icon: 'none' })
    }
  },

  /* ---------------- 筛选与搜索 ---------------- */

  onTabTap(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({ tab })
    this.applyFilter()
  },

  onSearchInput(e) {
    this.setData({ keyword: e.detail.value })
    this.applyFilter()
  },

  /** 应用 tab 筛选 + 关键词过滤，更新列表与计数 */
  applyFilter() {
    const { all, tab, keyword } = this.data
    const kw = (keyword || '').trim().toLowerCase()

    let list = all.filter((k) => k.status !== 'ignored')
    if (tab === 'pending') {
      list = list.filter((k) => k.status === 'pending')
    } else if (tab !== 'all') {
      // 已采纳的才进入类型 tab
      list = list.filter((k) => k.status === 'active')
      if (tab === 'theory') list = list.filter((k) => k.type === 'theory')
      else if (tab === 'experience')
        list = list.filter((k) => k.type === 'user_experience' || k.type === 'best_practice')
      else if (tab === 'template') list = list.filter((k) => k.type === 'task_template')
    }

    if (kw) {
      list = list.filter(
        (k) =>
          (k.title || '').toLowerCase().indexOf(kw) > -1 ||
          (k.content || '').toLowerCase().indexOf(kw) > -1 ||
          (k.tags || []).some((t) => String(t).toLowerCase().indexOf(kw) > -1)
      )
    }

    this.setData({
      list: list.map((k) => Object.assign({}, k, { typeLabel: knowledge.typeLabel(k.type) })),
      pendingCount: all.filter((k) => k.status === 'pending').length,
      activeCount: all.filter((k) => k.status === 'active').length,
    })
  },

  /* ---------------- 待确认操作 ---------------- */

  /** 采纳：pending → active，Agent 即可在建议中检索到 */
  async onConfirm(e) {
    const { id } = e.currentTarget.dataset
    try {
      await api.updateKnowledge(id, { status: 'active' })
      wx.showToast({ title: '已采纳', icon: 'success' })
      await this.reload()
    } catch (err) {
      console.error('[knowledge] 采纳失败', err)
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    }
  },

  /** 忽略：pending → ignored（不再显示，保留记录可追溯） */
  async onIgnore(e) {
    const { id } = e.currentTarget.dataset
    try {
      await api.updateKnowledge(id, { status: 'ignored' })
      wx.showToast({ title: '已忽略', icon: 'none' })
      await this.reload()
    } catch (err) {
      console.error('[knowledge] 忽略失败', err)
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    }
  },

  /* ---------------- 添加 / 编辑 ---------------- */

  openAddForm() {
    this.setData({
      showForm: true,
      formMode: 'add',
      editId: '',
      form: { title: '', content: '', type: 'user_experience', tagsText: '' },
    })
  },

  openEditForm(e) {
    const { id } = e.currentTarget.dataset
    const k = this.data.all.find((x) => x._id === id)
    if (!k) return
    this.setData({
      showForm: true,
      formMode: 'edit',
      editId: id,
      form: {
        title: k.title,
        content: k.content,
        type: k.type === 'theory' ? 'theory' : k.type,
        tagsText: (k.tags || []).join('、'),
      },
    })
  },

  closeForm() {
    this.setData({ showForm: false })
  },

  onFormTitle(e) {
    this.setData({ 'form.title': e.detail.value })
  },

  onFormContent(e) {
    this.setData({ 'form.content': e.detail.value })
  },

  onFormType(e) {
    this.setData({ 'form.type': e.detail.value })
  },

  onFormTags(e) {
    this.setData({ 'form.tagsText': e.detail.value })
  },

  /** 提交添加/编辑：标签按中英文逗号/顿号拆分，去空去重 */
  async submitForm() {
    if (this.data.submitting) return
    const title = (this.data.form.title || '').trim()
    const content = (this.data.form.content || '').trim()
    if (!title || !content) {
      wx.showToast({ title: '标题和内容不能为空', icon: 'none' })
      return
    }
    const tags = Array.from(
      new Set(
        (this.data.form.tagsText || '')
          .split(/[,，、\s]+/)
          .map((t) => t.trim())
          .filter((t) => !!t)
      )
    ).slice(0, 5)

    this.setData({ submitting: true })
    try {
      if (this.data.formMode === 'add') {
        await api.addKnowledge({
          title: title,
          content: content,
          type: this.data.form.type,
          tags: tags,
          status: 'active',
          source: 'manual',
        })
        wx.showToast({ title: '已添加', icon: 'success' })
      } else {
        await api.updateKnowledge(this.data.editId, {
          title: title,
          content: content,
          type: this.data.form.type,
          tags: tags,
        })
        wx.showToast({ title: '已保存', icon: 'success' })
      }
      this.setData({ showForm: false })
      await this.reload()
    } catch (err) {
      console.error('[knowledge] 保存失败', err)
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  /* ---------------- 删除 / 评分 ---------------- */

  onDelete(e) {
    const { id } = e.currentTarget.dataset
    const k = this.data.all.find((x) => x._id === id)
    if (!k) return
    wx.showModal({
      title: '删除知识',
      content: '「' + k.title + '」将被删除，Agent 将不再引用它。',
      confirmText: '删除',
      confirmColor: '#E5484D',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) this.executeDelete(id)
      },
    })
  },

  async executeDelete(id) {
    try {
      await api.removeKnowledge(id)
      wx.showToast({ title: '已删除', icon: 'success' })
      await this.reload()
    } catch (err) {
      console.error('[knowledge] 删除失败', err)
      wx.showToast({ title: '删除失败，请重试', icon: 'none' })
    }
  },

  /** 评分：点第 N 星评 N 分；点当前分同星取消评分（归 0） */
  async onRate(e) {
    const { id, star } = e.currentTarget.dataset
    const k = this.data.all.find((x) => x._id === id)
    if (!k) return
    const n = parseInt(star, 10)
    const rating = k.rating === n ? 0 : n
    try {
      await api.updateKnowledge(id, { rating: rating })
      await this.reload()
    } catch (err) {
      console.error('[knowledge] 评分失败', err)
      wx.showToast({ title: '评分失败，请重试', icon: 'none' })
    }
  },
})
