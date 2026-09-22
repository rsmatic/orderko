import express from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { queryOne } from '../db.js';
import { requireRole, isStaff } from '../middleware/auth.js';
import { asyncHandler, forbidden, notFound, badRequest } from '../middleware/errors.js';
import { audit } from '../lib/audit.js';
import {
  quoteDelivery,
  bookDelivery,
  cancelDelivery,
  refreshDelivery,
  getDeliveryForOrder,
  getProvider,
  recordEvent,
} from '../services/grab/index.js';

const router = express.Router();

/** Fee estimate for an address. Open to guests — checkout needs it. */
router.post(
  '/quote',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        address: z.string().min(4).max(500),
        lat: z.coerce.number().min(-90).max(90),
        lng: z.coerce.number().min(-180).max(180),
      })
      .parse(req.body);
    res.json(await quoteDelivery(body));
  }),
);

/** Book a Grab driver for an order. Staff only. */
router.post(
  '/orders/:orderId/book',
  requireRole('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.orderId);
    const { delivery, reused } = await bookDelivery(orderId, { actorId: req.user.id });
    if (!reused) await audit(req.user, 'delivery.book', 'order', orderId);
    res.status(reused ? 200 : 201).json({ delivery, reused });
  }),
);

router.post(
  '/orders/:orderId/cancel',
  requireRole('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.orderId);
    const reason = z.string().max(255).optional().parse(req.body?.reason);
    const delivery = await cancelDelivery(orderId, reason, req.user.id);
    await audit(req.user, 'delivery.cancel', 'order', orderId, { reason });
    res.json({ delivery });
  }),
);

/** Live status for an order's delivery. Customers may poll their own. */
router.get(
  '/orders/:orderId',
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.orderId);
    const order = await queryOne('SELECT id, customer_id FROM orders WHERE id = ?', [orderId]);
    if (!order) throw notFound('Order not found');
    if (!isStaff(req.user) && order.customer_id !== req.user?.id) {
      throw forbidden('That is not your order');
    }

    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const delivery = refresh
      ? await refreshDelivery(orderId).catch(() => getDeliveryForOrder(orderId))
      : await getDeliveryForOrder(orderId);

    if (!delivery) return res.json({ delivery: null });
    res.json({ delivery });
  }),
);

/**
 * Stand-in for Grab's own tracking page, so the mock provider has somewhere
 * to point `tracking_url` at.
 */
router.get(
  '/track/:providerDeliveryId',
  asyncHandler(async (req, res) => {
    const delivery = await queryOne(
      `SELECT d.provider_delivery_id, d.status, d.driver_name, d.driver_plate,
              d.driver_lat, d.driver_lng, d.dropoff_eta, o.order_number
         FROM deliveries d JOIN orders o ON o.id = d.order_id
        WHERE d.provider_delivery_id = ?`,
      [req.params.providerDeliveryId],
    );
    if (!delivery) throw notFound('Unknown tracking id');
    res.json(delivery);
  }),
);

/**
 * Development helper: push the mock driver to its next state immediately
 * instead of waiting for the timer. Disabled when GRAB_MODE=live.
 */
router.post(
  '/simulate/:orderId/advance',
  requireRole('admin', 'manager'),
  asyncHandler(async (req, res) => {
    if (config.grab.mode === 'live') {
      throw badRequest('Simulation is only available with GRAB_MODE=mock');
    }
    const delivery = await getDeliveryForOrder(Number(req.params.orderId));
    if (!delivery) throw notFound('No delivery booked for this order');

    await getProvider()._advance(delivery.provider_delivery_id);
    res.json({ delivery: await getDeliveryForOrder(Number(req.params.orderId)) });
  }),
);

export default router;

// ---------------------------------------------------------------- webhook

export const webhookRouter = express.Router();

/**
 * Grab posts delivery status changes here. The signature check runs against
 * the raw body, so this route is mounted before the JSON body parser in
 * index.js and parses the payload itself.
 */
webhookRouter.post(
  '/grab',
  express.raw({ type: '*/*', limit: '256kb' }),
  asyncHandler(async (req, res) => {
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

    const { mapStatus } = await import('../services/grab/live.js');
    const deliveryId = payload.deliveryID ?? payload.delivery_id;
    if (!deliveryId) return res.status(400).json({ error: 'Missing deliveryID' });

    const courier = payload.courier ?? {};
    const matched = await recordEvent({
      provider_delivery_id: deliveryId,
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

    // Always 200 for unknown ids, so Grab does not retry forever.
    res.json({ received: true, matched: Boolean(matched) });
  }),
);
