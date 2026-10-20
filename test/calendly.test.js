import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  createCalendlyRouter,
  verifyCalendlySignature,
  parseSignatureHeader,
  precallEmailCount,
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

function buildApp({ ghl, cache, log, signingKey = SIGNING_KEY, now = Date.now, allowedEventTypes }) {
  const calendlyRouter = createCalendlyRouter({ ghl, idempotencyCache: cache, log, signingKey, now, allowedEventTypes });
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
  // Remove-then-add so a returning lead who already carries the tag still
  // fires GHL's "tag added" trigger (Booked Confirmation, booking goals).
  assert.deepEqual(calls[1], ['removeTags', 'c_001', ['stage:disco-booked']]);
  assert.deepEqual(calls[2], ['addTags', 'c_001', ['stage:disco-booked']]);
  assert.equal(calls[3][0], 'createOpportunity');
  assert.equal(calls[3][1].pipeline, 'sales');
  assert.equal(calls[3][1].stage, 'Disco Booked');
  assert.equal(calls[3][1].contactId, 'c_001');
  assert.equal(calls[3][1].name, 'Disco call — lead@example.com');
});

test('calendly: a duplicate opportunity is a warning, not a failure', async () => {
  const ghl = makeFakeGhl({
    async createOpportunity() { throw new Error('GHL POST /opportunities/ failed: HTTP 400 — Can not create duplicate opportunity for the contact.'); },
  });
  const cache = makeCache();
  const { lines, stream } = makeMemoryLog();
  const log = createLogger({ stream });
  const app = buildApp({ ghl, cache, log });
  const payload = JSON.stringify({
    event: 'invitee.created',
    created_at: '2026-10-06T20:12:19.000Z',
    payload: { invitee: { uri: 'https://api.calendly.com/scheduled_events/E9/invitees/I9', email: 'back@example.com', name: 'Re Turn' } },
  });
  const sig = buildCalendlySig({ rawBody: payload, signingKey: SIGNING_KEY });
  await postJson(app, '/webhooks/calendly', payload, { 'calendly-webhook-signature': sig });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(lines.some((l) => l.msg === 'calendly.invitee_created.ok'));
  assert.ok(!lines.some((l) => l.msg === 'calendly.handler_failed'));
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

const MSP_EVENT = 'https://api.calendly.com/event_types/msp-growth';

function bookingPayload({ eventType, email, createdAt }) {
  return JSON.stringify({
    event: 'invitee.created',
    created_at: createdAt,
    payload: {
      scheduled_event: { event_type: eventType },
      invitee: { uri: `https://api.calendly.com/x/${email}`, email, name: 'Pat Owner' },
    },
  });
}

test('calendly: booking on an allowed event type reaches GHL', async () => {
  const ghl = makeFakeGhl();
  ghl.queueUpsert({ contactId: 'c_msp', created: true });
  const log = createLogger({ stream: makeMemoryLog().stream });
  const app = buildApp({ ghl, cache: makeCache(), log, allowedEventTypes: [MSP_EVENT] });
  const payload = bookingPayload({ eventType: MSP_EVENT, email: 'owner@msp.example', createdAt: '2026-10-05T18:00:00Z' });
  await postJson(app, '/webhooks/calendly', payload, { 'calendly-webhook-signature': buildCalendlySig({ rawBody: payload, signingKey: SIGNING_KEY }) });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ghl.calls[0][0], 'upsertContact');
});

test('calendly: booking on any other event type is ignored (no GHL calls)', async () => {
  const ghl = makeFakeGhl();
  const log = createLogger({ stream: makeMemoryLog().stream });
  const app = buildApp({ ghl, cache: makeCache(), log, allowedEventTypes: [MSP_EVENT] });
  const payload = bookingPayload({ eventType: 'https://api.calendly.com/event_types/30min', email: 'friend@example.com', createdAt: '2026-10-05T18:05:00Z' });
  const res = await postJson(app, '/webhooks/calendly', payload, { 'calendly-webhook-signature': buildCalendlySig({ rawBody: payload, signingKey: SIGNING_KEY }) });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ghl.calls.length, 0);
});

test('calendly: booking answers fill phone + website and land as a GHL note', async () => {
  const ghl = makeFakeGhl();
  ghl.queueUpsert({ contactId: 'c_qa', created: true });
  const cache = makeCache();
  const { stream } = makeMemoryLog();
  const app = buildApp({ ghl, cache, log: createLogger({ stream }) });
  const payload = JSON.stringify({
    event: 'invitee.created',
    created_at: '2026-10-06T21:00:00.000Z',
    payload: {
      email: 'owner@msp.com',
      name: 'Pat Owner',
      uri: 'https://api.calendly.com/scheduled_events/E7/invitees/I7',
      questions_and_answers: [
        { question: "What's the best phone number to reach you at?", answer: '+1 813 555 0101', position: 0 },
        { question: 'Your company website?', answer: 'patmsp.com', position: 1 },
        { question: 'How many people are on your team?', answer: '5–25', position: 2 },
      ],
    },
  });
  const sig = buildCalendlySig({ rawBody: payload, signingKey: SIGNING_KEY });
  await postJson(app, '/webhooks/calendly', payload, { 'calendly-webhook-signature': sig });
  await new Promise((r) => setTimeout(r, 50));
  const fields = ghl.calls.find((c) => c[0] === 'setContactFields');
  assert.deepEqual(fields, ['setContactFields', 'c_qa', { phone: '+1 813 555 0101', website: 'patmsp.com' }]);
  const note = ghl.calls.find((c) => c[0] === 'addNote');
  assert.equal(note[1], 'c_qa');
  assert.match(note[2], /How many people are on your team\?\n5–25/);
});

test('calendly: no answers means no note and no field write', async () => {
  const ghl = makeFakeGhl();
  const cache = makeCache();
  const { stream } = makeMemoryLog();
  const app = buildApp({ ghl, cache, log: createLogger({ stream }) });
  const payload = JSON.stringify({
    event: 'invitee.created', created_at: '2026-10-06T21:01:00.000Z',
    payload: { email: 'x@y.com', name: 'X', uri: 'https://api.calendly.com/scheduled_events/E8/invitees/I8' },
  });
  const sig = buildCalendlySig({ rawBody: payload, signingKey: SIGNING_KEY });
  await postJson(app, '/webhooks/calendly', payload, { 'calendly-webhook-signature': sig });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!ghl.calls.some((c) => c[0] === 'addNote' || c[0] === 'setContactFields'));
});

function scheduledPayload({ email, createdAt, scheduledEvent, timezone }) {
  return JSON.stringify({
    event: 'invitee.created',
    created_at: createdAt,
    payload: {
      email, name: 'Pat Owner', timezone,
      uri: `https://api.calendly.com/scheduled_events/S/invitees/${email}`,
      scheduled_event: scheduledEvent,
    },
  });
}

async function postScheduled(app, payload) {
  const sig = buildCalendlySig({ rawBody: payload, signingKey: SIGNING_KEY });
  await postJson(app, '/webhooks/calendly', payload, { 'calendly-webhook-signature': sig });
  await new Promise((r) => setTimeout(r, 50));
}

test('calendly: call time + Zoom link land on Call Date / Meeting Link before the booked tag', async () => {
  const ghl = makeFakeGhl();
  ghl.queueUpsert({ contactId: 'c_cd', created: true });
  const app = buildApp({ ghl, cache: makeCache(), log: createLogger({ stream: makeMemoryLog().stream }) });
  await postScheduled(app, scheduledPayload({
    email: 'cd@msp.com', createdAt: '2026-10-19T15:00:00.000Z', timezone: 'America/New_York',
    scheduledEvent: {
      start_time: '2026-10-21T18:30:00.000000Z',
      location: { type: 'zoom', join_url: 'https://us02web.zoom.us/j/123456789' },
    },
  }));
  const idx = ghl.calls.findIndex((c) => c[0] === 'setCustomFieldValues');
  assert.ok(idx >= 0, 'custom fields written');
  const [, cid, fields] = ghl.calls[idx];
  assert.equal(cid, 'c_cd');
  assert.deepEqual(fields.slice(0, 2), [
    { id: 'gt9XuAP9kQLRurPmRFXD', key: 'call_date', value: 'Wednesday, October 21 at 2:30 PM EDT' },
    { id: 'mb0boKK8jGwIffI6cyrA', key: 'meeting_link', value: 'https://us02web.zoom.us/j/123456789' },
  ]);
  assert.equal(fields[2].id, 'I6ixP2zu0oOQug7ibG14');
  assert.equal(fields[2].key, 'precall_emails');
  assert.equal(typeof fields[2].value, 'number');
  // Booked Confirmation fires on the tag and merges these fields, so they must exist first.
  const tagIdx = ghl.calls.findIndex((c) => c[0] === 'addTags' && c[2].includes('stage:disco-booked'));
  assert.ok(idx < tagIdx, 'fields written before stage:disco-booked is added');
  // Existing behavior unchanged.
  assert.deepEqual(ghl.calls.find((c) => c[0] === 'removeTags'), ['removeTags', 'c_cd', ['stage:disco-booked']]);
  assert.ok(ghl.calls.some((c) => c[0] === 'createOpportunity'));
});

test('calendly: Call Date uses the invitee timezone, falling back to Eastern', async () => {
  const ghl = makeFakeGhl();
  ghl.queueUpsert({ contactId: 'c_pt', created: true });
  ghl.queueUpsert({ contactId: 'c_et', created: true });
  const app = buildApp({ ghl, cache: makeCache(), log: createLogger({ stream: makeMemoryLog().stream }) });
  const ev = { start_time: '2026-10-21T18:30:00.000000Z', location: { type: 'zoom', join_url: 'https://zoom.us/j/1' } };
  await postScheduled(app, scheduledPayload({ email: 'pt@msp.com', createdAt: '2026-10-19T15:01:00Z', timezone: 'America/Los_Angeles', scheduledEvent: ev }));
  await postScheduled(app, scheduledPayload({ email: 'et@msp.com', createdAt: '2026-10-19T15:02:00Z', timezone: 'Not/AZone', scheduledEvent: ev }));
  const writes = ghl.calls.filter((c) => c[0] === 'setCustomFieldValues');
  assert.equal(writes[0][2][0].value, 'Wednesday, October 21 at 11:30 AM PDT');
  assert.equal(writes[1][2][0].value, 'Wednesday, October 21 at 2:30 PM EDT');
});

test('calendly: no scheduled_event means no custom-field write', async () => {
  const ghl = makeFakeGhl();
  const app = buildApp({ ghl, cache: makeCache(), log: createLogger({ stream: makeMemoryLog().stream }) });
  await postScheduled(app, scheduledPayload({ email: 'none@msp.com', createdAt: '2026-10-19T15:03:00Z' }));
  assert.ok(!ghl.calls.some((c) => c[0] === 'setCustomFieldValues'));
  assert.ok(ghl.calls.some((c) => c[0] === 'addTags'));
});

test('calendly: a failed custom-field write still tags and creates the opportunity', async () => {
  const ghl = makeFakeGhl({ async setCustomFieldValues() { throw new Error('GHL PUT /contacts/x → 422'); } });
  const { lines, stream } = makeMemoryLog();
  const app = buildApp({ ghl, cache: makeCache(), log: createLogger({ stream }) });
  await postScheduled(app, scheduledPayload({
    email: 'fail@msp.com', createdAt: '2026-10-19T15:04:00Z', timezone: 'America/New_York',
    scheduledEvent: { start_time: '2026-10-21T18:30:00Z', location: { join_url: 'https://zoom.us/j/2' } },
  }));
  assert.ok(ghl.calls.some((c) => c[0] === 'addTags'));
  assert.ok(ghl.calls.some((c) => c[0] === 'createOpportunity'));
  assert.ok(lines.some((l) => l.msg === 'calendly.call_fields_failed'));
  assert.ok(lines.some((l) => l.msg === 'calendly.invitee_created.ok'));
});

// Pre-Call Daily Value sends at the next 8am (contact time) after booking, then
// every 8am after, while the call is still more than 24h away. Max 6 emails.
test('calendly: precallEmailCount counts 8am sends more than 24h before the call', () => {
  const ny = 'America/New_York';
  // Booked Mon 3pm, call Thu 2pm: Tue 8am + Wed 8am qualify, Thu 8am doesn't.
  assert.equal(precallEmailCount(Date.parse('2026-10-19T19:00:00Z'), '2026-10-22T18:00:00Z', ny), 2);
  // Booked 6am: the first send is the same morning at 8am.
  assert.equal(precallEmailCount(Date.parse('2026-10-19T10:00:00Z'), '2026-10-21T18:00:00Z', ny), 2);
  // Call tomorrow afternoon: none.
  assert.equal(precallEmailCount(Date.parse('2026-10-19T19:00:00Z'), '2026-10-20T18:00:00Z', ny), 0);
  // A week out: capped at 6.
  assert.equal(precallEmailCount(Date.parse('2026-10-19T19:00:00Z'), '2026-10-27T18:00:00Z', ny), 6);
  // Across the Nov 1 DST change: Oct 31, Nov 1, Nov 2 at 8am local all qualify.
  assert.equal(precallEmailCount(Date.parse('2026-10-30T16:00:00Z'), '2026-11-03T19:00:00Z', ny), 3);
  // Pacific invitee: 8am PT is later in UTC, so Wed 8am PT (15:00Z) is still >24h before Thu 18:00Z.
  assert.equal(precallEmailCount(Date.parse('2026-10-19T22:00:00Z'), '2026-10-22T18:00:00Z', 'America/Los_Angeles'), 2);
  assert.equal(precallEmailCount(Date.now(), 'not a date', ny), 0);
});

test('calendly: invitee timezone is saved on the contact before the booked tag', async () => {
  const ghl = makeFakeGhl();
  ghl.queueUpsert({ contactId: 'c_tz', created: true });
  const app = buildApp({ ghl, cache: makeCache(), log: createLogger({ stream: makeMemoryLog().stream }) });
  await postScheduled(app, scheduledPayload({
    email: 'tz@msp.com', createdAt: '2026-10-19T15:10:00Z', timezone: 'America/Chicago',
    scheduledEvent: { start_time: '2026-10-21T18:30:00Z', location: { join_url: 'https://zoom.us/j/3' } },
  }));
  const tzIdx = ghl.calls.findIndex((c) => c[0] === 'setContactFields' && c[2].timezone);
  const tagIdx = ghl.calls.findIndex((c) => c[0] === 'addTags' && c[2].includes('stage:disco-booked'));
  assert.deepEqual(ghl.calls[tzIdx], ['setContactFields', 'c_tz', { timezone: 'America/Chicago' }]);
  assert.ok(tzIdx < tagIdx);
});

test('calendly: an invalid invitee timezone is not written to the contact', async () => {
  const ghl = makeFakeGhl();
  ghl.queueUpsert({ contactId: 'c_badtz', created: true });
  const app = buildApp({ ghl, cache: makeCache(), log: createLogger({ stream: makeMemoryLog().stream }) });
  await postScheduled(app, scheduledPayload({
    email: 'badtz@msp.com', createdAt: '2026-10-19T15:11:00Z', timezone: 'Mars/Olympus',
    scheduledEvent: { start_time: '2026-10-21T18:30:00Z' },
  }));
  assert.ok(!ghl.calls.some((c) => c[0] === 'setContactFields' && c[2].timezone));
});
