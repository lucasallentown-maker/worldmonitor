import assert from 'node:assert/strict';
import test from 'node:test';
import { describeFetchFailure, discoverNewPools } from '../tools/desk-scan/src/geckoterminal.mjs';

const state = { calls: [], pausedUntil: 0 };

test('a fetch failure keeps the nested cause code and hides a URL', () => {
  const err = new TypeError('fetch failed', {
    cause: Object.assign(new Error('https://user:secret@api.geckoterminal.com/path?token=abc'), {
      code: 'ENOTFOUND',
      syscall: 'getaddrinfo',
      hostname: 'api.geckoterminal.com',
    }),
  });
  const text = describeFetchFailure(err);
  assert.match(text, /TypeError/);
  assert.match(text, /ENOTFOUND/);
  assert.match(text, /getaddrinfo/);
  assert.match(text, /api\.geckoterminal\.com/);
  assert.equal(text.includes('secret'), false);
  assert.equal(text.includes('token=abc'), false);
  assert.match(text, /message-redacted/);
});

test('a failure with no cause code says the code is absent', () => {
  assert.match(describeFetchFailure(new TypeError('fetch failed')), /cause-code-absent/);
});

test('discovery reports a network failure separately from an HTTP status', async () => {
  const failed = await discoverNewPools({
    state,
    fetchImpl: async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
      });
    },
  });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
  assert.equal(failed.calls[0].status, null);
  const http = await discoverNewPools({
    state,
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(http.reason, 'geckoterminal HTTP 503');
  assert.equal(http.calls[0].status, 503);
});
