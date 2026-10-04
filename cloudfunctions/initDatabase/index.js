/**
 * 云函数：initDatabase
 *
 * 作用：创建 tasks / projects / knowledge / op_logs 四个集合（幂等，可重复调用），
 *       并返回各集合的索引规格与数据安全规则，供控制台一次性配置。
 *
 * 说明：
 * 1. 集合创建属于管理操作，客户端 SDK 不支持，因此放在云函数中执行；
 * 2. 默认示例任务与预置理论知识均由客户端首次打开时写入（保证"仅创建者可读写"
 *    权限下，云函数种的数据客户端不可见，故种子数据必须在客户端写入；
 *    理论知识由 miniprogram/utils/knowledge.js 的 PRESET_THEORY 提供）；
 * 3. 索引创建：wx-server-sdk 不提供索引管理 API，返回的 indexSpecs 需在
 *    云开发控制台 → 数据库 → 对应集合 → 索引管理 中手动创建（一次性操作）；
 *    数据量 < 100 条时无索引不影响功能，仅影响排序扫描效率；
 * 4. 数据安全规则：需在控制台 → 数据库 → 对应集合 → 权限设置 → 自定义安全规则
 *    中粘贴 securityRules（四个集合相同，均为"仅创建者可读写"）。
 *
 * 部署：在微信开发者工具中右键 initDatabase 目录 → 上传并部署（云端安装依赖）。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const COLLECTIONS = ['tasks', 'projects', 'knowledge', 'op_logs']

// 各集合建议索引（按实际查询模式定义，返回给调用方便于控制台配置）
const INDEX_SPECS = {
  tasks: [
    { name: 'createdAt_asc', fields: 'createdAt 升序（loadTasks 排序）' },
    { name: 'parentGoalId_status', fields: 'parentGoalId 升序 + status 升序（任务树按父节点查子任务）' },
  ],
  knowledge: [
    { name: 'createdAt_asc', fields: 'createdAt 升序（loadKnowledge 排序）' },
    { name: 'status_type', fields: 'status 升序 + type 升序（active 知识检索筛选）' },
  ],
  op_logs: [
    { name: 'openid_createdAt', fields: '_openid 升序 + createdAt 降序（按用户查最近操作日志）' },
  ],
}

// 数据安全规则（四个集合相同：仅创建者可读写；云函数以管理权限读写不受限）
const SECURITY_RULES = {
  read: 'auth.openid == resource.openid',
  write: 'auth.openid == resource.openid',
}

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
    indexSpecs: INDEX_SPECS,
    securityRules: SECURITY_RULES,
    message:
      errors.length === 0
        ? '集合就绪：tasks, projects, knowledge, op_logs（索引与安全规则见 indexSpecs/securityRules，需在控制台配置）'
        : '部分集合创建失败，请检查云数据库权限',
  }
}
