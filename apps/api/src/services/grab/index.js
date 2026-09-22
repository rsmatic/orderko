import { config } from '../../config.js';
import { execute, query, queryOne } from '../../db.js';
import { getSettings } from '../../lib/settings.js';
import { notFound, badRequest } from '../../middleware/errors.js';
import { createMockProvider, haversineKm } from './mock.js';
import { createLiveProvider } from './live.js';

/** Delivery states that mean the driver is done, one way or another. */
const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'returned']);

/** How a delivery status pushes the parent order forward. */
const ORDER_STATUS_FOR = {
  picking_up: 'dispatched',
  in_delivery: 'dispatched',
  completed: 'delivered',
};

let provider;

/**
 * Persists an event coming from either provider and syncs the order.
 * The mock provider calls this on its timer; the live provider reaches it
 * through the webhook route.
 */
async function recordEvent(event) {
  const delivery = await queryOne(
    'SELECT id, order_id, status FROM deliveries WHERE provider_delivery_id = ?',
    [event.provider_delivery_id],
  );
  if (!delivery) return null;

  await execute(
    `UPDATE deliveries
        SET status = ?,
            driver_name  = COALESCE(?, driver_name),
            driver_phone = COALESCE(?, driver_phone),
            driver_plate = COALESCE(?, driver_plate),
            driver_photo_url = COALESCE(?, driver_photo_url),
            driver_lat   = COALESCE(?, driver_lat),
            driver_lng   = COALESCE(?, driver_lng),
            raw_payload  = ?
      WHERE id = ?`,
    [
      event.status,
      event.driver?.name ?? null,
      event.driver?.phone ?? null,
      event.driver?.plate ?? null,
      event.driver?.photo_url ?? null,
      event.location?.lat ?? null,
      event.location?.lng ?? null,
      event.raw ? JSON.stringify(event.raw) : null,
      delivery.id,
    ],
  );

  await execute(
    `INSERT INTO delivery_events (delivery_id, status, description, lat, lng, raw)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      delivery.id,
      event.status,
      event.description ?? null,
      event.location?.lat ?? null,
      event.location?.lng ?? null,
      event.raw ? JSON.stringify(event.raw) : null,
    ],
  );

  const nextOrderStatus = ORDER_STATUS_FOR[event.status];
  if (nextOrderStatus) {
    const order = await queryOne('SELECT id, status FROM orders WHERE id = ?', [
      delivery.order_id,
    ]);
    if (order && order.status !== nextOrderStatus && order.status !== 'cancelled') {
      await execute('UPDATE orders SET status = ? WHERE id = ?', [
        nextOrderStatus,
        order.id,
      ]);
      await execute(
        `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
         VALUES (?, ?, ?, NULL, ?)`,
        [order.id, order.status, nextOrderStatus, `Grab: ${event.status}`],
      );
    }
  }

  return delivery.id;
}

export function getProvider() {
  if (!provider) {
    provider =
      config.grab.mode === 'live'
        ? createLiveProvider()
        : createMockProvider({ onEvent: (e) => recordEvent(e).catch(console.error) });
  }
  return provider;
}

async function pickupPlace() {
  const s = await getSettings();
  return {
    address: s.pickup_address,
    lat: Number(s.pickup_lat),
    lng: Number(s.pickup_lng),
    phone: s.pickup_phone,
    name: s.shop_name,
  };
}

/** A fee estimate for the checkout screen. Does not book anything. */
export async function quoteDelivery({ address, lat, lng }) {
  if (lat == null || lng == null) {
    throw badRequest('Delivery quote needs a latitude and longitude');
  }
  const pickup = await pickupPlace();
  const quote = await getProvider().quote({
    pickup,
    dropoff: { address, lat: Number(lat), lng: Number(lng) },
  });
  return {
    ...quote,
    provider: config.grab.mode === 'live' ? 'grab' : 'grab-mock',
    straight_line_km:
      Math.round(
        haversineKm(pickup, { lat: Number(lat), lng: Number(lng) }) * 100,
      ) / 100,
  };
}

/** Books a driver for an order and stores the delivery row. */
export async function bookDelivery(orderId, { actorId = null } = {}) {
  const order = await queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) throw notFound('Order not found');
  if (order.fulfillment_type !== 'delivery') {
    throw badRequest('This order is for pickup, not delivery');
  }
  if (order.delivery_lat == null || order.delivery_lng == null) {
    throw badRequest('Order has no delivery coordinates');
  }
  if (order.status === 'cancelled') {
    throw badRequest('Order is cancelled');
  }

  const existing = await queryOne(
    `SELECT * FROM deliveries
      WHERE order_id = ? AND status NOT IN ('cancelled','failed')
      ORDER BY id DESC LIMIT 1`,
    [orderId],
  );
  if (existing && existing.provider_delivery_id) {
    return { delivery: existing, reused: true };
  }

  const pickup = await pickupPlace();
  const dropoff = {
    address: order.delivery_address,
    lat: Number(order.delivery_lat),
    lng: Number(order.delivery_lng),
  };

  const p = getProvider();
  const quote = await p.quote({ pickup, dropoff });
  const booking = await p.book({
    quote,
    pickup,
    dropoff,
    orderNumber: order.order_number,
    sender: { name: pickup.name, phone: pickup.phone },
    recipient: { name: order.contact_name, phone: order.contact_phone },
  });

  const result = await execute(
    `INSERT INTO deliveries
       (order_id, provider, provider_delivery_id, quote_id, status, fee, currency,
        distance_km, tracking_url, pickup_eta, dropoff_eta, raw_payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orderId,
      'grab',
      booking.provider_delivery_id,
      quote.quote_id ?? null,
      booking.status ?? 'allocating',
      booking.fee ?? 0,
      booking.currency ?? 'MYR',
      booking.distance_km ?? quote.distance_km ?? null,
      booking.tracking_url ?? null,
      booking.pickup_eta ? new Date(booking.pickup_eta) : null,
      booking.dropoff_eta ? new Date(booking.dropoff_eta) : null,
      booking.raw ? JSON.stringify(booking.raw) : null,
    ],
  );

  await execute(
    `INSERT INTO delivery_events (delivery_id, status, description)
     VALUES (?, ?, ?)`,
    [result.insertId, booking.status ?? 'allocating', 'Booking created'],
  );

  if (order.status !== 'dispatched') {
    await execute('UPDATE orders SET status = ? WHERE id = ?', ['dispatched', orderId]);
    await execute(
      `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
       VALUES (?, ?, 'dispatched', ?, 'Grab driver requested')`,
      [orderId, order.status, actorId],
    );
  }

  const delivery = await queryOne('SELECT * FROM deliveries WHERE id = ?', [
    result.insertId,
  ]);
  return { delivery, reused: false };
}

/** Latest delivery row for an order, with its event trail. */
export async function getDeliveryForOrder(orderId) {
  const delivery = await queryOne(
    'SELECT * FROM deliveries WHERE order_id = ? ORDER BY id DESC LIMIT 1',
    [orderId],
  );
  if (!delivery) return null;
  const events = await query(
    'SELECT status, description, lat, lng, created_at FROM delivery_events WHERE delivery_id = ? ORDER BY id ASC',
    [delivery.id],
  );
  return { ...delivery, events };
}

/**
 * Pulls fresh driver position/status from the provider. The mock advances on
 * its own timer, so this mostly matters for the live provider, where polling
 * backs up the webhook.
 */
export async function refreshDelivery(orderId) {
  const delivery = await getDeliveryForOrder(orderId);
  if (!delivery) throw notFound('No delivery booked for this order');
  if (TERMINAL.has(delivery.status)) return delivery;

  const live = await getProvider().track(delivery.provider_delivery_id);
  if (!live) return delivery;

  if (live.status !== delivery.status || live.location) {
    await recordEvent({
      provider_delivery_id: delivery.provider_delivery_id,
      status: live.status,
      description: 'Polled from provider',
      driver: live.driver,
      location: live.location,
      raw: live.raw ?? null,
    });
  }
  return getDeliveryForOrder(orderId);
}

export async function cancelDelivery(orderId, reason, actorId = null) {
  const delivery = await getDeliveryForOrder(orderId);
  if (!delivery) throw notFound('No delivery booked for this order');
  if (TERMINAL.has(delivery.status)) {
    throw badRequest(`Delivery is already ${delivery.status}`);
  }

  await getProvider().cancel(delivery.provider_delivery_id, reason);
  await execute('UPDATE deliveries SET status = ? WHERE id = ?', [
    'cancelled',
    delivery.id,
  ]);
  await execute(
    `INSERT INTO delivery_events (delivery_id, status, description) VALUES (?, 'cancelled', ?)`,
    [delivery.id, reason || 'Cancelled by staff'],
  );
  await execute(
    `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
     VALUES (?, ?, ?, ?, 'Grab booking cancelled')`,
    [orderId, 'dispatched', 'ready', actorId],
  );
  await execute(`UPDATE orders SET status = 'ready' WHERE id = ? AND status = 'dispatched'`, [
    orderId,
  ]);

  return getDeliveryForOrder(orderId);
}

export { recordEvent };
