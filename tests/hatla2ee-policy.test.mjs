import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasConflictingPrice,
  hasRequiredHatla2eeCardData,
} from '../scripts/hatla2ee-policy.mjs';

test('requires mileage, price, and location on each Hatla2ee card', () => {
  assert.equal(hasRequiredHatla2eeCardData({ price: '710,000 EGP', city: 'Madinaty', mileage: '109,000 KM' }), true);
  assert.equal(hasRequiredHatla2eeCardData({ price: '710,000 EGP', city: 'Madinaty', mileage: '' }), false);
});

test('rejects a displayed price that conflicts with an explicitly labeled asking price', () => {
  assert.equal(hasConflictingPrice('7,100,000 EGP', 'السعر المطلوب: 710,000 جنيه'), true);
});

test('accepts matching prices across English and Arabic numerals', () => {
  assert.equal(hasConflictingPrice('710,000 EGP', 'السعر المطلوب: ٧١٠٬٠٠٠ جنيه'), false);
});

test('does not treat unrelated amounts as a labeled price conflict', () => {
  assert.equal(hasConflictingPrice('710,000 EGP', 'Model year 2025, mileage 109,000 KM'), false);
});
