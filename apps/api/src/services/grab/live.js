import { config } from '../../config.js';
import { HttpError } from '../../middleware/errors.js';

/**
 * GrabExpress partner API client.
 *
 * Endpoints follow Grab's Deliveries API:
 *   POST   /v1/deliveries/quotes
 *   POST   /v1/deliveries
 *   GET    /v1/deliveries/{deliveryID}
 *   DELETE /v1/deliveries/{deliveryID}
 *
 * Grab's own status vocabulary is mapped onto ours in STATUS_MAP so the rest
 * of the app never sees provider-specific strings.
 */

export const STATUS_MAP = {
  QUEUEING: 'allocating',
  ALLOCATING: 'allocating',
  PENDING_PICKUP: 'picking_up',
  PICKING_UP: 'picking_up',
  PENDING_DROP_OFF: 'in_delivery',
  IN_DELIVERY: 'in_delivery',
  IN_RETURN: 'returned',
  RETURNED: 'returned',
  COMPLETED: 'completed',
  CANCELED: 'cancelled',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
};

export const mapStatus = (grabStatus) =>
  STATUS_MAP[String(grabStatus || '').toUpperCase()] ?? 'allocating';

let tokenCache = { value: null, expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.value;
  }
  const res = await fetch(config.grab.authUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: config.grab.clientId,
      client_secret: config.grab.clientSecret,
      grant_type: 'client_credentials',
      scope: 'grab_express.partner_deliveries',
    }),
  });
  if (!res.ok) {
    throw new HttpError(502, `Grab auth failed (${res.status})`, await res.text());
  }
  const body = await res.json();
  tokenCache = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return tokenCache.value;
}

async function grabFetch(path, { method = 'GET', body } = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${config.grab.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const payload = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new HttpError(
      res.status === 400 ? 400 : 502,
      payload?.reason || payload?.message || `Grab API error (${res.status})`,
      payload,
    );
  }
  return payload;
}

const toGrabAddress = (place) => ({
  address: place.address,
  keywords: place.keywords ?? undefined,
  coordinates: { latitude: place.lat, longitude: place.lng },
});

const toGrabContact = (contact) => ({
  firstName: contact.name,
  phone: contact.phone,
  smsEnabled: true,
});

export function createLiveProvider() {
  if (!config.grab.clientId || !config.grab.clientSecret) {
    throw new Error(
      'GRAB_MODE=live requires GRAB_CLIENT_ID and GRAB_CLIENT_SECRET. ' +
        'Set GRAB_MODE=mock to run without Grab credentials.',
    );
  }

  return {
    name: 'grab-live',

    async quote({ pickup, dropoff, packages }) {
      const payload = await grabFetch('/v1/deliveries/quotes', {
        method: 'POST',
        body: {
          serviceType: config.grab.serviceType,
          packages: packages ?? [
            { name: 'Overnight oats', quantity: 1, description: 'Chilled food order' },
          ],
          origin: toGrabAddress(pickup),
          destination: toGrabAddress(dropoff),
        },
      });

      const best = payload.quotes?.[0];
      if (!best) throw new HttpError(502, 'Grab returned no quotes for this address');

      return {
        quote_id: best.serviceQuota?.quoteID ?? best.quoteID ?? null,
        fee: Number(best.amount ?? best.estimatedTotalFare ?? 0) / 100,
        currency: best.currency?.code ?? 'MYR',
        distance_km: payload.distance ? Number(payload.distance) / 1000 : null,
        eta_minutes: best.estimatedTimeline?.completed
          ? Math.round(
              (new Date(best.estimatedTimeline.completed) - Date.now()) / 60_000,
            )
          : null,
        raw: payload,
      };
    },

    async book({ quote, pickup, dropoff, sender, recipient, orderNumber, packages }) {
      const payload = await grabFetch('/v1/deliveries', {
        method: 'POST',
        body: {
          merchantOrderID: orderNumber,
          serviceType: config.grab.serviceType,
          paymentMethod: 'CASHLESS',
          packages: packages ?? [
            { name: 'Overnight oats', quantity: 1, description: 'Chilled food order' },
          ],
          origin: toGrabAddress(pickup),
          destination: toGrabAddress(dropoff),
          sender: toGrabContact(sender),
          recipient: toGrabContact(recipient),
          quoteID: quote?.quote_id ?? undefined,
        },
      });

      return {
        provider_delivery_id: payload.deliveryID,
        status: mapStatus(payload.status),
        fee: Number(payload.quote?.amount ?? 0) / 100,
        currency: payload.quote?.currency?.code ?? 'MYR',
        distance_km: null,
        tracking_url: payload.trackingURL ?? null,
        pickup_eta: payload.timeline?.pickup ?? null,
        dropoff_eta: payload.timeline?.dropoff ?? null,
        raw: payload,
      };
    },

    async track(providerDeliveryId) {
      const payload = await grabFetch(`/v1/deliveries/${providerDeliveryId}`);
      const courier = payload.courier ?? {};
      return {
        provider_delivery_id: payload.deliveryID,
        status: mapStatus(payload.status),
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
        tracking_url: payload.trackingURL ?? null,
        updated_at: new Date().toISOString(),
        raw: payload,
      };
    },

    async cancel(providerDeliveryId) {
      await grabFetch(`/v1/deliveries/${providerDeliveryId}`, { method: 'DELETE' });
      return { status: 'cancelled' };
    },
  };
}
