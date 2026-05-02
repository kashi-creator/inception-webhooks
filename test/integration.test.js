// Integration test — gated by INTEGRATION=1. Uses the real GHL sub-account
// + real Stripe SDK signature generator. Synthesizes fake webhook events
// signed with a test secret we own, POSTs them to the local app, asserts
// the GHL state, then cleans up.
//
// Run with:
//   INTEGRATION=1 npm run test:integration
//
// Required env: GHL_LOCATION_API_KEY (the PIT). STRIPE_API_KEY not used by
// this test (the deletion handler's email-fallback path is exercised in unit
// tests).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createApp } from '../src/app.js';
import { createStripeRouter } from '../src/stripe.js';
import { createCalendlyRouter } from '../src/calendly.js';
import { createGhl } from '../src/ghl.js';
import { createIdempotencyCache } from '../src/idempotency.js';
import { createLogger } from '../src/log.js';
import {
  buildStripeEventBodyAndSig,
  buildCalendlySig,
  makeStripeClient,
} from './helpers.js';

const SHOULD_RUN = process.env.INTEGRATION === '1';
const PIT = process.env.GHL_LOCATION_API_KEY;
const STRIPE_SECRET = 'whsec_integration_test_' + Math.random().toString(36).slice(2);
const CALENDLY_SIGNING_KEY = 'integration_test_calendly_' + Math.random().toString(36).slice(2);

if (!SHOULD_RUN) {
  test('integration: skipped (set INTEGRATION=1 to run)', () => {});
} else if (!PIT) {
  test('integration: skipped — GHL_LOCATION_API_KEY not set', () => {});
} else {
  // Memory log so the integration test output isn't 100 JSON lines.
  const lines = [];
  const log = createLogger({ stream: { write(l) { lines.push(JSON.parse(l)); return true; } } });

  const ghl = createGhl({ pit: PIT, detectSchemaDrift: false });
  const cache = createIdempotencyCache({ maxSize: 100, ttlMs: 60_000 });
  const stripeClient = makeStripeClient();

  const stripeRouter = createStripeRouter({
    ghl, stripeClient, stripeApi: null, idempotencyCache: cache, log, secret: STRIPE_SECRET,
  });
  const calendlyRouter = createCalendlyRouter({
    ghl, idempotencyCache: cache, log, signingKey: CALENDLY_SIGNING_KEY,
  });
  const app = createApp({ stripeRouter, calendlyRouter, log });

  let server;
  let baseUrl;
  const createdContactIds = new Set();

  test('integration: setup — start app', () => {
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  test('integration: stripe checkout.session.completed creates a real contact', async () => {
    const ts = Date.now();
    const email = `phase4-test+${ts}@inception-emails.com`;
    const stripeCustomerId = `cus_test_${ts}`;
    const payload = {
      id: `evt_int_${ts}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_test_int_${ts}`,
          customer: stripeCustomerId,
          customer_details: { email, name: 'Phase4 Test' },
          payment_link: 'plink_28E28k2ct7JQ52PcTOgIo0i', // Growth
          amount_total: 500000,
        },
      },
    };
    const { body, sig } = buildStripeEventBodyAndSig({ secret: STRIPE_SECRET, payload });
    const res = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': sig },
      body,
    });
    assert.equal(res.status, 200);

    // Wait for the async handler to finish all the GHL writes (5+ round trips).
    await new Promise((r) => setTimeout(r, 4000));

    const contact = await ghl.findContactByEmail(email);
    assert.ok(contact, 'expected GHL contact to exist after checkout');
    createdContactIds.add(contact.id);

    const tags = (contact.tags || []).map((t) => t.toLowerCase());
    assert.ok(tags.includes('src:checkout'), `tags missing src:checkout — got ${tags.join(',')}`);
    assert.ok(tags.includes('tier:growth'),  `tags missing tier:growth — got ${tags.join(',')}`);
    assert.ok(tags.includes('stage:active-client'), `tags missing stage:active-client — got ${tags.join(',')}`);

    // Idempotent re-run — same event.id → no duplicate contact, no error.
    cache._size?.(); // touch cache so we can prove we re-hit the dedupe.
    const built2 = buildStripeEventBodyAndSig({ secret: STRIPE_SECRET, payload, timestamp: Math.floor(Date.now() / 1000) + 1 });
    const res2 = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': built2.sig },
      body: built2.body,
    });
    assert.equal(res2.status, 200);
    await new Promise((r) => setTimeout(r, 500));

    const c2 = await ghl.findContactByEmail(email);
    assert.equal(c2.id, contact.id, 'idempotent path should not produce a new contact');
  });

  test('integration: calendly invitee.created creates a real contact', async () => {
    const ts = Date.now();
    const email = `phase4-test+cal-${ts}@inception-emails.com`;
    const payload = JSON.stringify({
      event: 'invitee.created',
      created_at: new Date().toISOString(),
      payload: {
        event: { event_type: 'https://api.calendly.com/event_types/test' },
        invitee: {
          uri: `https://api.calendly.com/scheduled_events/IT-${ts}/invitees/IT-${ts}`,
          email,
          name: 'Phase4 Calendly',
        },
      },
    });
    const sig = buildCalendlySig({ rawBody: payload, signingKey: CALENDLY_SIGNING_KEY });
    const res = await fetch(`${baseUrl}/webhooks/calendly`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'calendly-webhook-signature': sig },
      body: payload,
    });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 3000));

    const contact = await ghl.findContactByEmail(email);
    assert.ok(contact, 'expected GHL contact after Calendly invitee.created');
    createdContactIds.add(contact.id);

    const tags = (contact.tags || []).map((t) => t.toLowerCase());
    assert.ok(tags.includes('src:calendly'), `tags missing src:calendly — got ${tags.join(',')}`);
    assert.ok(tags.includes('stage:disco-booked'), `tags missing stage:disco-booked — got ${tags.join(',')}`);
  });

  test('integration: cleanup — delete created contacts', async () => {
    for (const id of createdContactIds) {
      const res = await fetch(`https://services.leadconnectorhq.com/contacts/${id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${PIT}`,
          Version: '2021-07-28',
          Accept: 'application/json',
        },
      });
      // 200 or 404 (already gone) are both fine; surface anything else.
      if (!(res.ok || res.status === 404)) {
        const t = await res.text();
        throw new Error(`Delete contact ${id} → ${res.status}: ${t.slice(0, 200)}`);
      }
    }
    server?.close();
  });
}
