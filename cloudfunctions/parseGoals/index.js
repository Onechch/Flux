/**
 * 云函数：parseGoals
 *
 * 作用：批量目标输入的第一阶段 —— 调用大模型，从用户一段自然语言中
 *       识别出独立目标列表（依赖关系优先合并：A 是 B 的前置条件、或指向同一交付物 → 一个目标）。
 * 输入：{ text: '我下周要做这几件事：第一，完成Q3汇报PPT；第二，整理绩效…' }
 * 输出：{ success: true, source: 'ai',
 *         goals: [{ title, description, complexity, mergeReason, reason }],
 *         summary: '用户有三项待办任务' }
 *       AI 不可用时：{ success: false, source: 'rule',
 *                     goals: <规则切分结果>, summary, error }
 *
 * 调用链（三层降级，任一层失败自动下沉）：
 *   1. 客户端直调：wx.cloud.extend.AI（见 miniprogram/utils/ai.js parseGoals）
 *   2. 本云函数：wx-server-sdk 的 AI 扩展（cloud.extend.AI / cloud.ai）
 *   3. 规则切分（本文件 ruleParseGoals，与客户端保持一致）：
 *      枚举（第N / 1.）与并列连接词（另外·还有·还要·以及·同时·再者）切分，
 *      顺序词（首先·然后·最后等）视为同一目标的步骤不切分
 *
 * AI 与规则结果均经 postProcessGoals 后处理：按依赖关系合并相邻目标（保守关键词启发式），
 * 覆盖"1. 制定实验方案 2. 做实验"这类枚举结构但存在依赖的输入（提示词【特殊说明】）。
 *
 * 部署：微信开发者工具中右键 parseGoals 目录 → 上传并部署（云端安装依赖）
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 系统提示词（与客户端 miniprogram/utils/ai.js 保持一致，避免两层行为不一致）
// 核心原则：依赖关系优先合并 —— 任务A是任务B的前置条件，或多个任务指向同一交付物 → 合并为一个目标
const SYSTEM_PROMPT = `你是一个任务识别专家。用户会输入一段自然语言，里面可能包含一个或多个独立的"目标"。

【核心判断原则】

一个"独立目标"的定义：用户能够独立交付的一件完整事项。

判断标准（按优先级排序）：

1. 依赖关系检测（最高优先级）
   - 如果任务A是任务B的必要前置条件，则它们必须合并为一个目标
   - 判断依据：没有A，B就无法进行
   - 示例："做实验与制定实验方案" → 没有方案无法做实验 → 合并为1个目标

2. 顺序关系检测
   - 如果用户描述中包含"先...再..."、"然后"、"接下来"、"最后"等顺序词
   - 且这些任务指向同一个最终交付物 → 合并为一个目标
   - 示例："先起草方案，然后跟团队对齐，最后定稿" → 合并为1个目标

3. 交付物检测
   - 如果多个任务指向同一个最终交付物 → 合并为一个目标
   - 如果多个任务指向不同的最终交付物 → 拆分为多个目标
   - 示例："完成季度汇报PPT"和"整理绩效数据" → 两个不同的交付物 → 拆分

4. 独立性检测
   - 如果某个任务可以在不依赖另一个任务的情况下独立完成 → 倾向于拆分为多个目标
   - 如果两个任务之间没有明确的依赖关系，但属于同一个大的工作范畴 → 根据用户意图判断

【判断流程图】

用户输入
    ↓
是否存在"任务A是任务B的前置条件"？
    ↓ 是
合并为一个目标
    ↓ 否
是否存在"多个任务指向同一个最终交付物"？
    ↓ 是
合并为一个目标
    ↓ 否
拆分为多个独立目标

【输出格式】只输出纯JSON，不要任何解释文字或代码块标记：
{"goals":[{"title":"目标名称（简洁，概括完整事项）","description":"补充信息（如有）","complexity":"complex或simple","suggestedDepth":2,"subtasks":"如果是合并的目标，这里列出子任务（可选）","mergeReason":"如果是合并的，说明为什么合并","reason":"判断依据"}],"summary":"一句话总结用户说了什么"}

suggestedDepth = 建议拆解深度（1-4）：
- 1：任务本身就是一步操作，无需拆解（如"发一封邮件"）
- 2：包含多个并列步骤，但不需要再细分（如"完成季度汇报"）
- 3：包含多个阶段，每阶段又含多个步骤（如"推进课题"）
- 4：复杂嵌套结构，多环节多依赖（如"蛋白表达实验"）

【示例】

示例1：
用户输入："做实验与制定实验方案"
判断：没有方案无法做实验 → 有依赖关系 → 合并为1个目标
输出：
{"goals":[{"title":"完成实验","description":"包括制定实验方案和执行实验","complexity":"complex","suggestedDepth":3,"mergeReason":"制定方案是做实验的必要前置条件，应合并为一个完整目标","reason":"两个任务有先后依赖关系，指向同一个交付物"}],"summary":"用户需要完成实验，包含制定方案和执行两个环节"}

示例2：
用户输入："完成季度汇报PPT，还要整理绩效数据"
判断：两个独立的最终交付物 → 无依赖关系 → 拆分为2个目标
输出：
{"goals":[{"title":"完成季度汇报PPT","description":"","complexity":"complex","suggestedDepth":2,"reason":"独立的最终交付物"},{"title":"整理绩效数据","description":"","complexity":"simple","suggestedDepth":1,"reason":"独立的最终交付物"}],"summary":"用户有两项独立任务：季度汇报PPT和整理绩效"}

示例3：
用户输入："先起草方案，然后跟团队对齐，最后定稿"
判断：有顺序关系，指向同一个交付物（方案定稿）→ 合并为1个目标
输出：
{"goals":[{"title":"完成方案定稿","description":"包括起草、团队对齐和定稿","complexity":"complex","suggestedDepth":2,"mergeReason":"三个步骤指向同一个最终交付物，且有明确的先后顺序","reason":"顺序关系+同一交付物"}],"summary":"用户需要完成方案定稿，包含起草、对齐和定稿三个步骤"}

示例4：
用户输入："完成Q3汇报PPT，需要先整理数据，然后做PPT，最后写演讲稿"
判断：整理数据→做PPT→写演讲稿，有先后依赖关系，指向同一个交付物（Q3汇报）→ 合并为1个目标
输出：
{"goals":[{"title":"完成Q3汇报","description":"包括整理数据、制作PPT和撰写演讲稿","complexity":"complex","suggestedDepth":2,"mergeReason":"三个任务有先后依赖关系，且指向同一个最终交付物","reason":"依赖关系+同一交付物"}],"summary":"用户需要完成Q3汇报，包含数据整理、PPT制作和演讲稿撰写"}

【特殊说明】

如果用户输入中包含明确的"第一...第二...第三..."或"1...2...3..."等结构，但各部分之间存在依赖关系，仍然按"依赖关系"优先原则处理。`

/**
 * 规则降级：按强标记切分独立目标（保守策略，无标记时视为单目标）。
 * 与客户端 pages/breakdown/index.js 的 ruleParseGoals 保持一致。
 * 与 AI 提示词"依赖关系优先合并"原则对齐：
 * - 切分标记：枚举（第N、数字列表 1. / 1、）、并列连接词（另外/还有/还要/以及/同时/再者）
 *   —— 并列词指向不同交付物，切分
 * - 顺序词（首先/其次/然后/接着/最后）不切分
 *   —— 顺序词通常是同一目标的步骤，保守合并不切
 * - 首个标记前的内容：以冒号结尾视为开场白丢弃，否则作为第一个目标
 * - 标题 = 段落首个软标点前的内容（≤20字），其余作为补充描述
 */
function ruleParseGoals(text) {
  const msg = String(text || '').trim()
  if (!msg) return { goals: [], summary: '' }

  const markerRe =
    /第[一二三四五六七八九十\d]+\s*[，,、.．:：]?|(?:^|[，,。；;：:\s])(?:另外|还有|还要|以及|同时|再者)|(?:^|[，,。；;\s])\d+\s*[.、）)]/g

  const points = []
  let m
  while ((m = markerRe.exec(msg)) !== null) {
    points.push({ start: m.index, end: m.index + m[0].length })
  }

  const segments = []
  if (points.length) {
    // 首个标记前的内容视为开场白丢弃的条件（两种冒号形态都覆盖）：
    // - 顺序词分支消耗了冒号（如"下周计划：首先…"）→ 标记以冒号开头
    // - 第N分支不消耗冒号（如"我下周要做几件事：第一，…"）→ 冒号留在前缀末尾
    const preamble = msg.slice(0, points[0].start).trim()
    const startsWithColon = /^[：:]/.test(msg.slice(points[0].start))
    if (preamble && !startsWithColon && !/[：:]$/.test(preamble) && preamble.length >= 2) {
      segments.push(preamble)
    }
    for (let i = 0; i < points.length; i++) {
      const from = points[i].end
      const to = i + 1 < points.length ? points[i + 1].start : msg.length
      const seg = msg.slice(from, to).replace(/^[，,。；;、\s]+|[，,。；;\s]+$/g, '')
      if (seg) segments.push(seg)
    }
  }
  if (!segments.length) segments.push(msg)

  const goals = segments.slice(0, 8).map((seg) => {
    // 标题 = 首个软标点前的内容；其余为补充描述
    const soft = seg.split(/[，,。；;：:]/)
    const head = (soft[0] || '').trim()
    const title = (head || seg).slice(0, 20)
    const description = head
      ? seg.slice(head.length).replace(/^[，,。；;：:\s]+/, '').slice(0, 60)
      : ''
    return {
      title: title,
      description: description,
      complexity: seg.length >= 12 || description ? 'complex' : 'simple',
      // 规则切分默认深度：内容越长结构越可能复杂（无法语义判断，保守给 2/3）
      suggestedDepth: seg.length >= 30 ? 3 : 2,
      reason: '规则切分（AI 不可用）',
    }
  })

  return {
    goals: goals,
    summary:
      goals.length > 1
        ? '识别到 ' + goals.length + ' 个目标（规则切分，请确认）'
        : '识别到 1 个目标',
  }
}

/**
 * 从模型输出中稳健提取目标列表：兼容代码块围栏、前后缀文字；
 * 校验并归一化字段（title 去重、complexity 白名单、长度截断）；解析失败返回 null。
 * subtasks 字段不入库（拆解由 breakdownTask 独立完成），mergeReason 保留供前端展示。
 */
function extractResult(rawText) {
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
  const raw = parsed.goals || (Array.isArray(parsed) ? parsed : null)
  if (!Array.isArray(raw) || !raw.length) return null

  const goals = []
  raw.slice(0, 8).forEach((g) => {
    const title = String(g && g.title ? g.title : '').trim().slice(0, 30)
    if (!title || goals.some((x) => x.title === title)) return
    // suggestedDepth：1-4 整数白名单（超范围回退 2）
    let depth = Number(g && g.suggestedDepth)
    if (!isFinite(depth) || depth < 1 || depth > 4) depth = 2
    depth = Math.round(depth)
    goals.push({
      title: title,
      description: String((g && g.description) || '').trim().slice(0, 60),
      complexity: g && g.complexity === 'simple' ? 'simple' : 'complex',
      suggestedDepth: depth,
      mergeReason: String((g && g.mergeReason) || '').trim().slice(0, 60),
      reason: String((g && g.reason) || '').trim().slice(0, 40),
    })
  })
  if (!goals.length) return null
  return { goals: goals, summary: String(parsed.summary || '').trim().slice(0, 60) }
}

/**
 * 依赖合并后处理（与客户端 miniprogram/utils/ai.js postProcessGoals 保持一致）。
 * AI 偶尔会把存在前置依赖的目标拆开（如"制定实验方案"+"做实验"），
 * 用保守的关键词启发式兜底合并相邻目标：
 * - 标题（或剥离通用动词后）存在包含关系 → 同一事项的细化 → 合并
 * - 双方共享领域关键词（排除前置物词本身），且一方标题含前置产出物词 → 合并
 */
// 前置产出物词：标题含这些词的目标，其产出常是另一目标的前置条件
const PRECONDITION_WORDS = [
  '方案', '计划', '数据', '材料', '清单', '名单', '模板',
  '大纲', '初稿', '草稿', '报告', '汇报', '预算', '需求', '纪要',
]

// 通用动词：比对关键词前剥离，避免"完成/准备"等动作词造成误判
const GENERIC_VERBS = [
  '完成', '准备', '整理', '制作', '处理', '安排', '执行', '撰写', '编写',
  '收集', '分析', '制定', '梳理', '汇总', '统计', '核对', '确认', '协调',
  '组织', '开展', '推进', '落实', '搭建', '开发', '设计', '输出', '做', '写',
]

const GENERIC_VERB_RE = new RegExp(GENERIC_VERBS.join('|'), 'g')

/** 判断两个目标是否存在明显依赖（标题启发式，保守策略） */
function isDependent(goalA, goalB) {
  const ta = String((goalA && goalA.title) || '')
  const tb = String((goalB && goalB.title) || '')
  if (!ta || !tb) return false

  // 1. 包含关系：一个标题包含另一个 → 同一事项的细化
  if (ta.indexOf(tb) > -1 || tb.indexOf(ta) > -1) return true
  const coreA = ta.replace(GENERIC_VERB_RE, '')
  const coreB = tb.replace(GENERIC_VERB_RE, '')
  if (coreA && coreB && (coreA.indexOf(coreB) > -1 || coreB.indexOf(coreA) > -1)) {
    return true // 剥离动词后包含（如"制定实验方案"→"实验方案"含"做实验"→"实验"）
  }
  if (!coreA || !coreB) return false

  // 2. 共享领域关键词（排除前置物词/通用词）+ 一方产出前置物
  const subsB = {}
  for (let j = 0; j < coreB.length - 1; j++) subsB[coreB.substr(j, 2)] = true
  let shared = false
  for (let j = 0; j < coreA.length - 1; j++) {
    const s = coreA.substr(j, 2)
    if (subsB[s] && PRECONDITION_WORDS.indexOf(s) === -1 && GENERIC_VERBS.indexOf(s) === -1) {
      shared = true
      break
    }
  }
  if (!shared) return false
  return PRECONDITION_WORDS.some((w) => ta.indexOf(w) > -1 || tb.indexOf(w) > -1)
}

/**
 * 后处理：按"依赖关系优先"合并相邻目标（链式合并）。
 * AI 已正确合并时不改动；规则切分出的枚举项若有依赖也在此合并（对应提示词【特殊说明】）。
 */
function postProcessGoals(goals) {
  if (!Array.isArray(goals) || goals.length < 2) return goals
  const list = goals.slice()
  for (let i = 0; i < list.length - 1; i++) {
    const current = list[i]
    const next = list[i + 1]
    if (!isDependent(current, next)) continue
    const desc = [current.description, next.description]
      .filter((d) => !!d)
      .join('；')
      .slice(0, 60)
    const merged = {
      title: (current.title + '与' + next.title).slice(0, 30),
      description: desc,
      complexity: 'complex',
      // 合并的目标结构更复杂：取两者深度较大值
      suggestedDepth: Math.max(current.suggestedDepth || 2, next.suggestedDepth || 2),
      mergeReason: '系统检测到两个任务存在依赖关系，自动合并',
      reason: '依赖关系',
    }
    list.splice(i, 2, merged)
    i-- // 合并结果与下一项重新比较，支持链式合并
  }
  return list
}

// 模型入口依次尝试（与 breakdownTask 保持一致）：
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

// 429 同参数退避重试（最多 2 次，1.5s / 3s 递增）
const RATE_LIMIT_RETRIES = 2
const RATE_LIMIT_BACKOFF_MS = 1500

/** 调用大模型生成文本（多入口依次尝试、流式优先，全部失败时抛错） */
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

exports.main = async (event = {}) => {
  const text = String(event.text || '').trim()
  if (!text) {
    return { success: false, goals: [], source: 'invalid', error: '请输入内容' }
  }

  try {
    const content = await callLLM([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
    ])
    const result = extractResult(content)
    if (!result || !result.goals.length) throw new Error('AI 输出解析失败')
    return {
      success: true,
      source: 'ai',
      goals: postProcessGoals(result.goals),
      summary: result.summary,
    }
  } catch (e) {
    // 降级：规则切分（枚举/并列词）+ 依赖合并后处理，source 标记 rule，客户端可提示用户确认
    console.warn('[parseGoals] AI 调用失败，使用规则切分', e)
    const rule = ruleParseGoals(text)
    return {
      success: false,
      source: 'rule',
      goals: postProcessGoals(rule.goals),
      summary: rule.summary,
      error: (e && (e.errMsg || e.message)) || String(e),
    }
  }
}
