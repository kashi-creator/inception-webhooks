import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierForPaymentLink, DEFAULT_TIER, TIER_BY_PAYMENT_LINK } from '../src/config.js';

test('config: tierForPaymentLink maps the 4 known links to tiers', () => {
  assert.equal(tierForPaymentLink('plink_8x2aEQ2ct3tA66T2fagIo0k').tier, 'Starter');
  assert.equal(tierForPaymentLink('plink_9B6bIU3gxd4agLx4nigIo0j').tier, 'Accelerator');
  assert.equal(tierForPaymentLink('plink_28E28k2ct7JQ52PcTOgIo0i').tier, 'Growth');
  assert.equal(tierForPaymentLink('plink_bJe28k6sJd4a7aX5rmgIo0h').tier, 'Enterprise');
});

test('config: tierForPaymentLink accepts both prefixed and bare suffix forms', () => {
  // Stripe Dashboard surfaces `plink_…`; SoT §2.3 records the suffix form.
  // Both must resolve.
  assert.equal(tierForPaymentLink('8x2aEQ2ct3tA66T2fagIo0k').tier, 'Starter');
});

test('config: unknown payment_link defaults to Starter with fallback flag', () => {
  const r = tierForPaymentLink('plink_unknown');
  assert.equal(r.tier, DEFAULT_TIER);
  assert.equal(r.fallback, true);
});

test('config: missing payment_link defaults to Starter with fallback flag', () => {
  const r = tierForPaymentLink(undefined);
  assert.equal(r.tier, DEFAULT_TIER);
  assert.equal(r.fallback, true);
});

test('config: TIER_BY_PAYMENT_LINK has 8 entries (4 prefixed + 4 bare)', () => {
  assert.equal(Object.keys(TIER_BY_PAYMENT_LINK).length, 8);
});
