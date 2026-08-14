// functions/lib/github-data-store.js
// 书签数据 GitHub 存储：把全部数据（分类、书签、待审核、设置）存成仓库里的单个 JSON 文件，
// 通过 GitHub Contents API 读写，替代原来的 D1 数据库。
//
// 环境变量：
//   GITHUB_REPO       必填，形如 "owner/repo"
//   GITHUB_TOKEN      必填（写操作需要），GitHub Personal Access Token
//   GITHUB_DATA_PATH  数据文件路径，默认 "data/data.json"

export const DATA_VERSION = 1;

const DATA_CACHE_KEY = 'github_data_cache';

export function getGithubConfig(env) {
  return {
    repo: String(env?.GITHUB_REPO || '').trim(),
    token: String(env?.GITHUB_TOKEN || '').trim(),
    path: String(env?.GITHUB_DATA_PATH || 'data/data.json').trim(),
  };
}

export function emptyData() {
  return {
    version: DATA_VERSION,
    categories: [],
    sites: [],
    pending_sites: [],
    settings: [],
  };
}

function normalizeData(data) {
  const base = emptyData();
  data = data && typeof data === 'object' ? data : {};
  return {
    version: data.version ?? DATA_VERSION,
    categories: Array.isArray(data.categories) ? data.categories : base.categories,
    sites: Array.isArray(data.sites) ? data.sites : base.sites,
    pending_sites: Array.isArray(data.pending_sites) ? data.pending_sites : base.pending_sites,
    settings: Array.isArray(data.settings) ? data.settings : base.settings,
  };
}

/**
 * 生成与 SQLite CURRENT_TIMESTAMP 一致的 UTC 时间串：YYYY-MM-DD HH:MM:SS
 */
export function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 计算集合内下一个自增 id（max + 1）
 */
export function nextId(items) {
  return items.reduce((max, item) => Math.max(max, Number(item?.id) || 0), 0) + 1;
}

async function githubFetch(env, method, url, body) {
  const { token } = getGithubConfig(env);
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'iori-nav',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res;
}

function contentsUrl(env) {
  const { repo, path } = getGithubConfig(env);
  if (!repo) throw new Error('GITHUB_REPO 未配置');
  // 整个 path 作为单个 URL 段编码，保留内部斜杠（%2F）
  return `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`;
}

/**
 * 直接从 GitHub 读取数据文件（不过缓存），返回 { data, sha }。
 * 文件不存在时返回空数据与 null sha。
 * 未配置 GITHUB_REPO 时回退到 KV 缓存或空数据（离线/测试模式）。
 */
export async function readFromGithub(env) {
  const { repo } = getGithubConfig(env);
  if (!repo) {
    // 未配置仓库：以 KV 缓存为唯一数据源，便于本地渲染与单元测试
    try {
      const cached = await env.NAV_AUTH.get(DATA_CACHE_KEY, { type: 'json' });
      if (cached) return { data: cached, sha: null };
    } catch (e) {
      // 忽略缓存读取失败
    }
    return { data: emptyData(), sha: null };
  }

  const res = await githubFetch(env, 'GET', contentsUrl(env));
  if (res.status === 404) {
    return { data: emptyData(), sha: null };
  }
  if (!res.ok) {
    throw new Error(`读取 GitHub 数据失败 (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  const payload = await res.json();
  const content = payload.content ? atob(payload.content) : '';
  let data;
  try {
    data = JSON.parse(content);
  } catch (e) {
    throw new Error('GitHub 数据文件不是有效的 JSON');
  }
  return { data: normalizeData(data), sha: payload.sha || null };
}

/**
 * 读取数据（优先走 KV 缓存）。读操作使用；写操作请用 readFromGithub 保证拿到最新 SHA。
 */
export async function loadData(env) {
  try {
    const cached = await env.NAV_AUTH.get(DATA_CACHE_KEY, { type: 'json' });
    if (cached) return cached;
  } catch (e) {
    // 缓存读取失败时回退到 GitHub
  }
  const { data } = await readFromGithub(env);
  try {
    await env.NAV_AUTH.put(DATA_CACHE_KEY, JSON.stringify(data), { expirationTtl: 86400 });
  } catch (e) {
    // 缓存写入失败不影响主流程
  }
  return data;
}

/**
 * 把数据写回 GitHub 并刷新 KV 缓存。
 * 未配置 GITHUB_REPO 时仅写入 KV 缓存（离线/测试模式）。
 * @param {object} env
 * @param {object} data 完整数据对象
 * @param {string|null} sha 当前文件 SHA（readFromGithub 取得）
 */
export async function saveData(env, data, sha) {
  const { repo, token } = getGithubConfig(env);

  // 无论是否写 GitHub，都先刷新 KV 缓存，保证后续读操作拿到最新数据
  try {
    await env.NAV_AUTH.put(DATA_CACHE_KEY, JSON.stringify(data), { expirationTtl: 86400 });
  } catch (e) {
    // 缓存写入失败不阻塞
  }

  if (!repo) {
    // 未配置仓库：离线/测试模式，仅更新缓存
    return data;
  }
  if (!token) throw new Error('GITHUB_TOKEN 未配置，无法写入数据');

  const body = {
    message: 'update nav data',
    content: btoa(JSON.stringify(data, null, 2)),
  };
  if (sha) body.sha = sha;

  const res = await githubFetch(env, 'PUT', contentsUrl(env), body);
  if (!res.ok) {
    throw new Error(`写入 GitHub 数据失败 (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  return data;
}

// ---- 针对 settings 的便捷工具 ----

export function getSettingMap(data) {
  const obj = {};
  for (const s of data.settings || []) obj[s.key] = s.value;
  return obj;
}

/**
 * 按 key 列表返回 [{ key, value }]（保持传入顺序，缺失的跳过）
 */
export function getSettingsRows(data, keys) {
  const map = getSettingMap(data);
  if (!keys) return (data.settings || []).slice();
  return keys.map(key => (map[key] !== undefined ? { key, value: map[key] } : null)).filter(Boolean);
}

/**
 * 批量写入/覆盖设置项。entries 形如 [[key, value], ...]
 */
export function upsertSettings(data, entries) {
  const map = getSettingMap(data);
  for (const [key, value] of entries) map[key] = value;
  data.settings = Object.entries(map).map(([key, value]) => ({ key, value }));
}

/**
 * 删除 / 清空指定设置项（value 为 '' 时也保留，用于显式清除）
 */
export function deleteSettings(data, deletedKeys) {
  const set = new Set(deletedKeys);
  data.settings = (data.settings || []).filter(s => !set.has(s.key));
}