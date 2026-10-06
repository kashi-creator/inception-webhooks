// Test helpers — fake GHL client + log + cache + Stripe signature builder.

import Stripe from 'stripe';
import { createHmac } from 'node:crypto';
import { createIdempotencyCache } from '../src/idempotency.js';

export function makeFakeGhl(overrides = {}) {
  const calls = [];
  const upsertResults = [];
  const findEmailResults = [];
  const findStripeResults = [];

  const fake = {
    calls,
    queueUpsert: (result) => upsertResults.push(result),
    queueFindByEmail: (result) => findEmailResults.push(result),
    queueFindByStripeCustomerId: (result) => findStripeResults.push(result),

    async upsertContact(input) {
      calls.push(['upsertContact', input]);
      const r = upsertResults.shift();
      return r || { contactId: 'contact_default', created: true };
    },
    async findContactByEmail(email) {
      calls.push(['findContactByEmail', email]);
      return findEmailResults.length ? findEmailResults.shift() : null;
    },
    async findContactByPhone(phone) {
      calls.push(['findContactByPhone', phone]);
      return null;
    },
    async updateContact(id, input) { calls.push(['updateContact', id, input]); },
    async addTags(id, tags) { calls.push(['addTags', id, [...tags]]); },
    async removeTags(id, tags) { calls.push(['removeTags', id, [...tags]]); },
    async setCustomFields(id, vals) { calls.push(['setCustomFields', id, { ...vals }]); },
    async createOpportunity(input) {
      calls.push(['createOpportunity', input]);
      return { opportunityId: 'opp_default', pipelineId: 'pipe_default', pipelineStageId: 'stage_default' };
    },
    async moveOpportunity(id, input) { calls.push(['moveOpportunity', id, input]); return { opportunityId: id, pipelineId: 'p', pipelineStageId: 's' }; },
    async setAddress(id, addr) { calls.push(['setAddress', id, { ...addr }]); },
    async setContactFields(id, fields) { calls.push(['setContactFields', id, { ...fields }]); },
    async addNote(id, body) { calls.push(['addNote', id, body]); },
    async setStripeCustomerId(id, stripeCustomerId) { calls.push(['setStripeCustomerId', id, stripeCustomerId]); },
    async findContactByStripeCustomerId(stripeCustomerId) {
      calls.push(['findContactByStripeCustomerId', stripeCustomerId]);
      return findStripeResults.length ? findStripeResults.shift() : null;
    },
    ...overrides,
  };
  return fake;
}

export function makeMemoryLog() {
  const lines = [];
  const stream = {
    write(line) { lines.push(JSON.parse(line.replace(/\n$/, ''))); return true; },
  };
  return { lines, stream };
}

export function makeCache() { return createIdempotencyCache({ maxSize: 100, ttlMs: 60_000 }); }

const stripeForSig = new Stripe('sk_test_dummy', { apiVersion: '2024-11-20.acacia' });

export function buildStripeEventBodyAndSig({ secret, payload, timestamp }) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const sig = stripeForSig.webhooks.generateTestHeaderString({ payload: body.toString('utf8'), secret, timestamp: ts });
  return { body, sig, ts };
}

export function buildCalendlySig({ rawBody, signingKey, timestamp }) {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const v1 = createHmac('sha256', signingKey).update(`${ts}.${bodyStr}`).digest('hex');
  return `t=${ts},v1=${v1}`;
}

export function makeStripeClient() {
  // Real Stripe SDK is fine for constructEvent — pure HMAC, no network.
  return new Stripe('sk_test_dummy', { apiVersion: '2024-11-20.acacia' });
}

export function makeStripeApiStub({ customers = {} } = {}) {
  return {
    customers: {
      async retrieve(id) {
        if (customers[id] === '__throw__') throw new Error('stripe-api-stub-error');
        return customers[id] || null;
      },
    },
  };
}
