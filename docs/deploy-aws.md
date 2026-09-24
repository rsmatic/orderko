# Putting the shop on AWS

The end state is one address — `https://shop.yourdomain.com` — serving the
customer site, the dashboards and the API together. No tunnel, no CORS, no
second URL to keep in sync, and nothing that changes when the machine restarts.

That is a real improvement over the current setup, where GitHub Pages serves the
site and a Cloudflare quick tunnel reaches an API on a laptop. The tunnel gets a
new address every restart, which means a redeploy every restart, and the shop is
offline whenever the laptop is.

---

## What this costs

| | |
|---|---|
| **EC2 t3.micro** | Free for 12 months on a new account, then about **$8–10/month** |
| **Domain** | About **$10–15/year** |
| **Everything else** | Nothing — Let's Encrypt certificates are free, the store is a file |

**Set a billing alarm on day one.** The free tier ends quietly twelve months
after signup and the first sign is usually the bill. Billing → Budgets → create a
zero-spend or $5 budget with an email alert. It takes two minutes and is the
difference between a surprise and a decision.

---

## 1. Create the account

At `aws.amazon.com` → **Create an AWS account**. You need an email, a phone for
the verification code, and a payment card. Fifteen minutes, most of it waiting.

Then, before anything else:

1. **Turn on MFA for the root user.** IAM → Security credentials → assign an
   authenticator app. The root user can close the account and move money; it
   should not be protected by a password alone.
2. **Stop using the root user.** IAM → Users → create one for yourself with
   `AdministratorAccess`, and sign in as that from now on.
3. **Set the billing alarm** described above.

---

## 2. Get a domain

Caddy fetches a certificate automatically, but only for a name you control.
**It cannot get one for an `ec2-…compute.amazonaws.com` address** — those are on
the Public Suffix List and Let's Encrypt refuses them. Without a domain the shop
can only serve plain HTTP, and a browser on an HTTPS page will not call an HTTP
API, so the site cannot reach it.

Any registrar works — Namecheap, Cloudflare, Porkbun, or Route 53 if you want it
all in one place. A free **DuckDNS** subdomain also works with Let's Encrypt if
you would rather not buy anything yet.

---

## 3. Launch the instance

EC2 → **Launch instance**.

| Setting | Value | Why |
|---|---|---|
| Name | `orderko` | |
| AMI | **Ubuntu Server 24.04 LTS** | what the bootstrap script expects |
| Type | **t3.micro** | free tier; enough for a shop this size |
| Key pair | create one, download the `.pem` | the only way back in — keep it |
| Region | **ap-southeast-1 (Singapore)** | nearest to the Philippines |
| Storage | 20 GB gp3 | 8 GB is tight once Docker images land |

**Security group** — three rules, and no more:

| Port | Source | Why |
|---|---|---|
| 22 | **My IP** | SSH. Not `0.0.0.0/0`: an open SSH port is found within minutes |
| 80 | Anywhere | Let's Encrypt verifies over port 80; it also redirects to HTTPS |
| 443 | Anywhere | the shop |

Then **Elastic IP** → allocate → associate it with the instance. Without this the
public address changes every time the machine stops, and the DNS record you are
about to write goes stale.

---

## 4. Point the domain at it

At your registrar, an **A record** for `shop` → the Elastic IP.

Check it before going further — this is the single most common thing to get
wrong, and every later symptom looks like something else:

```
nslookup shop.yourdomain.com 1.1.1.1
```

---

## 5. Run the bootstrap

```bash
ssh -i orderko.pem ubuntu@<elastic-ip>
curl -fsSL https://raw.githubusercontent.com/rsmatic/orderko/main/scripts/bootstrap-ec2.sh \
  | bash -s -- shop.yourdomain.com
```

It installs Docker, clones the repo, writes a `.env` with freshly generated
secrets, builds and starts everything, and installs a nightly backup of the
store. It is safe to run twice and will not overwrite an existing `.env`.

It prints the seeded admin password once. **Sign in as `admin@orderko.test`,
change it, then delete the seeded accounts you do not want.**

---

## 6. Move the existing shop over

The store is a single JSON file, so this is a copy. From the Windows machine:

```bash
scp -i orderko.pem apps/api/data/store.json ubuntu@<elastic-ip>:/tmp/store.json
```

Then on the server:

```bash
cd ~/orderko
sudo docker compose stop api
VOL=$(sudo docker volume ls -q | grep api-data)
sudo docker run --rm -v "$VOL":/data -v /tmp:/in alpine \
  sh -c 'cp /data/store.json /data/store.json.before-import && cp /in/store.json /data/store.json'
sudo docker compose start api
```

The API is stopped first because it holds the store in memory and rewrites the
whole file on every change — copying underneath a running API would be undone by
its next write. The old file is kept as `store.json.before-import`.

Your accounts, menu, orders, logo and GCash number all come across; they are all
in that one file.

---

## 7. Retire the tunnel

Once `https://shop.yourdomain.com` works:

- Stop `npm run serve:publish` on the Windows machine. Nothing depends on it.
- The GitHub Pages site is now a second, stale copy. Either point people at the
  new address, or set the `VITE_API_BASE_URL` repository variable to
  `https://shop.yourdomain.com/api` so Pages keeps working as a mirror.

---

## Afterwards

**Updating.** `cd ~/orderko && git pull && sudo docker compose up -d --build`.
The store lives in a Docker volume, not the repo, so it survives rebuilds.

**Backups.** `/etc/cron.daily/orderko-backup` keeps 14 days in
`/var/backups/orderko`. That protects against a bad edit, not against losing the
machine — copy one off the box periodically, or snapshot the EBS volume.

**One process, on purpose.** The store is a JSON file with no cross-process
locking. Do not scale this to two instances or two containers: they would
silently overwrite each other. That is why `docker-compose.yml` pins the API to
one replica. If the shop ever outgrows this, the fix is a real database, not a
second copy of the API.
