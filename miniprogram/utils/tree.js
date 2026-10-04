/**
 * utils/tree.js —— 多层级任务树工具集
 *
 * 支撑"动态多层级拆解"（1-5 层，深度由目标复杂度自适应）：
 * - normalizeTree：AI 输出的任务树归一化（与云函数 breakdownTask 同逻辑，
 *   客户端直调时复用，保证两层行为一致）
 * - buildTreeFromTasks：DB 扁平任务 → 目标任务树（首页渲染 / AI 调优传参）
 * - annotateTreeCPM：每层跑 CPM（同层依赖）+ 每层瓶颈标注
 * - findBottleneckChain：卡点链（每层瓶颈逐层向下，最深层 = 用户应立即行动的卡点）
 * - flattenForDisplay：树 → 拍平行列表（缩进 + 展开/折叠，WXML 单层 wx:for 渲染）
 * - importTreeToDb：AI 拆解树递归导入 DB（含同层依赖回填）
 * - syncTreeToDb：调优树差异同步（新增/更新耗时/递归删除，已完成保留）
 * - computeAutoCompleted：递归完成联动（全部子完成 → 父自动完成，向上传播）
 * - removeSubtreeById：递归删除整个子树
 * - ruleRefineTree：规则调优树版（与云函数 refineTask 保持一致，AI 不可用降级）
 *
 * 树节点统一结构（归一化 / DB 构建后）：
 * { _id, title, estimatedHours, actualHours, status, dependencies[同层任务名],
 *   aiHint, children[], depth, isCritical, isBottleneck, isClog }
 *
 * DB 模型不变（tasks 集合）：level 0 = 大目标，level 1..N = 各层子任务，
 * parentGoalId 指向直接父节点 —— 多层级只是放宽了 level 上限（≤ 5）。
 */

const cpm = require('./cpm')

// ---- 树归一化约束（与云函数 breakdownTask / refineTask 保持一致） ----
const MAX_DEPTH = 5        // 最多 5 层（根为第 0 层）
const MAX_CHILDREN = 8     // 每节点最多 8 个子任务
const MAX_NODES = 40       // 全树最多 40 个节点

/**
 * 归一化单个树节点（递归）：
 * - title 截断 30 字、同父去重；深度/广度/总节点数硬约束
 * - 叶子（无 children）耗时 clamp(0.5, 200)；父节点耗时 = 直接子任务合计
 * - 父节点的 bottleneck/bottleneckReason 命中子任务时转移到该子节点 aiHint
 */
function normalizeNode(raw, depth, stats) {
  const title = String(raw && raw.title ? raw.title : '').trim().slice(0, 30)
  if (!title) return null
  stats.count += 1

  let children = []
  if (Array.isArray(raw.children) && depth < MAX_DEPTH) {
    const seen = {}
    raw.children.slice(0, MAX_CHILDREN).forEach((c) => {
      if (stats.count >= MAX_NODES) return
      const n = normalizeNode(c, depth + 1, stats)
      if (n && !seen[n.title]) {
        seen[n.title] = true
        children.push(n)
      }
    })
  }

  let hours = Number(raw.estimatedHours)
  if (!isFinite(hours) || hours <= 0) hours = 0
  const deps = Array.isArray(raw.dependencies)
    ? raw.dependencies
        .map((d) => String(d || '').trim().slice(0, 30))
        .filter((d) => d && d !== title)
    : []

  const node = {
    title: title,
    estimatedHours: 0,
    dependencies: deps,
    isExecutable: children.length === 0,
    aiHint: '',
    children: children,
  }

  if (children.length) {
    node.estimatedHours =
      Math.round(children.reduce((s, c) => s + (c.estimatedHours || 0), 0) * 10) / 10
    const bn = String(raw.bottleneck || '').trim()
    const br = String(raw.bottleneckReason || '').trim().slice(0, 40)
    if (bn && br) {
      const hit = children.find((c) => c.title === bn || c.title.indexOf(bn) > -1)
      if (hit && !hit.aiHint) hit.aiHint = br
    }
  } else {
    node.estimatedHours = Math.min(Math.max(hours || 1, 0.5), 200)
  }
  return node
}

/**
 * AI 拆解原始输出 → 归一化任务树 + 信息缺口。
 * 兼容代码块围栏、前后缀文字、旧版扁平格式（tasks → 两层树）；失败返回 null。
 */
function extractTreeResult(rawText, goalText) {
  if (!rawText) return null
  const text = String(rawText).replace(/```(json)?/gi, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let parsed
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch (e) {
    return null
  }

  let rootRaw = parsed.goal && typeof parsed.goal === 'object' ? parsed.goal : null
  // 旧版扁平格式兼容（新旧版本并存期间）
  if (!rootRaw) {
    const rawTasks = parsed.tasks || (Array.isArray(parsed) ? parsed : null)
    if (Array.isArray(rawTasks) && rawTasks.length) {
      rootRaw = {
        title: goalText.slice(0, 30),
        children: rawTasks.map((t) => ({
          title: t.name,
          estimatedHours: t.estimatedHours,
          dependencies: t.dependencies,
          isExecutable: true,
        })),
      }
    }
  }
  if (!rootRaw) return null

  const stats = { count: 0 }
  const root = normalizeNode(rootRaw, 0, stats)
  if (!root || !root.children.length) return null
  if (!root.title) root.title = goalText.slice(0, 30)

  const infoGaps = Array.isArray(parsed.infoGaps)
    ? parsed.infoGaps
        .map((g) => String(g || '').trim().slice(0, 40))
        .filter((g) => !!g)
        .slice(0, 3)
    : []

  return { goal: root, infoGaps: infoGaps }
}

/** 任务树 → 兼容旧版的扁平列表（第一层子任务） */
function treeToFlatTasks(goalTree) {
  if (!goalTree || !Array.isArray(goalTree.children)) return []
  return goalTree.children.map((c) => ({
    name: c.title,
    estimatedHours: c.estimatedHours,
    dependencies: (c.dependencies || []).slice(),
  }))
}

/* ==================== DB ↔ 树 ==================== */

/** 按 parentGoalId 分组（保持 DB 返回顺序） */
function groupByParent(tasks) {
  const byParent = {}
  tasks.forEach((t) => {
    const pid = t.parentGoalId || ''
    if (!byParent[pid]) byParent[pid] = []
    byParent[pid].push(t)
  })
  return byParent
}

/**
 * DB 扁平任务 → 目标任务树（首页渲染 / AI 调优传参共用）。
 * dependencies（_id 列表）映射为同层任务名；映射不到的依赖丢弃（防悬挂引用）。
 * @param {Object} goalTask 大目标任务文档（level 0）
 * @param {Array} allTasks 全量任务（含大目标与所有层级子任务）
 */
function buildTreeFromTasks(goalTask, allTasks) {
  const byParent = groupByParent(allTasks)
  function build(task) {
    // 同层兄弟名映射：依赖 _id → 同层任务名
    const idToName = {}
    ;(byParent[task.parentGoalId || ''] || []).forEach((s) => {
      idToName[s._id] = s.title
    })
    return {
      _id: task._id,
      title: task.title,
      estimatedHours: task.estimatedHours || 0,
      actualHours: task.actualHours || 0,
      status: task.status || 'pending',
      aiHint: task.aiHint || '',
      dependencies: (task.dependencies || [])
        .map((id) => idToName[id])
        .filter((n) => !!n && n !== task.title),
      children: (byParent[task._id] || []).map(build),
    }
  }
  return build(goalTask)
}

/* ==================== 每层 CPM + 瓶颈 + 卡点链 ==================== */

/**
 * 每层 CPM + 每层瓶颈标注（原地修改并返回树）：
 * - 对每个节点的直接子任务列表跑 CPM（同层依赖），标记 isCritical
 * - 每层瓶颈（isBottleneck）：未完成子任务中评分最高者
 *   评分优先级：aiHint 卡住标记(1000) > 实际超预估1.5倍(500) >
 *               关键路径(100) > 耗时 + 被同层依赖数×5
 * - depth：根 0，逐层 +1
 */
function annotateTreeCPM(goalTree) {
  function annotate(node, depth) {
    node.depth = depth
    const children = node.children || []
    if (children.length) {
      const result = cpm.calculateCriticalPath(
        children.map((c) => ({
          name: c.title,
          estimatedHours: c.estimatedHours || 0,
          dependencies: c.dependencies || [],
        }))
      )
      const criticalSet = {}
      result.criticalPath.forEach((n) => {
        criticalSet[n] = true
      })
      // 被同层依赖计数
      const depCount = {}
      children.forEach((c) => {
        ;(c.dependencies || []).forEach((d) => {
          depCount[d] = (depCount[d] || 0) + 1
        })
      })
      children.forEach((c) => {
        c.isCritical = !!criticalSet[c.title]
        const est = c.estimatedHours || 0
        const timeout = est > 0 && (c.actualHours || 0) > est * 1.5
        c._score =
          (c.aiHint ? 1000 : 0) +
          (timeout ? 500 : 0) +
          (c.isCritical ? 100 : 0) +
          est +
          (depCount[c.title] || 0) * 5
      })
      // 每层瓶颈：未完成中评分最高者
      const open = children.filter((c) => c.status !== 'completed')
      if (open.length) {
        const best = open.reduce((a, b) => (b._score > a._score ? b : a))
        best.isBottleneck = true
      }
      children.forEach((c) => annotate(c, depth + 1))
    }
    return node
  }
  return annotate(goalTree, 0)
}

/**
 * 卡点链：从根的下一层开始，逐层取该层瓶颈（未完成）向下，
 * 直到叶子或该层无瓶颈 —— "用户最需要关注的瓶颈 = 最深层级的那个"。
 * 链上节点标 isClog = true。
 * @returns {Array} 卡点链节点数组（不含根）；最后一位 = 当前具体卡点
 */
function findBottleneckChain(goalTree) {
  const chain = []
  let node = goalTree
  while (node) {
    const next = (node.children || []).find(
      (c) => c.isBottleneck && c.status !== 'completed'
    )
    if (!next) break
    next.isClog = true
    chain.push(next)
    node = next
  }
  return chain
}

/**
 * 一次性树分析：每层 CPM → 每层瓶颈 → 卡点链 → 默认展开集合。
 * 默认展开规则：卡点链上节点全部展开（一路看到最深卡点），
 * 非链上节点默认折叠（用户可手动展开）。
 * @returns {Object} { tree, chain, clog, expandedIds: { nodeId: true } }
 */
function computeTreeMeta(goalTree) {
  // 清除上次标注残留（isBottleneck/isClog 每次重算，避免脏标记）
  ;(function clear(node) {
    node.isCritical = false
    node.isBottleneck = false
    node.isClog = false
    ;(node.children || []).forEach(clear)
  })(goalTree)
  annotateTreeCPM(goalTree)
  const chain = findBottleneckChain(goalTree)
  const expandedIds = {}
  chain.forEach((n) => {
    if (n._id) expandedIds[n._id] = true
  })
  return {
    tree: goalTree,
    chain: chain,
    clog: chain.length ? chain[chain.length - 1] : null,
    expandedIds: expandedIds,
  }
}

/* ==================== 拍平显示 ==================== */

/** 节点显示 key：DB 节点用 _id，预览树（未入库）用"父key/序号-标题"路径 */
function nodeKey(c, i, parentKey) {
  return c._id || parentKey + '/' + i + '-' + c.title
}

/**
 * 收集树全部节点 key（拆解页预览"默认全展开"用，与 flattenForDisplay 同规则）。
 * @returns {Object} { key: true }
 */
function collectKeys(goalTree) {
  const map = {}
  function walk(children, parentKey) {
    children.forEach((c, i) => {
      const key = nodeKey(c, i, parentKey)
      map[key] = true
      if (c.children && c.children.length) walk(c.children, key)
    })
  }
  walk(goalTree.children || [], '')
  return map
}

/**
 * 树 → 拍平行列表（首页 / 拆解页预览共用，WXML 单层 wx:for 渲染）。
 * 折叠节点的全部后代不输出；行内带 depth（缩进）与展开状态。
 * @param {Object} goalTree 已 computeTreeMeta 标注的树
 * @param {Object} expandedMap { key: true } 展开集合（key = 节点 _id）
 * @returns {Array} [{ key, _id, title, estimatedHours, status, depth,
 *                     hasChildren, expanded, isCritical, isBottleneck,
 *                     isClog, aiHint }]
 */
function flattenForDisplay(goalTree, expandedMap) {
  const rows = []
  function walk(children, depth, parentKey) {
    children.forEach((c, i) => {
      const key = nodeKey(c, i, parentKey)
      const expanded = !!expandedMap[key]
      rows.push({
        key: key,
        _id: c._id || '',
        title: c.title,
        estimatedHours: c.estimatedHours || 0,
        status: c.status || 'pending',
        depth: depth,
        hasChildren: (c.children || []).length > 0,
        expanded: expanded,
        isCritical: !!c.isCritical,
        isBottleneck: !!c.isBottleneck,
        isClog: !!c.isClog,
        aiHint: c.aiHint || '',
      })
      if (expanded && c.children && c.children.length) {
        walk(c.children, depth + 1, key)
      }
    })
  }
  walk(goalTree.children || [], 1, '')
  return rows
}

/**
 * 剥离运行时字段（_id/status/actualHours/isCritical/isBottleneck/isClog/depth/_score），
 * 输出干净的 AI 树（调优传参用，避免 DB 字段干扰模型）。
 */
function toAITree(node) {
  const out = {
    title: node.title,
    estimatedHours: node.estimatedHours || 0,
    dependencies: (node.dependencies || []).slice(),
    isExecutable: !(node.children && node.children.length),
  }
  if (node.aiHint) out.aiHint = node.aiHint
  if (node.children && node.children.length) {
    out.children = node.children.map(toAITree)
  }
  return out
}

/* ==================== 递归导入 / 同步 / 删除 ==================== */

/**
 * AI 拆解树递归导入 DB（拆解页采纳）：
 * 1. 创建/复用大目标（level 0，耗时 = 树根合计）
 * 2. 深度优先逐节点创建（level 1..N，parentGoalId 挂直接父节点，aiHint 随入）
 * 3. 每层回填同层依赖（任务名 → _id；创建动作不计入修改次数）
 *
 * 去重口径（关键）：
 * - 子任务：按"父节点 + 标题"匹配，不同父节点下的同名子任务（AI 拆解里极常见，
 *   如"收集资料/修改完善"）各自创建；不能用全局标题，否则会被误判为已存在。
 * - 大目标：只复用"本轮采纳开始前已存在于 DB 的大目标"，且每个标题最多复用一次；
 *   本轮新建的大目标不进入复用映射 —— 同一批识别出的同名目标必须各自成目标，
 *   否则第二张卡片会被并进第一张（子任务混在一起，首页也看不到该目标）。
 *   标题截断到 20/30 字，长描述很容易撞名，这条是必须的。
 * @param {string} goalTitle 目标名
 * @param {Object} goalTree 归一化任务树
 * @param {Object} api utils/api（addTask/updateTask/loadTasks）
 * @param {Object} [ctx] { goalIdByTitle, childIdByKey } 批量采纳时跨目标累积
 * @returns {Promise<Object>} { goalId, imported, skipped, ctx }
 */
async function importTreeToDb(goalTitle, goalTree, api, ctx) {
  if (!ctx) {
    ctx = { goalIdByTitle: {}, childIdByKey: {} }
    // 读取已有任务失败不能阻断导入（否则整批采纳一个目标都建不出来）：
    // 退化为"不做去重"，最多产生同名重复，目标本身一定会被创建。
    try {
      const existing = await api.loadTasks()
      existing.forEach((t) => {
        if (!t.title) return
        if (!t.parentGoalId) {
          // 大目标：按标题复用
          if (!ctx.goalIdByTitle[t.title]) ctx.goalIdByTitle[t.title] = t._id
        } else {
          // 子任务：按"父节点 + 标题"定位（同名不同父视为不同任务）
          const key = t.parentGoalId + '|' + t.title
          if (!ctx.childIdByKey[key]) ctx.childIdByKey[key] = t._id
        }
      })
    } catch (e) {
      console.warn('[tree] 读取已有任务失败，跳过去重复用（目标仍会创建）', e)
    }
  }

  let imported = 0
  let skipped = 0

  // 1. 大目标（归一化树根的 estimatedHours = 全树合计）
  //    已存在的大目标每个标题只复用一次（用完即从映射移除，见函数头注释）
  let goalId = ctx.goalIdByTitle[goalTitle]
  if (goalId) {
    delete ctx.goalIdByTitle[goalTitle]
    skipped++ // 大目标已存在：复用，只补缺失节点
  } else {
    const goalDoc = await api.addTask({
      title: goalTitle,
      estimatedHours: goalTree.estimatedHours || 0,
    })
    goalId = goalDoc._id
    imported++
  }

  // 2. 深度优先创建全部层级子任务（aiHint = AI 标记的卡点原因，供瓶颈识别）
  async function createLevel(parentId, level, children) {
    for (const c of children) {
      const key = parentId + '|' + c.title
      let id = ctx.childIdByKey[key]
      if (!id) {
        const doc = await api.addTask({
          title: c.title,
          estimatedHours: c.estimatedHours,
          parentGoalId: parentId,
          level: level,
          aiHint: c.aiHint || '',
        })
        id = doc._id
        ctx.childIdByKey[key] = id
        imported++
      } else {
        skipped++
        continue // 同父同名已存在：不重复创建，其子树视为已同步
      }
      if (c.children && c.children.length) {
        await createLevel(id, level + 1, c.children)
      }
    }
  }
  await createLevel(goalId, 1, goalTree.children || [])

  // 3. 回填同层依赖（同层 = 同一父节点下的兄弟，定位口径与创建一致）
  async function backfill(parentId, children) {
    for (const c of children) {
      const id = ctx.childIdByKey[parentId + '|' + c.title]
      if (id) {
        const depIds = (c.dependencies || [])
          .map((n) => ctx.childIdByKey[parentId + '|' + n])
          .filter((x) => !!x && x !== id)
        if (depIds.length) {
          await api.updateTask(id, { dependencies: depIds }, { countModification: false })
        }
      }
      if (c.children && c.children.length) {
        await backfill(id || '', c.children)
      }
    }
  }
  await backfill(goalId, goalTree.children || [])

  return { goalId: goalId, imported: imported, skipped: skipped, ctx: ctx }
}

/** 递归删除子树：先收集全部后代 id，再逐条删除（云端权限"仅创建者可读写"） */
async function removeSubtreeById(taskId, api, allTasks) {
  const all = allTasks || (await api.loadTasks())
  const byParent = groupByParent(all)
  const victims = [taskId]
  ;(function collect(pid) {
    ;(byParent[pid] || []).forEach((c) => {
      victims.push(c._id)
      collect(c._id)
    })
  })(taskId)
  for (const v of victims) await api.removeTask(v)
  return victims
}

/**
 * 递归完成联动：找出"全部子任务已完成（含本轮联动）但自身未完成"的祖先任务。
 * 不动点迭代（叶子完成 → 父完成 → 祖父完成，逐层向上传播）。
 * @returns {Array} 应自动完成的任务数组（含各级父节点，不含触发叶子）
 */
function computeAutoCompleted(tasks) {
  const byParent = groupByParent(tasks)
  const status = {}
  tasks.forEach((t) => {
    status[t._id] = t.status
  })
  const autoIds = []
  let changed = true
  while (changed) {
    changed = false
    tasks.forEach((t) => {
      if (status[t._id] === 'completed') return
      const subs = byParent[t._id] || []
      if (subs.length && subs.every((s) => status[s._id] === 'completed')) {
        status[t._id] = 'completed'
        autoIds.push(t)
        changed = true
      }
    })
  }
  return autoIds
}

/**
 * 调优树差异同步（拆解页编辑模式 → 已有目标）：
 * 递归对比草稿树与 DB 树（同层按 title 匹配）：
 * 1. 草稿新增节点 → 递归创建（含 aiHint）
 * 2. 未完成节点耗时变化 → 更新；已完成节点不动
 * 3. DB 有而草稿没有且未完成 → 递归删除子树；已完成保留
 * 4. 回填同层依赖（变化才写库）+ 根耗时 = 草稿树根合计
 * @returns {Promise<Object>} { added, updated, removed }
 */
async function syncTreeToDb(goalTask, draftTree, api) {
  const allTasks = await api.loadTasks()
  const dbTree = buildTreeFromTasks(goalTask, allTasks)
  let added = 0
  let updated = 0
  let removed = 0

  async function syncLevel(parentId, dbChildren, draftChildren, level) {
    const dbByName = {}
    dbChildren.forEach((c) => {
      if (!dbByName[c.title]) dbByName[c.title] = c
    })
    const draftByName = {}
    draftChildren.forEach((c) => {
      draftByName[c.title] = c
    })

    // 1. 新增草稿节点（递归创建子树）
    for (const d of draftChildren) {
      if (dbByName[d.title]) continue
      const doc = await api.addTask({
        title: d.title,
        estimatedHours: d.estimatedHours || 1,
        parentGoalId: parentId,
        level: level,
        aiHint: d.aiHint || '',
      })
      added++
      if (d.children && d.children.length) {
        await syncLevel(doc._id, [], d.children, level + 1)
      }
    }

    // 2. 已存在：更新未完成节点耗时 + 递归下层
    for (const d of draftChildren) {
      const dbNode = dbByName[d.title]
      if (!dbNode) continue
      if (dbNode.status !== 'completed' && (d.estimatedHours || 0) !== (dbNode.estimatedHours || 0)) {
        await api.updateTask(dbNode._id, { estimatedHours: d.estimatedHours })
        updated++
      }
      if (d.children && d.children.length) {
        await syncLevel(dbNode._id, dbNode.children || [], d.children, level + 1)
      }
    }

    // 3. 删除 DB 有而草稿没有的未完成节点（子树级联；已完成保留）
    for (const c of dbChildren) {
      if (draftByName[c.title] || c.status === 'completed') continue
      await removeSubtreeById(c._id, api, allTasks)
      removed++
    }
  }

  await syncLevel(goalTask._id, dbTree.children || [], draftTree.children || [], 1)

  // 4. 依赖回填：同步后重建全局名 → _id 映射，草稿树每层回填（变化才写库）
  const latest = await api.loadTasks()
  const idByName = {}
  latest.forEach((t) => {
    if (t.title && !idByName[t.title]) idByName[t.title] = t._id
  })
  const depById = {}
  latest.forEach((t) => {
    depById[t._id] = (t.dependencies || []).join('|')
  })
  async function backfill(node) {
    const id = idByName[node.title]
    if (id) {
      const depIds = (node.dependencies || [])
        .map((n) => idByName[n])
        .filter((x) => !!x && x !== id)
      if ((depIds.join('|') || '') !== (depById[id] || '')) {
        await api.updateTask(id, { dependencies: depIds }, { countModification: false })
      }
    }
    for (const c of node.children || []) await backfill(c)
  }
  await backfill(draftTree)

  // 5. 根耗时 = 草稿树根合计（归一化后已是子合计）
  const goalHours = draftTree.estimatedHours || 0
  if (goalHours !== (goalTask.estimatedHours || 0)) {
    await api.updateTask(goalTask._id, { estimatedHours: goalHours })
  }

  return { added: added, updated: updated, removed: removed }
}

/* ==================== 规则调优（树版降级） ==================== */

/** 递归重算父节点耗时 = 直接子任务合计（改叶子耗时后向上冒烟） */
function resumHours(node) {
  if (!node.children.length) return node.estimatedHours
  node.estimatedHours =
    Math.round(node.children.reduce((s, c) => s + resumHours(c), 0) * 10) / 10
  return node.estimatedHours
}

/**
 * 规则调优（树版）：基于正则的简单意图理解，递归作用于任务树
 * （与云函数 refineTask 的 ruleRefineTree 保持一致）。
 * 支持：删除（递归移除命中节点及子树）、增加（追加到根 children）、
 *       修改耗时（递归命中节点，向上重算父合计）。
 * 无法理解时返回 { source: 'rule-none' }，任务树原样返回。
 */
function ruleRefineTree(goalTree, feedback) {
  const fb = String(feedback || '')
  const summaries = []
  let changed = false
  const root = JSON.parse(JSON.stringify(goalTree))

  // 1. 删除：反馈含删除类关键词，且提及了树中某个节点名 → 递归移除该节点（含子树）
  const wantsDelete = /删除|去掉|不要|取消/.test(fb)
  if (wantsDelete) {
    const removedTitles = []
    function removeFrom(nodes) {
      const kept = []
      nodes.forEach((n) => {
        if (fb.indexOf(n.title) > -1) {
          removedTitles.push(n.title)
          return // 整个子树移除
        }
        n.children = removeFrom(n.children)
        kept.push(n)
      })
      return kept
    }
    root.children = removeFrom(root.children)
    if (removedTitles.length) {
      removedTitles.forEach((t) => summaries.push('已删除「' + t + '」'))
      changed = true
    }
  }

  // 2. 修改耗时：「任务名」改成/改为 N 小时（递归查找命中节点）
  const hm = fb.match(
    /(?:把|将)?\s*「?([^，。,\s「」]+?)」?\s*(?:改成|改为|调整到|调整为)\s*(\d+(?:\.\d+)?)\s*(?:小时|h)/
  )
  if (hm && hm[1]) {
    const keyword = hm[1].trim()
    let hitTitle = ''
    function setHours(node) {
      if (
        !hitTitle &&
        (node.title === keyword ||
          node.title.indexOf(keyword) > -1 ||
          keyword.indexOf(node.title) > -1)
      ) {
        hitTitle = node.title
        node.estimatedHours = Math.min(Math.max(parseFloat(hm[2]) || 1, 0.5), 200)
        return
      }
      node.children.forEach(setHours)
    }
    setHours(root)
    if (hitTitle) {
      if (!root.children.length) {
        root.estimatedHours = Math.min(Math.max(parseFloat(hm[2]) || 1, 0.5), 200)
      } else {
        resumHours(root)
      }
      summaries.push('已将「' + hitTitle + '」耗时调整为' + hm[2] + '小时')
      changed = true
    }
  }

  // 3. 增加：增加/添加/加上/新增 + 任务名 → 追加到根 children（可执行叶子）
  const am = fb.match(
    /(?:增加|添加|加上|新增)\s*(?:一个)?(?:名为|叫做?|任务)?\s*「?([^，。,\s「」]{1,12})」?/
  )
  if (am && am[1]) {
    const name = am[1].trim()
    let exists = false
    function findName(node) {
      if (node.title === name) {
        exists = true
        return
      }
      node.children.forEach(findName)
    }
    findName(root)
    if (name && !exists) {
      root.children.push({
        title: name,
        estimatedHours: 1,
        dependencies: [],
        isExecutable: true,
        aiHint: '',
        children: [],
      })
      resumHours(root)
      summaries.push('已增加「' + name + '」')
      changed = true
    }
  }

  if (!root.children.length) {
    // 全删光的边界：保留原树，提示至少保留一个子任务
    return {
      source: 'rule-none',
      goal: goalTree,
      adjustmentSummary: '至少需要保留一个子任务，已维持原任务树',
    }
  }
  if (!changed) {
    return { source: 'rule-none', goal: goalTree, adjustmentSummary: '' }
  }
  return { source: 'rule', goal: root, adjustmentSummary: summaries.join('，') }
}

module.exports = {
  MAX_DEPTH: MAX_DEPTH,
  normalizeNode: normalizeNode,
  extractTreeResult: extractTreeResult,
  treeToFlatTasks: treeToFlatTasks,
  buildTreeFromTasks: buildTreeFromTasks,
  annotateTreeCPM: annotateTreeCPM,
  findBottleneckChain: findBottleneckChain,
  computeTreeMeta: computeTreeMeta,
  flattenForDisplay: flattenForDisplay,
  collectKeys: collectKeys,
  toAITree: toAITree,
  importTreeToDb: importTreeToDb,
  removeSubtreeById: removeSubtreeById,
  computeAutoCompleted: computeAutoCompleted,
  syncTreeToDb: syncTreeToDb,
  ruleRefineTree: ruleRefineTree,
  resumHours: resumHours,
}
