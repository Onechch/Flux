/**
 * 云函数：refineSuggestion（补充情况 → Agent 重新生成建议）
 *
 * 作用：用户在瓶颈卡片就地补充真实情况（快速标签 + 文字描述）后，
 *       结合任务完整信息 + 个人知识库，重新生成针对性建议（替代泛泛的初始建议）。
 * 输入：{ taskId: '卡点任务ID', userContext: { tags: ['试过没用'], text: '我试过…' } }
 * 输出：{ success: true, source: 'ai'|'rule', suggestions: [{key,type,action,reason,effect,priority}],
 *         relatedKnowledge: [标题], basedOn: 'user_context', userContext, error? }
 *
 * 服务端完整流程（与客户端 pages/index/index.js submitUserContext 的第二层降级一致）：
 *   1. 查询任务完整信息（名称/耗时/状态/依赖 → 前置任务名/被阻塞的下游）
 *   2. 检索 knowledge 集合（仅 active；子串双向包含打分，个人经验优先，top 3）
 *   3. 任务信息 + 用户补充 + 知识参考 → 大模型生成针对性建议
 *   4. 新建议追加 tasks.suggestionHistory（保留最近 5 条）、更新 tasks.userContext（version 递增）
 *   5. 命中的知识 usageCount + 1（被 Agent 引用的次数）
 *
 * 调用链（客户端 pages/index/index.js submitUserContext）：
 *   层1 客户端直调 wx.cloud.extend.AI（miniprogram/utils/ai.js refineSuggestion）
 *   层2 本云函数（AI 生成 + 规则降级；本地模式下客户端不可见云端写入，客户端会跳过本层）
 *   层3 utils/suggestions.js generateCtxSuggestions（标签规则，客户端落库）
 *
 * 规则降级（AI 不可用）：按用户选中的快速标签映射预设策略（缺资源→外包/替代、
 * 不会做→求助、没时间→委派让路、等别人→催办、试过没用→换思路拆小、要求变了→对齐范围）。
 *
 * 部署：微信开发者工具中右键 refineSuggestion 目录 → 上传并部署（云端安装依赖）
 * 注意：AI 生成约需 5~15 秒，config.json 已将函数超时设为 30 秒。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 系统提示词：与客户端 miniprogram/utils/ai.js 的 REFINE_SUGGESTION_SYSTEM_PROMPT 保持一致
const SYSTEM_PROMPT = `你是一位资深项目管理顾问，专精于约束理论和流程优化。用户的任务卡住了，你需要结合用户补充的真实情况，给出具体可操作的建议。

要求：
1. 建议必须具体可操作，不要空泛（不要说"优化条件"，要说"尝试将诱导温度从37度降到16度，同时将IPTG浓度调整为0.1mM，做小量验证"）
2. 如果用户说"试过没用"，不要重复建议已经试过的方法，要给出新思路
3. 如果用户说"等别人"，建议中包含催办话术或并行方案
4. 如果用户说"没时间"，建议中包含优先级调整或任务委派
5. 如果用户说"不会做"，建议中包含学习路径或求助对象
6. 如果用户说"要求变了"，建议先对齐新要求再推进
7. 建议不超过3条，按优先级排序（priority: high/medium/low）
8. 语气务实，像同事给建议，不要像教科书
9. type 必须从以下选一：breakdown(拆解) parallel(并行) scope(砍需求) urge(催办) prepare(提前准备) backup(预备方案) focus(专注) delegate(委派) postpone(延后) help(求助) learn(快速学习) outsource(外包) switch(切前置) start(立即开始) expedite(优先处理) speedup(提速)
10. 如果提供了"相关知识库参考"，结合用户个人经验调整建议并在文案中自然体现（如"根据你的经验…"），用户经验优先于通用理论
11. 只输出纯JSON，不要任何解释文字或代码块标记

输出格式：
{"suggestions":[{"type":"help","action":"找师兄请教一次载体构建细节","reason":"自己摸索三天不如别人指点一句","effect":"当天就能开工","priority":"high"}],"relatedKnowledge":["引用的知识库条目标题"],"basedOn":"user_context"}`

// 建议类型白名单（与客户端 utils/ai.js SUGGESTION_TYPES / suggestions.js TYPES 保持一致）
const SUGGESTION_TYPES = [
  'breakdown', 'parallel', 'scope', 'urge', 'prepare', 'backup',
  'focus', 'delegate', 'postpone', 'help', 'learn', 'outsource',
  'switch', 'start', 'expedite', 'speedup',
]

// 快速标签 → 规则建议映射（与客户端 utils/suggestions.js CTX_TAG_RULES 保持一致）
const CTX_TAG_RULES = {
  缺资源: { type: 'outsource', action: '列出缺的具体资源，找替代或外包', reason: '资源缺口不补上，卡点会一直卡着', effect: '资源到位后可立即恢复推进' },
  不会做: { type: 'help', action: '找做过的人请教一次，比自学快', reason: '不熟悉的方法摸索成本最高', effect: '少走弯路，当天就能开工' },
  没时间: { type: 'delegate', action: '把其他任务让路或委派，给卡点留整块时间', reason: '碎片时间推进不动复杂卡点', effect: '集中精力突破，工期可控' },
  等别人: { type: 'urge', action: '现在就去催，并约定明确回复时间', reason: '干等没有产出，主动催办才有节奏', effect: '拿到回复即可恢复推进' },
  试过没用: { type: 'breakdown', action: '换思路：把卡点拆小，先做能验证的一小步', reason: '老方法重复试意义不大，需要新切入点', effect: '小步验证找到可行路径' },
  要求变了: { type: 'scope', action: '跟需求方重新对齐范围和交付标准', reason: '要求变了还按旧的做只会返工', effect: '对齐后按新要求直接推进' },
  其他: { type: 'focus', action: '写下卡住的具体原因，再定下一步', reason: '模糊的卡点最耗时间，先写清楚', effect: '问题明确后往往就有解法' },
}

// 模型入口依次尝试（与 extractKnowledge / refineTask 一致）
const MODEL_ATTEMPTS = [
  { provider: 'hunyuan-v3', model: 'hy3' },
  { provider: 'cloudbase', model: 'hy3' },
  { provider: 'cloudbase', model: 'deepseek-v4-flash' },
]

/**
 * 从模型输出中稳健提取"补充情况版"建议：兼容代码块围栏/前后缀文字；
 * type 白名单校验、priority 归一（high > medium > low）排序后取前 2 条；
 * 兼容 expectedEffect 字段名；解析失败返回 null。
 * 与客户端 miniprogram/utils/ai.js 的 extractRefinedSuggestions 同逻辑。
 */
function extractRefinedSuggestions(rawText, taskId, version) {
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
  const raw = parsed.suggestions
  if (!Array.isArray(raw) || !raw.length) return null

  const PRIORITY_RANK = { high: 0, medium: 1, low: 2 }
  const out = []
  raw.slice(0, 3).forEach((s) => {
    const type = SUGGESTION_TYPES.indexOf(s && s.type) > -1 ? s.type : 'speedup'
    const action = String((s && s.action) || '').trim().slice(0, 30)
    if (!action || out.some((x) => x.type === type)) return
    const priority = s && PRIORITY_RANK[s.priority] !== undefined ? s.priority : 'medium'
    out.push({
      key: taskId + ':ctx' + version + ':' + type,
      type: type,
      action: action,
      reason: String((s && s.reason) || '').trim().slice(0, 60),
      effect: String((s && (s.effect || s.expectedEffect)) || '').trim().slice(0, 60),
      priority: priority,
    })
  })
  if (!out.length) return null
  out.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])

  const relatedKnowledge = Array.isArray(parsed.relatedKnowledge)
    ? parsed.relatedKnowledge.map((t) => String(t || '').trim().slice(0, 20)).filter((t) => !!t).slice(0, 3)
    : []
  return { suggestions: out.slice(0, 2), relatedKnowledge: relatedKnowledge }
}

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

/**
 * 知识库检索（与客户端 utils/knowledge.js searchKnowledge 同口径的简化版）：
 * 仅检索 active 知识，子串双向包含打分（tag +3 / title +2 / content +1），
 * 类型权重（个人经验 ×1.5 > 模板 ×1.2 > 理论 ×1.0）+ usageCount 微弱加成，返回 top N。
 */
const TYPE_WEIGHTS = { user_experience: 1.5, best_practice: 1.5, task_template: 1.2, theory: 1.0 }

function scoreKnowledge(list, keywords, limit) {
  const words = (Array.isArray(keywords) ? keywords : [keywords])
    .map((w) => String(w || '').trim())
    .filter((w) => w && w.length >= 2)
  if (!words.length || !Array.isArray(list)) return []

  const scored = []
  list.forEach((k) => {
    if (!k || k.status !== 'active') return
    let score = 0
    const title = String(k.title || '')
    const content = String(k.content || '')
    const tags = Array.isArray(k.tags) ? k.tags : []
    words.forEach((w) => {
      if (tags.some((tag) => String(tag).indexOf(w) > -1 || w.indexOf(String(tag)) > -1)) score += 3
      if (title.indexOf(w) > -1 || w.indexOf(title) > -1) score += 2
      if (content.indexOf(w) > -1) score += 1
    })
    if (score <= 0) return
    score *= TYPE_WEIGHTS[k.type] || 1.0
    score += Math.min(k.usageCount || 0, 10) * 0.1
    scored.push({ knowledge: k, score: score })
  })
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 3)
    .map((x) => x.knowledge)
}

/** 规则降级：按用户选中的快速标签映射预设策略（与客户端 generateCtxSuggestions 同逻辑） */
function ruleRefinedSuggestions(taskId, userContext) {
  const tags = (userContext && userContext.tags) || []
  const version = (userContext && userContext.version) || 1
  const rules = []
  tags.forEach((tag) => {
    if (CTX_TAG_RULES[tag]) rules.push(CTX_TAG_RULES[tag])
  })
  if (!rules.length) rules.push(CTX_TAG_RULES['其他'])

  const out = []
  rules.slice(0, 2).forEach((r) => {
    if (out.some((x) => x.type === r.type)) return
    out.push({
      key: taskId + ':ctx' + version + ':' + r.type,
      type: r.type,
      action: r.action,
      reason: r.reason,
      effect: r.effect,
      priority: 'medium',
    })
  })
  return { suggestions: out, relatedKnowledge: [] }
}

exports.main = async (event = {}) => {
  const taskId = String(event.taskId || '').trim()
  const ctxInput = event.userContext || {}
  const tags = Array.isArray(ctxInput.tags)
    ? ctxInput.tags.map((t) => String(t || '').trim().slice(0, 10)).filter((t) => !!t).slice(0, 3)
    : []
  const text = String(ctxInput.text || '').trim().slice(0, 200)

  if (!taskId || (!tags.length && !text)) {
    return {
      success: false,
      suggestions: [],
      relatedKnowledge: [],
      basedOn: '',
      error: '参数不完整（需 taskId 和 userContext.tags/text 至少一项）',
    }
  }

  const db = cloud.database()
  const _ = db.command

  try {
    // 1. 查询卡点任务
    const taskRes = await db.collection('tasks').doc(taskId).get()
    const task = taskRes.data || {}
    if (!task || !task.title) {
      return { success: false, suggestions: [], relatedKnowledge: [], basedOn: '', error: '任务不存在' }
    }

    // 2. 查询全量任务（构建前置任务名/下游阻塞数/根目标名；数据量小一次取全）
    const allRes = await db.collection('tasks').limit(100).get()
    const allTasks = allRes.data || []
    const byId = {}
    allTasks.forEach((t) => {
      if (t && t._id) byId[t._id] = t
    })

    // 根目标名（沿 parentGoalId 祖先链上溯；guard 防环）
    let root = task
    const seen = {}
    while (root && root.parentGoalId && !seen[root._id]) {
      seen[root._id] = true
      root = byId[root.parentGoalId] || null
    }

    const prereqList = (task.dependencies || [])
      .map((d) => {
        const dep = byId[d]
        return dep ? { 任务: dep.title, 状态: dep.status || 'pending' } : null
      })
      .filter((x) => !!x)
    // 被该卡点直接阻塞的未完成下游数（dependencies 含 taskId 的任务）
    const blockedCount = allTasks.filter(
      (t) =>
        t &&
        t._id !== taskId &&
        t.status !== 'completed' &&
        Array.isArray(t.dependencies) &&
        t.dependencies.indexOf(taskId) > -1
    ).length

    const taskInfo = {
      所属目标: root ? root.title : '（未知）',
      瓶颈任务: task.title,
      任务描述: task.description || '（无）',
      状态: task.status || 'pending',
      预估耗时小时: task.estimatedHours || 0,
      实际耗时小时: task.actualHours || 0,
      前置任务: prereqList.length ? prereqList : '（无）',
      被阻塞的后续任务数: blockedCount,
    }

    // 3. 知识库检索（关键词：任务名 + 目标名 + 补充描述；个人经验优先）
    let knowledgeHits = []
    try {
      const kRes = await db.collection('knowledge').limit(100).get()
      knowledgeHits = scoreKnowledge(kRes.data || [], [task.title, root ? root.title : '', text], 3)
    } catch (e) {
      console.warn('[refineSuggestion] 知识库检索失败（跳过知识参考）', e)
    }

    // 4. 版本号：已有 userContext 版本 + 1（每次提交递增）
    const version = (task.userContext && task.userContext.version ? task.userContext.version : 0) + 1
    const userContext = {
      tags: tags,
      text: text,
      submittedAt: Date.now(),
      version: version,
    }

    // 5. AI 生成（失败 → 规则降级，保证总有建议）
    let source = 'ai'
    let result = null
    let llmError = null
    try {
      let userContent =
        '任务信息：\n' + JSON.stringify(taskInfo) +
        '\n\n用户补充的情况：\n快速标签：' + (tags.join('、') || '（无）') +
        '\n详细描述：' + (text || '（无）')
      if (knowledgeHits.length) {
        const refs = knowledgeHits
          .map((k, i) =>
            (i + 1) + '. [' + (k.type === 'theory' ? '理论' : '用户经验') + '] ' +
            k.title + '：' + k.content
          )
          .join('\n')
        userContent += '\n\n相关知识库参考（结合用户个人情况生成建议）：\n' + refs
      }
      const content = await callLLM([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ])
      result = extractRefinedSuggestions(content, taskId, version)
      if (!result) throw new Error('AI 建议解析失败')
    } catch (e) {
      llmError = e
      console.warn('[refineSuggestion] AI 调用失败，使用规则降级', e)
      source = 'rule'
      result = ruleRefinedSuggestions(taskId, userContext)
    }

    // 6. 落库：suggestionHistory 追加（保留最近 5 条）+ userContext 更新
    const history = Array.isArray(task.suggestionHistory) ? task.suggestionHistory : []
    history.push({
      version: version,
      suggestions: result.suggestions,
      relatedKnowledge: result.relatedKnowledge,
      generatedAt: Date.now(),
      basedOn: 'user_context',
      source: source,
    })
    const patch = {
      userContext: userContext,
      suggestionHistory: history.slice(-5),
      updatedAt: Date.now(),
    }
    await db.collection('tasks').doc(taskId).update({ data: patch })

    // 7. 命中的知识 usageCount + 1（引用计数，失败不影响主流程）
    knowledgeHits.forEach((k) => {
      db.collection('knowledge')
        .doc(k._id)
        .update({ data: { usageCount: _.inc(1), updatedAt: Date.now() } })
        .catch(() => {})
    })

    return {
      success: true,
      source: source,
      suggestions: result.suggestions,
      relatedKnowledge: result.relatedKnowledge,
      basedOn: 'user_context',
      userContext: userContext,
      suggestionHistory: patch.suggestionHistory,
      error: llmError ? (llmError.errMsg || llmError.message || String(llmError)) : undefined,
    }
  } catch (e) {
    console.error('[refineSuggestion] 执行失败', e)
    return {
      success: false,
      suggestions: [],
      relatedKnowledge: [],
      basedOn: '',
      error: (e && (e.errMsg || e.message)) || String(e),
    }
  }
}
