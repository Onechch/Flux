/**
 * 云函数：checkMultiTasking
 *
 * 逻辑：统计未完成任务数量，超过 3 项返回警告（利特尔法则：多任务排队损耗）。
 * 两级任务模型下只统计大目标（parentGoalId 为空）—— 10 个子任务只算 1 个在办。
 * 返回：{ success: true, count: 4, isOverLimit: true, message: '...' }
 *
 * 调用方式（二选一）：
 * 1. 传入任务列表做纯计算：wx.cloud.callFunction({ name: 'checkMultiTasking', data: { tasks: [...] } })
 * 2. 不传 tasks 时自动按当前用户（OPENID）查询云端 tasks 集合
 *
 * 部署：微信开发者工具中右键 checkMultiTasking 目录 → 上传并部署（云端安装依赖）
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const LIMIT = 3

exports.main = async (event = {}) => {
  try {
    let tasks = event.tasks

    if (!Array.isArray(tasks)) {
      const { OPENID } = cloud.getWXContext()
      const res = await db
        .collection('tasks')
        .where({ _openid: OPENID })
        .limit(100)
        .get()
      tasks = res.data || []
    }

    // 在办只统计大目标（level 0）：子任务不计入
    const count = tasks.filter(
      (t) => t.status !== 'completed' && !t.parentGoalId
    ).length
    const isOverLimit = count > LIMIT

    return {
      success: true,
      count,
      isOverLimit,
      message: isOverLimit
        ? '在办大目标已超过' + LIMIT + '个（当前' + count + '个），多任务将导致效率下降约40%。建议先完成瓶颈目标。'
        : '',
    }
  } catch (e) {
    return { success: false, count: 0, isOverLimit: false, message: '', error: e.errMsg || e.message }
  }
}
