import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdempotencyCache } from '../src/idempotency.js';

test('idempotency: seen returns false for new key, true after record', () => {
  const cache = createIdempotencyCache({ maxSize: 10, ttlMs: 60_000 });
  assert.equal(cache.seen('k1'), false);
  cache.record('k1');
  assert.equal(cache.seen('k1'), true);
});

test('idempotency: TTL expiry drops old entries', () => {
  let t = 1_000_000;
  const cache = createIdempotencyCache({ maxSize: 10, ttlMs: 1000, now: () => t });
  cache.record('k1');
  assert.equal(cache.seen('k1'), true);
  t += 2000;
  assert.equal(cache.seen('k1'), false);
});

test('idempotency: maxSize evicts oldest', () => {
  const cache = createIdempotencyCache({ maxSize: 3, ttlMs: 60_000 });
  cache.record('a');
  cache.record('b');
  cache.record('c');
  cache.record('d');
  assert.equal(cache.seen('a'), false);
  assert.equal(cache.seen('b'), true);
  assert.equal(cache.seen('c'), true);
  assert.equal(cache.seen('d'), true);
});

test('idempotency: re-recording refreshes recency', () => {
  const cache = createIdempotencyCache({ maxSize: 3, ttlMs: 60_000 });
  cache.record('a');
  cache.record('b');
  cache.record('c');
  cache.record('a'); // refreshes a → b is now oldest
  cache.record('d'); // evicts b
  assert.equal(cache.seen('a'), true);
  assert.equal(cache.seen('b'), false);
  assert.equal(cache.seen('c'), true);
  assert.equal(cache.seen('d'), true);
});
