import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createStripeRouter } from '../src/stripe.js';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/log.js';
import {
  makeFakeGhl,
  makeMemoryLog,
  makeCache,
  buildStripeEventBodyAndSig,
  makeStripeClient,
  makeStripeApiStub,
} from './helpers.js';

const STRIPE_SECRET = 'whsec_test_secret_for_unit_tests';

function buildApp({ ghl, cache, log, stripeApi = null }) {
  const stripeClient = makeStripeClient();
  const stripeRouter = createStripeRouter({
    ghl,
    stripeClient,
    stripeApi,
    idempotencyCache: cache,
    log,
    secret: STRIPE_SECRET,
  });
  // No real Calendly router in stripe-only tests.
  const calendlyRouter = express.Router();
  return createApp({ stripeRouter, calendlyRouter, log });
}

async function postRaw(app, path, body, headers = {}) {
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

test('stripe: webhook returns 400 on bad signature', async () => {
  const ghl = makeFakeGhl();
  const cache = makeCache();
  const mem = makeMemoryLog();
  const log = createLogger({ stream: mem.stream });
  const app = buildApp({ ghl, cache, log });
  const res = await postRaw(app, '/webhooks/stripe', '{"hello":"world"}', {
    'stripe-signature': 't=1,v1=deadbeef',
  });
  assert.equal(res.status, 400);
  assert.equal(ghl.calls.length, 0);
});

test('stripe: checkout.session.completed creates contact + tier tag + opp', async () => {
  const ghl = makeFakeGhl();
  ghl.queueUpsert({ contactId: 'c_paid_1', created: true });
  const cache = makeCache();
  const mem = makeMemoryLog();
  const log = createLogger({ stream: mem.stream });
  const app = buildApp({ ghl, cache, log });

  const payload = {
    id: 'evt_001',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        customer: 'cus_test_001',
        customer_details: { email: 'paid@example.com', name: 'Pat Smith' },
        payment_link: 'plink_9B6bIU3gxd4agLx4nigIo0j', // Accelerator
        amount_total: 250000,
      },
    },
  };
  const { body, sig } = buildStripeEventBodyAndSig({ secret: STRIPE_SECRET, payload });
  const res = await postRaw(app, '/webhooks/stripe', body, { 'stripe-signature': sig });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 50));

  const c = ghl.calls;
  assert.deepEqual(c[0], ['upsertContact', {
    email: 'paid@example.com',
    firstName: 'Pat',
    lastName: 'Smith',
    source: 'src:checkout',
  }]);
  assert.deepEqual(c[1], ['addTags', 'c_paid_1', ['tier:accelerator', 'stage:active-client']]);
  assert.deepEqual(c[2], ['setCustomFields', 'c_paid_1', { tier: 'Accelerator' }]);
  assert.deepEqual(c[3], ['setStripeCustomerId', 'c_paid_1', 'cus_test_001']);
  assert.equal(c[4][0], 'createOpportunity');
  assert.equal(c[4][1].pipeline, 'sales');
  assert.equal(c[4][1].stage, 'Won');
  assert.equal(c[4][1].monetaryValue, 2500);
  assert.equal(c[4][1].status, 'won');
});

test('stripe: unknown payment_link defaults to Starter, logs warn, still creates contact', async () => {
  const ghl = makeFakeGhl();
  ghl.queueUpsert({ contactId: 'c_unk_tier', created: true });
  const cache = makeCache();
  const mem = makeMemoryLog();
  const log = createLogger({ stream: mem.stream });
  const app = buildApp({ ghl, cache, log });

  const payload = {
    id: 'evt_unknown_link',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_unk',
        customer: 'cus_unk',
        customer_details: { email: 'unk@example.com', name: 'U N' },
        payment_link: 'plink_does_not_exist',
        amount_total: 100000,
      },
    },
  };
  const { body, sig } = buildStripeEventBodyAndSig({ secret: STRIPE_SECRET, payload });
  await postRaw(app, '/webhooks/stripe', body, { 'stripe-signature': sig });
  await new Promise((r) => setTimeout(r, 50));

  // Contact still gets created with Starter.
  const tagsCall = ghl.calls.find(([m]) => m === 'addTags');
  assert.deepEqual(tagsCall[2], ['tier:starter', 'stage:active-client']);

  // Warn line emitted with the unknown payment_link.
  const warn = mem.lines.find((l) => l.msg === 'stripe.checkout_completed.unknown_payment_link');
  assert.ok(warn, 'expected a warn line for unknown payment link');
  assert.equal(warn.payment_link, 'plink_does_not_exist');
  assert.equal(warn.tier, 'Starter');
});

test('stripe: duplicate event.id within ttl is idempotent', async () => {
  const ghl = makeFakeGhl();
  ghl.queueUpsert({ contactId: 'c_dup', created: true });
  ghl.queueUpsert({ contactId: 'c_dup', created: false });
  const cache = makeCache();
  const mem = makeMemoryLog();
  const log = createLogger({ stream: mem.stream });
  const app = buildApp({ ghl, cache, log });

  const payload = {
    id: 'evt_dup_42',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_dup',
        customer: 'cus_dup',
        customer_details: { email: 'dup@example.com', name: 'D Up' },
        payment_link: 'plink_8x2aEQ2ct3tA66T2fagIo0k',
        amount_total: 50000,
      },
    },
  };
  const built = buildStripeEventBodyAndSig({ secret: STRIPE_SECRET, payload });
  await postRaw(app, '/webhooks/stripe', built.body, { 'stripe-signature': built.sig });
  await new Promise((r) => setTimeout(r, 30));
  const callsAfterFirst = ghl.calls.length;
  // New signature, same event.id.
  const built2 = buildStripeEventBodyAndSig({ secret: STRIPE_SECRET, payload, timestamp: built.ts + 1 });
  await postRaw(app, '/webhooks/stripe', built2.body, { 'stripe-signature': built2.sig });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ghl.calls.length, callsAfterFirst, 'second event with same id should skip GHL writes');
});

test('stripe: customer.subscription.deleted finds contact via stripe_customer_id, tags churned', async () => {
  const ghl = makeFakeGhl();
  ghl.queueFindByStripeCustomerId({ id: 'c_churn', email: 'churn@example.com' });
  const cache = makeCache();
  const mem = makeMemoryLog();
  const log = createLogger({ stream: mem.stream });
  const app = buildApp({ ghl, cache, log });

  const payload = {
    id: 'evt_sub_del_1',
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_1', customer: 'cus_churn_42' } },
  };
  const { body, sig } = buildStripeEventBodyAndSig({ secret: STRIPE_SECRET, payload });
  await postRaw(app, '/webhooks/stripe', body, { 'stripe-signature': sig });
  await new Promise((r) => setTimeout(r, 50));

  assert.deepEqual(ghl.calls[0], ['findContactByStripeCustomerId', 'cus_churn_42']);
  assert.deepEqual(ghl.calls[1], ['addTags', 'c_churn', ['stage:churned']]);
  assert.deepEqual(ghl.calls[2], ['removeTags', 'c_churn', ['stage:active-client']]);
});

test('stripe: customer.subscription.deleted falls back to email lookup when custom-field search misses', async () => {
  const ghl = makeFakeGhl();
  // Custom-field search returns null (no stub queued).
  ghl.queueFindByEmail({ id: 'c_email_recover', email: 'recover@example.com' });
  const stripeApi = makeStripeApiStub({ customers: { cus_orphan: { email: 'recover@example.com' } } });
  const cache = makeCache();
  const mem = makeMemoryLog();
  const log = createLogger({ stream: mem.stream });
  const app = buildApp({ ghl, cache, log, stripeApi });

  const payload = {
    id: 'evt_sub_del_2',
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_2', customer: 'cus_orphan' } },
  };
  const { body, sig } = buildStripeEventBodyAndSig({ secret: STRIPE_SECRET, payload });
  await postRaw(app, '/webhooks/stripe', body, { 'stripe-signature': sig });
  await new Promise((r) => setTimeout(r, 50));

  // Order: custom-field search → email search → addTags → removeTags.
  assert.equal(ghl.calls[0][0], 'findContactByStripeCustomerId');
  assert.equal(ghl.calls[1][0], 'findContactByEmail');
  assert.equal(ghl.calls[1][1], 'recover@example.com');
  assert.deepEqual(ghl.calls[2], ['addTags', 'c_email_recover', ['stage:churned']]);
});

test('stripe: invoice.payment_failed tags engagement:cold', async () => {
  const ghl = makeFakeGhl();
  ghl.queueFindByStripeCustomerId({ id: 'c_dunning', email: 'd@example.com' });
  const cache = makeCache();
  const mem = makeMemoryLog();
  const log = createLogger({ stream: mem.stream });
  const app = buildApp({ ghl, cache, log });

  const payload = {
    id: 'evt_inv_fail_1',
    type: 'invoice.payment_failed',
    data: { object: { id: 'in_1', customer: 'cus_dunning_7' } },
  };
  const { body, sig } = buildStripeEventBodyAndSig({ secret: STRIPE_SECRET, payload });
  await postRaw(app, '/webhooks/stripe', body, { 'stripe-signature': sig });
  await new Promise((r) => setTimeout(r, 50));

  assert.deepEqual(ghl.calls[0], ['findContactByStripeCustomerId', 'cus_dunning_7']);
  assert.deepEqual(ghl.calls[1], ['addTags', 'c_dunning', ['engagement:cold']]);
});

test('stripe: unhandled event type is ack-200 and logged as ignored', async () => {
  const ghl = makeFakeGhl();
  const cache = makeCache();
  const mem = makeMemoryLog();
  const log = createLogger({ stream: mem.stream });
  const app = buildApp({ ghl, cache, log });

  const payload = {
    id: 'evt_other',
    type: 'customer.created',
    data: { object: { id: 'cus_x' } },
  };
  const { body, sig } = buildStripeEventBodyAndSig({ secret: STRIPE_SECRET, payload });
  const res = await postRaw(app, '/webhooks/stripe', body, { 'stripe-signature': sig });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ghl.calls.length, 0);
  const ignored = mem.lines.find((l) => l.msg === 'stripe.event_ignored');
  assert.ok(ignored, 'expected stripe.event_ignored log line');
});

test('healthz: returns 200 ok', async () => {
  const ghl = makeFakeGhl();
  const cache = makeCache();
  const mem = makeMemoryLog();
  const log = createLogger({ stream: mem.stream });
  const app = buildApp({ ghl, cache, log });
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    assert.equal((await res.text()).trim(), 'ok');
  } finally {
    server.close();
  }
});
