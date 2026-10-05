import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createPhoneBurnerRouter, extractContact, DISPOSITION_TAGS } from '../src/phoneburner.js';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/log.js';
import { makeFakeGhl, makeMemoryLog } from './helpers.js';

const KEY = 'pb_test_key_0123456789';

function buildApp({ ghl, log, key = KEY }) {
  const phoneburnerRouter = createPhoneBurnerRouter({ ghl, log, webhookKey: key });
  return createApp({ stripeRouter: express.Router(), calendlyRouter: express.Router(), phoneburnerRouter, log });
}

async function post(app, path, body, contentType = 'application/json') {
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: contentType === 'application/json' ? JSON.stringify(body) : new URLSearchParams(body).toString(),
    });
    return { status: res.status, text: await res.text() };
  } finally {
    server.close();
  }
}

// Brief wait for the async handler that runs after the 200 is sent.
const settle = () => new Promise((r) => setTimeout(r, 20));

const PB_PAYLOAD = {
  call_id: 'c1',
  disposition: 'Interested',
  contact: {
    first_name: 'Blaine',
    last_name: 'Messersmith',
    company: 'Merit IT',
    primary_email: { email_address: 'blaine@meritit.us' },
    primary_phone: { raw_phone: '7175550100' },
    address: { city: 'Mechanicsburg', state: 'PA' },
  },
};

test('phoneburner: extractContact finds nested PhoneBurner-style fields', () => {
  const c = extractContact(PB_PAYLOAD);
  assert.equal(c.email, 'blaine@meritit.us');
  assert.equal(c.phone, '7175550100');
  assert.equal(c.firstName, 'Blaine');
  assert.equal(c.lastName, 'Messersmith');
  assert.equal(c.companyName, 'Merit IT');
  assert.equal(c.city, 'Mechanicsburg');
});

test('phoneburner: extractContact handles flat form fields', () => {
  const c = extractContact({ first_name: 'Sam', email: 'sam@x.com', phone: '(813) 555-0142', company_name: 'X IT' });
  assert.deepEqual([c.firstName, c.email, c.phone, c.companyName], ['Sam', 'sam@x.com', '(813) 555-0142', 'X IT']);
});

test('phoneburner: wrong key is rejected and nothing reaches GHL', async () => {
  const ghl = makeFakeGhl();
  const { stream } = makeMemoryLog();
  const app = buildApp({ ghl, log: createLogger({ stream }) });
  const res = await post(app, '/webhooks/phoneburner/interested?key=nope', PB_PAYLOAD);
  assert.equal(res.status, 401);
  assert.equal(ghl.calls.length, 0);
});

test('phoneburner: unknown disposition is a 404', async () => {
  const ghl = makeFakeGhl();
  const { stream } = makeMemoryLog();
  const app = buildApp({ ghl, log: createLogger({ stream }) });
  const res = await post(app, `/webhooks/phoneburner/no-answer?key=${KEY}`, PB_PAYLOAD);
  assert.equal(res.status, 404);
  assert.equal(ghl.calls.length, 0);
});

test('phoneburner: interested upserts the contact and adds msp:interested', async () => {
  const ghl = makeFakeGhl();
  const { stream } = makeMemoryLog();
  const app = buildApp({ ghl, log: createLogger({ stream }) });
  const res = await post(app, `/webhooks/phoneburner/interested?key=${KEY}`, PB_PAYLOAD);
  assert.equal(res.status, 200);
  await settle();
  const upsert = ghl.calls.find((c) => c[0] === 'upsertContact')[1];
  assert.equal(upsert.email, 'blaine@meritit.us');
  assert.equal(upsert.companyName, 'Merit IT');
  assert.equal(upsert.source, 'src:phoneburner');
  const tags = ghl.calls.find((c) => c[0] === 'addTags')[2];
  assert.deepEqual(tags, ['msp:prospect', 'msp:interested']);
  assert.ok(ghl.calls.find((c) => c[0] === 'setAddress'));
});

test('phoneburner: form-encoded body works too', async () => {
  const ghl = makeFakeGhl();
  const { stream } = makeMemoryLog();
  const app = buildApp({ ghl, log: createLogger({ stream }) });
  const res = await post(app, `/webhooks/phoneburner/not-now?key=${KEY}`,
    { first_name: 'Sam', email: 'sam@x.com' }, 'application/x-www-form-urlencoded');
  assert.equal(res.status, 200);
  await settle();
  assert.deepEqual(ghl.calls.find((c) => c[0] === 'addTags')[2], ['msp:prospect', 'msp:not-now']);
});

test('phoneburner: dnc tags DNC and compliance:dnc, never msp:prospect', async () => {
  const ghl = makeFakeGhl();
  const { stream } = makeMemoryLog();
  const app = buildApp({ ghl, log: createLogger({ stream }) });
  await post(app, `/webhooks/phoneburner/dnc?key=${KEY}`, PB_PAYLOAD);
  await settle();
  assert.deepEqual(ghl.calls.find((c) => c[0] === 'addTags')[2], ['DNC', 'compliance:dnc']);
});

test('phoneburner: payload with no email or phone is logged and skipped', async () => {
  const ghl = makeFakeGhl();
  const { lines, stream } = makeMemoryLog();
  const app = buildApp({ ghl, log: createLogger({ stream }) });
  await post(app, `/webhooks/phoneburner/interested?key=${KEY}`, { contact: { first_name: 'X' } });
  await settle();
  assert.equal(ghl.calls.length, 0);
  assert.ok(lines.some((l) => l.msg === 'phoneburner.missing_identity'));
});

test('phoneburner: every mapped disposition has tags', () => {
  for (const d of ['interested', 'not-now', 'booked', 'not-a-fit', 'dnc']) {
    assert.ok(DISPOSITION_TAGS[d].length > 0, d);
  }
});

test('phoneburner: router is not mounted when no key is configured', async () => {
  const ghl = makeFakeGhl();
  const { stream } = makeMemoryLog();
  const app = buildApp({ ghl, log: createLogger({ stream }), key: '' });
  const res = await post(app, '/webhooks/phoneburner/interested?key=', PB_PAYLOAD);
  assert.equal(res.status, 404);
});
