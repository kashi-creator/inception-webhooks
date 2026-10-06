// Calendly webhook handler.
//
// Two events from Kashi's Calendly account:
//   - invitee.created  → upsert + src:calendly + stage:disco-booked + Disco Booked opp
//   - invitee.canceled → tag engagement:cold + note with cancel reason
//
// Signature scheme (Calendly docs): the signing_key signs `${ts}.${rawBody}`
// with HMAC-SHA256 → hex. Header is `Calendly-Webhook-Signature: t=<ts>,v1=<hex>`.
// Reject signatures older than 5 min to block replay (phase prompt §6.2).

import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { emailDomain } from './log.js';

const REPLAY_WINDOW_SECONDS = 5 * 60;

export function parseSignatureHeader(header) {
  if (typeof header !== 'string') return null;
  const parts = header.split(',').map((p) => p.trim()).filter(Boolean);
  let t;
  let v1;
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const k = p.slice(0, eq);
    const v = p.slice(eq + 1);
    if (k === 't') t = v;
    else if (k === 'v1') v1 = v;
  }
  if (!t || !v1) return null;
  const tsNum = Number(t);
  if (!Number.isFinite(tsNum)) return null;
  return { t, ts: tsNum, v1 };
}

export function verifyCalendlySignature({ rawBody, header, signingKey, now = Date.now }) {
  if (!signingKey) return { ok: false, reason: 'missing_signing_key' };
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: 'malformed_header' };

  const ageSec = Math.abs(Math.floor(now() / 1000) - parsed.ts);
  if (ageSec > REPLAY_WINDOW_SECONDS) return { ok: false, reason: 'stale_timestamp' };

  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const expected = createHmac('sha256', signingKey)
    .update(`${parsed.t}.${bodyStr}`)
    .digest('hex');

  let provided;
  try {
    provided = Buffer.from(parsed.v1, 'hex');
  } catch {
    return { ok: false, reason: 'malformed_v1' };
  }
  const expectedBuf = Buffer.from(expected, 'hex');
  if (provided.length !== expectedBuf.length) return { ok: false, reason: 'length_mismatch' };
  return timingSafeEqual(provided, expectedBuf)
    ? { ok: true }
    : { ok: false, reason: 'signature_mismatch' };
}

function splitName(name) {
  if (!name) return { firstName: undefined, lastName: undefined };
  const idx = name.indexOf(' ');
  if (idx < 0) return { firstName: name, lastName: undefined };
  return { firstName: name.slice(0, idx), lastName: name.slice(idx + 1) };
}

// Calendly sends bookings for every event type on the account (personal calls,
// other businesses). When allowedEventTypes is set, only those event-type URIs
// reach GHL; everything else is acknowledged and dropped.
function bookedEventType(payload) {
  return (payload.scheduled_event && payload.scheduled_event.event_type)
    || (payload.event && payload.event.event_type)
    || payload.event_type
    || null;
}

export function createCalendlyRouter({ ghl, idempotencyCache, log, signingKey, now = Date.now, allowedEventTypes }) {
  if (!ghl) throw new Error('createCalendlyRouter: ghl required');
  if (!idempotencyCache) throw new Error('createCalendlyRouter: idempotencyCache required');
  if (!log) throw new Error('createCalendlyRouter: log required');
  if (!signingKey) throw new Error('createCalendlyRouter: signingKey required');

  const router = express.Router();

  // Capture rawBody for HMAC, but still get parsed JSON via express.json.
  const captureRaw = express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
    limit: '256kb',
  });

  router.post('/webhooks/calendly', captureRaw, async (req, res) => {
    const t0 = Date.now();
    const verdict = verifyCalendlySignature({
      rawBody: req.rawBody || Buffer.alloc(0),
      header: req.headers['calendly-webhook-signature'],
      signingKey,
      now,
    });
    if (!verdict.ok) {
      log.warn('calendly.signature_failed', {
        route: '/webhooks/calendly',
        err: verdict.reason,
        latency_ms: Date.now() - t0,
      });
      return res.status(400).send('signature verification failed');
    }

    const body = req.body || {};
    const eventType = body.event;
    const payload = body.payload || {};
    const invitee = payload.invitee || {};

    if (allowedEventTypes && !allowedEventTypes.includes(bookedEventType(payload))) {
      res.status(200).json({ received: true, ignored: 'event_type' });
      log.info('calendly.event_type_ignored', {
        route: '/webhooks/calendly',
        event_type: eventType,
        invitee_uri: invitee.uri,
        latency_ms: Date.now() - t0,
      });
      return;
    }

    const idemKey = `${body.created_at || ''}|${invitee.uri || invitee.email || ''}`;
    const seen = idempotencyCache.seen(idemKey);
    res.status(200).json({ received: true });

    if (seen) {
      log.info('calendly.idempotent_skip', {
        route: '/webhooks/calendly',
        event_type: eventType,
        invitee_uri: invitee.uri,
        idempotent_skip: true,
        latency_ms: Date.now() - t0,
      });
      return;
    }
    idempotencyCache.record(idemKey);

    try {
      switch (eventType) {
        case 'invitee.created':
          await handleInviteeCreated({ ghl, log, body, t0 });
          break;
        case 'invitee.canceled':
          await handleInviteeCanceled({ ghl, log, body, t0 });
          break;
        default:
          log.info('calendly.event_ignored', {
            route: '/webhooks/calendly',
            event_type: eventType,
            latency_ms: Date.now() - t0,
          });
      }
    } catch (err) {
      log.error('calendly.handler_failed', {
        route: '/webhooks/calendly',
        event_type: eventType,
        ok: false,
        err: err && err.message ? err.message : String(err),
        latency_ms: Date.now() - t0,
      });
    }
  });

  return router;
}

async function handleInviteeCreated({ ghl, log, body, t0 }) {
  const payload = body.payload || {};
  const invitee = payload.invitee || payload;
  const email = invitee.email;
  if (!email) {
    log.warn('calendly.invitee_created.missing_email', { route: '/webhooks/calendly', event_type: body.event });
    return;
  }
  const { firstName, lastName } = splitName(invitee.name);

  const { contactId } = await ghl.upsertContact({
    email,
    firstName,
    lastName,
    source: 'src:calendly',
  });

  // Remove-then-add: a returning lead who already carries the tag would
  // otherwise not fire GHL's "tag added" trigger (Booked Confirmation, and the
  // exit-on-booking goals in the other MSP workflows).
  await ghl.removeTags(contactId, ['stage:disco-booked']);
  await ghl.addTags(contactId, ['stage:disco-booked']);

  // A returning lead already has a Sales opportunity; GHL refuses a second one.
  let opp = null;
  try {
    opp = await ghl.createOpportunity({
      pipeline: 'sales',
      stage: 'Disco Booked',
      contactId,
      name: `Disco call — ${email}`,
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (!/duplicate opportunity/i.test(msg)) throw err;
    log.warn('calendly.opportunity_exists', { route: '/webhooks/calendly', contact_id: contactId, err: msg });
  }

  // Booking-page answers: phone and website go on the contact (Erik calls
  // back from GHL); the full set lands as a note for call prep.
  const qa = payload.questions_and_answers || invitee.questions_and_answers || [];
  const answered = qa.filter((q) => q && q.question && String(q.answer || '').trim());
  if (answered.length) {
    const fields = {};
    const find = (re) => answered.find((q) => re.test(q.question));
    const phone = find(/phone/i);
    const website = find(/website/i);
    if (phone) fields.phone = String(phone.answer).trim();
    if (website) fields.website = String(website.answer).trim();
    if (Object.keys(fields).length) {
      // A phone GHL rejects shouldn't cost us the note.
      try { await ghl.setContactFields(contactId, fields); } catch (err) {
        log.warn('calendly.answers_fields_failed', { route: '/webhooks/calendly', contact_id: contactId, err: err && err.message ? err.message : String(err) });
      }
    }
    const lines = answered
      .sort((a, b) => (a.position || 0) - (b.position || 0))
      .map((q) => `${q.question}\n${String(q.answer).trim()}`);
    await ghl.addNote(contactId, `MSP Growth Call booking answers\n\n${lines.join('\n\n')}`);
  }

  log.info('calendly.invitee_created.ok', {
    route: '/webhooks/calendly',
    event_type: body.event,
    contact_id: contactId,
    email_domain: emailDomain(email),
    invitee_uri: invitee.uri,
    pipeline: 'sales',
    stage: 'Disco Booked',
    opportunity_id: opp && opp.opportunityId,
    ok: true,
    latency_ms: Date.now() - t0,
  });
}

async function handleInviteeCanceled({ ghl, log, body, t0 }) {
  const payload = body.payload || {};
  const invitee = payload.invitee || payload;
  const email = invitee.email;
  if (!email) {
    log.warn('calendly.invitee_canceled.missing_email', { route: '/webhooks/calendly', event_type: body.event });
    return;
  }
  const contact = await ghl.findContactByEmail(email);
  if (!contact) {
    log.warn('calendly.invitee_canceled.contact_not_found', {
      route: '/webhooks/calendly',
      event_type: body.event,
      email_domain: emailDomain(email),
    });
    return;
  }
  await ghl.addTags(contact.id, ['engagement:cold']);

  log.info('calendly.invitee_canceled.ok', {
    route: '/webhooks/calendly',
    event_type: body.event,
    contact_id: contact.id,
    email_domain: emailDomain(email),
    invitee_uri: invitee.uri,
    cancel_reason: (payload.cancellation && payload.cancellation.reason) || undefined,
    ok: true,
    latency_ms: Date.now() - t0,
  });
}
