// GHL access layer.
//
// Wraps `@inception-emails/ghl-client` (the typed Phase 2 package) and adds
// two methods for the new `stripe_customer_id` custom field: read (find a
// contact by it) and write (set it on a contact).
//
// Why the extension exists: Phase 4's bootstrap re-run added a 10th custom
// field, but the published v0.1.0 client's `setCustomFields` is statically
// typed against the 9 original fields and throws on unknown keys. Folding
// this field into the client is a v0.2 publish (locked surface — see SoT §9
// Phase 2 entry); doing that synchronously inside Phase 4 is out of scope.
// So the existing 9 fields + tags + opportunities go through the typed client
// (per phase prompt §6.7); only the 10th field uses a thin direct call.

import { createGhlClient } from '@inception-emails/ghl-client';
import { STRIPE_CUSTOMER_ID_FIELD, LOCATION_ID } from './config.js';

const API_BASE = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28';

class GhlExtError extends Error {
  constructor({ status, endpoint, method, body }) {
    super(`GHL ${method} ${endpoint} → ${status}`);
    this.name = 'GhlExtError';
    this.status = status;
    this.endpoint = endpoint;
    this.method = method;
    this.body = body;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function rawRequest({ pit, method, path, body, fetchImpl = fetch, maxRetries = 3 }) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetchImpl(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${pit}`,
        Version: API_VERSION,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (res.ok) return parsed;

    if (res.status === 429 || res.status >= 500) {
      lastErr = new GhlExtError({ status: res.status, endpoint: path, method, body: parsed });
      if (attempt < maxRetries) {
        const backoff = 250 * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
        await sleep(backoff);
        continue;
      }
    }
    throw new GhlExtError({ status: res.status, endpoint: path, method, body: parsed });
  }
  throw lastErr;
}

export function createGhl({ pit, locationId = LOCATION_ID, fetchImpl, detectSchemaDrift } = {}) {
  if (!pit) throw new Error('createGhl: pit required');
  const client = createGhlClient({
    pit,
    locationId,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    ...(detectSchemaDrift !== undefined ? { detectSchemaDrift } : {}),
  });

  const ext = {
    // ---- passthrough to the typed client ----
    upsertContact: (input) => client.upsertContact(input),
    findContactByEmail: (email) => client.findContactByEmail(email),
    findContactByPhone: (phone) => client.findContactByPhone(phone),
    updateContact: (id, input) => client.updateContact(id, input),
    addTags: (id, tags) => client.addTags(id, tags),
    removeTags: (id, tags) => client.removeTags(id, tags),
    setCustomFields: (id, values) => client.setCustomFields(id, values),
    createOpportunity: (input) => client.createOpportunity(input),
    moveOpportunity: (id, input) => client.moveOpportunity(id, input),

    // ---- Phase 4 extension for stripe_customer_id ----

    /**
     * Writes the stripe_customer_id custom field on a contact via PUT /contacts/{id}.
     * The wire shape mirrors `encodeCustomFields` in the v0.1 client (`{ id, key,
     * value, field_value }` belt-and-suspenders — see SoT §10).
     */
    async setStripeCustomerId(contactId, stripeCustomerId) {
      if (!contactId) throw new Error('setStripeCustomerId: contactId required');
      if (!stripeCustomerId) throw new Error('setStripeCustomerId: stripeCustomerId required');
      await rawRequest({
        pit,
        method: 'PUT',
        path: `/contacts/${contactId}`,
        body: {
          customFields: [{
            id: STRIPE_CUSTOMER_ID_FIELD.id,
            key: STRIPE_CUSTOMER_ID_FIELD.key,
            value: stripeCustomerId,
            field_value: stripeCustomerId,
          }],
        },
        fetchImpl,
      });
    },

    /**
     * Searches contacts by stripe_customer_id custom field. Returns the first
     * match or null. GHL search filters reference custom fields by their
     * field-key (canonical lookup path per v2 search API docs).
     */
    async findContactByStripeCustomerId(stripeCustomerId) {
      if (!stripeCustomerId) return null;
      const result = await rawRequest({
        pit,
        method: 'POST',
        path: '/contacts/search',
        body: {
          locationId,
          page: 1,
          pageLimit: 1,
          filters: [{
            field: `customField.${STRIPE_CUSTOMER_ID_FIELD.id}`,
            operator: 'eq',
            value: stripeCustomerId,
          }],
        },
        fetchImpl,
      });
      const contacts = (result && (result.contacts || result.data)) || [];
      return contacts[0] || null;
    },
  };
  return ext;
}
