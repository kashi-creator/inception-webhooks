import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  createCalendlyRouter,
  verifyCalendlySignature,
  parseSignatureHeader,
} from '../src/calendly.js';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/log.js';
import {
  makeFakeGhl,
  makeMemoryLog,
  makeCache,
  buildCalendlySig,
} from './helpers.js';

const SIGNING_KEY = 'test_calendly_signing_key_0123456789abcdef';

function buildApp({ ghl, cache, log, signingKey = SIGNING_KEY, now = Date.now }) {
  const calendlyRouter = createCalendlyRouter({ ghl, idempotencyCache: cache, log, signingKey, now });
  // No stripe router for Calendly tests — pass a no-op placeholder.
  const stripeRouter = express.Router();
  return createApp({ stripeRouter, calendlyRouter, log });
}

async function postJson(app, path, body, headers = {}) {
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    server.close();
  }
}

test('calendly: parseSignatureHeader handles the documented format', () => {
  const got = parseSignatureHeader('t=1234567890,v1=abc');
  assert.deepEqual(got, { t: '1234567890', ts: 1234567890, v1: 'abc' });
});

test('calendly: parseSignatureHeader handles whitespace + extra params', () => {
  const got = parseSignatureHeader(' t=42, v1=ff , v2=ignored');
  assert.equal(got.t, '42');
  assert.equal(got.v1, 'ff');
});

test('calendly: parseSignatureHeader returns null on garbage', () => {
  assert.equal(parseSignatureHeader(null), null);
  assert.equal(parseSignatureHeader(''), null);
  assert.equal(parseSignatureHeader('t=onlytimestamp'), null);
  assert.equal(parseSignatureHeader('v1=onlysig'), null);
});

test('calendly: verifyCalendlySignature rejects stale timestamp (>5 min)', () => {
  const rawBody = Buffer.from('{}');
  const tenMinAgo = Math.floor(Date.now() / 1000) - 600;
  const header = buildCalendlySig({ rawBody, signingKey: SIGNING_KEY, timestamp: tenMinAgo });
  const r = verifyCalendlySignature({ rawBody, header, signingKey: SIGNING_KEY });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'stale_timestamp');
});

test('calendly: verifyCalendlySignature accepts valid signature in window', () => {
  const rawBody = Buffer.from('{"hello":"world"}');
  const header = buildCalendlySig({ rawBody, signingKey: SIGNING_KEY });
  const r = verifyCalendlySignature({ rawBody, header, signingKey: SIGNING_KEY });
  assert.equal(r.ok, true);
});

test('calendly: verifyCalendlySignature rejects wrong key', () => {
  const rawBody = Buffer.from('{}');
  const header = buildCalendlySig({ rawBody, signingKey: 'other-key' });
  const r = verifyCalendlySignature({ rawBody, header, signingKey: SIGNING_KEY });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'signature_mismatch');
});

test('calendly: webhook returns 400 on bad signature', async () => {
  const ghl = makeFakeGhl();
  const cache = makeCache();
  const mem = makeMemoryLog();
  const log = createLogger({ stream: mem.stream });
  const app = buildApp({ ghl, cache, log });
  const res = await postJson(app, '/webhooks/calendly', '{"event":"invitee.created"}', {
    'calendly-webhook-signature': 't=1,v1=deadbeef',
  });
  assert.equal(res.status, 400);
  assert.equal(ghl.calls.length, 0);
});

test('calendly: invitee.created creates contact + tags + opportunity', async () => {
  const ghl = makeFakeGhl();
  ghl.queueUpsert({ contactId: 'c_001', created: true });
  const cache = makeCache();
  const mem = makeMemoryLog();
  const log = createLogger({ stream: mem.stream });
  const app = buildApp({ ghl, cache, log });

  const payload = JSON.stringify({
    event: 'invitee.created',
    created_at: '2026-05-02T20:00:00Z',
    payload: {
      event: { event_type: 'https://api.calendly.com/event_types/abc123' },
      invitee: {
        uri: 'https://api.calendly.com/scheduled_events/E1/invitees/I1',
        email: 'lead@example.com',
        name: 'Jane Doe',
      },
    },
  });
  const sig = buildCalendlySig({ rawBody: payload, signingKey: SIGNING_KEY });
  const res = await postJson(app, '/webhooks/calendly', payload, {
    'calendly-webhook-signature': sig,
  });
  assert.equal(res.status, 200);

  // Allow async handler to settle.
  await new Promise((r) => setTimeout(r, 50));

  const calls = ghl.calls;
  assert.deepEqual(calls[0], ['upsertContact', {
    email: 'lead@example.com',
    firstName: 'Jane',
    lastName: 'Doe',
    source: 'src:calendly',
  }]);
  assert.deepEqual(calls[1], ['addTags', 'c_001', ['stage:disco-booked']]);
  assert.equal(calls[2][0], 'createOpportunity');
  assert.equal(calls[2][1].pipeline, 'sales');
  assert.equal(calls[2][1].stage, 'Disco Booked');
  assert.equal(calls[2][1].contactId, 'c_001');
  assert.equal(calls[2][1].name, 'Disco call — lead@example.com');
});

test('calendly: duplicate invitee.uri within ttl is idempotent (no second GHL call)', async () => {
  const ghl = makeFakeGhl();
  ghl.queueUpsert({ contactId: 'c_002', created: true });
  ghl.queueUpsert({ contactId: 'c_002', created: false });
  const cache = makeCache();
  const mem = makeMemoryLog();
  const log = createLogger({ stream: mem.stream });
  const app = buildApp({ ghl, cache, log });

  const payload = JSON.stringify({
    event: 'invitee.created',
    created_at: '2026-05-02T21:00:00Z',
    payload: {
      invitee: {
        uri: 'https://api.calendly.com/dup-test',
        email: 'dup@example.com',
        name: 'Dup User',
      },
    },
  });
  const sig = buildCalendlySig({ rawBody: payload, signingKey: SIGNING_KEY });

  await postJson(app, '/webhooks/calendly', payload, { 'calendly-webhook-signature': sig });
  await new Promise((r) => setTimeout(r, 30));
  const callsAfterFirst = ghl.calls.length;
  // Generate a fresh signature to avoid the replay-by-bytes idempotency working
  // for a wrong reason (we want the EVENT idempotency to kick in).
  const sig2 = buildCalendlySig({ rawBody: payload, signingKey: SIGNING_KEY, timestamp: Math.floor(Date.now() / 1000) + 1 });
  await postJson(app, '/webhooks/calendly', payload, { 'calendly-webhook-signature': sig2 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ghl.calls.length, callsAfterFirst, 'second call should be skipped by idempotency');
});

test('calendly: invitee.canceled tags engagement:cold on existing contact', async () => {
  const ghl = makeFakeGhl();
  ghl.queueFindByEmail({ id: 'c_999', email: 'cancel@example.com', tags: [] });
  const cache = makeCache();
  const mem = makeMemoryLog();
  const log = createLogger({ stream: mem.stream });
  const app = buildApp({ ghl, cache, log });

  const payload = JSON.stringify({
    event: 'invitee.canceled',
    created_at: '2026-05-02T22:00:00Z',
    payload: {
      invitee: { uri: 'https://api.calendly.com/cancel-1', email: 'cancel@example.com', name: 'C C' },
      cancellation: { reason: 'changed plans', canceler_type: 'invitee' },
    },
  });
  const sig = buildCalendlySig({ rawBody: payload, signingKey: SIGNING_KEY });
  const res = await postJson(app, '/webhooks/calendly', payload, { 'calendly-webhook-signature': sig });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 50));

  const calls = ghl.calls;
  assert.deepEqual(calls[0], ['findContactByEmail', 'cancel@example.com']);
  assert.deepEqual(calls[1], ['addTags', 'c_999', ['engagement:cold']]);
});

test('calendly: invitee.canceled with no matching contact logs warn, no GHL writes', async () => {
  const ghl = makeFakeGhl(); // no queued findContactByEmail → returns null
  const cache = makeCache();
  const mem = makeMemoryLog();
  const log = createLogger({ stream: mem.stream });
  const app = buildApp({ ghl, cache, log });

  const payload = JSON.stringify({
    event: 'invitee.canceled',
    created_at: '2026-05-02T22:30:00Z',
    payload: { invitee: { uri: 'https://api.calendly.com/cancel-orphan', email: 'orphan@example.com' } },
  });
  const sig = buildCalendlySig({ rawBody: payload, signingKey: SIGNING_KEY });
  await postJson(app, '/webhooks/calendly', payload, { 'calendly-webhook-signature': sig });
  await new Promise((r) => setTimeout(r, 50));
  const writeCalls = ghl.calls.filter(([m]) => m === 'addTags' || m === 'setCustomFields' || m === 'upsertContact');
  assert.equal(writeCalls.length, 0);
});
