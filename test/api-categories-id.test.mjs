import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestPut } from '../functions/api/categories/[id].js';
import { createKv, seedData, readSavedData, emptyData } from './helpers/github-data-store.mjs';

test('PUT /api/categories/:id marks private descendants and their sites private', async () => {
  const kv = createKv({ session_token: '1' });
  const data = emptyData();
  data.categories = [
    { id: 1, catelog: 'Root', parent_id: 0, is_private: 0, sort_order: 1 },
    { id: 2, catelog: 'Child', parent_id: 1, is_private: 0, sort_order: 2 },
    { id: 3, catelog: 'Grandchild', parent_id: 2, is_private: 0, sort_order: 3 },
    { id: 4, catelog: 'Other', parent_id: 0, is_private: 0, sort_order: 4 },
  ];
  data.sites = [
    { id: 1, catelog_id: 1, catelog_name: 'Root', is_private: 0 },
    { id: 2, catelog_id: 2, catelog_name: 'Child', is_private: 0 },
    { id: 3, catelog_id: 3, catelog_name: 'Grandchild', is_private: 0 },
    { id: 4, catelog_id: 4, catelog_name: 'Other', is_private: 0 },
  ];
  seedData(kv, data);

  const request = new Request('https://example.com/api/categories/1', {
    method: 'PUT',
    headers: {
      Cookie: 'admin_session=token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      catelog: 'Private Root',
      sort_order: 10,
      parent_id: 0,
      is_private: true,
    }),
  });

  const response = await onRequestPut({
    request,
    env: {
      NAV_AUTH: kv,
    },
    params: { id: '1' },
  });
  const body = await response.json();

  assert.equal(response.status, 200, body.message);
  assert.equal(body.code, 200);

  const saved = readSavedData(kv);
  assert.deepEqual(saved.categories.map(category => category.is_private), [1, 1, 1, 0]);
  assert.deepEqual(saved.sites.map(site => site.is_private), [1, 1, 1, 0]);
  assert.equal(saved.sites[0].catelog_name, 'Private Root');
});