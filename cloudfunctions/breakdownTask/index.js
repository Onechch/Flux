/**
 * 云函数：breakdownTask（多层级动态拆解）
 *
 * 作用：调用大模型，将用户目标拆解为多层级任务树（层级深度由复杂度自动适配），
 *       拆到"可直接执行"或"卡点暴露"为止；同时产出信息缺口提示。
 * 输入：{ goal: '推进课题，卡在蛋白表达', depthHint: 3（可选，parseGoals 的建议深度） }
 * 输出：{ success: true, source: 'ai',
 *         goal: { title, estimatedHours, children: [{ title, estimatedHours,
 *                dependencies, isExecutable, aiHint, children: [...] }] },   // 任务树
 *         tasks: [...],                    // 兼容输出：第一层子任务转扁平列表（旧客户端）
 *         infoGaps: ['是否有固定截止日期？', ...] }
 *       AI 不可用时：{ success: false, source: 'fallback', goal: <预设两层树>,
 *                     tasks: <预设示例>, infoGaps: <预设问题>, error }
 *
 * 多层级拆解原则（提示词引导 + 归一化兜底）：
 * - 层级不固定：简单目标 1 层，复杂目标 3-5 层
 * - 拆到"可执行"为止：用户看到就知道下一步做什么时停止
 * - 拆到"卡点暴露"为止：用户说"卡在 xxx"的环节必须展开到能定位原因
 * - 避免过度拆解："发邮件"不拆成"打开邮箱→写正文→点击发送"
 * - 性能约束：单次 AI 调用生成整棵树（不做逐层多轮调用，避免超时与请求放大）；
 *   归一化强制最多 5 层、每节点最多 8 个子任务、全树 ≤ 40 节点
 * - 瓶颈提示：AI 在父节点标记 bottleneck/bottleneckReason，归一化时转移到
 *   对应子节点的 aiHint 字段（前端展示"当前卡点"的依据之一）
 *
 * 调用链（三层降级，任一层失败自动下沉）：
 *   1. 客户端直调：wx.cloud.extend.AI（官方明确支持路径，见 miniprogram/utils/ai.js）
 *   2. 本云函数：wx-server-sdk 的 AI 扩展（cloud.extend.AI / cloud.ai）
 *   3. 预设两层树（本文件 FALLBACK_TREE，与客户端保持一致）
 *
 * 部署：微信开发者工具中右键 breakdownTask 目录 → 上传并部署（云端安装依赖）
 * 注意：整树生成约需 5~20 秒，config.json 已将函数超时设为 30 秒；
 *       如仍超时，请在云开发控制台将该函数超时时间调大（最大 60s）。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 系统提示词（关键）：引导模型单次输出完整多层级任务树。
// 与客户端 miniprogram/utils/ai.js 保持一致，避免两层行为不一致。
const SYSTEM_PROMPT = `你是一位项目管理专家。请将用户输入的目标拆解为多层级任务树，层级深度由目标复杂度自动适配。

【拆解原则】
1. 层级不固定：简单目标1层，复杂目标可达4-5层；用户给出"建议拆解深度"时参考执行
2. 拆解到"可执行"为止：用户看到任务就知道下一步做什么时停止
3. 拆解到"卡点暴露"为止：用户提到"卡在xxx"的环节必须展开到能定位具体原因
4. 避免过度拆解："发邮件"不要拆成"打开邮箱→写正文→点击发送"

【停止拆解条件】（满足任一，该节点不再有 children）
- 任务已足够具体，用户看到就知道该做什么
- 预估耗时≤2小时且无进一步拆解必要
- 不涉及多个环节或依赖
- 已是最小可执行单元（如"填写表格"、"发送邮件"）

【节点字段】
- title：任务名（15字以内）
- estimatedHours：预估小时数（叶子任务0.5-200；父任务=直接子任务合计）
- dependencies：同层前置任务名列表（仅引用同级任务名，无则空数组）
- isExecutable：是否可直接执行（true时不得有children；false时必须有children）
- bottleneck：直接子任务中最可能卡住的任务名（可选）
- bottleneckReason：瓶颈判断依据（可选，20字内，如"表达量不达标，需优化条件"）
- children：子任务列表（可执行任务省略该字段）

【规模约束】最多5层；每个节点最多8个子任务；全树总节点不超过40个

【性能要求】一次性输出完整任务树，不要逐层询问

输出格式（只输出纯JSON，不要任何解释文字或代码块标记）：
{"goal":{"title":"完成Q3汇报","estimatedHours":11,"children":[{"title":"明确框架","estimatedHours":1,"dependencies":[],"isExecutable":true},{"title":"收集数据","estimatedHours":3,"dependencies":["明确框架"],"isExecutable":true}]},"infoGaps":["是否有可用的历史模板？"]}

示例1（简单目标，1层，全可执行）：
输入："发一封周报邮件"
输出：
{"goal":{"title":"发送周报邮件","estimatedHours":0.5,"children":[{"title":"撰写并发送周报邮件","estimatedHours":0.5,"dependencies":[],"isExecutable":true}]},"infoGaps":[]}

示例2（中等目标，2层）：
输入："完成季度汇报PPT"
输出：
{"goal":{"title":"完成季度汇报PPT","estimatedHours":11,"children":[{"title":"明确汇报框架","estimatedHours":1,"dependencies":[],"isExecutable":true},{"title":"收集数据","estimatedHours":3,"dependencies":["明确汇报框架"],"isExecutable":true},{"title":"撰写PPT","estimatedHours":5,"dependencies":["收集数据"],"isExecutable":true},{"title":"修改完善","estimatedHours":2,"dependencies":["撰写PPT"],"isExecutable":true}]},"infoGaps":["是否有可用的数据模板？"]}

示例3（复杂目标+卡点，4层；"卡在蛋白表达"必须展开到能定位原因）：
输入："推进课题，两年后毕业，现在卡在蛋白表达"
输出：
{"goal":{"title":"推进课题","estimatedHours":660,"bottleneck":"实验执行","bottleneckReason":"当前课题卡在实验环节","children":[{"title":"文献调研与课题设计","estimatedHours":120,"dependencies":[],"isExecutable":false,"children":[{"title":"文献综述","estimatedHours":40,"dependencies":[],"isExecutable":true},{"title":"设计研究框架","estimatedHours":80,"dependencies":["文献综述"],"isExecutable":true}]},{"title":"实验执行","estimatedHours":380,"dependencies":["文献调研与课题设计"],"isExecutable":false,"bottleneck":"蛋白表达","bottleneckReason":"表达量不达标","children":[{"title":"蛋白表达","estimatedHours":200,"dependencies":[],"isExecutable":false,"bottleneck":"诱导表达条件优化","bottleneckReason":"表达量不达标，需优化诱导条件","children":[{"title":"载体构建","estimatedHours":40,"dependencies":[],"isExecutable":true},{"title":"诱导表达条件优化","estimatedHours":120,"dependencies":["载体构建"],"isExecutable":true},{"title":"蛋白纯化","estimatedHours":40,"dependencies":["诱导表达条件优化"],"isExecutable":true}]},{"title":"蛋白功能验证","estimatedHours":180,"dependencies":["蛋白表达"],"isExecutable":false,"children":[{"title":"设计验证实验","estimatedHours":80,"dependencies":[],"isExecutable":true},{"title":"执行验证与记录","estimatedHours":100,"dependencies":["设计验证实验"],"isExecutable":true}]}]},{"title":"论文撰写与投稿","estimatedHours":160,"dependencies":["实验执行"],"isExecutable":false,"children":[{"title":"撰写初稿","estimatedHours":100,"dependencies":[],"isExecutable":true},{"title":"投稿与修改","estimatedHours":60,"dependencies":["撰写初稿"],"isExecutable":true}]}]},"infoGaps":[]}`

// ---- 树归一化约束（与提示词一致，归一化时强制执行） ----
const MAX_DEPTH = 5        // 最多 5 层（根为第 0 层）
const MAX_CHILDREN = 8     // 每节点最多 8 个子任务
const MAX_NODES = 40       // 全树最多 40 个节点

// AI 不可用时的降级树（两层，与客户端 pages/breakdown/index.js 保持一致）
const FALLBACK_CHILDREN = [
  { title: '明确目标范围', estimatedHours: 1, dependencies: [], isExecutable: true },
  { title: '收集资料', estimatedHours: 2, dependencies: ['明确目标范围'], isExecutable: true },
  { title: '撰写初稿', estimatedHours: 4, dependencies: ['收集资料'], isExecutable: true },
  { title: '修改完善', estimatedHours: 2, dependencies: ['撰写初稿'], isExecutable: true },
  { title: '最终审核', estimatedHours: 1, dependencies: ['修改完善'], isExecutable: true },
]

// 降级时的预设信息缺口（与客户端保持一致）
const FALLBACK_INFO_GAPS = [
  '是否有固定的截止日期？',
  '是否有可用的数据或模板？',
  '是否有其他人员配合？',
]

/**
 * 归一化单个树节点（递归）：
 * - title 截断 30 字、同父去重
 * - 深度/广度/总节点数硬约束（超出截断：深层子任务丢弃、超编子任务丢弃）
 * - 叶子（无 children）isExecutable=true、耗时 clamp(0.5, 200)
 * - 父节点耗时强制 = 直接子任务合计（覆盖 AI 给出的值，保证一致性）
 * - dependencies 过滤自引用（导入时再校验同层有效）
 * - 父节点的 bottleneck/bottleneckReason 命中子任务时转移到该子节点 aiHint
 */
function normalizeNode(raw, depth, stats) {
  const title = String(raw && raw.title ? raw.title : '').trim().slice(0, 30)
  if (!title) return null
  stats.count += 1

  // 子任务：仅非叶原始数据且未触深度/总量上限时递归
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
    // 父节点：耗时 = 直接子任务合计；AI 瓶颈提示转移到命中的子节点
    node.estimatedHours =
      Math.round(children.reduce((s, c) => s + (c.estimatedHours || 0), 0) * 10) / 10
    const bn = String(raw.bottleneck || '').trim()
    const br = String(raw.bottleneckReason || '').trim().slice(0, 40)
    if (bn && br) {
      const hit = children.find((c) => c.title === bn || c.title.indexOf(bn) > -1)
      if (hit && !hit.aiHint) hit.aiHint = br
    }
  } else {
    // 叶子：clamp 到合理区间
    node.estimatedHours = Math.min(Math.max(hours || 1, 0.5), 200)
  }
  return node
}

/**
 * 从模型输出中稳健提取任务树：
 * 兼容代码块围栏、前后缀文字、旧版扁平格式（tasks → 两层树）；
 * 解析失败返回 null。
 */
function extractResult(rawText, goalText) {
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
  // 旧版扁平格式兼容：tasks → 两层树（云函数新旧版本并存期间）
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
  if (!root) return null
  // 根节点标题缺失时用目标文本兜底
  if (!root.title) root.title = goalText.slice(0, 30)

  // 信息缺口：字符串数组，最多 3 条
  const infoGaps = Array.isArray(parsed.infoGaps)
    ? parsed.infoGaps
        .map((g) => String(g || '').trim().slice(0, 40))
        .filter((g) => !!g)
        .slice(0, 3)
    : []

  return { goal: root, infoGaps: infoGaps }
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

/** 构建降级树（两层：目标 → 预设示例步骤） */
function buildFallbackTree(goalText) {
  const stats = { count: 0 }
  const root = normalizeNode(
    {
      title: goalText.slice(0, 30),
      estimatedHours: 10,
      children: FALLBACK_CHILDREN,
    },
    0,
    stats
  )
  return root
}

// 模型入口依次尝试：
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

// 单次调用硬超时 + 整体时间预算（均须小于函数总超时 30s，
// 保证超时前能返回预设降级树，而不是让客户端等函数超时后丢失降级数据）
const CALL_TIMEOUT_MS = 20 * 1000
const TOTAL_BUDGET_MS = 25 * 1000

function withTimeout(p, ms, label) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' 超时(' + ms + 'ms)')), ms)
  })
  // 败者定时器必须清理：主 Promise 先结算后，孤儿定时器稍后触发会产生
  // 未处理的 Promise 拒绝（可能中断云函数后续降级逻辑）
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

/** 调用大模型生成文本（多入口依次尝试、非流式优先，全部失败时抛错） */
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
  const deadline = Date.now() + TOTAL_BUDGET_MS
  for (const ai of entries) {
    for (const attempt of MODEL_ATTEMPTS) {
      // streamText 优先：实测 hunyuan-v3/hy3 免费通道的 generateText 返回空内容
      for (const fn of [tryStreamText, tryGenerateText]) {
        if (Date.now() >= deadline) break // 时间预算耗尽 → 立即降级
        let tries = 0
        while (tries <= RATE_LIMIT_RETRIES) {
          try {
            const content = await withTimeout(
              fn(ai, attempt, messages),
              Math.min(CALL_TIMEOUT_MS, Math.max(deadline - Date.now(), 1)),
              attempt.provider + '/' + attempt.model
            )
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

exports.main = async (event = {}) => {
  const goal = String(event.goal || '').trim()
  const depthHint = Number(event.depthHint)
  if (!goal) {
    return {
      success: false,
      goal: null,
      tasks: [],
      source: 'invalid',
      error: '请输入目标',
    }
  }

  // 用户消息：目标 + 可选的深度提示（来自 parseGoals 的 suggestedDepth）
  const depthNote =
    isFinite(depthHint) && depthHint >= 1 && depthHint <= 4
      ? '（建议拆解深度：' + Math.round(depthHint) + '层）'
      : ''

  try {
    const content = await callLLM([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: goal + depthNote },
    ])
    const result = extractResult(content, goal)
    if (!result || !result.goal.children.length) throw new Error('AI 输出解析失败')
    return {
      success: true,
      goal: result.goal,           // 任务树（新版客户端使用）
      tasks: treeToFlatTasks(result.goal), // 兼容输出（旧版客户端）
      infoGaps: result.infoGaps,
      source: 'ai',
    }
  } catch (e) {
    // 降级：返回预设两层树 + 兢容扁平列表 + 预设信息缺口，
    // source 标记 fallback，客户端可再尝试直调
    console.warn('[breakdownTask] AI 调用失败，使用预设两层树', e)
    const fallbackTree = buildFallbackTree(goal)
    return {
      success: false,
      goal: fallbackTree,
      tasks: treeToFlatTasks(fallbackTree),
      infoGaps: FALLBACK_INFO_GAPS,
      source: 'fallback',
      error: (e && (e.errMsg || e.message)) || String(e),
    }
  }
}
