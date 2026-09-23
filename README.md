# Orderko — Overnight Oats Ordering System

A full-stack ordering system for an overnight-oats shop: a customer storefront
where you build a jar (mix your fruits, pick your milk, pile on walnuts, Skippy
peanut butter and chia seeds), a manager console for the kitchen and the menu,
an admin dashboard for people, settings and reporting, and Grab driver
dispatch for delivery orders.

```
                 ┌─ Express API (Node 20) ─ JSON file store
@overnight-oats/core ┤
                 └─ React 18 SPA (Vite) ─ browser demo (localStorage)
                          │
                          └─ Grab delivery adapter (sim ⇄ live GrabExpress)
```

One implementation of the rules, two places it runs. `packages/core` holds the
route table, pricing and order lifecycle with no I/O of its own; storage,
password hashing, token signing and the delivery provider all arrive as
adapters. The server supplies a JSON file, bcrypt, JWT and the real Grab
client; the browser demo supplies localStorage and throwaway equivalents.

**There is no database server.** The store is a single JSON file, written
atomically and serialised through one write queue. That suits a shop doing
hundreds of orders a day and assumes a single process — see
[DEPLOY.md](DEPLOY.md) for the limits.

---

## Quick start

```bash
npm install
npm run dev                 # API on :4000, web on :5173
```

That is the whole setup. No database to install, no credentials to configure —
the store seeds itself at `apps/api/data/store.json` on first run, including
two weeks of sample orders so the dashboards are legible. Set
`SEED_SAMPLE_ORDERS=false` for a real shop, so your first order is order
number one.

Open <http://localhost:5173>.

| Sign in as | Email | Password | Lands on |
|---|---|---|---|
| Admin | `admin@orderko.test` | `Password123!` | `/admin` |
| Manager | `manager@orderko.test` | `Password123!` | `/manager` |
| Customer | `cust@orderko.test` | `Password123!` | `/` |

Customers can also order as guests — no account needed.

### Other commands

```bash
npm run orders:clear  # remove every order, keeping the menu and accounts
npm run data:reset    # throw away the store and reseed (destroys all data)
npm run smoke         # end-to-end API check; needs the API running
npm run test:core     # the rules behind the item builder's clicks
npm run test:demo     # same checks against the core's browser adapters
npm run build         # production build of the web app
```

---

## The three surfaces

One React app, three route trees, gated by role.

### Customer — `/`

The jar builder is the centre of it. Option groups come from the store, so the
rules are data, not code:

| Group | Style | Rule |
|---|---|---|
| Jar Size | pick one | required |
| Milk Base | pick one | required — fresh, oat, almond, soy, coconut, Greek yogurt |
| **Fruit Mix** | **pick several** | **required, max 3** — banana, mango, dragon fruit, strawberry, blueberry, kiwi, green apple |
| Nuts | pick several | optional — walnuts, almonds, crushed peanuts |
| Seeds | pick several | optional — chia, pumpkin, flax |
| Spreads | pick several | optional, max 2 — **Skippy peanut butter**, almond butter, Nutella, Biscoff |
| Sweetener | pick one | optional — honey, maple, muscovado, date syrup |
| Extras | pick several | optional — granola crunch, protein scoop, cacao nibs, toasted coconut, cinnamon, extra oats |

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

- **People** — create staff and customer accounts, change email addresses and
  roles, reset passwords, disable accounts. Both the email address and the
  mobile number sign you in, so a change to either is rejected if another
  account already has it. The last active admin can't be demoted or disabled.
- **Shop settings** — branding (logo, front-page picture, and whether free
  choices are labelled "Included"), name, currency, tax rate, minimum order,
  prep time, delivery radius, the pickup address Grab collects from, a
  delivery on/off switch, and the GCash number customers pay to.
- **Activity log** — every staff change, who made it and when.
- **Danger zone** — remove every order, behind the admin's own password. The
  menu, accounts and settings are untouched, and the deletion is logged.

---

## Grab delivery

The delivery layer is an adapter with two interchangeable providers behind one
interface (`quote` / `book` / `track` / `cancel`). The core never knows which
is in play.

The mode is a shop setting — **Admin → Shop settings → Delivery** has a switch,
so it changes without editing a file or restarting. `GRAB_MODE` only seeds a
brand-new store. Credentials stay in the environment: a client secret does not
belong in a settings object that is written to disk in the clear.

**Simulated** (the default) walks a fake driver through the states: a booking walks through
`allocating → picking_up → in_delivery → completed`, assigns a driver with a
name and plate, and feeds each transition through the same handler the real
webhook uses. Distance-based fees. Staff can push it along with the **Advance**
button, and `GRAB_AUTO_ADVANCE_SECONDS` moves it on a timer.

The simulation keeps no state of its own — `advance` is told the current status
and returns the next one — so progress lives in the store and a restart resumes
rather than stalling.

**Live** talks to the GrabExpress partner API. Switching it on is refused
unless these are present, because a shop that believes it is booking couriers
and is not would find out far too late:

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

Checkout puts the destination on a map: search by name, drop or drag a pin, or
use the browser's own location. It runs on Leaflet with OpenStreetMap tiles and
Nominatim for geocoding, so it needs **no API key and no billing account** —
unlike Google Maps, which requires both even inside its free tier.

Leaflet loads only when a customer chooses delivery, so the storefront does not
carry it. Nominatim asks callers to stay under a request a second, which the
debounced search respects; a busy shop should move to a paid geocoder.

Swapping in Google Places or Grab's own lookup means replacing
`apps/web/src/components/AddressPicker.jsx`. Everything downstream only wants
an address string plus lat/lng.

**Delivery radius.** Because a pin can land anywhere, `max_delivery_km` is
enforced on the server — on the cart quote, on checkout, and on the standalone
fee lookup. Without it a pin in another province quotes a fare and is accepted.
Set it in Admin → Shop settings; 0 removes the limit.

---

## Paying by GCash

Set a number in **Admin → Shop settings → GCash** and the checkout offers
GCash alongside cash and card. The customer sees where to send the money —
tapping the number copies it, digits only, because pasting spaces into GCash
is what makes it reject the number — and the same panel stays on the order
page until the payment is confirmed.

Nothing is charged automatically. There is no merchant account and no API key:
the customer pays from their own GCash app, the order stays **unpaid**, and
the shop marks it paid from the order screen once the money lands. Clearing
the number takes GCash off the checkout again.

The number lives in settings rather than in code because settings are editable
and this one is meant to be read by every visitor — that is what a receiving
number is for. It is not a credential, and nothing secret is kept there; the
Grab client secret stays in the API's environment for exactly that reason.
Because the browser could always be lying about what it picked, the server
re-checks the payment method against the list it accepts and refuses a GCash
order outright when no number is set, rather than stranding it in unpaid with
nowhere to pay.

---

## Customer sign-in

A customer can order as a guest, or sign in to keep their order history.
Alongside email and password there is **Sign in with Google**, which appears
only once a client id is set in Admin → Shop settings.

The sign-in box takes **an email address or the mobile number on the account**.
Nobody types their number back the way they first entered it, so
[`phone.js`](packages/core/src/phone.js) reduces both sides to the last ten
digits before comparing — `0915 386 8303`, `+639153868303` and `9153868303`
are one account. That makes the number an identifier, so it is held unique the
way an email is: registration, profile edits and admin edits all refuse a
number another account already has. Where old data already holds a pair, login
by number refuses rather than guessing which account was meant.

The account is created when Google vouches for the address, not when someone
types one at checkout — typing an address proves nothing about owning it. An
address Google reports as unverified is refused for the same reason, and an
existing account with that address is signed into rather than duplicated.

The browser receives a signed token from Google and posts it to
`POST /auth/google`; [`google-auth.js`](apps/api/src/google-auth.js) checks the
signature against Google's published keys, the issuer, and that the token was
minted for **this** shop's client id, before anything in it is believed. Node
builds a verifying key straight from a JWK, so this needs no extra dependency.

Setup is free and needs no card: a Google Cloud project, an OAuth client id,
and `https://rsmatic.github.io` as an authorised JavaScript origin. No redirect
URI — sign-in happens in the page, so a changing API address does not matter.
The client id is public by design and is served in `/catalog/settings`.

---

## How money is handled

The browser never sets a price. It sends product ids, option ids and quantities;
the server looks up current prices, enforces every group's min/max rule, checks
availability and stock, and computes the total. `POST /api/orders/quote` returns
exactly what `POST /api/orders` will charge. The delivery fee is re-quoted from
the provider at checkout, so a tampered client can't discount its own delivery.

Prices are in Philippine pesos and tax is the 12% VAT rate, both held in
settings rather than in code — Admin → Shop settings changes either. Tax
applies to goods, not to the delivery fee. Item names and prices are
snapshotted onto the order line at checkout, so changing a price later doesn't
rewrite history. Products and options that appear in past orders are deactivated
rather than deleted — there is no foreign key to enforce that now, so the core
checks it explicitly before any delete.

---

## Layout

```
packages/core/            the application, with no I/O of its own
  src/
    seed.js               accounts, catalog, two weeks of sample orders
    rules.js              pricing, totals, transitions, AppError
    backend.js            the route table; takes storage/auth/delivery adapters
    delivery-sim.js       stateless driver simulation
    index.js

apps/api/                 the core over HTTP, backed by a JSON file
  src/
    index.js              express, webhook, health, sim ticker
    config.js             env → typed config
    persistence.js        atomic, serialised JSON file store
    adapters.js           bcrypt + JWT, and provider selection
    grab-live.js          GrabExpress partner client
  scripts/
    reset-data.js         throw away the store and reseed
    smoke-test.js         end-to-end check over HTTP
  data/store.json         the database (gitignored, seeds itself)

apps/web/                 React SPA
  src/
    App.jsx               all routing and role gates
    context/              AuthContext, CartContext
    components/           ui.jsx, OrderDetail.jsx, DemoBanner.jsx
    demo/backend.js       the core over localStorage
    routes/
      customer/           StoreLayout, Menu, Customizer, CartDrawer,
                          Checkout, OrderTracking
      manager/            KitchenQueue, OrdersList, MenuManager, Reports
      admin/              Users, Settings, AuditLog
      DashboardLayout.jsx shared dashboard chrome
      Login.jsx           sign in / register
    styles.css            one stylesheet for all three surfaces
  scripts/
    demo-test.mjs         the same checks, through the browser adapters
  Dockerfile, Caddyfile   build + serve, proxying /api

docker-compose.yml        api + web, one command
render.yaml               Render blueprint
DEPLOY.md                 deployment runbook
```

### Why a shared core

The browser demo and the API used to be separate implementations of the same
rules, kept honest only by a test. They are now one module with different
adapters, so a rule cannot be changed in one place and forgotten in the other.

Both test suites still exist because the adapters differ and both paths matter:
`npm run smoke` drives the real server over HTTP, `npm run test:demo` drives
the browser adapters in-process.

---

## API

Everything is under `/api`. Staff endpoints take `Authorization: Bearer <jwt>`.

| Method | Path | Who |
|---|---|---|
| `POST` | `/auth/register`, `/auth/login`, `/auth/google` | anyone |
| `GET` `PATCH` | `/auth/me` | signed in |
| `GET` | `/catalog/menu`, `/catalog/settings` | anyone (staff also see hidden rows) |
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
| `POST` | `/delivery/simulate/:id/advance` | manager, admin (sim mode only) |
| `POST` | `/webhooks/grab` | Grab (HMAC-signed) |
| `GET` `POST` `PATCH` | `/admin/users` | admin |
| `POST` | `/admin/orders/clear` | admin, password re-entered |
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
with a 400 listing what's allowed. Every transition is appended to the order’s history.

---

## Deploying

**[DEPLOY.md](DEPLOY.md) is the runbook.** The short version:

```bash
cp .env.compose.example .env     # set JWT_SECRET and SEED_PASSWORD
docker compose up -d --build
```

That runs the API and the web app behind Caddy, which serves the bundle and
proxies `/api` on the same origin — so there is no CORS to configure and deep
links return 200 rather than Pages' 404. The store seeds itself on first boot.

There is no database service to provision. What the deployment does need is a
**persistent disk** for `data/store.json`: on an ephemeral container filesystem
every order vanishes on the next deploy. The compose stack mounts a volume;
`render.yaml` declares a disk.

### What the JSON store costs you

Worth knowing before it takes real orders:

- **One process.** No cross-process locking, so two replicas would overwrite
  each other. Both deployment configs pin a single instance.
- **Whole-file writes.** Every change rewrites the file, debounced and
  serialised through one queue. Fine for hundreds of orders a day; not for
  thousands.
- **No referential integrity.** The core checks before deleting anything that
  appears in an order, since nothing else will.
- **Backups are a file copy** — which is also the upside:

```bash
docker compose cp api:/app/apps/api/data/store.json ./backup-$(date +%F).json
```

### Demo mode

GitHub Pages serves files and cannot run the API at all, so a build with no
`VITE_API_BASE_URL` falls back to running the core in the browser
([`apps/web/src/demo/`](apps/web/src/demo/)) rather than publishing a site that
cannot do anything. Same rules, same routes; `localStorage` instead of a file,
and throwaway credentials instead of bcrypt and JWT — which is exactly why it
is demo-only.

This is what is live at **<https://rsmatic.github.io/orderko/>** today. A banner
says so and offers a reset. Setting `VITE_API_BASE_URL` disables it and drops
the chunk from the bundle entirely.

### Frontend on Pages

Two one-time settings, both already done for this repo:

1. **Settings → Pages → Source: GitHub Actions.**
2. **Settings → Secrets and variables → Actions → Variables:**
   `VITE_API_BASE_URL` = `https://<your-api>/api`, once you have one.

Push to `main` and [`deploy-pages.yml`](.github/workflows/deploy-pages.yml)
builds and publishes. It derives the base path from the repository name, copies
`index.html` to `404.html` so deep links survive, and writes `.nojekyll`.

### CI

[`ci.yml`](.github/workflows/ci.yml) runs on every push: builds the web app,
runs the core's checks through the browser adapters, boots the API and runs the
smoke test over HTTP, restarts it to prove data survives, then builds both
Docker images and validates the compose file.

---

## Other notes

- Set a real `JWT_SECRET` and a real `SEED_PASSWORD` — the API refuses to start
  in production with either default.
- Set `GRAB_WEBHOOK_SECRET`; without it the webhook signature check is skipped.
- The seeded passwords are documented above, so treat them as public and change
  them after first login.
- `data/store.json` is gitignored. Do not commit one: it contains password
  hashes and customer contact details.
