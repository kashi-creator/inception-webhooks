// Tiny LRU + TTL cache for webhook event IDs.
//
// Stripe and Calendly both retry on 5xx and may deliver the same event 2-5
// times during a hiccup. This cache prevents duplicate GHL mutations on retry.
// Hard requirement (phase prompt §6.4): 1000 entries / ~5 min TTL.
//
// In-memory only — Railway restarts will clear it. That's acceptable for v0.1
// because both webhooks are at-least-once and the GHL writes are idempotent
// (upsertContact, addTags, setCustomFields are all safe to repeat). Phase 11
// monitoring should add Redis / a durable cache if duplicate-create rate
// becomes measurable.

export function createIdempotencyCache({ maxSize = 1000, ttlMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
  // Map preserves insertion order, so re-insertion implements LRU.
  const entries = new Map();

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [key, ts] of entries) {
      if (ts < cutoff) {
        entries.delete(key);
      } else {
        // Insertion order means once we hit a fresh entry, all later ones are
        // also fresh. Stop scanning.
        break;
      }
    }
  }

  return {
    /** Returns true if the key is fresh in the cache (already seen). */
    seen(key) {
      prune();
      const ts = entries.get(key);
      if (ts === undefined) return false;
      // Refresh recency on hit.
      entries.delete(key);
      entries.set(key, now());
      return true;
    },
    /** Records a key as seen now. Caller should call after `seen` returns false. */
    record(key) {
      prune();
      if (entries.has(key)) entries.delete(key);
      entries.set(key, now());
      while (entries.size > maxSize) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
      }
    },
    /** Test-only: number of live entries. */
    _size() {
      prune();
      return entries.size;
    },
  };
}
