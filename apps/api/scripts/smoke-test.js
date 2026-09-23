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

const login = async (email) => {
  const res = await call('POST', '/auth/login', { body: { email, password: PASSWORD } });
  if (!res.ok) throw new Error(`Login failed for ${email}: ${res.body?.error}`);
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

  const nutsGroup = byo?.option_groups?.find((g) => g.slug === 'nuts-seeds');
  check('add-ons include walnuts and chia seeds',
    ['Walnuts', 'Chia Seeds'].every((n) => nutsGroup?.options?.some((o) => o.name === n)));

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
  const chia = nutsGroup.options.find((o) => o.name === 'Chia Seeds');
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
