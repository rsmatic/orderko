-- Overnight Oats ordering system - seed data
-- Password for every seeded account is: Password123!
-- (bcrypt hash below; regenerate with apps/api/scripts/hash.js)

SET NAMES utf8mb4;

-- ---------------------------------------------------------------- users

INSERT INTO users (email, password_hash, name, phone, role) VALUES
  ('admin@orderko.test',   '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', 'Aida Admin',    '+60123000001', 'admin'),
  ('manager@orderko.test', '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', 'Marcus Manager', '+60123000002', 'manager'),
  ('cust@orderko.test',    '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', 'Chloe Customer', '+60123000003', 'customer');

-- ---------------------------------------------------------------- settings

INSERT INTO settings (setting_key, setting_value, description) VALUES
  ('shop_name',        JSON_QUOTE('Orderko Overnight Oats'),                 'Display name'),
  ('currency',         JSON_QUOTE('MYR'),                                    'ISO currency code'),
  ('tax_rate',         CAST('0.06' AS JSON),                                 'Service tax applied to subtotal'),
  ('pickup_address',   JSON_QUOTE('12 Jalan Kemuning, Bangsar, 59100 Kuala Lumpur'), 'Where Grab picks up'),
  ('pickup_lat',       CAST('3.1298' AS JSON),                               'Pickup latitude'),
  ('pickup_lng',       CAST('101.6708' AS JSON),                             'Pickup longitude'),
  ('pickup_phone',     JSON_QUOTE('+60312345678'),                           'Contact for the driver'),
  ('min_order_total',  CAST('12.00' AS JSON),                                'Minimum basket before checkout'),
  ('delivery_enabled', CAST('true' AS JSON),                                 'Offer Grab delivery at checkout'),
  ('order_lead_mins',  CAST('20' AS JSON),                                   'Prep time before an order is ready');

-- ---------------------------------------------------------------- catalog

INSERT INTO categories (id, name, slug, sort_order) VALUES
  (1, 'Signature Overnight Oats', 'signature', 1),
  (2, 'Build Your Own',           'build-your-own', 2),
  (3, 'Drinks',                   'drinks', 3);

INSERT INTO products (id, category_id, name, slug, description, base_price, image_url, sort_order) VALUES
  (1, 2, 'Build Your Own Oats',    'build-your-own-oats',
      'Start with our rolled-oat base soaked overnight, then pick your milk, fruit mix and toppings.', 12.00,
      'https://images.unsplash.com/photo-1517093157656-b9eccef91cb1?w=800&q=70', 1),
  (2, 1, 'Classic Banana & Honey', 'classic-banana-honey',
      'Rolled oats soaked in fresh milk with banana, a swirl of honey and a pinch of cinnamon.', 14.00,
      'https://images.unsplash.com/photo-1484723091739-30a097e8f929?w=800&q=70', 2),
  (3, 1, 'Tropical Mango Dragon',  'tropical-mango-dragon',
      'Coconut-milk oats layered with mango and dragon fruit, finished with toasted coconut.', 16.50,
      'https://images.unsplash.com/photo-1490474418585-ba9bad8fd0ea?w=800&q=70', 3),
  (4, 1, 'Peanut Butter Power',    'peanut-butter-power',
      'Skippy peanut butter blended through oat milk oats, with banana and crushed peanuts.', 16.00,
      'https://images.unsplash.com/photo-1495214783159-3503fd1b572d?w=800&q=70', 4),
  (5, 3, 'Cold Brew Coffee',       'cold-brew-coffee',
      '16-hour cold brew, served black over ice.', 9.00,
      'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?w=800&q=70', 5);

INSERT INTO option_groups (id, name, slug, description, input_type, min_select, max_select, is_required, sort_order) VALUES
  (1, 'Jar Size',      'jar-size',     'How hungry are you?',                        'single', 1, 1, 1, 1),
  (2, 'Milk Base',     'milk-base',    'What we soak the oats in overnight.',        'single', 1, 1, 1, 2),
  (3, 'Fruit Mix',     'fruit-mix',    'Mix and match up to 3 fresh fruits.',        'multi',  1, 3, 1, 3),
  (4, 'Nuts & Seeds',  'nuts-seeds',   'Crunch and protein.',                        'multi',  0, 0, 0, 4),
  (5, 'Spreads',       'spreads',      'Stirred through or swirled on top.',         'multi',  0, 2, 0, 5),
  (6, 'Sweetener',     'sweetener',    'Pick one, or skip it entirely.',             'single', 0, 1, 0, 6),
  (7, 'Extras',        'extras',       'Little upgrades.',                           'multi',  0, 0, 0, 7);

INSERT INTO options (group_id, name, description, price_delta, sort_order) VALUES
  -- 1 Jar Size
  (1, 'Regular (350ml)',   'One jar, one breakfast.',               0.00, 1),
  (1, 'Large (500ml)',     'For the seriously hungry.',             3.50, 2),
  -- 2 Milk Base
  (2, 'Fresh Milk',        'Full cream dairy milk.',                0.00, 1),
  (2, 'Oat Milk',          'Barista-grade, naturally sweet.',       2.00, 2),
  (2, 'Almond Milk',       'Light and nutty.',                      2.00, 3),
  (2, 'Soy Milk',          'Extra protein, dairy free.',            1.50, 4),
  (2, 'Coconut Milk',      'Rich and tropical.',                    2.50, 5),
  (2, 'Greek Yogurt',      'Thick, tangy, high protein.',           3.00, 6),
  -- 3 Fruit Mix
  (3, 'Banana',            'Sliced fresh each morning.',            1.50, 1),
  (3, 'Mango',             'Sweet Harumanis cubes.',                2.50, 2),
  (3, 'Dragon Fruit',      'Red-fleshed, mildly sweet.',            2.50, 3),
  (3, 'Strawberry',        'Halved Cameron Highlands berries.',     3.00, 4),
  (3, 'Blueberry',         'Whole, frozen-fresh.',                  3.00, 5),
  (3, 'Kiwi',              'Tart green slices.',                    2.00, 6),
  (3, 'Green Apple',       'Crisp diced apple.',                    1.50, 7),
  -- 4 Nuts & Seeds
  (4, 'Walnuts',           'Toasted halves.',                       2.50, 1),
  (4, 'Almonds',           'Sliced and toasted.',                   2.00, 2),
  (4, 'Crushed Peanuts',   'Roasted and lightly salted.',           1.50, 3),
  (4, 'Chia Seeds',        'One tablespoon, soaked in.',            1.50, 4),
  (4, 'Pumpkin Seeds',     'Dry-roasted pepitas.',                  1.50, 5),
  (4, 'Flax Seeds',        'Ground, for the omega-3s.',             1.00, 6),
  (4, 'Granola Crunch',    'House-baked oat cluster topping.',      3.00, 7),
  -- 5 Spreads
  (5, 'Peanut Butter (Skippy)', 'Creamy, one generous scoop.',      3.00, 1),
  (5, 'Almond Butter',     'Unsweetened, stone-ground.',            4.00, 2),
  (5, 'Nutella',           'For when it is that kind of morning.',  3.50, 3),
  (5, 'Biscoff Spread',    'Speculoos, swirled on top.',            3.50, 4),
  -- 6 Sweetener
  (6, 'Honey',             'Local wildflower honey.',               1.00, 1),
  (6, 'Maple Syrup',       'Grade A amber.',                        2.00, 2),
  (6, 'Gula Melaka',       'Palm sugar syrup.',                     1.50, 3),
  (6, 'Date Syrup',        'Refined-sugar free.',                   2.00, 4),
  -- 7 Extras
  (7, 'Protein Scoop',     'Unflavoured whey, 20g protein.',        4.50, 1),
  (7, 'Cacao Nibs',        'Bitter dark chocolate crunch.',         2.00, 2),
  (7, 'Toasted Coconut',   'Shaved and toasted.',                   1.50, 3),
  (7, 'Cinnamon Dust',     'Ceylon cinnamon.',                      0.00, 4),
  (7, 'Extra Oats',        'Half portion more of the base.',        2.00, 5);

-- Which option groups each product offers.
-- Build Your Own gets everything; signature jars are customisable but pre-filled.
INSERT INTO product_option_groups (product_id, group_id, sort_order) VALUES
  (1,1,1),(1,2,2),(1,3,3),(1,4,4),(1,5,5),(1,6,6),(1,7,7),
  (2,1,1),(2,3,2),(2,4,3),(2,5,4),(2,6,5),(2,7,6),
  (3,1,1),(3,3,2),(3,4,3),(3,5,4),(3,6,5),(3,7,6),
  (4,1,1),(4,3,2),(4,4,3),(4,5,4),(4,6,5),(4,7,6);
-- (product 5, Cold Brew, has no option groups)

-- ---------------------------------------------------------------- sample orders

INSERT INTO orders
  (id, order_number, customer_id, status, fulfillment_type, contact_name, contact_phone, contact_email,
   delivery_address, delivery_lat, delivery_lng, subtotal, delivery_fee, tax, total, payment_method, payment_status, created_at)
VALUES
  (1, 'OK-240001', 3, 'completed', 'delivery', 'Chloe Customer', '+60123000003', 'cust@orderko.test',
   'Unit 8-3, Residensi Damai, Jalan Maarof, 59100 Kuala Lumpur', 3.1421000, 101.6740000,
   21.50, 6.00, 1.29, 28.79, 'ewallet', 'paid', NOW() - INTERVAL 2 DAY),
  (2, 'OK-240002', 3, 'preparing', 'pickup', 'Chloe Customer', '+60123000003', 'cust@orderko.test',
   NULL, NULL, NULL,
   16.50, 0.00, 0.99, 17.49, 'card', 'paid', NOW() - INTERVAL 40 MINUTE),
  (3, 'OK-240003', NULL, 'pending', 'delivery', 'Walk-in Guest', '+60129998888', NULL,
   'Level 21, Menara Binjai, Jalan Ampang, 50450 Kuala Lumpur', 3.1580000, 101.7150000,
   33.00, 7.50, 1.98, 42.48, 'cash', 'unpaid', NOW() - INTERVAL 8 MINUTE);

INSERT INTO order_items (id, order_id, product_id, product_name, quantity, unit_base_price, unit_options_price, line_total, notes) VALUES
  (1, 1, 1, 'Build Your Own Oats',   1, 12.00, 9.50, 21.50, 'Less honey please'),
  (2, 2, 3, 'Tropical Mango Dragon', 1, 16.50,  0.00, 16.50, NULL),
  (3, 3, 4, 'Peanut Butter Power',   2, 16.00,  0.50, 33.00, NULL);

INSERT INTO order_item_options (order_item_id, option_id, group_name, option_name, price_delta) VALUES
  (1,  1, 'Jar Size',     'Regular (350ml)',       0.00),
  (1,  4, 'Milk Base',    'Oat Milk',              2.00),
  (1,  9, 'Fruit Mix',    'Banana',                1.50),
  (1, 10, 'Fruit Mix',    'Mango',                 2.50),
  (1, 19, 'Nuts & Seeds', 'Chia Seeds',            1.50),
  (1, 27, 'Sweetener',    'Honey',                 1.00),
  (1, 34, 'Extras',       'Cinnamon Dust',         0.00),
  (3,  1, 'Jar Size',     'Regular (350ml)',       0.00),
  (3, 11, 'Fruit Mix',    'Dragon Fruit',          2.50),
  (3, 18, 'Nuts & Seeds', 'Crushed Peanuts',       1.50);

INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note, created_at) VALUES
  (1, NULL,        'pending',   3, 'Order placed',              NOW() - INTERVAL 2 DAY),
  (1, 'pending',   'confirmed', 2, NULL,                        NOW() - INTERVAL 2 DAY + INTERVAL 3 MINUTE),
  (1, 'confirmed', 'preparing', 2, NULL,                        NOW() - INTERVAL 2 DAY + INTERVAL 6 MINUTE),
  (1, 'preparing', 'ready',     2, NULL,                        NOW() - INTERVAL 2 DAY + INTERVAL 22 MINUTE),
  (1, 'ready',     'dispatched',2, 'Grab driver assigned',      NOW() - INTERVAL 2 DAY + INTERVAL 26 MINUTE),
  (1, 'dispatched','delivered', NULL, 'Grab webhook: COMPLETED',NOW() - INTERVAL 2 DAY + INTERVAL 44 MINUTE),
  (1, 'delivered', 'completed', 2, NULL,                        NOW() - INTERVAL 2 DAY + INTERVAL 45 MINUTE),
  (2, NULL,        'pending',   3, 'Order placed',              NOW() - INTERVAL 40 MINUTE),
  (2, 'pending',   'confirmed', 2, NULL,                        NOW() - INTERVAL 36 MINUTE),
  (2, 'confirmed', 'preparing', 2, NULL,                        NOW() - INTERVAL 30 MINUTE),
  (3, NULL,        'pending',   NULL, 'Order placed',           NOW() - INTERVAL 8 MINUTE);

INSERT INTO deliveries (order_id, provider, provider_delivery_id, quote_id, status, fee, distance_km,
                        driver_name, driver_phone, driver_plate, tracking_url, created_at)
VALUES
  (1, 'grab', 'GRB-MOCK-240001', 'QUO-MOCK-240001', 'completed', 6.00, 3.40,
   'Hafiz R.', '+60198887766', 'WXY 4412', 'https://grab.test/track/GRB-MOCK-240001', NOW() - INTERVAL 2 DAY);

INSERT INTO delivery_events (delivery_id, status, description, created_at) VALUES
  (1, 'allocating',  'Looking for a driver',        NOW() - INTERVAL 2 DAY + INTERVAL 26 MINUTE),
  (1, 'picking_up',  'Hafiz R. is heading to shop', NOW() - INTERVAL 2 DAY + INTERVAL 29 MINUTE),
  (1, 'in_delivery', 'Order collected',             NOW() - INTERVAL 2 DAY + INTERVAL 34 MINUTE),
  (1, 'completed',   'Delivered to customer',       NOW() - INTERVAL 2 DAY + INTERVAL 44 MINUTE);
