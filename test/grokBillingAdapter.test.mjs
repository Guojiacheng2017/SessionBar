import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGrokBilling } from '../dist/providers/provider-plans/grokBillingAdapter.js';

test('unified Grok billing exposes the reported weekly quota', () => {
  const row = parseGrokBilling({ config: { isUnifiedBillingUser: true, creditUsagePercent: 1, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-10-28T07:04:18Z' } } }, Date.parse('2026-10-26T07:00:00Z'));
  assert.equal(row.provider, 'three-in-one');
  assert.equal(row.remaining, 99);
  assert.equal(row.used, 1);
  assert.equal(row.limit, 100);
});

test('independent Grok account stays separate and invalid quota is unavailable', () => {
  const config = { creditUsagePercent: 10, currentPeriod: { end: '2026-10-28T07:04:18Z' } };
  assert.equal(parseGrokBilling({ config }, Date.parse('2026-10-26')).provider, 'grok');
  assert.equal(parseGrokBilling({ config: { ...config, creditUsagePercent: 101 } }), null);
  assert.equal(parseGrokBilling({ config: {} }), null);
});
