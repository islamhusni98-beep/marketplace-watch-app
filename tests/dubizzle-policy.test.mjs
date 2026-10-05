import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isDefinitiveDubizzleFailure,
  isUsedListingConditionAllowed,
} from '../scripts/dubizzle-policy.mjs';

test('allows an explicitly used vehicle', () => {
  assert.equal(isUsedListingConditionAllowed('Used', true), true);
  assert.equal(isUsedListingConditionAllowed('مستعمل', false), true);
});

test('allows a missing condition only on a Used search route', () => {
  assert.equal(isUsedListingConditionAllowed('', true), true);
  assert.equal(isUsedListingConditionAllowed('', false), false);
});

test('rejects explicit new and unrecognized condition values even on a Used route', () => {
  assert.equal(isUsedListingConditionAllowed('New', true), false);
  assert.equal(isUsedListingConditionAllowed('جديد', true), false);
  assert.equal(isUsedListingConditionAllowed('unknown', true), false);
});

test('stops browser fallback after access denial, rate limit, or server outage', () => {
  for (const status of [403, 429, 500, 503]) {
    assert.equal(isDefinitiveDubizzleFailure(status), true);
  }
  for (const status of [200, 400, 404]) {
    assert.equal(isDefinitiveDubizzleFailure(status), false);
  }
});
