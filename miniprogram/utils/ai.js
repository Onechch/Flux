/**
 * utils/ai.js —— 客户端 AI 直调封装（wx.cloud.extend.AI）
 *
 * 官方文档（小程序端大模型接入）：
 * https://developers.weixin.qq.com/minigame/dev/wxcloud/guide/extensions/extend/ai/model.html
 *
 * API 要点（2026 版）：
 * - 入口：wx.cloud.extend.AI（基础库 ≥ 3.7.1 具备该对象；createModel("cloudbase") 需 ≥ 3.15.1）
 * - 供应商标识仅支持 "cloudbase"（云开发售卖模型）与 "hunyuan-v3"（体验）；
 *   混元通过 createModel("cloudbase") + model: "hy3" 调用（成长计划免费额度）
 * - 非流式 generateText：参数无 data 包裹层，{ model, messages } 直传，
 *   返回 res.choices[0].message.content —— 本项目 MVP"等待完整结果"，优先用它
 * - 流式 streamText：参数有 data 包裹层，for await 消费 res.textStream —— 兜底用
 *
 * 使用前提：
 * 1. app.js 的 wx.cloud.init 已填写真实云环境 env
 * 2. CloudBase 控制台 → 你的环境 → AI+ → 已开通（按 token 计费，新用户有免费额度）
 */

// 模型入口依次尝试：
// 1. hunyuan-v3 + hy3 —— 小程序成长计划专用 Provider（仅消耗免费额度）
// 2. cloudbase + hy3 —— 付费 Token 资源包通道（免费额度环境不可用时兜底）
// 3. cloudbase + deepseek-v4-flash —— 付费兜底
// 参考：https://docs.cloudbase.net/error-code/AI_MODEL_NOT_FOUND
// （hunyuan-v3 仅成长计划 SDK 调用；cloudbase 免费额度耗尽后自动消耗套餐额度）
const MODEL_ATTEMPTS = [
  { provider: 'hunyuan-v3', model: 'hy3' },
  { provider: 'cloudbase', model: 'hy3' },
  { provider: 'cloudbase', model: 'deepseek-v4-flash' },
]

// 系统提示词：与云函数 breakdownTask 完全一致，避免两层行为不一致
const BREAKDOWN_SYSTEM_PROMPT = `你是一位项目管理专家。请将用户输入的目标拆解为具体的子任务列表。

要求：
1. 每个子任务包含：name（任务名，12字以内）、estimatedHours（预估小时数，0.5-8之间的数值）、dependencies（前置依赖的任务名列表，若无依赖则为空数组）
2. 按执行顺序排列
3. dependencies 必须引用已拆解任务的确切名称，不得虚构
4. 拆解粒度适中（3-8个子任务）
5. 只输出纯JSON，不要任何解释文字或代码块标记

输出格式：
{"tasks":[{"name":"收集数据","estimatedHours":2,"dependencies":[]},{"name":"数据分析","estimatedHours":3,"dependencies":["收集数据"]}]}`

function getAIEntry() {
  if (wx.cloud && wx.cloud.extend && wx.cloud.extend.AI) {
    return wx.cloud.extend.AI
  }
  return null
}

/**
 * 单次尝试：非流式 generateText（参数无 data 包裹层）
 * 返回 res.choices[0].message.content；不可用（旧基础库无此方法）返回 null
 */
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

/**
 * 单次尝试：流式 streamText（参数有 data 包裹层），收齐完整文本
 */
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
  // 流式返回：循环收齐完整文本（不做实时流式输出，等完整结果）
  for await (const chunk of res.textStream) {
    content += chunk
  }
  if (content && content.trim()) return content
  throw new Error('模型返回空内容')
}

/**
 * 429 限流识别：成长计划免费额度有并发限制（EXCEED_CONCURRENT_REQUEST_LIMIT），
 * 触发后应退避等待重试，而不是立即切换入口叠加请求。
 */
function isRateLimited(err) {
  const msg = String((err && (err.errMsg || err.message)) || err || '')
  return /429|too many requests|exceed_concurrent|concurrent request|rate.?limit/i.test(msg)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 429 同参数退避重试（最多 2 次，1.5s / 3s 递增）
const RATE_LIMIT_RETRIES = 2
const RATE_LIMIT_BACKOFF_MS = 1500

// 全局串行队列：同一时刻只允许一个 AI 请求在途，防止并发触发 429
let chatChain = Promise.resolve()

/**
 * 通用对话调用：messages → 完整文本（等待全部生成完，不做实时流式）。
 * 尝试顺序：每个模型入口先 streamText（流式收齐，hy3 实测稳定），
 * 再 generateText（非流式兜底）；任一成功即返回。
 * 429 → 同参数退避重试；其他错误 → 直接换下一个入口。
 * @param {Array} messages [{ role, content }]
 * @returns {Promise<string>} 模型完整输出
 */
async function chat(messages) {
  // 排入串行队列，前一个请求完成后再发起
  const run = chatChain.then(() => doChat(messages))
  chatChain = run.then(
    () => {},
    () => {}
  )
  return run
}

async function doChat(messages) {
  const ai = getAIEntry()
  if (!ai) {
    throw new Error('当前基础库不支持 wx.cloud.extend.AI（需 ≥ 3.7.1）')
  }

  let lastError = null
  for (const attempt of MODEL_ATTEMPTS) {
    // streamText 优先：实测 hunyuan-v3/hy3 免费通道的 generateText 返回空内容，
    // 流式稳定；且失败后立即换 generateText 不会叠加请求
    for (const fn of [tryStreamText, tryGenerateText]) {
      const method = fn === tryGenerateText ? 'generateText' : 'streamText'
      let tries = 0
      while (tries <= RATE_LIMIT_RETRIES) {
        try {
          const content = await fn(ai, attempt, messages)
          if (content) {
            console.log('[ai] 成功:', attempt.provider + '/' + attempt.model, method)
            return content
          }
          console.warn('[ai] 不可用:', attempt.provider + '/' + attempt.model, method, '（SDK 无此方法，跳过）')
          break // 方法不存在（返回 null）→ 换下一个调用方式，不重试
        } catch (e) {
          lastError = e
          // 关键诊断日志：打出每次尝试的入口与完整错误，便于定位
          console.warn('[ai] 失败:', attempt.provider + '/' + attempt.model, method, e)
          if (isRateLimited(e) && tries < RATE_LIMIT_RETRIES) {
            tries += 1
            await delay(RATE_LIMIT_BACKOFF_MS * tries) // 退避后重试同一入口
            continue
          }
          break // 非 429（如模型不存在/额度不足）→ 换下一个入口
        }
      }
    }
  }
  throw lastError || new Error('AI 调用失败')
}

/**
 * 从模型输出中稳健提取任务列表（与云函数 extractTasks 同逻辑）：
 * 兼容代码块围栏、前后缀文字；校验并归一化；解析失败返回 null。
 */
function extractTasks(rawText) {
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
  const rawTasks = parsed.tasks || (Array.isArray(parsed) ? parsed : null)
  if (!Array.isArray(rawTasks) || !rawTasks.length) return null

  const tasks = []
  rawTasks.slice(0, 12).forEach((t) => {
    const name = String(t && t.name ? t.name : '').trim().slice(0, 30)
    if (!name || tasks.some((x) => x.name === name)) return
    let hours = Number(t.estimatedHours)
    if (!isFinite(hours) || hours <= 0) hours = 1
    const deps = Array.isArray(t.dependencies)
      ? t.dependencies
          .map((d) => String(d || '').trim())
          .filter((d) => d && d !== name)
      : []
    tasks.push({ name: name, estimatedHours: Math.min(hours, 100), dependencies: deps })
  })
  return tasks.length ? tasks : null
}

/**
 * 目标拆解：goal → 子任务列表（不含关键路径，关键路径由 cpm.js 计算）
 * @param {string} goal 用户目标
 * @returns {Promise<Array>} [{ name, estimatedHours, dependencies }]
 */
async function breakdownGoal(goal) {
  const content = await chat([
    { role: 'system', content: BREAKDOWN_SYSTEM_PROMPT },
    { role: 'user', content: goal },
  ])
  const tasks = extractTasks(content)
  if (!tasks) throw new Error('AI 输出解析失败')
  return tasks
}

module.exports = {
  chat,
  breakdownGoal,
  isRateLimited,
}
