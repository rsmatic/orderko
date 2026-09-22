# Deploying the backend

The frontend is already live on GitHub Pages at
<https://rsmatic.github.io/orderko/>, running the in-browser demo backend. This
document covers standing up the *real* API and MySQL, and pointing that same
site at them.

Everything below needs an account and a payment method, which is why it is a
runbook rather than something already done.

---

## Option A — Railway (recommended)

One provider for both the API and MySQL, so the database credentials are
injected for you and there is no cross-provider networking to arrange.

Railway has no free tier; budget a few dollars a month. **Check current pricing
— it changes.**

### 1. Account and CLI

```bash
npm i -g @railway/cli
railway login          # opens a browser
```

### 2. Project and database

```bash
cd /path/to/orderko
railway init                      # name it "orderko"
railway add --database mysql
```

Railway now exposes `MYSQLHOST`, `MYSQLPORT`, `MYSQLUSER`, `MYSQLPASSWORD` and
`MYSQLDATABASE` to services in the project.

### 3. Deploy the API

The repo root is the Docker build context because the image keeps the monorepo
layout (the setup script reads `db/*.sql` relative to it).

```bash
railway up --service api
```

Then set the service variables — in the dashboard, or:

```bash
railway variables --service api \
  --set NODE_ENV=production \
  --set DB_HOST='${{MySQL.MYSQLHOST}}' \
  --set DB_PORT='${{MySQL.MYSQLPORT}}' \
  --set DB_USER='${{MySQL.MYSQLUSER}}' \
  --set DB_PASSWORD='${{MySQL.MYSQLPASSWORD}}' \
  --set DB_NAME='${{MySQL.MYSQLDATABASE}}' \
  --set JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")" \
  --set SEED_PASSWORD="$(node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))")" \
  --set CORS_ORIGIN=https://rsmatic.github.io \
  --set GRAB_MODE=mock
```

Write down the `SEED_PASSWORD` you generated — it is the login for the seeded
admin account, and it is not recoverable from the database afterwards.

Generate a domain for the service (dashboard → Settings → Networking → Generate
Domain), then set `PUBLIC_BASE_URL` to it:

```bash
railway variables --service api --set PUBLIC_BASE_URL=https://<your>.up.railway.app
```

### 4. Load the schema

```bash
railway run --service api npm run db:setup
```

`db:setup` refuses to run with the documented default `SEED_PASSWORD` when
`NODE_ENV=production`, so set a real one first.

### 5. Point the site at it

```bash
gh variable set VITE_API_BASE_URL --repo rsmatic/orderko \
  --body "https://<your>.up.railway.app/api"
gh workflow run deploy-pages.yml --repo rsmatic/orderko
```

That disables demo mode and rebuilds. The demo chunk drops out of the bundle.

### 6. Verify

```bash
curl https://<your>.up.railway.app/api/health
# {"ok":true,"db":"up","grab_mode":"mock","env":"production"}

SMOKE_BASE_URL=https://<your>.up.railway.app \
SEED_PASSWORD=<the one you generated> \
  npm run smoke
```

The smoke test writes real orders, so run it once against a fresh database and
not against a shop that is taking orders.

---

## Option B — Your own server

One command, no platform, and the API and web share an origin so there is no
CORS to configure. Any box with Docker: Hetzner, DigitalOcean, a spare machine.

```bash
git clone git@github.com:rsmatic/orderko.git && cd orderko
cp .env.compose.example .env
# edit .env: MYSQL_ROOT_PASSWORD, DB_PASSWORD, JWT_SECRET, SEED_PASSWORD,
#            and SITE_ADDRESS if you have a domain

docker compose up -d --build
docker compose run --rm api npm run db:setup
```

Open `http://<server>` — or your domain, for which Caddy fetches a certificate
by itself once `SITE_ADDRESS` is set.

This serves the web app itself, so GitHub Pages becomes optional. If you want
to keep the Pages site as the front door instead, set `VITE_API_BASE_URL` to
your domain's `/api` and add that origin to `CORS_ORIGIN`.

Backups are yours to arrange:

```bash
docker compose exec mysql mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" \
  overnight_oats | gzip > backup-$(date +%F).sql.gz
```

---

## Option C — Render plus a managed MySQL

Render's free web tier runs the container but it has no managed MySQL, so the
database comes from elsewhere (Aiven and TiDB both offer MySQL-compatible free
plans — verify current terms). [`render.yaml`](render.yaml) is the blueprint.

The trade: two providers, and a free Render instance sleeps when idle, so the
first request after a pause takes 30–60 seconds. The frontend reports that as
"it may still be waking up" rather than an error, but a real customer should
not meet it.

---

## Do not use

**PlanetScale, TiDB, Vitess-based services** for the *primary* database
without checking first: the schema has 14 foreign-key constraints and 4 JSON
columns, and foreign keys are exactly where MySQL-compatible layers differ.
Dropping them would push referential integrity into application code.

**Supabase, Neon, any Postgres** — wrong dialect. The schema uses `ENUM`,
`JSON_QUOTE`, `GROUP_CONCAT`, `ON DUPLICATE KEY UPDATE` and MySQL `INTERVAL`
arithmetic; it will not load.

---

## Before you take real orders

- [ ] `JWT_SECRET` is random and private (the API refuses to boot in production without one).
- [ ] `SEED_PASSWORD` is not `Password123!`, and you changed the seeded accounts' passwords after first login.
- [ ] MySQL uses a dedicated user, not `root`.
- [ ] `CORS_ORIGIN` lists only origins you control.
- [ ] `GRAB_WEBHOOK_SECRET` is set — without it the webhook signature check is skipped.
- [ ] Database backups are scheduled.
- [ ] `GRAB_MODE=live` with real credentials, once you have a GrabExpress partner account.
