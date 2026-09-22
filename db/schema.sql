-- Overnight Oats ordering system - schema
-- MySQL 8.0+

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS delivery_events;
DROP TABLE IF EXISTS deliveries;
DROP TABLE IF EXISTS order_status_history;
DROP TABLE IF EXISTS order_item_options;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS product_option_groups;
DROP TABLE IF EXISTS options;
DROP TABLE IF EXISTS option_groups;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS users;

SET FOREIGN_KEY_CHECKS = 1;

-- ---------------------------------------------------------------- accounts

CREATE TABLE users (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email          VARCHAR(190) NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  name           VARCHAR(120) NOT NULL,
  phone          VARCHAR(32)  NULL,
  role           ENUM('admin','manager','customer') NOT NULL DEFAULT 'customer',
  is_active      TINYINT(1)   NOT NULL DEFAULT 1,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- key/value store for shop configuration (tax rate, hours, delivery radius...)
CREATE TABLE settings (
  setting_key   VARCHAR(80)  NOT NULL,
  setting_value JSON         NOT NULL,
  description   VARCHAR(255) NULL,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- catalog

CREATE TABLE categories (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(120) NOT NULL,
  slug       VARCHAR(120) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE products (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  category_id  INT UNSIGNED NOT NULL,
  name         VARCHAR(160) NOT NULL,
  slug         VARCHAR(160) NOT NULL,
  description  TEXT NULL,
  base_price   DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  image_url    VARCHAR(500) NULL,
  is_active    TINYINT(1) NOT NULL DEFAULT 1,
  track_stock  TINYINT(1) NOT NULL DEFAULT 0,
  stock_qty    INT NOT NULL DEFAULT 0,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_products_slug (slug),
  KEY idx_products_category (category_id),
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A group of choices: "Fruit Mix" (multi, max 3), "Milk Base" (single), "Toppings" (multi)
CREATE TABLE option_groups (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(120) NOT NULL,
  slug        VARCHAR(120) NOT NULL,
  description VARCHAR(255) NULL,
  input_type  ENUM('single','multi') NOT NULL DEFAULT 'multi',
  min_select  INT NOT NULL DEFAULT 0,
  max_select  INT NOT NULL DEFAULT 0,
  is_required TINYINT(1) NOT NULL DEFAULT 0,
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_option_groups_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE options (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  group_id     INT UNSIGNED NOT NULL,
  name         VARCHAR(160) NOT NULL,
  description  VARCHAR(255) NULL,
  price_delta  DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  image_url    VARCHAR(500) NULL,
  is_available TINYINT(1) NOT NULL DEFAULT 1,
  track_stock  TINYINT(1) NOT NULL DEFAULT 0,
  stock_qty    INT NOT NULL DEFAULT 0,
  sort_order   INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_options_group (group_id),
  CONSTRAINT fk_options_group FOREIGN KEY (group_id) REFERENCES option_groups (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE product_option_groups (
  product_id INT UNSIGNED NOT NULL,
  group_id   INT UNSIGNED NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, group_id),
  KEY idx_pog_group (group_id),
  CONSTRAINT fk_pog_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
  CONSTRAINT fk_pog_group   FOREIGN KEY (group_id)   REFERENCES option_groups (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- orders

CREATE TABLE orders (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_number     VARCHAR(24) NOT NULL,
  customer_id      INT UNSIGNED NULL,
  status           ENUM('pending','confirmed','preparing','ready','dispatched','delivered','completed','cancelled')
                   NOT NULL DEFAULT 'pending',
  fulfillment_type ENUM('pickup','delivery') NOT NULL DEFAULT 'pickup',
  contact_name     VARCHAR(120) NOT NULL,
  contact_phone    VARCHAR(32)  NOT NULL,
  contact_email    VARCHAR(190) NULL,
  delivery_address VARCHAR(500) NULL,
  delivery_notes   VARCHAR(500) NULL,
  delivery_lat     DECIMAL(10,7) NULL,
  delivery_lng     DECIMAL(10,7) NULL,
  subtotal         DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  delivery_fee     DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  tax              DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  discount         DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  total            DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  currency         CHAR(3) NOT NULL DEFAULT 'MYR',
  payment_method   ENUM('cash','card','ewallet') NOT NULL DEFAULT 'cash',
  payment_status   ENUM('unpaid','paid','refunded') NOT NULL DEFAULT 'unpaid',
  notes            VARCHAR(500) NULL,
  scheduled_for    DATETIME NULL,
  cancelled_reason VARCHAR(255) NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_orders_number (order_number),
  KEY idx_orders_customer (customer_id),
  KEY idx_orders_status (status),
  KEY idx_orders_created (created_at),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Names and prices are snapshotted so historical orders survive catalog edits.
CREATE TABLE order_items (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id           INT UNSIGNED NOT NULL,
  product_id         INT UNSIGNED NULL,
  product_name       VARCHAR(160) NOT NULL,
  quantity           INT NOT NULL DEFAULT 1,
  unit_base_price    DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  unit_options_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  line_total         DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  notes              VARCHAR(255) NULL,
  PRIMARY KEY (id),
  KEY idx_order_items_order (order_id),
  CONSTRAINT fk_order_items_order   FOREIGN KEY (order_id)   REFERENCES orders (id)   ON DELETE CASCADE,
  CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE order_item_options (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_item_id INT UNSIGNED NOT NULL,
  option_id     INT UNSIGNED NULL,
  group_name    VARCHAR(120) NOT NULL,
  option_name   VARCHAR(160) NOT NULL,
  price_delta   DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  PRIMARY KEY (id),
  KEY idx_oio_item (order_item_id),
  CONSTRAINT fk_oio_item   FOREIGN KEY (order_item_id) REFERENCES order_items (id) ON DELETE CASCADE,
  CONSTRAINT fk_oio_option FOREIGN KEY (option_id)     REFERENCES options (id)     ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE order_status_history (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id    INT UNSIGNED NOT NULL,
  from_status VARCHAR(24) NULL,
  to_status   VARCHAR(24) NOT NULL,
  changed_by  INT UNSIGNED NULL,
  note        VARCHAR(255) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_osh_order (order_id),
  CONSTRAINT fk_osh_order FOREIGN KEY (order_id)   REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_osh_user  FOREIGN KEY (changed_by) REFERENCES users (id)  ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- delivery (Grab)

CREATE TABLE deliveries (
  id                   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id             INT UNSIGNED NOT NULL,
  provider             VARCHAR(32) NOT NULL DEFAULT 'grab',
  provider_delivery_id VARCHAR(120) NULL,
  quote_id             VARCHAR(120) NULL,
  status               ENUM('quoted','allocating','picking_up','in_delivery','completed','cancelled','failed','returned')
                       NOT NULL DEFAULT 'quoted',
  fee                  DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  currency             CHAR(3) NOT NULL DEFAULT 'MYR',
  distance_km          DECIMAL(8,2) NULL,
  driver_name          VARCHAR(120) NULL,
  driver_phone         VARCHAR(32)  NULL,
  driver_plate         VARCHAR(32)  NULL,
  driver_photo_url     VARCHAR(500) NULL,
  driver_lat           DECIMAL(10,7) NULL,
  driver_lng           DECIMAL(10,7) NULL,
  tracking_url         VARCHAR(500) NULL,
  pickup_eta           DATETIME NULL,
  dropoff_eta          DATETIME NULL,
  raw_payload          JSON NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_deliveries_order (order_id),
  KEY idx_deliveries_provider_id (provider_delivery_id),
  CONSTRAINT fk_deliveries_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE delivery_events (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  delivery_id INT UNSIGNED NOT NULL,
  status      VARCHAR(40) NOT NULL,
  description VARCHAR(255) NULL,
  lat         DECIMAL(10,7) NULL,
  lng         DECIMAL(10,7) NULL,
  raw         JSON NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_devents_delivery (delivery_id),
  CONSTRAINT fk_devents_delivery FOREIGN KEY (delivery_id) REFERENCES deliveries (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- audit

CREATE TABLE audit_log (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NULL,
  action     VARCHAR(80) NOT NULL,
  entity     VARCHAR(80) NULL,
  entity_id  VARCHAR(80) NULL,
  meta       JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_user (user_id),
  KEY idx_audit_created (created_at),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
