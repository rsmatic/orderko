/**
 * A stand-in for GrabExpress.
 *
 * It keeps no progress state of its own: `advance` is told the current status
 * and returns the next one, so the only record of an in-flight delivery is the
 * one already persisted. A restart therefore cannot lose a simulation, which
 * the previous timer-based version could.
 */

import { haversineKm, round2 } from './rules.js';

const FLOW = ['allocating', 'picking_up', 'in_delivery', 'completed'];

const DESCRIPTIONS = {
  allocating: 'Looking for a nearby driver',
  picking_up: 'Driver is on the way to the shop',
  in_delivery: 'Order collected, heading to you',
  completed: 'Delivered',
  cancelled: 'Booking cancelled',
};

const DRIVERS = [
  { name: 'Hafiz R.',   phone: '+60198887766', plate: 'WXY 4412' },
  { name: 'Siti N.',    phone: '+60177665544', plate: 'VBN 8821' },
  { name: 'Kumar S.',   phone: '+60163344221', plate: 'WA 6390 C' },
  { name: 'Wei Lin T.', phone: '+60122119988', plate: 'BMT 1173' },
];

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();

/** Flag-down plus distance, rounded to sen. */
const feeForDistance = (km) => round2(5.0 + Math.max(0, km - 1) * 1.2);

export function createSimulatedDelivery({ publicBaseUrl = '' } = {}) {
  return {
    name: 'simulated',

    async quote({ pickup, dropoff }) {
      const km = Math.max(0.4, haversineKm(pickup, dropoff));
      return {
        quote_id: `QUO-${rand()}`,
        fee: feeForDistance(km),
        currency: 'MYR',
        distance_km: round2(km),
        eta_minutes: Math.max(12, Math.round(km * 4 + 10)),
        provider: 'simulated',
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
    },

    async book({ quote }) {
      const id = `GRB-${rand()}`;
      return {
        provider: 'grab',
        provider_delivery_id: id,
        status: 'allocating',
        fee: quote.fee,
        currency: quote.currency ?? 'MYR',
        distance_km: quote.distance_km,
        tracking_url: publicBaseUrl ? `${publicBaseUrl}/api/delivery/track/${id}` : null,
        pickup_eta: new Date(Date.now() + 8 * 60_000).toISOString(),
        dropoff_eta: new Date(Date.now() + (quote.eta_minutes ?? 25) * 60_000).toISOString(),
        raw: { source: 'simulated', bookingId: id },
      };
    },

    /** Stateless: the caller supplies where the delivery currently is. */
    async advance(providerDeliveryId, currentStatus) {
      const next = FLOW[FLOW.indexOf(currentStatus) + 1];
      if (!next) return null;
      return {
        status: next,
        description: DESCRIPTIONS[next],
        driver: next === 'picking_up'
          ? DRIVERS[Math.floor(Math.random() * DRIVERS.length)]
          : null,
        location: null,
      };
    },

    async track() {
      // Progress only moves through `advance`, so there is nothing to poll.
      return null;
    },

    async cancel() {
      return { status: 'cancelled' };
    },
  };
}

export { FLOW as SIM_FLOW, DESCRIPTIONS as SIM_DESCRIPTIONS };
