import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestPost } from '../functions/api/config/submit.js';
import { INPUT_LIMITS } from '../functions/lib/validators.js';
import { createKv, seedData, emptyData, readSavedData } from './helpers/github-data-store.mjs';

function seedPublicData(kv) {
  seedData(kv, {
    version: 1,
    categories: [{ id: 1, catelog: 'Public', is_private: 0 }],
    sites: [],
    pending_sites: [],
    settings: [],
  });
}

test('public submit does not expose duplicate site URL existence', async () => {
  const kv = createKv();
  seedPublicData(kv);

  const request = new Request('https://example.com/api/config/submit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://example.com',
      'CF-Connecting-IP': '203.0.113.1',
    },
    body: JSON.stringify({
      name: 'Submitted',
      url: 'https://private.example.com',
      catelog_id: 1,
    }),
  });

  const env = {
    ENABLE_PUBLIC_SUBMISSION: 'true',
    NAV_AUTH: kv,
  };

  const response = await onRequestPost({ request, env });
  const body = await response.json();

  assert.equal(response.status, 201, body.message);
  assert.match(body.message, /waiting for admin approve/);
  const saved = readSavedData(kv);
  assert.equal(saved.pending_sites.length, 1);
  assert.equal(saved.pending_sites[0].url, 'https://private.example.com');
});

test('public submit rejects overlong bookmark text before writing pending site', async () => {
  const kv = createKv();
  seedData(kv, emptyData());

  const request = new Request('https://example.com/api/config/submit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://example.com',
      'CF-Connecting-IP': '203.0.113.1',
    },
    body: JSON.stringify({
      name: 'x'.repeat(INPUT_LIMITS.bookmarkName + 1),
      url: 'https://submitted.example.com',
      catelog_id: 1,
    }),
  });

  const response = await onRequestPost({
    request,
    env: {
      ENABLE_PUBLIC_SUBMISSION: 'true',
      NAV_AUTH: kv,
    },
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.match(body.message, /书签名称不能超过/);
});

test('public submit requires Turnstile token when configured', async () => {
  const kv = createKv();
  seedData(kv, emptyData());

  const request = new Request('https://example.com/api/config/submit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://example.com',
      'CF-Connecting-IP': '203.0.113.1',
    },
    body: JSON.stringify({
      name: 'Submitted',
      url: 'https://submitted.example.com',
      catelog_id: 1,
    }),
  });

  const response = await onRequestPost({
    request,
    env: {
      ENABLE_PUBLIC_SUBMISSION: 'true',
      TURNSTILE_SITE_KEY: 'site-key',
      TURNSTILE_SECRET_KEY: 'secret-key',
      NAV_AUTH: kv,
    },
  });
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.match(body.message, /请先完成人机验证/);
});

test('public submit verifies Turnstile token before inserting pending site', async () => {
  const originalFetch = globalThis.fetch;
  const kv = createKv();
  seedPublicData(kv);

  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(init.method, 'POST');
    assert.equal(init.body.get('secret'), 'secret-key');
    assert.equal(init.body.get('response'), 'turnstile-token');
    assert.equal(init.body.get('remoteip'), '203.0.113.1');
    return Response.json({ success: true });
  };

  try {
    const request = new Request('https://example.com/api/config/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://example.com',
        'CF-Connecting-IP': '203.0.113.1',
      },
      body: JSON.stringify({
        name: 'Submitted',
        url: 'https://submitted.example.com',
        catelog_id: 1,
        turnstileToken: 'turnstile-token',
      }),
    });

    const response = await onRequestPost({
      request,
      env: {
        ENABLE_PUBLIC_SUBMISSION: 'true',
        TURNSTILE_SITE_KEY: 'site-key',
        TURNSTILE_SECRET_KEY: 'secret-key',
        NAV_AUTH: kv,
      },
    });
    const body = await response.json();

    assert.equal(response.status, 201, body.message);
    const saved = readSavedData(kv);
    assert.equal(saved.pending_sites.length, 1);
    assert.equal(saved.pending_sites[0].url, 'https://submitted.example.com');
  } finally {
    globalThis.fetch = originalFetch;
  }
});