/**
 * 云函数：breakdownTask
 *
 * 作用：调用 DeepSeek 大模型，将用户目标拆解为带依赖关系的子任务列表。
 * 输入：{ goal: '完成季度汇报' }
 * 输出：{ success: true, tasks: [...], source: 'ai' }
 *       AI 不可用时：{ success: false, tasks: <预设示例>, source: 'fallback', error }
 *       （tasks 始终带兜底数据，source 字段供客户端决定是否再走客户端直调）
 *
 * 调用链（三层降级，任一层失败自动下沉）：
 *   1. 客户端直调：wx.cloud.extend.AI（官方明确支持路径，见 miniprogram/utils/ai.js）
 *   2. 本云函数：wx-server-sdk 的 AI 扩展（cloud.extend.AI / cloud.ai）
 *   3. 预设示例数据（本文件 FALLBACK_TASKS，与客户端保持一致）
 *
 * 部署：微信开发者工具中右键 breakdownTask 目录 → 上传并部署（云端安装依赖）
 * 注意：AI 生成约需 5~15 秒，config.json 已将函数超时设为 30 秒；
 *       如仍超时，请在云开发控制台将该函数超时时间调大（最大 60s）。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 系统提示词（关键）：引导模型按"目标→子任务→依赖关系→预估耗时"结构输出纯 JSON
const SYSTEM_PROMPT = `你是一位项目管理专家。请将用户输入的目标拆解为具体的子任务列表。

要求：
1. 每个子任务包含：name（任务名，12字以内）、estimatedHours（预估小时数，0.5-8之间的数值）、dependencies（前置依赖的任务名列表，若无依赖则为空数组）
2. 按执行顺序排列
3. dependencies 必须引用已拆解任务的确切名称，不得虚构
4. 拆解粒度适中（3-8个子任务）
5. 只输出纯JSON，不要任何解释文字或代码块标记

输出格式：
{"tasks":[{"name":"收集数据","estimatedHours":2,"dependencies":[]},{"name":"数据分析","estimatedHours":3,"dependencies":["收集数据"]}]}`

// AI 不可用时的降级示例（与客户端 pages/breakdown/index.js 保持一致）
const FALLBACK_TASKS = [
  { name: '明确目标范围', estimatedHours: 1, dependencies: [] },
  { name: '收集资料', estimatedHours: 2, dependencies: ['明确目标范围'] },
  { name: '撰写初稿', estimatedHours: 4, dependencies: ['收集资料'] },
  { name: '修改完善', estimatedHours: 2, dependencies: ['撰写初稿'] },
  { name: '最终审核', estimatedHours: 1, dependencies: ['修改完善'] },
]

// 模型入口依次尝试：
// 1. hunyuan-v3 + hy3 —— 小程序成长计划专用 Provider（仅消耗免费额度）
// 2. cloudbase + hy3 —— 付费 Token 资源包通道兜底
// 3. cloudbase + deepseek-v4-flash —— 付费兜底
const MODEL_ATTEMPTS = [
  { provider: 'hunyuan-v3', model: 'hy3' },
  { provider: 'cloudbase', model: 'hy3' },
  { provider: 'cloudbase', model: 'deepseek-v4-flash' },
]

/**
 * 从模型输出中稳健提取任务列表：
 * 兼容代码块围栏、前后缀文字；校验并归一化字段；返回 null 表示解析失败。
 */
function extractTasks(rawText) {
  if (!rawText) return null
  let text = String(rawText).replace(/```(json)?/gi, '').trim()
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
  const goal = String(event.goal || '').trim()
  if (!goal) {
    return { success: false, tasks: [], source: 'invalid', error: '请输入目标' }
  }

  try {
    const content = await callLLM([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: goal },
    ])
    const tasks = extractTasks(content)
    if (!tasks) throw new Error('AI 输出解析失败')
    return { success: true, tasks: tasks, source: 'ai' }
  } catch (e) {
    // 降级：返回预设示例，source 标记 fallback，客户端可再尝试直调
    console.warn('[breakdownTask] AI 调用失败，使用预设示例', e)
    return {
      success: false,
      tasks: FALLBACK_TASKS,
      source: 'fallback',
      error: (e && (e.errMsg || e.message)) || String(e),
    }
  }
}
