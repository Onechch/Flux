/**
 * 云函数：analyzeBottleneck
 *
 * 逻辑：查询所有未完成任务，按"预计耗时最长"识别瓶颈（约束理论 TOC）。
 * 两级任务模型下只认大目标（parentGoalId 为空），子任务不参与瓶颈识别。
 * 返回：{ success: true, bottleneckId: 'xxx', reason: '该目标耗时最长，是当前系统瓶颈' }
 * 无大目标或只有一个大目标时返回 bottleneckId: null（无需锁定）。
 *
 * 调用方式（二选一）：
 * 1. 传入任务列表做纯计算（快，无数据库 IO）：
 *    wx.cloud.callFunction({ name: 'analyzeBottleneck', data: { tasks: [...] } })
 * 2. 不传 tasks 时自动按当前用户（OPENID）查询云端 tasks 集合
 *
 * 部署：微信开发者工具中右键 analyzeBottleneck 目录 → 上传并部署（云端安装依赖）
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

exports.main = async (event = {}) => {
  try {
    let activeTasks = event.tasks

    // 未传任务列表时，按 OPENID 查询当前用户未完成任务
    if (!Array.isArray(activeTasks)) {
      const { OPENID } = cloud.getWXContext()
      const res = await db
        .collection('tasks')
        .where({ _openid: OPENID, status: db.command.neq('completed') })
        .limit(100)
        .get()
      activeTasks = res.data || []
    }

    // 只认大目标（level 0）：子任务不参与瓶颈识别
    const activeGoals = activeTasks.filter(
      (t) => t.status !== 'completed' && !t.parentGoalId
    )

    if (!activeGoals.length) {
      return { success: true, bottleneckId: null, reason: '暂无未完成大目标' }
    }
    if (activeGoals.length === 1) {
      // 单一大目标无需锁定（避免自我阻塞）
      return { success: true, bottleneckId: null, reason: '仅剩一个大目标，无需瓶颈锁定' }
    }

    // 按预计耗时降序，取第一名为瓶颈
    const sorted = [...activeGoals].sort(
      (a, b) => (b.estimatedHours || 0) - (a.estimatedHours || 0)
    )
    const bottleneck = sorted[0]

    return {
      success: true,
      bottleneckId: bottleneck._id,
      reason:
        '该目标耗时最长（预估 ' + (bottleneck.estimatedHours || 0) + 'h），是当前系统瓶颈',
    }
  } catch (e) {
    return { success: false, bottleneckId: null, error: e.errMsg || e.message }
  }
}
