// Env config + Stripe payment-link → tier mapping.
//
// Tier IDs come from SoT §2.3. The IDs the SoT records are the SUFFIX portion
// of the URL (`buy.stripe.com/<suffix>`). The Stripe Dashboard surfaces the
// matching `plink_…` IDs in webhook payloads. Both forms are recorded in this
// map so the handler tolerates either; lookup is a simple `===` chain.
//
// If a payload arrives with an unknown payment_link, the handler logs a warn
// and DEFAULTS to 'Starter' so the contact still gets created (per phase
// prompt §5a). A missing tier is recoverable by Kashi later; a missing contact
// is not.

export const TIER_BY_PAYMENT_LINK = Object.freeze({
  // Starter
  'plink_8x2aEQ2ct3tA66T2fagIo0k': 'Starter',
  '8x2aEQ2ct3tA66T2fagIo0k':       'Starter',
  // Accelerator
  'plink_9B6bIU3gxd4agLx4nigIo0j': 'Accelerator',
  '9B6bIU3gxd4agLx4nigIo0j':       'Accelerator',
  // Growth
  'plink_28E28k2ct7JQ52PcTOgIo0i': 'Growth',
  '28E28k2ct7JQ52PcTOgIo0i':       'Growth',
  // Enterprise
  'plink_bJe28k6sJd4a7aX5rmgIo0h': 'Enterprise',
  'bJe28k6sJd4a7aX5rmgIo0h':       'Enterprise',
});

export const DEFAULT_TIER = 'Starter';

const MSP_GROWTH_CALL_EVENT_TYPE = 'https://api.calendly.com/event_types/7f993982-4878-4966-bc79-4be32a0346b1';

export function tierForPaymentLink(paymentLinkId) {
  if (!paymentLinkId) return { tier: DEFAULT_TIER, fallback: true };
  const tier = TIER_BY_PAYMENT_LINK[paymentLinkId];
  return tier ? { tier, fallback: false } : { tier: DEFAULT_TIER, fallback: true };
}

export const LOCATION_ID = 'oPTc9Dv3gSsB3uQmYdBd';

// New custom field added in Phase 4 bootstrap re-run 2026-05-02. The published
// @inception-emails/ghl-client@0.1.0 doesn't know about this field (its typed
// `setCustomFields` would throw on the unknown key); we write it via the
// extension in src/ghl.js. v0.2 of the client should fold this in.
export const STRIPE_CUSTOMER_ID_FIELD = Object.freeze({
  key: 'stripe_customer_id',
  id:  'EmjJw4lXxDotA5OkQscO',
});

export function readEnv(env = process.env) {
  const required = ['GHL_LOCATION_API_KEY', 'STRIPE_WEBHOOK_SECRET', 'CALENDLY_WEBHOOK_SIGNING_KEY'];
  const missing = required.filter((k) => !env[k]);
  return {
    pit: env.GHL_LOCATION_API_KEY,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
    calendlyWebhookSigningKey: env.CALENDLY_WEBHOOK_SIGNING_KEY,
    // Only these Calendly event types feed GHL. Default: "MSP Growth Call".
    calendlyAllowedEventTypes: (env.CALENDLY_ALLOWED_EVENT_TYPES || MSP_GROWTH_CALL_EVENT_TYPE)
      .split(',').map((s) => s.trim()).filter(Boolean),
    // Optional. If absent, the deletion/payment-failed email fallback (which
    // calls Stripe's customers API to recover an email) is skipped — primary
    // lookup by stripe_customer_id custom field is unaffected.
    stripeApiKey: env.STRIPE_API_KEY || null,
    port: Number(env.PORT) || 3000,
    nodeEnv: env.NODE_ENV || 'production',
    missing,
  };
}
