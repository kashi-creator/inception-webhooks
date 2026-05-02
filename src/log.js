// One-line JSON logger. Railway's log viewer parses JSON automatically; the shape
// is the contract that Phase 11 (monitoring) will key off, so keep it stable.
//
// Hard rule (SoT §10 + phase prompt §6.5): no secrets in logs ever. PIT, Stripe
// signing secret, Calendly signing key, Calendly API token must never leave
// process memory. Helpers below scrub email → domain so support can debug
// without exposing PII.

const SAFE_KEYS = new Set([
  'level', 'msg', 'route', 'event_type', 'event_id', 'contact_id',
  'email_domain', 'tier', 'pipeline', 'stage', 'latency_ms', 'ok', 'err',
  'idempotent_skip', 'invoice_id', 'subscription_id', 'stripe_customer_id',
  'invitee_uri', 'cancel_reason', 'payment_link', 'opportunity_id',
]);

export function emailDomain(email) {
  if (typeof email !== 'string') return undefined;
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : undefined;
}

function sanitize(rec) {
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    if (!SAFE_KEYS.has(k)) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

export function createLogger({ stream = process.stdout, now = () => new Date() } = {}) {
  function emit(level, msg, fields = {}) {
    const line = JSON.stringify({
      ts: now().toISOString(),
      level,
      msg,
      ...sanitize(fields),
    });
    stream.write(line + '\n');
  }
  return {
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}
