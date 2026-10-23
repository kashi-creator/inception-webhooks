import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createPhoneBurnerRouter, extractContact, DISPOSITION_TAGS } from '../src/phoneburner.js';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/log.js';
import { makeFakeGhl, makeMemoryLog } from './helpers.js';

const KEY = 'pb_test_key_0123456789';

function buildApp({ ghl, log, key = KEY, now }) {
  const phoneburnerRouter = createPhoneBurnerRouter({ ghl, log, webhookKey: key, now });
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
  for (const d of ['interested', 'not-now', 'booked', 'not-a-fit', 'dnc', 'send-info', 'call-later']) {
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

test('phoneburner: send-info tags msp:send-info and writes no fields', async () => {
  const ghl = makeFakeGhl();
  const { stream } = makeMemoryLog();
  const app = buildApp({ ghl, log: createLogger({ stream }) });
  const res = await post(app, `/webhooks/phoneburner/send-info?key=${KEY}`, PB_PAYLOAD);
  assert.equal(res.status, 200);
  await settle();
  assert.deepEqual(ghl.calls.find((c) => c[0] === 'addTags')[2], ['msp:prospect', 'msp:send-info']);
  assert.ok(!ghl.calls.some((c) => c[0] === 'setCustomFieldValues'));
});

test('phoneburner: call-later sets Follow-Up Date to today + 90 days, before the tag', async () => {
  const ghl = makeFakeGhl();
  const { stream } = makeMemoryLog();
  // 2026-10-20 02:00 UTC is still Oct 19 in Florida, so "today" is Oct 19.
  const now = () => Date.parse('2026-10-20T02:00:00Z');
  const app = buildApp({ ghl, log: createLogger({ stream }), now });
  const res = await post(app, `/webhooks/phoneburner/call-later?key=${KEY}`, PB_PAYLOAD);
  assert.equal(res.status, 200);
  await settle();
  const fieldIdx = ghl.calls.findIndex((c) => c[0] === 'setCustomFieldValues');
  const tagIdx = ghl.calls.findIndex((c) => c[0] === 'addTags');
  assert.deepEqual(ghl.calls[fieldIdx], ['setCustomFieldValues', 'contact_default', [
    { id: 'Wv5hY4I5fE5VDNV8RpL9', key: 'followup_date', value: '2027-01-17' },
  ]]);
  assert.deepEqual(ghl.calls[tagIdx][2], ['msp:prospect', 'msp:call-later']);
  // Workflow 1B's first email merges Follow-Up Date, so it must be set first.
  assert.ok(fieldIdx < tagIdx);
});

// PhoneBurner's documented api_calldone shape: the lead lives under `contact`,
// with no email. The account-level disposition webhook also carries the
// PhoneBurner user's own details somewhere outside `contact`; that address
// (erik@inception-emails.com) must never become the prospect's email.
const PB_CALLDONE_NO_EMAIL = {
  status: 'Send info',
  duration: 54,
  call_id: '1767709',
  connected: '1',
  user: { email_address: 'erik@inception-emails.com', first_name: 'Erik', last_name: 'Duhn', phone: '3802575027' },
  contact: {
    user_id: '9988776',
    lead_id: 'abc123',
    phone: '9495551212',
    first_name: 'Colby',
    last_name: 'Flesher',
    phones: [{ number: '9495551212', phone_type: 'Home', phone_label: null }],
    addresses: [{ address: '123 Main street', city: 'BIRMINGHAM', state: 'Alabama', zip: '35203' }],
  },
};

test('phoneburner: agent/user email is never taken as the prospect email', () => {
  const c = extractContact(PB_CALLDONE_NO_EMAIL);
  assert.equal(c.email, undefined);
  assert.equal(c.phone, '9495551212');
  assert.deepEqual([c.firstName, c.lastName, c.city, c.state], ['Colby', 'Flesher', 'BIRMINGHAM', 'Alabama']);
});

test('phoneburner: contact email wins even when an agent block comes first', () => {
  const c = extractContact({
    agent: { email: 'erik@inception-emails.com', phone: '3802575027' },
    owner_email: 'kashi@inception-emails.com',
    contact: { first_name: 'Dana', primary_email: { email_address: 'dana@acme-it.com' }, primary_phone: { raw_phone: '8135550142' } },
  });
  assert.equal(c.email, 'dana@acme-it.com');
  assert.equal(c.phone, '8135550142');
  assert.equal(c.firstName, 'Dana');
});

test('phoneburner: an @inception-emails.com address is rejected even under contact', () => {
  const c = extractContact({ contact: { email: 'erik@inception-emails.com', phone: '9495551212', first_name: 'X' } });
  assert.equal(c.email, undefined);
  assert.equal(c.phone, '9495551212');
  assert.equal(extractContact({ email: 'vendor+abc@send.inception-emails.com', phone: '8135550100' }).email, undefined);
});

test('phoneburner: a lead with no email is upserted by phone only', async () => {
  const ghl = makeFakeGhl();
  const { lines, stream } = makeMemoryLog();
  const app = buildApp({ ghl, log: createLogger({ stream }) });
  await post(app, `/webhooks/phoneburner/send-info?key=${KEY}`, PB_CALLDONE_NO_EMAIL);
  await settle();
  const upsert = ghl.calls.find((c) => c[0] === 'upsertContact')[1];
  assert.equal(upsert.email, undefined);
  assert.equal(upsert.phone, '9495551212');
  assert.equal(upsert.firstName, 'Colby');
  // The payload's shape (paths only, no values) is logged so the real format can be checked.
  const shape = lines.find((l) => l.msg === 'phoneburner.payload_shape');
  assert.ok(shape, 'payload shape logged');
  assert.ok(!JSON.stringify(shape).includes('erik@'), 'no values in the shape log');
  assert.ok(!JSON.stringify(shape).includes('9495551212'));
});

test('phoneburner: agent fields are never used for name or phone when contact has none', () => {
  const c = extractContact({ status: 'Interested', user: { first_name: 'Erik', phone: '3802575027', email: 'erik@inception-emails.com' }, contact: { lead_id: 'x' } });
  assert.equal(c.email, undefined);
  assert.equal(c.phone, undefined);
  assert.equal(c.firstName, undefined);
});
