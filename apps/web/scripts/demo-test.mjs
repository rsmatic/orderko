#!/usr/bin/env node
// Checks the demo backend enforces the same rules as apps/api.
// Run: npm run test:demo --workspace apps/web
// Exercises the demo backend in Node, with a localStorage stub.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const BACKEND = new URL('../src/demo/backend.js', import.meta.url).href;
const { demoRequest } = await import(BACKEND);

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS ' + name); }
  else { fail += 1; failures.push(name); console.log('  FAIL ' + name + (detail ? '  -- ' + detail : '')); }
};
const call = async (m, p, b, t) => {
  try { return { ok: true, body: await demoRequest(m, p, b, t) }; }
  catch (e) { return { ok: false, status: e.status, error: e.message }; }
};

console.log('\nAuth');
const admin = await call('POST', '/auth/login', { email: 'admin@orderko.test', password: 'Password123!' });
const manager = await call('POST', '/auth/login', { email: 'manager@orderko.test', password: 'Password123!' });
const cust = await call('POST', '/auth/login', { email: 'cust@orderko.test', password: 'Password123!' });
check('admin logs in', admin.ok && admin.body.user.role === 'admin', admin.error);
check('manager logs in', manager.ok && manager.body.user.role === 'manager');
check('customer logs in', cust.ok && cust.body.user.role === 'customer');
const wrongPw = await call('POST', '/auth/login', { email: 'admin@orderko.test', password: 'nope12345' });
check('wrong password rejected', !wrongPw.ok && wrongPw.status === 401);
const aT = admin.body.token;
const mT = manager.body.token;
const cT = cust.body.token;

console.log('\nRole boundaries');
check('customer blocked from /admin/users', (await call('GET', '/admin/users', null, cT)).status === 403);
check('manager blocked from /admin/users', (await call('GET', '/admin/users', null, mT)).status === 403);
check('admin allowed on /admin/users', (await call('GET', '/admin/users', null, aT)).ok);
check('anonymous blocked from queue', (await call('GET', '/orders/queue')).status === 401);
check('manager allowed on queue', (await call('GET', '/orders/queue', null, mT)).ok);

console.log('\nMenu');
const menu = await call('GET', '/catalog/menu');
check('menu loads with 5 products', menu.ok && menu.body.products.length === 5);
const byo = menu.body.products.find((p) => p.slug === 'build-your-own-oats');
const fruit = byo.option_groups.find((g) => g.slug === 'fruit-mix');
check('fruit mix capped at 3', fruit.max_select === 3);
check('has banana, mango, dragon fruit',
  ['Banana', 'Mango', 'Dragon Fruit'].every((n) => fruit.options.some((o) => o.name === n)));
const nuts = byo.option_groups.find((g) => g.slug === 'nuts-seeds');
check('has walnuts and chia seeds',
  ['Walnuts', 'Chia Seeds'].every((n) => nuts.options.some((o) => o.name === n)));
const spreads = byo.option_groups.find((g) => g.slug === 'spreads');
check('has Skippy peanut butter', spreads.options.some((o) => o.name.includes('Skippy')));
check('milk base is single-choice', byo.option_groups.find((g) => g.slug === 'milk-base').input_type === 'single');

console.log('\nPricing');
const id = (n) => {
  for (const g of byo.option_groups) {
    const o = g.options.find((x) => x.name === n);
    if (o) return o.id;
  }
  throw new Error('no option named ' + n);
};
const size = id('Regular (350ml)');
const milk = id('Oat Milk');
const three = [size, milk, id('Banana'), id('Mango'), id('Dragon Fruit'), id('Walnuts'), id('Chia Seeds'), id('Peanut Butter (Skippy)')];

const q = await call('POST', '/orders/quote', { items: [{ product_id: byo.id, quantity: 2, option_ids: three }] });
check('three fruits plus add-ons prices cleanly', q.ok, q.error);
const expected = (12 + 0 + 2 + 1.5 + 2.5 + 2.5 + 2.5 + 1.5 + 3) * 2;
check('total matches the option sum',
  Math.abs(q.body.items[0].line_total - expected) < 0.01,
  'want ' + expected + ' got ' + (q.body && q.body.items[0].line_total));
check('tax applied', q.body.tax > 0);

const four = await call('POST', '/orders/quote', {
  items: [{ product_id: byo.id, quantity: 1, option_ids: [size, milk, id('Banana'), id('Mango'), id('Dragon Fruit'), id('Strawberry')] }],
});
check('a 4th fruit is rejected', !four.ok && four.status === 400, four.error);

const noMilk = await call('POST', '/orders/quote', { items: [{ product_id: byo.id, quantity: 1, option_ids: [size, id('Banana')] }] });
check('missing required milk rejected', !noMilk.ok, noMilk.error);

const cold = menu.body.products.find((p) => p.slug === 'cold-brew-coffee');
const wrong = await call('POST', '/orders/quote', { items: [{ product_id: cold.id, quantity: 1, option_ids: [id('Banana')] }] });
check('option from another product rejected', !wrong.ok, wrong.error);

const tiny = await call('POST', '/orders', {
  items: [{ product_id: cold.id, quantity: 1, option_ids: [] }],
  fulfillment_type: 'pickup', contact_name: 'Tiny', contact_phone: '+60111111111',
}, cT);
check('order below the minimum rejected', !tiny.ok, tiny.error);

console.log('\nCheckout and Grab');
const order = await call('POST', '/orders', {
  items: [{ product_id: byo.id, quantity: 1, option_ids: three, notes: 'Extra cold' }],
  fulfillment_type: 'delivery', contact_name: 'Smoke Tester', contact_phone: '+60123000003',
  delivery_address: 'Menara Binjai, Jalan Ampang', delivery_lat: 3.158, delivery_lng: 101.715,
  payment_method: 'ewallet',
}, cT);
check('order created', order.ok, order.error);
const oid = order.body && order.body.id;
check('order number is formatted', /^OK-\d{6}$/.test((order.body && order.body.order_number) || ''));
check('all 8 options kept', order.body && order.body.items[0].options.length === 8);
check('delivery fee charged', order.body && order.body.delivery_fee > 0);
check('item note survived', order.body && order.body.items[0].notes === 'Extra cold');
check('history starts at pending', order.body && order.body.history[0].to_status === 'pending');

const other = await call('POST', '/auth/register', { email: 'nosy@example.com', password: 'Password123!', name: 'Nosy Neighbour' });
check('another customer cannot read it', (await call('GET', '/orders/' + oid, null, other.body.token)).status === 403);
check('anonymous cannot read it', (await call('GET', '/orders/' + oid)).status === 403);

check('illegal status jump refused', (await call('PATCH', '/orders/' + oid + '/status', { status: 'delivered' }, mT)).status === 400);
for (const s of ['confirmed', 'preparing', 'ready']) {
  const r = await call('PATCH', '/orders/' + oid + '/status', { status: s }, mT);
  check('manager advances to ' + s, r.ok, r.error);
}
check('customer cannot change status', (await call('PATCH', '/orders/' + oid + '/status', { status: 'completed' }, cT)).status === 403);

const book = await call('POST', '/delivery/orders/' + oid + '/book', {}, mT);
check('driver booked', book.ok && book.body.delivery.status === 'allocating', book.error);
check('order moved to dispatched', (await call('GET', '/orders/' + oid, null, mT)).body.status === 'dispatched');

const states = [];
for (let i = 0; i < 3; i += 1) {
  const r = await call('POST', '/delivery/simulate/' + oid + '/advance', {}, mT);
  states.push(r.body && r.body.delivery && r.body.delivery.status);
}
check('driver walks picking_up -> in_delivery -> completed',
  JSON.stringify(states) === JSON.stringify(['picking_up', 'in_delivery', 'completed']), JSON.stringify(states));

const done = await call('GET', '/orders/' + oid, null, mT);
check('completed delivery marks order delivered', done.body.status === 'delivered', done.body.status);
check('driver details captured', Boolean(done.body.delivery.driver_name));
check('event trail written', done.body.delivery.events.length >= 4);
check('order can be completed', (await call('PATCH', '/orders/' + oid + '/status', { status: 'completed' }, mT)).ok);

console.log('\nManager and admin');
const pe = await call('PATCH', '/catalog/products/' + byo.id, { base_price: 13 }, mT);
check('manager changes a price', pe.ok && pe.body.base_price === 13, pe.error);
await call('PATCH', '/catalog/products/' + byo.id, { base_price: 12 }, mT);
check('customer cannot change prices', (await call('PATCH', '/catalog/products/' + byo.id, { base_price: 1 }, cT)).status === 403);

check('manager marks an option sold out', (await call('PATCH', '/catalog/options/' + id('Dragon Fruit'), { is_available: false }, mT)).ok);
check('sold-out fruit cannot be ordered',
  !(await call('POST', '/orders/quote', { items: [{ product_id: byo.id, quantity: 1, option_ids: [size, milk, id('Dragon Fruit')] }] })).ok);
await call('PATCH', '/catalog/options/' + id('Dragon Fruit'), { is_available: true }, mT);

const newOpt = await call('POST', '/catalog/options', { group_id: fruit.id, name: 'Test Berry', price_delta: 2.5 }, mT);
check('manager adds a fruit', newOpt.ok, newOpt.error);
check('and removes it', (await call('DELETE', '/catalog/options/' + newOpt.body.id, null, mT)).body.deleted === true);

const stats = await call('GET', '/admin/stats?days=30', null, aT);
check('stats load', stats.ok && stats.body.period.orders > 0, stats.error);
check('stats rank top options', stats.body.top_options.length > 0);
check('stats have a daily series', stats.body.daily.length > 1, stats.body.daily.length + ' days');
check('stats have best sellers', stats.body.top_products.length > 0);
check('managers can see reports', (await call('GET', '/admin/stats?days=7', null, mT)).ok);

const tax = await call('PUT', '/admin/settings', { tax_rate: 0.08 }, aT);
check('admin changes the tax rate', tax.ok && tax.body.settings.tax_rate === 0.08);
await call('PUT', '/admin/settings', { tax_rate: 0.06 }, aT);
check('manager cannot change settings', (await call('PUT', '/admin/settings', { tax_rate: 0.5 }, mT)).status === 403);
check('audit log recorded changes', (await call('GET', '/admin/audit', null, aT)).body.entries.length > 0);

const queue = await call('GET', '/orders/queue', null, mT);
check('kitchen queue has live orders', queue.body.orders.length > 0, queue.body.orders.length + ' orders');
check('queue tickets carry their options', queue.body.orders.some((o) => o.items.some((i) => i.option_summary)));

const users = await call('GET', '/admin/users', null, aT);
check('admin sees users with order counts', users.body.users.some((u) => u.order_count > 0));

console.log('\n' + '-'.repeat(48));
if (fail === 0) console.log(pass + ' checks passed, 0 failed.');
else {
  console.log(pass + ' passed, ' + fail + ' FAILED');
  for (const f of failures) console.log('  . ' + f);
}
process.exit(fail === 0 ? 0 : 1);
