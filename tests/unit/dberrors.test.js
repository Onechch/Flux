/**
 * tests/unit/dberrors.test.js —— 数据库错误分类与读重试（utils/dberrors.js）
 *
 * 覆盖：各错误码/errMsg 特征的正确归类、validation 错误的透传、
 * 集合不存在优先于文档不存在、withRetry 只对可重试类型生效。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const dberrors = require(path.join(__dirname, '..', '..', 'miniprogram', 'utils', 'dberrors'))
const validation = require(path.join(__dirname, '..', '..', 'miniprogram', 'utils', 'validation'))

test('ValidationError 被归类为 validation（且保留中文原文）', () => {
  let err
  try {
    validation.validateTaskInput({})
  } catch (e) {
    err = e
  }
  const c = dberrors.classifyDbError(err)
  assert.equal(c.type, 'validation')
  assert.equal(c.message, err.message)
})

test('已是 DbError 时原样透传（不重复包装）', () => {
  const orig = new dberrors.DbError('network', '网络不稳定，请稍后重试', 'raw')
  assert.equal(dberrors.classifyDbError(orig), orig)
})

test('权限类错误：-502001 / permission denied', () => {
  assert.equal(dberrors.classifyDbError({ errCode: -502001 }).type, 'permission')
  assert.equal(
    dberrors.classifyDbError({ errMsg: 'permission denied for collection tasks' }).type,
    'permission'
  )
  assert.equal(dberrors.classifyDbError({ errMsg: 'not authorized' }).type, 'permission')
})

test('集合不存在：-501001，且优先于「文档不存在」判定', () => {
  const c = dberrors.classifyDbError({
    errCode: -501001,
    errMsg: 'collection not exists: tasks',
  })
  assert.equal(c.type, 'collection', '"collection not exists" 不应被 notfound 规则吞掉')
  assert.equal(
    dberrors.classifyDbError({ errMsg: 'DATABASE_COLLECTION_NOT_EXIST' }).type,
    'collection'
  )
})

test('文档不存在：-502005 / document not exists', () => {
  assert.equal(dberrors.classifyDbError({ errCode: -502005 }).type, 'notfound')
  assert.equal(dberrors.classifyDbError({ errMsg: 'document not exists' }).type, 'notfound')
})

test('数据校验错误：-502004', () => {
  assert.equal(dberrors.classifyDbError({ errCode: -502004, errMsg: 'invalid data' }).type, 'validation')
})

test('限流错误：429 / too many requests', () => {
  assert.equal(dberrors.classifyDbError({ errCode: 429 }).type, 'limit')
  assert.equal(dberrors.classifyDbError({ errMsg: 'too many requests' }).type, 'limit')
  assert.equal(dberrors.classifyDbError({ errMsg: 'EXCEED_CONCURRENT_REQUEST_LIMIT' }).type, 'limit')
})

test('网络错误：request:fail / timeout / errCode -1', () => {
  assert.equal(dberrors.classifyDbError({ errMsg: 'request:fail timeout' }).type, 'network')
  assert.equal(dberrors.classifyDbError({ errCode: -1 }).type, 'network')
  assert.equal(dberrors.classifyDbError({ errMsg: 'network error' }).type, 'network')
})

test('未知错误兜底为 unknown，并给出中文提示', () => {
  const c = dberrors.classifyDbError({ errMsg: 'something weird' })
  assert.equal(c.type, 'unknown')
  assert.equal(c.message, dberrors.FRIENDLY_MESSAGES.unknown)
})

test('非对象错误（字符串/undefined）也能分类，不抛错', () => {
  assert.equal(dberrors.classifyDbError('boom').type, 'unknown')
  assert.equal(dberrors.classifyDbError(undefined).type, 'unknown')
})

test('retryable 标记：仅 network / limit 可重试', () => {
  assert.equal(new dberrors.DbError('network', 'x').retryable, true)
  assert.equal(new dberrors.DbError('limit', 'x').retryable, true)
  assert.equal(new dberrors.DbError('permission', 'x').retryable, false)
  assert.equal(new dberrors.DbError('notfound', 'x').retryable, false)
  assert.equal(new dberrors.DbError('validation', 'x').retryable, false)
})

test('withRetry：网络错误重试后成功', async () => {
  let n = 0
  const r = await dberrors.withRetry(
    async () => {
      n += 1
      if (n === 1) throw { errMsg: 'request:fail timeout' }
      return 'ok'
    },
    { retries: 1, backoffMs: 1 }
  )
  assert.equal(r, 'ok')
  assert.equal(n, 2)
})

test('withRetry：重试耗尽后抛出最后一次错误', async () => {
  let n = 0
  await assert.rejects(
    () =>
      dberrors.withRetry(
        async () => {
          n += 1
          throw { errMsg: 'request:fail' }
        },
        { retries: 2, backoffMs: 1 }
      ),
    (e) => {
      assert.equal(e.errMsg, 'request:fail')
      return true
    }
  )
  assert.equal(n, 3, '首次 + 2 次重试')
})

test('withRetry：不可重试类型立即抛出，不消耗重试次数', async () => {
  let n = 0
  await assert.rejects(
    () =>
      dberrors.withRetry(
        async () => {
          n += 1
          throw { errCode: -502001, errMsg: 'permission denied' }
        },
        { retries: 3, backoffMs: 1 }
      ),
    // withRetry 保留并抛出「原始错误」（便于上层读到 errCode/errMsg 原文），
    // 归类由调用方（api.js runLogged）统一执行 —— 此处同时验证归类结果
    (e) => {
      assert.equal(e.errCode, -502001)
      assert.equal(dberrors.classifyDbError(e).type, 'permission')
      return true
    }
  )
  assert.equal(n, 1, '权限错误应立即失败')
})

test('withRetry：默认只重试 1 次', async () => {
  let n = 0
  await assert.rejects(() =>
    dberrors.withRetry(async () => {
      n += 1
      throw { errMsg: 'timeout' }
    }, { backoffMs: 1 })
  )
  assert.equal(n, 2)
})

test('所有类型的友好提示均为非空中文', () => {
  Object.keys(dberrors.FRIENDLY_MESSAGES).forEach((k) => {
    const msg = dberrors.FRIENDLY_MESSAGES[k]
    assert.ok(msg && msg.length > 0, k + ' 缺少提示文案')
  })
})
