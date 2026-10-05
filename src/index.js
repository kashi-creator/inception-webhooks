// Entrypoint. Wires the typed GHL client + the two routers into one Express
// service and listens on the Railway-injected PORT. Fails fast on missing env
// vars so a misconfigured Railway deploy crashes loud rather than silently
// dropping every webhook.

import Stripe from 'stripe';
import { createLogger } from './log.js';
import { readEnv } from './config.js';
import { createGhl } from './ghl.js';
import { createIdempotencyCache } from './idempotency.js';
import { createStripeRouter } from './stripe.js';
import { createCalendlyRouter } from './calendly.js';
import { createApp } from './app.js';

function main() {
  const log = createLogger();
  const env = readEnv();
  if (env.missing.length > 0) {
    log.error('boot.missing_env', { err: env.missing.join(',') });
    process.exit(1);
  }

  const ghl = createGhl({ pit: env.pit });

  // The Stripe SDK constructor requires a string key, but webhook signature
  // verification (constructEvent) makes no HTTP calls — it's pure HMAC. So
  // we instantiate one client purely for `webhooks.constructEvent`, and a
  // SECOND client (only if STRIPE_API_KEY is set) for the deletion-handler
  // fallback that calls `customers.retrieve`. Keeping the two roles separate
  // makes the missing-API-key case explicit instead of "everything 401s".
  const stripeClient = new Stripe(env.stripeApiKey || 'sk_webhook_verify_only', {
    apiVersion: '2024-11-20.acacia',
  });
  const stripeApi = env.stripeApiKey ? stripeClient : null;
  if (!stripeApi) {
    log.warn('boot.stripe_api_key_missing', {
      err: 'STRIPE_API_KEY unset — subscription_deleted/payment_failed email fallback disabled',
    });
  }

  // Both halves share one cache. Keys are namespaced (Stripe event.id vs
  // Calendly created_at|invitee.uri) so collisions are not a concern.
  const idempotencyCache = createIdempotencyCache();

  const stripeRouter = createStripeRouter({
    ghl,
    stripeClient,
    stripeApi,
    idempotencyCache,
    log,
    secret: env.stripeWebhookSecret,
  });
  const calendlyRouter = createCalendlyRouter({
    ghl,
    idempotencyCache,
    log,
    signingKey: env.calendlyWebhookSigningKey,
    allowedEventTypes: env.calendlyAllowedEventTypes,
  });
  const app = createApp({ stripeRouter, calendlyRouter, log });

  app.listen(env.port, () => {
    log.info('boot.listening', { route: `:${env.port}`, ok: true });
  });
}

main();
