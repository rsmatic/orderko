# Orderko — Overnight Oats Ordering System

A full-stack ordering system for an overnight-oats shop: a customer storefront
where you build a jar (mix your fruits, pick your milk, pile on walnuts, Skippy
peanut butter and chia seeds), a manager console for the kitchen and the menu,
an admin dashboard for people, settings and reporting, and Grab driver
dispatch for delivery orders.

```
MySQL 8  ←  Express API (Node 20)  ←  React 18 SPA (Vite)
                    │
                    └─ Grab delivery adapter (mock ⇄ live GrabExpress)
```

---

## Quick start

```bash
npm install                 # installs both workspaces

cp apps/api/.env.example apps/api/.env
#   then set DB_PASSWORD (and DB_USER if not root)

npm run db:setup            # creates the database, loads schema + seed data
npm run dev                 # API on :4000, web on :5173
```

Open <http://localhost:5173>.

| Sign in as | Email | Password | Lands on |
|---|---|---|---|
| Admin | `admin@orderko.test` | `Password123!` | `/admin` |
| Manager | `manager@orderko.test` | `Password123!` | `/manager` |
| Customer | `cust@orderko.test` | `Password123!` | `/` |

Customers can also order as guests — no account needed.

### Other commands

```bash
npm run db:reset      # drop and rebuild the database (destroys all data)
npm run smoke         # end-to-end API check; needs the API running
npm run build         # production build of the web app
```

---

## The three surfaces

One React app, three route trees, gated by role.

### Customer — `/`

The jar builder is the centre of it. Option groups come from the database, so
the rules are data, not code:

| Group | Style | Rule |
|---|---|---|
| Jar Size | pick one | required |
| Milk Base | pick one | required — fresh, oat, almond, soy, coconut, Greek yogurt |
| **Fruit Mix** | **pick several** | **required, max 3** — banana, mango, dragon fruit, strawberry, blueberry, kiwi, green apple |
| Nuts & Seeds | pick several | optional — walnuts, almonds, crushed peanuts, chia, pumpkin, flax, granola |
| Spreads | pick several | optional, max 2 — **Skippy peanut butter**, almond butter, Nutella, Biscoff |
| Sweetener | pick one | optional — honey, maple, gula melaka, date syrup |
| Extras | pick several | optional — protein scoop, cacao nibs, toasted coconut, cinnamon, extra oats |

A manager can add a group, change its min/max, or add a new fruit, and the
ordering page picks it up on the next load.

Also here: cart with live server-side pricing, pickup-or-delivery checkout with
a real Grab fee quote, order tracking with driver details, and order history.

### Manager — `/manager`

- **Kitchen queue** — a board of live orders across New → Confirmed → Building →
  Ready → Out, with every chosen option printed on the ticket. Orders sitting
  too long in a column get flagged. One click advances an order or books a Grab
  driver. Auto-refreshes.
- **All orders** — searchable and filterable, with a detail view carrying status
  controls, payment, the Grab booking and full history.
- **Menu & prices** — edit items and base prices, toggle what's live, manage every
  option and its surcharge, mark things sold out, set the min/max rules on a
  group, and track stock.
- **Reports** — revenue and order charts, best sellers, most-picked add-ons.

### Admin — `/admin`

Everything a manager can do, plus:

- **People** — create staff and customer accounts, change roles, reset passwords,
  disable accounts. The last active admin can't be demoted or disabled.
- **Shop settings** — name, currency, tax rate, minimum order, prep time, the
  pickup address Grab collects from, and a delivery on/off switch.
- **Activity log** — every staff change, who made it and when.

---

## Grab delivery

The delivery layer is an adapter with two interchangeable providers behind one
interface (`quote` / `book` / `track` / `cancel`). Nothing outside
`src/services/grab/` knows which is in play.

**`GRAB_MODE=mock`** (the default) simulates a driver locally: a booking walks
through `allocating → picking_up → in_delivery → completed` on a timer, assigns
a driver with a name and plate, moves their position, and feeds each transition
through the same handler the real webhook uses. Distance-based fees. Staff can
skip the timer with the **Advance (mock)** button in the order detail.

**`GRAB_MODE=live`** talks to the GrabExpress partner API. Set:

```ini
GRAB_MODE=live
GRAB_CLIENT_ID=...
GRAB_CLIENT_SECRET=...
GRAB_WEBHOOK_SECRET=...
# production endpoints:
GRAB_BASE_URL=https://partner-api.grab.com/grabexpress
GRAB_AUTH_URL=https://api.grab.com/grabid/v1/oauth2/token
```

Point Grab's webhook at `POST /api/webhooks/grab`. The body signature is checked
with `GRAB_WEBHOOK_SECRET` against the raw payload (that route is mounted ahead
of the JSON parser for exactly this reason). Grab's status vocabulary is mapped
to ours in `STATUS_MAP`, and a delivery reaching `picking_up` or `completed`
moves the parent order to `dispatched` or `delivered` automatically.

Switching modes needs no code change.

### Address lookup

Checkout offers a short list of Kuala Lumpur landmarks instead of a live address
autocomplete, since that needs a Places API key. Checkout only ever needs an
address string plus lat/lng — swap `SAVED_PLACES` in
`apps/web/src/routes/customer/Checkout.jsx` for Google Places or Grab's own
address lookup and nothing else changes.

---

## How money is handled

The browser never sets a price. It sends product ids, option ids and quantities;
the server looks up current prices, enforces every group's min/max rule, checks
availability and stock, and computes the total. `POST /api/orders/quote` returns
exactly what `POST /api/orders` will charge. The delivery fee is re-quoted from
the provider at checkout, so a tampered client can't discount its own delivery.

Tax applies to goods, not to the delivery fee. Item names and prices are
snapshotted onto `order_items` at checkout, so changing a price later doesn't
rewrite history. Products and options that appear in past orders are deactivated
rather than deleted.

---

## Layout

```
db/
  schema.sql              14 tables
  seed.sql                accounts, catalog, sample orders

apps/api/
  src/
    index.js              express app, route mounting
    config.js             env → typed config
    db.js                 mysql2 pool, query/execute/transaction
    middleware/
      auth.js             JWT, attachUser, requireRole
      errors.js           HttpError, asyncHandler, error middleware
    routes/
      auth.js             register, login, me
      catalog.js          menu (public), product/option/group CRUD (staff)
      orders.js           quote, checkout, listing, queue, status, payment
      delivery.js         quote, book, cancel, track + the Grab webhook
      admin.js            users, settings, stats, audit
    services/
      pricing.js          the single source of truth for what a cart costs
      grab/
        index.js          provider selection, persistence, order sync
        mock.js           simulated driver
        live.js           GrabExpress client
    lib/
      settings.js         cached key/value shop config
      audit.js            audit trail
  scripts/
    setup-db.js           create + migrate + seed
    smoke-test.js         end-to-end API check

apps/web/
  src/
    App.jsx               all routing and role gates
    context/              AuthContext, CartContext
    components/           ui.jsx, OrderDetail.jsx
    routes/
      customer/           StoreLayout, Menu, Customizer, CartDrawer,
                          Checkout, OrderTracking
      manager/            KitchenQueue, OrdersList, MenuManager, Reports
      admin/              Users, Settings, AuditLog
      DashboardLayout.jsx shared dashboard chrome
      Login.jsx           sign in / register
    styles.css            one stylesheet for all three surfaces
```

---

## API

Everything is under `/api`. Staff endpoints take `Authorization: Bearer <jwt>`.

| Method | Path | Who |
|---|---|---|
| `POST` | `/auth/register`, `/auth/login` | anyone |
| `GET` `PATCH` | `/auth/me` | signed in |
| `GET` | `/catalog/menu` | anyone (staff also see hidden rows) |
| `POST` `PATCH` `DELETE` | `/catalog/products`, `/catalog/options`, `/catalog/option-groups`, `/catalog/categories` | manager, admin |
| `POST` | `/orders/quote` | anyone |
| `POST` | `/orders` | anyone (guest checkout) |
| `GET` | `/orders` | signed in — customers see only their own |
| `GET` | `/orders/queue` | manager, admin |
| `GET` | `/orders/:id` | owner or staff |
| `GET` | `/orders/track/:orderNumber?phone=` | anyone with both |
| `PATCH` | `/orders/:id/status`, `/orders/:id/payment` | manager, admin |
| `POST` | `/orders/:id/cancel` | owner (while pending) or staff |
| `POST` | `/delivery/quote` | anyone |
| `POST` | `/delivery/orders/:id/book`, `/delivery/orders/:id/cancel` | manager, admin |
| `GET` | `/delivery/orders/:id` | owner or staff |
| `POST` | `/delivery/simulate/:id/advance` | manager, admin (mock mode only) |
| `POST` | `/webhooks/grab` | Grab (HMAC-signed) |
| `GET` `POST` `PATCH` | `/admin/users` | admin |
| `GET` | `/admin/settings` | manager, admin |
| `PUT` | `/admin/settings` | admin |
| `GET` | `/admin/stats` | manager, admin |
| `GET` | `/admin/audit` | admin |

### Order lifecycle

```
pending → confirmed → preparing → ready ─┬→ dispatched → delivered → completed
                                          └→ completed            (pickup)
```

Any state before `completed` can go to `cancelled`. Illegal jumps are refused
with a 400 listing what's allowed. Every transition is written to
`order_status_history`.

---

## Deploying

The frontend is static and goes on GitHub Pages. The API and MySQL cannot —
Pages serves files, it does not run processes — so they go on a host that runs
containers.

```
GitHub Pages ──► React SPA      https://rsmatic.github.io/orderko/
                     │ VITE_API_BASE_URL
                     ▼
Render/Railway ──► Express API  https://<your-api>/api
                     │ DB_*
                     ▼
Managed MySQL 8 ──► overnight_oats
```

### 1. MySQL

Create a MySQL 8 database anywhere that gives you a host, port, user, password
and a TCP connection — Railway, Aiven and TiDB Serverless all work, as does a
database on your own server. (Free tiers move around; check current terms.)

Load the schema from your laptop, pointing the setup script at the remote:

```bash
DB_HOST=... DB_PORT=... DB_USER=... DB_PASSWORD=... DB_NAME=overnight_oats \
  npm run db:setup
```

Then change the seeded passwords — they are documented in this file, so treat
them as public.

### 2. API

The API ships as a container. Build context is the **repo root**, not
`apps/api`, because the image keeps the monorepo layout:

```bash
docker build -f apps/api/Dockerfile -t orderko-api .
```

**Render** — `New → Blueprint`, point it at this repo, and it reads
[`render.yaml`](render.yaml). Fill in the values marked `sync: false` (the DB_*
set and `PUBLIC_BASE_URL`); `JWT_SECRET` is generated for you.

**Railway / Fly / anything else** — deploy the Dockerfile and set the same
environment variables by hand. Health check path is `/api/health`, which
reports whether the database is reachable, not just whether the process is up.

Either way these matter:

| Variable | Value |
|---|---|
| `CORS_ORIGIN` | `https://rsmatic.github.io` — exact origin, no trailing slash |
| `PUBLIC_BASE_URL` | the API's own public URL |
| `JWT_SECRET` | a real secret; the API refuses to boot in production without one |
| `DB_*` | your MySQL |
| `GRAB_MODE` | `mock` until you have GrabExpress credentials |

### 3. Frontend on Pages

Two one-time settings in the repo:

1. **Settings → Pages → Source: GitHub Actions.**
2. **Settings → Secrets and variables → Actions → Variables → New variable:**
   `VITE_API_BASE_URL` = `https://<your-api>/api` (include the `/api`).

Push to `main` and [`deploy-pages.yml`](.github/workflows/deploy-pages.yml)
builds and publishes. Without the variable the site still deploys, but every
request fails with a message saying so — the workflow also logs a warning.

The workflow derives `VITE_BASE` from the repository name, because a project
site is served from `/<repo>/`. It also copies `index.html` to `404.html` so
deep links survive (Pages has no history fallback), and writes `.nojekyll`.

> **On the URL:** the published path is the repository name, so renaming the
> repo moves the site with no workflow change. `rsmatic/orderko` publishes to
> `https://rsmatic.github.io/orderko/`.

### CI

[`ci.yml`](.github/workflows/ci.yml) runs on every push: builds the web app,
stands up MySQL 8, loads the schema, boots the API, runs the smoke test against
it, and builds the API image.

## Other notes

- Put MySQL behind a dedicated user, not `root`.
- Set `GRAB_WEBHOOK_SECRET`; without it the webhook signature check is skipped.
- The mock provider keeps simulation state in memory, so a restart stops
  in-flight simulations. Rows already in `deliveries` are unaffected. This is
  mock-only — the live provider is stateless and driven by webhooks.
- A free-tier API that spins down when idle will make the first request after a
  pause slow or fail; the frontend surfaces that as "it may still be waking up".
