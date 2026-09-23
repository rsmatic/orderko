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
