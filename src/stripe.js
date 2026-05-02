// Stripe webhook handler.
//
// Three events from the Loving Awareness LLC Stripe account (live mode):
//   - checkout.session.completed   → upsert + tier tag + active-client + Won opp
//   - customer.subscription.deleted → tag stage:churned + clear active-client
//   - invoice.payment_failed       → tag engagement:cold + note (Phase 12 dunning later)
//
// Routing contract (phase prompt §6.1, §6.3):
//   1. Verify Stripe-Signature against the raw body. Reject 400 on failure.
//   2. ACK 200 immediately so Stripe doesn't retry on slow GHL.
//   3. Idempotency check on event.id; skip GHL writes on duplicate.
//   4. Dispatch to handler. GHL write failures are logged, never re-thrown to
//      Stripe — the response is already sent.

import express from 'express';
import { tierForPaymentLink } from './config.js';
import { emailDomain } from './log.js';

function splitName(name) {
  if (!name) return { firstName: undefined, lastName: undefined };
  const idx = name.indexOf(' ');
  if (idx < 0) return { firstName: name, lastName: undefined };
  return { firstName: name.slice(0, idx), lastName: name.slice(idx + 1) };
}

export function createStripeRouter({ ghl, stripeClient, idempotencyCache, log, secret, stripeApi }) {
  if (!ghl) throw new Error('createStripeRouter: ghl required');
  if (!stripeClient) throw new Error('createStripeRouter: stripeClient required');
  if (!idempotencyCache) throw new Error('createStripeRouter: idempotencyCache required');
  if (!log) throw new Error('createStripeRouter: log required');
  if (!secret) throw new Error('createStripeRouter: secret required');

  const router = express.Router();

  // Per phase prompt §4: raw body parser scoped to THIS route only — Stripe
  // signature verification needs the exact bytes.
  router.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const t0 = Date.now();
    let event;
    try {
      event = stripeClient.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        secret,
      );
    } catch (err) {
      log.warn('stripe.signature_failed', {
        route: '/webhooks/stripe',
        err: err && err.message ? err.message : String(err),
        latency_ms: Date.now() - t0,
      });
      return res.status(400).send('signature verification failed');
    }

    // Idempotency check BEFORE 200 — a duplicate event still gets 200, but we
    // skip the GHL writes.
    const seen = idempotencyCache.seen(event.id);
    res.status(200).json({ received: true });

    if (seen) {
      log.info('stripe.idempotent_skip', {
        route: '/webhooks/stripe',
        event_id: event.id,
        event_type: event.type,
        idempotent_skip: true,
        latency_ms: Date.now() - t0,
      });
      return;
    }
    idempotencyCache.record(event.id);

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutCompleted({ ghl, log, event, t0 });
          break;
        case 'customer.subscription.deleted':
          await handleSubscriptionDeleted({ ghl, stripeApi: stripeApi || stripeClient, log, event, t0 });
          break;
        case 'invoice.payment_failed':
          await handleInvoicePaymentFailed({ ghl, stripeApi: stripeApi || stripeClient, log, event, t0 });
          break;
        default:
          log.info('stripe.event_ignored', {
            route: '/webhooks/stripe',
            event_id: event.id,
            event_type: event.type,
            latency_ms: Date.now() - t0,
          });
      }
    } catch (err) {
      // Logged not re-thrown — response is already 200. Phase 11 monitoring
      // tails for `level=error` + `route=/webhooks/stripe` to alert.
      log.error('stripe.handler_failed', {
        route: '/webhooks/stripe',
        event_id: event.id,
        event_type: event.type,
        ok: false,
        err: err && err.message ? err.message : String(err),
        latency_ms: Date.now() - t0,
      });
    }
  });

  return router;
}

async function handleCheckoutCompleted({ ghl, log, event, t0 }) {
  const session = event.data.object;
  const email = session.customer_details && session.customer_details.email;
  if (!email) {
    log.warn('stripe.checkout_completed.missing_email', {
      route: '/webhooks/stripe',
      event_id: event.id,
      event_type: event.type,
    });
    return;
  }

  const { firstName, lastName } = splitName(session.customer_details && session.customer_details.name);
  const { tier, fallback } = tierForPaymentLink(session.payment_link);
  if (fallback) {
    log.warn('stripe.checkout_completed.unknown_payment_link', {
      route: '/webhooks/stripe',
      event_id: event.id,
      event_type: event.type,
      payment_link: session.payment_link || 'missing',
      tier,
    });
  }

  const { contactId } = await ghl.upsertContact({
    email,
    firstName,
    lastName,
    source: 'src:checkout',
  });

  await ghl.addTags(contactId, [`tier:${tier.toLowerCase()}`, 'stage:active-client']);
  await ghl.setCustomFields(contactId, { tier });

  const stripeCustomerId = typeof session.customer === 'string' ? session.customer : session.customer && session.customer.id;
  if (stripeCustomerId) {
    await ghl.setStripeCustomerId(contactId, stripeCustomerId);
  }

  const opp = await ghl.createOpportunity({
    pipeline: 'sales',
    stage: 'Won',
    contactId,
    monetaryValue: typeof session.amount_total === 'number' ? session.amount_total / 100 : undefined,
    name: `${tier} — ${email}`,
    status: 'won',
  });

  log.info('stripe.checkout_completed.ok', {
    route: '/webhooks/stripe',
    event_id: event.id,
    event_type: event.type,
    contact_id: contactId,
    email_domain: emailDomain(email),
    tier,
    payment_link: session.payment_link,
    opportunity_id: opp && opp.opportunityId,
    stripe_customer_id: stripeCustomerId,
    ok: true,
    latency_ms: Date.now() - t0,
  });
}

async function findContactForCustomer({ ghl, stripeApi, customerId, log, event }) {
  if (!customerId) return null;
  // Primary: search by stripe_customer_id custom field.
  try {
    const contact = await ghl.findContactByStripeCustomerId(customerId);
    if (contact) return contact;
  } catch (err) {
    log.warn('stripe.customer_lookup.search_failed', {
      route: '/webhooks/stripe',
      event_id: event.id,
      event_type: event.type,
      stripe_customer_id: customerId,
      err: err && err.message ? err.message : String(err),
    });
  }
  // Fallback: fetch the Stripe customer's email and look up by email. Costs
  // one extra Stripe API call but recovers contacts created before the
  // stripe_customer_id field was populated. Skipped if STRIPE_API_KEY is not
  // configured (boot logged this as a warn).
  if (!stripeApi) return null;
  try {
    const customer = await stripeApi.customers.retrieve(customerId);
    const email = customer && customer.email;
    if (!email) return null;
    return await ghl.findContactByEmail(email);
  } catch (err) {
    log.warn('stripe.customer_lookup.email_failed', {
      route: '/webhooks/stripe',
      event_id: event.id,
      event_type: event.type,
      stripe_customer_id: customerId,
      err: err && err.message ? err.message : String(err),
    });
    return null;
  }
}

async function handleSubscriptionDeleted({ ghl, stripeApi, log, event, t0 }) {
  const sub = event.data.object;
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer && sub.customer.id;
  const contact = await findContactForCustomer({ ghl, stripeApi, customerId, log, event });
  if (!contact) {
    log.warn('stripe.subscription_deleted.contact_not_found', {
      route: '/webhooks/stripe',
      event_id: event.id,
      event_type: event.type,
      stripe_customer_id: customerId,
      subscription_id: sub.id,
    });
    return;
  }
  await ghl.addTags(contact.id, ['stage:churned']);
  await ghl.removeTags(contact.id, ['stage:active-client']);
  log.info('stripe.subscription_deleted.ok', {
    route: '/webhooks/stripe',
    event_id: event.id,
    event_type: event.type,
    contact_id: contact.id,
    email_domain: emailDomain(contact.email),
    subscription_id: sub.id,
    stripe_customer_id: customerId,
    ok: true,
    latency_ms: Date.now() - t0,
  });
}

async function handleInvoicePaymentFailed({ ghl, stripeApi, log, event, t0 }) {
  const invoice = event.data.object;
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer && invoice.customer.id;
  const contact = await findContactForCustomer({ ghl, stripeApi, customerId, log, event });
  if (!contact) {
    log.warn('stripe.invoice_payment_failed.contact_not_found', {
      route: '/webhooks/stripe',
      event_id: event.id,
      event_type: event.type,
      stripe_customer_id: customerId,
      invoice_id: invoice.id,
    });
    return;
  }
  await ghl.addTags(contact.id, ['engagement:cold']);
  log.info('stripe.invoice_payment_failed.ok', {
    route: '/webhooks/stripe',
    event_id: event.id,
    event_type: event.type,
    contact_id: contact.id,
    email_domain: emailDomain(contact.email),
    invoice_id: invoice.id,
    stripe_customer_id: customerId,
    ok: true,
    latency_ms: Date.now() - t0,
  });
}
