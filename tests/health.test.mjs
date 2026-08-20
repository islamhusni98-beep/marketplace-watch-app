import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/health.ts';

test('health endpoint returns ok payload', () => {
  let statusCode;
  let payload;
  const res = {
    status(code) {
      statusCode = code;
      return {
        json(body) {
          payload = body;
        }
      };
    }
  };

  handler({}, res);
  assert.equal(statusCode, 200);
  assert.deepEqual(payload, { ok: true, service: 'marketplace-watch-app' });
});
