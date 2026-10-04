/**
 * 云函数：extractKnowledge（对话知识提取）
 *
 * 作用：分析用户与 Agent 的对话反馈，提取值得存入知识库的有长期价值的信息
 *       （工作习惯、资源约束、经验教训、任务特征），返回条目列表由客户端
 *       写入 knowledge 集合（status: 'pending'，用户确认后 Agent 才引用）。
 * 输入：{ userMessage: '我一般上午效率比较高', context: '目标：xx；当前子任务：…' }
 * 输出：{ success: true, source: 'ai'|'rule', items: [{title,content,type,tags}] }
 *
 * 调用链（客户端 pages/breakdown/index.js triggerKnowledgeExtraction）：
 *   1. 客户端直调 wx.cloud.extend.AI（见 miniprogram/utils/ai.js extractKnowledge）
 *   2. 本云函数（AI 提取 + 规则降级）
 *   两层均失败时客户端静默跳过（知识提取是增值功能，不阻塞调优主流程）
 *
 * 规则降级（AI 不可用时基于正则的高置信度模式提取，宁缺毋滥）：
 * - "我习惯/我一般/我喜欢 + …"              → 工作习惯（user_experience）
 * - "上次/上次因为 + …（导致/以后要）…"      → 经验教训（best_practice）
 * - "需要等/没有xx配合/不能xx"              → 资源约束（user_experience）
 * - "xx通常需要N天/xx总是最耗时/xx的关键是"  → 任务特征（task_template）
 *
 * 部署：微信开发者工具中右键 extractKnowledge 目录 → 上传并部署（云端安装依赖）
 * 注意：AI 生成约需 5~15 秒，config.json 已将函数超时设为 30 秒。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 系统提示词：与客户端 miniprogram/utils/ai.js 的 EXTRACT_SYSTEM_PROMPT 保持一致。
// 覆盖补充情况场景的四类高价值信息：试过没用（无效经验）、资源限制、
// 外部要求（如导师/领导要求）、之前成功的方法（有效实践）。
const SYSTEM_PROMPT = `你是一个信息提取专家。请分析用户与任务管理助手的对话，识别其中是否有值得存入个人知识库的有长期价值的信息。

要求：
1. 只提取对后续任务管理有长期价值的信息：工作习惯或偏好（如"我习惯上午做重要的事"）、资源或约束条件（如"我没有设计师配合"、"导师要求下周出结果"）、经验或教训（如"上次因为xxx导致延期"、"我试过xxx没用"、"我用xxx成功了"）、任务特征或技巧（如"季度汇报的关键是数据准确性"）
2. 忽略一次性的任务操作指令（"删除XX任务"、"增加XX"、"把XX改成N小时"这类调整本身不是知识）
3. 每条知识包含：title（10字以内概括）、content（信息要点，50字以内）、type（user_experience/best_practice/task_template 三选一；"试过没用"的无效方法→user_experience，"用xxx成功了"的有效方法→best_practice）、tags（1-3个标签）
4. 没有值得提取的信息时输出空数组
5. 只输出纯JSON，不要任何解释文字或代码块标记

输出格式：
{"items":[{"title":"上午效率高","content":"用户一般上午效率比较高，重要的事放上午做","type":"user_experience","tags":["习惯","效率"]}]}`

// 模型入口依次尝试（与 refineTask / breakdownTask 一致）：
// 1. hunyuan-v3 + hy3 —— 小程序成长计划专用 Provider（仅消耗免费额度）
// 2. cloudbase + hy3 —— 付费 Token 资源包通道兜底
// 3. cloudbase + deepseek-v4-flash —— 付费兜底
const MODEL_ATTEMPTS = [
  { provider: 'hunyuan-v3', model: 'hy3' },
  { provider: 'cloudbase', model: 'hy3' },
  { provider: 'cloudbase', model: 'deepseek-v4-flash' },
]

/**
 * 从模型输出中稳健提取知识条目：兼容代码块围栏、前后缀文字；
 * type 白名单校验（theory 为预置专用，提取结果不允许）；解析失败返回 null。
 * 与客户端 miniprogram/utils/ai.js 的 extractKnowledgeItems 同逻辑。
 */
function extractItems(rawText) {
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
  const raw = parsed.items || (Array.isArray(parsed) ? parsed : null)
  if (!Array.isArray(raw) || !raw.length) return []

  const out = []
  raw.slice(0, 3).forEach((item) => {
    const title = String((item && item.title) || '').trim().slice(0, 20)
    const content = String((item && item.content) || '').trim().slice(0, 100)
    const type =
      item && ['user_experience', 'best_practice', 'task_template'].indexOf(item.type) > -1
        ? item.type
        : 'user_experience'
    if (!title || !content || out.some((x) => x.title === title)) return
    const tags = Array.isArray(item.tags)
      ? item.tags
          .map((t) => String(t || '').trim().slice(0, 10))
          .filter((t) => !!t)
          .slice(0, 3)
      : []
    out.push({ title: title, content: content, type: type, tags: tags })
  })
  return out
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
 * 规则降级：基于正则的高置信度模式提取（AI 不可用时的兜底）。
 * 每条模式只截取用户原句要点（不虚构内容），最多返回 2 条；无命中返回空数组。
 * 与客户端 knowledge.js 的 EXTRACT_HINT_RE 预筛口径互补：这里做"精提"，宁可漏不可错。
 */
function ruleExtract(userMessage) {
  const msg = String(userMessage || '').trim()
  const items = []

  // 1. 经验教训："上次因为…（导致/以后要）…" —— 教训价值最高，优先提取
  const lesson = msg.match(/上次[^，。]{0,30}(?:导致|造成|以后|下次)[^，。]{0,30}/)
  if (lesson && lesson[0]) {
    items.push({
      title: '过往教训',
      content: lesson[0].slice(0, 50),
      type: 'best_practice',
      tags: ['教训'],
    })
  }

  // 2. 工作习惯："我习惯/我一般/我喜欢/我通常 + …"
  const habit = msg.match(/我(?:习惯|一般|通常|喜欢|偏好)[^，。]{0,30}/)
  if (habit && habit[0]) {
    items.push({
      title: '个人习惯',
      content: habit[0].slice(0, 50),
      type: 'user_experience',
      tags: ['习惯', '偏好'],
    })
  }

  // 3. 资源约束："需要等…/没有…配合/…不能…"
  if (items.length < 2) {
    const resource = msg.match(/[^，。]{0,10}(?:需要等|没有|不能)[^，。]{0,20}/)
    if (resource && resource[0] && resource[0].length >= 4) {
      items.push({
        title: '资源约束',
        content: resource[0].slice(0, 50),
        type: 'user_experience',
        tags: ['资源', '约束'],
      })
    }
  }

  // 4. 任务特征："…通常需要N天/…总是最耗时/…的关键是…"
  if (items.length < 2) {
    const feature = msg.match(/[^，。]{0,15}(?:通常需要|总是|的关键是|关键是)[^，。]{0,25}/)
    if (feature && feature[0] && feature[0].length >= 5) {
      items.push({
        title: '任务特征',
        content: feature[0].slice(0, 50),
        type: 'task_template',
        tags: ['任务特征'],
      })
    }
  }

  return items.slice(0, 2)
}

exports.main = async (event = {}) => {
  const userMessage = String(event.userMessage || '').trim()
  const context = String(event.context || '').trim()

  if (!userMessage) {
    return {
      success: false,
      source: 'invalid',
      items: [],
      error: '参数不完整（需 userMessage）',
    }
  }

  try {
    const content = await callLLM([
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: '用户消息：' + userMessage + '\n对话上下文：' + (context || '（无）'),
      },
    ])
    const items = extractItems(content)
    if (items === null) throw new Error('AI 提取结果解析失败')
    return { success: true, source: 'ai', items: items }
  } catch (e) {
    // 降级：AI 不可用时基于正则做高置信度模式提取（无命中返回空数组）
    console.warn('[extractKnowledge] AI 调用失败，使用规则降级', e)
    const items = ruleExtract(userMessage)
    return {
      success: true,
      source: 'rule',
      items: items,
      error: (e && (e.errMsg || e.message)) || String(e),
    }
  }
}
