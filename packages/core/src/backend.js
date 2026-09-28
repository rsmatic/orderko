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
import { phoneKey, looksLikePhone } from './phone.js';

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
    // What each seller sets for themselves: where they are collected from,
    // where their money goes, what they charge to deliver. Anything they leave
    // empty falls back to the shop's own setting.
    sellerProfiles: [],
    audit: [],
    seq: {
      user: 4,
      product: 6,
      group: 9,
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

  /**
   * Several sellers can share one shop. A product belongs to a user, and a
   * manager sees only their own — unless an admin has given them the run of
   * the place.
   *
   * An admin always can; there is no point in a shop owner who has to grant
   * themselves permission, and no way to recover if they revoked it.
   */
  const managesEverything = (u) => Boolean(u) &&
    // Absent means the run of the shop, which is what every manager had
    // before sellers existed. Upgrading an existing shop must not leave its
    // manager staring at an empty board; only an admin deliberately turning
    // this off should narrow what they see.
    (u.role === 'admin' || u.manages_all_products !== false);

  /** A product with no owner belongs to the shop, which only an admin runs. */
  const ownsProduct = (u, product) =>
    managesEverything(u) || (product?.owner_id != null && product.owner_id === u?.id);

  const requireOwnership = (u, product) => {
    if (!ownsProduct(u, product)) throw forbidden('That product belongs to someone else');
    return product;
  };

  /**
   * The single seller behind an order, or null when it has items from more
   * than one — or none that are owned.
   *
   * Mixed orders are nobody's in particular, so they stay with the admins.
   * The alternative is an order that no seller can see and therefore nobody
   * makes.
   */
  function ownerOfOrder(orderId) {
    const owners = new Set(
      db.orderItems.filter((i) => i.order_id === orderId).map((i) => i.owner_id ?? null),
    );
    return owners.size === 1 ? [...owners][0] : null;
  }

  const canSeeOrder = (u, orderId) =>
    managesEverything(u) || ownerOfOrder(orderId) === u?.id;

  const requireOrderAccess = (u, orderId) => {
    if (!canSeeOrder(u, orderId)) throw forbidden('That order belongs to another seller');
  };
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

  /**
   * Finds the account behind whatever was typed into the sign-in box: an
   * email address, or the mobile number the account was registered with.
   */
  function findByIdentifier(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return null;
    if (!looksLikePhone(text)) {
      const email = text.toLowerCase();
      return db.users.find((u) => u.email === email) ?? null;
    }
    const key = phoneKey(text);
    if (!key) return null;
    const matches = db.users.filter((u) => phoneKey(u.phone) === key);
    // Two accounts on one number would make this a coin toss. assertPhoneFree
    // stops new pairs being created, but older data may already hold one, and
    // signing someone into the wrong account is worse than refusing them.
    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * A mobile number can now be used to sign in, so it has to point at a single
   * account the way an email does. Blank clears it and is always allowed.
   */
  function assertPhoneFree(raw, selfId = null) {
    const key = phoneKey(raw);
    if (!key) return;
    if (db.users.some((u) => u.id !== selfId && phoneKey(u.phone) === key)) {
      throw conflict('Another account already uses that mobile number');
    }
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

    // Customers shop the whole store — the separation is between sellers, not
    // between what is for sale. It only applies to staff looking at the menu
    // in order to manage it.
    const products = db.products
      .filter((p) => staff || p.is_active)
      .filter((p) => !staff || managesEverything(user) || p.owner_id === user.id)
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
        hero_title: s.hero_title ?? '',
        hero_text: s.hero_text ?? '',
        hero_cta: s.hero_cta ?? '',
        show_included_label: s.show_included_label !== false,
        google_client_id: s.google_client_id ?? '',
        // A receiving number is meant to be read by customers — that is the
        // whole point of it. Nothing secret lives in settings.
        gcash_number: s.gcash_number ?? '',
        gcash_name: s.gcash_name ?? '',
        gcash_qr_url: s.gcash_qr_url ?? '',
        currency: s.currency,
        tax_rate: Number(s.tax_rate),
        pickup_address: s.pickup_address,
        min_order_total: Number(s.min_order_total),
        delivery_enabled: Boolean(s.delivery_enabled),
        // A shop created before these existed was delivering with Grab, so an
        // absent key means the old behaviour rather than off. Upgrading must
        // not quietly stop a working shop taking delivery orders.
        grab_delivery_enabled: s.grab_delivery_enabled ?? true,
        own_delivery_enabled: s.own_delivery_enabled ?? false,
        own_delivery_fee: Number(s.own_delivery_fee ?? 0),
        own_delivery_fee_per_km: Number(s.own_delivery_fee_per_km ?? 0),
        max_delivery_km: Number(s.max_delivery_km ?? 0),
        pickup_lat: Number(s.pickup_lat),
        pickup_lng: Number(s.pickup_lng),
        order_lead_mins: Number(s.order_lead_mins),
      },
      // Who is behind each product, so the storefront can name the seller and
      // keep a basket to one of them. Only the parts a customer may see.
      sellers: [...new Set(db.products.map((p) => p.owner_id ?? null))].map((id) => {
        const sp = sellerProfile(id);
        return {
          id: sp.user_id,
          name: sp.display_name,
          pickup_address: sp.pickup_address,
          gcash_number: sp.gcash_number,
          gcash_name: sp.gcash_name,
          gcash_qr_url: sp.gcash_qr_url,
          grab_delivery_enabled: sp.grab_delivery_enabled,
          own_delivery_enabled: sp.own_delivery_enabled,
        };
      }),
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
  function assertWithinRange(dropoff, seller = null) {
    const limit = Number(db.settings.max_delivery_km ?? 0);
    if (!limit) return;
    // From the seller's own counter, not the shop's. A seller in Carmona
    // delivering one street away is not making a 28 km trip just because the
    // shop's address is in Makati.
    const from = seller ?? db.settings;
    const km = haversineKm(
      { lat: Number(from.pickup_lat), lng: Number(from.pickup_lng) },
      { lat: Number(dropoff.lat), lng: Number(dropoff.lng) },
    );
    if (km > limit) {
      throw bad(
        `That address is about ${Math.round(km)} km away. ` +
          `We deliver within ${limit} km — choose pickup, or a closer address.`,
      );
    }
  }

  /**
   * What the delivery costs, whoever is carrying it.
   *
   * Both the quote and the checkout need this, and they must agree: the
   * browser is shown one number and charged another if they drift apart. So
   * neither calls the provider directly any more.
   *
   * Delivering yourself returns a quote of the same shape as Grab's, which is
   * what lets everything downstream — the totals, the order record, the
   * summary panel — stay unaware of who is carrying the jar.
   */
  /**
   * Which carriers a customer may choose right now, in the order they are
   * offered. Empty means this shop is pickup only.
   */
  function enabledCarriers(seller = null) {
    if (!db.settings.delivery_enabled) return [];
    const who = seller ?? sellerProfile(null);
    return [
      who.grab_delivery_enabled ? 'grab' : null,
      who.own_delivery_enabled ? 'own' : null,
    ].filter(Boolean);
  }

  /**
   * Settles which carrier an order is using.
   *
   * A browser that predates the choice sends none, so fall back to the first
   * one running rather than refusing an order over a field it has never heard
   * of. Anything else must be a carrier that is actually switched on — the
   * checkout only shows those, so a request for another one did not come from
   * the checkout.
   */
  function resolveCarrier(requested, seller = null) {
    const running = enabledCarriers(seller);
    if (!running.length) throw bad('Delivery is switched off right now');
    if (requested == null || requested === '') return running[0];
    if (!running.includes(requested)) throw bad('That delivery option is not available');
    return requested;
  }

  async function quoteDelivery(dropoff, carrier, seller = null) {
    const from = seller ?? sellerProfile(null);
    if (carrier === 'own') {
      const km = haversineKm(
        { lat: Number(from.pickup_lat), lng: Number(from.pickup_lng) },
        { lat: Number(dropoff.lat), lng: Number(dropoff.lng) },
      );
      const flat = Number(from.own_delivery_fee ?? 0);
      const perKm = Number(from.own_delivery_fee_per_km ?? 0);
      return {
        provider: 'own',
        fee: round2(flat + perKm * km),
        distance_km: round2(km),
        // The shop knows its own area better than a formula would; the prep
        // time it already advertises is a more honest number than a guess.
        eta_minutes: Number(db.settings.order_lead_mins ?? 0) || null,
      };
    }
    return delivery.quote({
      pickup: {
        address: from.pickup_address,
        lat: Number(from.pickup_lat),
        lng: Number(from.pickup_lng),
        phone: from.pickup_phone,
        name: from.display_name,
      },
      dropoff,
    });
  }

  /** The fields a seller may set instead of the shop's. */
  const SELLER_FIELDS = [
    'display_name',
    'gcash_number', 'gcash_name', 'gcash_qr_url',
    'pickup_address', 'pickup_lat', 'pickup_lng', 'pickup_phone',
    'own_delivery_fee', 'own_delivery_fee_per_km',
    // How this seller gets an order to the customer. Their call, not the
    // shop's: one may have a rider of their own and another may not.
    'grab_delivery_enabled', 'own_delivery_enabled',
  ];

  /** The two carrier switches are yes/no, and absent means the shop's answer. */
  const SELLER_FLAGS = ['grab_delivery_enabled', 'own_delivery_enabled'];

  /**
   * A seller's details, with the shop's used for anything they have not set.
   *
   * Falling back rather than requiring every field is what lets a seller be
   * added in a minute: assign them some products and they are trading, with
   * the shop's pickup point and the shop's GCash, until they fill in their
   * own.
   */
  function sellerProfile(ownerId) {
    const own = (db.sellerProfiles ?? []).find((p) => p.user_id === ownerId) ?? {};
    const shop = db.settings;
    const pick = (k) => {
      const v = own[k];
      return v === undefined || v === null || v === '' ? shop[k] : v;
    };
    return {
      user_id: ownerId ?? null,
      display_name: own.display_name
        || db.users.find((u) => u.id === ownerId)?.name
        || shop.shop_name,
      gcash_number: pick('gcash_number') ?? '',
      gcash_name: own.gcash_name || own.display_name
        || (ownerId == null ? shop.gcash_name : db.users.find((u) => u.id === ownerId)?.name)
        || shop.gcash_name || '',
      gcash_qr_url: pick('gcash_qr_url') ?? '',
      pickup_address: pick('pickup_address'),
      pickup_lat: Number(pick('pickup_lat')),
      pickup_lng: Number(pick('pickup_lng')),
      pickup_phone: pick('pickup_phone'),
      own_delivery_fee: Number(pick('own_delivery_fee') ?? 0),
      own_delivery_fee_per_km: Number(pick('own_delivery_fee_per_km') ?? 0),
      // A shop that has never touched these delivered with Grab, so that is
      // what an unanswered switch still means.
      grab_delivery_enabled: own.grab_delivery_enabled
        ?? shop.grab_delivery_enabled ?? true,
      own_delivery_enabled: own.own_delivery_enabled
        ?? shop.own_delivery_enabled ?? false,
      // What this seller has actually set, and what they would inherit.
      // An editor that saved the merged values back would freeze the shop's
      // settings into the seller, so later changing the shop would stop
      // reaching them. Blank here means "use the shop's".
      own: Object.fromEntries(SELLER_FIELDS.map((k) => [k, own[k] ?? ''])),
      shop: Object.fromEntries(SELLER_FIELDS.map((k) => [k, shop[k] ?? ''])),
    };
  }

  /**
   * The one seller a basket belongs to.
   *
   * A basket holds one seller's work and no more, so that an order has a
   * single place to collect from and a single person to pay. Mixing them would
   * mean one order with two pickup points, which is not an order.
   */
  function sellerOfItems(items) {
    const owners = new Set(
      (items ?? []).map((raw) => {
        const p = db.products.find((x) => x.id === Number(raw.product_id));
        return p?.owner_id ?? null;
      }),
    );
    if (owners.size > 1) {
      throw bad('One order can only hold items from one seller. Place a second order for the rest.');
    }
    return owners.size === 1 ? [...owners][0] : null;
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
    // Who made it, so the order page can say where to collect and whose
    // GCash to pay. Read from the items, which carry the owner they were
    // sold under.
    const owner = items.length ? items[0].owner_id ?? null : null;
    const sp = sellerProfile(owner);
    return {
      ...order,
      items,
      history,
      delivery: deliveryForOrder(order.id),
      seller: {
        id: sp.user_id,
        name: sp.display_name,
        pickup_address: sp.pickup_address,
        gcash_number: sp.gcash_number,
        gcash_name: sp.gcash_name,
        gcash_qr_url: sp.gcash_qr_url,
      },
    };
  }

  /**
   * The secret in a link the shop pastes to a customer.
   *
   * 128 bits from the platform's CSPRNG. It has to be unguessable rather than
   * merely unique: order numbers run in sequence, so anything derived from one
   * could be walked from OK-240001 to everyone else's order.
   */
  const shareToken = () => {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  };

  /**
   * Puts stock back, or takes it away again.
   *
   * Checkout deducts on the way in, so an order being rewritten has to return
   * what it was holding before the new contents are priced — otherwise a jar
   * already counted against the old order is counted a second time against the
   * new one and the shop appears to have sold twice what it did.
   */
  function moveStock(items, sign) {
    for (const item of items) {
      const product = db.products.find((p) => p.id === item.product_id);
      if (product?.track_stock) {
        product.stock_qty = Math.max(0, product.stock_qty + sign * item.quantity);
      }
      for (const o of item.options ?? []) {
        const opt = db.options.find((x) => x.id === o.option_id);
        if (opt?.track_stock) opt.stock_qty = Math.max(0, opt.stock_qty + sign * item.quantity);
      }
    }
  }

  /** The lines of an order, with their options, in the shape priceCart returns. */
  const linesOf = (orderId) => db.orderItems
    .filter((i) => i.order_id === orderId)
    .map((i) => ({ ...i, options: db.orderItemOptions.filter((o) => o.order_item_id === i.id) }));

  /**
   * A picture has to be one, and nothing checked that for products.
   *
   * The usual mistake is pasting the address bar from a Google Images search
   * rather than the image itself — a search page is HTML, so the browser
   * fetches it happily and shows nothing at all. Saying so at the moment it is
   * pasted is the only place anyone will understand the message.
   */
  function cleanImageUrl(raw, what = 'That picture') {
    const value = String(raw ?? '').trim();
    if (!value) return '';
    if (value.length > MAX_IMAGE_CHARS) {
      throw bad(
        `${what} is too large (${Math.round(value.length / 1024)} KB). `
          + `Keep it under ${Math.round(MAX_IMAGE_CHARS / 1024)} KB.`,
      );
    }
    if (!/^(https?:\/\/|data:image\/)/.test(value)) {
      throw bad('An image must be an https:// address or an uploaded picture');
    }
    if (/^https?:\/\/(www\.)?(google|bing|duckduckgo|yandex)\.[a-z.]+\/(search|images)/i.test(value)) {
      throw bad(
        'That is a link to a search results page, not to a picture. Open the '
          + 'image itself, right-click it and choose "Copy image address" — or '
          + 'upload the picture here instead.',
      );
    }
    return value;
  }

  const orderNumberFor = (id) => `OK-${String(240000 + id).padStart(6, '0')}`;

  /**
   * Bumped by every write, so a screen can ask "has anything changed?" without
   * pulling the whole order list to find out that nothing has.
   *
   * It counts writes rather than order changes, so a menu edit moves it too.
   * That costs the odd needless refetch and is worth it: the alternative is
   * bookkeeping at every mutation site, where the one that gets forgotten is
   * the one that leaves a new order off the screen.
   *
   * It lives in memory, so a restart sends it back to zero. Clients compare
   * for difference, not for growth.
   */
  let rev = 0;

  // Anything else is a typo or a tampered request; the checkout only ever
  // sends one of these.
  const PAYMENT_METHODS = ['cash', 'card', 'ewallet', 'gcash'];

  // ------------------------------------------------------------ route table

  const routes = [
    // ---------------------------------------------------------------- auth
    ['POST', /^\/auth\/login$/, async (m, body) => {
      // 'email' is what older clients send; either field may carry a number.
      const user = findByIdentifier(body.identifier ?? body.email);
      // Same message either way, so this never confirms which accounts exist.
      if (!user) throw unauthorized('Those sign-in details are incorrect');
      if (!user.is_active) throw unauthorized('This account has been deactivated');
      if (!(await auth.verifyPassword(body.password ?? '', user.password_hash))) {
        throw unauthorized('Those sign-in details are incorrect');
      }
      return { token: await auth.signToken(user), user: publicUser(user) };
    }],

    ['POST', /^\/auth\/register$/, async (m, body) => {
      const email = String(body.email ?? '').toLowerCase().trim();
      if (!email.includes('@')) throw bad('Enter a valid email');
      if (String(body.password ?? '').length < 8) throw bad('Password must be at least 8 characters');
      if (String(body.name ?? '').trim().length < 2) throw bad('Enter your name');
      if (db.users.some((u) => u.email === email)) throw conflict('That email is already registered');
      assertPhoneFree(body.phone);

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
      if (body.phone !== undefined) {
        assertPhoneFree(body.phone, user.id);
        user.phone = body.phone;
      }
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
      // A manager's product is theirs. An admin may hand it to someone, or
      // leave it unowned as the shop's own.
      const owner = managesEverything(user)
        ? (body.owner_id == null ? null : Number(body.owner_id))
        : user.id;
      if (owner != null && !db.users.some((u) => u.id === owner && u.role !== 'customer')) {
        throw bad('That owner is not a member of staff');
      }
      const p = {
        id: nextId('product'),
        owner_id: owner,
        category_id: Number(body.category_id),
        name: body.name,
        slug: body.slug || slugify(body.name),
        description: body.description ?? null,
        base_price: Number(body.base_price),
        image_url: cleanImageUrl(body.image_url) || null,
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
      requireOwnership(user, p);
      // Only someone who runs the whole shop may hand a product to another
      // seller; otherwise a manager could give away — or quietly take — stock.
      if (body.owner_id !== undefined) {
        if (!managesEverything(user)) throw forbidden('Only an admin can reassign a product');
        const next = body.owner_id == null ? null : Number(body.owner_id);
        if (next != null && !db.users.some((u) => u.id === next && u.role !== 'customer')) {
          throw bad('That owner is not a member of staff');
        }
        p.owner_id = next;
      }
      for (const k of ['category_id', 'name', 'description', 'base_price', 'sort_order', 'stock_qty']) {
        if (body[k] !== undefined) p[k] = body[k];
      }
      if (body.image_url !== undefined) p.image_url = cleanImageUrl(body.image_url) || null;
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
      requireOwnership(user, p);
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
      if (body.image_url !== undefined) o.image_url = cleanImageUrl(body.image_url) || null;
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
      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) throw bad('A category needs a name');
        if (name.length > 60) throw bad('That category name is too long');
        c.name = name;
      }
      if (body.sort_order !== undefined) c.sort_order = body.sort_order;
      if (body.is_active !== undefined) c.is_active = body.is_active ? 1 : 0;
      // Renaming a category changes what every customer sees above the menu,
      // so it belongs in the log with the rest of the menu changes.
      audit(user, 'category.update', 'category', c.id, body);
      return c;
    }],

    /**
     * Just the shop's public settings. The storefront header needs the name
     * and logo on every page and has no use for the whole catalog.
     */
    /**
     * What a seller has set for themselves, with the shop's used for anything
     * they have not. Public: the customer has to be told where to collect the
     * order and whose GCash to pay, and neither is a secret.
     */
    ['GET', /^\/sellers\/(\d+|shop)\/profile$/, async (m) => {
      const id = m[1] === 'shop' ? null : Number(m[1]);
      if (id != null && !db.users.some((u) => u.id === id)) throw notFound('No such seller');
      return sellerProfile(id);
    }],

    /** Every seller with something for sale, for an admin choosing between them. */
    ['GET', /^\/sellers$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      const owners = new Set(db.products.map((p) => p.owner_id ?? null));
      return {
        sellers: [...owners]
          .map((id) => ({
            ...sellerProfile(id),
            products: db.products.filter((p) => (p.owner_id ?? null) === id).length,
          }))
          .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name))),
      };
    }],

    /**
     * A seller sets their own; an admin may set anyone's. Blank means "use the
     * shop's", which is how a seller is switched back to the house defaults.
     */
    ['PUT', /^\/sellers\/(\d+|shop)\/profile$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      // "shop" is the seller behind anything nobody owns. It is not a person,
      // so only an admin speaks for it.
      const id = m[1] === 'shop' ? null : Number(m[1]);
      if (id === null) {
        requireRole(user, 'admin');
      } else {
        if (!managesEverything(user) && user.id !== id) {
          throw forbidden('You can only change your own details');
        }
        if (!db.users.some((u) => u.id === id)) throw notFound('No such seller');
      }

      db.sellerProfiles = db.sellerProfiles ?? [];
      const row = db.sellerProfiles.find((p) => p.user_id === id)
        ?? (db.sellerProfiles.push({ user_id: id }), db.sellerProfiles.at(-1));

      for (const k of SELLER_FIELDS) {
        if (body[k] === undefined) continue;
        if (SELLER_FLAGS.includes(k)) {
          // Blank puts the switch back to inheriting, the same as every
          // other field here. Without it an explicit false would shadow the
          // shop for ever, with no way in the UI to undo it.
          if (body[k] === '' || body[k] === null) delete row[k];
          else row[k] = Boolean(body[k]);
        } else if (k === 'gcash_number') {
          const typed = String(body[k] ?? '').trim();
          if (typed && !phoneKey(typed)) throw bad('Enter a valid GCash mobile number');
          row[k] = typed;
        } else if (k === 'gcash_qr_url') {
          const value = String(body[k] ?? '').trim();
          if (value.length > MAX_IMAGE_CHARS) {
            throw bad('That image is too large — keep it under '
              + Math.round(MAX_IMAGE_CHARS / 1024) + ' KB');
          }
          if (value && !/^(https?:\/\/|data:image\/)/.test(value)) {
            throw bad('An image must be an https:// address or an uploaded picture');
          }
          row[k] = value;
        } else if (k === 'own_delivery_fee' || k === 'own_delivery_fee_per_km') {
          if (body[k] === '' || body[k] === null) { row[k] = ''; continue; }
          const n = Number(body[k]);
          if (!Number.isFinite(n) || n < 0) throw bad('A delivery fee cannot be negative');
          row[k] = round2(n);
        } else if (k === 'pickup_lat' || k === 'pickup_lng') {
          if (body[k] === '' || body[k] === null) { row[k] = ''; continue; }
          const n = Number(body[k]);
          if (!Number.isFinite(n)) throw bad('That pickup point is not a place');
          row[k] = n;
        } else {
          row[k] = String(body[k] ?? '').trim().slice(0, 300);
        }
      }

      audit(user, 'seller.profile', 'user', id, { fields: Object.keys(body) });
      return sellerProfile(id);
    }],

    ['GET', /^\/catalog\/settings$/, async (m, body, user) => buildMenu(user).settings],

    // -------------------------------------------------------------- orders
    ['POST', /^\/orders\/quote$/, async (m, body) => {
      const { items, subtotal } = priceCart(db, body.items);
      const seller = sellerProfile(sellerOfItems(body.items));

      let deliveryQuote = null;
      if (body.fulfillment_type === 'delivery' && body.delivery_lat != null) {
        assertWithinRange({ lat: body.delivery_lat, lng: body.delivery_lng }, seller);
        deliveryQuote = await quoteDelivery({
          address: body.delivery_address,
          lat: Number(body.delivery_lat),
          lng: Number(body.delivery_lng),
        }, resolveCarrier(body.delivery_carrier, seller), seller);
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
        // The seller's own, falling back to the shop's. This is what the
        // customer is shown, so it has to be whoever is actually making it.
        seller: {
          id: seller.user_id,
          name: seller.display_name,
          gcash_number: seller.gcash_number,
          gcash_name: seller.gcash_name,
          gcash_qr_url: seller.gcash_qr_url,
          grab_delivery_enabled: seller.grab_delivery_enabled,
          own_delivery_enabled: seller.own_delivery_enabled,
        },
        pickup_address: seller.pickup_address,
        order_lead_mins: Number(db.settings.order_lead_mins),
        min_order_total: Number(db.settings.min_order_total),
        meets_minimum: subtotal >= Number(db.settings.min_order_total),
      };
    }],

    ['POST', /^\/orders$/, async (m, body, user) => {
      // Settled before anything is priced, so the fee and the record agree.
      // Whose basket this is has to be settled first: the carriers on offer
      // are theirs, not the shop's.
      const seller = sellerProfile(sellerOfItems(body.items));
      const carrier = body.fulfillment_type === 'delivery'
        ? resolveCarrier(body.delivery_carrier, seller)
        : null;
      const paymentMethod = body.payment_method ?? 'cash';
      if (!PAYMENT_METHODS.includes(paymentMethod)) throw bad('Unknown payment method');
      // Taking a GCash order with nowhere to send the money would strand it in
      // unpaid with no way for the customer to settle up.
      if (paymentMethod === 'gcash'
        && !String(sellerProfile(sellerOfItems(body.items)).gcash_number ?? '').trim()) {
        throw bad('GCash is not set up for this seller yet');
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
        assertWithinRange({ lat: body.delivery_lat, lng: body.delivery_lng }, seller);
        const q = await quoteDelivery({
          address: body.delivery_address,
          lat: Number(body.delivery_lat),
          lng: Number(body.delivery_lng),
        }, carrier, seller);
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
        delivery_carrier: carrier,
        delivery_address: body.delivery_address ?? null,
        delivery_notes: body.delivery_notes ?? null,
        delivery_lat: body.delivery_lat ?? null,
        delivery_lng: body.delivery_lng ?? null,
        ...totals,
        currency: db.settings.currency,
        share_token: shareToken(),
        payment_method: paymentMethod,
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
          // Snapshotted, so reassigning a product later does not rewrite who
          // earned what last month.
          owner_id: db.products.find((p) => p.id === item.product_id)?.owner_id ?? null,
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

    /**
     * Small enough to poll: the staff screens hit this every few seconds and
     * only fetch the real list when the number has moved.
     */
    ['GET', /^\/orders\/pulse$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      const seen = db.orders.filter((o) => canSeeOrder(user, o.id));
      return {
        rev,
        orders: seen.length,
        open: seen.filter((o) => !['completed', 'cancelled'].includes(o.status)).length,
      };
    }],

    ['GET', /^\/orders\/queue$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      const orders = db.orders
        .filter((o) => !['completed', 'cancelled'].includes(o.status))
        .filter((o) => canSeeOrder(user, o.id))
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

    /**
     * The link the shop sends the customer. No sign-in: whoever holds the
     * token is who it was given to, which is the same trust a parcel-tracking
     * link asks for.
     */
    ['GET', /^\/orders\/shared\/([0-9a-f]{32})$/, async (m, body, user) => {
      const order = db.orders.find((o) => o.share_token === m[1]);
      if (!order) throw notFound('That link is not valid');
      return loadOrder(order.id);
    }],

    /**
     * Hands the shop the token for an order, minting one if it predates this
     * feature. A POST because it can create something and has to be saved.
     */
    ['POST', /^\/orders\/(\d+)\/share$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      const order = db.orders.find((o) => o.id === Number(m[1]));
      if (!order) throw notFound('Order not found');
      if (!order.share_token) order.share_token = shareToken();
      return { id: order.id, order_number: order.order_number, share_token: order.share_token };
    }],

    ['GET', /^\/orders\/(\d+)$/, async (m, body, user) => {
      const order = loadOrder(m[1]);
      if (!order) throw notFound('Order not found');
      if (isStaff(user)) requireOrderAccess(user, order.id);
      else if (!user || order.customer_id !== user.id) {
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
      const payment = query.get('payment_status');
      const search = (query.get('search') ?? '').toLowerCase();

      let rows = db.orders.filter((o) => (isStaff(user)
        ? canSeeOrder(user, o.id)
        : o.customer_id === user.id));
      if (statuses.length) rows = rows.filter((o) => statuses.includes(o.status));
      if (type) rows = rows.filter((o) => o.fulfillment_type === type);
      // Cancelled orders are not debts, so an unpaid filter leaves them out.
      if (payment) {
        rows = rows.filter((o) => o.payment_status === payment
          && (payment !== 'unpaid' || o.status !== 'cancelled'));
      }
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

    /**
     * Rewrites what an order contains.
     *
     * The shop takes a call — one more jar, no walnuts after all — and the
     * order has to follow. Only the contents are given; every price is worked
     * out here from the menu, exactly as it is at checkout, because a till
     * that accepts a total from the browser is not a till.
     *
     * The delivery fee is left alone: it was quoted for a distance, and the
     * distance has not changed.
     */
    ['PUT', /^\/orders\/(\d+)\/items$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      const order = db.orders.find((o) => o.id === Number(m[1]));
      if (!order) throw notFound('Order not found');
      // Nothing to make, so nothing to change.
      if (order.status === 'cancelled') throw bad('A cancelled order cannot be edited');
      // A completed order is a settled record, and a manager should not be
      // rewriting one after the fact. An admin may: they can already delete
      // it outright, and correcting a mistake is the lesser act of the two.
      if (order.status === 'completed' && user.role !== 'admin') {
        throw bad('This order is completed — ask an admin to change it');
      }

      const before = linesOf(order.id);
      const previousTotal = order.total;

      // Give back what the old contents were holding, so the new contents are
      // checked against stock the shop actually has.
      moveStock(before, +1);

      let priced;
      try {
        priced = priceCart(db, body.items);
      } catch (err) {
        moveStock(before, -1);   // nothing changed; put the reservation back
        throw err;
      }

      const oldItemIds = new Set(before.map((i) => i.id));
      db.orderItemOptions = db.orderItemOptions.filter((o) => !oldItemIds.has(o.order_item_id));
      db.orderItems = db.orderItems.filter((i) => i.order_id !== order.id);

      for (const item of priced.items) {
        const itemId = nextId('item');
        db.orderItems.push({
          id: itemId,
          order_id: order.id,
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
      }
      moveStock(priced.items, -1);

      const totals = totalsFor({
        subtotal: priced.subtotal,
        deliveryFee: order.delivery_fee,
        taxRate: db.settings.tax_rate,
      });
      Object.assign(order, totals);

      const money = (n) => `${db.settings.currency} ${Number(n).toFixed(2)}`;
      let note = `Items edited: ${money(previousTotal)} → ${money(order.total)}`;
      if (body.reason) note += ` (${String(body.reason).slice(0, 120)})`;

      // Money already collected no longer covers the order. Saying so is the
      // whole point of the unpaid list; a larger order silently marked paid is
      // how a shop loses the difference.
      if (order.payment_status === 'paid' && order.total > previousTotal) {
        order.payment_status = 'unpaid';
        note += ' — marked unpaid, the total went up';
      }

      db.history.push({
        order_id: order.id,
        from_status: order.status,
        to_status: order.status,
        changed_by: user.id,
        note,
        created_at: nowIso(),
      });
      audit(user, 'order.items', 'order', order.id, {
        from_total: previousTotal,
        to_total: order.total,
        lines: priced.items.length,
      });
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

    /**
     * Removes an order from the books entirely.
     *
     * Cancelling records that an order was called off; this says it should
     * never have been counted — a test order, a duplicate. Admin only, because
     * it destroys a financial record and takes the money with it: the revenue
     * on the reports drops, and the deletion is the only trace left.
     *
     * Stock is put back, unlike cancelling. Cancelling leaves an order in the
     * books to explain where the jar went; a deleted order explains nothing,
     * so anything it was holding has to be returned or the count is quietly
     * wrong for ever.
     */
    ['DELETE', /^\/orders\/(\d+)$/, async (m, body, user) => {
      requireRole(user, 'admin');
      const order = db.orders.find((o) => o.id === Number(m[1]));
      if (!order) throw notFound('Order not found');

      const lines = linesOf(order.id);
      moveStock(lines, +1);

      const itemIds = new Set(lines.map((i) => i.id));
      const deliveryIds = new Set(
        db.deliveries.filter((d) => d.order_id === order.id).map((d) => d.id),
      );

      db.orderItemOptions = db.orderItemOptions.filter((o) => !itemIds.has(o.order_item_id));
      db.orderItems = db.orderItems.filter((i) => i.order_id !== order.id);
      db.history = db.history.filter((h) => h.order_id !== order.id);
      db.deliveryEvents = db.deliveryEvents.filter((e) => !deliveryIds.has(e.delivery_id));
      db.deliveries = db.deliveries.filter((d) => d.order_id !== order.id);
      db.orders = db.orders.filter((o) => o.id !== order.id);

      // Written before the order is gone so the log still knows what it was.
      audit(user, 'order.delete', 'order', order.id, {
        order_number: order.order_number,
        status: order.status,
        payment_status: order.payment_status,
        total: order.total,
        items: lines.length,
      });
      return {
        deleted: true,
        id: order.id,
        order_number: order.order_number,
        total: order.total,
        stock_returned: lines.length,
      };
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
      // Read off the order rather than the settings: both carriers can be
      // running at once, and an order placed as our own delivery stays ours
      // even if Grab is switched on beside it.
      const carried = db.orders.find((o) => o.id === Number(m[1]))?.delivery_carrier;
      if (carried === 'own') {
        throw bad('This order is being delivered by the shop — there is no rider to book');
      }
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
      assertPhoneFree(body.phone);

      const u = {
        id: nextId('user'),
        email,
        password_hash: await auth.hashPassword(body.password),
        name: body.name,
        phone: body.phone ?? null,
        role: body.role,
        manages_all_products: Boolean(body.manages_all_products),
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
      if (body.manages_all_products !== undefined) {
        target.manages_all_products = Boolean(body.manages_all_products);
      }
      if (body.phone !== undefined) assertPhoneFree(body.phone, target.id);
      for (const k of ['name', 'phone', 'role']) if (body[k] !== undefined) target[k] = body[k];
      if (body.is_active !== undefined) target.is_active = body.is_active ? 1 : 0;
      if (body.password) target.password_hash = await auth.hashPassword(body.password);
      audit(user, 'user.update', 'user', target.id, { ...body, password: undefined });
      return { ...publicUser(target), is_active: target.is_active };
    }],

    /**
     * Deletes an account for good.
     *
     * Orders are money that changed hands, so they are kept and detached
     * instead of going with the account: every order already carries the name,
     * phone and email given at checkout, so the record stays readable on its
     * own. Disabling an account keeps it in the list and stops it signing in;
     * this is for the ones that should not be in the list at all.
     */
    ['DELETE', /^\/admin\/users\/(\d+)$/, async (m, body, user) => {
      requireRole(user, 'admin');
      const target = db.users.find((u) => u.id === Number(m[1]));
      if (!target) throw notFound('User not found');

      // Deleting yourself would end your own session mid-request, and the
      // account doing the deleting is the one that can undo a mistake.
      if (target.id === user.id) throw bad('You cannot delete your own account');
      if (
        target.role === 'admin' && target.is_active &&
        !db.users.some((u) => u.role === 'admin' && u.is_active && u.id !== target.id)
      ) {
        throw bad('This is the last active admin');
      }

      const detached = db.orders.filter((o) => o.customer_id === target.id);
      for (const order of detached) order.customer_id = null;

      db.users = db.users.filter((u) => u.id !== target.id);
      audit(user, 'user.delete', 'user', target.id, {
        email: target.email,
        name: target.name,
        role: target.role,
        orders_kept: detached.length,
      });
      return { deleted: true, id: target.id, orders_kept: detached.length };
    }],

    ['GET', /^\/admin\/settings$/, async (m, body, user) => {
      requireRole(user, 'admin', 'manager');
      return { settings: { ...db.settings }, grab_mode: db.settings.grab_mode ?? 'sim' };
    }],

    ['PUT', /^\/admin\/settings$/, async (m, body, user) => {
      requireRole(user, 'admin');
      const allowed = [
        'shop_name', 'logo_url', 'hero_image_url', 'show_included_label',
        'hero_title', 'hero_text', 'hero_cta',
        'google_client_id', 'gcash_number', 'gcash_name', 'gcash_qr_url',
        'currency', 'tax_rate', 'pickup_address', 'pickup_lat', 'pickup_lng',
        'pickup_phone', 'min_order_total', 'delivery_enabled', 'order_lead_mins',
        'max_delivery_km', 'grab_mode',
        'grab_delivery_enabled', 'own_delivery_enabled',
        'own_delivery_fee', 'own_delivery_fee_per_km',
      ];
      const patch = {};
      for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
      if (!Object.keys(patch).length) throw bad('Nothing to update');

      for (const k of ['grab_delivery_enabled', 'own_delivery_enabled']) {
        if (patch[k] !== undefined) patch[k] = Boolean(patch[k]);
      }
      for (const k of ['own_delivery_fee', 'own_delivery_fee_per_km']) {
        if (patch[k] === undefined) continue;
        const n = Number(patch[k]);
        // A negative fee would pay the customer to order, and NaN would make
        // every total NaN from here on.
        if (!Number.isFinite(n) || n < 0) throw bad('A delivery fee cannot be negative');
        patch[k] = round2(n);
      }

      if (patch.grab_mode !== undefined) {
        if (!['sim', 'live'].includes(patch.grab_mode)) {
          throw bad('Delivery mode must be "sim" or "live"');
        }
        const unavailable = await delivery.whyUnavailable?.(patch.grab_mode);
        if (unavailable) throw bad(unavailable);
      }

      if (patch.gcash_number !== undefined) {
        const typed = String(patch.gcash_number ?? '').trim();
        if (typed && !phoneKey(typed)) throw bad('Enter a valid GCash mobile number');
        patch.gcash_number = typed;
      }
      if (patch.gcash_name !== undefined) patch.gcash_name = String(patch.gcash_name ?? '').trim();

      // Free text on the front page of a public site: trim it, and cap it so
      // a paste of a whole document cannot be saved into the page.
      for (const [k, max] of [['hero_title', 120], ['hero_text', 400], ['hero_cta', 40]]) {
        if (patch[k] === undefined) continue;
        const text = String(patch[k] ?? '').trim();
        if (text.length > max) throw bad(`That is too long — keep it under ${max} characters`);
        patch[k] = text;
      }

      for (const k of ['logo_url', 'hero_image_url', 'gcash_qr_url']) {
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

      /**
       * Whose figures these are.
       *
       * A seller sees their own and cannot ask for anybody else's. Somebody
       * who runs the whole shop sees everything, or one seller at a time by
       * passing ?owner=<id>.
       */
      const askedFor = query.get('owner');
      let scopeTo = null;
      if (managesEverything(user)) {
        scopeTo = askedFor ? Number(askedFor) : null;
      } else {
        scopeTo = user.id;
        if (askedFor && Number(askedFor) !== user.id) {
          throw forbidden('You can only see your own figures');
        }
      }

      const visible = (o) => scopeTo == null || ownerOfOrder(o.id) === scopeTo;

      const inWindow = db.orders
        .filter((o) => new Date(o.created_at).getTime() >= since)
        .filter(visible);
      const counted = inWindow.filter((o) => o.status !== 'cancelled');
      const todayKey = new Date().toDateString();
      const todays = db.orders
        .filter((o) => new Date(o.created_at).toDateString() === todayKey)
        .filter(visible);

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

      /**
       * Money owed, over the whole book rather than the chosen window.
       *
       * A debt does not stop being owed because it is older than thirty days,
       * and an unpaid tile that quietly drops the oldest ones is worse than no
       * tile. Cancelled orders are not debts.
       */
      const owing = db.orders.filter(
        (o) => o.payment_status !== 'paid' && o.status !== 'cancelled',
      ).filter(visible);
      const oldestOwing = owing.reduce(
        (oldest, o) => (oldest === null || new Date(o.created_at) < new Date(oldest) ? o.created_at : oldest),
        null,
      );

      return {
        days,
        unpaid: {
          orders: owing.length,
          total: round2(owing.reduce((sum, o) => sum + o.total, 0)),
          oldest_at: oldestOwing,
        },
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
        open_orders: db.orders
          .filter((o) => !['completed', 'cancelled'].includes(o.status))
          .filter(visible).length,
        // Only shown to someone who can see everybody; a seller asking for
        // their own figures has nothing to compare against.
        by_owner: managesEverything(user) && scopeTo == null
          ? (() => {
            const rows = new Map();
            for (const o of counted) {
              const owner = ownerOfOrder(o.id);
              const key = owner ?? 0;
              const row = rows.get(key) ?? {
                owner_id: owner,
                owner_name: owner == null
                  ? 'Mixed or unassigned'
                  : db.users.find((u) => u.id === owner)?.name ?? `User ${owner}`,
                orders: 0,
                revenue: 0,
              };
              row.orders += 1;
              row.revenue = round2(row.revenue + o.total);
              rows.set(key, row);
            }
            return [...rows.values()].sort((a, b) => b.revenue - a.revenue);
          })()
          : [],
        scoped_to: scopeTo,
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
          rev += 1;
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
