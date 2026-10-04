/**
 * tests/unit/crypto.test.js —— 敏感字段加密（utils/crypto.js）
 *
 * 覆盖：XXTEA 加解密往返（ASCII/中文/emoji/长文本）、密文前缀格式、
 * 历史明文兼容、密钥不匹配与密文损坏的兜底、防二次加密、设备密钥生成。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const crypto = require(path.join(__dirname, '..', '..', 'miniprogram', 'utils', 'crypto'))

const KEY_A = 'AbCdEfGhIjKlMnOp'
const KEY_B = 'PoNmKlJiHgFeDcBa'

test('往返加解密：ASCII 文本', () => {
  const plain = 'hello world'
  const cipher = crypto.encryptWithKey(plain, KEY_A)
  assert.ok(cipher.indexOf('enc1:') === 0, '密文应带 enc1: 前缀')
  assert.notEqual(cipher, plain)
  assert.equal(crypto.decryptWithKey(cipher, KEY_A), plain)
})

test('往返加解密：中文文本', () => {
  const plain = '蛋白表达量不达标，需要优化诱导条件（16度、0.1mM IPTG）'
  const cipher = crypto.encryptWithKey(plain, KEY_A)
  assert.equal(crypto.decryptWithKey(cipher, KEY_A), plain)
})

test('往返加解密：emoji（代理对）不被截断', () => {
  const plain = '进度🔴卡住了⚠️再试🚀'
  const cipher = crypto.encryptWithKey(plain, KEY_A)
  assert.equal(crypto.decryptWithKey(cipher, KEY_A), plain)
})

test('往返加解密：单字符与长文本', () => {
  const short = 'a'
  assert.equal(crypto.decryptWithKey(crypto.encryptWithKey(short, KEY_A), KEY_A), short)

  const long = '长文本测试'.repeat(500)
  assert.equal(crypto.decryptWithKey(crypto.encryptWithKey(long, KEY_A), KEY_A), long)
})

test('往返加解密：所有块长度边界（1..17 字节，覆盖 XXTEA 补位分支）', () => {
  for (let n = 1; n <= 17; n++) {
    const plain = 'x'.repeat(n)
    const cipher = crypto.encryptWithKey(plain, KEY_A)
    assert.equal(crypto.decryptWithKey(cipher, KEY_A), plain, '长度 ' + n + ' 往返失败')
  }
})

test('空文本 / 非字符串加密返回空串', () => {
  assert.equal(crypto.encryptWithKey('', KEY_A), '')
  assert.equal(crypto.encryptWithKey(null, KEY_A), '')
  assert.equal(crypto.encryptWithKey(undefined, KEY_A), '')
  assert.equal(crypto.encryptWithKey(12345, KEY_A), '')
})

test('历史明文兼容：无 enc1: 前缀的值原样返回（不误判为密文）', () => {
  assert.equal(crypto.decryptWithKey('这是云函数直写的明文', KEY_A), '这是云函数直写的明文')
  assert.equal(crypto.decryptWithKey('', KEY_A), '')
})

test('密钥不匹配时返回空串（不抛错、不返回乱码）', () => {
  const cipher = crypto.encryptWithKey('敏感内容', KEY_A)
  assert.equal(crypto.decryptWithKey(cipher, KEY_B), '')
})

test('密文损坏时返回空串（base64 非法 / 长度位非法）', () => {
  const cipher = crypto.encryptWithKey('敏感内容', KEY_A)
  // 破坏 base64 字符
  assert.equal(crypto.decryptWithKey('enc1:@@@not-base64@@@', KEY_A), '')
  // 截断密文（长度位与实际不符）
  assert.equal(crypto.decryptWithKey(cipher.slice(0, cipher.length - 4), KEY_A), '')
  // 只剩前缀
  assert.equal(crypto.decryptWithKey('enc1:', KEY_A), '')
})

test('isEncrypted 只认 enc1: 前缀', () => {
  assert.equal(crypto.isEncrypted('enc1:abc'), true)
  assert.equal(crypto.isEncrypted('abc'), false)
  assert.equal(crypto.isEncrypted(''), false)
  assert.equal(crypto.isEncrypted(null), false)
})

test('encryptText 幂等：已加密文本不会被二次加密', () => {
  const once = crypto.encryptText('补充情况文本')
  const twice = crypto.encryptText(once)
  assert.equal(twice, once, '二次加密会导致无法解密')
  assert.equal(crypto.decryptText(once), '补充情况文本')
})

test('getOrCreateKey：无 wx 环境下返回稳定的 16 字符内存密钥', () => {
  const k1 = crypto.getOrCreateKey()
  const k2 = crypto.getOrCreateKey()
  assert.equal(k1.length, 16)
  assert.equal(k1, k2, '同进程内应复用同一密钥')
})

test('getOrCreateKey：有 wx 时读写 Storage 并复用已存密钥', () => {
  const store = {}
  global.wx = {
    getStorageSync: (k) => (store[k] === undefined ? '' : store[k]),
    setStorageSync: (k, v) => {
      store[k] = v
    },
  }
  try {
    const k1 = crypto.getOrCreateKey()
    assert.equal(k1.length, 16)
    assert.equal(store.po_sk, k1, '首次调用应把密钥写入 Storage')
    const k2 = crypto.getOrCreateKey()
    assert.equal(k2, k1)
  } finally {
    delete global.wx
  }
})

test('getOrCreateKey：Storage 中已有合法 16 位密钥时直接复用', () => {
  const store = { po_sk: '0123456789abcdef' }
  global.wx = {
    getStorageSync: (k) => (store[k] === undefined ? '' : store[k]),
    setStorageSync: (k, v) => {
      store[k] = v
    },
  }
  try {
    assert.equal(crypto.getOrCreateKey(), '0123456789abcdef')
  } finally {
    delete global.wx
  }
})

test('getOrCreateKey：Storage 中密钥长度非法时重新生成', () => {
  const store = { po_sk: 'short' }
  global.wx = {
    getStorageSync: (k) => (store[k] === undefined ? '' : store[k]),
    setStorageSync: (k, v) => {
      store[k] = v
    },
  }
  try {
    const k = crypto.getOrCreateKey()
    assert.equal(k.length, 16)
    assert.notEqual(k, 'short')
  } finally {
    delete global.wx
  }
})
