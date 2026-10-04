/**
 * utils/validation.js —— 数据验证层（云数据库写入前的前置校验）
 *
 * 职责：确保写入 tasks / knowledge 集合的数据完整且合法，脏数据不落库。
 * 设计（务实取舍，避免破坏既有 AI 生成链路）：
 * - 必填缺失 / 类型错误 / 枚举外取值 / 数值越界 → 抛 ValidationError（中文可读）
 * - 文本超长 → 静默截断到上限（AI 输出偶发超长，截断优于报错）
 * - patch 模式只校验 schema 已知字段，未知字段原样透传（兼容 db.command 等内部值）
 *
 * 集合 schema 与云数据库保持一致（见 utils/api.js 头部注释）。
 * ValidationError 会被 utils/dberrors.js 归类为 type='validation'（不可重试）。
 */

/** 校验错误：message 为面向用户的中文提示，fields 为出错字段名列表 */
function ValidationError(message, fields) {
  this.name = 'ValidationError'
  this.message = message
  this.fields = fields || []
  this.type = 'validation'
}
ValidationError.prototype = Object.create(Error.prototype)
ValidationError.prototype.constructor = ValidationError

/** tasks 集合字段规则（modificationCount/createdAt/updatedAt 为系统内部字段，不走 patch 校验） */
const TASK_FIELDS = {
  title: { type: 'string', required: true, max: 100, label: '任务名称' },
  description: { type: 'string', max: 1000, label: '任务描述' },
  estimatedHours: { type: 'number', min: 0, max: 10000, label: '预估耗时' },
  actualHours: { type: 'number', min: 0, max: 100000, label: '实际耗时' },
  status: {
    type: 'enum',
    values: ['pending', 'locked', 'in_progress', 'completed'],
    label: '状态',
  },
  isBottleneck: { type: 'boolean', label: '瓶颈标记' },
  dependencies: { type: 'stringArray', maxItems: 20, itemMax: 64, label: '前置依赖' },
  projectId: { type: 'string', max: 64, label: '项目ID' },
  parentGoalId: { type: 'string', max: 64, label: '父目标ID' },
  level: { type: 'integer', min: 0, max: 5, label: '层级' },
  aiHint: { type: 'string', max: 200, label: 'AI卡点提示' },
  userContext: { type: 'userContext', label: '补充情况' },
  suggestionHistory: { type: 'suggestionHistory', label: '建议历史' },
}

/** knowledge 集合字段规则 */
const KNOWLEDGE_FIELDS = {
  title: { type: 'string', required: true, max: 50, label: '知识标题' },
  content: { type: 'string', required: true, max: 500, label: '知识内容' },
  type: {
    type: 'enum',
    values: ['theory', 'user_experience', 'best_practice', 'task_template'],
    label: '知识类型',
  },
  tags: { type: 'stringArray', maxItems: 5, itemMax: 10, label: '标签' },
  status: { type: 'enum', values: ['active', 'pending', 'ignored'], label: '状态' },
  source: { type: 'enum', values: ['preset', 'manual', 'extracted'], label: '来源' },
  usageCount: { type: 'integer', min: 0, max: 100000, label: '引用次数' },
  rating: { type: 'integer', min: 0, max: 5, label: '评分' },
}

/**
 * 校验单个字段，返回规范化后的值（文本截断/去空白）。
 * 出错时向 errors 累积 { field, message }，不中断（一次报全）。
 */
function validateField(name, rule, value, errors) {
  const label = rule.label || name

  // 必填检查（仅显式传入时才判空；patch 局部更新允许字段缺席）
  if (value === undefined || value === null) {
    if (rule.required) errors.push({ field: name, message: label + '不能为空' })
    return undefined
  }

  switch (rule.type) {
    case 'string': {
      if (typeof value !== 'string') {
        errors.push({ field: name, message: label + '必须是文本' })
        return undefined
      }
      const trimmed = value.trim()
      // 必填文本去空白后为空视为缺失：否则 '   ' 会绕过 required 检查落库为空标题
      if (rule.required && !trimmed) {
        errors.push({ field: name, message: label + '不能为空' })
        return undefined
      }
      return rule.max && trimmed.length > rule.max ? trimmed.slice(0, rule.max) : trimmed
    }
    case 'number': {
      if (typeof value !== 'number' || !isFinite(value)) {
        errors.push({ field: name, message: label + '必须是数字' })
        return undefined
      }
      if ((rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max)) {
        errors.push({
          field: name,
          message: label + '需在 ' + rule.min + ' ~ ' + rule.max + ' 之间',
        })
        return undefined
      }
      return value
    }
    case 'integer': {
      if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value) {
        errors.push({ field: name, message: label + '必须是整数' })
        return undefined
      }
      if ((rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max)) {
        errors.push({
          field: name,
          message: label + '需在 ' + rule.min + ' ~ ' + rule.max + ' 之间',
        })
        return undefined
      }
      return value
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        errors.push({ field: name, message: label + '格式不正确' })
        return undefined
      }
      return value
    }
    case 'enum': {
      if (!rule.values || rule.values.indexOf(value) === -1) {
        errors.push({ field: name, message: label + '取值不合法' })
        return undefined
      }
      return value
    }
    case 'stringArray': {
      if (!Array.isArray(value)) {
        errors.push({ field: name, message: label + '必须是列表' })
        return undefined
      }
      if (rule.maxItems && value.length > rule.maxItems) {
        errors.push({ field: name, message: label + '最多 ' + rule.maxItems + ' 项' })
        return undefined
      }
      return value.map((item) => {
        const s = String(item === null || item === undefined ? '' : item).trim()
        return rule.itemMax && s.length > rule.itemMax ? s.slice(0, rule.itemMax) : s
      })
    }
    case 'userContext': {
      // { tags: string[≤3], text: string≤200, submittedAt: number, version: integer≥1 }
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push({ field: name, message: label + '格式不正确' })
        return undefined
      }
      const ctx = {
        tags: [],
        text: '',
        submittedAt: value.submittedAt || 0,
        version: value.version || 1,
      }
      if (Array.isArray(value.tags)) {
        ctx.tags = value.tags
          .map((t) => String(t || '').trim().slice(0, 10))
          .filter((t) => !!t)
          .slice(0, 3)
      }
      if (typeof value.text === 'string') {
        ctx.text = value.text.trim().slice(0, 200)
      }
      if (typeof ctx.version !== 'number' || Math.floor(ctx.version) !== ctx.version || ctx.version < 1) {
        ctx.version = 1
      }
      return ctx
    }
    case 'suggestionHistory': {
      // [{ version, suggestions[], relatedKnowledge[], generatedAt, basedOn, source }]，保留最近 5 条
      if (!Array.isArray(value)) {
        errors.push({ field: name, message: label + '必须是列表' })
        return undefined
      }
      return value
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .map((item) => ({
          version: typeof item.version === 'number' ? item.version : 1,
          suggestions: Array.isArray(item.suggestions) ? item.suggestions.slice(0, 3) : [],
          relatedKnowledge: Array.isArray(item.relatedKnowledge) ? item.relatedKnowledge : [],
          generatedAt: item.generatedAt || 0,
          basedOn: item.basedOn || '',
          source: item.source || '',
        }))
        .slice(-5)
    }
    default:
      return value
  }
}

/**
 * 通用校验入口。
 * @param {Object} fields schema（TASK_FIELDS / KNOWLEDGE_FIELDS）
 * @param {Object} input 待校验对象
 * @param {Object} opts { partial: true } 时跳过必填检查（patch 局部更新）
 * @returns {Object} 规范化后的数据（仅包含 schema 已知字段且值合法）
 * @throws {ValidationError} 任一字段校验失败时抛出（message 汇总所有错误）
 */
function validateWith(fields, input, opts = {}) {
  const errors = []
  const out = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('数据格式不正确', ['input'])
  }
  Object.keys(fields).forEach((name) => {
    const rule = fields[name]
    const value = input[name]
    if (value === undefined) {
      if (rule.required && !opts.partial) {
        errors.push({ field: name, message: (rule.label || name) + '不能为空' })
      }
      return
    }
    const normalized = validateField(name, rule, value, errors)
    if (normalized !== undefined) out[name] = normalized
  })
  if (errors.length) {
    throw new ValidationError(errors.map((e) => e.message).join('；'), errors.map((e) => e.field))
  }
  return out
}

/** 校验新增任务参数（完整校验，title 必填） */
function validateTaskInput(input) {
  return validateWith(TASK_FIELDS, input)
}

/** 校验任务 patch（partial：只校验传入的已知字段，未知字段由调用方保留） */
function validateTaskPatch(patch) {
  return validateWith(TASK_FIELDS, patch, { partial: true })
}

/** 校验新增知识条目参数（title/content 必填） */
function validateKnowledgeInput(input) {
  return validateWith(KNOWLEDGE_FIELDS, input)
}

/** 校验知识 patch（partial） */
function validateKnowledgePatch(patch) {
  return validateWith(KNOWLEDGE_FIELDS, patch, { partial: true })
}

/** 文档 ID 基础校验（空/超长直接拒绝） */
function validateDocId(id, label) {
  const s = String(id || '').trim()
  if (!s) throw new ValidationError((label || '文档') + 'ID不能为空', ['_id'])
  if (s.length > 64) throw new ValidationError((label || '文档') + 'ID不合法', ['_id'])
  return s
}

module.exports = {
  ValidationError,
  TASK_FIELDS,
  KNOWLEDGE_FIELDS,
  validateTaskInput,
  validateTaskPatch,
  validateKnowledgeInput,
  validateKnowledgePatch,
  validateDocId,
}
