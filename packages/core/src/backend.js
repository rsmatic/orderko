/**
 * The whole application, as a route table over a plain JavaScript object.
 *
 * It does no I/O of its own. Storage, password hashing, token signing and the
 * delivery provider all arrive as adapters, which is what lets one
 * implementation serve both the HTTP API (JSON file on disk, bcrypt, JWT, the
 * real GrabExpress client) and the browser demo (localStorage, trivial
 * comparisons, a simulated driver).
 */

import {
  SEED_PASSWORD, seedUsers, seedSettings, seedCategories, seedProducts,
  seedOptionGroups, seedOptions, seedProductOptionGroups, seedOrders,
} from './seed.js';
import {
  AppError, bad, unauthorized, forbidden, notFound, conflict,
  round2, slugify, isStaff, publicUser, priceCart, totalsFor, haversineKm,
  TRANSITIONS, ORDER_STATUS_FOR_DELIVERY,
} from './rules.js';
import { groupRuleProblem } from './selection.js';

const nowIso = () => new Date().toISOString();

/** Images live inline in the store, so they need a ceiling. ~400 KB of base64. */
const MAX_IMAGE_CHARS = 400_000;

/** An order book with nothing in it, counters at the start. */
const emptyOrderBook = () => ({
  orders: [],
  orderItems: [],
  orderItemOptions: [],
  history: [],
  nextOrderId: 1,
  nextItemId: 1,
  nextOptRowId: 1,
});

/**
 * Strips every order and everything hanging off one — items, chosen options,
 * status history, deliveries and their events — leaving the catalog, accounts
 * and settings untouched. Counters go back to the start, so the next order is
 * numbered as if it were the first.
 *
 * Audit entries go too: most of them refer to orders that no longer exist.
 */
export function clearOrders(state) {
  const removed = state.orders.length;

  Object.assign(state, emptyOrderBook());
  state.deliveries = [];
  state.deliveryEvents = [];
  state.audit = [];

  Object.assign(state.seq, {
    order: 1,
    item: 1,
    optRow: 1,
    delivery: 1,
    event: 1,
    audit: 1,
  });

  return { state, removed };
}

/**
 * The shape persisted by whichever storage adapter is in play.
 *
 * `includeSampleOrders` seeds two weeks of history so the kitchen board and
 * the reports are not empty on a first look. A real shop wants it off, so the
 * first order in the book is a real one.
 */
export async function freshState({
  hashPassword,
  seedPassword = SEED_PASSWORD,
  includeSampleOrders = true,
} = {}) {
  const options = seedOptions();
  const seeded = includeSampleOrders ? seedOrders(options) : emptyOrderBook();
  const users = seedUsers();

  for (const u of users) {
    u.password_hash = hashPassword ? await hashPassword(seedPassword) : seedPassword;
  }

  return {
    version: 1,
    users,
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
  };
}

/**
 * @param {object}   opts
 * @param {object}   opts.state    the state object to operate on
 * @param {function} opts.persist  called after any handler that mutated state
 * @param {object}   opts.auth     { hashPassword, verifyPassword, signToken, verifyToken }
 * @param {object}   opts.delivery { quote, book, track, cancel, advance? }
 * @param {object}   [opts.googleAuth] { verify(credential, clientId) } — absent
 *                   when Google sign-in is not available.
 */
export function createBackend({ state, persist, auth, delivery, googleAuth }) {
  let db = state;

  const nextId = (key) => {
    const id = db.seq[key];
    db.seq[key] = id + 1;
    return id;
  };

  // ------------------------------------------------------------------ users

  async function userFromToken(token) {
    if (!token) return null;
    const claims = await auth.verifyToken(token);
    if (!claims) return null;
    const user = db.users.find((u) => u.id === Number(claims.sub));
    return user && user.is_active ? user : null;
  }

  const requireUser = (u) => { if (!u) throw unauthorized(); return u; };
  const requireRole = (u, ...roles) => {
    requireUser(u);
    if (!roles.includes(u.role)) throw forbidden(`Requires role: ${roles.join(' or ')}`);
    return u;
  };

  /**
   * Validates and normalises a new email, rejecting one already in use.
   * Email is the login identifier, so a clash would lock someone out.
   */
  function changeEmail(target, raw) {
    const email = String(raw ?? '').toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address');
    if (email.length > 190) throw bad('That email is too long');
    if (db.users.some((u) => u.email === email && u.id !== target.id)) {
      throw conflict('Another account already uses that email');
    }
    return email;
  }

  function audit(user, action, entity = null, entityId = null, meta = null) {
    db.audit.unshift({
      id: nextId('audit'),
      action,
      entity,
      entity_id: entityId == null ? null : String(entityId),
      meta,
      created_at: nowIso(),
      user_name: user?.name ?? null,
      user_email: user?.email ?? null,
    });
    // The log is a convenience, not an archive; keep it bounded.
    db.audit = db.audit.slice(0, 500);
  }

  // ---------------------------------------------------------------- catalog

  function buildMenu(user) {
    const staff = isStaff(user);

    const optionsByGroup = new Map();
    for (const o of db.options) {
      if (!staff && !o.is_available) continue;
      if (!optionsByGroup.has(o.group_id)) optionsByGroup.set(o.group_id, []);
      optionsByGroup.get(o.group_id).push({ ...o });
    }

    const groups = db.optionGroups
      .filter((g) => staff || g.is_active)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((g) => ({
        ...g,
        options: (optionsByGroup.get(g.id) ?? []).sort((a, b) => a.sort_order - b.sort_order),
      }));

    const groupById = new Map(groups.map((g) => [g.id, g]));

    const products = db.products
      .filter((p) => staff || p.is_active)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((p) => ({
        ...p,
        option_groups: db.productOptionGroups
          .filter((l) => l.product_id === p.id)
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((l) => groupById.get(l.group_id))
          .filter(Boolean),
      }));

    const s = db.settings;
    return {
      settings: {
        shop_name: s.shop_name,
        logo_url: s.logo_url ?? '',
        hero_image_url: s.hero_image_url ?? '',
        show_included_label: s.show_included_label !== false,
        google_client_id: s.google_client_id ?? '',
        currency: s.currency,
        tax_rate: Number(s.tax_rate),
        pickup_address: s.pickup_address,
        min_order_total: Number(s.min_order_total),
        delivery_enabled: Boolean(s.delivery_enabled),
        max_delivery_km: Number(s.max_delivery_km ?? 0),
        pickup_lat: Number(s.pickup_lat),
        pickup_lng: Number(s.pickup_lng),
        order_lead_mins: Number(s.order_lead_mins),
      },
      categories: db.categories
        .filter((c) => staff || c.is_active)
        .sort((a, b) => a.sort_order - b.sort_order),
      option_groups: groups,
      products,
    };
  }

  function setProductGroups(productId, groupIds) {
    db.productOptionGroups = db.productOptionGroups.filter((l) => l.product_id !== productId);
    groupIds.forEach((gid, i) => {
      db.productOptionGroups.push({ product_id: productId, group_id: Number(gid), sort_order: i });
    });
  }

  // --------------------------------------------------------------- delivery

  /**
   * Refuses a destination outside the delivery radius. Checked here rather
   * than in the UI: the picker can put a pin anywhere, and the fee formula
   * will happily quote a fare across the country.
   */
  function assertWithinRange(dropoff) {
    const limit = Number(db.settings.max_delivery_km ?? 0);
    if (!limit) return;
    const km = haversineKm(
      { lat: Number(db.settings.pickup_lat), lng: Number(db.settings.pickup_lng) },
      { lat: Number(dropoff.lat), lng: Number(dropoff.lng) },
    );
    if (km > limit) {
      throw bad(
        `That address is about ${Math.round(km)} km away. ` +
          `We deliver within ${limit} km — choose pickup, or a closer address.`,
      );
    }
  }

  const pickupPlace = () => ({
    address: db.settings.pickup_address,
    lat: Number(db.settings.pickup_lat),
    lng: Number(db.settings.pickup_lng),
    phone: db.settings.pickup_phone,
    name: db.settings.shop_name,
  });

  function deliveryForOrder(orderId) {
    const d = [...db.deliveries].reverse().find((x) => x.order_id === orderId);
    if (!d) return null;
    return { ...d, events: db.deliveryEvents.filter((e) => e.delivery_id === d.id) };
  }

  /**
   * Records a provider transition and drags the parent order along with it.
   * Both the simulated driver and the real Grab webhook land here.
   */
  function recordDeliveryEvent({ providerDeliveryId, status, description, driver, location, raw }, actorId = null) {
    const record = db.deliveries.find((d) => d.provider_delivery_id === providerDeliveryId);
    if (!record) return null;

    record.status = status;
    if (driver) {
      record.driver_name = driver.name ?? record.driver_name;
      record.driver_phone = driver.phone ?? record.driver_phone;
      record.driver_plate = driver.plate ?? record.driver_plate;
      record.driver_photo_url = driver.photo_url ?? record.driver_photo_url;
    }
    if (location) {
      record.driver_lat = location.lat;
      record.driver_lng = location.lng;
    }
    if (raw !== undefined) record.raw_payload = raw;

    db.deliveryEvents.push({
      id: nextId('event'),
      delivery_id: record.id,
      status,
      description: description ?? null,
      lat: location?.lat ?? null,
      lng: location?.lng ?? null,
      created_at: nowIso(),
    });

    const next = ORDER_STATUS_FOR_DELIVERY[status];
    if (next) {
      const order = db.orders.find((o) => o.id === record.order_id);
      if (order && order.status !== next && order.status !== 'cancelled') {
        db.history.push({
          order_id: order.id,
          from_status: order.status,
          to_status: next,
          changed_by: actorId,
          note: `Grab: ${status}`,
          created_at: nowIso(),
        });
        order.status = next;
      }
    }
    return record;
  }

  // ----------------------------------------------------------------- orders

  function loadOrder(id) {
    const order = db.orders.find((o) => o.id === Number(id));
    if (!order) return null;
    const items = db.orderItems
      .filter((i) => i.order_id === order.id)
      .map((i) => ({ ...i, options: db.orderItemOptions.filter((o) => o.order_item_id === i.id) }));
    const history = db.history
      .filter((h) => h.order_id === order.id)
      .map((h) => ({ ...h, changed_by_name: db.users.find((u) => u.id === h.changed_by)?.name ?? null }));
    return { ...order, items, history, delivery: deliveryForOrder(order.id) };
  }

  const orderNumberFor = (id) => `OK-${String(240000 + id).padStart(6, '0')}`;

  // ------------------------------------------------------------ route table

  const routes = [
    // ---------------------------------------------------------------- auth
    ['POST', /^\/auth\/login$/, async (m, body) => {
      const email = String(body.email ?? '').toLowerCase().trim();
      const user = db.users.find((u) => u.email === email);
      // Same message either way, so this never confirms which emails exist.
      if (!user) throw unauthorized('Email or password is incorrect');
      if (!user.is_active) throw unauthorized('This account has been deactivated');
      if (!(await auth.verifyPassword(body.password ?? '', user.password_hash))) {
        throw unauthorized('Email or password is incorrect');
      }
      return { token: await auth.signToken(user), user: publicUser(user) };
    }],

    ['POST', /^\/auth\/register$/, async (m, body) => {
      const email = String(body.email ?? '').toLowerCase().trim();
      if (!email.includes('@')) throw bad('Enter a valid email');
      if (String(body.password ?? '').length < 8) throw bad('Password must be at least 8 characters');
      if (String(body.name ?? '').trim().length < 2) throw bad('Enter your name');
      if (db.users.some((u) => u.email === email)) throw conflict('That email is already registered');

      const user = {
        id: nextId('user'),
        email,
        password_hash: await auth.hashPassword(body.password),
        name: body.name.trim(),
        phone: body.phone ?? null,
        role: 'customer',
        is_active: 1,
        created_at: nowIso(),
      };
      db.users.push(user);
      return { token: await auth.signToken(user), user: publicUser(user) };
    }],

    ['GET', /^\/auth\/me$/, async (m, body, user) => ({ user: publicUser(requireUser(user)) })],

    ['PATCH', /^\/auth\/me$/, async (m, body, user) => {
      requireUser(user);
      if (body.email !== undefined) user.email = changeEmail(user, body.email);
      if (body.name !== undefined) user.name = body.name;
      if (body.phone !== undefined) user.phone = body.phone;
      if (body.password) user.password_hash = await auth.hashPassword(body.password);
      return { user: publicUser(user) };
    }],

    /**
     * Sign in with Google.
     *
     * The account is created here rather than when someone types an address
     * at checkout, because typing an address proves nothing — Google vouching
     * for it does. An unverified Google address is refused for the same
     * reason.
     *
     * An existing account with that address is signed into, not duplicated:
     * Google confirming the address means this is the same person, whether
     * they had a password or not.
     */
    ['POST', /^\/auth\/google$/, async (m, body) => {
      if (!googleAuth?.verify) throw bad('Google sign-in is not configured for this shop');
      if (!body.credential) throw bad('Missing Google credential');

      const profile = await googleAuth.verify(body.credential, db.settings.google_client_id);
      if (!profile?.email) throw unauthorized('Google did not return an email address');
      if (!profile.email_verified) {
        throw unauthorized('That Google account has an unverified email address');
      }

      const email = String(profile.email).toLowerCase().trim();
      let user = db.users.find((u) => u.email === email);

      if (user) {
        if (!user.is_active) throw unauthorized('This account has been deactivated');
        // Remember the Google identity so the link survives an email change.
        if (!user.google_sub) user.google_sub = profile.sub;
      } else {
        user = {
          id: nextId('user'),
          email,
          // No password: this account is reached through Google until its
          // owner sets one. verifyPassword refuses a non-bcrypt hash.
          password_hash: null,
          google_sub: profile.sub,
          name: profile.name || email.split('@')[0],
          phone: null,
          role: 'customer',
          is_active: 1,
          created_at: nowIso(),
        };
        db.users.push(user);
        audit(user, 'user.google_signup', 'user', user.id, { email });
      }

      return { token: await auth.signToken(user), user: publicUser(user), created: !user.password_hash };
    }],

    // ------------------------------------------------------------- catalog
    ['GET', /^\/catalog\/menu$/, async (m, body, user) => buildMenu(user)],

    ['POST', /^\/catalog\/products$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      const p = {
        id: nextId('product'),
        category_id: Number(body.category_id),
        name: body.name,
        slug: body.slug || slugify(body.name),
        description: body.description ?? null,
        base_price: Number(body.base_price),
        image_url: body.image_url || null,
        is_active: body.is_active === false ? 0 : 1,
        track_stock: body.track_stock ? 1 : 0,
        stock_qty: Number(body.stock_qty ?? 0),
        sort_order: Number(body.sort_order ?? 0),
      };
      db.products.push(p);
      setProductGroups(p.id, body.option_group_ids ?? []);
      audit(user, 'product.create', 'product', p.id, { name: p.name });
      return p;
    }],

    ['PATCH', /^\/catalog\/products\/(\d+)$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      const p = db.products.find((x) => x.id === Number(m[1]));
      if (!p) throw notFound('Product not found');
      for (const k of ['category_id', 'name', 'description', 'base_price', 'sort_order', 'stock_qty']) {
        if (body[k] !== undefined) p[k] = body[k];
      }
      if (body.image_url !== undefined) p.image_url = body.image_url || null;
      if (body.is_active !== undefined) p.is_active = body.is_active ? 1 : 0;
      if (body.track_stock !== undefined) p.track_stock = body.track_stock ? 1 : 0;
      if (body.option_group_ids) setProductGroups(p.id, body.option_group_ids);
      audit(user, 'product.update', 'product', p.id, body);
      return p;
    }],

    ['DELETE', /^\/catalog\/products\/(\d+)$/, async (m, body, user) => {
      requireRole(user, 'admin');
      const id = Number(m[1]);
      const p = db.products.find((x) => x.id === id);
      if (!p) throw notFound('Product not found');
      // Keep order history readable; hide it from the menu instead.
      if (db.orderItems.some((i) => i.product_id === id)) {
        p.is_active = 0;
        audit(user, 'product.deactivate', 'product', id, { reason: 'has orders' });
        return { deactivated: true, deleted: false };
      }
      db.products = db.products.filter((x) => x.id !== id);
      db.productOptionGroups = db.productOptionGroups.filter((l) => l.product_id !== id);
      audit(user, 'product.delete', 'product', id);
      return { deactivated: false, deleted: true };
    }],

    ['POST', /^\/catalog\/options$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      const o = {
        id: nextId('option'),
        group_id: Number(body.group_id),
        name: body.name,
        description: body.description ?? null,
        price_delta: Number(body.price_delta),
        image_url: body.image_url || null,
        is_available: body.is_available === false ? 0 : 1,
        track_stock: body.track_stock ? 1 : 0,
        stock_qty: Number(body.stock_qty ?? 0),
        sort_order: Number(body.sort_order ?? 0),
      };
      db.options.push(o);
      audit(user, 'option.create', 'option', o.id, { name: o.name });
      return o;
    }],

    ['PATCH', /^\/catalog\/options\/(\d+)$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      const o = db.options.find((x) => x.id === Number(m[1]));
      if (!o) throw notFound('Option not found');
      for (const k of ['group_id', 'name', 'description', 'price_delta', 'sort_order', 'stock_qty']) {
        if (body[k] !== undefined) o[k] = body[k];
      }
      if (body.image_url !== undefined) o.image_url = body.image_url || null;
      if (body.is_available !== undefined) o.is_available = body.is_available ? 1 : 0;
      if (body.track_stock !== undefined) o.track_stock = body.track_stock ? 1 : 0;
      audit(user, 'option.update', 'option', o.id, body);
      return o;
    }],

    ['DELETE', /^\/catalog\/options\/(\d+)$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      const id = Number(m[1]);
      const o = db.options.find((x) => x.id === id);
      if (!o) throw notFound('Option not found');
      if (db.orderItemOptions.some((x) => x.option_id === id)) {
        o.is_available = 0;
        audit(user, 'option.deactivate', 'option', id, { reason: 'has orders' });
        return { deactivated: true, deleted: false };
      }
      db.options = db.options.filter((x) => x.id !== id);
      audit(user, 'option.delete', 'option', id);
      return { deactivated: false, deleted: true };
    }],

    ['POST', /^\/catalog\/option-groups$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      const g = {
        id: nextId('group'),
        name: body.name,
        slug: body.slug || slugify(body.name),
        description: body.description ?? null,
        input_type: body.input_type,
        min_select: Number(body.min_select ?? 0),
        max_select: Number(body.max_select ?? 0),
        is_required: body.is_required ? 1 : 0,
        sort_order: Number(body.sort_order ?? 0),
        is_active: 1,
      };
      const problem = groupRuleProblem(g);
      if (problem) throw bad(problem);

      db.optionGroups.push(g);
      audit(user, 'option_group.create', 'option_group', g.id, { name: g.name });
      return g;
    }],

    ['PATCH', /^\/catalog\/option-groups\/(\d+)$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      const g = db.optionGroups.find((x) => x.id === Number(m[1]));
      if (!g) throw notFound('Option group not found');
      const snapshot = { ...g };
      for (const k of ['name', 'description', 'input_type', 'min_select', 'max_select', 'sort_order']) {
        if (body[k] !== undefined) g[k] = body[k];
      }
      if (body.is_required !== undefined) g.is_required = body.is_required ? 1 : 0;
      if (body.is_active !== undefined) g.is_active = body.is_active ? 1 : 0;

      const problem = groupRuleProblem(g);
      if (problem) {
        // Nothing is saved on a contradiction; put the group back as it was.
        Object.assign(g, snapshot);
        throw bad(problem);
      }

      audit(user, 'option_group.update', 'option_group', g.id, body);
      return g;
    }],

    ['POST', /^\/catalog\/categories$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      const c = {
        id: nextId('category'),
        name: body.name,
        slug: body.slug || slugify(body.name),
        sort_order: Number(body.sort_order ?? 0),
        is_active: body.is_active === false ? 0 : 1,
      };
      db.categories.push(c);
      audit(user, 'category.create', 'category', c.id, { name: c.name });
      return c;
    }],

    ['PATCH', /^\/catalog\/categories\/(\d+)$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      const c = db.categories.find((x) => x.id === Number(m[1]));
      if (!c) throw notFound('Category not found');
      if (body.name !== undefined) c.name = body.name;
      if (body.sort_order !== undefined) c.sort_order = body.sort_order;
      if (body.is_active !== undefined) c.is_active = body.is_active ? 1 : 0;
      return c;
    }],

    /**
     * Just the shop's public settings. The storefront header needs the name
     * and logo on every page and has no use for the whole catalog.
     */
    ['GET', /^\/catalog\/settings$/, async (m, body, user) => buildMenu(user).settings],

    // -------------------------------------------------------------- orders
    ['POST', /^\/orders\/quote$/, async (m, body) => {
      const { items, subtotal } = priceCart(db, body.items);

      let deliveryQuote = null;
      if (body.fulfillment_type === 'delivery' && body.delivery_lat != null) {
        assertWithinRange({ lat: body.delivery_lat, lng: body.delivery_lng });
        deliveryQuote = await delivery.quote({
          pickup: pickupPlace(),
          dropoff: {
            address: body.delivery_address,
            lat: Number(body.delivery_lat),
            lng: Number(body.delivery_lng),
          },
        });
      }

      const totals = totalsFor({
        subtotal,
        deliveryFee: deliveryQuote?.fee ?? 0,
        taxRate: db.settings.tax_rate,
      });

      return {
        items,
        ...totals,
        currency: db.settings.currency,
        delivery_quote: deliveryQuote,
        pickup_address: db.settings.pickup_address,
        order_lead_mins: Number(db.settings.order_lead_mins),
        min_order_total: Number(db.settings.min_order_total),
        meets_minimum: subtotal >= Number(db.settings.min_order_total),
      };
    }],

    ['POST', /^\/orders$/, async (m, body, user) => {
      if (body.fulfillment_type === 'delivery' && !db.settings.delivery_enabled) {
        throw bad('Delivery is switched off right now');
      }
      const { items, subtotal } = priceCart(db, body.items);
      if (subtotal < Number(db.settings.min_order_total)) {
        throw bad(`Minimum order is ${db.settings.currency} ${Number(db.settings.min_order_total).toFixed(2)}`);
      }

      // The delivery fee is re-quoted here; a fee sent by the client is ignored.
      let deliveryFee = 0;
      if (body.fulfillment_type === 'delivery') {
        if (body.delivery_lat == null || body.delivery_lng == null) {
          throw bad('Delivery orders need an address with coordinates');
        }
        assertWithinRange({ lat: body.delivery_lat, lng: body.delivery_lng });
        const q = await delivery.quote({
          pickup: pickupPlace(),
          dropoff: {
            address: body.delivery_address,
            lat: Number(body.delivery_lat),
            lng: Number(body.delivery_lng),
          },
        });
        deliveryFee = q.fee;
      }

      const totals = totalsFor({ subtotal, deliveryFee, taxRate: db.settings.tax_rate });
      const id = nextId('order');

      db.orders.push({
        id,
        order_number: orderNumberFor(id),
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
        currency: db.settings.currency,
        payment_method: body.payment_method ?? 'cash',
        payment_status: 'unpaid',
        notes: body.notes ?? null,
        scheduled_for: body.scheduled_for ?? null,
        cancelled_reason: null,
        created_at: nowIso(),
      });

      for (const item of items) {
        const itemId = nextId('item');
        db.orderItems.push({
          id: itemId,
          order_id: id,
          product_id: item.product_id,
          product_name: item.product_name,
          quantity: item.quantity,
          unit_base_price: item.unit_base_price,
          unit_options_price: item.unit_options_price,
          line_total: item.line_total,
          notes: item.notes,
        });
        for (const o of item.options) {
          db.orderItemOptions.push({ id: nextId('optRow'), order_item_id: itemId, ...o });
        }

        const product = db.products.find((p) => p.id === item.product_id);
        if (product?.track_stock) product.stock_qty = Math.max(0, product.stock_qty - item.quantity);
        for (const o of item.options) {
          const opt = db.options.find((x) => x.id === o.option_id);
          if (opt?.track_stock) opt.stock_qty = Math.max(0, opt.stock_qty - item.quantity);
        }
      }

      db.history.push({
        order_id: id,
        from_status: null,
        to_status: 'pending',
        changed_by: user?.id ?? null,
        note: 'Order placed',
        created_at: nowIso(),
      });
      audit(user, 'order.create', 'order', id, { order_number: orderNumberFor(id) });
      return loadOrder(id);
    }],

    ['GET', /^\/orders\/queue$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      const orders = db.orders
        .filter((o) => !['completed', 'cancelled'].includes(o.status))
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .map((o) => {
          const d = deliveryForOrder(o.id);
          return {
            ...o,
            customer_name: db.users.find((u) => u.id === o.customer_id)?.name ?? null,
            delivery_status: d?.status ?? null,
            driver_name: d?.driver_name ?? null,
            driver_phone: d?.driver_phone ?? null,
            tracking_url: d?.tracking_url ?? null,
            age_minutes: Math.max(0, Math.round((Date.now() - new Date(o.created_at)) / 60000)),
            items: db.orderItems.filter((i) => i.order_id === o.id).map((i) => ({
              ...i,
              option_summary: db.orderItemOptions
                .filter((x) => x.order_item_id === i.id)
                .map((x) => `${x.group_name}: ${x.option_name}`)
                .join(' | ') || null,
            })),
          };
        });
      return { orders };
    }],

    // Declared before /orders/:id so a two-segment path cannot be read as an id.
    ['GET', /^\/orders\/track\/([^/?]+)$/, async (m, body, user, query) => {
      const order = db.orders.find(
        (o) => o.order_number === decodeURIComponent(m[1]) && o.contact_phone === query.get('phone'),
      );
      if (!order) throw notFound('No order matches that number and phone');
      return loadOrder(order.id);
    }],

    ['GET', /^\/orders\/(\d+)$/, async (m, body, user) => {
      const order = loadOrder(m[1]);
      if (!order) throw notFound('Order not found');
      if (!isStaff(user) && (!user || order.customer_id !== user.id)) {
        throw forbidden('That is not your order');
      }
      return order;
    }],

    ['GET', /^\/orders$/, async (m, body, user, query) => {
      requireUser(user);
      const limit = Math.min(200, Math.max(1, Number(query.get('limit') ?? 50)));
      const offset = Math.max(0, Number(query.get('offset') ?? 0));
      const statuses = (query.get('status') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const type = query.get('fulfillment_type');
      const search = (query.get('search') ?? '').toLowerCase();

      let rows = db.orders.filter((o) => (isStaff(user) ? true : o.customer_id === user.id));
      if (statuses.length) rows = rows.filter((o) => statuses.includes(o.status));
      if (type) rows = rows.filter((o) => o.fulfillment_type === type);
      if (search) {
        rows = rows.filter((o) =>
          o.order_number.toLowerCase().includes(search) ||
          o.contact_name.toLowerCase().includes(search) ||
          (o.contact_phone ?? '').includes(search));
      }
      rows = rows.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      const total = rows.length;
      const page = rows.slice(offset, offset + limit).map((o) => {
        const d = deliveryForOrder(o.id);
        return {
          ...o,
          customer_name: db.users.find((u) => u.id === o.customer_id)?.name ?? null,
          item_count: db.orderItems.filter((i) => i.order_id === o.id).length,
          delivery_status: d?.status ?? null,
          driver_name: d?.driver_name ?? null,
          tracking_url: d?.tracking_url ?? null,
        };
      });
      return { orders: page, total, limit, offset };
    }],

    ['PATCH', /^\/orders\/(\d+)\/status$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      const order = db.orders.find((o) => o.id === Number(m[1]));
      if (!order) throw notFound('Order not found');
      const allowed = TRANSITIONS[order.status] ?? [];
      if (!allowed.includes(body.status)) {
        throw bad(`Cannot move an order from "${order.status}" to "${body.status}"`, { allowed });
      }
      db.history.push({
        order_id: order.id,
        from_status: order.status,
        to_status: body.status,
        changed_by: user.id,
        note: body.note ?? body.reason ?? null,
        created_at: nowIso(),
      });
      order.status = body.status;
      order.cancelled_reason = body.status === 'cancelled' ? body.reason ?? null : null;
      audit(user, 'order.status', 'order', order.id, { from: allowed, to: body.status });
      return loadOrder(order.id);
    }],

    ['PATCH', /^\/orders\/(\d+)\/payment$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      const order = db.orders.find((o) => o.id === Number(m[1]));
      if (!order) throw notFound('Order not found');
      order.payment_status = body.payment_status;
      if (body.payment_method) order.payment_method = body.payment_method;
      audit(user, 'order.payment', 'order', order.id, body);
      return loadOrder(order.id);
    }],

    ['POST', /^\/orders\/(\d+)\/cancel$/, async (m, body, user) => {
      requireUser(user);
      const order = db.orders.find((o) => o.id === Number(m[1]));
      if (!order) throw notFound('Order not found');
      if (!isStaff(user) && order.customer_id !== user.id) throw forbidden('That is not your order');
      if (!isStaff(user) && order.status !== 'pending') {
        throw bad('This order is already being prepared — call the shop to cancel');
      }
      if (order.status === 'cancelled') throw bad('Already cancelled');

      const reason = body.reason ?? 'Cancelled by customer';
      db.history.push({
        order_id: order.id,
        from_status: order.status,
        to_status: 'cancelled',
        changed_by: user.id,
        note: reason,
        created_at: nowIso(),
      });
      order.status = 'cancelled';
      order.cancelled_reason = reason;
      audit(user, 'order.cancel', 'order', order.id, { reason });
      return loadOrder(order.id);
    }],

    // ------------------------------------------------------------ delivery
    ['POST', /^\/delivery\/quote$/, async (m, body) => {
      if (body.lat == null || body.lng == null) {
        throw bad('Delivery quote needs a latitude and longitude');
      }
      assertWithinRange({ lat: body.lat, lng: body.lng });
      return delivery.quote({
        pickup: pickupPlace(),
        dropoff: { address: body.address, lat: Number(body.lat), lng: Number(body.lng) },
      });
    }],

    ['POST', /^\/delivery\/orders\/(\d+)\/book$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      const orderId = Number(m[1]);
      const order = db.orders.find((o) => o.id === orderId);
      if (!order) throw notFound('Order not found');
      if (order.fulfillment_type !== 'delivery') throw bad('This order is for pickup, not delivery');
      if (order.delivery_lat == null) throw bad('Order has no delivery coordinates');
      if (order.status === 'cancelled') throw bad('Order is cancelled');

      const existing = deliveryForOrder(orderId);
      if (existing && !['cancelled', 'failed'].includes(existing.status)) {
        return { delivery: existing, reused: true };
      }

      const pickup = pickupPlace();
      const dropoff = {
        address: order.delivery_address,
        lat: Number(order.delivery_lat),
        lng: Number(order.delivery_lng),
      };
      const quote = await delivery.quote({ pickup, dropoff });
      const booking = await delivery.book({
        quote,
        pickup,
        dropoff,
        orderNumber: order.order_number,
        sender: { name: pickup.name, phone: pickup.phone },
        recipient: { name: order.contact_name, phone: order.contact_phone },
      });

      const record = {
        id: nextId('delivery'),
        order_id: orderId,
        provider: booking.provider ?? 'grab',
        provider_delivery_id: booking.provider_delivery_id,
        quote_id: quote.quote_id ?? null,
        status: booking.status ?? 'allocating',
        fee: booking.fee ?? quote.fee ?? 0,
        currency: booking.currency ?? 'PHP',
        distance_km: booking.distance_km ?? quote.distance_km ?? null,
        driver_name: null,
        driver_phone: null,
        driver_plate: null,
        driver_photo_url: null,
        driver_lat: null,
        driver_lng: null,
        tracking_url: booking.tracking_url ?? null,
        pickup_eta: booking.pickup_eta ?? null,
        dropoff_eta: booking.dropoff_eta ?? null,
        raw_payload: booking.raw ?? null,
        created_at: nowIso(),
      };
      db.deliveries.push(record);
      db.deliveryEvents.push({
        id: nextId('event'),
        delivery_id: record.id,
        status: record.status,
        description: 'Booking created',
        lat: null,
        lng: null,
        created_at: nowIso(),
      });

      if (order.status !== 'dispatched') {
        db.history.push({
          order_id: orderId,
          from_status: order.status,
          to_status: 'dispatched',
          changed_by: user.id,
          note: 'Grab driver requested',
          created_at: nowIso(),
        });
        order.status = 'dispatched';
      }

      audit(user, 'delivery.book', 'order', orderId);
      return { delivery: deliveryForOrder(orderId), reused: false };
    }],

    ['POST', /^\/delivery\/orders\/(\d+)\/cancel$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      const orderId = Number(m[1]);
      const record = db.deliveries.find(
        (d) => d.order_id === orderId && !['cancelled', 'completed'].includes(d.status),
      );
      if (!record) throw notFound('No delivery booked for this order');

      await delivery.cancel(record.provider_delivery_id, body.reason);
      recordDeliveryEvent({
        providerDeliveryId: record.provider_delivery_id,
        status: 'cancelled',
        description: body.reason || 'Cancelled by staff',
      }, user.id);

      const order = db.orders.find((o) => o.id === orderId);
      if (order?.status === 'dispatched') {
        db.history.push({
          order_id: orderId,
          from_status: 'dispatched',
          to_status: 'ready',
          changed_by: user.id,
          note: 'Grab booking cancelled',
          created_at: nowIso(),
        });
        order.status = 'ready';
      }

      audit(user, 'delivery.cancel', 'order', orderId, { reason: body.reason });
      return { delivery: deliveryForOrder(orderId) };
    }],

    ['GET', /^\/delivery\/orders\/(\d+)$/, async (m, body, user, query) => {
      const orderId = Number(m[1]);
      const order = db.orders.find((o) => o.id === orderId);
      if (!order) throw notFound('Order not found');
      if (!isStaff(user) && order.customer_id !== user?.id) throw forbidden('That is not your order');

      const record = db.deliveries.find((d) => d.order_id === orderId);
      const wantsRefresh = query.get('refresh') === '1' || query.get('refresh') === 'true';
      if (record && wantsRefresh && delivery.track) {
        const live = await delivery.track(record.provider_delivery_id).catch(() => null);
        if (live && (live.status !== record.status || live.location)) {
          recordDeliveryEvent({
            providerDeliveryId: record.provider_delivery_id,
            status: live.status,
            description: 'Polled from provider',
            driver: live.driver,
            location: live.location,
          });
        }
      }
      return { delivery: deliveryForOrder(orderId) };
    }],

    ['POST', /^\/delivery\/simulate\/(\d+)\/advance$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      if (!delivery.advance) throw bad('Simulation is not available with this delivery provider');
      const orderId = Number(m[1]);
      const record = db.deliveries.find((d) => d.order_id === orderId);
      if (!record) throw notFound('No delivery booked for this order');

      // The provider is stateless about progress — current status comes from
      // our own record, so a restart cannot lose an in-flight simulation.
      const next = await delivery.advance(record.provider_delivery_id, record.status);
      if (!next) throw bad(`Delivery is already ${record.status}`);
      recordDeliveryEvent({
        providerDeliveryId: record.provider_delivery_id,
        status: next.status,
        description: next.description,
        driver: next.driver,
        location: next.location,
      }, user.id);
      return { delivery: deliveryForOrder(orderId) };
    }],

    // --------------------------------------------------------------- admin
    ['GET', /^\/admin\/users$/, async (m, body, user, query) => {
      requireRole(user, 'admin');
      const role = query.get('role');
      const search = (query.get('search') ?? '').toLowerCase();
      let rows = [...db.users];
      if (role) rows = rows.filter((u) => u.role === role);
      if (search) {
        rows = rows.filter((u) =>
          u.name.toLowerCase().includes(search) ||
          u.email.toLowerCase().includes(search) ||
          (u.phone ?? '').includes(search));
      }
      const users = rows.map((u) => {
        const theirs = db.orders.filter((o) => o.customer_id === u.id);
        return {
          ...publicUser(u),
          is_active: u.is_active,
          created_at: u.created_at,
          order_count: theirs.length,
          lifetime_value: round2(
            theirs.filter((o) => o.status === 'completed').reduce((s, o) => s + o.total, 0),
          ),
        };
      });
      return { users, total: users.length, limit: users.length, offset: 0 };
    }],

    ['POST', /^\/admin\/users$/, async (m, body, user) => {
      requireRole(user, 'admin');
      const email = String(body.email).toLowerCase().trim();
      if (db.users.some((u) => u.email === email)) throw conflict('That email is already registered');
      if (String(body.password ?? '').length < 8) throw bad('Password must be at least 8 characters');

      const u = {
        id: nextId('user'),
        email,
        password_hash: await auth.hashPassword(body.password),
        name: body.name,
        phone: body.phone ?? null,
        role: body.role,
        is_active: 1,
        created_at: nowIso(),
      };
      db.users.push(u);
      audit(user, 'user.create', 'user', u.id, { email, role: u.role });
      return { ...publicUser(u), is_active: u.is_active };
    }],

    ['PATCH', /^\/admin\/users\/(\d+)$/, async (m, body, user) => {
      requireRole(user, 'admin');
      const target = db.users.find((u) => u.id === Number(m[1]));
      if (!target) throw notFound('User not found');

      // Keep at least one active admin so nobody locks themselves out.
      const losingAdmin = target.role === 'admin' &&
        ((body.role && body.role !== 'admin') || body.is_active === false);
      if (losingAdmin && !db.users.some((u) => u.role === 'admin' && u.is_active && u.id !== target.id)) {
        throw bad('This is the last active admin');
      }

      if (body.email !== undefined) target.email = changeEmail(target, body.email);
      for (const k of ['name', 'phone', 'role']) if (body[k] !== undefined) target[k] = body[k];
      if (body.is_active !== undefined) target.is_active = body.is_active ? 1 : 0;
      if (body.password) target.password_hash = await auth.hashPassword(body.password);
      audit(user, 'user.update', 'user', target.id, { ...body, password: undefined });
      return { ...publicUser(target), is_active: target.is_active };
    }],

    ['GET', /^\/admin\/settings$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      return { settings: { ...db.settings }, grab_mode: db.settings.grab_mode ?? 'sim' };
    }],

    ['PUT', /^\/admin\/settings$/, async (m, body, user) => {
      requireRole(user, 'admin');
      const allowed = [
        'shop_name', 'logo_url', 'hero_image_url', 'show_included_label',
        'google_client_id',
        'currency', 'tax_rate', 'pickup_address', 'pickup_lat', 'pickup_lng',
        'pickup_phone', 'min_order_total', 'delivery_enabled', 'order_lead_mins',
        'max_delivery_km', 'grab_mode',
      ];
      const patch = {};
      for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
      if (!Object.keys(patch).length) throw bad('Nothing to update');

      if (patch.grab_mode !== undefined) {
        if (!['sim', 'live'].includes(patch.grab_mode)) {
          throw bad('Delivery mode must be "sim" or "live"');
        }
        const unavailable = await delivery.whyUnavailable?.(patch.grab_mode);
        if (unavailable) throw bad(unavailable);
      }

      for (const k of ['logo_url', 'hero_image_url']) {
        if (patch[k] === undefined) continue;
        const value = String(patch[k] ?? '').trim();
        if (value.length > MAX_IMAGE_CHARS) {
          throw bad(
            `That image is too large (${Math.round(value.length / 1024)} KB). ` +
              `Keep it under ${Math.round(MAX_IMAGE_CHARS / 1024)} KB — the whole store is ` +
              'rewritten on every order, so a big picture slows every save.',
          );
        }
        if (value && !/^(https?:\/\/|data:image\/)/.test(value)) {
          throw bad('An image must be an https:// address or an uploaded picture');
        }
        patch[k] = value;
      }
      Object.assign(db.settings, patch);
      audit(user, 'settings.update', 'settings', null, patch);
      return { settings: { ...db.settings } };
    }],

    ['GET', /^\/admin\/stats$/, async (m, body, user, query) => {
      requireRole(user, 'admin', 'manager');
      const days = Math.min(365, Math.max(1, Number(query.get('days') ?? 30)));
      const since = Date.now() - days * 86_400_000;

      const inWindow = db.orders.filter((o) => new Date(o.created_at).getTime() >= since);
      const counted = inWindow.filter((o) => o.status !== 'cancelled');
      const todayKey = new Date().toDateString();
      const todays = db.orders.filter((o) => new Date(o.created_at).toDateString() === todayKey);

      const byDay = new Map();
      for (const o of inWindow) {
        const key = new Date(o.created_at).toISOString().slice(0, 10);
        const row = byDay.get(key) ?? { day: key, orders: 0, revenue: 0 };
        row.orders += 1;
        if (o.status !== 'cancelled') row.revenue = round2(row.revenue + o.total);
        byDay.set(key, row);
      }

      const countedIds = new Set(counted.map((o) => o.id));
      const itemsInWindow = db.orderItems.filter((i) => countedIds.has(i.order_id));
      const itemIds = new Set(itemsInWindow.map((i) => i.id));

      const productTotals = new Map();
      for (const i of itemsInWindow) {
        const row = productTotals.get(i.product_name) ??
          { product_name: i.product_name, qty: 0, revenue: 0 };
        row.qty += i.quantity;
        row.revenue = round2(row.revenue + i.line_total);
        productTotals.set(i.product_name, row);
      }

      const optionTotals = new Map();
      for (const o of db.orderItemOptions) {
        if (!itemIds.has(o.order_item_id)) continue;
        const key = `${o.group_name}|${o.option_name}`;
        const row = optionTotals.get(key) ??
          { group_name: o.group_name, option_name: o.option_name, picks: 0 };
        row.picks += 1;
        optionTotals.set(key, row);
      }

      const statusTotals = new Map();
      for (const o of inWindow) statusTotals.set(o.status, (statusTotals.get(o.status) ?? 0) + 1);

      return {
        days,
        today: {
          orders: todays.length,
          revenue: round2(todays.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + o.total, 0)),
        },
        period: {
          orders: inWindow.length,
          revenue: round2(counted.reduce((s, o) => s + o.total, 0)),
          avg_order_value: counted.length
            ? round2(counted.reduce((s, o) => s + o.total, 0) / counted.length)
            : 0,
        },
        open_orders: db.orders.filter((o) => !['completed', 'cancelled'].includes(o.status)).length,
        by_status: [...statusTotals].map(([status, n]) => ({ status, n })),
        daily: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
        top_products: [...productTotals.values()].sort((a, b) => b.qty - a.qty).slice(0, 10),
        top_options: [...optionTotals.values()].sort((a, b) => b.picks - a.picks).slice(0, 15),
        fulfillment: ['pickup', 'delivery'].map((t) => ({
          fulfillment_type: t,
          n: inWindow.filter((o) => o.fulfillment_type === t).length,
          delivery_fees: round2(
            inWindow.filter((o) => o.fulfillment_type === t).reduce((s, o) => s + o.delivery_fee, 0),
          ),
        })),
      };
    }],

    ['GET', /^\/admin\/audit$/, async (m, body, user, query) => {
      requireRole(user, 'admin');
      const limit = Math.min(500, Math.max(1, Number(query.get('limit') ?? 100)));
      return { entries: db.audit.slice(0, limit) };
    }],

    /**
     * Removes every order. The menu, accounts and settings are untouched.
     *
     * Being signed in as an admin is not enough: the password is asked for
     * again, because this is irreversible and an admin session left open on a
     * shop counter is the likely way it gets triggered by accident.
     */
    ['POST', /^\/admin\/orders\/clear$/, async (m, body, user) => {
      requireRole(user, 'admin');

      if (!user.password_hash) {
        throw bad(
          'This account signs in with Google and has no password. ' +
            'Set one under your account first, so this can be confirmed.',
        );
      }
      if (!body.password) throw bad('Enter your password to confirm');
      if (!(await auth.verifyPassword(body.password, user.password_hash))) {
        throw unauthorized('That password is not correct');
      }

      const { removed } = clearOrders(db);
      // Logged after the wipe, which also clears the log — so this entry is
      // the first thing in it, and the deletion leaves a trace.
      audit(user, 'orders.clear', null, null, { removed });
      return { removed };
    }],
  ];

  /** Methods whose handlers may have mutated state and so need persisting. */
  const WRITES = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

  /**
   * Routes that create something answer 201. Declared here rather than
   * inferred from the response shape, which was guesswork.
   */
  const CREATED = new Map([
    ['POST /auth/register', () => 201],
    ['POST /catalog/products', () => 201],
    ['POST /catalog/options', () => 201],
    ['POST /catalog/option-groups', () => 201],
    ['POST /catalog/categories', () => 201],
    ['POST /orders', () => 201],
    ['POST /admin/users', () => 201],
    // Re-booking an order that already has a live driver is not a creation.
    ['POST /delivery/book', (result) => (result?.reused ? 200 : 201)],
  ]);

  const statusFor = (method, rawPath, result) => {
    const key = /^\/delivery\/orders\/\d+\/book$/.test(rawPath)
      ? 'POST /delivery/book'
      : `${method} ${rawPath}`;
    return CREATED.get(key)?.(result) ?? 200;
  };

  return {
    /**
     * @returns {{status: number, body: any}} — throws AppError for anything a
     *          client should see as a 4xx.
     */
    async handle(method, path, body, token) {
      const [rawPath, search] = String(path).split('?');
      const query = new URLSearchParams(search ?? '');
      const user = await userFromToken(token);

      for (const [verb, pattern, handler] of routes) {
        if (verb !== method) continue;
        const match = rawPath.match(pattern);
        if (!match) continue;

        const result = await handler(match, body ?? {}, user, query);
        // A GET can still write — a polled delivery refresh records an event.
        if (WRITES.has(method) || rawPath.startsWith('/delivery/orders/')) {
          await persist?.(db);
        }
        return { status: statusFor(method, rawPath, result), body: result };
      }

      throw notFound(`No route for ${method} ${rawPath}`);
    },

    /** Used by the Grab webhook, which arrives outside the route table. */
    async applyDeliveryEvent(event) {
      const record = recordDeliveryEvent(event);
      if (record) await persist?.(db);
      return record;
    },

    getState: () => db,

    async replaceState(next) {
      db = next;
      await persist?.(db);
      return db;
    },
  };
}

export { AppError };
