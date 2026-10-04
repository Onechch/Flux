/**
 * 云函数：refineTask（对话调优 · 多层级任务树版）
 *
 * 作用：用户对拆解初稿（任务树）提出反馈意见后，调用大模型针对性调整整棵任务树。
 * 输入：{ goal: '完成季度汇报',
 *         currentTree: { title, children: [{ title, estimatedHours, dependencies,
 *                            isExecutable, aiHint, children }] },   // 新版：任务树
 *         currentTasks: [{name,...}],   // 旧版兼容：扁平列表（会被转成两层树）
 *         userFeedback: '删除收集数据，增加内部预演',
 *         knowledge: [{title,content,type,tags}]（可选，知识库检索命中的相关知识） }
 * 输出：{ success: true, source: 'ai'|'rule'|'rule-none',
 *         goal: <新版任务树>,           // 调整后的完整任务树
 *         tasks: [...],                 // 兼容输出：第一层子任务转扁平列表
 *         adjustmentSummary: '已删除收集数据，增加内部预演' }
 *
 * 知识库参考：客户端检索命中的知识（个人经验优先于理论）随请求传入，
 * 拼进 prompt 让建议个性化（如"根据你上午效率高的习惯…"）。
 *
 * 降级方案（AI 不可用时基于规则递归调整任务树，与客户端
 * pages/breakdown/index.js 的 ruleRefineTree 保持一致）：
 * - "删除/去掉/不要/取消 + 任务名"     → 递归移除命中节点（整个子树）
 * - "增加/添加/加上/新增 + 任务名"      → 追加到根的 children（默认 1h 可执行）
 * - "任务名 改成/改为 N 小时"           → 递归命中节点改耗时（向上重算父合计）
 * - 规则无法理解时返回 rule-none（任务树原样返回，客户端提示用户）
 *
 * 调用链（与 breakdownTask 一致的模型多入口尝试 + 429 退避）：
 *   1. 客户端直调 wx.cloud.extend.AI（见 miniprogram/utils/ai.js refineTasks）
 *   2. 本云函数（AI）
 *   3. 本云函数内置规则降级 / 客户端规则降级
 *
 * 部署：微信开发者工具中右键 refineTask 目录 → 上传并部署（云端安装依赖）
 * 注意：整树调整约需 5~20 秒，config.json 已将函数超时设为 30 秒。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 系统提示词：与客户端 miniprogram/utils/ai.js 的 REFINE_SYSTEM_PROMPT 保持一致
const SYSTEM_PROMPT = `你是一个任务管理专家。用户已有一版多层级任务树初稿，现在提出了反馈意见，请根据反馈调整任务树。

要求：
1. 理解用户的反馈意图（增加、删除、修改耗时、调整层级/依赖、重新生成）
2. 根据反馈针对性调整，未提及的节点保持原样（保留原有层级结构与 dependencies）
3. dependencies 仅引用同层任务的确切名称，不得虚构
4. isExecutable=true 的节点不得有 children；需要继续拆解的节点 isExecutable=false 且给出 children
5. 父节点 estimatedHours = 直接子任务合计；叶子任务耗时保持合理（0.5-200小时）
6. 层级规模约束：最多5层；每节点最多8个子任务；全树不超过40个节点
7. adjustmentSummary 用一句话说明改了什么（30字以内，如"已删除收集数据，已增加内部预演"）
8. 如果提供了"用户知识库参考"，结合用户的个人习惯、经验和约束调整任务树，并在调整说明中自然体现（如"根据你上午效率高的习惯…"），但不生硬罗列
9. 只输出纯JSON，不要任何解释文字或代码块标记

输出格式：
{"goal":{"title":"完成季度汇报","estimatedHours":11,"children":[{"title":"明确框架","estimatedHours":1,"dependencies":[],"isExecutable":true},{"title":"收集数据","estimatedHours":3,"dependencies":["明确框架"],"isExecutable":true}]},"adjustmentSummary":"已删除XX，已增加YY"}`

// ---- 树归一化约束（与 breakdownTask 保持一致） ----
const MAX_DEPTH = 5
const MAX_CHILDREN = 8
const MAX_NODES = 40

/** 归一化单个树节点（与 breakdownTask 的 normalizeNode 同逻辑） */
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
    aiHint: String(raw && raw.aiHint ? raw.aiHint : '').trim().slice(0, 40),
    children: children,
  }

  if (children.length) {
    node.estimatedHours =
      Math.round(children.reduce((s, c) => s + (c.estimatedHours || 0), 0) * 10) / 10
  } else {
    node.estimatedHours = Math.min(Math.max(hours || 1, 0.5), 200)
  }
  return node
}

/** 扁平任务列表 → 两层树（旧版 currentTasks 入参兼容） */
function flatTasksToTree(tasks, goalTitle) {
  const stats = { count: 0 }
  return normalizeNode(
    {
      title: goalTitle,
      children: (tasks || []).map((t) => ({
        title: t.name || t.title,
        estimatedHours: t.estimatedHours,
        dependencies: t.dependencies,
        isExecutable: true,
      })),
    },
    0,
    stats
  )
}

/**
 * 从模型输出中稳健提取调优结果（任务树 + 调整说明）：
 * 兼容代码块围栏、前后缀文字、旧版扁平格式输出；解析失败返回 null。
 */
function extractResult(rawText, fallbackTitle) {
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
  // 旧版扁平输出兼容：tasks → 两层树
  if (!rootRaw && Array.isArray(parsed.tasks) && parsed.tasks.length) {
    rootRaw = {
      title: fallbackTitle,
      children: parsed.tasks.map((t) => ({
        title: t.name,
        estimatedHours: t.estimatedHours,
        dependencies: t.dependencies,
        isExecutable: true,
      })),
    }
  }
  if (!rootRaw) return null

  const stats = { count: 0 }
  const root = normalizeNode(rootRaw, 0, stats)
  if (!root || !root.children.length) return null
  if (!root.title) root.title = fallbackTitle

  return {
    goal: root,
    adjustmentSummary: String(parsed.adjustmentSummary || '').trim().slice(0, 60),
  }
}

/** 任务树 → 兼容扁平列表（第一层子任务，供旧版客户端使用） */
function treeToFlatTasks(goalTree) {
  if (!goalTree || !Array.isArray(goalTree.children)) return []
  return goalTree.children.map((c) => ({
    name: c.title,
    estimatedHours: c.estimatedHours,
    dependencies: c.dependencies.slice(),
  }))
}

// 模型入口依次尝试（与 breakdownTask 一致）：
// 1. hunyuan-v3 + hy3 —— 小程序成长计划专用 Provider（仅消耗免费额度）
// 2. cloudbase + hy3 —— 付费 Token 资源包通道兜底
// 3. cloudbase + deepseek-v4-flash —— 付费兜底
const MODEL_ATTEMPTS = [
  { provider: 'hunyuan-v3', model: 'hy3' },
  { provider: 'cloudbase', model: 'hy3' },
  { provider: 'cloudbase', model: 'deepseek-v4-flash' },
]

/** 单次尝试：非流式 generateText（参数无 data 包裹层），返回文本；不可用返回 null */
async function tryGenerateText(ai, attempt, messages) {
  const model = ai.createModel(attempt.provider)
  if (typeof model.generateText !== 'function') return null
  const res = await model.generateText({
    model: attempt.model,
    messages: messages,
  })
  const content =
    res && res.choices && res.choices[0] && res.choices[0].message
      ? res.choices[0].message.content
      : ''
  if (content && String(content).trim()) return String(content)
  throw new Error('模型返回空内容')
}

/** 单次尝试：流式 streamText（参数有 data 包裹层），收齐完整文本；不可用返回 null */
async function tryStreamText(ai, attempt, messages) {
  const model = ai.createModel(attempt.provider)
  if (typeof model.streamText !== 'function') return null
  const res = await model.streamText({
    data: {
      model: attempt.model,
      messages: messages,
    },
  })
  let content = ''
  for await (const chunk of res.textStream) {
    content += chunk
  }
  if (content && content.trim()) return content
  throw new Error('模型返回空内容')
}

/** 429 限流识别（EXCEED_CONCURRENT_REQUEST_LIMIT） */
function isRateLimited(e) {
  const msg = String((e && (e.errMsg || e.message)) || e || '')
  return /429|too many requests|exceed_concurrent|concurrent request|rate.?limit/i.test(msg)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 429 同参数退避重试（最多 2 次，1.5s / 3s 递增；注意函数总超时 30s）
const RATE_LIMIT_RETRIES = 2
const RATE_LIMIT_BACKOFF_MS = 1500

/** 调用大模型生成文本（多入口依次尝试、streamText 优先，全部失败时抛错） */
async function callLLM(messages) {
  const entries = []
  if (cloud.extend && cloud.extend.AI && cloud.extend.AI.createModel) {
    entries.push(cloud.extend.AI)
  }
  if (cloud.ai && cloud.ai.createModel) {
    entries.push(cloud.ai)
  }
  if (!entries.length) {
    throw new Error('当前 wx-server-sdk 不支持 AI 调用（建议升级依赖版本）')
  }

  let lastError = null
  for (const ai of entries) {
    for (const attempt of MODEL_ATTEMPTS) {
      // streamText 优先：实测 hunyuan-v3/hy3 免费通道的 generateText 返回空内容
      for (const fn of [tryStreamText, tryGenerateText]) {
        let tries = 0
        while (tries <= RATE_LIMIT_RETRIES) {
          try {
            const content = await fn(ai, attempt, messages)
            if (content) return content
            break // 方法不存在（返回 null）→ 换下一个调用方式，不重试
          } catch (e) {
            lastError = e
            if (isRateLimited(e) && tries < RATE_LIMIT_RETRIES) {
              tries += 1
              await delay(RATE_LIMIT_BACKOFF_MS * tries) // 退避后重试同一入口
              continue
            }
            break // 非 429 → 换下一个入口
          }
        }
      }
    }
  }
  throw lastError || new Error('AI 调用失败')
}

/** 递归重算父节点耗时 = 直接子任务合计（改耗时后向上冒烟） */
function resumHours(node) {
  if (!node.children.length) return node.estimatedHours
  node.estimatedHours =
    Math.round(node.children.reduce((s, c) => s + resumHours(c), 0) * 10) / 10
  return node.estimatedHours
}

/**
 * 规则降级（树版）：基于正则的简单意图理解，递归作用于任务树
 * （与客户端 pages/breakdown/index.js 的 ruleRefineTree 保持一致）。
 * 支持：删除（递归移除命中节点及子树）、增加（追加到根 children）、
 *       修改耗时（递归命中节点，向上重算父合计）。
 * 无法理解时返回 { source: 'rule-none' }，任务树原样返回。
 */
function ruleRefineTree(tree, feedback) {
  const fb = String(feedback || '')
  const summaries = []
  let changed = false
  const root = JSON.parse(JSON.stringify(tree))

  // 1. 删除：反馈含删除类关键词，且提及了树中某个节点名 → 递归移除该节点（含子树）
  const wantsDelete = /删除|去掉|不要|取消/.test(fb)
  if (wantsDelete) {
    let removedTitles = []
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
      // 叶子改耗时后向上重算父合计
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
      goal: tree,
      adjustmentSummary: '至少需要保留一个子任务，已维持原任务树',
    }
  }
  if (!changed) {
    return { source: 'rule-none', goal: tree, adjustmentSummary: '' }
  }
  return {
    source: 'rule',
    goal: root,
    adjustmentSummary: summaries.join('，'),
  }
}

exports.main = async (event = {}) => {
  const goal = String(event.goal || '').trim()
  const feedback = String(event.userFeedback || '').trim()
  const knowledge = Array.isArray(event.knowledge) ? event.knowledge.slice(0, 3) : []

  // 入参兼容：新版传 currentTree（树），旧版传 currentTasks（扁平）
  let currentTree = event.currentTree && typeof event.currentTree === 'object' ? event.currentTree : null
  if (!currentTree && Array.isArray(event.currentTasks) && event.currentTasks.length) {
    currentTree = flatTasksToTree(event.currentTasks, goal)
  }

  if (!goal || !feedback || !currentTree || !currentTree.children || !currentTree.children.length) {
    return {
      success: false,
      source: 'invalid',
      goal: currentTree || null,
      tasks: currentTree ? treeToFlatTasks(currentTree) : [],
      adjustmentSummary: '',
      error: '参数不完整（需 goal / currentTree 或 currentTasks / userFeedback）',
    }
  }

  try {
    let userContent =
      '用户原始目标：' + goal +
      '\n当前任务树（title/estimatedHours/dependencies/isExecutable/children 嵌套结构）：\n' +
      JSON.stringify(currentTree) +
      '\n用户反馈：' + feedback
    if (knowledge.length) {
      const refs = knowledge
        .map((k, i) =>
          (i + 1) + '. [' + (k.type === 'theory' ? '理论' : '用户经验') + '] ' +
          (k.title || '') + '：' + (k.content || '')
        )
        .join('\n')
      userContent += '\n用户知识库参考（结合用户个人情况生成建议）：\n' + refs
    }
    const content = await callLLM([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ])
    const result = extractResult(content, currentTree.title || goal)
    if (!result) throw new Error('AI 输出解析失败')
    return {
      success: true,
      source: 'ai',
      goal: result.goal,
      tasks: treeToFlatTasks(result.goal), // 兼容输出（旧版客户端）
      adjustmentSummary: result.adjustmentSummary,
    }
  } catch (e) {
    // 降级：AI 不可用时基于规则递归调整任务树（删除/增加/改耗时）
    console.warn('[refineTask] AI 调用失败，使用规则降级', e)
    const ruled = ruleRefineTree(currentTree, feedback)
    return {
      success: true,
      source: ruled.source, // 'rule' | 'rule-none'
      goal: ruled.goal,
      tasks: treeToFlatTasks(ruled.goal),
      adjustmentSummary: ruled.adjustmentSummary,
      error: (e && (e.errMsg || e.message)) || String(e),
    }
  }
}
