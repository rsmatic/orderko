#!/usr/bin/env bash
#
# Brings a fresh Ubuntu box up as the whole shop: the API, the web app, and
# Caddy in front getting its own HTTPS certificate.
#
#   curl -fsSL https://raw.githubusercontent.com/rsmatic/orderko/main/scripts/bootstrap-ec2.sh | bash -s -- shop.example.com
#
# Safe to run twice: it installs what is missing and leaves an existing store
# alone. It never overwrites a .env that is already there, because that file
# holds the secrets the running store was seeded with.
set -euo pipefail

DOMAIN="${1:-}"
REPO="${REPO:-https://github.com/rsmatic/orderko.git}"
DIR="${DIR:-$HOME/orderko}"

if [ -z "$DOMAIN" ]; then
  echo "usage: bootstrap-ec2.sh <domain>" >&2
  echo "  the domain must already point at this machine's IP" >&2
  exit 1
fi

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "Checking the domain points here"
# Caddy asks Let's Encrypt for a certificate, and Let's Encrypt checks by
# connecting back to this address. Getting this wrong is the usual reason a
# deploy comes up on plain HTTP and never upgrades, so it is worth saying early.
MINE="$(curl -fsS --max-time 10 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"
THEIRS="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)"
if [ -z "$THEIRS" ]; then
  echo "  WARNING: $DOMAIN does not resolve yet."
  echo "  Caddy will keep retrying, so this is fine if DNS is still spreading."
elif [ -n "$MINE" ] && [ "$MINE" != "$THEIRS" ]; then
  echo "  WARNING: $DOMAIN resolves to $THEIRS but this machine is $MINE."
  echo "  The certificate cannot be issued until that matches."
else
  echo "  $DOMAIN -> $THEIRS (this machine)"
fi

say "Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl git openssl
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
  echo "  installed"
else
  echo "  already installed"
fi

say "Fetching the code"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR"

say "Writing .env"
if [ -f .env ]; then
  echo "  .env already exists — left untouched."
  echo "  It holds the secrets this store was seeded with; changing"
  echo "  SEED_PASSWORD now would not change anybody's existing password."
else
  secret() { openssl rand -base64 24 | tr -d '\n' | tr '+/' '-_'; }
  cat > .env <<EOF
JWT_SECRET=$(secret)
SEED_PASSWORD=$(secret)
SITE_ADDRESS=$DOMAIN
PUBLIC_BASE_URL=https://$DOMAIN
HTTP_PORT=80
HTTPS_PORT=443
# A real shop starts with an empty order book.
SEED_SAMPLE_ORDERS=false
GRAB_MODE=sim
EOF
  chmod 600 .env
  echo "  written. The seeded admin password is:"
  echo
  echo "      $(grep '^SEED_PASSWORD=' .env | cut -d= -f2-)"
  echo
  echo "  Sign in as admin@orderko.test, change it, then delete the seeded"
  echo "  accounts you do not want. This password is only ever used to create"
  echo "  them on first boot."
fi

say "Building and starting"
sudo docker compose up -d --build

say "Nightly backup of the store"
# The whole shop is one JSON file, which makes backing it up trivial and makes
# not doing it unforgivable.
#
# The volume name is read from compose rather than assumed: it is prefixed with
# the project name, which is the directory name, so hardcoding it would break
# the moment this is cloned somewhere else.
VOLUME="$(sudo docker compose config --volumes | grep -x 'api-data' >/dev/null && \
  sudo docker compose ps -q api | xargs -r sudo docker inspect \
    -f '{{ range .Mounts }}{{ if eq .Destination "/app/apps/api/data" }}{{ .Name }}{{ end }}{{ end }}' || true)"

if [ -z "$VOLUME" ]; then
  echo "  could not identify the data volume — skipping the backup job"
else
  sudo install -d -m 700 /var/backups/orderko
  sudo tee /etc/cron.daily/orderko-backup >/dev/null <<CRON
#!/bin/sh
# Keeps 14 days of the order book. The file is small; the shop is not.
set -e
MOUNT=\$(docker volume inspect -f '{{ .Mountpoint }}' '$VOLUME' 2>/dev/null) || exit 0
[ -f "\$MOUNT/store.json" ] || exit 0
gzip -c "\$MOUNT/store.json" > "/var/backups/orderko/store-\$(date +%Y-%m-%d).json.gz"
find /var/backups/orderko -name 'store-*.json.gz' -mtime +14 -delete
CRON
  sudo chmod +x /etc/cron.daily/orderko-backup
  echo "  volume $VOLUME -> /var/backups/orderko (14 days)"
fi

say "Done"
echo "  Shop:   https://$DOMAIN"
echo "  Health: https://$DOMAIN/api/health"
echo
echo "  The certificate takes a few seconds on first boot. If it never"
echo "  arrives, check DNS and that ports 80 and 443 are open in the security"
echo "  group — Let's Encrypt needs port 80 to verify the domain."
echo
echo "  Logs:    cd $DIR && sudo docker compose logs -f"
echo "  Restart: cd $DIR && sudo docker compose restart"
echo "  Update:  cd $DIR && git pull && sudo docker compose up -d --build"
