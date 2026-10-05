// Express app factory. Kept separate from index.js so tests can construct an
// app instance without spinning up an HTTP listener.

import express from 'express';

export function createApp({ stripeRouter, calendlyRouter, phoneburnerRouter, log }) {
  const app = express();

  // Liveness probe — Railway hits this and decides whether to restart the
  // container. Intentionally cheap: no env-var checks, no GHL ping.
  app.get('/healthz', (_req, res) => res.status(200).type('text/plain').send('ok'));

  // The Stripe router brings its own raw-body parser scoped to its route. The
  // Calendly router does the same for JSON. Mount before any global parser.
  app.use(stripeRouter);
  app.use(calendlyRouter);
  if (phoneburnerRouter) app.use(phoneburnerRouter);

  app.use((err, _req, res, _next) => {
    if (log) log.error('express.unhandled', { err: err && err.message ? err.message : String(err) });
    res.status(500).send('internal error');
  });

  return app;
}
