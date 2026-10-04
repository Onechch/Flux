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

// 多层级任务树工具（归一化 / CPM / 卡点链 / 导入，与云函数同逻辑的客户端副本）
const tree = require('./tree')

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

// 系统提示词：与云函数 breakdownTask 完全一致（多层级任务树版），避免两层行为不一致。
// 层级深度由复杂度自适应（1-5 层），拆到"可执行"和"卡点暴露"为止。
const BREAKDOWN_SYSTEM_PROMPT = `你是一位项目管理专家。请将用户输入的目标拆解为多层级任务树，层级深度由目标复杂度自动适配。

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

// 系统提示词：对话调优（多层级任务树版，与云函数 refineTask 保持一致）。
// 若调用方传入相关知识参考（用户经验优先于理论），要求建议结合用户个人情况，
// 并在文案中体现引用（如"根据你的习惯…"），让建议从"通用正确"变成"对你有用"。
const REFINE_SYSTEM_PROMPT = `你是一个任务管理专家。用户已有一版多层级任务树初稿，现在提出了反馈意见，请根据反馈调整任务树。

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

// 系统提示词：批量目标识别（与云函数 parseGoals 保持一致）。
// 核心原则：依赖关系优先合并 —— 任务A是任务B的前置条件，或多个任务指向同一交付物 → 合并为一个目标。
const PARSE_GOALS_SYSTEM_PROMPT = `你是一个任务识别专家。用户会输入一段自然语言，里面可能包含一个或多个独立的"目标"。

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

// 系统提示词：对话知识提取（与云函数 extractKnowledge 保持一致）。
// 覆盖补充情况场景的四类高价值信息：试过没用（无效经验）、资源限制、
// 外部要求（如导师/领导要求）、之前成功的方法（有效实践）。
const EXTRACT_SYSTEM_PROMPT = `你是一个信息提取专家。请分析用户与任务管理助手的对话，识别其中是否有值得存入个人知识库的有长期价值的信息。

要求：
1. 只提取对后续任务管理有长期价值的信息：工作习惯或偏好（如"我习惯上午做重要的事"）、资源或约束条件（如"我没有设计师配合"、"导师要求下周出结果"）、经验或教训（如"上次因为xxx导致延期"、"我试过xxx没用"、"我用xxx成功了"）、任务特征或技巧（如"季度汇报的关键是数据准确性"）
2. 忽略一次性的任务操作指令（"删除XX任务"、"增加XX"、"把XX改成N小时"这类调整本身不是知识）
3. 每条知识包含：title（10字以内概括）、content（信息要点，50字以内）、type（user_experience/best_practice/task_template 三选一；"试过没用"的无效方法→user_experience，"用xxx成功了"的有效方法→best_practice）、tags（1-3个标签）
4. 没有值得提取的信息时输出空数组
5. 只输出纯JSON，不要任何解释文字或代码块标记

输出格式：
{"items":[{"title":"上午效率高","content":"用户一般上午效率比较高，重要的事放上午做","type":"user_experience","tags":["习惯","效率"]}]}`

// 系统提示词：瓶颈智能建议（与建议类型白名单、index.js 采纳动作映射保持一致）
const SUGGESTION_TYPES = [
  'breakdown', 'parallel', 'scope',
  'urge', 'prepare', 'backup',
  'focus', 'delegate', 'postpone',
  'help', 'learn', 'outsource',
  'switch', 'start', 'expedite', 'speedup',
]

const SUGGESTION_SYSTEM_PROMPT = `你是一位资深项目管理顾问，专精于约束理论和流程优化。请为卡住的瓶颈任务生成具体可操作的建议。

要求：
1. 每条建议包含：action（做什么，20字以内）、reason（为什么，一句话）、effect（会怎样，一句话）
2. 建议要具体可落地，不要空泛（不说"提高效率"，要说"把xxx拆成2个小步"）
3. 语气务实接地气，像同事给建议，不要像教科书
4. 只输出1-2条最重要的建议，不要贪多
5. type 必须从以下选一：breakdown(拆解) parallel(并行) scope(砍需求) urge(催办) prepare(提前准备) backup(预备方案) focus(专注) delegate(委派) postpone(延后) help(求助) learn(快速学习) outsource(外包) switch(切前置) start(立即开始) expedite(优先处理) speedup(提速)
6. 只输出纯JSON，不要任何解释文字或代码块标记

输出格式：
{"suggestions":[{"type":"breakdown","action":"把数据分析拆成取数和建模两步","reason":"整块3小时容易中途卡壳","effect":"每步1.5小时，当天可完成"}]}`

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
  const res = await withTimeout(
    model.generateText({
      model: attempt.model,
      messages: messages,
    }),
    GEN_TIMEOUT_MS,
    'generateText'
  )
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
  const consume = (async () => {
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
    return content
  })()
  const content = await withTimeout(consume, STREAM_TIMEOUT_MS, 'streamText')
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

// 单次调用超时：免费通道偶发流挂起会导致批量拆解永久停滞，必须有硬性上限
const STREAM_TIMEOUT_MS = 25 * 1000 // 流式收齐上限
const GEN_TIMEOUT_MS = 15 * 1000 // 非流式上限

// 熔断：全部入口失败后进入冷却，冷却期内调用直接快速失败
// （批量拆解场景下避免每个目标重复全量失败循环）
let aiDownUntil = 0
const AI_DOWN_COOLDOWN_MS = 60 * 1000 // 一般失败冷却 60s
const AI_DOWN_QUOTA_COOLDOWN_MS = 5 * 60 * 1000 // 额度/模型级失败冷却 5min
const AI_BUDGET_COOLDOWN_MS = 30 * 1000 // 预算耗尽（通道慢而非不可用）短冷却

// 预算耗尽错误标记（区分于通道失败：不触发长冷却，30s 后自动重试）
const BUDGET_ERR_FLAG = 'AI_BUDGET_EXHAUSTED'

function isQuotaError(err) {
  const msg = String((err && (err.errMsg || err.message)) || err || '')
  return /quota|额度|ARREARS|欠费|MODEL_NOT_FOUND|not found in definitions|AI_MODEL_NOT_FOUND/i.test(msg)
}

function withTimeout(p, ms, label) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' 超时(' + ms + 'ms)')), ms)
  })
  // 败者定时器必须清理：主 Promise 先结算后，孤儿定时器稍后触发会产生
  // 未处理的 Promise 拒绝（Node 直接崩溃 / 小程序运行时告警并可能中断后续逻辑）
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

// 全局串行队列：同一时刻只允许一个 AI 请求在途，防止并发触发 429
let chatChain = Promise.resolve()

/**
 * 通用对话调用：messages → 完整文本（等待全部生成完，不做实时流式）。
 * 尝试顺序：每个模型入口先 streamText（流式收齐，hy3 实测稳定），
 * 再 generateText（非流式兜底）；任一成功即返回。
 * 429 → 同参数退避重试；其他错误 → 直接换下一个入口。
 * @param {Array} messages [{ role, content }]
 * @param {Object} [opts] { budgetMs: 单次调用总时间预算（批量场景防止单目标
 *        占用全部入口超时的总和——3入口×2方法最坏约 2 分钟） }
 * @returns {Promise<string>} 模型完整输出
 */
async function chat(messages, opts) {
  // 排入串行队列，前一个请求完成后再发起
  const run = chatChain.then(() => doChat(messages, opts))
  chatChain = run.then(
    () => {},
    () => {}
  )
  return run
}

async function doChat(messages, opts) {
  if (Date.now() < aiDownUntil) {
    throw new Error('AI 熔断冷却中，快速失败')
  }
  const ai = getAIEntry()
  if (!ai) {
    throw new Error('当前基础库不支持 wx.cloud.extend.AI（需 ≥ 3.7.1）')
  }
  const budgetMs = opts && Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : 0
  const deadline = budgetMs ? Date.now() + budgetMs : 0

  let lastError = null
  for (const attempt of MODEL_ATTEMPTS) {
    // streamText 优先：实测 hunyuan-v3/hy3 免费通道的 generateText 返回空内容，
    // 流式稳定；且失败后立即换 generateText 不会叠加请求
    for (const fn of [tryStreamText, tryGenerateText]) {
      // 预算耗尽：不再尝试剩余入口（慢 ≠ 不可用，直接抛预算错误）
      if (deadline && Date.now() >= deadline) {
        aiDownUntil = Date.now() + AI_BUDGET_COOLDOWN_MS
        throw new Error(BUDGET_ERR_FLAG + '（' + budgetMs + 'ms 内未获得结果，通道过慢）')
      }
      const method = fn === tryGenerateText ? 'generateText' : 'streamText'
      let tries = 0
      while (tries <= RATE_LIMIT_RETRIES) {
        try {
          // 预算内尝试：外层 race 到 deadline（在途请求也能被预算精确中断，
          // 否则单次流挂起仍会占满 25s 超时才轮到预算检查）
          const content = deadline
            ? await withTimeout(
                fn(ai, attempt, messages),
                Math.max(deadline - Date.now(), 1),
                BUDGET_ERR_FLAG
              )
            : await fn(ai, attempt, messages)
          if (content) {
            console.log('[ai] 成功:', attempt.provider + '/' + attempt.model, method)
            return content
          }
          console.warn('[ai] 不可用:', attempt.provider + '/' + attempt.model, method, '（SDK 无此方法，跳过）')
          break // 方法不存在（返回 null）→ 换下一个调用方式，不重试
        } catch (e) {
          // 预算耗尽中断：短冷却后抛出（区别于通道故障的长冷却）
          if (isBudgetError(e)) {
            aiDownUntil = Date.now() + AI_BUDGET_COOLDOWN_MS
            throw e
          }
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
  // 全部入口失败 → 进入熔断冷却：额度/模型级错误冷却更久
  const quota = isQuotaError(lastError)
  aiDownUntil = Date.now() + (quota ? AI_DOWN_QUOTA_COOLDOWN_MS : AI_DOWN_COOLDOWN_MS)
  console.warn('[ai] 全部入口失败，进入熔断冷却', quota ? '5min' : '60s')
  throw lastError || new Error('AI 调用失败')
}

/** AI 是否处于熔断冷却期（供降级路径跳过注定失败的调用） */
function isAiTemporarilyDown() {
  return Date.now() < aiDownUntil
}

/** 是否为预算耗尽错误（通道慢而非不可用：降级提示文案不同，冷却更短） */
function isBudgetError(err) {
  return String((err && (err.errMsg || err.message)) || err || '').indexOf(BUDGET_ERR_FLAG) > -1
}

/**
 * 从模型输出中稳健提取多层级任务树（归一化 + 信息缺口），
 * 复用 utils/tree.js 的 extractTreeResult（与云函数 breakdownTask 同逻辑）：
 * 兼容代码块围栏、前后缀文字、旧版扁平格式（tasks → 两层树）；解析失败返回 null。
 */
function extractBreakdownResult(rawText, goalText) {
  return tree.extractTreeResult(rawText, goalText)
}

/**
 * 目标拆解（初稿，多层级任务树版）：goal → { goal, infoGaps }
 * 层级深度由 AI 按复杂度自适应（1-5 层），归一化强制约束
 * （≤5 层、每节点 ≤8 子任务、全树 ≤40 节点）。
 * 每层瓶颈 / 卡点链由 utils/tree.js 的 computeTreeMeta 计算（客户端，不入 AI）。
 * @param {string} goal 用户目标
 * @param {number} [depthHint] 建议拆解深度（1-4，parseGoals 的 suggestedDepth）
 * @param {Object} [opts] { budgetMs: 单目标 AI 时间预算（批量拆解传 35s 左右，
 *        防止最坏 3入口×2方法×超时的总和拖垮整批） }
 * @returns {Promise<Object>} { goal: { title, estimatedHours, children[...] },
 *                              infoGaps: [string] }
 */
async function breakdownGoal(goal, depthHint, opts) {
  const depthNote =
    isFinite(depthHint) && depthHint >= 1 && depthHint <= 4
      ? '（建议拆解深度：' + Math.round(depthHint) + '层）'
      : ''
  const content = await chat(
    [
      { role: 'system', content: BREAKDOWN_SYSTEM_PROMPT },
      { role: 'user', content: goal + depthNote },
    ],
    opts
  )
  const result = extractBreakdownResult(content, goal)
  if (!result) throw new Error('AI 输出解析失败')
  return result
}

/**
 * 从模型输出中稳健提取调优结果（多层级任务树 + 调整说明），
 * 复用 utils/tree.js 的归一化（与云函数 refineTask 同逻辑）；解析失败返回 null。
 */
function extractRefineResult(rawText, goalTitle) {
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
      title: goalTitle,
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
  const root = tree.normalizeNode(rootRaw, 0, stats)
  if (!root || !root.children.length) return null
  if (!root.title) root.title = goalTitle

  return {
    goal: root,
    adjustmentSummary: String(parsed.adjustmentSummary || '').trim().slice(0, 60),
  }
}

/**
 * 从模型输出中稳健提取知识条目：兼容代码块围栏/前后缀文字；
 * type 白名单校验（theory 为预置专用，提取结果不允许）；解析失败返回 null。
 */
function extractKnowledgeItems(rawText) {
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

/**
 * 对话知识提取：分析用户反馈，识别值得存入知识库的信息（待确认状态由调用方落库）。
 * @param {string} userMessage 用户反馈文本
 * @param {string} context 对话上下文（目标名 + 当前任务概况，帮助模型理解）
 * @returns {Promise<Array>} 知识条目 [{ title, content, type, tags }]，可能为空数组
 */
async function extractKnowledge(userMessage, context) {
  const content = await chat([
    { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: '用户消息：' + userMessage + '\n对话上下文：' + (context || '（无）'),
    },
  ])
  const items = extractKnowledgeItems(content)
  if (items === null) throw new Error('AI 提取结果解析失败')
  return items
}

/**
 * 从模型输出中稳健提取目标识别结果：兼容代码块围栏/前后缀文字；
 * title 去重、complexity 白名单、长度截断（与云函数 parseGoals 同逻辑）；
 * subtasks 不入库（拆解由 breakdownTask 独立完成），mergeReason 保留；
 * 解析失败返回 null，无目标返回空数组。
 */
function extractParseResult(rawText) {
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
 * 依赖合并后处理（与云函数 parseGoals 的 postProcessGoals 保持一致）。
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
 * AI 已正确合并时不改动；供拆解页对规则切分结果同样调用（层3/429 路径）。
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

/**
 * 批量目标识别：一段自然语言 → 独立目标列表（依赖关系优先合并）。
 * @param {string} text 用户原始输入（可能包含多个目标 + 补充描述）
 * @returns {Promise<Object>} { goals: [{ title, description, complexity, mergeReason, reason }],
 *                              summary: string }
 */
async function parseGoals(text) {
  const content = await chat(
    [
      { role: 'system', content: PARSE_GOALS_SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
    { budgetMs: 60 * 1000 } // 单次识别整体预算（3入口×2方法最坏约 2min，压到 60s）
  )
  const result = extractParseResult(content)
  if (!result) throw new Error('AI 识别结果解析失败')
  return { goals: postProcessGoals(result.goals), summary: result.summary }
}

/**
 * 对话调优（多层级任务树版）：基于初稿树 + 用户反馈，AI 生成新版任务树。
 * @param {string} goal 用户原始目标
 * @param {Object} currentTree 当前任务树（utils/tree.js 归一化结构；
 *        兼容旧版扁平列表 [{ name, estimatedHours, dependencies }]，内部转两层树）
 * @param {string} userFeedback 用户反馈文本
 * @param {Array} [relatedKnowledge] 知识库检索命中的相关知识（可选）：
 *        [{ title, content, type, tags }]，作为个性化建议的参考上下文
 * @returns {Promise<Object>} { goal: <新任务树>, adjustmentSummary }
 */
async function refineTasks(goal, currentTree, userFeedback, relatedKnowledge) {
  // 旧版扁平列表兼容：转两层树（新版本并存期间）
  let treeInput = currentTree
  if (Array.isArray(currentTree)) {
    const stats = { count: 0 }
    treeInput = tree.normalizeNode(
      {
        title: goal,
        children: currentTree.map((t) => ({
          title: t.name,
          estimatedHours: t.estimatedHours,
          dependencies: t.dependencies,
          isExecutable: true,
        })),
      },
      0,
      stats
    )
  }

  let userContent =
    '用户原始目标：' + goal +
    '\n当前任务树（title/estimatedHours/dependencies/isExecutable/children 嵌套结构）：\n' +
    JSON.stringify(treeInput) +
    '\n用户反馈：' + userFeedback
  if (Array.isArray(relatedKnowledge) && relatedKnowledge.length) {
    const refs = relatedKnowledge
      .slice(0, 3)
      .map((k, i) =>
        (i + 1) + '. [' + (k.type === 'theory' ? '理论' : '用户经验') + '] ' +
        k.title + '：' + k.content
      )
      .join('\n')
    userContent += '\n用户知识库参考（结合用户个人情况生成建议）：\n' + refs
  }
  const content = await chat([
    { role: 'system', content: REFINE_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ])
  const result = extractRefineResult(content, goal)
  if (!result) throw new Error('AI 调优结果解析失败')
  return result
}

/**
 * 从模型输出中稳健提取建议列表：兼容代码块围栏/前后缀文字；
 * type 校验白名单（非法值兜底 speedup），action 必填；解析失败返回 null。
 */
function extractSuggestions(rawText, taskId) {
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
  const raw = parsed.suggestions || (Array.isArray(parsed) ? parsed : null)
  if (!Array.isArray(raw) || !raw.length) return null

  const out = []
  raw.slice(0, 2).forEach((s) => {
    const type = SUGGESTION_TYPES.indexOf(s && s.type) > -1 ? s.type : 'speedup'
    const action = String((s && s.action) || '').trim().slice(0, 30)
    if (!action || out.some((x) => x.type === type)) return // 去重（同类型只留一条）
    out.push({
      key: taskId + ':ai:' + type, // 稳定 key：忽略/采纳跨刷新去重
      type: type,
      action: action,
      reason: String((s && s.reason) || '').trim().slice(0, 60),
      effect: String((s && s.effect) || '').trim().slice(0, 60),
    })
  })
  return out.length ? out : null
}

/**
 * 瓶颈智能建议：传入卡点任务完整信息，AI 生成 1-2 条可操作建议。
 * @param {Object} info { 目标, 任务, 描述, 状态, 预估耗时, 实际耗时, 前置任务, 被阻塞的后续任务数 }
 * @param {string} taskId 卡点任务 ID（用于生成稳定 key）
 * @returns {Promise<Array>} [{ key, type, action, reason, effect }]
 */
async function suggestForBottleneck(info, taskId) {
  const content = await chat([
    { role: 'system', content: SUGGESTION_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(info) },
  ])
  const suggestions = extractSuggestions(content, taskId)
  if (!suggestions) throw new Error('AI 建议解析失败')
  return suggestions
}

/* ---------------- 补充情况 → 重新生成建议（refineSuggestion） ---------------- */

// 系统提示词：基于用户补充情况重新生成卡点建议（与云函数 refineSuggestion 保持一致）。
// 输入 = 任务表面信息 + 用户补充（标签/描述）+ 知识库参考，输出针对性建议。
const REFINE_SUGGESTION_SYSTEM_PROMPT = `你是一位资深项目管理顾问，专精于约束理论和流程优化。用户的任务卡住了，你需要结合用户补充的真实情况，给出具体可操作的建议。

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

/**
 * 从模型输出中稳健提取"补充情况版"建议：兼容代码块围栏/前后缀文字；
 * type 白名单校验（非法值兜底 speedup）、priority 归一（high > medium > low），
 * 按 priority 排序后取前 2 条（建议卡片最多展示 2 条）；
 * 兼容 expectedEffect 字段名（映射为 effect）；解析失败返回 null。
 * 与云函数 refineSuggestion 的 extractRefinedSuggestions 同逻辑。
 * @param {string} rawText 模型输出
 * @param {string} taskId 卡点任务 ID（稳定 key：忽略/采纳跨刷新去重）
 * @param {number} version 补充信息版本号（每次提交递增，key 随版本更新）
 * @returns {Object|null} { suggestions: [{key,type,action,reason,effect,priority}],
 *                          relatedKnowledge: [标题] }
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
    if (!action || out.some((x) => x.type === type)) return // 去重（同类型只留一条）
    const priority = s && PRIORITY_RANK[s.priority] !== undefined ? s.priority : 'medium'
    out.push({
      key: taskId + ':ctx' + version + ':' + type, // 稳定 key：随版本更新
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

/**
 * 补充情况 → Agent 重新生成建议（客户端直调层，云函数 refineSuggestion 为第二层）。
 * @param {Object} taskInfo 卡点任务信息（目标/任务/状态/耗时/前置/下游，口径同 suggestForBottleneck）
 * @param {Object} userContext { tags: [标签], text: 详细描述, version }
 * @param {string} taskId 卡点任务 ID（稳定 key）
 * @param {Array} [relatedKnowledge] 知识库检索命中（可选）：[{ title, content, type }]
 * @returns {Promise<Object>} { suggestions: [{key,type,action,reason,effect,priority}],
 *                              relatedKnowledge: [标题] }
 */
async function refineSuggestion(taskInfo, userContext, taskId, relatedKnowledge) {
  const ctx = userContext || {}
  let userContent =
    '任务信息：\n' + JSON.stringify(taskInfo) +
    '\n\n用户补充的情况：\n快速标签：' +
    ((ctx.tags || []).join('、') || '（无）') +
    '\n详细描述：' + (ctx.text || '（无）')
  if (Array.isArray(relatedKnowledge) && relatedKnowledge.length) {
    const refs = relatedKnowledge
      .slice(0, 3)
      .map((k, i) =>
        (i + 1) + '. [' + (k.type === 'theory' ? '理论' : '用户经验') + '] ' +
        k.title + '：' + k.content
      )
      .join('\n')
    userContent += '\n\n相关知识库参考（结合用户个人情况生成建议）：\n' + refs
  }
  const content = await chat([
    { role: 'system', content: REFINE_SUGGESTION_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ])
  const result = extractRefinedSuggestions(content, taskId, ctx.version || 1)
  if (!result) throw new Error('AI 建议解析失败')
  return result
}

module.exports = {
  chat,
  breakdownGoal,
  parseGoals,
  postProcessGoals,
  refineTasks,
  extractKnowledge,
  suggestForBottleneck,
  refineSuggestion,
  extractRefinedSuggestions,
  isRateLimited,
  isAiTemporarilyDown,
  isBudgetError,
}
