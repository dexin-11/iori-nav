import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestGet } from '../functions/api/public-config.js';
import { createKv, seedData, emptyData } from './helpers/github-data-store.mjs';

test('GET /api/public-config exposes Turnstile site key but not secret key', async () => {
  const kv = createKv();
  seedData(kv, emptyData());

  const response = await onRequestGet({
    env: {
      ENABLE_PUBLIC_SUBMISSION: 'true',
      TURNSTILE_SITE_KEY: 'site-key',
      TURNSTILE_SECRET_KEY: 'secret-key',
      NAV_AUTH: kv,
    },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.submissionEnabled, true);
  assert.equal(body.turnstileSiteKey, 'site-key');
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'turnstileSecretKey'), false);
  assert.equal(JSON.stringify(body).includes('secret-key'), false);
});
