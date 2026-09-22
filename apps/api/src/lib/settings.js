import { query, execute } from '../db.js';

const DEFAULTS = {
  shop_name: 'Orderko Overnight Oats',
  currency: 'MYR',
  tax_rate: 0.06,
  pickup_address: '12 Jalan Kemuning, Bangsar, 59100 Kuala Lumpur',
  pickup_lat: 3.1298,
  pickup_lng: 101.6708,
  pickup_phone: '+60312345678',
  min_order_total: 12,
  delivery_enabled: true,
  order_lead_mins: 20,
};

let cache = null;
let cachedAt = 0;
const TTL_MS = 30_000;

/** All settings as a plain object, merged over defaults. Cached briefly. */
export async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < TTL_MS) return cache;

  const rows = await query('SELECT setting_key, setting_value FROM settings');
  const stored = {};
  for (const row of rows) {
    // mysql2 parses JSON columns already; strings arrive as strings.
    stored[row.setting_key] = row.setting_value;
  }
  cache = { ...DEFAULTS, ...stored };
  cachedAt = Date.now();
  return cache;
}

export async function getSetting(key) {
  const all = await getSettings();
  return all[key];
}

export async function setSettings(patch, description = null) {
  for (const [key, value] of Object.entries(patch)) {
    await execute(
      `INSERT INTO settings (setting_key, setting_value, description)
       VALUES (?, CAST(? AS JSON), ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [key, JSON.stringify(value), description],
    );
  }
  cache = null;
  return getSettings({ fresh: true });
}

/** Settings a customer is allowed to see. */
export function publicSettings(all) {
  return {
    shop_name: all.shop_name,
    currency: all.currency,
    tax_rate: Number(all.tax_rate),
    pickup_address: all.pickup_address,
    min_order_total: Number(all.min_order_total),
    delivery_enabled: Boolean(all.delivery_enabled),
    order_lead_mins: Number(all.order_lead_mins),
  };
}
