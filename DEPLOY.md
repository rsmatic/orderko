# Deploying

The frontend is already live on GitHub Pages at
<https://rsmatic.github.io/orderko/>, running the core in the browser. This
document covers standing up the *real* API and pointing that same site at it.

There is no database to provision. What you do need is a host that runs a
container **with a persistent disk** — the store is a JSON file, and an
ephemeral filesystem loses every order on redeploy.

---

## What the store needs from a host

| Requirement | Why |
|---|---|
| A persistent disk or volume | `data/store.json` *is* the database |
| Exactly one instance | No cross-process locking; two replicas overwrite each other |
| ~50 MB of disk | The seeded store is ~120 KB; it grows with orders |
| No database add-on | There isn't one |

Anything that satisfies the first two works. The options below are ordered by
how little there is to go wrong.

---

## Option A — a machine you own, via Cloudflare Tunnel

Free, no account, no card, no open inbound ports, and it works on a laptop
behind a home router. The GitHub Pages site stays the front door; the tunnel
carries `/api` to whichever machine is running it.

```bash
npm install
npm run serve:publish
```

That starts the API, opens a Cloudflare quick tunnel, prints the public URL,
and repoints the Pages site at it. `npm run serve` does the same without
touching the deployment.

You need `cloudflared`. The script takes whatever is on PATH, so any of these
work; set `CLOUDFLARED` to override:

```bash
# Windows
winget install --id Cloudflare.cloudflared
# macOS
brew install cloudflared
# Linux
curl -Lo cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  && chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/
```

Before exposing anything, set real secrets in `apps/api/.env`:

```ini
NODE_ENV=production
CORS_ORIGIN=https://rsmatic.github.io
JWT_SECRET=<32 random bytes>
SEED_PASSWORD=<not the one published in the README>
```

Then `npm run data:reset`, so the seeded accounts use your password rather than
the public one. The API refuses to start in production with either default, but
it cannot tell that an *existing* store was seeded with the old one.

### The catch

A quick tunnel's hostname changes every time it starts, so the Pages site has
to be rebuilt to match — which is what `--publish` does, at about a minute per
restart. Fine for a shop that starts the machine once and leaves it; irritating
if you restart often.

For a stable hostname, upgrade to a **named tunnel**. That needs a free
Cloudflare account and a domain on Cloudflare, after which:

```bash
cloudflared tunnel login
cloudflared tunnel create orderko
cloudflared tunnel route dns orderko api.yourdomain.com
cloudflared tunnel run --url http://localhost:4000 orderko
```

Now `VITE_API_BASE_URL` is `https://api.yourdomain.com/api` permanently and no
rebuild is needed again. Run it as a service (`cloudflared service install`) so
it survives reboots.

### What this does and does not protect

The tunnel exposes the API to the whole internet. `CORS_ORIGIN` stops *other
websites* from reading it in a browser, but it does nothing against `curl` —
CORS is a browser policy, not access control. What actually protects the data
is authentication, which is why the seeded password matters.

---

## Option B — your own server, with Docker

One command, no platform account, no per-service billing, and the API and web
app share an origin so there is no CORS to configure. Any box with Docker:
Hetzner, DigitalOcean, a spare machine at the shop.

```bash
git clone git@github.com:rsmatic/orderko.git && cd orderko
cp .env.compose.example .env
```

Edit `.env` — at minimum:

```ini
JWT_SECRET=<node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))">
SEED_PASSWORD=<something private; this is your first admin login>
SITE_ADDRESS=shop.example.com     # blank for plain HTTP
PUBLIC_BASE_URL=https://shop.example.com
```

Then:

```bash
docker compose up -d --build
```

The store seeds itself on first boot. Open `http://<server>` — or your domain,
for which Caddy fetches a certificate by itself once `SITE_ADDRESS` is set.

This serves the web app too, so GitHub Pages becomes optional. To keep the Pages
site as the front door instead, set `VITE_API_BASE_URL` to your domain's `/api`
and add that origin to `CORS_ORIGIN`.

### Backups

The database is one file, so a backup is a copy. Put this in cron:

```bash
docker compose cp api:/app/apps/api/data/store.json \
  ./backups/store-$(date +%F-%H%M).json
```

Restore by stopping the API, putting a copy back, and starting it again.

---

## Option C — Render

[`render.yaml`](render.yaml) is the blueprint: `New → Blueprint`, point it at
this repo, and fill in the values marked `sync: false` (`PUBLIC_BASE_URL` and
`SEED_PASSWORD`). `JWT_SECRET` is generated for you.

**The free instance type will not work.** It has no disk support and an
ephemeral filesystem, so the store resets on every deploy and restart. The
blueprint asks for a paid instance type with a 1 GB disk mounted at
`/app/apps/api/data`, and pins `numInstances: 1`.

Check current pricing before committing — it changes.

---

## Option D — anywhere else

The image is plain Docker, built from the repo root:

```bash
docker build -f apps/api/Dockerfile -t orderko-api .
```

Run it with a volume on `/app/apps/api/data`, one replica, and these variables:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `JWT_SECRET` | a long random string — the API refuses to boot without one |
| `SEED_PASSWORD` | not the documented default — also refused |
| `CORS_ORIGIN` | the exact origin serving the frontend, no trailing slash |
| `PUBLIC_BASE_URL` | the API's own public URL |
| `DATA_FILE` | `data/store.json` |
| `GRAB_MODE` | `sim` until you have GrabExpress credentials |

Health check path is `/api/health`, which reports how many orders the store
holds.

Fly.io, Railway and a bare `docker run` behind nginx all fit. Platforms that
only offer ephemeral disks (most free tiers, Cloud Run, Lambda) do not, unless
you replace `persistence.js` with object storage.

---

## Pointing the Pages site at it

```bash
gh variable set VITE_API_BASE_URL --repo rsmatic/orderko \
  --body "https://<your-api>/api"
gh workflow run deploy-pages.yml --repo rsmatic/orderko
```

That disables demo mode and rebuilds; the demo chunk drops out of the bundle.

## Verifying

```bash
curl https://<your-api>/api/health
# {"ok":true,"store":"json","orders":52,"grab_mode":"sim","env":"production"}

SMOKE_BASE_URL=https://<your-api> \
SEED_PASSWORD=<the one you set> \
  npm run smoke
```

The smoke test writes real orders and edits prices, so run it against a fresh
store — not one taking orders.

---

## Before you take real orders

- [ ] `JWT_SECRET` is random and private.
- [ ] `SEED_PASSWORD` is not `Password123!`, and you changed the seeded
      accounts' passwords after first login. They are published in the README.
- [ ] The data directory is on a **persistent** volume — confirm by redeploying
      and checking `orders` in `/api/health` did not reset.
- [ ] Backups are scheduled and you have restored one at least once.
- [ ] `CORS_ORIGIN` lists only origins you control.
- [ ] Exactly one instance is running.
- [ ] `GRAB_WEBHOOK_SECRET` is set — without it the signature check is skipped.
- [ ] `GRAB_MODE=live` with real credentials, once you have a GrabExpress
      partner account.

## If the shop outgrows a JSON file

The signs are slow writes as the file grows, or wanting more than one instance.
`packages/core` never touches storage directly — it reads and writes one state
object — so the migration is to give it a different persistence adapter rather
than to rewrite the application. `git log` still has the MySQL implementation
if that is the direction.
