// app.js —— 个人运营官
App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('基础库版本过低（需 ≥ 3.7.1），无法使用云开发能力，数据将仅存本地')
      return
    }
    wx.cloud.init({
      // 云开发环境 ID（成长计划免费环境）
      env: 'cloud1-d1glmx6wl7de7c5c6',
      traceUser: true,
    })
  },
  globalData: {},
})
