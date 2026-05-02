# inception-webhooks

Phase 4 of the Inception Emails integration. One Express service that handles
two webhook surfaces:

- **`POST /webhooks/stripe`** — `checkout.session.completed` /
  `customer.subscription.deleted` / `invoice.payment_failed` from the Loving
  Awareness Stripe account → updates GHL contact + tags + opportunity.
- **`POST /webhooks/calendly`** — `invitee.created` / `invitee.canceled` from
  Kashi's Calendly account → updates GHL contact + tags + opportunity.

GHL writes go through `@inception-emails/ghl-client` (Phase 2). One extra
custom field (`stripe_customer_id`) is written via a thin direct call because
v0.1.0 of the client doesn't know about it yet — this should fold into v0.2.

See `INTEGRATION-SOURCE-OF-TRUTH.md` §2.2 / §6 / §8 / §9 (entries on
2026-05-02) for the full story.

## Run locally

```bash
cp .env.example .env  # then fill in real values
npm install
npm test                 # unit tests (no network)
INTEGRATION=1 npm run test:integration  # gated; hits live GHL sub-account
npm start
```

## Deploy

Railway auto-deploys from `main`. Three env vars are required at runtime:

- `GHL_LOCATION_API_KEY` — PIT for the Inception sub-account.
- `STRIPE_WEBHOOK_SECRET` — `whsec_…` from Stripe Dashboard → Developers →
  Webhooks → endpoint → Signing secret.
- `CALENDLY_WEBHOOK_SIGNING_KEY` — printed once by
  `scripts/setup-calendly-webhook.mjs`.

`STRIPE_API_KEY` is optional — only the deletion/payment-failed email-fallback
path uses it. Without it, lookup falls back to the `stripe_customer_id` custom
field only.

## Calendly webhook registration

```bash
CALENDLY_API_TOKEN=<personal-access-token> \
  node scripts/setup-calendly-webhook.mjs https://<railway-url>/webhooks/calendly
```

The script is idempotent — re-running it is safe and won't generate a new
signing key.
