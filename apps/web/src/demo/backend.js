/**
 * Demo backend.
 *
 * GitHub Pages serves files; it cannot run the Express API or MySQL. This
 * module stands in for both so the published site is fully usable, answering
 * the same routes with the same shapes and enforcing the same rules —
 * particularly the pricing rules, which are the part worth demonstrating.
 *
 * State lives in localStorage, so it is per-browser and survives a refresh.
 * Nothing here runs in a real deployment: set VITE_API_BASE_URL and the app
 * talks to the real API instead.
 *
 * This deliberately mirrors apps/api/src — if you change a rule there, change
 * it here too, or the demo stops telling the truth.
 */

import {
  SEED_PASSWORD, seedUsers, seedSettings, seedCategories, seedProducts,
  seedOptionGroups, seedOptions, seedProductOptionGroups, seedOrders,
} from './seed.js';

const STORAGE_KEY = 'oats.demo.state.v1';
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const nowIso = () => new Date().toISOString();

/** Same shape as the real API's error responses. */
class DemoError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
const bad = (m, d) => new DemoError(400, m, d);
const unauth = (m = 'Not signed in') => new DemoError(401, m);
const forbid = (m = 'Not allowed') => new DemoError(403, m);
const missing = (m = 'Not found') => new DemoError(404, m);

// ------------------------------------------------------------------- state

function freshState() {
  const options = seedOptions();
  const seeded = seedOrders(options);
  return {
    users: seedUsers(),
    settings: seedSettings(),
    categories: seedCategories(),
    products: seedProducts(),
    optionGroups: seedOptionGroups(),
    options,
    productOptionGroups: seedProductOptionGroups(),
    orders: seeded.orders,
    orderItems: seeded.orderItems,
    orderItemOptions: seeded.orderItemOptions,
    history: seeded.history,
    deliveries: [],
    deliveryEvents: [],
    audit: [],
    seq: {
      user: 4,
      product: 6,
      group: 8,
      option: options.length + 1,
      category: 4,
      order: seeded.nextOrderId,
      item: seeded.nextItemId,
      optRow: seeded.nextOptRowId,
      delivery: 1,
      event: 1,
      audit: 1,
    },
    // Sessions are tokens we minted this browser session.
    sessions: {},
  };
}

let state = null;

function load() {
  if (state) return state;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      state = JSON.parse(raw);
      // A seed change invalidates stored state rather than half-migrating it.
      if (!state?.seq || !state?.products?.length) state = freshState();
    } else {
      state = freshState();
    }
  } catch {
    state = freshState();
  }
  return state;
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota or private mode — the demo still works for this page view.
  }
}

/** Wipes demo data back to the seeded catalog and order history. */
export function resetDemo() {
  state = freshState();
  save();
}

const nextId = (key) => {
  const id = state.seq[key];
  state.seq[key] = id + 1;
  return id;
};

// -------------------------------------------------------------------- auth

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role });

function mintToken(user) {
  const token = `demo.${user.id}.${Math.random().toString(36).slice(2)}`;
  state.sessions[token] = user.id;
  save();
  return token;
}

function currentUser(token) {
  if (!token) return null;
  // Tokens carry the user id, so a refresh that cleared sessions still works.
  const id = state.sessions[token] ?? Number(String(token).split('.')[1]);
  const user = state.users.find((u) => u.id === id);
  return user && user.is_active ? user : null;
}

const isStaff = (u) => u?.role === 'admin' || u?.role === 'manager';
const requireUser = (u) => { if (!u) throw unauth(); return u; };
const requireRole = (u, ...roles) => {
  requireUser(u);
  if (!roles.includes(u.role)) throw forbid(`Requires role: ${roles.join(' or ')}`);
  return u;
};

// ----------------------------------------------------------------- catalog

function buildMenu(user) {
  const staff = isStaff(user);
  const visible = (row, flag = 'is_active') => (staff ? true : Boolean(row[flag]));

  const optionsByGroup = new Map();
  for (const o of state.options) {
    if (!staff && !o.is_available) continue;
    if (!optionsByGroup.has(o.group_id)) optionsByGroup.set(o.group_id, []);
    optionsByGroup.get(o.group_id).push({ ...o });
  }

  const groups = state.optionGroups
    .filter((g) => visible(g))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((g) => ({ ...g, options: (optionsByGroup.get(g.id) ?? []).sort((a, b) => a.sort_order - b.sort_order) }));

  const groupById = new Map(groups.map((g) => [g.id, g]));

  const products = state.products
    .filter((p) => visible(p))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((p) => ({
      ...p,
      option_groups: state.productOptionGroups
        .filter((l) => l.product_id === p.id)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((l) => groupById.get(l.group_id))
        .filter(Boolean),
    }));

  const s = state.settings;
  return {
    settings: {
      shop_name: s.shop_name,
      currency: s.currency,
      tax_rate: Number(s.tax_rate),
      pickup_address: s.pickup_address,
      min_order_total: Number(s.min_order_total),
      delivery_enabled: Boolean(s.delivery_enabled),
      order_lead_mins: Number(s.order_lead_mins),
    },
    categories: state.categories.filter((c) => visible(c)).sort((a, b) => a.sort_order - b.sort_order),
    option_groups: groups,
    products,
  };
}

// ----------------------------------------------------------------- pricing

/** Mirrors apps/api/src/services/pricing.js. */
function priceCart(items) {
  if (!Array.isArray(items) || items.length === 0) throw bad('Cart is empty');

  const priced = [];
  let subtotal = 0;

  for (const raw of items) {
    const product = state.products.find((p) => p.id === Number(raw.product_id));
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
      state.productOptionGroups.filter((l) => l.product_id === product.id).map((l) => l.group_id),
    );
    const chosen = [];
    const countByGroup = new Map();

    for (const optionId of raw.option_ids ?? []) {
      const opt = state.options.find((o) => o.id === Number(optionId));
      if (!opt) throw bad(`Option ${optionId} does not exist`);
      const group = state.optionGroups.find((g) => g.id === opt.group_id);
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
      const g = state.optionGroups.find((x) => x.id === groupId);
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

function totalsFor({ subtotal, deliveryFee = 0, taxRate = 0, discount = 0 }) {
  const sub = round2(subtotal);
  const disc = round2(Math.min(discount, sub));
  const fee = round2(deliveryFee);
  const tax = round2((sub - disc) * Number(taxRate));
  return { subtotal: sub, discount: disc, delivery_fee: fee, tax, total: round2(sub - disc + fee + tax) };
}

// ---------------------------------------------------------------- delivery

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
  return 2 * R * Math.asin(Math.sqrt(h));
}

function quoteDelivery({ lat, lng }) {
  if (lat == null || lng == null) throw bad('Delivery quote needs a latitude and longitude');
  const pickup = { lat: Number(state.settings.pickup_lat), lng: Number(state.settings.pickup_lng) };
  const km = Math.max(0.4, haversineKm(pickup, { lat: Number(lat), lng: Number(lng) }));
  const fee = round2(5.0 + Math.max(0, km - 1) * 1.2);
  return {
    quote_id: `QUO-${rand()}`,
    fee,
    currency: 'MYR',
    distance_km: round2(km),
    eta_minutes: Math.max(12, Math.round(km * 4 + 10)),
    provider: 'grab-demo',
    straight_line_km: round2(km),
  };
}

const DRIVERS = [
  { name: 'Hafiz R.',   phone: '+60198887766', plate: 'WXY 4412' },
  { name: 'Siti N.',    phone: '+60177665544', plate: 'VBN 8821' },
  { name: 'Kumar S.',   phone: '+60163344221', plate: 'WA 6390 C' },
  { name: 'Wei Lin T.', phone: '+60122119988', plate: 'BMT 1173' },
];
const FLOW = ['allocating', 'picking_up', 'in_delivery', 'completed'];
const FLOW_TEXT = {
  allocating: 'Looking for a nearby driver',
  picking_up: 'Driver is on the way to the shop',
  in_delivery: 'Order collected, heading to you',
  completed: 'Delivered',
  cancelled: 'Booking cancelled',
};
const ORDER_STATUS_FOR = { picking_up: 'dispatched', in_delivery: 'dispatched', completed: 'delivered' };

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();

function deliveryFor(orderId) {
  const d = [...state.deliveries].reverse().find((x) => x.order_id === orderId);
  if (!d) return null;
  return { ...d, events: state.deliveryEvents.filter((e) => e.delivery_id === d.id) };
}

function pushDeliveryEvent(delivery, status, description, driver, actorId = null) {
  delivery.status = status;
  if (driver) {
    delivery.driver_name = driver.name;
    delivery.driver_phone = driver.phone;
    delivery.driver_plate = driver.plate;
  }
  state.deliveryEvents.push({
    id: nextId('event'), delivery_id: delivery.id, status,
    description, lat: null, lng: null, created_at: nowIso(),
  });

  const next = ORDER_STATUS_FOR[status];
  if (next) {
    const order = state.orders.find((o) => o.id === delivery.order_id);
    if (order && order.status !== next && order.status !== 'cancelled') {
      state.history.push({
        order_id: order.id, from_status: order.status, to_status: next,
        changed_by: actorId, note: `Grab: ${status}`, created_at: nowIso(),
      });
      order.status = next;
    }
  }
}

// ------------------------------------------------------------------ orders

function loadOrder(id) {
  const order = state.orders.find((o) => o.id === Number(id));
  if (!order) return null;
  const items = state.orderItems
    .filter((i) => i.order_id === order.id)
    .map((i) => ({ ...i, options: state.orderItemOptions.filter((o) => o.order_item_id === i.id) }));
  const history = state.history
    .filter((h) => h.order_id === order.id)
    .map((h) => ({ ...h, changed_by_name: state.users.find((u) => u.id === h.changed_by)?.name ?? null }));
  return { ...order, items, history, delivery: deliveryFor(order.id) };
}

const TRANSITIONS = {
  pending:    ['confirmed', 'cancelled'],
  confirmed:  ['preparing', 'cancelled'],
  preparing:  ['ready', 'cancelled'],
  ready:      ['dispatched', 'completed', 'cancelled'],
  dispatched: ['delivered', 'cancelled'],
  delivered:  ['completed'],
  completed:  [],
  cancelled:  [],
};

function audit(user, action, entity, entityId, meta) {
  state.audit.unshift({
    id: nextId('audit'), action, entity, entity_id: entityId == null ? null : String(entityId),
    meta: meta ?? null, created_at: nowIso(),
    user_name: user?.name ?? null, user_email: user?.email ?? null,
  });
  state.audit = state.audit.slice(0, 300);
}

// ------------------------------------------------------------------ router

const ROUTES = [
  // --- auth
  ['POST', /^\/auth\/login$/, (m, body) => {
    const user = state.users.find((u) => u.email === String(body.email).toLowerCase().trim());
    if (!user || user.password !== body.password) throw unauth('Email or password is incorrect');
    if (!user.is_active) throw unauth('This account has been deactivated');
    return { token: mintToken(user), user: publicUser(user) };
  }],

  ['POST', /^\/auth\/register$/, (m, body) => {
    const email = String(body.email ?? '').toLowerCase().trim();
    if (!email.includes('@')) throw bad('Enter a valid email');
    if (String(body.password ?? '').length < 8) throw bad('Password must be at least 8 characters');
    if (state.users.some((u) => u.email === email)) throw new DemoError(409, 'That email is already registered');
    const user = {
      id: nextId('user'), email, password: body.password, name: body.name,
      phone: body.phone ?? null, role: 'customer', is_active: 1, created_at: nowIso(),
    };
    state.users.push(user);
    return { token: mintToken(user), user: publicUser(user) };
  }],

  ['GET', /^\/auth\/me$/, (m, body, user) => ({ user: publicUser(requireUser(user)) })],

  ['PATCH', /^\/auth\/me$/, (m, body, user) => {
    requireUser(user);
    if (body.name !== undefined) user.name = body.name;
    if (body.phone !== undefined) user.phone = body.phone;
    if (body.password) user.password = body.password;
    return { user: publicUser(user) };
  }],

  // --- catalog
  ['GET', /^\/catalog\/menu$/, (m, body, user) => buildMenu(user)],

  ['POST', /^\/catalog\/products$/, (m, body, user) => {
    requireRole(user, 'admin', 'manager');
    const p = {
      id: nextId('product'), category_id: Number(body.category_id), name: body.name,
      slug: slugify(body.name), description: body.description ?? null,
      base_price: Number(body.base_price), image_url: body.image_url || null,
      is_active: body.is_active === false ? 0 : 1, track_stock: body.track_stock ? 1 : 0,
      stock_qty: Number(body.stock_qty ?? 0), sort_order: Number(body.sort_order ?? 0),
    };
    state.products.push(p);
    setProductGroups(p.id, body.option_group_ids ?? []);
    audit(user, 'product.create', 'product', p.id, { name: p.name });
    return p;
  }],

  ['PATCH', /^\/catalog\/products\/(\d+)$/, (m, body, user) => {
    requireRole(user, 'admin', 'manager');
    const p = state.products.find((x) => x.id === Number(m[1]));
    if (!p) throw missing('Product not found');
    for (const k of ['category_id', 'name', 'description', 'base_price', 'image_url', 'sort_order', 'stock_qty']) {
      if (body[k] !== undefined) p[k] = k === 'image_url' ? (body[k] || null) : body[k];
    }
    if (body.is_active !== undefined) p.is_active = body.is_active ? 1 : 0;
    if (body.track_stock !== undefined) p.track_stock = body.track_stock ? 1 : 0;
    if (body.option_group_ids) setProductGroups(p.id, body.option_group_ids);
    audit(user, 'product.update', 'product', p.id, body);
    return p;
  }],

  ['DELETE', /^\/catalog\/products\/(\d+)$/, (m, body, user) => {
    requireRole(user, 'admin');
    const id = Number(m[1]);
    const used = state.orderItems.some((i) => i.product_id === id);
    const p = state.products.find((x) => x.id === id);
    if (!p) throw missing('Product not found');
    if (used) {
      p.is_active = 0;
      audit(user, 'product.deactivate', 'product', id, { reason: 'has orders' });
      return { deactivated: true, deleted: false };
    }
    state.products = state.products.filter((x) => x.id !== id);
    state.productOptionGroups = state.productOptionGroups.filter((l) => l.product_id !== id);
    audit(user, 'product.delete', 'product', id);
    return { deactivated: false, deleted: true };
  }],

  ['POST', /^\/catalog\/options$/, (m, body, user) => {
    requireRole(user, 'admin', 'manager');
    const o = {
      id: nextId('option'), group_id: Number(body.group_id), name: body.name,
      description: body.description ?? null, price_delta: Number(body.price_delta),
      image_url: body.image_url || null, is_available: body.is_available === false ? 0 : 1,
      track_stock: body.track_stock ? 1 : 0, stock_qty: Number(body.stock_qty ?? 0),
      sort_order: Number(body.sort_order ?? 0),
    };
    state.options.push(o);
    audit(user, 'option.create', 'option', o.id, { name: o.name });
    return o;
  }],

  ['PATCH', /^\/catalog\/options\/(\d+)$/, (m, body, user) => {
    requireRole(user, 'admin', 'manager');
    const o = state.options.find((x) => x.id === Number(m[1]));
    if (!o) throw missing('Option not found');
    for (const k of ['group_id', 'name', 'description', 'price_delta', 'sort_order', 'stock_qty']) {
      if (body[k] !== undefined) o[k] = body[k];
    }
    if (body.is_available !== undefined) o.is_available = body.is_available ? 1 : 0;
    if (body.track_stock !== undefined) o.track_stock = body.track_stock ? 1 : 0;
    audit(user, 'option.update', 'option', o.id, body);
    return o;
  }],

  ['DELETE', /^\/catalog\/options\/(\d+)$/, (m, body, user) => {
    requireRole(user, 'admin', 'manager');
    const id = Number(m[1]);
    const o = state.options.find((x) => x.id === id);
    if (!o) throw missing('Option not found');
    if (state.orderItemOptions.some((x) => x.option_id === id)) {
      o.is_available = 0;
      audit(user, 'option.deactivate', 'option', id, { reason: 'has orders' });
      return { deactivated: true, deleted: false };
    }
    state.options = state.options.filter((x) => x.id !== id);
    audit(user, 'option.delete', 'option', id);
    return { deactivated: false, deleted: true };
  }],

  ['PATCH', /^\/catalog\/option-groups\/(\d+)$/, (m, body, user) => {
    requireRole(user, 'admin', 'manager');
    const g = state.optionGroups.find((x) => x.id === Number(m[1]));
    if (!g) throw missing('Option group not found');
    for (const k of ['name', 'description', 'input_type', 'min_select', 'max_select', 'sort_order']) {
      if (body[k] !== undefined) g[k] = body[k];
    }
    if (body.is_required !== undefined) g.is_required = body.is_required ? 1 : 0;
    if (body.is_active !== undefined) g.is_active = body.is_active ? 1 : 0;
    audit(user, 'option_group.update', 'option_group', g.id, body);
    return g;
  }],

  ['POST', /^\/catalog\/option-groups$/, (m, body, user) => {
    requireRole(user, 'admin', 'manager');
    const g = {
      id: nextId('group'), name: body.name, slug: slugify(body.name),
      description: body.description ?? null, input_type: body.input_type,
      min_select: Number(body.min_select ?? 0), max_select: Number(body.max_select ?? 0),
      is_required: body.is_required ? 1 : 0, sort_order: Number(body.sort_order ?? 0), is_active: 1,
    };
    state.optionGroups.push(g);
    audit(user, 'option_group.create', 'option_group', g.id, { name: g.name });
    return g;
  }],

  ['POST', /^\/catalog\/categories$/, (m, body, user) => {
    requireRole(user, 'admin', 'manager');
    const c = {
      id: nextId('category'), name: body.name, slug: slugify(body.name),
      sort_order: Number(body.sort_order ?? 0), is_active: 1,
    };
    state.categories.push(c);
    return c;
  }],

  ['PATCH', /^\/catalog\/categories\/(\d+)$/, (m, body, user) => {
    requireRole(user, 'admin', 'manager');
    const c = state.categories.find((x) => x.id === Number(m[1]));
    if (!c) throw missing('Category not found');
    if (body.name !== undefined) c.name = body.name;
    if (body.sort_order !== undefined) c.sort_order = body.sort_order;
    if (body.is_active !== undefined) c.is_active = body.is_active ? 1 : 0;
    return c;
  }],

  // --- orders
  ['POST', /^\/orders\/quote$/, (m, body) => {
    const { items, subtotal } = priceCart(body.items);
    let deliveryQuote = null;
    if (body.fulfillment_type === 'delivery' && body.delivery_lat != null) {
      deliveryQuote = quoteDelivery({ lat: body.delivery_lat, lng: body.delivery_lng });
    }
    const totals = totalsFor({ subtotal, deliveryFee: deliveryQuote?.fee ?? 0, taxRate: state.settings.tax_rate });
    return {
      items, ...totals,
      currency: state.settings.currency,
      delivery_quote: deliveryQuote,
      pickup_address: state.settings.pickup_address,
      order_lead_mins: Number(state.settings.order_lead_mins),
      min_order_total: Number(state.settings.min_order_total),
      meets_minimum: subtotal >= Number(state.settings.min_order_total),
    };
  }],

  ['POST', /^\/orders$/, (m, body, user) => {
    if (body.fulfillment_type === 'delivery' && !state.settings.delivery_enabled) {
      throw bad('Delivery is switched off right now');
    }
    const { items, subtotal } = priceCart(body.items);
    if (subtotal < Number(state.settings.min_order_total)) {
      throw bad(`Minimum order is ${state.settings.currency} ${Number(state.settings.min_order_total).toFixed(2)}`);
    }
    let deliveryFee = 0;
    if (body.fulfillment_type === 'delivery') {
      if (body.delivery_lat == null || body.delivery_lng == null) {
        throw bad('Delivery orders need an address with coordinates');
      }
      deliveryFee = quoteDelivery({ lat: body.delivery_lat, lng: body.delivery_lng }).fee;
    }
    const totals = totalsFor({ subtotal, deliveryFee, taxRate: state.settings.tax_rate });
    const id = nextId('order');

    state.orders.push({
      id,
      order_number: `OK-${String(240000 + id).padStart(6, '0')}`,
      customer_id: user?.id ?? null,
      status: 'pending',
      fulfillment_type: body.fulfillment_type,
      contact_name: body.contact_name,
      contact_phone: body.contact_phone,
      contact_email: body.contact_email ?? user?.email ?? null,
      delivery_address: body.delivery_address ?? null,
      delivery_notes: body.delivery_notes ?? null,
      delivery_lat: body.delivery_lat ?? null,
      delivery_lng: body.delivery_lng ?? null,
      ...totals,
      currency: state.settings.currency,
      payment_method: body.payment_method ?? 'cash',
      payment_status: 'unpaid',
      notes: body.notes ?? null,
      scheduled_for: body.scheduled_for ?? null,
      cancelled_reason: null,
      created_at: nowIso(),
    });

    for (const item of items) {
      const itemId = nextId('item');
      state.orderItems.push({
        id: itemId, order_id: id, product_id: item.product_id, product_name: item.product_name,
        quantity: item.quantity, unit_base_price: item.unit_base_price,
        unit_options_price: item.unit_options_price, line_total: item.line_total, notes: item.notes,
      });
      for (const o of item.options) {
        state.orderItemOptions.push({ id: nextId('optRow'), order_item_id: itemId, ...o });
      }
      const product = state.products.find((p) => p.id === item.product_id);
      if (product?.track_stock) product.stock_qty = Math.max(0, product.stock_qty - item.quantity);
      for (const o of item.options) {
        const opt = state.options.find((x) => x.id === o.option_id);
        if (opt?.track_stock) opt.stock_qty = Math.max(0, opt.stock_qty - item.quantity);
      }
    }

    state.history.push({
      order_id: id, from_status: null, to_status: 'pending',
      changed_by: user?.id ?? null, note: 'Order placed', created_at: nowIso(),
    });
    audit(user, 'order.create', 'order', id, { order_number: `OK-${String(240000 + id).padStart(6, '0')}` });
    return loadOrder(id);
  }],

  ['GET', /^\/orders\/queue$/, (m, body, user) => {
    requireRole(user, 'admin', 'manager');
    const orders = state.orders
      .filter((o) => !['completed', 'cancelled'].includes(o.status))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map((o) => {
        const d = deliveryFor(o.id);
        return {
          ...o,
          customer_name: state.users.find((u) => u.id === o.customer_id)?.name ?? null,
          delivery_status: d?.status ?? null,
          driver_name: d?.driver_name ?? null,
          driver_phone: d?.driver_phone ?? null,
          tracking_url: d?.tracking_url ?? null,
          age_minutes: Math.max(0, Math.round((Date.now() - new Date(o.created_at)) / 60000)),
          items: state.orderItems.filter((i) => i.order_id === o.id).map((i) => ({
            ...i,
            option_summary: state.orderItemOptions
              .filter((x) => x.order_item_id === i.id)
              .map((x) => `${x.group_name}: ${x.option_name}`)
              .join(' | ') || null,
          })),
        };
      });
    return { orders };
  }],

  ['GET', /^\/orders\/track\/([^/?]+)$/, (m, body, user, query) => {
    const order = state.orders.find(
      (o) => o.order_number === decodeURIComponent(m[1]) && o.contact_phone === query.get('phone'),
    );
    if (!order) throw missing('No order matches that number and phone');
    return loadOrder(order.id);
  }],

  ['GET', /^\/orders\/(\d+)$/, (m, body, user) => {
    const order = loadOrder(m[1]);
    if (!order) throw missing('Order not found');
    if (!isStaff(user) && (!user || order.customer_id !== user.id)) throw forbid('That is not your order');
    return order;
  }],

  ['GET', /^\/orders$/, (m, body, user, query) => {
    requireUser(user);
    const limit = Number(query.get('limit') ?? 50);
    const offset = Number(query.get('offset') ?? 0);
    const statuses = (query.get('status') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const type = query.get('fulfillment_type');
    const search = (query.get('search') ?? '').toLowerCase();

    let rows = state.orders.filter((o) => (isStaff(user) ? true : o.customer_id === user.id));
    if (statuses.length) rows = rows.filter((o) => statuses.includes(o.status));
    if (type) rows = rows.filter((o) => o.fulfillment_type === type);
    if (search) {
      rows = rows.filter((o) =>
        o.order_number.toLowerCase().includes(search) ||
        o.contact_name.toLowerCase().includes(search) ||
        (o.contact_phone ?? '').includes(search));
    }
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const total = rows.length;
    const page = rows.slice(offset, offset + limit).map((o) => {
      const d = deliveryFor(o.id);
      return {
        ...o,
        customer_name: state.users.find((u) => u.id === o.customer_id)?.name ?? null,
        item_count: state.orderItems.filter((i) => i.order_id === o.id).length,
        delivery_status: d?.status ?? null,
        driver_name: d?.driver_name ?? null,
        tracking_url: d?.tracking_url ?? null,
      };
    });
    return { orders: page, total, limit, offset };
  }],

  ['PATCH', /^\/orders\/(\d+)\/status$/, (m, body, user) => {
    requireRole(user, 'admin', 'manager');
    const order = state.orders.find((o) => o.id === Number(m[1]));
    if (!order) throw missing('Order not found');
    const allowed = TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(body.status)) {
      throw bad(`Cannot move an order from "${order.status}" to "${body.status}"`, { allowed });
    }
    state.history.push({
      order_id: order.id, from_status: order.status, to_status: body.status,
      changed_by: user.id, note: body.note ?? body.reason ?? null, created_at: nowIso(),
    });
    order.status = body.status;
    order.cancelled_reason = body.status === 'cancelled' ? body.reason ?? null : null;
    audit(user, 'order.status', 'order', order.id, { to: body.status });
    return loadOrder(order.id);
  }],

  ['PATCH', /^\/orders\/(\d+)\/payment$/, (m, body, user) => {
    requireRole(user, 'admin', 'manager');
    const order = state.orders.find((o) => o.id === Number(m[1]));
    if (!order) throw missing('Order not found');
    order.payment_status = body.payment_status;
    if (body.payment_method) order.payment_method = body.payment_method;
    audit(user, 'order.payment', 'order', order.id, body);
    return loadOrder(order.id);
  }],

  ['POST', /^\/orders\/(\d+)\/cancel$/, (m, body, user) => {
    requireUser(user);
    const order = state.orders.find((o) => o.id === Number(m[1]));
    if (!order) throw missing('Order not found');
    if (!isStaff(user) && order.customer_id !== user.id) throw forbid('That is not your order');
    if (!isStaff(user) && order.status !== 'pending') {
      throw bad('This order is already being prepared — call the shop to cancel');
    }
    if (order.status === 'cancelled') throw bad('Already cancelled');
    state.history.push({
      order_id: order.id, from_status: order.status, to_status: 'cancelled',
      changed_by: user.id, note: body.reason ?? 'Cancelled by customer', created_at: nowIso(),
    });
    order.status = 'cancelled';
    order.cancelled_reason = body.reason ?? 'Cancelled by customer';
    audit(user, 'order.cancel', 'order', order.id, { reason: body.reason });
    return loadOrder(order.id);
  }],

  // --- delivery
  ['POST', /^\/delivery\/quote$/, (m, body) => quoteDelivery(body)],

  ['POST', /^\/delivery\/orders\/(\d+)\/book$/, (m, body, user) => {
    requireRole(user, 'admin', 'manager');
    const orderId = Number(m[1]);
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw missing('Order not found');
    if (order.fulfillment_type !== 'delivery') throw bad('This order is for pickup, not delivery');
    if (order.status === 'cancelled') throw bad('Order is cancelled');

    const existing = deliveryFor(orderId);
    if (existing && !['cancelled', 'failed'].includes(existing.status)) {
      return { delivery: existing, reused: true };
    }

    const quote = quoteDelivery({ lat: order.delivery_lat, lng: order.delivery_lng });
    const delivery = {
      id: nextId('delivery'), order_id: orderId, provider: 'grab',
      provider_delivery_id: `GRB-${rand()}`, quote_id: quote.quote_id, status: 'allocating',
      fee: quote.fee, currency: 'MYR', distance_km: quote.distance_km,
      driver_name: null, driver_phone: null, driver_plate: null,
      driver_lat: null, driver_lng: null,
      tracking_url: null,
      pickup_eta: new Date(Date.now() + 8 * 60_000).toISOString(),
      dropoff_eta: new Date(Date.now() + quote.eta_minutes * 60_000).toISOString(),
      created_at: nowIso(),
    };
    state.deliveries.push(delivery);
    state.deliveryEvents.push({
      id: nextId('event'), delivery_id: delivery.id, status: 'allocating',
      description: 'Booking created', lat: null, lng: null, created_at: nowIso(),
    });

    if (order.status !== 'dispatched') {
      state.history.push({
        order_id: orderId, from_status: order.status, to_status: 'dispatched',
        changed_by: user.id, note: 'Grab driver requested', created_at: nowIso(),
      });
      order.status = 'dispatched';
    }
    audit(user, 'delivery.book', 'order', orderId);
    return { delivery: deliveryFor(orderId), reused: false };
  }],

  ['POST', /^\/delivery\/orders\/(\d+)\/cancel$/, (m, body, user) => {
    requireRole(user, 'admin', 'manager');
    const orderId = Number(m[1]);
    const delivery = state.deliveries.find((d) => d.order_id === orderId && !['cancelled', 'completed'].includes(d.status));
    if (!delivery) throw missing('No delivery booked for this order');
    pushDeliveryEvent(delivery, 'cancelled', body.reason || FLOW_TEXT.cancelled, null, user.id);
    const order = state.orders.find((o) => o.id === orderId);
    if (order?.status === 'dispatched') {
      state.history.push({
        order_id: orderId, from_status: 'dispatched', to_status: 'ready',
        changed_by: user.id, note: 'Grab booking cancelled', created_at: nowIso(),
      });
      order.status = 'ready';
    }
    audit(user, 'delivery.cancel', 'order', orderId, { reason: body.reason });
    return { delivery: deliveryFor(orderId) };
  }],

  ['GET', /^\/delivery\/orders\/(\d+)$/, (m, body, user) => {
    const orderId = Number(m[1]);
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw missing('Order not found');
    if (!isStaff(user) && order.customer_id !== user?.id) throw forbid('That is not your order');
    return { delivery: deliveryFor(orderId) };
  }],

  ['POST', /^\/delivery\/simulate\/(\d+)\/advance$/, (m, body, user) => {
    requireRole(user, 'admin', 'manager');
    const orderId = Number(m[1]);
    const delivery = state.deliveries.find((d) => d.order_id === orderId);
    if (!delivery) throw missing('No delivery booked for this order');
    const next = FLOW[FLOW.indexOf(delivery.status) + 1];
    if (!next) throw bad(`Delivery is already ${delivery.status}`);
    const driver = next === 'picking_up' ? DRIVERS[Math.floor(Math.random() * DRIVERS.length)] : null;
    pushDeliveryEvent(delivery, next, FLOW_TEXT[next], driver, user.id);
    return { delivery: deliveryFor(orderId) };
  }],

  // --- admin
  ['GET', /^\/admin\/users$/, (m, body, user, query) => {
    requireRole(user, 'admin');
    const role = query.get('role');
    const search = (query.get('search') ?? '').toLowerCase();
    let rows = [...state.users];
    if (role) rows = rows.filter((u) => u.role === role);
    if (search) {
      rows = rows.filter((u) =>
        u.name.toLowerCase().includes(search) ||
        u.email.toLowerCase().includes(search) ||
        (u.phone ?? '').includes(search));
    }
    const users = rows.map((u) => {
      const theirs = state.orders.filter((o) => o.customer_id === u.id);
      return {
        ...publicUser(u), is_active: u.is_active, created_at: u.created_at,
        order_count: theirs.length,
        lifetime_value: round2(theirs.filter((o) => o.status === 'completed').reduce((s, o) => s + o.total, 0)),
      };
    });
    return { users, total: users.length, limit: 100, offset: 0 };
  }],

  ['POST', /^\/admin\/users$/, (m, body, user) => {
    requireRole(user, 'admin');
    const email = String(body.email).toLowerCase().trim();
    if (state.users.some((u) => u.email === email)) throw new DemoError(409, 'That email is already registered');
    const u = {
      id: nextId('user'), email, password: body.password, name: body.name,
      phone: body.phone ?? null, role: body.role, is_active: 1, created_at: nowIso(),
    };
    state.users.push(u);
    audit(user, 'user.create', 'user', u.id, { email, role: u.role });
    return { ...publicUser(u), is_active: u.is_active };
  }],

  ['PATCH', /^\/admin\/users\/(\d+)$/, (m, body, user) => {
    requireRole(user, 'admin');
    const target = state.users.find((u) => u.id === Number(m[1]));
    if (!target) throw missing('User not found');
    const losingAdmin = target.role === 'admin' &&
      ((body.role && body.role !== 'admin') || body.is_active === false);
    if (losingAdmin && !state.users.some((u) => u.role === 'admin' && u.is_active && u.id !== target.id)) {
      throw bad('This is the last active admin');
    }
    for (const k of ['name', 'phone', 'role']) if (body[k] !== undefined) target[k] = body[k];
    if (body.is_active !== undefined) target.is_active = body.is_active ? 1 : 0;
    if (body.password) target.password = body.password;
    audit(user, 'user.update', 'user', target.id, { ...body, password: undefined });
    return { ...publicUser(target), is_active: target.is_active };
  }],

  ['GET', /^\/admin\/settings$/, (m, body, user) => {
    requireRole(user, 'admin', 'manager');
    return { settings: { ...state.settings }, grab_mode: 'demo' };
  }],

  ['PUT', /^\/admin\/settings$/, (m, body, user) => {
    requireRole(user, 'admin');
    Object.assign(state.settings, body);
    audit(user, 'settings.update', 'settings', null, body);
    return { settings: { ...state.settings } };
  }],

  ['GET', /^\/admin\/stats$/, (m, body, user, query) => {
    requireRole(user, 'admin', 'manager');
    const days = Number(query.get('days') ?? 30);
    const since = Date.now() - days * 86_400_000;
    const inWindow = state.orders.filter((o) => new Date(o.created_at).getTime() >= since);
    const counted = inWindow.filter((o) => o.status !== 'cancelled');
    const todayKey = new Date().toDateString();
    const todays = state.orders.filter((o) => new Date(o.created_at).toDateString() === todayKey);

    const byDay = new Map();
    for (const o of inWindow) {
      const key = new Date(o.created_at).toISOString().slice(0, 10);
      const row = byDay.get(key) ?? { day: key, orders: 0, revenue: 0 };
      row.orders += 1;
      if (o.status !== 'cancelled') row.revenue = round2(row.revenue + o.total);
      byDay.set(key, row);
    }

    const itemsInWindow = state.orderItems.filter((i) =>
      counted.some((o) => o.id === i.order_id));

    const productTotals = new Map();
    for (const i of itemsInWindow) {
      const row = productTotals.get(i.product_name) ?? { product_name: i.product_name, qty: 0, revenue: 0 };
      row.qty += i.quantity;
      row.revenue = round2(row.revenue + i.line_total);
      productTotals.set(i.product_name, row);
    }

    const optionTotals = new Map();
    for (const o of state.orderItemOptions) {
      if (!itemsInWindow.some((i) => i.id === o.order_item_id)) continue;
      const key = `${o.group_name}|${o.option_name}`;
      const row = optionTotals.get(key) ?? { group_name: o.group_name, option_name: o.option_name, picks: 0 };
      row.picks += 1;
      optionTotals.set(key, row);
    }

    const statusTotals = new Map();
    for (const o of inWindow) statusTotals.set(o.status, (statusTotals.get(o.status) ?? 0) + 1);

    const fulfilment = ['pickup', 'delivery'].map((t) => ({
      fulfillment_type: t,
      n: inWindow.filter((o) => o.fulfillment_type === t).length,
      delivery_fees: round2(inWindow.filter((o) => o.fulfillment_type === t).reduce((s, o) => s + o.delivery_fee, 0)),
    }));

    return {
      days,
      today: {
        orders: todays.length,
        revenue: round2(todays.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + o.total, 0)),
      },
      period: {
        orders: inWindow.length,
        revenue: round2(counted.reduce((s, o) => s + o.total, 0)),
        avg_order_value: counted.length ? round2(counted.reduce((s, o) => s + o.total, 0) / counted.length) : 0,
      },
      open_orders: state.orders.filter((o) => !['completed', 'cancelled'].includes(o.status)).length,
      by_status: [...statusTotals].map(([status, n]) => ({ status, n })),
      daily: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
      top_products: [...productTotals.values()].sort((a, b) => b.qty - a.qty).slice(0, 10),
      top_options: [...optionTotals.values()].sort((a, b) => b.picks - a.picks).slice(0, 15),
      fulfillment: fulfilment,
    };
  }],

  ['GET', /^\/admin\/audit$/, (m, body, user) => {
    requireRole(user, 'admin');
    return { entries: state.audit };
  }],

  ['GET', /^\/health$/, () => ({ ok: true, db: 'demo', grab_mode: 'demo', env: 'demo' })],
];

function setProductGroups(productId, groupIds) {
  state.productOptionGroups = state.productOptionGroups.filter((l) => l.product_id !== productId);
  groupIds.forEach((gid, i) => {
    state.productOptionGroups.push({ product_id: productId, group_id: Number(gid), sort_order: i });
  });
}

const slugify = (s) =>
  String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 150);

/**
 * Entry point used by lib/api.js. Mirrors fetch's contract closely enough for
 * the app not to know the difference, including a little latency so loading
 * states are exercised rather than skipped.
 */
export async function demoRequest(method, path, body, token) {
  load();

  const [rawPath, search] = String(path).split('?');
  const query = new URLSearchParams(search ?? '');
  const user = currentUser(token);

  await new Promise((r) => setTimeout(r, 60 + Math.random() * 120));

  for (const [verb, pattern, handler] of ROUTES) {
    if (verb !== method) continue;
    const match = rawPath.match(pattern);
    if (!match) continue;
    const result = handler(match, body ?? {}, user, query);
    save();
    return result;
  }

  throw missing(`No route for ${method} ${rawPath}`);
}

export { DemoError, SEED_PASSWORD };
