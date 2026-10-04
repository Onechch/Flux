/**
 * utils/crypto.js —— 敏感字段加密工具（XXTEA-128，纯 JS 实现）
 *
 * 用途：用户在瓶颈卡片补充的自由文本（userContext.text）属于最敏感的个人信息，
 * 落库前加密、读取时解密，防止云数据库被直接导出时明文泄露。
 *
 * 密文格式：'enc1:' + base64(xxtea(utf8(明文)))，无前缀的值视为历史明文原样返回
 * （兼容云函数 refineSuggestion 直写的明文 userContext，混合存储互不影响）。
 *
 * 密钥管理（MVP 取舍，需知悉的边界）：
 * - 首次使用时生成 16 字节随机密钥，存于本机 Storage（key: po_sk）
 * - 密钥与设备绑定：换设备/清缓存后历史密文不可解密（读取返回空串，可重新补充）
 * - 本方案防"数据库侧泄露"，不防"拿到用户设备+存储的攻击者"（客户端无安全密钥库）
 *
 * 依赖 wx 的仅密钥存取一处（getOrCreateKey），核心算法为纯函数，可在 node 中自测。
 */

const DELTA = 0x9e3779b9
const ENC_PREFIX = 'enc1:'
const KEY_STORAGE = 'po_sk'
const KEY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/* ---------------- XXTEA 核心（字节数组 <-> 32位字数组） ---------------- */

function toUint32Array(bytes, includeLength) {
  const length = bytes.length
  let n = length >> 2
  if ((length & 3) !== 0) n++
  let v
  if (includeLength) {
    v = new Array(n + 1)
    v[n] = length
  } else {
    v = new Array(n)
  }
  for (let i = 0; i < n; i++) v[i] = 0
  for (let i = 0; i < length; i++) v[i >>> 2] |= bytes[i] << ((i & 3) << 3)
  return v
}

function toUint8Array(v, includeLength) {
  const length = v.length
  let n = length << 2
  if (includeLength) {
    const m = v[length - 1]
    n -= 4
    if (m < n - 3 || m > n) return null // 长度位非法 → 密文损坏
    n = m
  }
  const bytes = new Array(n)
  for (let i = 0; i < n; i++) {
    bytes[i] = (v[i >>> 2] >>> ((i & 3) << 3)) & 0xff
  }
  return bytes
}

function mx(sum, y, z, p, e, k) {
  return (
    (((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) ^
    ((sum ^ y) + (k[(p & 3) ^ e] ^ z))
  )
}

function encryptUint32Array(v, key) {
  const length = v.length
  const n = length - 1
  if (n < 1) return v
  let z = v[n]
  let y = v[0]
  let sum = 0
  let e
  let q = Math.floor(6 + 52 / length)
  while (q-- > 0) {
    sum = (sum + DELTA) >>> 0
    e = (sum >>> 2) & 3
    let p
    for (p = 0; p < n; p++) {
      y = v[p + 1]
      z = v[p] = (v[p] + mx(sum, y, z, p, e, key)) >>> 0
    }
    y = v[0]
    z = v[n] = (v[n] + mx(sum, y, z, n, e, key)) >>> 0
  }
  return v
}

function decryptUint32Array(v, key) {
  const length = v.length
  const n = length - 1
  if (n < 1) return v
  let z = v[n]
  let y = v[0]
  let q = Math.floor(6 + 52 / length)
  let sum = (q * DELTA) >>> 0
  let e
  while (sum !== 0) {
    e = (sum >>> 2) & 3
    let p
    for (p = n; p > 0; p--) {
      z = v[p - 1]
      y = v[p] = (v[p] - mx(sum, y, z, p, e, key)) >>> 0
    }
    z = v[n]
    y = v[0] = (v[0] - mx(sum, y, z, 0, e, key)) >>> 0
    sum = (sum - DELTA) >>> 0
  }
  return v
}

/* ---------------- UTF-8 编解码 + Base64 ---------------- */

function utf8Encode(str) {
  const bytes = []
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = (code - 0xd800) * 0x400 + next - 0xdc00 + 0x10000
        i++
      }
    }
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      )
    }
  }
  return bytes
}

function utf8Decode(bytes) {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    let code
    if (b < 0x80) {
      code = b
      i += 1
    } else if (b < 0xe0) {
      code = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)
      i += 2
    } else if (b < 0xf0) {
      code = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      i += 3
    } else {
      code =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f)
      i += 4
    }
    if (code >= 0x10000) {
      // 代理对还原（emoji 等）
      code -= 0x10000
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff))
    } else {
      out += String.fromCharCode(code)
    }
  }
  return out
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64Encode(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 63] : '='
  }
  return out
}

function base64Decode(str) {
  const bytes = []
  let buffer = 0
  let bits = 0
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (ch === '=') break
    const idx = B64_ALPHABET.indexOf(ch)
    if (idx === -1) return null
    buffer = (buffer << 6) | idx
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return bytes
}

/* ---------------- 对外接口 ---------------- */

/** 密钥字符串 → 4 个 32 位字（密钥固定 16 字节） */
function keyToWords(keyStr) {
  const bytes = []
  for (let i = 0; i < keyStr.length && i < 16; i++) bytes.push(keyStr.charCodeAt(i) & 0xff)
  while (bytes.length < 16) bytes.push(0)
  return toUint32Array(bytes, false)
}

/**
 * 加密文本（指定密钥，纯函数）。
 * @returns {string} 'enc1:' + base64 密文；空文本返回 ''
 */
function encryptWithKey(plainText, keyStr) {
  if (!plainText || typeof plainText !== 'string') return ''
  const key = keyToWords(keyStr)
  const v = encryptUint32Array(toUint32Array(utf8Encode(plainText), true), key)
  const bytes = toUint8Array(v, false) || []
  return ENC_PREFIX + base64Encode(bytes)
}

/**
 * 解密 'enc1:' 密文（指定密钥，纯函数）。
 * @returns {string} 明文；非密文格式原样返回；解密失败（密钥不匹配/密文损坏）返回 ''
 */
function decryptWithKey(cipherText, keyStr) {
  if (typeof cipherText !== 'string') return ''
  if (cipherText.indexOf(ENC_PREFIX) !== 0) return cipherText // 历史明文，原样返回
  const b64 = cipherText.slice(ENC_PREFIX.length)
  const bytes = base64Decode(b64)
  if (!bytes || !bytes.length) return ''
  try {
    const key = keyToWords(keyStr)
    const v = decryptUint32Array(toUint32Array(bytes, false), key)
    const plain = toUint8Array(v, true)
    if (!plain) return ''
    return utf8Decode(plain)
  } catch (e) {
    return ''
  }
}

/** 是否已是密文（防二次加密） */
function isEncrypted(text) {
  return typeof text === 'string' && text.indexOf(ENC_PREFIX) === 0
}

/**
 * 获取/生成设备本地密钥（16 字符随机串，存 Storage）。
 * node 环境无 wx 时使用内存兜底（仅自测用）。
 */
let memoryKey = ''
function getOrCreateKey() {
  if (typeof wx === 'undefined') {
    if (!memoryKey) {
      memoryKey = ''
      for (let i = 0; i < 16; i++) {
        memoryKey += KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)]
      }
    }
    return memoryKey
  }
  let key = ''
  try {
    key = wx.getStorageSync(KEY_STORAGE) || ''
  } catch (e) {
    key = ''
  }
  if (key && key.length === 16) return key
  key = ''
  for (let i = 0; i < 16; i++) {
    key += KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)]
  }
  try {
    wx.setStorageSync(KEY_STORAGE, key)
  } catch (e) {
    console.warn('[crypto] 密钥写入本地存储失败', e)
  }
  return key
}

/** 加密敏感文本（使用本机密钥；已加密则原样返回，防二次加密） */
function encryptText(plainText) {
  if (isEncrypted(plainText)) return plainText
  return encryptWithKey(plainText, getOrCreateKey())
}

/** 解密敏感文本（使用本机密钥；非密文原样返回；失败返回 ''） */
function decryptText(cipherText) {
  return decryptWithKey(cipherText, getOrCreateKey())
}

module.exports = {
  encryptText,
  decryptText,
  isEncrypted,
  encryptWithKey,
  decryptWithKey,
  getOrCreateKey,
}
