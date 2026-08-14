import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestPost } from '../functions/api/config/import.js';
import { INPUT_LIMITS, IMPORT_BODY_MAX_BYTES, IMPORT_BODY_MAX_MB } from '../functions/lib/validators.js';
import { createKv, seedData, readSavedData, emptyData } from './helpers/github-data-store.mjs';

function buildEnv(initialData) {
  const kv = createKv({ session_token: '1' });
  if (initialData) seedData(kv, initialData);
  return { env: { NAV_AUTH: kv }, kv };
}

test('import rejects bodies over the declared byte limit', async () => {
  const { env } = buildEnv();
  const request = new Request('https://example.com/api/config/import', {
    method: 'POST',
    headers: {
      Cookie: 'admin_session=token',
      'Content-Type': 'application/json',
      'Content-Length': String(IMPORT_BODY_MAX_BYTES + 1),
    },
    body: JSON.stringify({ category: [], sites: [] }),
  });

  const response = await onRequestPost({ request, env });
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.match(body.message, new RegExp(`${IMPORT_BODY_MAX_MB}MB`));
});

test('a full-count export stays within the import byte limit at realistic field sizes', async () => {
  // 10MB 这个数字的依据：跑满计数上限、字段取实测量级时仍要留有余量。
  // 实测约 300 字节/条（80 条 23KB），这里按更宽的字段从严估算。
  const category = Array.from({ length: INPUT_LIMITS.importCategories }, (_, i) => ({
    id: i + 1,
    catelog: `分类名称示例 ${i + 1}`,
    sort_order: i,
    parent_id: 0,
    is_private: 0,
  }));
  const sites = Array.from({ length: INPUT_LIMITS.importSites }, (_, i) => ({
    id: i + 1,
    name: `书签名称示例 ${i + 1}`,
    url: `https://example.com/some/path/segment/${i + 1}`,
    logo: `https://faviconsnap.com/api/favicon?url=https://example.com/${i + 1}`,
    desc: '这是一段中等长度的书签描述文本，用于估算真实备份体积。',
    catelog_id: (i % INPUT_LIMITS.importCategories) + 1,
    sort_order: i,
    is_private: 0,
  }));

  // 备份写的是 JSON.stringify(data, null, 2)，恢复时 POST 的是无缩进版本
  const backupBytes = Buffer.byteLength(JSON.stringify({ category, sites }, null, 2), 'utf8');
  const restoreBytes = Buffer.byteLength(JSON.stringify({ category, sites, override: true }), 'utf8');

  assert.ok(
    restoreBytes < backupBytes,
    '恢复载荷无缩进，必然小于带缩进的备份文件，因此备份侧不需要额外留余量'
  );
  assert.ok(
    backupBytes < IMPORT_BODY_MAX_BYTES,
    `跑满计数上限的备份应在体积上限内，实际 ${(backupBytes / 1024 / 1024).toFixed(1)}MB`
  );
});

test('import restores categories when a backup contains no bookmarks', async () => {
  const { env, kv } = buildEnv(emptyData());
  const request = new Request('https://example.com/api/config/import', {
    method: 'POST',
    headers: { Cookie: 'admin_session=token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: [{ id: 1, catelog: '空分类', parent_id: 0, is_private: 0 }],
      sites: [],
    }),
  });

  const response = await onRequestPost({ request, env });
  const body = await response.json();

  assert.equal(response.status, 201, body.message);
  const saved = readSavedData(kv);
  assert.equal(saved.categories.length, 1, '分类不应因书签数量为零而被忽略');
  assert.equal(saved.categories[0].catelog, '空分类');
});

test('import override updates the database URL form that actually exists', async () => {
  const { env, kv } = buildEnv({
    ...emptyData(),
    categories: [{ id: 1, catelog: 'Default', parent_id: 0, is_private: 0 }],
    sites: [{
      id: 1,
      name: 'Old',
      url: 'https://example.com',
      catelog_id: 1,
      catelog_name: 'Default',
      sort_order: 0,
      is_private: 0,
    }],
  });

  const request = new Request('https://example.com/api/config/import', {
    method: 'POST',
    headers: {
      Cookie: 'admin_session=token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      override: true,
      category: [{ id: 1, catelog: 'Default', parent_id: 0, is_private: 0 }],
      sites: [{
        name: 'Updated',
        url: 'https://example.com',
        catelog_id: 1,
        sort_order: 1,
      }],
    }),
  });

  const response = await onRequestPost({ request, env });
  const body = await response.json();

  assert.equal(response.status, 201, body.message);
  assert.match(body.message, /更新 1 个/);
  const saved = readSavedData(kv);
  const site = saved.sites.find(s => s.url === 'https://example.com');
  assert.ok(site, '应更新已存在的书签');
  assert.equal(site.name, 'Updated');
});

test('import override without sort_order keeps the existing sort order', async () => {
  const { env, kv } = buildEnv({
    ...emptyData(),
    categories: [{ id: 1, catelog: 'Default', parent_id: 0, is_private: 0 }],
    sites: [{
      id: 1,
      name: 'Old',
      url: 'https://example.com',
      catelog_id: 1,
      catelog_name: 'Default',
      sort_order: 5,
      is_private: 0,
    }],
  });

  const request = new Request('https://example.com/api/config/import', {
    method: 'POST',
    headers: {
      Cookie: 'admin_session=token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      override: true,
      category: [{ id: 1, catelog: 'Default', parent_id: 0, is_private: 0 }],
      sites: [{
        name: 'Updated',
        url: 'https://example.com',
        catelog_id: 1,
      }],
    }),
  });

  const response = await onRequestPost({ request, env });
  const body = await response.json();

  assert.equal(response.status, 201, body.message);
  assert.match(body.message, /更新 1 个/);
  const saved = readSavedData(kv);
  const site = saved.sites.find(s => s.url === 'https://example.com');
  assert.ok(site);
  assert.equal(site.sort_order, 5, '未提供排序值时应保留已有书签的排序值');
});

test('import forces public children and sites private under a private parent category', async () => {
  const { env, kv } = buildEnv(emptyData());

  const request = new Request('https://example.com/api/config/import', {
    method: 'POST',
    headers: {
      Cookie: 'admin_session=token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      category: [
        { id: 1, catelog: '私人资料', parent_id: 0, is_private: 1 },
        { id: 2, catelog: '账号面板', parent_id: 1, is_private: 0 },
      ],
      sites: [{
        name: '内部面板',
        url: 'https://internal.example',
        catelog_id: 2,
        is_private: 0,
      }],
    }),
  });

  const response = await onRequestPost({ request, env });
  const body = await response.json();

  assert.equal(response.status, 201, body.message);
  assert.match(body.message, /新增 1 个/);
  const saved = readSavedData(kv);
  assert.equal(saved.categories.length, 2);
  assert.equal(saved.categories[0].catelog, '私人资料');
  assert.equal(saved.categories[0].is_private, 1);
  assert.equal(saved.categories[1].catelog, '账号面板');
  assert.equal(saved.categories[1].is_private, 1, '私有父分类下的子分类应被强制置为私有');
  assert.equal(saved.sites.length, 1);
  assert.equal(saved.sites[0].catelog_name, '账号面板');
  assert.equal(saved.sites[0].is_private, 1, '私有分类下的书签应被强制置为私有');
});

test('import maps Chrome root bookmarks into a root category', async () => {
  const { env, kv } = buildEnv(emptyData());

  const request = new Request('https://example.com/api/config/import', {
    method: 'POST',
    headers: {
      Cookie: 'admin_session=token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      category: [],
      sites: [{
        name: 'Root Link',
        url: 'https://root.example',
        catelog_id: 0,
      }],
    }),
  });

  const response = await onRequestPost({ request, env });
  const body = await response.json();

  assert.equal(response.status, 201, body.message);
  assert.match(body.message, /新增 1 个/);
  const saved = readSavedData(kv);
  const rootCategory = saved.categories.find(c => c.catelog === '默认');
  assert.ok(rootCategory, '根目录书签应映射进「默认」根分类');
  assert.equal(rootCategory.sort_order, 9999);
  assert.equal(rootCategory.is_private, 0);
  assert.equal(saved.sites.length, 1);
  assert.equal(saved.sites[0].catelog_id, rootCategory.id);
  assert.equal(saved.sites[0].catelog_name, '默认');
});

test('import skips overlong bookmark rows instead of writing them', async () => {
  const { env, kv } = buildEnv(emptyData());

  const request = new Request('https://example.com/api/config/import', {
    method: 'POST',
    headers: {
      Cookie: 'admin_session=token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      category: [{ id: 1, catelog: 'Default', parent_id: 0, is_private: 0 }],
      sites: [{
        name: 'Too long',
        url: 'https://toolong.example',
        desc: 'x'.repeat(INPUT_LIMITS.bookmarkDesc + 1),
        catelog_id: 1,
      }],
    }),
  });

  const response = await onRequestPost({ request, env });
  const body = await response.json();

  assert.equal(response.status, 201, body.message);
  assert.match(body.message, /跳过 1 个/);
  const saved = readSavedData(kv);
  assert.equal(saved.categories.length > 0, true, '分类应被写入');
  assert.equal(saved.sites.length, 0, '超长书签不应写入');
});

test('import deduplicates the same URL with and without trailing slash', async () => {
  const { env, kv } = buildEnv(emptyData());

  const request = new Request('https://example.com/api/config/import', {
    method: 'POST',
    headers: {
      Cookie: 'admin_session=token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      category: [{ id: 1, catelog: 'Default', parent_id: 0, is_private: 0 }],
      sites: [
        {
          name: 'Example',
          url: 'https://example.com',
          catelog_id: 1,
        },
        {
          name: 'Example Slash',
          url: 'https://example.com/',
          catelog_id: 1,
        },
      ],
    }),
  });

  const response = await onRequestPost({ request, env });
  const body = await response.json();

  assert.equal(response.status, 201, body.message);
  assert.match(body.message, /新增 1 个/);
  assert.match(body.message, /跳过 1 个/);
  const saved = readSavedData(kv);
  assert.equal(saved.sites.length, 1);
  assert.equal(saved.sites[0].url, 'https://example.com');
});

test('import deduplicates non-root URLs with and without trailing slash', async () => {
  const { env, kv } = buildEnv(emptyData());

  const request = new Request('https://example.com/api/config/import', {
    method: 'POST',
    headers: {
      Cookie: 'admin_session=token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      category: [{ id: 1, catelog: 'Default', parent_id: 0, is_private: 0 }],
      sites: [
        {
          name: 'Dig Tool Slash',
          url: 'https://toolbox.googleapps.com/apps/dig/',
          catelog_id: 1,
        },
        {
          name: 'Dig Tool',
          url: 'https://toolbox.googleapps.com/apps/dig',
          catelog_id: 1,
        },
      ],
    }),
  });

  const response = await onRequestPost({ request, env });
  const body = await response.json();

  assert.equal(response.status, 201, body.message);
  assert.match(body.message, /新增 1 个/);
  assert.match(body.message, /跳过 1 个/);
  const saved = readSavedData(kv);
  assert.equal(saved.sites.length, 1);
  assert.equal(saved.sites[0].url, 'https://toolbox.googleapps.com/apps/dig/');
});