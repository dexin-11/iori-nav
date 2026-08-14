import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestPut } from '../functions/api/pending/[id].js';
import { createKv, seedData, emptyData } from './helpers/github-data-store.mjs';

test('PUT /api/pending/:id matches legacy root URL forms before approval', async () => {
  const kv = createKv({ session_token: '1' });
  const data = emptyData();
  data.pending_sites = [{
    id: 1,
    name: 'Example',
    url: 'https://example.com/',
    logo: '',
    desc: '',
    catelog_id: 1,
  }];
  // 已存在同 URL 的书签，触发重复检查返回 409
  data.sites = [{ id: 99, url: 'https://example.com' }];
  seedData(kv, data);

  const request = new Request('https://example.com/api/pending/1', {
    method: 'PUT',
    headers: {
      Cookie: 'admin_session=token',
      'Content-Type': 'application/json',
    },
  });
  const env = {
    NAV_AUTH: kv,
  };

  const response = await onRequestPut({ request, env, params: { id: '1' } });
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.code, 409);
});