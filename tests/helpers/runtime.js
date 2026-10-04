/**
 * tests/helpers/runtime.js —— 小程序运行时测试夹具
 *
 * 小程序代码（Page / wx.* / wx-server-sdk）无法直接在 Node 中运行，
 * 本夹具提供最小可用的运行时替身，使「页面逻辑」与「云函数逻辑」都能被单测覆盖：
 *
 * 1. createStorage   —— 内存版 Storage（结构化克隆，模拟真实 storage 的值语义）
 * 2. createWxMock    —— wx 全局对象替身（storage / toast / modal / cloud / AI）
 * 3. createDbMock    —— 云数据库替身（collection / where / orderBy / skip / limit / add / update / remove）
 * 4. createServerSdk —— wx-server-sdk 替身（cloud.init / database / getWXContext / extend.AI）
 * 5. loadPage        —— 加载 miniprogram/pages/**.js，返回可调用的页面实例（含 setData 路径写入）
 * 6. loadCloudFunction —— 加载 cloudfunctions/**.js（自动注入 wx-server-sdk 替身）
 *
 * 设计要点：
 * - setData 支持小程序的数据路径语法（'tasks[0].displayHours' / 'batchResults[2].pending'），
 *   否则页面逻辑里大量按路径更新数组元素的写法无法被测试驱动。
 * - 每次 loadPage 前清理 require 缓存，保证页面与 utils 的模块级状态（如 api.js 的 mode）
 *   在用例之间互不污染。
 * - Storage 读写做结构化克隆：真实 wx.setStorageSync 会序列化，若不做克隆，
 *   代码里「取出数组→就地修改→写回」的别名错误会被掩盖。
 */

'use strict'

const path = require('path')
const Module = require('module')

const ROOT = path.resolve(__dirname, '..', '..')
const MINIPROGRAM = path.join(ROOT, 'miniprogram')

/** 小程序源码路径 */
function mini(rel) {
  return path.join(MINIPROGRAM, rel)
}

/* ==================== Storage ==================== */

/**
 * 内存版 Storage。
 * 语义对齐 wx：缺失键返回 ''，值在存取时深拷贝（structuredClone）。
 */
function createStorage(initial) {
  const map = new Map()
  Object.keys(initial || {}).forEach((k) => map.set(k, clone(initial[k])))
  return {
    get(key) {
      return map.has(key) ? clone(map.get(key)) : ''
    },
    set(key, val) {
      map.set(key, clone(val))
    },
    remove(key) {
      map.delete(key)
    },
    keys() {
      return Array.from(map.keys())
    },
    /** 直接取原始值（断言用，绕过克隆） */
    peek(key) {
      return map.get(key)
    },
  }
}

/** 结构化克隆（优先用原生实现，回退 JSON 深拷贝） */
function clone(v) {
  if (v === undefined || v === null) return v
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(v)
    } catch (e) {
      /* 含不可克隆值（如函数）时回退 */
    }
  }
  if (typeof v !== 'object') return v
  try {
    return JSON.parse(JSON.stringify(v))
  } catch (e) {
    return v
  }
}

/* ==================== wx 替身 ==================== */

/**
 * 创建 wx 全局替身。
 * @param {Object} [opts]
 *   - storage: 预置 Storage（默认新建空）
 *   - cloud:   wx.cloud 替身；传 null 表示基础库无云能力（触发本地降级模式）
 *   - modalConfirm: wx.showModal 的默认确认结果（默认 true）
 *   - toasts:  调用记录数组（不传则内部新建，可通过返回值读取）
 */
function createWxMock(opts = {}) {
  const storage = opts.storage || createStorage()
  const calls = { toast: [], loading: [], modal: [], navigate: [], switchTab: [], hideLoading: 0 }
  // showModal 结果队列：队列非空时逐个出队，否则用默认值
  const modalQueue = Array.isArray(opts.modalResults) ? opts.modalResults.slice() : []

  const wx = {
    // ---- storage ----
    getStorageSync: (k) => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.remove(k),

    // ---- 交互 ----
    showToast: (o) => {
      calls.toast.push(o || {})
    },
    showLoading: (o) => {
      calls.loading.push(o || {})
    },
    hideLoading: () => {
      calls.hideLoading += 1
    },
    showModal: (o) => {
      const opt = o || {}
      calls.modal.push(opt)
      const result = modalQueue.length
        ? modalQueue.shift()
        : { confirm: opts.modalConfirm === undefined ? true : opts.modalConfirm, cancel: false }
      if (typeof opt.success === 'function') opt.success(result)
      if (typeof opt.complete === 'function') opt.complete(result)
    },
    navigateTo: (o) => {
      calls.navigate.push(o || {})
    },
    switchTab: (o) => {
      calls.switchTab.push(o || {})
    },
    stopPullDownRefresh: () => {},
    showActionSheet: (o) => {
      if (o && typeof o.success === 'function') o.success({ tapIndex: 0 })
    },

    // ---- 云能力 ----
    cloud: opts.cloud === undefined ? null : opts.cloud,

    // ---- 测试辅助 ----
    __storage: storage,
    __calls: calls,
  }
  return wx
}

/* ==================== setData 路径写入 ==================== */

/** 解析小程序数据路径：'a.b[0].c' → ['a','b',0,'c'] */
function parsePath(p) {
  const tokens = []
  const re = /\[(\d+)\]|([^.[\]]+)/g
  let m
  while ((m = re.exec(String(p))) !== null) {
    if (m[1] !== undefined) tokens.push(Number(m[1]))
    else tokens.push(m[2])
  }
  return tokens
}

/** 按路径写入对象（中间层缺失时按下一 token 类型自动建数组/对象） */
function setByPath(root, dataPath, value) {
  const tokens = parsePath(dataPath)
  if (!tokens.length) return
  let cur = root
  for (let i = 0; i < tokens.length - 1; i++) {
    const k = tokens[i]
    if (cur[k] === undefined || cur[k] === null) {
      cur[k] = typeof tokens[i + 1] === 'number' ? [] : {}
    }
    cur = cur[k]
  }
  cur[tokens[tokens.length - 1]] = value
}

/* ==================== 模块缓存管理 ==================== */

/**
 * 清理小程序源码的 require 缓存（页面与 utils），
 * 避免模块级状态（api.js 的 mode、suggestions.js 的队列等）跨用例串味。
 */
function clearMiniProgramCache() {
  Object.keys(require.cache).forEach((k) => {
    if (k.indexOf(MINIPROGRAM) === 0 || k.indexOf(path.join(ROOT, 'cloudfunctions')) === 0) {
      delete require.cache[k]
    }
  })
}

/* ==================== 页面加载 ==================== */

/**
 * 加载一个页面模块并实例化。
 * @param {string} relPath 相对 miniprogram 的页面脚本路径，如 'pages/index/index.js'
 * @param {Object} [opts]
 *   - wx: wx 替身（默认新建）
 *   - data: 覆盖初始 data
 * @returns {Object} 页面实例：拥有页面全部方法 + data + setData，另有 __wx / __calls 便于断言
 */
function loadPage(relPath, opts = {}) {
  const wxMock = opts.wx || createWxMock()
  clearMiniProgramCache()

  const prevPage = global.Page
  const prevApp = global.App
  const prevWx = global.wx
  let definition = null

  global.wx = wxMock
  global.Page = (o) => {
    definition = o
  }
  global.App = (o) => {
    definition = o
  }

  const abs = mini(relPath)
  try {
    delete require.cache[abs]
    require(abs)
  } finally {
    global.Page = prevPage
    global.App = prevApp
  }
  if (!definition) {
    global.wx = prevWx
    throw new Error('未能从 ' + relPath + ' 捕获 Page/App 定义')
  }

  const inst = Object.create(null)
  Object.keys(definition).forEach((k) => {
    inst[k] = definition[k]
  })
  inst.data = Object.assign({}, clone(definition.data) || {}, opts.data || {})
  inst.setData = function setData(patch, cb) {
    Object.keys(patch || {}).forEach((k) => setByPath(this.data, k, patch[k]))
    if (typeof cb === 'function') cb()
  }
  inst.__wx = wxMock
  inst.__calls = wxMock.__calls
  inst.__storage = wxMock.__storage
  return inst
}

/* ==================== 云函数加载 ==================== */

// wx-server-sdk 替身注入点：loadCloudFunction 期间生效
let currentServerSdk = null
const origLoad = Module._load
let loadPatched = false

function patchModuleLoad() {
  if (loadPatched) return
  loadPatched = true
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk' && currentServerSdk) return currentServerSdk
    return origLoad.call(this, request, parent, isMain)
  }
}

/**
 * 加载一个云函数并返回其导出对象。
 * @param {string} name 云函数目录名
 * @param {Object} serverSdk wx-server-sdk 替身（见 createServerSdk）
 */
function loadCloudFunction(name, serverSdk) {
  patchModuleLoad()
  const abs = path.join(ROOT, 'cloudfunctions', name, 'index.js')
  const prev = currentServerSdk
  currentServerSdk = serverSdk
  try {
    delete require.cache[abs]
    return require(abs)
  } finally {
    currentServerSdk = prev
  }
}

/* ==================== 云数据库替身 ==================== */

/**
 * 云数据库替身（内存实现，支持云函数里实际用到的查询形态）。
 * @param {Object} collections { 集合名: [文档] }
 */
function createDbMock(collections) {
  const store = {}
  Object.keys(collections || {}).forEach((k) => {
    store[k] = (collections[k] || []).map(clone)
  })
  const created = []
  let autoId = 0

  const command = {
    eq: (v) => ({ __op: 'eq', value: v }),
    neq: (v) => ({ __op: 'neq', value: v }),
    gt: (v) => ({ __op: 'gt', value: v }),
    gte: (v) => ({ __op: 'gte', value: v }),
    lt: (v) => ({ __op: 'lt', value: v }),
    lte: (v) => ({ __op: 'lte', value: v }),
    inc: (v) => ({ __op: 'inc', value: v }),
    // 数组追加（对齐云开发 $push：字段不存在时自动创建为数组）
    push: (v) => ({ __op: 'push', value: v }),
  }

  function match(doc, where) {
    return Object.keys(where || {}).every((k) => {
      const cond = where[k]
      const val = doc[k]
      if (cond && typeof cond === 'object' && cond.__op) {
        switch (cond.__op) {
          case 'eq':
            return val === cond.value
          case 'neq':
            return val !== cond.value
          case 'gt':
            return val > cond.value
          case 'gte':
            return val >= cond.value
          case 'lt':
            return val < cond.value
          case 'lte':
            return val <= cond.value
          default:
            return true
        }
      }
      return val === cond
    })
  }

  function applyUpdate(doc, data) {
    Object.keys(data || {}).forEach((k) => {
      const v = data[k]
      if (v && typeof v === 'object' && v.__op === 'inc') {
        doc[k] = (doc[k] || 0) + v.value
      } else if (v && typeof v === 'object' && v.__op === 'push') {
        const list = Array.isArray(doc[k]) ? doc[k] : []
        const add = Array.isArray(v.value) ? v.value : [v.value]
        doc[k] = list.concat(clone(add))
      } else {
        doc[k] = clone(v)
      }
    })
  }

  function collection(name) {
    if (!store[name]) store[name] = []
    return {
      where(cond) {
        let rows = store[name].filter((d) => match(d, cond))
        const api = {
          orderBy(field, dir) {
            const sign = dir === 'desc' ? -1 : 1
            rows = rows.slice().sort((a, b) => (a[field] > b[field] ? sign : a[field] < b[field] ? -sign : 0))
            return api
          },
          skip(n) {
            rows = rows.slice(n)
            return api
          },
          limit(n) {
            rows = rows.slice(0, n)
            return api
          },
          count() {
            return Promise.resolve({ total: rows.length })
          },
          get() {
            return Promise.resolve({ data: rows.map(clone) })
          },
          update({ data }) {
            rows.forEach((d) => applyUpdate(d, data))
            return Promise.resolve({ stats: { updated: rows.length } })
          },
          remove() {
            const victims = new Set(rows.map((d) => d._id))
            store[name] = store[name].filter((d) => !victims.has(d._id))
            return Promise.resolve({ stats: { removed: victims.size } })
          },
        }
        return api
      },
      orderBy(field, dir) {
        return this.where({}).orderBy(field, dir)
      },
      skip(n) {
        return this.where({}).skip(n)
      },
      limit(n) {
        return this.where({}).limit(n)
      },
      get() {
        return this.where({}).get()
      },
      count() {
        return this.where({}).count()
      },
      add({ data }) {
        autoId += 1
        const doc = Object.assign({ _id: 'mock_' + autoId }, clone(data))
        store[name].push(doc)
        return Promise.resolve({ _id: doc._id })
      },
      doc(id) {
        return {
          update({ data }) {
            const d = store[name].find((x) => x._id === id)
            if (!d) {
              const err = new Error('document not exists')
              err.errCode = -502005
              return Promise.reject(err)
            }
            applyUpdate(d, data)
            return Promise.resolve({ stats: { updated: 1 } })
          },
          remove() {
            const before = store[name].length
            store[name] = store[name].filter((x) => x._id !== id)
            if (store[name].length === before) {
              const err = new Error('document not exists')
              err.errCode = -502005
              return Promise.reject(err)
            }
            return Promise.resolve({ stats: { removed: 1 } })
          },
          get() {
            const d = store[name].find((x) => x._id === id)
            if (!d) {
              const err = new Error('document not exists')
              err.errCode = -502005
              return Promise.reject(err)
            }
            return Promise.resolve({ data: clone(d) })
          },
        }
      },
    }
  }

  return {
    collection,
    command,
    createCollection(name) {
      if (store[name]) {
        const err = new Error('collection already exists')
        err.errCode = -501001
        return Promise.reject(err)
      }
      store[name] = []
      created.push(name)
      return Promise.resolve({})
    },
    /** 测试辅助：读取集合当前内容 */
    __dump(name) {
      return clone(store[name] || [])
    },
    __created: created,
    __store: store,
  }
}

/**
 * 创建 wx-server-sdk 替身。
 * @param {Object} [opts]
 *   - db: createDbMock 的返回值（云函数通常只用 database）
 *   - openid: getWXContext 返回的 OPENID
 *   - ai: cloud.extend.AI 替身
 */
function createServerSdk(opts = {}) {
  const db = opts.db || createDbMock({})
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
    init() {},
    database: () => db,
    getWXContext: () => ({ OPENID: opts.openid || 'test-openid', APPID: 'test-appid' }),
  }
  if (opts.ai) cloud.extend = { AI: opts.ai }
  return cloud
}

module.exports = {
  ROOT,
  MINIPROGRAM,
  mini,
  clone,
  createStorage,
  createWxMock,
  createDbMock,
  createServerSdk,
  loadPage,
  loadCloudFunction,
  clearMiniProgramCache,
  setByPath,
  parsePath,
}
