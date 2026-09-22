/**
 * The shop's rules, with no storage or transport in sight.
 *
 * Everything here is a pure function over plain data, which is what lets the
 * same logic run behind the HTTP API and inside the browser demo.
 */

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Same shape the HTTP layer turns into a status code. */
export class AppError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.details = details;
  }
}

export const bad = (m, d) => new AppError(400, m, d);
export const unauthorized = (m = 'Not signed in') => new AppError(401, m);
export const forbidden = (m = 'Not allowed') => new AppError(403, m);
export const notFound = (m = 'Not found') => new AppError(404, m);
export const conflict = (m) => new AppError(409, m);

/** Which statuses staff may move an order into, from each state. */
export const TRANSITIONS = {
  pending:    ['confirmed', 'cancelled'],
  confirmed:  ['preparing', 'cancelled'],
  preparing:  ['ready', 'cancelled'],
  ready:      ['dispatched', 'completed', 'cancelled'],
  dispatched: ['delivered', 'cancelled'],
  delivered:  ['completed'],
  completed:  [],
  cancelled:  [],
};

export const ORDER_STATUSES = Object.keys(TRANSITIONS);

/** Delivery states that mean the driver is done, one way or another. */
export const TERMINAL_DELIVERY = new Set(['completed', 'cancelled', 'failed', 'returned']);

/** How a delivery status pushes the parent order forward. */
export const ORDER_STATUS_FOR_DELIVERY = {
  picking_up: 'dispatched',
  in_delivery: 'dispatched',
  completed: 'delivered',
};

export const isStaff = (user) => user?.role === 'admin' || user?.role === 'manager';

export const publicUser = (u) =>
  u && { id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role };

export const slugify = (s) =>
  String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 150);

/**
 * Re-prices a cart from the catalog. Callers pass ids and quantities only —
 * a price that arrived from a client is never trusted.
 *
 * @param {object} db      the state object
 * @param {Array}  items   [{ product_id, quantity, option_ids, notes }]
 */
export function priceCart(db, items) {
  if (!Array.isArray(items) || items.length === 0) throw bad('Cart is empty');

  const priced = [];
  let subtotal = 0;

  for (const raw of items) {
    const product = db.products.find((p) => p.id === Number(raw.product_id));
    if (!product) throw bad(`Product ${raw.product_id} does not exist`);
    if (!product.is_active) throw bad(`"${product.name}" is not available right now`);

    const quantity = Number.parseInt(raw.quantity, 10);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
      throw bad(`Quantity for "${product.name}" must be between 1 and 50`);
    }
    if (product.track_stock && product.stock_qty < quantity) {
      throw bad(`Only ${product.stock_qty} left of "${product.name}"`);
    }

    const allowedGroupIds = new Set(
      db.productOptionGroups.filter((l) => l.product_id === product.id).map((l) => l.group_id),
    );
    const chosen = [];
    const countByGroup = new Map();

    for (const optionId of raw.option_ids ?? []) {
      const opt = db.options.find((o) => o.id === Number(optionId));
      if (!opt) throw bad(`Option ${optionId} does not exist`);
      const group = db.optionGroups.find((g) => g.id === opt.group_id);
      if (!opt.is_available || !group?.is_active) throw bad(`"${opt.name}" is sold out`);
      if (!allowedGroupIds.has(opt.group_id)) {
        throw bad(`"${opt.name}" cannot be added to "${product.name}"`);
      }
      if (opt.track_stock && opt.stock_qty < quantity) throw bad(`Not enough "${opt.name}" left`);

      countByGroup.set(opt.group_id, (countByGroup.get(opt.group_id) ?? 0) + 1);
      chosen.push({
        option_id: opt.id,
        group_name: group.name,
        option_name: opt.name,
        price_delta: round2(opt.price_delta),
      });
    }

    for (const groupId of allowedGroupIds) {
      const g = db.optionGroups.find((x) => x.id === groupId);
      if (!g || !g.is_active) continue;
      const picked = countByGroup.get(groupId) ?? 0;
      const min = g.is_required ? Math.max(1, g.min_select) : g.min_select;
      if (picked < min) throw bad(`"${product.name}": pick at least ${min} from ${g.name}`);
      const max = g.input_type === 'single' ? 1 : g.max_select;
      if (max > 0 && picked > max) throw bad(`"${product.name}": pick at most ${max} from ${g.name}`);
    }

    const unitBase = round2(product.base_price);
    const unitOptions = round2(chosen.reduce((s, o) => s + o.price_delta, 0));
    const lineTotal = round2((unitBase + unitOptions) * quantity);

    priced.push({
      product_id: product.id,
      product_name: product.name,
      quantity,
      unit_base_price: unitBase,
      unit_options_price: unitOptions,
      line_total: lineTotal,
      notes: raw.notes?.slice(0, 255) || null,
      options: chosen,
    });
    subtotal = round2(subtotal + lineTotal);
  }

  return { items: priced, subtotal };
}

/** Tax is charged on goods, not on the delivery fee. */
export function totalsFor({ subtotal, deliveryFee = 0, taxRate = 0, discount = 0 }) {
  const sub = round2(subtotal);
  const disc = round2(Math.min(discount, sub));
  const fee = round2(deliveryFee);
  const tax = round2((sub - disc) * Number(taxRate));
  return { subtotal: sub, discount: disc, delivery_fee: fee, tax, total: round2(sub - disc + fee + tax) };
}

/** Straight-line distance in km, for distance-based delivery pricing. */
export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
  return 2 * R * Math.asin(Math.sqrt(h));
}
