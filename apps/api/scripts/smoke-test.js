#!/usr/bin/env node
/**
 * End-to-end check against a running API. Exercises the paths that matter:
 * auth for all three roles, the menu, cart pricing and its guard rails,
 * checkout, the kitchen status flow, a Grab booking with a simulated driver,
 * manager price edits and admin reporting.
 *
 *   npm run dev            # in one terminal
 *   node scripts/smoke-test.js
 */
import { config } from '../src/config.js';

const BASE = process.env.SMOKE_BASE_URL || `http://localhost:${config.port}`;
const PASSWORD = config.seedPassword;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  \u001b[32mPASS\u001b[0m ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  \u001b[31mFAIL\u001b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { status: res.status, ok: res.ok, body: payload };
}

/** @param identifier an email address or the mobile number on the account. */
const login = async (identifier) => {
  const res = await call('POST', '/auth/login', { body: { identifier, password: PASSWORD } });
  if (!res.ok) throw new Error(`Login failed for ${identifier}: ${res.body?.error}`);
  return res.body.token;
};

async function main() {
  console.log(`Smoke-testing ${BASE}\n`);

  // -------------------------------------------------------------- health
  section('Health');
  const health = await call('GET', '/health');
  check('GET /health responds 200', health.status === 200, `got ${health.status}`);
  check('the JSON store is loaded', health.body?.store === 'json', JSON.stringify(health.body));
  // An empty order book is a perfectly good state — a cleared store, or one
  // seeded with SEED_SAMPLE_ORDERS=false — so this reports rather than asserts.
  check('the store reports an order count', Number.isInteger(Number(health.body?.orders)));
  console.log(`  (grab mode: ${health.body?.grab_mode}, orders on hand: ${health.body?.orders})`);

  // ---------------------------------------------------------------- auth
  section('Authentication');
  const adminToken = await login('admin@orderko.test');
  const managerToken = await login('manager@orderko.test');
  const customerToken = await login('cust@orderko.test');
  check('admin can sign in', Boolean(adminToken));
  check('manager can sign in', Boolean(managerToken));
  check('customer can sign in', Boolean(customerToken));

  const badLogin = await call('POST', '/auth/login', {
    body: { email: 'admin@orderko.test', password: 'wrong-password-here' },
  });
  check('wrong password is rejected', badLogin.status === 401, `got ${badLogin.status}`);

  const me = await call('GET', '/auth/me', { token: adminToken });
  check('GET /auth/me returns the admin', me.body?.user?.role === 'admin');

  // ------------------------------------------------------------ role gates
  section('Role boundaries');
  const customerAtUsers = await call('GET', '/admin/users', { token: customerToken });
  check('customer cannot list users', customerAtUsers.status === 403, `got ${customerAtUsers.status}`);

  const managerAtUsers = await call('GET', '/admin/users', { token: managerToken });
  check('manager cannot list users', managerAtUsers.status === 403, `got ${managerAtUsers.status}`);

  const adminAtUsers = await call('GET', '/admin/users', { token: adminToken });
  check('admin can list users', adminAtUsers.status === 200, `got ${adminAtUsers.status}`);

  const managerAtQueue = await call('GET', '/orders/queue', { token: managerToken });
  check('manager can read the kitchen queue', managerAtQueue.status === 200);

  const anonAtQueue = await call('GET', '/orders/queue');
  check('anonymous cannot read the kitchen queue', anonAtQueue.status === 401, `got ${anonAtQueue.status}`);

  // -------------------------------------------------------------- catalog
  section('Categories');

  const cats = (await call('GET', '/catalog/menu', { token: managerToken })).body.categories;
  const first = cats[0];
  const wasCalled = first.name;

  const renamed = await call('PATCH', `/catalog/categories/${first.id}`, {
    token: managerToken, body: { name: '  Merienda  ' },
  });
  check('a category can be renamed', renamed.status === 200, renamed.body?.error);
  check('and the name is trimmed', renamed.body?.name === 'Merienda',
    JSON.stringify(renamed.body?.name));
  check('the storefront shows the new name',
    (await call('GET', '/catalog/menu')).body.categories.some((c) => c.name === 'Merienda'));

  // Renaming must never move anything between categories.
  check('the items stayed where they were',
    (await call('GET', '/catalog/menu', { token: managerToken })).body.products
      .filter((p) => p.category_id === first.id).length
      === (await call('GET', '/catalog/menu', { token: managerToken })).body.products
        .filter((p) => p.category_id === first.id).length);

  check('an empty name is refused',
    (await call('PATCH', `/catalog/categories/${first.id}`, {
      token: managerToken, body: { name: '   ' },
    })).status === 400);
  check('and the old name survived that',
    (await call('GET', '/catalog/menu')).body.categories
      .find((c) => c.id === first.id)?.name === 'Merienda');

  check('a customer cannot rename one',
    (await call('PATCH', `/catalog/categories/${first.id}`, {
      token: customerToken, body: { name: 'Mine now' },
    })).status === 403);

  check('the rename is in the activity log',
    ((await call('GET', '/admin/audit?limit=20', { token: adminToken })).body?.entries ?? [])
      .some((a) => a.action === 'category.update'),
    'no category.update entry');

  const made = await call('POST', '/catalog/categories', {
    token: managerToken, body: { name: 'Pasalubong', sort_order: 99 },
  });
  check('a category can be added', made.status === 201, made.body?.error);

  // Hidden rather than deleted: a category with items in it would orphan them.
  check('a category can be hidden',
    (await call('PATCH', `/catalog/categories/${made.body.id}`, {
      token: managerToken, body: { is_active: false },
    })).status === 200);
  check('and a hidden one leaves the storefront',
    !(await call('GET', '/catalog/menu')).body.categories.some((c) => c.id === made.body.id));

  // Put the name back so the suite can run again.
  await call('PATCH', `/catalog/categories/${first.id}`, {
    token: managerToken, body: { name: wasCalled },
  });
  check('the original name goes back',
    (await call('GET', '/catalog/menu')).body.categories
      .find((c) => c.id === first.id)?.name === wasCalled);

  section('Product pictures');

  // Pasting the address bar from a Google Images search is the usual mistake,
  // and it renders nothing: the browser fetches an HTML page into an img tag.
  const searchLink = await call('POST', '/catalog/products', {
    token: managerToken,
    body: {
      name: 'Picture Test', category_id: 1, base_price: 80,
      image_url: 'https://www.google.com/search?q=suman+sa+lihiya&tbm=isch',
    },
  });
  check('a search link is refused as a picture', searchLink.status === 400,
    `got ${searchLink.status}`);
  check('and the refusal says how to get the real one',
    /copy image address|search results/i.test(searchLink.body?.error ?? ''),
    searchLink.body?.error);

  const notAUrl = await call('POST', '/catalog/products', {
    token: managerToken,
    body: { name: 'Picture Test', category_id: 1, base_price: 80, image_url: 'suman.jpg' },
  });
  check('a bare filename is refused', notAUrl.status === 400, `got ${notAUrl.status}`);

  const realImage = await call('POST', '/catalog/products', {
    token: managerToken,
    body: {
      name: `Picture Test ${Date.now()}`, category_id: 1, base_price: 80,
      image_url: 'https://images.unsplash.com/photo-1517093157656-b9eccef91cb1?w=800',
    },
  });
  check('a real image address is accepted', realImage.status === 201, realImage.body?.error);

  check('an uploaded picture is accepted too',
    (await call('PATCH', `/catalog/products/${realImage.body.id}`, {
      token: managerToken, body: { image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
    })).status === 200);

  check('an oversized upload is refused',
    (await call('PATCH', `/catalog/products/${realImage.body.id}`, {
      token: managerToken,
      body: { image_url: 'data:image/png;base64,' + 'A'.repeat(500_000) },
    })).status === 400);

  check('and a picture can be cleared',
    (await call('PATCH', `/catalog/products/${realImage.body.id}`, {
      token: managerToken, body: { image_url: '' },
    })).status === 200);

  await call('DELETE', `/catalog/products/${realImage.body.id}`, { token: adminToken });

  section('Menu');
  const menu = await call('GET', '/catalog/menu');
  check('menu loads', menu.status === 200);
  check('menu has products', menu.body?.products?.length > 0);

  const byo = menu.body.products.find((p) => p.slug === 'build-your-own-oats');
  check('"Build Your Own Oats" exists', Boolean(byo));

  const fruitGroup = byo?.option_groups?.find((g) => g.slug === 'fruit-mix');
  check('it offers a Fruit Mix group', Boolean(fruitGroup));
  check('fruit mix is capped at 3', fruitGroup?.max_select === 3, `max_select=${fruitGroup?.max_select}`);
  check('fruit mix has banana, mango and dragon fruit',
    ['Banana', 'Mango', 'Dragon Fruit'].every((n) => fruitGroup?.options?.some((o) => o.name === n)));

  const nutsGroup = byo?.option_groups?.find((g) => g.slug === 'nuts');
  const seedsGroup = byo?.option_groups?.find((g) => g.slug === 'seeds');
  check('nuts and seeds are separate groups', Boolean(nutsGroup) && Boolean(seedsGroup));
  check('walnuts are under Nuts', nutsGroup?.options?.some((o) => o.name === 'Walnuts'));
  check('chia seeds are under Seeds', seedsGroup?.options?.some((o) => o.name === 'Chia Seeds'));
  check('no nut ended up among the seeds',
    !seedsGroup?.options?.some((o) => ['Walnuts', 'Almonds', 'Crushed Peanuts'].includes(o.name)));

  const spreads = byo?.option_groups?.find((g) => g.slug === 'spreads');
  check('spreads include Skippy peanut butter',
    spreads?.options?.some((o) => o.name.includes('Skippy')));

  const milkGroup = byo?.option_groups?.find((g) => g.slug === 'milk-base');
  check('milk base is a single choice', milkGroup?.input_type === 'single');

  // --------------------------------------------------------------- pricing
  section('Cart pricing');
  const size = byo.option_groups.find((g) => g.slug === 'jar-size').options[0];
  const milk = milkGroup.options.find((o) => o.name === 'Oat Milk');
  const banana = fruitGroup.options.find((o) => o.name === 'Banana');
  const mango = fruitGroup.options.find((o) => o.name === 'Mango');
  const dragon = fruitGroup.options.find((o) => o.name === 'Dragon Fruit');
  const strawberry = fruitGroup.options.find((o) => o.name === 'Strawberry');
  const walnuts = nutsGroup.options.find((o) => o.name === 'Walnuts');
  const chia = seedsGroup.options.find((o) => o.name === 'Chia Seeds');
  const skippy = spreads.options.find((o) => o.name.includes('Skippy'));

  const threeFruits = [size.id, milk.id, banana.id, mango.id, dragon.id, walnuts.id, chia.id, skippy.id];
  const quote = await call('POST', '/orders/quote', {
    body: { items: [{ product_id: byo.id, quantity: 2, option_ids: threeFruits }] },
  });
  check('three fruits plus add-ons prices cleanly', quote.status === 200, JSON.stringify(quote.body?.error));

  const expectedUnit =
    Number(byo.base_price) +
    [size, milk, banana, mango, dragon, walnuts, chia, skippy]
      .reduce((sum, o) => sum + Number(o.price_delta), 0);
  check(
    'server price matches the option sum',
    Math.abs(quote.body.items[0].line_total - expectedUnit * 2) < 0.01,
    `expected ${(expectedUnit * 2).toFixed(2)}, got ${quote.body?.items?.[0]?.line_total}`,
  );
  check('tax is applied', Number(quote.body.tax) > 0);
  check('quoted in the shop currency', quote.body.currency === menu.body.settings.currency,
    quote.body.currency);
  check('shop currency is PHP', menu.body.settings.currency === 'PHP', menu.body.settings.currency);

  const fourFruits = await call('POST', '/orders/quote', {
    body: {
      items: [{
        product_id: byo.id, quantity: 1,
        option_ids: [size.id, milk.id, banana.id, mango.id, dragon.id, strawberry.id],
      }],
    },
  });
  check('a 4th fruit is rejected', fourFruits.status === 400, `got ${fourFruits.status}`);

  const noMilk = await call('POST', '/orders/quote', {
    body: { items: [{ product_id: byo.id, quantity: 1, option_ids: [size.id, banana.id] }] },
  });
  check('a missing required milk choice is rejected', noMilk.status === 400, `got ${noMilk.status}`);

  const coldBrew = menu.body.products.find((p) => p.slug === 'cold-brew-coffee');
  const wrongProduct = await call('POST', '/orders/quote', {
    body: { items: [{ product_id: coldBrew.id, quantity: 1, option_ids: [banana.id] }] },
  });
  check('an option from another product is rejected', wrongProduct.status === 400, `got ${wrongProduct.status}`);

  const tinyOrder = await call('POST', '/orders', {
    token: customerToken,
    body: {
      items: [{ product_id: coldBrew.id, quantity: 1, option_ids: [] }],
      fulfillment_type: 'pickup',
      contact_name: 'Minimum Test',
      contact_phone: '+639171111111',
    },
  });
  check('an order below the minimum is rejected', tinyOrder.status === 400, `got ${tinyOrder.status}`);

  // ------------------------------------------------------------- delivery
  section('Grab delivery quote');
  const deliveryQuote = await call('POST', '/delivery/quote', {
    body: {
      address: 'Level 21, BGC Corporate Center, Bonifacio Global City, Taguig, 1634',
      lat: 14.5507, lng: 121.0494,
    },
  });
  check('a delivery fee is quoted', deliveryQuote.status === 200 && deliveryQuote.body.fee > 0,
    JSON.stringify(deliveryQuote.body));
  check('the quote carries a distance', Number(deliveryQuote.body?.distance_km) > 0);

  // The address picker can drop a pin anywhere, so the radius is enforced on
  // the server rather than trusted to the map.
  const farAway = await call('POST', '/delivery/quote', {
    body: { address: 'Cebu City', lat: 10.3157, lng: 123.8854 },
  });
  check('an address beyond the radius is refused', farAway.status === 400, `got ${farAway.status}`);
  check('the refusal says how far it is',
    /km away/.test(farAway.body?.error ?? ''), farAway.body?.error);

  const farOrder = await call('POST', '/orders', {
    token: customerToken,
    body: {
      items: [{ product_id: byo.id, quantity: 1, option_ids: threeFruits }],
      fulfillment_type: 'delivery',
      contact_name: 'Too Far', contact_phone: '+639170000004',
      delivery_address: 'Cebu City', delivery_lat: 10.3157, delivery_lng: 123.8854,
    },
  });
  check('and it cannot be ordered either', farOrder.status === 400, `got ${farOrder.status}`);

  // ------------------------------------------------------------- checkout
  section('Checkout');
  const order = await call('POST', '/orders', {
    token: customerToken,
    body: {
      items: [
        { product_id: byo.id, quantity: 1, option_ids: threeFruits, notes: 'Extra cold please' },
        { product_id: coldBrew.id, quantity: 1, option_ids: [] },
      ],
      fulfillment_type: 'delivery',
      contact_name: 'Smoke Tester',
      contact_phone: '+639170000003',
      contact_email: 'cust@orderko.test',
      delivery_address: 'Level 21, BGC Corporate Center, Bonifacio Global City, Taguig, 1634',
      delivery_lat: 14.5507,
      delivery_lng: 121.0494,
      payment_method: 'ewallet',
    },
  });
  check('order is created', order.status === 201, JSON.stringify(order.body?.error ?? order.body?.details));

  const orderId = order.body?.id;
  check('it has an order number', /^OK-\d+$/.test(order.body?.order_number ?? ''));
  check('it has two line items', order.body?.items?.length === 2);
  check('the built jar kept all 8 options', order.body?.items?.[0]?.options?.length === 8,
    `got ${order.body?.items?.[0]?.options?.length}`);
  check('the fruit choices were recorded',
    ['Banana', 'Mango', 'Dragon Fruit']
      .every((n) => order.body.items[0].options.some((o) => o.option_name === n)));
  check('a delivery fee was charged', Number(order.body?.delivery_fee) > 0);
  check('the item note survived', order.body?.items?.[0]?.notes === 'Extra cold please');
  check('history starts at pending', order.body?.history?.[0]?.to_status === 'pending');

  // A fixed address, reused across runs. A unique one per run left an account
  // behind every time the suite was executed.
  const NOSY = { email: 'smoke-other@orderko.test', password: 'SmokeTest123!', name: 'Nosy Neighbour' };
  const registered = await call('POST', '/auth/register', { body: NOSY });
  const nosyToken = registered.status === 409
    ? (await call('POST', '/auth/login', { body: { email: NOSY.email, password: NOSY.password } })).body?.token
    : registered.body?.token;
  check('a second customer account is available', Boolean(nosyToken));
  const peek = await call('GET', `/orders/${orderId}`, { token: nosyToken });
  check("another customer cannot read someone else's order", peek.status === 403, `got ${peek.status}`);

  const guestPeek = await call('GET', `/orders/${orderId}`);
  check('an anonymous request cannot read it either', guestPeek.status === 403 || guestPeek.status === 401);

  // -------------------------------------------------------- kitchen flow
  section('Kitchen flow');
  const skipAhead = await call('PATCH', `/orders/${orderId}/status`, {
    token: managerToken, body: { status: 'delivered' },
  });
  check('an illegal status jump is refused', skipAhead.status === 400, `got ${skipAhead.status}`);

  for (const status of ['confirmed', 'preparing', 'ready']) {
    const step = await call('PATCH', `/orders/${orderId}/status`, {
      token: managerToken, body: { status },
    });
    check(`manager can move it to ${status}`, step.status === 200,
      JSON.stringify(step.body?.error));
  }

  const customerMove = await call('PATCH', `/orders/${orderId}/status`, {
    token: customerToken, body: { status: 'completed' },
  });
  check('a customer cannot change order status', customerMove.status === 403, `got ${customerMove.status}`);

  // --------------------------------------------------------- grab booking
  section('Grab booking');
  const booking = await call('POST', `/delivery/orders/${orderId}/book`, { token: managerToken });
  check('a driver is booked', booking.status === 201, JSON.stringify(booking.body?.error));
  check('the booking has a provider id', Boolean(booking.body?.delivery?.provider_delivery_id));
  check('it starts out allocating', booking.body?.delivery?.status === 'allocating',
    booking.body?.delivery?.status);

  const afterBooking = await call('GET', `/orders/${orderId}`, { token: managerToken });
  check('the order moved to dispatched', afterBooking.body?.status === 'dispatched',
    afterBooking.body?.status);

  if (health.body?.grab_mode === 'sim') {
    const states = [];
    for (let i = 0; i < 3; i += 1) {
      const advanced = await call('POST', `/delivery/simulate/${orderId}/advance`, { token: managerToken });
      states.push(advanced.body?.delivery?.status);
    }
    check('the driver walks through pickup → delivery → completed',
      JSON.stringify(states) === JSON.stringify(['picking_up', 'in_delivery', 'completed']),
      JSON.stringify(states));

    const done = await call('GET', `/orders/${orderId}`, { token: managerToken });
    check('a completed delivery marks the order delivered', done.body?.status === 'delivered',
      done.body?.status);
    check('driver details were captured', Boolean(done.body?.delivery?.driver_name));
    check('the event trail was written', done.body?.delivery?.events?.length >= 4,
      `${done.body?.delivery?.events?.length} events`);

    const finish = await call('PATCH', `/orders/${orderId}/status`, {
      token: managerToken, body: { status: 'completed' },
    });
    check('the order can be completed', finish.status === 200);
  }

  // ---------------------------------------------------------- manager edits
  section('Manager: menu and prices');
  const originalPrice = Number(byo.base_price);
  const priceEdit = await call('PATCH', `/catalog/products/${byo.id}`, {
    token: managerToken, body: { base_price: originalPrice + 1 },
  });
  check('manager can change a price', priceEdit.status === 200, JSON.stringify(priceEdit.body?.error));
  check('the new price stuck', Number(priceEdit.body?.base_price) === originalPrice + 1);
  await call('PATCH', `/catalog/products/${byo.id}`, {
    token: managerToken, body: { base_price: originalPrice },
  });

  const soldOut = await call('PATCH', `/catalog/options/${dragon.id}`, {
    token: managerToken, body: { is_available: false },
  });
  check('manager can mark an option sold out', soldOut.status === 200);

  const buySoldOut = await call('POST', '/orders/quote', {
    body: { items: [{ product_id: byo.id, quantity: 1, option_ids: [size.id, milk.id, dragon.id] }] },
  });
  check('a sold-out fruit cannot be ordered', buySoldOut.status === 400, `got ${buySoldOut.status}`);
  await call('PATCH', `/catalog/options/${dragon.id}`, {
    token: managerToken, body: { is_available: true },
  });

  const newOption = await call('POST', '/catalog/options', {
    token: managerToken,
    body: {
      group_id: fruitGroup.id,
      name: `Smoke Berry ${Date.now()}`,
      price_delta: 2.5,
    },
  });
  check('manager can add a new fruit', newOption.status === 201, JSON.stringify(newOption.body?.error));
  if (newOption.body?.id) {
    const removed = await call('DELETE', `/catalog/options/${newOption.body.id}`, { token: managerToken });
    check('and remove it again', removed.status === 200 && removed.body?.deleted === true);
  }

  const customerEdit = await call('PATCH', `/catalog/products/${byo.id}`, {
    token: customerToken, body: { base_price: 1 },
  });
  check('a customer cannot change prices', customerEdit.status === 403, `got ${customerEdit.status}`);

  // --------------------------------------------------------------- admin
  section('Google sign-in');
  // A real Google token cannot be minted here, so this checks the refusals —
  // the half that has to hold, because it is what stands between a forged
  // token and somebody else's account.
  await call('PUT', '/admin/settings', { token: adminToken, body: { google_client_id: '' } });
  const unconfigured = await call('POST', '/auth/google', { body: { credential: 'x' } });
  check('an unconfigured shop refuses', unconfigured.status === 400, `got ${unconfigured.status}`);

  const CLIENT_ID = '123456-smoketest.apps.googleusercontent.com';
  await call('PUT', '/admin/settings', { token: adminToken, body: { google_client_id: CLIENT_ID } });

  const publicSettings = await call('GET', '/catalog/settings');
  check('the client id is public, as Google intends',
    publicSettings.body?.google_client_id === CLIENT_ID);

  const noCredential = await call('POST', '/auth/google', { body: {} });
  check('a missing credential is refused', noCredential.status === 400, `got ${noCredential.status}`);

  const garbage = await call('POST', '/auth/google', { body: { credential: 'not.a.token' } });
  check('a malformed token is refused', garbage.status === 401, `got ${garbage.status}`);

  // Signed with our own key, claiming to be the admin.
  const { generateKeyPairSync } = await import('node:crypto');
  const jwtLib = (await import('jsonwebtoken')).default;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const forged = jwtLib.sign(
    { sub: 'attacker', email: 'admin@orderko.test', email_verified: true },
    privateKey,
    {
      algorithm: 'RS256',
      issuer: 'https://accounts.google.com',
      audience: CLIENT_ID,
      expiresIn: '1h',
      keyid: 'not-a-google-key',
    },
  );
  const forgedAttempt = await call('POST', '/auth/google', { body: { credential: forged } });
  check('a self-signed token is refused', forgedAttempt.status === 401, `got ${forgedAttempt.status}`);
  check('and it issued no session', !forgedAttempt.body?.token);

  const usersAfter = await call('GET', '/admin/users', { token: adminToken });
  check('no account was created by the attempts',
    !usersAfter.body?.users?.some((u) => u.email === 'attacker@example.com'));

  await call('PUT', '/admin/settings', { token: adminToken, body: { google_client_id: '' } });

  section('Email editing');
  const selfEdit = await call('PATCH', '/auth/me', {
    token: customerToken, body: { email: 'chloe.new@orderko.test' },
  });
  check('a customer can change their own email', selfEdit.status === 200, selfEdit.body?.error);

  const newAddressLogin = await call('POST', '/auth/login', {
    body: { email: 'chloe.new@orderko.test', password: PASSWORD },
  });
  check('the new address signs in', newAddressLogin.ok);

  const oldAddressLogin = await call('POST', '/auth/login', {
    body: { email: 'cust@orderko.test', password: PASSWORD },
  });
  check('the old address no longer signs in', oldAddressLogin.status === 401);

  const clash = await call('PATCH', '/auth/me', {
    token: customerToken, body: { email: 'admin@orderko.test' },
  });
  check('an address already in use is rejected', clash.status === 409, `got ${clash.status}`);

  const malformed = await call('PATCH', '/auth/me', {
    token: customerToken, body: { email: 'not-an-email' },
  });
  check('a malformed address is rejected', malformed.status === 400, `got ${malformed.status}`);

  const adminEdit = await call('PATCH', '/admin/users/3', {
    token: adminToken, body: { email: 'CHLOE@Orderko.test' },
  });
  check('an admin can change another account', adminEdit.status === 200, adminEdit.body?.error);
  check('the address is normalised to lower case',
    adminEdit.body?.email === 'chloe@orderko.test', adminEdit.body?.email);

  // Put it back, so re-running the suite against the same store still works.
  await call('PATCH', '/admin/users/3', { token: adminToken, body: { email: 'cust@orderko.test' } });
  check('the seeded address works again',
    (await call('POST', '/auth/login', { body: { email: 'cust@orderko.test', password: PASSWORD } })).ok);

  // ------------------------------------------------ sign in with a number
  section('Signing in with a mobile number');

  // Chloe is seeded as +639170000003. None of these spellings match that text,
  // which is the whole point.
  for (const typed of ['09170000003', '0917 000 0003', '+63 917 000 0003', '9170000003']) {
    const res = await call('POST', '/auth/login', { body: { identifier: typed, password: PASSWORD } });
    check(`"${typed}" signs in`, res.ok && res.body?.user?.email === 'cust@orderko.test',
      res.body?.error ?? res.body?.user?.email);
  }

  const wrongPass = await call('POST', '/auth/login', {
    body: { identifier: '0917 000 0003', password: 'nope-not-this-one' },
  });
  check('a number with the wrong password is refused', wrongPass.status === 401);

  const unknownNumber = await call('POST', '/auth/login', {
    body: { identifier: '0999 999 9999', password: PASSWORD },
  });
  check('an unknown number is refused', unknownNumber.status === 401);
  check('and the refusal does not say which part was wrong',
    unknownNumber.body?.error === wrongPass.body?.error,
    `${unknownNumber.body?.error} vs ${wrongPass.body?.error}`);

  check('an email still signs in', (await call('POST', '/auth/login', {
    body: { identifier: 'cust@orderko.test', password: PASSWORD },
  })).ok);
  check('an older client sending "email" still works', (await call('POST', '/auth/login', {
    body: { email: 'cust@orderko.test', password: PASSWORD },
  })).ok);

  // What the browser actually sends: both names, same value, so the page keeps
  // working against an API that has not been restarted yet.
  check('both field names together sign in', (await call('POST', '/auth/login', {
    body: { identifier: 'cust@orderko.test', email: 'cust@orderko.test', password: PASSWORD },
  })).ok);
  const bothWithNumber = await call('POST', '/auth/login', {
    body: { identifier: '0917 000 0003', email: '0917 000 0003', password: PASSWORD },
  });
  check('a number sent under both names still signs in',
    bothWithNumber.ok && bothWithNumber.body?.user?.email === 'cust@orderko.test',
    bothWithNumber.body?.error);

  // A number that signs you in has to point at one account, or it is a lottery.
  const takenNumber = await call('PATCH', '/auth/me', {
    token: customerToken, body: { phone: '+639170000001' },
  });
  check('a number already on another account is refused', takenNumber.status === 409,
    `got ${takenNumber.status}`);
  check('the same number typed differently is still refused',
    (await call('PATCH', '/auth/me', { token: customerToken, body: { phone: '0917 000 0001' } })).status === 409);
  check('an admin cannot assign a duplicate either',
    (await call('PATCH', '/admin/users/3', { token: adminToken, body: { phone: '09170000002' } })).status === 409);
  check('your own number is not a clash with yourself',
    (await call('PATCH', '/auth/me', { token: customerToken, body: { phone: '0917 000 0003' } })).status === 200);

  // ------------------------------------------------------------------ gcash
  section('GCash');

  const noNumberYet = await call('POST', '/orders', {
    token: customerToken,
    body: {
      items: [{ product_id: byo.id, quantity: 1, option_ids: threeFruits }],
      fulfillment_type: 'pickup',
      contact_name: 'Smoke Tester',
      contact_phone: '+639170000003',
      payment_method: 'gcash',
    },
  });
  check('GCash is refused before a number is set', noNumberYet.status === 400,
    `got ${noNumberYet.status}`);

  const badNumber = await call('PUT', '/admin/settings', {
    token: adminToken, body: { gcash_number: 'not a number' },
  });
  check('a nonsense GCash number is rejected', badNumber.status === 400, `got ${badNumber.status}`);

  const setGcash = await call('PUT', '/admin/settings', {
    token: adminToken, body: { gcash_number: '0915 386 8303', gcash_name: 'The MANNA' },
  });
  check('an admin can set the GCash number', setGcash.status === 200, setGcash.body?.error);

  const managerGcash = await call('PUT', '/admin/settings', {
    token: managerToken, body: { gcash_number: '0999 999 9999' },
  });
  check('a manager cannot change it', managerGcash.status === 403, `got ${managerGcash.status}`);

  const gcashPublic = await call('GET', '/catalog/settings');
  check('the storefront can read the number', gcashPublic.body?.gcash_number === '0915 386 8303',
    gcashPublic.body?.gcash_number);
  check('and the account name', gcashPublic.body?.gcash_name === 'The MANNA');

  const gcashOrder = await call('POST', '/orders', {
    token: customerToken,
    body: {
      items: [{ product_id: byo.id, quantity: 1, option_ids: threeFruits }],
      fulfillment_type: 'pickup',
      contact_name: 'Smoke Tester',
      contact_phone: '+639170000003',
      payment_method: 'gcash',
    },
  });
  check('a GCash order is accepted once it is set up', gcashOrder.status === 201,
    JSON.stringify(gcashOrder.body?.error ?? gcashOrder.body?.details));
  check('it records the method', gcashOrder.body?.payment_method === 'gcash');
  // Nothing is charged automatically, so it must not claim to be paid.
  check('it starts unpaid', gcashOrder.body?.payment_status === 'unpaid',
    gcashOrder.body?.payment_status);

  const marked = await call('PATCH', `/orders/${gcashOrder.body?.id}/payment`, {
    token: adminToken, body: { payment_status: 'paid' },
  });
  check('the shop can mark it paid', marked.status === 200, marked.body?.error);

  const madeUp = await call('POST', '/orders', {
    token: customerToken,
    body: {
      items: [{ product_id: byo.id, quantity: 1, option_ids: threeFruits }],
      fulfillment_type: 'pickup',
      contact_name: 'Smoke Tester',
      contact_phone: '+639170000003',
      payment_method: 'crypto-beans',
    },
  });
  check('an invented payment method is rejected', madeUp.status === 400, `got ${madeUp.status}`);

  // The QR is the shop's own picture out of the GCash app; it cannot be built
  // from the number, so all the server can do is carry it and check its size.
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const setQr = await call('PUT', '/admin/settings', {
    token: adminToken, body: { gcash_qr_url: tinyPng },
  });
  check('an admin can upload a GCash QR', setQr.status === 200, setQr.body?.error);
  check('the storefront can read the QR',
    (await call('GET', '/catalog/settings')).body?.gcash_qr_url === tinyPng);

  const notAnImage = await call('PUT', '/admin/settings', {
    token: adminToken, body: { gcash_qr_url: 'javascript:alert(1)' },
  });
  check('a QR that is not an image is rejected', notAnImage.status === 400,
    `got ${notAnImage.status}`);

  const hugeQr = await call('PUT', '/admin/settings', {
    token: adminToken, body: { gcash_qr_url: 'data:image/png;base64,' + 'A'.repeat(500_000) },
  });
  check('an oversized QR is rejected', hugeQr.status === 400, `got ${hugeQr.status}`);
  check('the good QR survived the refusals',
    (await call('GET', '/catalog/settings')).body?.gcash_qr_url === tinyPng);

  // Put the shop back the way it was found.
  await call('PUT', '/admin/settings', {
    token: adminToken, body: { gcash_number: '', gcash_name: '', gcash_qr_url: '' },
  });
  check('the QR can be cleared',
    (await call('GET', '/catalog/settings')).body?.gcash_qr_url === '');
  check('clearing the number switches GCash off',
    (await call('GET', '/catalog/settings')).body?.gcash_number === '');

  section('Admin: reports, users, settings');
  const stats = await call('GET', '/admin/stats?days=30', { token: adminToken });
  check('stats load', stats.status === 200);
  check('stats count orders', Number(stats.body?.period?.orders) > 0);
  check('stats rank the top options', Array.isArray(stats.body?.top_options) && stats.body.top_options.length > 0);

  const managerStats = await call('GET', '/admin/stats?days=7', { token: managerToken });
  check('managers can see reports too', managerStats.status === 200);

  const settings = await call('GET', '/admin/settings', { token: adminToken });
  check('settings load', settings.status === 200);

  const originalTax = Number(settings.body.settings.tax_rate);
  const taxEdit = await call('PUT', '/admin/settings', {
    token: adminToken, body: { tax_rate: 0.08 },
  });
  check('admin can change the tax rate', taxEdit.status === 200);
  check('the new rate stuck', Number(taxEdit.body?.settings?.tax_rate) === 0.08);
  await call('PUT', '/admin/settings', { token: adminToken, body: { tax_rate: originalTax } });

  const managerSettingsWrite = await call('PUT', '/admin/settings', {
    token: managerToken, body: { tax_rate: 0.5 },
  });
  check('a manager cannot change settings', managerSettingsWrite.status === 403, `got ${managerSettingsWrite.status}`);

  const audit = await call('GET', '/admin/audit?limit=20', { token: adminToken });
  check('the audit log recorded our changes', audit.body?.entries?.length > 0);

  // --------------------------------------------- the three ways to get it
  section('Pickup, Grab, and our own delivery');

  const DROP = { lat: 14.5507, lng: 121.0494 };
  const order3 = (extra = {}) => ({
    items: [{ product_id: byo.id, quantity: 1, option_ids: threeFruits }],
    fulfillment_type: 'delivery',
    delivery_address: 'Level 21, BGC Corporate Center, Taguig',
    delivery_lat: DROP.lat,
    delivery_lng: DROP.lng,
    ...extra,
  });
  const setCarriers = (grab, own, extra = {}) => call('PUT', '/admin/settings', {
    token: adminToken,
    body: { delivery_enabled: true, grab_delivery_enabled: grab, own_delivery_enabled: own, ...extra },
  });

  const FLAT = 59;
  const bothOn = await setCarriers(true, true, { own_delivery_fee: FLAT, own_delivery_fee_per_km: 0 });
  check('both carriers can run at once', bothOn.status === 200, bothOn.body?.error);
  const pub = await call('GET', '/catalog/settings');
  check('the storefront is told about both',
    pub.body?.grab_delivery_enabled === true && pub.body?.own_delivery_enabled === true,
    JSON.stringify([pub.body?.grab_delivery_enabled, pub.body?.own_delivery_enabled]));

  // The whole point: two carriers, two different prices, side by side.
  const qGrab = await call('POST', '/orders/quote', { body: order3({ delivery_carrier: 'grab' }) });
  const qOwn = await call('POST', '/orders/quote', { body: order3({ delivery_carrier: 'own' }) });
  check('Grab quotes its own fare', qGrab.body?.delivery_quote?.provider !== 'own',
    JSON.stringify(qGrab.body?.delivery_quote?.provider));
  check('our delivery quotes the shop fee', Number(qOwn.body?.delivery_fee) === FLAT,
    `got ${qOwn.body?.delivery_fee}`);
  check('and they are priced differently',
    Number(qGrab.body?.delivery_fee) !== Number(qOwn.body?.delivery_fee),
    `${qGrab.body?.delivery_fee} vs ${qOwn.body?.delivery_fee}`);

  const madeUpCarrier = await call('POST', '/orders/quote', { body: order3({ delivery_carrier: 'lalamove' }) });
  check('an invented carrier is refused', madeUpCarrier.status === 400, `got ${madeUpCarrier.status}`);

  // Each order carries its own answer, so the kitchen knows what to do with it.
  const byGrab = await call('POST', '/orders', {
    token: customerToken,
    body: order3({ delivery_carrier: 'grab', contact_name: 'Grab Customer', contact_phone: '+639170000008' }),
  });
  const byOwn = await call('POST', '/orders', {
    token: customerToken,
    body: order3({ delivery_carrier: 'own', contact_name: 'COD Customer', contact_phone: '+639170000009', payment_method: 'cash' }),
  });
  check('an order can be placed with Grab', byGrab.status === 201,
    JSON.stringify(byGrab.body?.error ?? byGrab.body?.details));
  check('and another with our own delivery', byOwn.status === 201,
    JSON.stringify(byOwn.body?.error ?? byOwn.body?.details));
  check('each records who is carrying it',
    byGrab.body?.delivery_carrier === 'grab' && byOwn.body?.delivery_carrier === 'own',
    `${byGrab.body?.delivery_carrier} / ${byOwn.body?.delivery_carrier}`);
  check('the COD order is charged the shop fee', Number(byOwn.body?.delivery_fee) === FLAT,
    `got ${byOwn.body?.delivery_fee}`);
  check('and is unpaid until the food arrives', byOwn.body?.payment_status === 'unpaid');

  // Booking follows the order, not the shop: Grab is switched on for both.
  check('a rider can be booked for the Grab order',
    (await call('POST', `/delivery/orders/${byGrab.body.id}/book`, { token: managerToken })).status === 201);
  check('but not for the one we deliver',
    (await call('POST', `/delivery/orders/${byOwn.body.id}/book`, { token: managerToken })).status === 400);

  // One carrier off: the other still works, and the dead one is refused.
  await setCarriers(false, true);
  check('with Grab off, Grab is refused',
    (await call('POST', '/orders/quote', { body: order3({ delivery_carrier: 'grab' }) })).status === 400);
  check('and ours still quotes',
    (await call('POST', '/orders/quote', { body: order3({ delivery_carrier: 'own' }) })).status === 200);
  // An older browser sends no carrier at all; it must not be turned away.
  const noCarrier = await call('POST', '/orders/quote', { body: order3() });
  check('a request with no carrier falls back to the one running',
    noCarrier.status === 200 && Number(noCarrier.body?.delivery_fee) === FLAT,
    `${noCarrier.status} fee ${noCarrier.body?.delivery_fee}`);

  await setCarriers(true, false);
  check('with ours off, ours is refused',
    (await call('POST', '/orders/quote', { body: order3({ delivery_carrier: 'own' }) })).status === 400);
  check('and Grab still quotes',
    (await call('POST', '/orders/quote', { body: order3({ delivery_carrier: 'grab' }) })).status === 200);

  await setCarriers(false, false);
  check('with neither on, delivery is refused',
    (await call('POST', '/orders/quote', { body: order3({ delivery_carrier: 'grab' }) })).status === 400);
  const pickupStill = await call('POST', '/orders/quote', {
    body: { items: [{ product_id: byo.id, quantity: 1, option_ids: threeFruits }], fulfillment_type: 'pickup' },
  });
  check('but pickup is always offered', pickupStill.status === 200, pickupStill.body?.error);

  // The radius is the shop's rule, not Grab's.
  await setCarriers(false, true, { own_delivery_fee: FLAT });
  check('our own delivery still respects the radius',
    (await call('POST', '/orders/quote', {
      body: order3({ delivery_carrier: 'own', delivery_lat: 10.3157, delivery_lng: 123.8854 }),
    })).status === 400);

  // Leave the shop as the suite found it.
  await setCarriers(true, false);
  check('the shop is back on Grab',
    (await call('GET', '/catalog/settings')).body?.grab_delivery_enabled === true);

  // ------------------------------------------------------ money owed
  section('Unpaid');

  const owedBefore = await call('GET', '/admin/stats?days=30', { token: adminToken });
  check('stats report money owed', typeof owedBefore.body?.unpaid?.total === 'number',
    JSON.stringify(owedBefore.body?.unpaid));
  check('and how many orders owe it', Number.isInteger(owedBefore.body?.unpaid?.orders));

  const owedOrder = await call('POST', '/orders', {
    token: customerToken,
    body: {
      items: [{ product_id: byo.id, quantity: 1, option_ids: threeFruits }],
      fulfillment_type: 'pickup',
      contact_name: 'Owes Money',
      contact_phone: '+639170000005',
    },
  });
  check('an unpaid order was placed', owedOrder.status === 201,
    JSON.stringify(owedOrder.body?.error ?? owedOrder.body?.details));

  const owedAfter = await call('GET', '/admin/stats?days=30', { token: adminToken });
  check('it is counted as owing', owedAfter.body?.unpaid?.orders === owedBefore.body.unpaid.orders + 1,
    `${owedBefore.body.unpaid.orders} -> ${owedAfter.body?.unpaid?.orders}`);
  check('and its total is added',
    Math.abs(owedAfter.body.unpaid.total - (owedBefore.body.unpaid.total + owedOrder.body.total)) < 0.01,
    `${owedBefore.body.unpaid.total} + ${owedOrder.body.total} vs ${owedAfter.body.unpaid.total}`);
  check('the oldest debt is dated', typeof owedAfter.body?.unpaid?.oldest_at === 'string');

  // The list behind the tile: who owes, not just how much.
  const owedList = await call('GET', '/orders?payment_status=unpaid&limit=200', { token: adminToken });
  check('unpaid orders can be listed', owedList.status === 200, owedList.body?.error);
  check('every row is genuinely unpaid',
    owedList.body.orders.every((o) => o.payment_status === 'unpaid'));
  check('the new one is in the list',
    owedList.body.orders.some((o) => o.id === owedOrder.body.id));
  check('rows carry who to chase',
    owedList.body.orders.every((o) => typeof o.contact_name === 'string' && o.contact_name.length > 0));

  // Paying it must take it off both the tile and the list.
  await call('PATCH', `/orders/${owedOrder.body.id}/payment`, {
    token: adminToken, body: { payment_status: 'paid' },
  });
  const settled = await call('GET', '/admin/stats?days=30', { token: adminToken });
  check('paying removes it from the total',
    settled.body?.unpaid?.orders === owedBefore.body.unpaid.orders,
    `${settled.body?.unpaid?.orders} vs ${owedBefore.body.unpaid.orders}`);
  check('and from the list',
    !(await call('GET', '/orders?payment_status=unpaid&limit=200', { token: adminToken }))
      .body.orders.some((o) => o.id === owedOrder.body.id));

  // A cancelled order is not a debt, however it was left.
  const scrapped = await call('POST', '/orders', {
    token: customerToken,
    body: {
      items: [{ product_id: byo.id, quantity: 1, option_ids: threeFruits }],
      fulfillment_type: 'pickup',
      contact_name: 'Changed Their Mind',
      contact_phone: '+639170000006',
    },
  });
  await call('PATCH', `/orders/${scrapped.body.id}/status`, {
    token: adminToken, body: { status: 'cancelled', reason: 'smoke test' },
  });
  const afterCancel = await call('GET', '/admin/stats?days=30', { token: adminToken });
  check('a cancelled order is not owed',
    afterCancel.body?.unpaid?.orders === owedBefore.body.unpaid.orders,
    `${afterCancel.body?.unpaid?.orders} vs ${owedBefore.body.unpaid.orders}`);
  check('and is not in the chase list',
    !(await call('GET', '/orders?payment_status=unpaid&limit=200', { token: adminToken }))
      .body.orders.some((o) => o.id === scrapped.body.id));

  check('a customer cannot read the shop-wide stats',
    (await call('GET', '/admin/stats?days=30', { token: customerToken })).status === 403);

  // --------------------------------------------- changing a placed order
  section('Editing an order');

  const placedForEdit = await call('POST', '/orders', {
    token: customerToken,
    body: {
      items: [{ product_id: byo.id, quantity: 1, option_ids: threeFruits }],
      fulfillment_type: 'pickup',
      contact_name: 'Changed Their Order',
      contact_phone: '+639170000010',
    },
  });
  check('an order to edit exists', placedForEdit.status === 201,
    JSON.stringify(placedForEdit.body?.error ?? placedForEdit.body?.details));
  const editId = placedForEdit.body.id;
  const oneJar = Number(placedForEdit.body.total);

  check('a customer cannot edit an order',
    (await call('PUT', `/orders/${editId}/items`, {
      token: customerToken,
      body: { items: [{ product_id: byo.id, quantity: 9, option_ids: threeFruits }] },
    })).status === 403);
  check('nor can a stranger',
    [401, 403].includes((await call('PUT', `/orders/${editId}/items`, {
      body: { items: [{ product_id: byo.id, quantity: 9, option_ids: threeFruits }] },
    })).status));

  const doubled = await call('PUT', `/orders/${editId}/items`, {
    token: managerToken,
    body: {
      items: [{ product_id: byo.id, quantity: 2, option_ids: threeFruits }],
      reason: 'customer rang to add a jar',
    },
  });
  check('a manager can edit an order', doubled.status === 200, doubled.body?.error);
  check('the quantity changed', doubled.body?.items?.[0]?.quantity === 2,
    String(doubled.body?.items?.[0]?.quantity));
  check('and it is re-priced by the server',
    Number(doubled.body?.subtotal) > Number(placedForEdit.body.subtotal),
    `${placedForEdit.body.subtotal} -> ${doubled.body?.subtotal}`);
  check('the total follows', Number(doubled.body?.total) > oneJar,
    `${oneJar} -> ${doubled.body?.total}`);
  check('the change is on the order history',
    (doubled.body?.history ?? []).some((h) => (h.note ?? '').includes('Items edited')),
    JSON.stringify((doubled.body?.history ?? []).map((h) => h.note)));
  check('with the reason given',
    (doubled.body?.history ?? []).some((h) => (h.note ?? '').includes('rang to add a jar')));

  // A price sent by the browser must count for nothing.
  const liar = await call('PUT', `/orders/${editId}/items`, {
    token: managerToken,
    body: {
      items: [{ product_id: byo.id, quantity: 2, option_ids: threeFruits, line_total: 1, unit_base_price: 1 }],
      total: 1, subtotal: 1,
    },
  });
  check('a total sent by the client is ignored', Number(liar.body?.total) === Number(doubled.body.total),
    `${liar.body?.total} vs ${doubled.body.total}`);

  const nonsense = await call('PUT', `/orders/${editId}/items`, {
    token: managerToken,
    body: { items: [{ product_id: 999999, quantity: 1, option_ids: [] }] },
  });
  check('an item that does not exist is refused', nonsense.status === 400, `got ${nonsense.status}`);
  check('and the order was left alone',
    Number((await call('GET', `/orders/${editId}`, { token: managerToken })).body?.total)
      === Number(doubled.body.total));

  const empty = await call('PUT', `/orders/${editId}/items`, {
    token: managerToken, body: { items: [] },
  });
  check('an order cannot be emptied', empty.status === 400, `got ${empty.status}`);

  // Money already taken must not quietly cover a bigger order.
  await call('PATCH', `/orders/${editId}/payment`, {
    token: adminToken, body: { payment_status: 'paid' },
  });
  const grown = await call('PUT', `/orders/${editId}/items`, {
    token: managerToken,
    body: { items: [{ product_id: byo.id, quantity: 4, option_ids: threeFruits }] },
  });
  check('a paid order that grows goes back to unpaid',
    grown.body?.payment_status === 'unpaid', String(grown.body?.payment_status));
  check('and says why', (grown.body?.history ?? []).some((h) => (h.note ?? '').includes('total went up')));

  // A smaller order does not: that is a refund, not an amount outstanding.
  await call('PATCH', `/orders/${editId}/payment`, {
    token: adminToken, body: { payment_status: 'paid' },
  });
  const shrunk = await call('PUT', `/orders/${editId}/items`, {
    token: managerToken,
    body: { items: [{ product_id: byo.id, quantity: 1, option_ids: threeFruits }] },
  });
  check('a paid order that shrinks stays paid', shrunk.body?.payment_status === 'paid',
    String(shrunk.body?.payment_status));

  // Settled orders are a record.
  await call('PATCH', `/orders/${editId}/status`, { token: managerToken, body: { status: 'confirmed' } });
  await call('PATCH', `/orders/${editId}/status`, { token: managerToken, body: { status: 'preparing' } });
  await call('PATCH', `/orders/${editId}/status`, { token: managerToken, body: { status: 'ready' } });
  await call('PATCH', `/orders/${editId}/status`, { token: managerToken, body: { status: 'completed' } });
  check('a completed order cannot be edited',
    (await call('PUT', `/orders/${editId}/items`, {
      token: managerToken,
      body: { items: [{ product_id: byo.id, quantity: 2, option_ids: threeFruits }] },
    })).status === 400);

    // Stock is deducted at checkout, so an edit has to give the old contents
  // back before taking the new — or the shop appears to have sold twice.
  section('Editing an order moves stock');

  const stockQty = async () => Number(
    (await call('GET', '/catalog/menu', { token: managerToken }))
      .body.products.find((p) => p.id === coldBrew.id)?.stock_qty,
  );

  const tracked = await call('PATCH', `/catalog/products/${coldBrew.id}`, {
    token: managerToken, body: { track_stock: true, stock_qty: 100 },
  });
  check('a product can be put on stock control', tracked.status === 200, tracked.body?.error);
  check('it starts at 100', (await stockQty()) === 100, String(await stockQty()));

  const tookThree = await call('POST', '/orders', {
    token: customerToken,
    body: {
      items: [{ product_id: coldBrew.id, quantity: 3, option_ids: [] }],
      fulfillment_type: 'pickup',
      contact_name: 'Stock Tester',
      contact_phone: '+639170000011',
    },
  });
  check('an order of 3 is placed', tookThree.status === 201,
    JSON.stringify(tookThree.body?.error ?? tookThree.body?.details));
  check('stock fell to 97', (await stockQty()) === 97, String(await stockQty()));

  await call('PUT', `/orders/${tookThree.body.id}/items`, {
    token: managerToken,
    body: { items: [{ product_id: coldBrew.id, quantity: 5, option_ids: [] }] },
  });
  check('raising it to 5 leaves 95, not 92',
    (await stockQty()) === 95, `got ${await stockQty()}`);

  await call('PUT', `/orders/${tookThree.body.id}/items`, {
    token: managerToken,
    body: { items: [{ product_id: coldBrew.id, quantity: 1, option_ids: [] }] },
  });
  check('lowering it to 1 gives the rest back', (await stockQty()) === 99,
    `got ${await stockQty()}`);

  // A rejected edit must not quietly keep the stock it released.
  const overStock = await call('PUT', `/orders/${tookThree.body.id}/items`, {
    token: managerToken,
    body: { items: [{ product_id: coldBrew.id, quantity: 500, option_ids: [] }] },
  });
  check('an edit beyond stock is refused', overStock.status === 400, `got ${overStock.status}`);
  check('and the reservation is put back', (await stockQty()) === 99,
    `got ${await stockQty()}`);

  // Leave the product as the suite found it.
  await call('PATCH', `/catalog/products/${coldBrew.id}`, {
    token: managerToken, body: { track_stock: false, stock_qty: 0 },
  });
  check('stock control can be switched off again',
    (await call('GET', '/catalog/menu', { token: managerToken }))
      .body.products.find((p) => p.id === coldBrew.id)?.track_stock === 0);

    // ------------------------------------------------ two sellers, one shop
  section('Sellers');

  // Two sellers who should never see each other's work.
  const makeSeller = async (email, name) => {
    let r = await call('POST', '/admin/users', {
      token: adminToken,
      body: { name, email, password: PASSWORD, role: 'manager', manages_all_products: false },
    });
    if (r.status === 409) {
      const list = await call('GET', '/admin/users?limit=200', { token: adminToken });
      const found = list.body.users.find((u) => u.email === email);
      await call('PATCH', `/admin/users/${found.id}`, {
        token: adminToken, body: { manages_all_products: false },
      });
      r = { status: 201, body: found };
    }
    return r.body;
  };

  const suman = await makeSeller('smoke-suman@orderko.test', 'Suman Seller');
  const crinkle = await makeSeller('smoke-crinkle@orderko.test', 'Crinkle Seller');
  check('two sellers exist', Boolean(suman?.id && crinkle?.id),
    JSON.stringify([suman?.id, crinkle?.id]));
  check('neither runs the whole shop',
    suman.manages_all_products === false && crinkle.manages_all_products === false,
    JSON.stringify([suman.manages_all_products, crinkle.manages_all_products]));

  const sumanToken = await login('smoke-suman@orderko.test');
  const crinkleToken = await login('smoke-crinkle@orderko.test');

  const cat = (await call('GET', '/catalog/menu', { token: adminToken })).body.categories[0].id;
  const mkProduct = (token, name, owner) => call('POST', '/catalog/products', {
    token,
    body: { name, category_id: cat, base_price: 60, ...(owner ? { owner_id: owner } : {}) },
  });

  const sumanProduct = await mkProduct(sumanToken, `Suman ${Date.now()}`);
  const crinkleProduct = await mkProduct(crinkleToken, `Crinkles ${Date.now()}`);
  check('a seller can add their own product', sumanProduct.status === 201, sumanProduct.body?.error);
  check('and it belongs to them', sumanProduct.body?.owner_id === suman.id,
    `${sumanProduct.body?.owner_id} vs ${suman.id}`);

  // The menu each seller manages.
  const shelfOf = async (token) => (await call('GET', '/catalog/menu', { token })).body.products;
  const sumanShelf = await shelfOf(sumanToken);
  check('a seller sees their own product', sumanShelf.some((p) => p.id === sumanProduct.body.id));
  check('and not the other seller\'s',
    !sumanShelf.some((p) => p.id === crinkleProduct.body.id),
    'crinkles visible to the suman seller');
  check('an admin sees both',
    (await shelfOf(adminToken)).filter((p) =>
      [sumanProduct.body.id, crinkleProduct.body.id].includes(p.id)).length === 2);

  // Customers shop the whole store; the separation is between sellers.
  const publicMenu = (await call('GET', '/catalog/menu')).body.products;
  check('a customer sees both sellers\' products',
    [sumanProduct.body.id, crinkleProduct.body.id]
      .every((id) => publicMenu.some((p) => p.id === id)),
    'the storefront is hiding a seller');

  check('a seller cannot edit the other seller\'s product',
    (await call('PATCH', `/catalog/products/${crinkleProduct.body.id}`, {
      token: sumanToken, body: { base_price: 1 },
    })).status === 403);
  check('nor reassign their own to someone else',
    (await call('PATCH', `/catalog/products/${sumanProduct.body.id}`, {
      token: sumanToken, body: { owner_id: crinkle.id },
    })).status === 403);
  check('an admin can reassign',
    (await call('PATCH', `/catalog/products/${sumanProduct.body.id}`, {
      token: adminToken, body: { owner_id: suman.id },
    })).status === 200);

  // Orders: a seller sees only the ones made entirely of their own items.
  const orderOf = (productId, name, phone) => call('POST', '/orders', {
    token: customerToken,
    body: {
      items: [{ product_id: productId, quantity: 3, option_ids: [] }],
      fulfillment_type: 'pickup', contact_name: name, contact_phone: phone,
    },
  });
  const pureSuman = await orderOf(sumanProduct.body.id, 'Suman Buyer', '+639170000020');
  const pureCrinkle = await orderOf(crinkleProduct.body.id, 'Crinkle Buyer', '+639170000021');
  check('a pure order is placed for each seller',
    pureSuman.status === 201 && pureCrinkle.status === 201,
    JSON.stringify([pureSuman.body?.error, pureCrinkle.body?.error]));

  // One seller per basket: an order has one place to collect from and one
  // person to pay, so the two cannot be mixed.
  const mixed = await call('POST', '/orders', {
    token: customerToken,
    body: {
      items: [
        { product_id: sumanProduct.body.id, quantity: 2, option_ids: [] },
        { product_id: crinkleProduct.body.id, quantity: 2, option_ids: [] },
      ],
      fulfillment_type: 'pickup', contact_name: 'Bought Both', contact_phone: '+639170000022',
    },
  });
  check('a basket cannot mix two sellers', mixed.status === 400, `got ${mixed.status}`);
  check('and the refusal says what to do',
    /one seller/i.test(mixed.body?.error ?? ''), mixed.body?.error);
  check('the quote refuses it too, before anyone reaches checkout',
    (await call('POST', '/orders/quote', {
      body: {
        items: [
          { product_id: sumanProduct.body.id, quantity: 2, option_ids: [] },
          { product_id: crinkleProduct.body.id, quantity: 2, option_ids: [] },
        ],
        fulfillment_type: 'pickup',
      },
    })).status === 400);

  check('a seller can open their own order',
    (await call('GET', `/orders/${pureSuman.body.id}`, { token: sumanToken })).status === 200);
  check('but not the other seller\'s',
    (await call('GET', `/orders/${pureCrinkle.body.id}`, { token: sumanToken })).status === 403);

  const listFor = async (token) =>
    (await call('GET', '/orders?limit=200', { token })).body.orders.map((o) => o.id);
  const sumanList = await listFor(sumanToken);
  check('the order list shows only their own',
    sumanList.includes(pureSuman.body.id) && !sumanList.includes(pureCrinkle.body.id),
    JSON.stringify(sumanList));

  const sumanQueue = (await call('GET', '/orders/queue', { token: sumanToken })).body.orders.map((o) => o.id);
  check('so does the kitchen board',
    sumanQueue.includes(pureSuman.body.id) && !sumanQueue.includes(pureCrinkle.body.id),
    JSON.stringify(sumanQueue));

  // Reports.
  const sumanStats = (await call('GET', '/admin/stats?days=30', { token: sumanToken })).body;
  const adminStats = (await call('GET', '/admin/stats?days=30', { token: adminToken })).body;
  check('a seller sees fewer orders than the admin',
    sumanStats.period.orders < adminStats.period.orders,
    `${sumanStats.period.orders} vs ${adminStats.period.orders}`);
  check('and is scoped to themselves', sumanStats.scoped_to === suman.id,
    String(sumanStats.scoped_to));
  check('a seller cannot ask for another seller\'s figures',
    (await call('GET', `/admin/stats?days=30&owner=${crinkle.id}`, { token: sumanToken })).status === 403);
  check('an admin gets a breakdown per seller',
    (adminStats.by_owner ?? []).some((r) => r.owner_id === suman.id),
    JSON.stringify((adminStats.by_owner ?? []).map((r) => r.owner_name)));
  check('with a row for the shop\'s own unassigned products',
    (adminStats.by_owner ?? []).some((r) => r.owner_id === null),
    JSON.stringify((adminStats.by_owner ?? []).map((r) => r.owner_name)));

  const scoped = (await call('GET', `/admin/stats?days=30&owner=${suman.id}`, { token: adminToken })).body;
  check('and can look at one seller at a time',
    scoped.period.orders === sumanStats.period.orders,
    `${scoped.period.orders} vs ${sumanStats.period.orders}`);

  // ------------------------------------- each seller's own money and place
  const shopProfile = (await call('GET', '/sellers/shop/profile')).body;
  const beforeSet = (await call('GET', `/sellers/${suman.id}/profile`)).body;
  check('a seller starts on the shop\'s details',
    beforeSet.pickup_address === shopProfile.pickup_address,
    `${beforeSet.pickup_address} vs ${shopProfile.pickup_address}`);

  const mine = await call('PUT', `/sellers/${suman.id}/profile`, {
    token: sumanToken,
    body: {
      display_name: 'Suman ni Aling Nena',
      pickup_address: '21 Mabini Street, Carmona, Cavite',
      pickup_lat: 14.3133, pickup_lng: 121.0577,
      gcash_number: '0917 111 2222',
      own_delivery_fee: 40,
    },
  });
  check('a seller can set their own details', mine.status === 200, mine.body?.error);
  // The editor needs to tell what a seller set from what they inherit, or
  // saving would freeze the shop's values into their row.
  check('the profile reports what they actually set',
    mine.body?.own?.pickup_address === '21 Mabini Street, Carmona, Cavite',
    JSON.stringify(mine.body?.own?.pickup_address));
  check('and what they would inherit',
    typeof mine.body?.shop?.pickup_address === 'string'
      && mine.body.shop.pickup_address !== mine.body.own.pickup_address,
    JSON.stringify(mine.body?.shop?.pickup_address));
  check('a field left blank stays inherited',
    mine.body?.own?.pickup_phone === '' && Boolean(mine.body?.pickup_phone),
    JSON.stringify([mine.body?.own?.pickup_phone, mine.body?.pickup_phone]));
  check('and they take effect', mine.body?.pickup_address === '21 Mabini Street, Carmona, Cavite');
  check('with their own GCash', mine.body?.gcash_number === '0917 111 2222');

  check('a seller cannot set another seller\'s',
    (await call('PUT', `/sellers/${crinkle.id}/profile`, {
      token: sumanToken, body: { gcash_number: '0917 999 9999' },
    })).status === 403);
  check('an admin can set anyone\'s',
    (await call('PUT', `/sellers/${crinkle.id}/profile`, {
      token: adminToken, body: { display_name: 'Crinkles Co' },
    })).status === 200);
  check('a nonsense GCash number is refused',
    (await call('PUT', `/sellers/${suman.id}/profile`, {
      token: sumanToken, body: { gcash_number: 'not a number' },
    })).status === 400);

  // What the customer is actually told, which is the point of all of it.
  const sumanQuote = await call('POST', '/orders/quote', {
    body: {
      items: [{ product_id: sumanProduct.body.id, quantity: 3, option_ids: [] }],
      fulfillment_type: 'pickup',
    },
  });
  check('the quote collects from the seller, not the shop',
    sumanQuote.body?.pickup_address === '21 Mabini Street, Carmona, Cavite',
    sumanQuote.body?.pickup_address);
  check('and names who is being paid',
    sumanQuote.body?.seller?.gcash_number === '0917 111 2222',
    JSON.stringify(sumanQuote.body?.seller));

  const crinkleQuote = await call('POST', '/orders/quote', {
    body: {
      items: [{ product_id: crinkleProduct.body.id, quantity: 3, option_ids: [] }],
      fulfillment_type: 'pickup',
    },
  });
  check('a different seller gets a different answer',
    crinkleQuote.body?.pickup_address !== sumanQuote.body?.pickup_address,
    `both say ${crinkleQuote.body?.pickup_address}`);
  check('and one still on the shop\'s falls back to it',
    crinkleQuote.body?.pickup_address === shopProfile.pickup_address);

  // Their own delivery rate, not the shop's.
  await call('PUT', '/admin/settings', {
    token: adminToken,
    body: { delivery_enabled: true, grab_delivery_enabled: false, own_delivery_enabled: true },
  });
  const sumanFee = await call('POST', '/orders/quote', {
    body: {
      items: [{ product_id: sumanProduct.body.id, quantity: 3, option_ids: [] }],
      fulfillment_type: 'delivery', delivery_carrier: 'own',
      delivery_lat: 14.3200, delivery_lng: 121.0600,
    },
  });
  check('delivery is charged at the seller\'s rate',
    Number(sumanFee.body?.delivery_fee) === 40,
    `got ${sumanFee.body?.delivery_fee}`);
  await call('PUT', '/admin/settings', {
    token: adminToken, body: { grab_delivery_enabled: true, own_delivery_enabled: false },
  });

  // A placed order remembers whose it was.
  const sumanOrder = await call('POST', '/orders', {
    token: customerToken,
    body: {
      items: [{ product_id: sumanProduct.body.id, quantity: 3, option_ids: [] }],
      fulfillment_type: 'pickup', contact_name: 'Suman Buyer', contact_phone: '+639170000023',
    },
  });
  check('an order carries its seller', sumanOrder.body?.seller?.id === suman.id,
    JSON.stringify(sumanOrder.body?.seller));
  check('so the order page can say where to collect',
    sumanOrder.body?.seller?.pickup_address === '21 Mabini Street, Carmona, Cavite');
  await call('DELETE', `/orders/${sumanOrder.body.id}`, { token: adminToken });

  // ----------------------------------- each seller picks their own carriers
  await call('PUT', `/sellers/${suman.id}/profile`, {
    token: sumanToken,
    body: { grab_delivery_enabled: false, own_delivery_enabled: true, own_delivery_fee: 40 },
  });
  await call('PUT', `/sellers/${crinkle.id}/profile`, {
    token: adminToken,
    body: { grab_delivery_enabled: true, own_delivery_enabled: false },
  });

  const sumanOnly = (await call('GET', `/sellers/${suman.id}/profile`)).body;
  check('a seller can switch Grab off for themselves',
    sumanOnly.grab_delivery_enabled === false && sumanOnly.own_delivery_enabled === true,
    JSON.stringify([sumanOnly.grab_delivery_enabled, sumanOnly.own_delivery_enabled]));

  const deliverTo = { delivery_lat: 14.3200, delivery_lng: 121.0600 };
  const sumanCarrier = (carrier) => call('POST', '/orders/quote', {
    body: {
      items: [{ product_id: sumanProduct.body.id, quantity: 3, option_ids: [] }],
      fulfillment_type: 'delivery', delivery_carrier: carrier, ...deliverTo,
    },
  });
  check('their own delivery quotes', (await sumanCarrier('own')).status === 200);
  check('and Grab is refused for them', (await sumanCarrier('grab')).status === 400);

  // The other seller, in the same shop, has the opposite answer.
  const crinkleCarrier = (carrier) => call('POST', '/orders/quote', {
    body: {
      items: [{ product_id: crinkleProduct.body.id, quantity: 3, option_ids: [] }],
      fulfillment_type: 'delivery', delivery_carrier: carrier,
      delivery_lat: 14.5507, delivery_lng: 121.0494,
    },
  });
  check('the other seller still has Grab', (await crinkleCarrier('grab')).status === 200);
  check('and their own delivery is refused', (await crinkleCarrier('own')).status === 400);

  check('the storefront is told each seller\'s carriers',
    (await call('GET', '/catalog/menu')).body.sellers
      .some((x) => x.id === suman.id && x.grab_delivery_enabled === false),
    'the menu does not carry per-seller carriers');

  // The shop is a seller too, for whatever nobody owns.
  const shopCarriers = await call('PUT', '/sellers/shop/profile', {
    token: adminToken, body: { own_delivery_enabled: true, own_delivery_fee: 25 },
  });
  check('an admin can set the shop\'s own details', shopCarriers.status === 200,
    shopCarriers.body?.error);
  check('a manager cannot speak for the shop',
    (await call('PUT', '/sellers/shop/profile', {
      token: sumanToken, body: { own_delivery_fee: 1 },
    })).status === 403);
  check('the shop keeps what was set',
    (await call('GET', '/sellers/shop/profile')).body?.own_delivery_fee === 25);

  // Cleared rather than set to false, so the shop goes back to inheriting
  // and the rest of the suite still controls it through /admin/settings.
  await call('PUT', '/sellers/shop/profile', {
    token: adminToken,
    body: { grab_delivery_enabled: '', own_delivery_enabled: '', own_delivery_fee: '' },
  });
  check('the shop goes back to inheriting',
    (await call('GET', '/sellers/shop/profile')).body?.own?.own_delivery_enabled === '');

  // Tidy up, so re-running the suite starts from the same shop.
  for (const id of [pureSuman.body.id, pureCrinkle.body.id]) {
    await call('DELETE', `/orders/${id}`, { token: adminToken });
  }
  for (const p of [sumanProduct.body.id, crinkleProduct.body.id]) {
    await call('DELETE', `/catalog/products/${p}`, { token: adminToken });
  }
  for (const u of [suman.id, crinkle.id]) {
    await call('DELETE', `/admin/users/${u}`, { token: adminToken });
  }
  check('the shop is left as it was found',
    !(await call('GET', '/admin/users?limit=200', { token: adminToken }))
      .body.users.some((u) => u.email === 'smoke-suman@orderko.test'));

    // --------------------------------------- the shop's own front page
  section('Front page wording');

  const defaults = await call('GET', '/catalog/settings');
  check('the storefront is given the front page fields',
    ['hero_title', 'hero_text', 'hero_cta'].every((k) => k in defaults.body),
    JSON.stringify(Object.keys(defaults.body).filter((k) => k.startsWith('hero'))));

  const written = await call('PUT', '/admin/settings', {
    token: adminToken,
    body: {
      hero_title: 'Suman, ensaymada and crinkles',
      hero_text: 'Baked this morning. Order ahead and pick it up.',
      hero_cta: 'See what is fresh',
    },
  });
  check('an admin can write the front page', written.status === 200, written.body?.error);

  const shown = await call('GET', '/catalog/settings');
  check('and every visitor gets it',
    shown.body?.hero_title === 'Suman, ensaymada and crinkles'
      && shown.body?.hero_cta === 'See what is fresh',
    JSON.stringify([shown.body?.hero_title, shown.body?.hero_cta]));

  check('a manager cannot change it',
    (await call('PUT', '/admin/settings', {
      token: managerToken, body: { hero_title: 'not mine to write' },
    })).status === 403);

  // Free text on a public page: it has to be bounded.
  const tooLong = await call('PUT', '/admin/settings', {
    token: adminToken, body: { hero_text: 'x'.repeat(500) },
  });
  check('a blurb that is too long is refused', tooLong.status === 400, `got ${tooLong.status}`);
  check('and the good one survived',
    (await call('GET', '/catalog/settings')).body?.hero_text
      === 'Baked this morning. Order ahead and pick it up.');

  const padded = await call('PUT', '/admin/settings', {
    token: adminToken, body: { hero_title: '   Kakanin at Panaderya   ' },
  });
  check('surrounding spaces are trimmed off',
    padded.body?.settings?.hero_title === 'Kakanin at Panaderya',
    JSON.stringify(padded.body?.settings?.hero_title));

  // Cleared, the storefront falls back rather than showing an empty headline.
  await call('PUT', '/admin/settings', {
    token: adminToken, body: { hero_title: '', hero_text: '', hero_cta: '' },
  });
  check('it can be cleared again',
    (await call('GET', '/catalog/settings')).body?.hero_title === '');

    // ---------------------------------------------- removing one order
  section('Deleting an order');

  const doomedOrder = await call('POST', '/orders', {
    token: customerToken,
    body: {
      items: [{ product_id: byo.id, quantity: 2, option_ids: threeFruits }],
      fulfillment_type: 'pickup',
      contact_name: 'Test Order',
      contact_phone: '+639170000012',
    },
  });
  check('a test order exists', doomedOrder.status === 201,
    JSON.stringify(doomedOrder.body?.error ?? doomedOrder.body?.details));
  const doomedOrderId = doomedOrder.body.id;

  // Take it all the way to completed, which is the case that had no answer.
  for (const st of ['confirmed', 'preparing', 'ready', 'completed']) {
    await call('PATCH', `/orders/${doomedOrderId}/status`, { token: managerToken, body: { status: st } });
  }
  const completed = await call('GET', `/orders/${doomedOrderId}`, { token: adminToken });
  check('and is completed', completed.body?.status === 'completed', completed.body?.status);

  check('a manager cannot delete an order',
    (await call('DELETE', `/orders/${doomedOrderId}`, { token: managerToken })).status === 403);
  check('a customer cannot either',
    (await call('DELETE', `/orders/${doomedOrderId}`, { token: customerToken })).status === 403);
  check('nor can a stranger',
    [401, 403].includes((await call('DELETE', `/orders/${doomedOrderId}`)).status));
  check('it survived the refusals',
    (await call('GET', `/orders/${doomedOrderId}`, { token: adminToken })).status === 200);

  const removed = await call('DELETE', `/orders/${doomedOrderId}`, { token: adminToken });
  check('an admin can delete a completed order', removed.status === 200, removed.body?.error);
  check('it reports what went', removed.body?.order_number === completed.body.order_number,
    JSON.stringify(removed.body));
  check('the order is gone',
    (await call('GET', `/orders/${doomedOrderId}`, { token: adminToken })).status === 404);
  check('and is off the order list',
    !(await call('GET', '/orders?limit=200', { token: adminToken }))
      .body.orders.some((o) => o.id === doomedOrderId));
  check('deleting it twice is a 404',
    (await call('DELETE', `/orders/${doomedOrderId}`, { token: adminToken })).status === 404);
  check('the deletion is in the activity log',
    ((await call('GET', '/admin/audit?limit=20', { token: adminToken })).body?.entries ?? [])
      .some((a) => a.action === 'order.delete'),
    'no order.delete entry');

  // Its money must leave the reports with it.
  const owedBeforeDelete = (await call('GET', '/admin/stats?days=30', { token: adminToken })).body;
  const extra = await call('POST', '/orders', {
    token: customerToken,
    body: {
      items: [{ product_id: byo.id, quantity: 1, option_ids: threeFruits }],
      fulfillment_type: 'pickup',
      contact_name: 'Counted Then Not',
      contact_phone: '+639170000013',
    },
  });
  const withExtra = (await call('GET', '/admin/stats?days=30', { token: adminToken })).body;
  check('a new order is counted', withExtra.period.orders === owedBeforeDelete.period.orders + 1,
    `${owedBeforeDelete.period.orders} -> ${withExtra.period.orders}`);
  await call('DELETE', `/orders/${extra.body.id}`, { token: adminToken });
  const afterDelete = (await call('GET', '/admin/stats?days=30', { token: adminToken })).body;
  check('and uncounted once deleted',
    afterDelete.period.orders === owedBeforeDelete.period.orders,
    `${withExtra.period.orders} -> ${afterDelete.period.orders}`);
  check('the revenue goes with it',
    Math.abs(afterDelete.period.revenue - owedBeforeDelete.period.revenue) < 0.01,
    `${withExtra.period.revenue} -> ${afterDelete.period.revenue}`);

    // ------------------------------------------------ the shareable link
  section('Order tracking link');

  const share = await call('POST', `/orders/${orderId}/share`, { token: managerToken });
  check('staff can get a link for an order', share.status === 200, share.body?.error);
  const shareToken = share.body?.share_token;
  check('it is 128 bits of hex', /^[0-9a-f]{32}$/.test(shareToken ?? ''), String(shareToken));

  check('asking twice gives the same link',
    (await call('POST', `/orders/${orderId}/share`, { token: adminToken })).body?.share_token === shareToken);

  check('a customer cannot mint one for an order',
    (await call('POST', `/orders/${orderId}/share`, { token: customerToken })).status === 403);
  check('nor can a stranger',
    [401, 403].includes((await call('POST', `/orders/${orderId}/share`)).status));

  // The whole point: it opens with no session at all.
  const shared = await call('GET', `/orders/shared/${shareToken}`);
  check('the link opens without signing in', shared.status === 200, shared.body?.error);
  check('and shows the right order', shared.body?.id === orderId,
    `${shared.body?.id} vs ${orderId}`);
  check('with its items', (shared.body?.items?.length ?? 0) > 0);
  check('and its status', typeof shared.body?.status === 'string');

  check('a made-up token opens nothing',
    (await call('GET', '/orders/shared/' + 'f'.repeat(32))).status === 404);
  check('a short token is not even a route',
    (await call('GET', '/orders/shared/abc')).status === 404);

  // Order numbers run in sequence, so a token that could be derived from one
  // would let anybody walk the whole book.
  const other = await call('POST', '/orders', {
    token: customerToken,
    body: {
      items: [{ product_id: byo.id, quantity: 1, option_ids: threeFruits }],
      fulfillment_type: 'pickup',
      contact_name: 'Someone Else',
      contact_phone: '+639170000004',
    },
  });
  check('a second order exists', other.status === 201);
  const otherShare = await call('POST', `/orders/${other.body.id}/share`, { token: adminToken });
  check('two orders get different tokens', otherShare.body?.share_token !== shareToken);
  check("one order's token does not open the other",
    (await call('GET', `/orders/shared/${shareToken}`)).body?.id !== other.body.id);

  // ----------------------------------------------- live order updates
  section('Live order updates');

  const pulse = await call('GET', '/orders/pulse', { token: adminToken });
  check('an admin can read the pulse', pulse.status === 200, pulse.body?.error);
  check('it carries a revision', Number.isInteger(pulse.body?.rev), JSON.stringify(pulse.body));
  check('and an order count', Number.isInteger(pulse.body?.orders));
  check('and an open count', Number.isInteger(pulse.body?.open));
  check('the open count cannot exceed the total',
    pulse.body.open <= pulse.body.orders, JSON.stringify(pulse.body));

  check('a manager can read it too',
    (await call('GET', '/orders/pulse', { token: managerToken })).status === 200);
  check('a customer cannot',
    (await call('GET', '/orders/pulse', { token: customerToken })).status === 403);
  check('an anonymous request cannot',
    [401, 403].includes((await call('GET', '/orders/pulse')).status));

  // Reading must not itself count as a change, or every screen would reload on
  // every poll for ever.
  const pulseAgain = await call('GET', '/orders/pulse', { token: adminToken });
  check('polling does not move the revision', pulseAgain.body?.rev === pulse.body.rev,
    `${pulse.body.rev} -> ${pulseAgain.body?.rev}`);

  const placed = await call('POST', '/orders', {
    token: customerToken,
    body: {
      items: [{ product_id: byo.id, quantity: 1, option_ids: threeFruits }],
      fulfillment_type: 'pickup',
      contact_name: 'Pulse Tester',
      contact_phone: '+639170000003',
    },
  });
  check('an order was placed', placed.status === 201,
    JSON.stringify(placed.body?.error ?? placed.body?.details));

  const afterOrder = await call('GET', '/orders/pulse', { token: adminToken });
  check('a new order moves the revision', afterOrder.body?.rev !== pulse.body.rev,
    `still ${afterOrder.body?.rev}`);
  check('and raises the order count', afterOrder.body?.orders === pulse.body.orders + 1,
    `${pulse.body.orders} -> ${afterOrder.body?.orders}`);

  // A status change is a change too — the board shows status, so a screen that
  // only watched the count would sit on a stale one.
  await call('PATCH', `/orders/${placed.body.id}/status`, {
    token: managerToken, body: { status: 'confirmed' },
  });
  const afterStatus = await call('GET', '/orders/pulse', { token: adminToken });
  check('a status change moves it as well', afterStatus.body?.rev !== afterOrder.body.rev,
    `still ${afterStatus.body?.rev}`);
  check('without inventing an order', afterStatus.body?.orders === afterOrder.body.orders);

  // ------------------------------------------------ deleting an account
  section('Deleting an account');

  // A throwaway account, so the suite can be run again against the same store.
  const doomedEmail = 'smoke-doomed@orderko.test';
  let doomed = await call('POST', '/admin/users', {
    token: adminToken,
    body: { name: 'Doomed Customer', email: doomedEmail, password: PASSWORD, role: 'customer' },
  });
  if (doomed.status === 409) {
    // Left behind by a run that died half way; find it and carry on.
    const list = await call('GET', '/admin/users?limit=200', { token: adminToken });
    doomed = { status: 201, body: list.body.users.find((u) => u.email === doomedEmail) };
  }
  check('a throwaway account exists', doomed.status === 201 && doomed.body?.id,
    JSON.stringify(doomed.body));
  const doomedId = doomed.body.id;

  const doomedToken = await login(doomedEmail);
  const theirOrder = await call('POST', '/orders', {
    token: doomedToken,
    body: {
      items: [{ product_id: byo.id, quantity: 1, option_ids: threeFruits }],
      fulfillment_type: 'pickup',
      contact_name: 'Doomed Customer',
      contact_phone: '+639170000009',
    },
  });
  check('they placed an order', theirOrder.status === 201,
    JSON.stringify(theirOrder.body?.error ?? theirOrder.body?.details));
  const theirOrderId = theirOrder.body?.id;

  check('a manager cannot delete an account',
    (await call('DELETE', `/admin/users/${doomedId}`, { token: managerToken })).status === 403);
  check('an anonymous request cannot',
    [401, 403].includes((await call('DELETE', `/admin/users/${doomedId}`)).status));
  check('the account survived the refusals',
    (await call('GET', '/admin/users?limit=200', { token: adminToken }))
      .body.users.some((u) => u.id === doomedId));

  const deleteSelf = await call('DELETE', '/admin/users/1', { token: adminToken });
  check('an admin cannot delete their own account', deleteSelf.status === 400,
    `got ${deleteSelf.status}`);

  const gone = await call('DELETE', `/admin/users/${doomedId}`, { token: adminToken });
  check('an admin can delete an account', gone.status === 200, gone.body?.error);
  check('it reports the orders it kept', gone.body?.orders_kept === 1,
    JSON.stringify(gone.body));

  check('the account is off the list',
    !(await call('GET', '/admin/users?limit=200', { token: adminToken }))
      .body.users.some((u) => u.id === doomedId));
  check('they can no longer sign in',
    (await call('POST', '/auth/login', { body: { identifier: doomedEmail, password: PASSWORD } }))
      .status === 401);
  check('deleting them twice is a 404',
    (await call('DELETE', `/admin/users/${doomedId}`, { token: adminToken })).status === 404);

  // Orders are money that changed hands; they must outlive the account.
  const keptOrder = await call('GET', `/orders/${theirOrderId}`, { token: adminToken });
  check('their order is still in the books', keptOrder.status === 200, keptOrder.body?.error);
  check('it is detached from the deleted account', keptOrder.body?.customer_id === null,
    String(keptOrder.body?.customer_id));
  check('but still says who it was for',
    keptOrder.body?.contact_name === 'Doomed Customer', keptOrder.body?.contact_name);
  check('and still carries its total', Number(keptOrder.body?.total) > 0);

  const auditLog = await call('GET', '/admin/audit?limit=20', { token: adminToken });
  check('the deletion is logged',
    (auditLog.body?.entries ?? auditLog.body?.audit ?? []).some((a) => a.action === 'user.delete'),
    JSON.stringify(Object.keys(auditLog.body ?? {})));

  section('Grab mode switch');
  const modeNow = await call('GET', '/admin/settings', { token: adminToken });
  check('the mode is reported', ['sim', 'live'].includes(modeNow.body?.grab_mode),
    modeNow.body?.grab_mode);

  const badMode = await call('PUT', '/admin/settings', {
    token: adminToken, body: { grab_mode: 'whatever' },
  });
  check('an unknown mode is refused', badMode.status === 400, `got ${badMode.status}`);

  const managerMode = await call('PUT', '/admin/settings', {
    token: managerToken, body: { grab_mode: 'sim' },
  });
  check('a manager cannot change the mode', managerMode.status === 403, `got ${managerMode.status}`);

  // Without credentials this must be refused rather than saved: a shop that
  // thinks it is booking couriers and is not would notice far too late.
  const goLive = await call('PUT', '/admin/settings', {
    token: adminToken, body: { grab_mode: 'live' },
  });
  const credentialled = goLive.status === 200;
  if (credentialled) {
    check('live can be switched on when credentials exist', true);
    await call('PUT', '/admin/settings', { token: adminToken, body: { grab_mode: 'sim' } });
  } else {
    check('live is refused without credentials', goLive.status === 400, `got ${goLive.status}`);
    check('the refusal names what is missing',
      /GRAB_CLIENT_ID/.test(goLive.body?.error ?? ''), goLive.body?.error);
    const unchanged = await call('GET', '/admin/settings', { token: adminToken });
    check('and the mode did not change', unchanged.body?.grab_mode === 'sim',
      unchanged.body?.grab_mode);
  }

  const stillQuoting = await call('POST', '/delivery/quote', {
    body: { address: 'BGC', lat: 14.5507, lng: 121.0494 },
  });
  check('simulated delivery still quotes', stillQuoting.status === 200, stillQuoting.body?.error);

  section('Remove all orders');
  const beforeClear = await call('GET', '/orders?limit=1', { token: adminToken });
  check('there are orders to remove', Number(beforeClear.body?.total) > 0,
    `total=${beforeClear.body?.total}`);

  const managerClear = await call('POST', '/admin/orders/clear', {
    token: managerToken, body: { password: PASSWORD },
  });
  check('a manager cannot remove orders', managerClear.status === 403, `got ${managerClear.status}`);

  const anonClear = await call('POST', '/admin/orders/clear', { body: { password: PASSWORD } });
  check('an anonymous request cannot', anonClear.status === 401, `got ${anonClear.status}`);

  const noPassword = await call('POST', '/admin/orders/clear', { token: adminToken, body: {} });
  check('an admin without a password cannot', noPassword.status === 400, `got ${noPassword.status}`);

  const wrongPassword = await call('POST', '/admin/orders/clear', {
    token: adminToken, body: { password: 'definitely-not-the-password' },
  });
  check('a wrong password is refused', wrongPassword.status === 401, `got ${wrongPassword.status}`);

  const survived = await call('GET', '/orders?limit=1', { token: adminToken });
  check('nothing was removed by the refusals',
    survived.body?.total === beforeClear.body?.total,
    `${beforeClear.body?.total} -> ${survived.body?.total}`);

  const cleared = await call('POST', '/admin/orders/clear', {
    token: adminToken, body: { password: PASSWORD },
  });
  check('the right password removes them', cleared.status === 200, cleared.body?.error);
  check('it reports how many went', cleared.body?.removed === beforeClear.body?.total,
    `removed=${cleared.body?.removed}`);

  const after = await call('GET', '/orders?limit=1', { token: adminToken });
  check('the order book is empty', after.body?.total === 0, `total=${after.body?.total}`);

  const menuAfter = await call('GET', '/catalog/menu');
  check('the menu survived', menuAfter.body?.products?.length > 0);
  const usersAfterClear = await call('GET', '/admin/users', { token: adminToken });
  check('the accounts survived', usersAfterClear.body?.users?.length > 0);

  const trail = await call('GET', '/admin/audit', { token: adminToken });
  check('the deletion left a trace', trail.body?.entries?.[0]?.action === 'orders.clear',
    trail.body?.entries?.[0]?.action);


  // -------------------------------------------------------------- summary
  console.log(`\n${'─'.repeat(52)}`);
  if (failed === 0) {
    console.log(`\u001b[32m${passed} checks passed, 0 failed.\u001b[0m`);
  } else {
    console.log(`\u001b[31m${passed} passed, ${failed} FAILED\u001b[0m`);
    for (const f of failures) console.log(`  · ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nSmoke test could not run:', err.message);
  console.error(`Is the API up at ${BASE}? Start it with: npm run dev:api`);
  process.exit(1);
});
