#!/usr/bin/env node
// One-shot script to register the Calendly webhook subscription that points
// at this service's `/webhooks/calendly` endpoint.
//
// Usage:
//   CALENDLY_API_TOKEN=<personal-access-token> \
//     node scripts/setup-calendly-webhook.mjs https://<railway-url>/webhooks/calendly
//
// Idempotent: lists existing user-scoped subscriptions and skips creation if
// one already targets the same callback URL. The signing_key is generated
// CLIENT-SIDE (32 random hex bytes) so we can stash it locally in stable form
// before sending it to Calendly. Calendly stores whatever we give it; that's
// the documented contract. Generating client-side avoids the case where
// Calendly silently rotates the key on us mid-deploy.
//
// Output: prints the signing_key ONCE on creation. Kashi pastes it into
// Railway env as CALENDLY_WEBHOOK_SIGNING_KEY. Never logged again.

import { randomBytes } from 'node:crypto';

const CALENDLY_API = 'https://api.calendly.com';

const TOKEN = process.env.CALENDLY_API_TOKEN;
if (!TOKEN) {
  console.error('Missing CALENDLY_API_TOKEN env var.');
  console.error('Get one at https://calendly.com/integrations/api_webhooks');
  process.exit(1);
}

const callbackUrl = process.argv[2];
if (!callbackUrl || !/^https?:\/\//.test(callbackUrl)) {
  console.error('Usage: node scripts/setup-calendly-webhook.mjs <https-callback-url>');
  console.error('Example: node scripts/setup-calendly-webhook.mjs https://inception-webhooks.up.railway.app/webhooks/calendly');
  process.exit(1);
}

async function calendly(path, init = {}) {
  const res = await fetch(`${CALENDLY_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const err = new Error(`Calendly ${init.method || 'GET'} ${path} → ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function main() {
  // Resolve the user URI (also gives us organization).
  const me = await calendly('/users/me');
  const userUri = me && me.resource && me.resource.uri;
  const orgUri = me && me.resource && me.resource.current_organization;
  if (!userUri || !orgUri) {
    console.error('Could not resolve user/organization from /users/me:', JSON.stringify(me, null, 2));
    process.exit(1);
  }
  console.log(`User: ${userUri}`);
  console.log(`Org:  ${orgUri}`);

  // Idempotency: list existing subscriptions for this user, skip if URL matches.
  const list = await calendly(`/webhook_subscriptions?organization=${encodeURIComponent(orgUri)}&user=${encodeURIComponent(userUri)}&scope=user`);
  const existing = (list && list.collection) || [];
  const matching = existing.find((sub) => sub.callback_url === callbackUrl);
  if (matching) {
    console.log('');
    console.log('A webhook subscription with this callback URL is already registered:');
    console.log(`  uri: ${matching.uri}`);
    console.log(`  callback_url: ${matching.callback_url}`);
    console.log(`  events: ${(matching.events || []).join(', ')}`);
    console.log(`  state: ${matching.state}`);
    console.log('');
    console.log('NOT recreating. The original signing_key is the source of truth.');
    console.log('If lost, delete this subscription in Calendly and re-run.');
    return;
  }

  const signingKey = randomBytes(32).toString('hex');

  const created = await calendly('/webhook_subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      url: callbackUrl,
      events: ['invitee.created', 'invitee.canceled'],
      organization: orgUri,
      user: userUri,
      scope: 'user',
      signing_key: signingKey,
    }),
  });

  const sub = (created && created.resource) || {};
  console.log('');
  console.log('Calendly webhook subscription created:');
  console.log(`  uri: ${sub.uri || '(unknown)'}`);
  console.log(`  callback_url: ${sub.callback_url || callbackUrl}`);
  console.log(`  events: ${(sub.events || ['invitee.created', 'invitee.canceled']).join(', ')}`);
  console.log('');
  console.log('==============================================================');
  console.log('  CALENDLY_WEBHOOK_SIGNING_KEY = ' + signingKey);
  console.log('==============================================================');
  console.log('');
  console.log('Paste the line above into Railway env as CALENDLY_WEBHOOK_SIGNING_KEY,');
  console.log('then redeploy. This is the ONLY time the key will be printed.');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  if (err && err.body) console.error('body:', JSON.stringify(err.body, null, 2));
  process.exit(1);
});
