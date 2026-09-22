import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { createBackend, AppError } from '@overnight-oats/core';
import { config } from './config.js';
import { createJsonStore } from './persistence.js';
import { auth, createDelivery } from './adapters.js';
import { mapStatus } from './grab-live.js';

const store = createJsonStore({
  file: config.dataFile,
  hashPassword: auth.hashPassword,
  seedPassword: config.seedPassword,
});

const { state, seeded } = await store.load();
const delivery = createDelivery();

const backend = createBackend({
  state,
  persist: store.persist,
  auth,
  delivery,
});

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: config.cors.origin, credentials: true }));

// ------------------------------------------------------------------ webhook

/**
 * Grab posts delivery updates here. The signature is checked against the raw
 * body, so this route is mounted ahead of the JSON parser and parses its own.
 */
app.post('/api/webhooks/grab', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  const raw = req.body instanceof Buffer ? req.body : Buffer.from('');

  if (config.grab.webhookSecret) {
    const signature = req.get('x-grab-signature') || req.get('x-signature') || '';
    const expected = crypto
      .createHmac('sha256', config.grab.webhookSecret)
      .update(raw)
      .digest('base64');
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Bad signature' });
    }
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    return res.status(400).json({ error: 'Body is not JSON' });
  }

  const providerDeliveryId = payload.deliveryID ?? payload.delivery_id;
  if (!providerDeliveryId) return res.status(400).json({ error: 'Missing deliveryID' });

  const courier = payload.courier ?? {};
  const matched = await backend.applyDeliveryEvent({
    providerDeliveryId,
    status: mapStatus(payload.status),
    description: payload.description ?? `Grab: ${payload.status}`,
    driver: courier.name
      ? {
          name: courier.name,
          phone: courier.phone,
          plate: courier.vehicle?.licensePlate,
          photo_url: courier.photoURL,
        }
      : null,
    location: courier.coordinates
      ? { lat: courier.coordinates.latitude, lng: courier.coordinates.longitude }
      : null,
    raw: payload,
  });

  // Always 200 on an unknown id, so Grab stops retrying.
  res.json({ received: true, matched: Boolean(matched) });
});

app.use(express.json({ limit: '256kb' }));

// ------------------------------------------------------------------- health

app.get('/api/health', (req, res) => {
  const db = backend.getState();
  res.json({
    ok: true,
    store: 'json',
    data_file: config.dataFile,
    orders: db.orders.length,
    grab_mode: config.grab.mode,
    env: config.env,
  });
});

/** Public stand-in for Grab's tracking page, which sim bookings point at. */
app.get('/api/delivery/track/:providerDeliveryId', (req, res) => {
  const db = backend.getState();
  const record = db.deliveries.find((d) => d.provider_delivery_id === req.params.providerDeliveryId);
  if (!record) return res.status(404).json({ error: 'Unknown tracking id' });
  const order = db.orders.find((o) => o.id === record.order_id);
  res.json({
    provider_delivery_id: record.provider_delivery_id,
    status: record.status,
    driver_name: record.driver_name,
    driver_plate: record.driver_plate,
    dropoff_eta: record.dropoff_eta,
    order_number: order?.order_number ?? null,
  });
});

// -------------------------------------------------------------- the backend

const bearer = (req) => {
  const header = req.get('authorization') || '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
};

app.all('/api/*', async (req, res) => {
  const path = req.originalUrl.slice('/api'.length);
  try {
    const { status, body } = await backend.handle(req.method, path, req.body, bearer(req));
    res.status(status).json(body);
  } catch (err) {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    console.error('[error]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` }));

// ------------------------------------------------------------- sim ticker

/**
 * Moves simulated deliveries along on a timer, so a customer watching the
 * tracking page sees progress without staff pressing Advance. Progress lives
 * in the store, so a restart resumes rather than stalling.
 */
function startSimTicker() {
  if (config.grab.mode === 'live' || config.grab.autoAdvanceSeconds <= 0) return null;

  const tick = async () => {
    try {
      const db = backend.getState();
      const active = db.deliveries.filter(
        (d) => !['completed', 'cancelled', 'failed', 'returned'].includes(d.status),
      );
      for (const record of active) {
        const next = await delivery.advance(record.provider_delivery_id, record.status);
        if (!next) continue;
        await backend.applyDeliveryEvent({
          providerDeliveryId: record.provider_delivery_id,
          status: next.status,
          description: next.description,
          driver: next.driver,
          location: next.location,
        });
      }
    } catch (err) {
      console.error('[sim]', err.message);
    }
  };

  const timer = setInterval(tick, config.grab.autoAdvanceSeconds * 1000);
  timer.unref?.();
  return timer;
}

const ticker = startSimTicker();

const server = app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
  console.log(`  store:  ${config.dataFile}${seeded ? '  (seeded)' : ''}`);
  console.log(`  grab:   ${config.grab.mode}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(ticker);
    server.close(async () => {
      // Flush the debounced write so the last order is not lost on shutdown.
      await store.flush();
      process.exit(0);
    });
  });
}

export default app;
