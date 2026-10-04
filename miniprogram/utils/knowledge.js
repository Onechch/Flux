/**
 * utils/knowledge.js —— 知识库核心逻辑（预置理论 + 检索算法）
 *
 * 知识库 = Agent 的"长期记忆"，两类知识：
 * - theory（理论）：运营管理核心概念，系统预置（PRESET_THEORY，客户端幂等写入）
 * - user_experience / best_practice / task_template（用户经验类）：
 *   从对话中 AI 自动提取（status: 'pending' 待确认）或用户手动添加
 *
 * 数据存储见 utils/api.js（knowledge 集合，云优先 + 本地降级，与 tasks 同模式）。
 *
 * 检索算法（searchKnowledge）：
 * - 中文场景不做分词，用「子串双向包含」匹配（tag 命中 +3 / title 命中 +2 / content 命中 +1）
 * - 类型权重：个人经验（user_experience/best_practice）×1.5 > 模板 ×1.2 > 理论 ×1.0
 *   （用户个人经验优先于通用理论）
 * - usageCount 作为微弱加成（经常被引用的知识优先）
 * - 数据量 < 几百条，前端内存计算无性能问题（首页 < 1.5s 不受影响：仅拆解页反馈时调用）
 */

// 知识类型 → 中文标签（知识库页 tab 与卡片标签共用）
const TYPE_LABELS = {
  theory: '理论',
  user_experience: '经验',
  best_practice: '经验',
  task_template: '模板',
}

// 系统预置理论知识（初始化时客户端写入 knowledge 集合，title 去重幂等）
const PRESET_THEORY = [
  {
    title: 'WIP限制（在制品限制）',
    content:
      'WIP（Work In Progress）限制是一种精益管理方法，通过限制同时进行的工作项数量来优化流程效率。多任务处理会导致认知负担增加、任务切换损耗、完成率下降。研究显示，将WIP限制在3项以内，可提升整体完成率约30%。在"个人运营官"中，建议同时推进的大目标不超过3项。',
    type: 'theory',
    tags: ['wip', '精益管理', '效率', '多任务'],
  },
  {
    title: '约束理论（TOC）',
    content:
      '约束理论由高德拉特提出，核心观点是"任何系统至少有一个约束，系统的产出由这个约束决定"。在任务管理中，瓶颈就是那个约束。找到瓶颈并集中资源解决它，是整个系统效率提升的关键。识别瓶颈后，应优先处理，其他任务应让路。',
    type: 'theory',
    tags: ['约束理论', 'toc', '瓶颈', '高德拉特'],
  },
  {
    title: '利特尔法则',
    content:
      '利特尔法则是排队理论的核心定律：平均在制品数量 = 平均吞吐率 × 平均完成时间。简单说，同时做越多事情，每件事完成得越慢。在个人任务管理中，减少并行任务数量是缩短完成时间最有效的方法。',
    type: 'theory',
    tags: ['利特尔法则', '排队理论', '吞吐率', '完成时间'],
  },
  {
    title: '关键路径法（CPM）',
    content:
      '关键路径法用于识别项目中最长的依赖链，这条链决定了项目的最短完成时间。关键路径上的任何延迟都会直接导致项目延期。在任务管理中，应优先保障关键路径上的任务按时完成，非关键路径任务可适当弹性调整。',
    type: 'theory',
    tags: ['关键路径法', 'cpm', '项目管理', '依赖链'],
  },
  {
    title: '丰田七大浪费',
    content:
      '丰田生产体系定义的七种浪费：过度生产、等待、运输、过度加工、库存、动作、缺陷。在个人任务管理中对应的浪费有：过度准备、等待他人回复、反复修改、过度完美主义、信息堆积、频繁切换任务、返工。',
    type: 'theory',
    tags: ['丰田', '浪费', '精益', '七大浪费'],
  },
  {
    title: '"鼓-缓冲-绳子"模型',
    content:
      '约束理论的执行框架。鼓是系统的节奏（瓶颈的节奏），缓冲是保护瓶颈不受干扰的安全余量，绳子是控制物料投放的机制（确保不超出瓶颈处理能力）。在个人任务管理中，瓶颈任务是"鼓"，为它预留的专注时间是"缓冲"，主动屏蔽其他任务是"绳子"。',
    type: 'theory',
    tags: ['鼓缓冲绳子', '约束理论', '执行框架'],
  },
]

// 类型权重：个人经验优先于通用理论（检索排序用）
const TYPE_WEIGHTS = {
  user_experience: 1.5,
  best_practice: 1.5,
  task_template: 1.2,
  theory: 1.0,
}

/**
 * 知识库检索：从已采纳（active）知识中匹配关键词，返回得分最高的 N 条。
 * @param {Array} list 全部知识（api.loadKnowledge 的返回值，含各 status）
 * @param {Array|string} keywords 关键词数组（如 [目标名, 反馈文本, 瓶颈任务名]）
 * @param {number} limit 返回条数上限（默认 3，Agent 建议上下文的上限）
 * @returns {Array} 命中的知识条目（按相关性降序，已剔除 _score 临时字段）
 */
function searchKnowledge(list, keywords, limit) {
  const words = (Array.isArray(keywords) ? keywords : [keywords])
    .map((w) => String(w || '').trim())
    .filter((w) => w && w.length >= 2) // 单字噪声太大，至少 2 字才参与匹配
  if (!words.length || !Array.isArray(list)) return []

  const scored = []
  list.forEach((k) => {
    if (!k || k.status !== 'active') return // 仅检索已采纳的知识
    let score = 0
    const title = String(k.title || '')
    const content = String(k.content || '')
    const tags = Array.isArray(k.tags) ? k.tags : []
    words.forEach((w) => {
      if (tags.some((tag) => String(tag).indexOf(w) > -1 || w.indexOf(String(tag)) > -1)) {
        score += 3 // 标签命中：最强信号
      }
      if (title.indexOf(w) > -1 || w.indexOf(title) > -1) {
        score += 2 // 标题命中
      }
      if (content.indexOf(w) > -1) {
        score += 1 // 内容命中
      }
    })
    if (score <= 0) return
    // 类型权重（个人经验 > 模板 > 理论）+ 引用次数微弱加成
    score *= TYPE_WEIGHTS[k.type] || 1.0
    score += Math.min(k.usageCount || 0, 10) * 0.1
    scored.push({ knowledge: k, score: score })
  })

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 3)
    .map((x) => x.knowledge)
}

/**
 * 对话提取预筛：判断反馈文本是否可能含有值得提取的个人信息。
 * 纯操作指令（"删除XX"）不触发 AI 提取，节省调用额度；
 * 宁可宽一点（AI 精提会再过滤），不漏掉有价值信息。
 */
const EXTRACT_HINT_RE =
  /习惯|一般|通常|总是|上次|上个月|上周|去年|偏好|喜欢|擅长|效率|踩坑|返工|教训|经验|模板|技巧|依赖|需要等|配合|资源|约束|不能|建议我/

function worthExtracting(feedback) {
  const text = String(feedback || '').trim()
  return text.length >= 8 && EXTRACT_HINT_RE.test(text)
}

/** 类型 → 中文标签 */
function typeLabel(type) {
  return TYPE_LABELS[type] || '其他'
}

module.exports = {
  PRESET_THEORY,
  TYPE_LABELS,
  TYPE_WEIGHTS,
  EXTRACT_HINT_RE,
  searchKnowledge,
  worthExtracting,
  typeLabel,
}
