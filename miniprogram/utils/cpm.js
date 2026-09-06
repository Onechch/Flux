/**
 * utils/cpm.js —— 关键路径算法（CPM，Critical Path Method）
 *
 * 输入：[{ name, estimatedHours, dependencies: [前置任务名] }]
 * 输出：{
 *   tasks:          [...同输入，附加 isCritical 标记与 depText 展示文本],
 *   criticalPath:   [任务名]（按执行顺序），
 *   totalDuration:  项目总工期（小时，关键路径长度）
 * }
 *
 * 实现步骤：
 * 1. 归一化：任务名去重、剔除自依赖/指向不存在任务的依赖、耗时兜底
 * 2. 拓扑排序（Kahn 算法）计算每个任务的最早开始时间 earliestStart
 * 3. 总工期 = 各任务"最早开始 + 耗时"的最大值
 * 4. 从最晚完成的任务回溯：每步选择"完成时间最晚"的前置依赖 → 得到关键路径
 * 5. 标记 isCritical
 *
 * 健壮性：依赖成环时按 earliestStart=0 兜底（不阻塞渲染）；数据量 < 20，
 * 前端 O(n²) 计算无性能问题。
 */

function calculateCriticalPath(rawTasks) {
  // 1. 归一化
  const tasks = []
  const nameMap = {} // name -> task
  if (Array.isArray(rawTasks)) {
    rawTasks.forEach((raw) => {
      const name = String(raw && raw.name ? raw.name : '').trim()
      if (!name || nameMap[name]) return
      let hours = Number(raw.estimatedHours)
      if (!isFinite(hours) || hours <= 0) hours = 1
      const deps = []
      if (Array.isArray(raw.dependencies)) {
        raw.dependencies.forEach((d) => {
          const dep = String(d || '').trim()
          if (dep && dep !== name && deps.indexOf(dep) === -1) deps.push(dep)
        })
      }
      nameMap[name] = { name: name, estimatedHours: hours, dependencies: deps }
      tasks.push(nameMap[name])
    })
  }
  // 剔除指向不存在任务名的依赖（AI 输出可能虚构依赖名）
  tasks.forEach((t) => {
    t.dependencies = t.dependencies.filter((d) => !!nameMap[d])
  })

  if (!tasks.length) {
    return { tasks: [], criticalPath: [], totalDuration: 0 }
  }

  // 2. 拓扑排序（Kahn）：计算最早开始时间
  const inDegree = {}
  const successors = {} // name -> 下游任务名列表
  tasks.forEach((t) => {
    inDegree[t.name] = t.dependencies.length
    t.dependencies.forEach((d) => {
      if (!successors[d]) successors[d] = []
      successors[d].push(t.name)
    })
  })

  const earliestStart = {}
  const queue = []
  tasks.forEach((t) => {
    if (inDegree[t.name] === 0) queue.push(t.name)
  })
  while (queue.length) {
    const cur = queue.shift()
    const task = nameMap[cur]
    let es = 0
    task.dependencies.forEach((d) => {
      es = Math.max(es, earliestStart[d] + nameMap[d].estimatedHours)
    })
    earliestStart[cur] = es
    const next = successors[cur] || []
    for (let i = 0; i < next.length; i++) {
      inDegree[next[i]] -= 1
      if (inDegree[next[i]] === 0) queue.push(next[i])
    }
  }
  // 成环的残留任务兜底为 0，保证后续计算不出现 undefined
  tasks.forEach((t) => {
    if (earliestStart[t.name] === undefined) earliestStart[t.name] = 0
  })

  // 3. 完成时间与总工期
  const finish = {}
  let totalDuration = 0
  tasks.forEach((t) => {
    finish[t.name] = earliestStart[t.name] + t.estimatedHours
    if (finish[t.name] > totalDuration) totalDuration = finish[t.name]
  })

  // 4. 回溯关键路径：从最晚完成的任务，沿"完成时间最晚的依赖"回溯
  const criticalPath = []
  let current = tasks[0]
  tasks.forEach((t) => {
    if (finish[t.name] > finish[current.name]) current = t
  })
  const visited = {} // 防环保护
  while (current && !visited[current.name]) {
    visited[current.name] = true
    criticalPath.unshift(current.name)
    let prev = null
    current.dependencies.forEach((d) => {
      if (!prev || finish[d] > finish[prev.name]) prev = nameMap[d]
    })
    current = prev
  }

  // 5. 标记关键路径 + 生成依赖展示文本
  const criticalSet = {}
  criticalPath.forEach((n) => {
    criticalSet[n] = true
  })
  const marked = tasks.map((t) => ({
    name: t.name,
    estimatedHours: t.estimatedHours,
    dependencies: t.dependencies,
    isCritical: !!criticalSet[t.name],
    depText: t.dependencies.length ? t.dependencies.join('、') : '无',
  }))

  return {
    tasks: marked,
    criticalPath: criticalPath,
    totalDuration: Math.round(totalDuration * 10) / 10, // 保留 1 位小数
  }
}

module.exports = {
  calculateCriticalPath,
}
