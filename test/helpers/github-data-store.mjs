// test/helpers/github-data-store.mjs
// 测试专用的 GitHub 数据存储 mock：
// 在未配置 GITHUB_REPO 时，github-data-store 以 KV 缓存 (github_data_cache) 作为唯一数据源。
// 该 helper 提供一个可读写的 KV mock，并暴露 DATA_CACHE_KEY 与数据读写便捷方法。

export const DATA_CACHE_KEY = 'github_data_cache';

/**
 * 创建支持 json 类型读写与普通键值读写的 KV mock
 * @param {object} seeds - 初始 KV 条目 { key: value }（value 为字符串或对象）
 */
export function createKv(seeds = {}) {
  const store = new Map();
  for (const [key, value] of Object.entries(seeds)) {
    store.set(key, value);
  }
  return {
    store,
    async get(key, opts) {
      if (!store.has(key)) return null;
      const value = store.get(key);
      if (opts && opts.type === 'json') {
        if (value === null || value === undefined) return null;
        return typeof value === 'string' ? JSON.parse(value) : value;
      }
      return value;
    },
    async put(key, value, opts = {}) {
      store.set(key, value);
      return undefined;
    },
    async delete(key) {
      store.delete(key);
      return undefined;
    },
  };
}

/**
 * 构造一个包含完整书签数据的空数据对象（字段与 github-data-store 一致）
 */
export function emptyData() {
  return {
    version: 1,
    categories: [],
    sites: [],
    pending_sites: [],
    settings: [],
  };
}

/**
 * 往 KV 中写入初始数据对象（作为 github_data_cache）
 */
export function seedData(kv, data) {
  kv.store.set(DATA_CACHE_KEY, data);
  return kv;
}

/**
 * 从 KV 中读取当前保存的数据对象
 */
export function readSavedData(kv) {
  const value = kv.store.get(DATA_CACHE_KEY);
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}