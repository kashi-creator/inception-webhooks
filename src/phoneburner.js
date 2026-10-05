// PhoneBurner disposition webhook handler.
//
// Each PhoneBurner disposition button gets its own webhook URL:
//   POST /webhooks/phoneburner/<disposition>?key=<PHONEBURNER_WEBHOOK_KEY>
// The disposition lives in the URL, not the payload, so we don't depend on
// PhoneBurner's payload naming for the one thing that matters. PhoneBurner
// webhooks aren't signed, hence the shared key.
//
// The contact is upserted into GHL and tagged; the tag starts the matching MSP
// workflow (msp:interested → Interested → Book, msp:not-now → Not Now Nurture).
// No-answer and gatekeeper stay inside PhoneBurner and have no route here.

import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { emailDomain } from './log.js';

export const DISPOSITION_TAGS = Object.freeze({
  interested: ['msp:prospect', 'msp:interested'],
  'not-now': ['msp:prospect', 'msp:not-now'],
  // The Calendly MSP Growth Call webhook adds stage:disco-booked when the
  // meeting is actually on the calendar; this just records the dialer source.
  booked: ['msp:prospect'],
  'not-a-fit': ['msp:disqualified'],
  dnc: ['DNC', 'compliance:dnc'],
});

const SOURCE_TAG = 'src:phoneburner';

function keyMatches(provided, expected) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Flattens nested objects into [path, value] pairs with lowercase paths, so the
// extractor can match PhoneBurner's nested shape (contact.primary_email.email_address)
// and flat form posts (email) alike.
function flatten(obj, prefix = '', out = []) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k.toLowerCase()}` : k.toLowerCase();
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, path, out);
    else if (Array.isArray(v)) v.forEach((item, i) => flatten(item, `${path}.${i}`, out));
    else if (v !== null && v !== undefined && String(v).trim() !== '') out.push([path, String(v).trim()]);
  }
  return out;
}

function pick(pairs, patterns, test = () => true) {
  for (const re of patterns) {
    const hit = pairs.find(([p, v]) => re.test(p) && test(v));
    if (hit) return hit[1];
  }
  return undefined;
}

export function extractContact(body) {
  const pairs = flatten(body);
  const leaf = (name) => new RegExp(`(^|\\.)${name}$`);
  return {
    email: pick(pairs, [/email_address$/, leaf('email'), /email/], (v) => v.includes('@')),
    phone: pick(pairs, [/primary_phone\.(raw_phone|phone)$/, /raw_phone$/, leaf('phone'), /phone_number$/, /phone/],
      (v) => /\d{7,}/.test(v.replace(/\D/g, ''))),
    firstName: pick(pairs, [leaf('first_name'), leaf('firstname')]),
    lastName: pick(pairs, [leaf('last_name'), leaf('lastname')]),
    companyName: pick(pairs, [leaf('company_name'), leaf('company'), leaf('companyname')]),
    city: pick(pairs, [leaf('city')]),
    state: pick(pairs, [leaf('state')]),
  };
}

export function createPhoneBurnerRouter({ ghl, log, webhookKey }) {
  if (!ghl) throw new Error('createPhoneBurnerRouter: ghl required');
  if (!log) throw new Error('createPhoneBurnerRouter: log required');

  const router = express.Router();
  // No key configured → no route. Keeps an unconfigured deploy from accepting
  // unauthenticated writes into GHL.
  if (!webhookKey) return router;

  const parsers = [express.json({ limit: '256kb' }), express.urlencoded({ extended: true, limit: '256kb' })];

  router.post('/webhooks/phoneburner/:disposition', ...parsers, async (req, res) => {
    const t0 = Date.now();
    const route = '/webhooks/phoneburner';
    if (!keyMatches(req.query.key, webhookKey)) {
      log.warn('phoneburner.bad_key', { route, latency_ms: Date.now() - t0 });
      return res.status(401).send('unauthorized');
    }
    const disposition = req.params.disposition;
    const tags = DISPOSITION_TAGS[disposition];
    if (!tags) return res.status(404).send('unknown disposition');

    const body = req.body || {};
    res.status(200).json({ received: true });

    const contact = extractContact(body);
    if (!contact.email && !contact.phone) {
      log.warn('phoneburner.missing_identity', {
        route, event_type: disposition, err: `payload keys: ${Object.keys(body).join(',')}`,
      });
      return;
    }

    try {
      const { contactId } = await ghl.upsertContact({
        email: contact.email,
        phone: contact.phone,
        firstName: contact.firstName,
        lastName: contact.lastName,
        companyName: contact.companyName,
        source: SOURCE_TAG,
      });
      if (contact.city || contact.state) {
        await ghl.setAddress(contactId, { city: contact.city, state: contact.state });
      }
      await ghl.addTags(contactId, tags);
      log.info('phoneburner.disposition.ok', {
        route, event_type: disposition, contact_id: contactId,
        email_domain: emailDomain(contact.email), ok: true, latency_ms: Date.now() - t0,
      });
    } catch (err) {
      log.error('phoneburner.handler_failed', {
        route, event_type: disposition, ok: false,
        err: err && err.message ? err.message : String(err), latency_ms: Date.now() - t0,
      });
    }
  });

  return router;
}
