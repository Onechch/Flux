/**
 * 云函数：initDatabase
 *
 * 作用：创建 tasks / projects 两个集合（幂等，可重复调用）。
 *
 * 说明：
 * 1. 集合创建属于管理操作，客户端 SDK 不支持，因此放在云函数中执行；
 * 2. 默认示例任务由客户端首次打开时写入（保证"仅创建者可读写"权限下，
 *    云函数种的数据客户端不可见，故种子数据必须在客户端写入）。
 *
 * 部署：在微信开发者工具中右键 initDatabase 目录 → 上传并部署（云端安装依赖）。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const COLLECTIONS = ['tasks', 'projects']

exports.main = async () => {
  const created = []
  const errors = []

  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name)
      created.push(name)
    } catch (e) {
      // 集合已存在视为成功（TCB 错误码 -501001 / DATABASE_COLLECTION_EXISTS）
      const msg = e.errMsg || e.message || ''
      const exists =
        e.errCode === -501001 ||
        msg.indexOf('exists') > -1 ||
        msg.indexOf('already exist') > -1
      if (!exists) {
        errors.push({ collection: name, errCode: e.errCode, errMsg: msg })
      }
    }
  }

  return {
    success: errors.length === 0,
    created,
    errors,
    message: errors.length === 0 ? '集合就绪：tasks, projects' : '部分集合创建失败，请检查云数据库权限',
  }
}
