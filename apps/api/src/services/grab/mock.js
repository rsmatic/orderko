import crypto from 'node:crypto';
import { config } from '../../config.js';

/**
 * A local stand-in for GrabExpress. It returns the same shapes as the live
 * provider and walks a booking through allocating -> picking_up -> in_delivery
 * -> completed on a timer, pushing each transition into the same webhook
 * handler the real Grab would call.
 *
 * State lives in memory, so restarting the API stops in-flight simulations.
 * Bookings already written to the `deliveries` table are unaffected.
 */

const bookings = new Map();

const DRIVERS = [
  { name: 'Hafiz R.',   phone: '+60198887766', plate: 'WXY 4412' },
  { name: 'Siti N.',    phone: '+60177665544', plate: 'VBN 8821' },
  { name: 'Kumar S.',   phone: '+60163344221', plate: 'WA 6390 C' },
  { name: 'Wei Lin T.', phone: '+60122119988', plate: 'BMT 1173' },
];

const FLOW = ['allocating', 'picking_up', 'in_delivery', 'completed'];

const DESCRIPTIONS = {
  allocating: 'Looking for a nearby driver',
  picking_up: 'Driver is on the way to the shop',
  in_delivery: 'Order collected, heading to you',
  completed: 'Delivered',
  cancelled: 'Booking cancelled',
};

const id = (prefix) => `${prefix}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

/** Straight-line distance in km. Good enough to fake a delivery fee. */
export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function feeForDistance(km) {
  const base = 5.0;      // flag-down
  const perKm = 1.2;
  return Math.round((base + Math.max(0, km - 1) * perKm) * 100) / 100;
}

/** Nudges a point a fraction of the way toward another, for fake GPS. */
function lerpPoint(from, to, t) {
  return {
    lat: Number((from.lat + (to.lat - from.lat) * t).toFixed(7)),
    lng: Number((from.lng + (to.lng - from.lng) * t).toFixed(7)),
  };
}

export function createMockProvider({ onEvent }) {
  // `onEvent` persists the transition, so it has to finish before a caller
  // reads the delivery back — otherwise an advance-then-read returns the
  // previous status.
  async function advance(bookingId) {
    const b = bookings.get(bookingId);
    if (!b || b.terminal) return;

    const nextIndex = FLOW.indexOf(b.status) + 1;
    const next = FLOW[nextIndex];
    if (!next) return;

    b.status = next;
    b.updatedAt = new Date();

    if (next === 'picking_up') {
      b.driver = DRIVERS[Math.floor(Math.random() * DRIVERS.length)];
      b.driverPos = lerpPoint(b.dropoff, b.pickup, 0.6);
    } else if (next === 'in_delivery') {
      b.driverPos = { ...b.pickup };
    } else if (next === 'completed') {
      b.driverPos = { ...b.dropoff };
      b.terminal = true;
    }

    await onEvent?.({
      provider_delivery_id: b.id,
      status: next,
      description: DESCRIPTIONS[next],
      driver: b.driver ?? null,
      location: b.driverPos ?? null,
      raw: { source: 'mock', bookingId: b.id, status: next },
    });

    if (!b.terminal) {
      b.timer = setTimeout(
        () => { advance(bookingId).catch((err) => console.error('[grab-mock]', err)); },
        config.grab.mockTickSeconds * 1000,
      );
      b.timer.unref?.();
    }
  }

  return {
    name: 'grab-mock',

    async quote({ pickup, dropoff }) {
      const km = Math.max(0.4, haversineKm(pickup, dropoff));
      const fee = feeForDistance(km);
      return {
        quote_id: id('QUO'),
        fee,
        currency: 'MYR',
        distance_km: Math.round(km * 100) / 100,
        eta_minutes: Math.max(12, Math.round(km * 4 + 10)),
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
    },

    async book({ quote, pickup, dropoff, orderNumber }) {
      const bookingId = id('GRB');
      const booking = {
        id: bookingId,
        status: 'allocating',
        pickup,
        dropoff,
        fee: quote.fee,
        orderNumber,
        driver: null,
        driverPos: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        terminal: false,
      };
      bookings.set(bookingId, booking);

      booking.timer = setTimeout(
        () => { advance(bookingId).catch((err) => console.error('[grab-mock]', err)); },
        config.grab.mockTickSeconds * 1000,
      );
      booking.timer.unref?.();

      return {
        provider_delivery_id: bookingId,
        status: 'allocating',
        fee: quote.fee,
        currency: 'MYR',
        distance_km: quote.distance_km,
        tracking_url: `${config.publicBaseUrl}/api/delivery/track/${bookingId}`,
        pickup_eta: new Date(Date.now() + 8 * 60_000).toISOString(),
        dropoff_eta: new Date(Date.now() + (quote.eta_minutes ?? 25) * 60_000).toISOString(),
        raw: { source: 'mock', bookingId },
      };
    },

    async track(providerDeliveryId) {
      const b = bookings.get(providerDeliveryId);
      if (!b) return null;
      return {
        provider_delivery_id: b.id,
        status: b.status,
        driver: b.driver,
        location: b.driverPos,
        updated_at: b.updatedAt.toISOString(),
      };
    },

    async cancel(providerDeliveryId, reason) {
      const b = bookings.get(providerDeliveryId);
      if (!b) return { status: 'cancelled', note: 'Unknown booking' };
      clearTimeout(b.timer);
      b.status = 'cancelled';
      b.terminal = true;
      await onEvent?.({
        provider_delivery_id: b.id,
        status: 'cancelled',
        description: reason || DESCRIPTIONS.cancelled,
        raw: { source: 'mock', bookingId: b.id, reason },
      });
      return { status: 'cancelled' };
    },

    /** Test hook: jump a booking to its next state without waiting. */
    async _advance(providerDeliveryId) {
      const b = bookings.get(providerDeliveryId);
      if (!b) return null;
      clearTimeout(b.timer);
      await advance(providerDeliveryId);
      return this.track(providerDeliveryId);
    },
  };
}
