/**
 * tests/helpers/fake-api.js —— utils/api.js 的内存替身
 *
 * 用途：让依赖数据层的纯逻辑（utils/tree.js 的导入/同步、页面级状态流转）
 * 能在不接触真实云数据库的前提下被单测覆盖。
 *
 * 关键点：默认值与 utils/api.js 的 addTask 保持一致
 * （estimatedHours 缺省 1、level 缺省 0、status 初始 pending、modificationCount 初始 0），
 * 否则测试会掩盖真实链路里的默认值差异。
 */

'use strict'

const { clone } = require('./runtime')

/**
 * @param {Array} [initialTasks] 初始任务文档（可含 _id）
 * @returns {Object} 具备 loadTasks/addTask/updateTask/removeTask 的假 api，附断言辅助
 */
function createFakeApi(initialTasks) {
  let seq = 0
  const tasks = (initialTasks || []).map(clone)
  const calls = { add: [], update: [], remove: [], load: 0 }

  function nextId() {
    seq += 1
    return 't' + seq
  }

  return {
    async loadTasks() {
      calls.load += 1
      return tasks.map(clone)
    },

    async addTask(params) {
      const p = params || {}
      const now = Date.now()
      const doc = {
        _id: nextId(),
        title: p.title,
        description: p.description || '',
        estimatedHours: p.estimatedHours === undefined ? 1 : p.estimatedHours,
        actualHours: 0,
        status: 'pending',
        isBottleneck: false,
        dependencies: (p.dependencies || []).slice(),
        projectId: p.projectId || '',
        parentGoalId: p.parentGoalId || '',
        level: p.level === undefined ? 0 : p.level,
        aiHint: p.aiHint || '',
        userContext: null,
        suggestionHistory: [],
        createdAt: now,
        updatedAt: now,
        modificationCount: 0,
      }
      tasks.push(doc)
      calls.add.push(clone(doc))
      return clone(doc)
    },

    async updateTask(id, patch, opts) {
      const t = tasks.find((x) => x._id === id)
      if (!t) throw new Error('任务不存在: ' + id)
      Object.assign(t, clone(patch || {}), { updatedAt: Date.now() })
      calls.update.push({ id: id, patch: clone(patch || {}), opts: opts || {} })
    },

    async removeTask(id) {
      const i = tasks.findIndex((x) => x._id === id)
      if (i === -1) return
      tasks.splice(i, 1)
      calls.remove.push(id)
    },

    isGoal(t) {
      return !t.parentGoalId
    },

    // ---- 断言辅助 ----
    __tasks: tasks,
    __calls: calls,
    __byId(id) {
      return tasks.find((x) => x._id === id)
    },
    __byTitle(title) {
      return tasks.filter((x) => x.title === title)
    },
    __children(pid) {
      return tasks.filter((x) => x.parentGoalId === pid)
    },
  }
}

module.exports = { createFakeApi }
