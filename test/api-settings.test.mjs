import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

import { getHomeDirtyKey } from '../functions/_middleware.js';
import { onRequestGet, onRequestPost } from '../functions/api/settings.js';
import { createKv, seedData, readSavedData, emptyData } from './helpers/github-data-store.mjs';

// 把初始 settings 对象 seed 进 data.settings（值与存储语义一致，统一转成字符串）
function createDb(initialSettings = {}, kvSeeds = {}) {
  const kv = createKv({ session_token: '1', ...kvSeeds });
  const data = emptyData();
  data.settings = Object.entries(initialSettings).map(([key, value]) => ({ key, value: String(value) }));
  seedData(kv, data);
  return kv;
}

// 从 KV 数据缓存里读取指定 key 的设置值
function savedSetting(kv, key) {
  const saved = readSavedData(kv);
  const entry = (saved.settings || []).find(s => s.key === key);
  return entry ? entry.value : undefined;
}

function loadAdminSettingsModule() {
  const source = readFileSync(resolve('public/js/admin-settings-defaults.js'), 'utf8');
  const context = { window: {} };

  vm.runInNewContext(source, context, { filename: 'public/js/admin-settings-defaults.js' });

  return context.window.AdminSettings.defaults;
}

function loadAdminSettingsDefaults() {
  return loadAdminSettingsModule().createDefaultSettings();
}

test('applyServerSettings lets a cleared WebDAV value overwrite a stale in-memory one', async () => {
  // webdav_dir 留空的语义是「备份放根目录」，是有效值而不是「回退默认」。
  // 放进 TRUTHY_STRING_FIELDS 会让服务端的空值被内存旧值顶掉：界面显示旧目录，
  // 而服务端读 DB 里的空值把备份写到根目录——界面与实际行为不符。
  const defaults = loadAdminSettingsModule();

  const stale = defaults.createDefaultSettings();
  stale.webdav_url = 'https://dav.example.com/';
  stale.webdav_username = 'user';
  stale.webdav_dir = 'iori-nav';

  defaults.applyServerSettings(
    { webdav_url: '', webdav_username: '', webdav_dir: '' },
    stale
  );

  assert.equal(stale.webdav_dir, '', '服务端清空后内存不应保留旧目录');
  assert.equal(stale.webdav_url, '');
  assert.equal(stale.webdav_username, '');

  // 非空值仍然正常覆盖
  const updated = defaults.createDefaultSettings();
  updated.webdav_dir = 'old';
  defaults.applyServerSettings({ webdav_dir: 'new' }, updated);
  assert.equal(updated.webdav_dir, 'new');

  // 字段缺席时不动内存值（服务端没返回该 key ≠ 清空）
  const absent = defaults.createDefaultSettings();
  absent.webdav_dir = 'keep';
  defaults.applyServerSettings({}, absent);
  assert.equal(absent.webdav_dir, 'keep');
});

test('applyServerSettings keeps empty strings falling back to defaults for styling fields', async () => {
  // 对照组：颜色/字号的空串语义仍是「回退默认」，不能被这次改动带走
  const defaults = loadAdminSettingsModule();
  const settings = defaults.createDefaultSettings();
  settings.home_title_color = '#ffffff';

  defaults.applyServerSettings({ home_title_color: '' }, settings);

  assert.equal(settings.home_title_color, '#ffffff');
});

test('resolveWebdavPasswordForPayload keeps password semantics in one place', () => {
  const defaults = loadAdminSettingsModule();

  assert.equal(defaults.resolveWebdavPasswordForPayload('new-pass', false), 'new-pass');
  assert.equal(defaults.resolveWebdavPasswordForPayload('new-pass', true), 'new-pass');
  assert.equal(defaults.resolveWebdavPasswordForPayload('', true), undefined, '有已存密码且留空 → 不修改，不发送');
  assert.equal(defaults.resolveWebdavPasswordForPayload('', false), '', '无已存密码且留空 → 空密码');
});

test('POST /api/settings accepts the admin settings payload', async () => {
  const defaults = loadAdminSettingsDefaults();
  const kv = createDb({}, { settings_cache: '[cached]' });
  const request = new Request('https://example.com/api/settings', {
    method: 'POST',
    headers: {
      Cookie: 'admin_session=token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(defaults),
  });

  const response = await onRequestPost({
    request,
    env: {
      NAV_AUTH: kv,
    },
  });
  const body = await response.json();
  const saved = readSavedData(kv);
  const savedMap = Object.fromEntries(saved.settings.map(s => [s.key, s.value]));
  const savedKeys = Object.keys(savedMap);

  assert.equal(response.status, 200, body.message);
  assert.equal(body.code, 200);
  assert.ok(savedKeys.includes('layout_hide_desc'));
  assert.ok(savedKeys.includes('provider'));
  assert.equal(savedKeys.includes('has_api_key'), false);
  assert.equal(savedKeys.includes('layout_random_wallpaper'), false);
  assert.ok(savedKeys.includes('home_category_flow'));
  assert.equal(savedMap['layout_hide_desc'], 'false');
  assert.equal(savedMap['home_category_flow'], 'single_line');
  assert.equal(savedMap['provider'], 'workers-ai');
  assert.equal(kv.store.has('settings_cache'), false);
});

test('POST /api/settings accepts category flow setting directly', async () => {
  const kv = createDb({}, { settings_cache: '[cached]' });
  const request = new Request('https://example.com/api/settings', {
    method: 'POST',
    headers: {
      Cookie: 'admin_session=token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      home_category_flow: 'multi_line',
    }),
  });

  const response = await onRequestPost({
    request,
    env: {
      NAV_AUTH: kv,
    },
  });
  const body = await response.json();

  assert.equal(response.status, 200, body.message);
  assert.equal(body.code, 200);
  assert.equal(savedSetting(kv, 'home_category_flow'), 'multi_line');
});

test('POST /api/settings skips unchanged writes but still invalidates caches', async () => {
  const kv = createDb({
    provider: 'workers-ai',
    layout_hide_desc: 'false',
  }, { settings_cache: '[cached]' });
  const request = new Request('https://example.com/api/settings', {
    method: 'POST',
    headers: {
      Cookie: 'admin_session=token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      provider: 'workers-ai',
      layout_hide_desc: false,
    }),
  });

  const response = await onRequestPost({
    request,
    env: {
      NAV_AUTH: kv,
    },
  });
  const body = await response.json();

  assert.equal(response.status, 200, body.message);
  assert.equal(body.code, 200);
  // 值未变化，不应写入任何新条目
  assert.deepEqual(readSavedData(kv).settings, [
    { key: 'provider', value: 'workers-ai' },
    { key: 'layout_hide_desc', value: 'false' },
  ]);
  assert.equal(kv.store.has('settings_cache'), false);
  assert.equal(kv.store.has(getHomeDirtyKey('public')), true);
  assert.equal(kv.store.has(getHomeDirtyKey('private')), true);
});

test('GET /api/settings never returns the WebDAV password', async () => {
  const kv = createDb({
    webdav_url: 'https://dav.example.com/',
    webdav_username: 'user',
    webdav_password: 'secret',
  });
  const request = new Request('https://example.com/api/settings', {
    headers: { Cookie: 'admin_session=token' },
  });

  const response = await onRequestGet({ request, env: { NAV_AUTH: kv } });
  const body = await response.json();
  const raw = JSON.stringify(body);

  assert.equal(response.status, 200);
  assert.equal(raw.includes('secret'), false, '响应中不得出现 WebDAV 密码');
  assert.equal(body.data.webdav_password, undefined);
  assert.equal(body.data.has_webdav_password, true);
  assert.equal(body.data.webdav_username, 'user');
});

test('POST /api/settings keeps the stored WebDAV password when field is empty', async () => {
  const kv = createDb({ webdav_password: 'secret' });
  const request = new Request('https://example.com/api/settings', {
    method: 'POST',
    headers: { Cookie: 'admin_session=token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      webdav_url: 'https://dav.example.com/',
      webdav_username: 'user',
      webdav_password: '',
    }),
  });

  const response = await onRequestPost({ request, env: { NAV_AUTH: kv } });
  const body = await response.json();

  assert.equal(response.status, 200, body.message);
  assert.equal(savedSetting(kv, 'webdav_password'), 'secret', '空密码不应清空已存密码');
  assert.equal(savedSetting(kv, 'webdav_username'), 'user');
});

test('POST /api/settings preserves leading and trailing spaces in the WebDAV password', async () => {
  const kv = createDb();
  const password = ' secret with spaces ';
  const request = new Request('https://example.com/api/settings', {
    method: 'POST',
    headers: { Cookie: 'admin_session=token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ webdav_password: password }),
  });

  const response = await onRequestPost({ request, env: { NAV_AUTH: kv } });
  const body = await response.json();

  assert.equal(response.status, 200, body.message);
  assert.equal(savedSetting(kv, 'webdav_password'), password);
});

test('POST /api/settings leaves the home cache alone when only WebDAV keys are saved', async () => {
  // WebDAV 配置不进 SETTINGS_SCHEMA，首页 SSR 的 settings 查询按 getSettingsKeys()
  // 过滤，所以改它们既不影响 settings_cache 也不影响首页 HTML —— 刷缓存只会让
  // 访客白等一次重新渲染。点「立即备份」触发的落库走的就是这条路径。
  const kv = createDb({}, { settings_cache: '[cached]' });
  const request = new Request('https://example.com/api/settings', {
    method: 'POST',
    headers: { Cookie: 'admin_session=token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      webdav_url: 'https://dav.example.com/',
      webdav_username: 'user',
      webdav_dir: 'iori-nav',
    }),
  });

  const response = await onRequestPost({ request, env: { NAV_AUTH: kv } });
  const body = await response.json();

  assert.equal(response.status, 200, body.message);
  assert.equal(savedSetting(kv, 'webdav_url'), 'https://dav.example.com/');
  assert.equal(kv.store.get('settings_cache'), '[cached]', 'WebDAV 配置不在 settings_cache 内');
  assert.equal(kv.store.has(getHomeDirtyKey('public')), false);
  assert.equal(kv.store.has(getHomeDirtyKey('private')), false);
});

test('POST /api/settings still invalidates caches when WebDAV keys ride along with rendered ones', async () => {
  const kv = createDb({}, { settings_cache: '[cached]' });
  const request = new Request('https://example.com/api/settings', {
    method: 'POST',
    headers: { Cookie: 'admin_session=token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      webdav_url: 'https://dav.example.com/',
      layout_hide_desc: true,
    }),
  });

  const response = await onRequestPost({ request, env: { NAV_AUTH: kv } });
  const body = await response.json();

  assert.equal(response.status, 200, body.message);
  assert.equal(kv.store.has('settings_cache'), false);
  assert.equal(kv.store.has(getHomeDirtyKey('public')), true);
  assert.equal(kv.store.has(getHomeDirtyKey('private')), true);
});

test('POST /api/settings rejects a non-http WebDAV URL', async () => {
  const kv = createDb();
  const request = new Request('https://example.com/api/settings', {
    method: 'POST',
    headers: { Cookie: 'admin_session=token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ webdav_url: 'javascript:alert(1)' }),
  });

  const response = await onRequestPost({ request, env: { NAV_AUTH: kv } });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(savedSetting(kv, 'webdav_url'), undefined);
  assert.match(body.message, /webdav_url/);
});

test('POST /api/settings rejects an HTTP WebDAV URL to protect credentials', async () => {
  const kv = createDb();
  const request = new Request('https://example.com/api/settings', {
    method: 'POST',
    headers: { Cookie: 'admin_session=token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ webdav_url: 'http://dav.example.com/root' }),
  });

  const response = await onRequestPost({ request, env: { NAV_AUTH: kv } });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(savedSetting(kv, 'webdav_url'), undefined);
  assert.match(body.message, /HTTPS/);
});

test('POST /api/settings rejects credentials embedded in the WebDAV URL', async () => {
  const kv = createDb();
  const request = new Request('https://example.com/api/settings', {
    method: 'POST',
    headers: { Cookie: 'admin_session=token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ webdav_url: 'https://user:secret@dav.example.com/root' }),
  });

  const response = await onRequestPost({ request, env: { NAV_AUTH: kv } });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(savedSetting(kv, 'webdav_url'), undefined);
  assert.match(body.message, /credentials/);
  assert.equal(JSON.stringify(body).includes('secret'), false, '响应不得回显 URL 中的密码');
});

test('POST /api/settings rejects webdav_dir path traversal via both separators', async () => {
  // 反斜杠曾能绕过只 split('/') 的检查，以 %5C 原样送到 Windows 系服务端
  // %2f 二次解码后变 /，也能绕过 split('/') 检查
  const traversals = ['ok/../../etc', 'ok\\..\\..\\etc', '..\\..\\x', 'a\\b', '../..', '..%2f..%2fetc', '..%5c..%5cetc'];

  for (const dir of traversals) {
    const kv = createDb();
    const request = new Request('https://example.com/api/settings', {
      method: 'POST',
      headers: { Cookie: 'admin_session=token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ webdav_dir: dir }),
    });

    const response = await onRequestPost({ request, env: { NAV_AUTH: kv } });
    assert.equal(response.status, 400, `应拒绝 webdav_dir: ${JSON.stringify(dir)}`);
    assert.equal(savedSetting(kv, 'webdav_dir'), undefined);
  }
});

test('POST /api/settings still accepts ordinary webdav_dir values', async () => {
  const kv = createDb();
  const request = new Request('https://example.com/api/settings', {
    method: 'POST',
    headers: { Cookie: 'admin_session=token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ webdav_dir: 'iori-nav/backup' }),
  });

  const response = await onRequestPost({ request, env: { NAV_AUTH: kv } });
  const body = await response.json();

  assert.equal(response.status, 200, body.message);
  assert.equal(savedSetting(kv, 'webdav_dir'), 'iori-nav/backup');
});

test('POST /api/settings clears the WebDAV password when explicitly sent null', async () => {
  const kv = createDb({ webdav_password: 'secret' });
  const request = new Request('https://example.com/api/settings', {
    method: 'POST',
    headers: { Cookie: 'admin_session=token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ webdav_password: null }),
  });

  const response = await onRequestPost({ request, env: { NAV_AUTH: kv } });
  const body = await response.json();

  // 留空是「不修改」，所以解除配置需要一个显式出口；用 null 而不是带内哨兵字符串
  assert.equal(response.status, 200, body.message);
  assert.equal(savedSetting(kv, 'webdav_password'), '', 'null 应清空已存密码');
});

test('POST /api/settings can store a password that looks like a clear sentinel', async () => {
  // 曾用 '__CLEAR__' 字符串做清除哨兵，会把这个合法密码静默吞成空值，
  // 之后备份一直报「WebDAV 未配置」而接口返回 200，排查方向完全被带偏
  const kv = createDb({ webdav_password: 'secret' });
  const request = new Request('https://example.com/api/settings', {
    method: 'POST',
    headers: { Cookie: 'admin_session=token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ webdav_password: '__CLEAR__' }),
  });

  const response = await onRequestPost({ request, env: { NAV_AUTH: kv } });
  const body = await response.json();

  assert.equal(response.status, 200, body.message);
  assert.equal(savedSetting(kv, 'webdav_password'), '__CLEAR__', '任何字符串都应能作为真实密码存储');
});

test('POST /api/settings keeps the stored password when the field is absent or empty', async () => {
  // 前端每次加载都会清空密码框，空值必须是「不修改」而不是「清除」
  for (const payload of [{ webdav_username: 'user' }, { webdav_password: '', webdav_username: 'user' }]) {
    const kv = createDb({ webdav_password: 'secret' });
    const request = new Request('https://example.com/api/settings', {
      method: 'POST',
      headers: { Cookie: 'admin_session=token', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const response = await onRequestPost({ request, env: { NAV_AUTH: kv } });
    assert.equal(response.status, 200);
    assert.equal(
      savedSetting(kv, 'webdav_password'),
      'secret',
      `空密码不应覆盖已存值: ${JSON.stringify(payload)}`
    );
  }
});

test('GET /api/settings reports no password after it is cleared', async () => {
  const kv = createDb({ webdav_password: '' });
  const request = new Request('https://example.com/api/settings', {
    headers: { Cookie: 'admin_session=token' },
  });

  const response = await onRequestGet({ request, env: { NAV_AUTH: kv } });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.has_webdav_password, false, '清空后前端应显示未配置');
});