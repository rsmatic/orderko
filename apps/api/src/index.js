import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { ping } from './db.js';
import { attachUser } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import authRoutes from './routes/auth.js';
import catalogRoutes from './routes/catalog.js';
import orderRoutes from './routes/orders.js';
import adminRoutes from './routes/admin.js';
import deliveryRoutes, { webhookRouter } from './routes/delivery.js';

const app = express();

app.disable('x-powered-by');
app.use(cors({ origin: config.cors.origin, credentials: true }));

// Webhooks need the raw body for signature checks, so they are mounted
// ahead of the JSON parser.
app.use('/api/webhooks', webhookRouter);

app.use(express.json({ limit: '256kb' }));
app.use(attachUser);

app.get('/api/health', async (req, res) => {
  try {
    await ping();
    res.json({ ok: true, db: 'up', grab_mode: config.grab.mode, env: config.env });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'down', error: err.message });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/delivery', deliveryRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port} (grab: ${config.grab.mode})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

export default app;
