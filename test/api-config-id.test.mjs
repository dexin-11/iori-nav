import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestPut } from '../functions/api/config/[id].js';
import { createKv, seedData, emptyData } from './helpers/github-data-store.mjs';

test('PUT /api/config/:id rejects updates to a missing category', async () => {
  const kv = createKv({ session_token: '1' });
  const data = emptyData();
  data.sites = [{ id: 1, name: 'Example', url: 'https://example.com', catelog_id: 999, is_private: 0 }];
  seedData(kv, data);

  const request = new Request('https://example.com/api/config/1', {
    method: 'PUT',
    headers: {
      Cookie: 'admin_session=token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Example',
      url: 'https://example.com',
      catelog_id: 999,
      is_private: false,
    }),
  });
  const env = {
    NAV_AUTH: kv,
  };

  const response = await onRequestPut({ request, env, params: { id: '1' } });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.code, 400);
  assert.match(body.message, /Category not found/);
});

test('PUT /api/config/:id rejects unsafe bookmark URLs before updating', async () => {
  const kv = createKv({ session_token: '1' });
  const data = emptyData();
  data.sites = [{ id: 1, name: 'Example', url: 'https://example.com', catelog_id: 1, is_private: 0 }];
  data.categories = [{ id: 1, catelog: 'Default', is_private: 0 }];
  seedData(kv, data);

  const request = new Request('https://example.com/api/config/1', {
    method: 'PUT',
    headers: {
      Cookie: 'admin_session=token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Example',
      url: 'javascript:alert(1)',
      catelog_id: 1,
      is_private: false,
    }),
  });
  const env = {
    NAV_AUTH: kv,
  };

  const response = await onRequestPut({ request, env, params: { id: '1' } });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.code, 400);
  assert.match(body.message, /valid http or https URL/);
});