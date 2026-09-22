/**
 * Seed data for demo mode, mirroring db/seed.sql.
 *
 * Keep the two in step: the demo exists so the published site behaves like a
 * real deployment, and it stops being useful the moment the catalogs diverge.
 */

export const SEED_PASSWORD = 'Password123!';

export const seedUsers = () => [
  { id: 1, email: 'admin@orderko.test',   password: SEED_PASSWORD, name: 'Aida Admin',     phone: '+60123000001', role: 'admin',    is_active: 1, created_at: daysAgo(90) },
  { id: 2, email: 'manager@orderko.test', password: SEED_PASSWORD, name: 'Marcus Manager', phone: '+60123000002', role: 'manager',  is_active: 1, created_at: daysAgo(80) },
  { id: 3, email: 'cust@orderko.test',    password: SEED_PASSWORD, name: 'Chloe Customer', phone: '+60123000003', role: 'customer', is_active: 1, created_at: daysAgo(40) },
];

export const seedSettings = () => ({
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
});

export const seedCategories = () => [
  { id: 1, name: 'Signature Overnight Oats', slug: 'signature',      sort_order: 1, is_active: 1 },
  { id: 2, name: 'Build Your Own',           slug: 'build-your-own', sort_order: 2, is_active: 1 },
  { id: 3, name: 'Drinks',                   slug: 'drinks',         sort_order: 3, is_active: 1 },
];

export const seedProducts = () => [
  {
    id: 1, category_id: 2, name: 'Build Your Own Oats', slug: 'build-your-own-oats',
    description: 'Start with our rolled-oat base soaked overnight, then pick your milk, fruit mix and toppings.',
    base_price: 12.0, image_url: 'https://images.unsplash.com/photo-1517093157656-b9eccef91cb1?w=800&q=70',
    is_active: 1, track_stock: 0, stock_qty: 0, sort_order: 1,
  },
  {
    id: 2, category_id: 1, name: 'Classic Banana & Honey', slug: 'classic-banana-honey',
    description: 'Rolled oats soaked in fresh milk with banana, a swirl of honey and a pinch of cinnamon.',
    base_price: 14.0, image_url: 'https://images.unsplash.com/photo-1484723091739-30a097e8f929?w=800&q=70',
    is_active: 1, track_stock: 0, stock_qty: 0, sort_order: 2,
  },
  {
    id: 3, category_id: 1, name: 'Tropical Mango Dragon', slug: 'tropical-mango-dragon',
    description: 'Coconut-milk oats layered with mango and dragon fruit, finished with toasted coconut.',
    base_price: 16.5, image_url: 'https://images.unsplash.com/photo-1490474418585-ba9bad8fd0ea?w=800&q=70',
    is_active: 1, track_stock: 0, stock_qty: 0, sort_order: 3,
  },
  {
    id: 4, category_id: 1, name: 'Peanut Butter Power', slug: 'peanut-butter-power',
    description: 'Skippy peanut butter blended through oat milk oats, with banana and crushed peanuts.',
    base_price: 16.0, image_url: 'https://images.unsplash.com/photo-1495214783159-3503fd1b572d?w=800&q=70',
    is_active: 1, track_stock: 0, stock_qty: 0, sort_order: 4,
  },
  {
    id: 5, category_id: 3, name: 'Cold Brew Coffee', slug: 'cold-brew-coffee',
    description: '16-hour cold brew, served black over ice.',
    base_price: 9.0, image_url: 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?w=800&q=70',
    is_active: 1, track_stock: 0, stock_qty: 0, sort_order: 5,
  },
];

export const seedOptionGroups = () => [
  { id: 1, name: 'Jar Size',     slug: 'jar-size',   description: 'How hungry are you?',                 input_type: 'single', min_select: 1, max_select: 1, is_required: 1, sort_order: 1, is_active: 1 },
  { id: 2, name: 'Milk Base',    slug: 'milk-base',  description: 'What we soak the oats in overnight.', input_type: 'single', min_select: 1, max_select: 1, is_required: 1, sort_order: 2, is_active: 1 },
  { id: 3, name: 'Fruit Mix',    slug: 'fruit-mix',  description: 'Mix and match up to 3 fresh fruits.', input_type: 'multi',  min_select: 1, max_select: 3, is_required: 1, sort_order: 3, is_active: 1 },
  { id: 4, name: 'Nuts & Seeds', slug: 'nuts-seeds', description: 'Crunch and protein.',                 input_type: 'multi',  min_select: 0, max_select: 0, is_required: 0, sort_order: 4, is_active: 1 },
  { id: 5, name: 'Spreads',      slug: 'spreads',    description: 'Stirred through or swirled on top.',  input_type: 'multi',  min_select: 0, max_select: 2, is_required: 0, sort_order: 5, is_active: 1 },
  { id: 6, name: 'Sweetener',    slug: 'sweetener',  description: 'Pick one, or skip it entirely.',      input_type: 'single', min_select: 0, max_select: 1, is_required: 0, sort_order: 6, is_active: 1 },
  { id: 7, name: 'Extras',       slug: 'extras',     description: 'Little upgrades.',                    input_type: 'multi',  min_select: 0, max_select: 0, is_required: 0, sort_order: 7, is_active: 1 },
];

const OPTION_ROWS = [
  // group, name, description, price_delta, sort_order
  [1, 'Regular (350ml)', 'One jar, one breakfast.',              0.0,  1],
  [1, 'Large (500ml)',   'For the seriously hungry.',            3.5,  2],

  [2, 'Fresh Milk',      'Full cream dairy milk.',               0.0,  1],
  [2, 'Oat Milk',        'Barista-grade, naturally sweet.',      2.0,  2],
  [2, 'Almond Milk',     'Light and nutty.',                     2.0,  3],
  [2, 'Soy Milk',        'Extra protein, dairy free.',           1.5,  4],
  [2, 'Coconut Milk',    'Rich and tropical.',                   2.5,  5],
  [2, 'Greek Yogurt',    'Thick, tangy, high protein.',          3.0,  6],

  [3, 'Banana',          'Sliced fresh each morning.',           1.5,  1],
  [3, 'Mango',           'Sweet Harumanis cubes.',               2.5,  2],
  [3, 'Dragon Fruit',    'Red-fleshed, mildly sweet.',           2.5,  3],
  [3, 'Strawberry',      'Halved Cameron Highlands berries.',    3.0,  4],
  [3, 'Blueberry',       'Whole, frozen-fresh.',                 3.0,  5],
  [3, 'Kiwi',            'Tart green slices.',                   2.0,  6],
  [3, 'Green Apple',     'Crisp diced apple.',                   1.5,  7],

  [4, 'Walnuts',         'Toasted halves.',                      2.5,  1],
  [4, 'Almonds',         'Sliced and toasted.',                  2.0,  2],
  [4, 'Crushed Peanuts', 'Roasted and lightly salted.',          1.5,  3],
  [4, 'Chia Seeds',      'One tablespoon, soaked in.',           1.5,  4],
  [4, 'Pumpkin Seeds',   'Dry-roasted pepitas.',                 1.5,  5],
  [4, 'Flax Seeds',      'Ground, for the omega-3s.',            1.0,  6],
  [4, 'Granola Crunch',  'House-baked oat cluster topping.',     3.0,  7],

  [5, 'Peanut Butter (Skippy)', 'Creamy, one generous scoop.',   3.0,  1],
  [5, 'Almond Butter',   'Unsweetened, stone-ground.',           4.0,  2],
  [5, 'Nutella',         'For when it is that kind of morning.', 3.5,  3],
  [5, 'Biscoff Spread',  'Speculoos, swirled on top.',           3.5,  4],

  [6, 'Honey',           'Local wildflower honey.',              1.0,  1],
  [6, 'Maple Syrup',     'Grade A amber.',                       2.0,  2],
  [6, 'Gula Melaka',     'Palm sugar syrup.',                    1.5,  3],
  [6, 'Date Syrup',      'Refined-sugar free.',                  2.0,  4],

  [7, 'Protein Scoop',   'Unflavoured whey, 20g protein.',       4.5,  1],
  [7, 'Cacao Nibs',      'Bitter dark chocolate crunch.',        2.0,  2],
  [7, 'Toasted Coconut', 'Shaved and toasted.',                  1.5,  3],
  [7, 'Cinnamon Dust',   'Ceylon cinnamon.',                     0.0,  4],
  [7, 'Extra Oats',      'Half portion more of the base.',       2.0,  5],
];

export const seedOptions = () =>
  OPTION_ROWS.map(([group_id, name, description, price_delta, sort_order], i) => ({
    id: i + 1,
    group_id,
    name,
    description,
    price_delta,
    image_url: null,
    is_available: 1,
    track_stock: 0,
    stock_qty: 0,
    sort_order,
  }));

// Build Your Own offers everything; signature jars skip the milk choice because
// it is already part of the recipe. Cold Brew has no choices at all.
export const seedProductOptionGroups = () => [
  ...[1, 2, 3, 4, 5, 6, 7].map((g, i) => ({ product_id: 1, group_id: g, sort_order: i })),
  ...[1, 3, 4, 5, 6, 7].map((g, i) => ({ product_id: 2, group_id: g, sort_order: i })),
  ...[1, 3, 4, 5, 6, 7].map((g, i) => ({ product_id: 3, group_id: g, sort_order: i })),
  ...[1, 3, 4, 5, 6, 7].map((g, i) => ({ product_id: 4, group_id: g, sort_order: i })),
];

function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

const minsAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();

/**
 * A little order history, so the manager board and the reports have something
 * to show the first time someone opens them.
 */
export function seedOrders(optionsById) {
  const opt = (name) => optionsById.find((o) => o.name === name);
  const line = (names) =>
    names.map((n) => {
      const o = opt(n);
      return { option_id: o.id, group_name: groupName(o.group_id), option_name: o.name, price_delta: o.price_delta };
    });

  const orders = [];
  const orderItems = [];
  const orderItemOptions = [];
  const history = [];
  const deliveries = [];
  const deliveryEvents = [];

  let itemId = 0;
  let optRowId = 0;

  // A spread of completed orders over the last fortnight, so the charts have
  // a shape rather than a single spike.
  const RECIPES = [
    { product: 2, name: 'Classic Banana & Honey', opts: ['Regular (350ml)', 'Banana', 'Honey'] },
    { product: 3, name: 'Tropical Mango Dragon',  opts: ['Regular (350ml)', 'Mango', 'Dragon Fruit', 'Toasted Coconut'] },
    { product: 4, name: 'Peanut Butter Power',    opts: ['Large (500ml)', 'Banana', 'Crushed Peanuts', 'Peanut Butter (Skippy)'] },
    { product: 1, name: 'Build Your Own Oats',    opts: ['Regular (350ml)', 'Oat Milk', 'Banana', 'Mango', 'Chia Seeds', 'Honey'] },
    { product: 1, name: 'Build Your Own Oats',    opts: ['Large (500ml)', 'Almond Milk', 'Strawberry', 'Blueberry', 'Walnuts', 'Maple Syrup'] },
    { product: 5, name: 'Cold Brew Coffee',       opts: [] },
  ];

  const basePrice = { 1: 12.0, 2: 14.0, 3: 16.5, 4: 16.0, 5: 9.0 };
  let orderId = 0;

  for (let day = 13; day >= 0; day -= 1) {
    const perDay = 2 + ((day * 7) % 4); // 2..5, deterministic
    for (let n = 0; n < perDay; n += 1) {
      orderId += 1;
      const recipe = RECIPES[(day + n) % RECIPES.length];
      const chosen = line(recipe.opts);
      const optionsTotal = round2(chosen.reduce((s, o) => s + o.price_delta, 0));
      const qty = n === 0 ? 2 : 1;
      const unit = round2(basePrice[recipe.product] + optionsTotal);
      const lineTotal = round2(unit * qty);
      const isDelivery = (day + n) % 3 === 0;
      const deliveryFee = isDelivery ? 6.0 : 0;
      const tax = round2(lineTotal * 0.06);
      const createdAt = new Date(Date.now() - day * 86_400_000 - (n * 47 + 30) * 60_000).toISOString();

      orders.push({
        id: orderId,
        order_number: `OK-${String(240000 + orderId).padStart(6, '0')}`,
        customer_id: 3,
        status: 'completed',
        fulfillment_type: isDelivery ? 'delivery' : 'pickup',
        contact_name: 'Chloe Customer',
        contact_phone: '+60123000003',
        contact_email: 'cust@orderko.test',
        delivery_address: isDelivery ? 'Unit 8-3, Residensi Damai, Jalan Maarof, 59100 Kuala Lumpur' : null,
        delivery_notes: null,
        delivery_lat: isDelivery ? 3.1421 : null,
        delivery_lng: isDelivery ? 101.674 : null,
        subtotal: lineTotal,
        delivery_fee: deliveryFee,
        tax,
        discount: 0,
        total: round2(lineTotal + deliveryFee + tax),
        currency: 'MYR',
        payment_method: isDelivery ? 'ewallet' : 'card',
        payment_status: 'paid',
        notes: null,
        scheduled_for: null,
        cancelled_reason: null,
        created_at: createdAt,
      });

      itemId += 1;
      orderItems.push({
        id: itemId, order_id: orderId, product_id: recipe.product, product_name: recipe.name,
        quantity: qty, unit_base_price: basePrice[recipe.product], unit_options_price: optionsTotal,
        line_total: lineTotal, notes: null,
      });
      for (const o of chosen) {
        optRowId += 1;
        orderItemOptions.push({ id: optRowId, order_item_id: itemId, ...o });
      }
      history.push({ order_id: orderId, from_status: null, to_status: 'pending', changed_by: 3, note: 'Order placed', created_at: createdAt });
      history.push({ order_id: orderId, from_status: 'ready', to_status: 'completed', changed_by: 2, note: null, created_at: createdAt });
    }
  }

  // Three live orders so the kitchen board is not empty on first load.
  const live = [
    { status: 'pending',   mins: 4,  type: 'delivery', recipe: RECIPES[3] },
    { status: 'preparing', mins: 18, type: 'pickup',   recipe: RECIPES[1] },
    { status: 'ready',     mins: 26, type: 'delivery', recipe: RECIPES[2] },
  ];

  for (const l of live) {
    orderId += 1;
    const chosen = line(l.recipe.opts);
    const optionsTotal = round2(chosen.reduce((s, o) => s + o.price_delta, 0));
    const unit = round2(basePrice[l.recipe.product] + optionsTotal);
    const isDelivery = l.type === 'delivery';
    const deliveryFee = isDelivery ? 6.5 : 0;
    const tax = round2(unit * 0.06);

    orders.push({
      id: orderId,
      order_number: `OK-${String(240000 + orderId).padStart(6, '0')}`,
      customer_id: l.status === 'pending' ? null : 3,
      status: l.status,
      fulfillment_type: l.type,
      contact_name: l.status === 'pending' ? 'Walk-in Guest' : 'Chloe Customer',
      contact_phone: l.status === 'pending' ? '+60129998888' : '+60123000003',
      contact_email: l.status === 'pending' ? null : 'cust@orderko.test',
      delivery_address: isDelivery ? 'Level 21, Menara Binjai, Jalan Ampang, 50450 Kuala Lumpur' : null,
      delivery_notes: isDelivery ? 'Leave with the guard house' : null,
      delivery_lat: isDelivery ? 3.158 : null,
      delivery_lng: isDelivery ? 101.715 : null,
      subtotal: unit,
      delivery_fee: deliveryFee,
      tax,
      discount: 0,
      total: round2(unit + deliveryFee + tax),
      currency: 'MYR',
      payment_method: 'cash',
      payment_status: 'unpaid',
      notes: l.status === 'preparing' ? 'Allergic to walnuts — please double check' : null,
      scheduled_for: null,
      cancelled_reason: null,
      created_at: minsAgo(l.mins),
    });

    itemId += 1;
    orderItems.push({
      id: itemId, order_id: orderId, product_id: l.recipe.product, product_name: l.recipe.name,
      quantity: 1, unit_base_price: basePrice[l.recipe.product], unit_options_price: optionsTotal,
      line_total: unit, notes: null,
    });
    for (const o of chosen) {
      optRowId += 1;
      orderItemOptions.push({ id: optRowId, order_item_id: itemId, ...o });
    }
    history.push({ order_id: orderId, from_status: null, to_status: 'pending', changed_by: null, note: 'Order placed', created_at: minsAgo(l.mins) });
  }

  return { orders, orderItems, orderItemOptions, history, deliveries, deliveryEvents, nextOrderId: orderId + 1, nextItemId: itemId + 1, nextOptRowId: optRowId + 1 };
}

const GROUP_NAMES = {
  1: 'Jar Size', 2: 'Milk Base', 3: 'Fruit Mix', 4: 'Nuts & Seeds',
  5: 'Spreads', 6: 'Sweetener', 7: 'Extras',
};
const groupName = (id) => GROUP_NAMES[id];

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
