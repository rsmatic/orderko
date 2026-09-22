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
  { name: 'Jomar R.',   phone: '+639178887766', plate: 'NCR 4412' },
  { name: 'Liezl S.',   phone: '+639177665544', plate: 'ABC 8821' },
  { name: 'Ramon D.',   phone: '+639163344221', plate: 'NDF 6390' },
  { name: 'Katrina M.', phone: '+639172119988', plate: 'TYU 1173' },
];

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();

/** Flag-down plus distance, in pesos — roughly GrabExpress city rates. */
const feeForDistance = (km) => round2(55 + Math.max(0, km - 1) * 12);

export function createSimulatedDelivery({ publicBaseUrl = '' } = {}) {
  return {
    name: 'simulated',

    async quote({ pickup, dropoff }) {
      const km = Math.max(0.4, haversineKm(pickup, dropoff));
      return {
        quote_id: `QUO-${rand()}`,
        fee: feeForDistance(km),
        currency: 'PHP',
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
        currency: quote.currency ?? 'PHP',
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
