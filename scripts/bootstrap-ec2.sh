#!/usr/bin/env bash
#
# Brings a fresh EC2 box up as the whole shop: the API, the web app, and Caddy
# in front. Works on Amazon Linux and on Ubuntu.
#
#   curl -fsSL https://raw.githubusercontent.com/rsmatic/orderko/main/scripts/bootstrap-ec2.sh | bash
#   curl -fsSL …/bootstrap-ec2.sh | bash -s -- shop.example.com
#
# With no argument it serves plain HTTP, which is all a bare IP can do — a
# certificate needs a name. Add one later with scripts/enable-https.sh.
#
# Safe to run twice: it installs what is missing and leaves an existing store
# alone. It never overwrites a .env, because that holds the secrets the store
# was seeded with.
set -euo pipefail

DOMAIN="${1:-}"
REPO="${REPO:-https://github.com/rsmatic/orderko.git}"
DIR="${DIR:-$HOME/orderko}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

case "$(uname -m)" in
  x86_64)  PLUGIN_ARCH=amd64 ;;
  aarch64) PLUGIN_ARCH=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

say "Swap"
# The web image is built with Vite, which wants more memory than the smallest
# instances have. Below a gigabyte the build is killed part way through with
# nothing useful in the log, so buy the headroom rather than debug that.
RAM_MB=$(free -m | awk '/Mem:/{print $2}')
if [ "$RAM_MB" -lt 950 ] && ! swapon --show | grep -q /swapfile; then
  sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  echo "  ${RAM_MB} MB of RAM — added 2 GB of swap so the build survives"
else
  echo "  ${RAM_MB} MB of RAM — no swap needed"
fi

say "Docker and git"
if command -v dnf >/dev/null 2>&1; then
  sudo dnf install -y -q docker git >/dev/null
  sudo systemctl enable --now docker >/dev/null 2>&1
elif command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl git
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io
else
  echo "no dnf or apt-get — unsupported distribution" >&2
  exit 1
fi
sudo usermod -aG docker "$USER"
echo "  $(sudo docker --version)"

say "Compose and buildx plugins"
# Amazon Linux ships Docker without either plugin, and with a buildx too old
# for current compose ("compose build requires buildx 0.17.0 or later").
PLUGINS=/usr/libexec/docker/cli-plugins
sudo mkdir -p "$PLUGINS"

if ! sudo docker compose version >/dev/null 2>&1; then
  sudo curl -fsSL \
    "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${PLUGIN_ARCH/amd64/x86_64}" \
    -o "$PLUGINS/docker-compose"
  sudo chmod +x "$PLUGINS/docker-compose"
fi
echo "  $(sudo docker compose version)"

BUILDX_OK=$(sudo docker buildx version 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+' | head -1 || echo v0.0)
if [ "$(printf '%s\nv0.17\n' "$BUILDX_OK" | sort -V | head -1)" != "v0.17" ]; then
  # buildx names its assets with the version in them, so the /latest/download
  # shortcut 404s and quietly writes an HTML error page over the binary.
  URL=$(curl -fsSL https://api.github.com/repos/docker/buildx/releases/latest \
    | grep -o "https://github.com/docker/buildx/releases/download/[^\"]*linux-${PLUGIN_ARCH}" | head -1)
  [ -n "$URL" ] || { echo "could not resolve a buildx download" >&2; exit 1; }
  sudo curl -fsSL "$URL" -o "$PLUGINS/docker-buildx"
  sudo chmod +x "$PLUGINS/docker-buildx"
fi
echo "  $(sudo docker buildx version)"

say "Code"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone --depth 1 "$REPO" "$DIR"; fi
cd "$DIR"

say "Configuration"
if [ -f .env ]; then
  echo "  .env already exists — left untouched."
  echo "  It holds the secrets this store was seeded with."
else
  secret() { openssl rand -base64 24 | tr -d '\n' | tr '+/' '-_'; }
  PUBLIC_IP=$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')
  if [ -n "$DOMAIN" ]; then
    SITE="$DOMAIN"; BASE="https://$DOMAIN"
  else
    SITE=":80"; BASE="http://${PUBLIC_IP:-localhost}"
  fi
  cat > .env <<EOF
JWT_SECRET=$(secret)
SEED_PASSWORD=$(secret)
SITE_ADDRESS=$SITE
PUBLIC_BASE_URL=$BASE
HTTP_PORT=80
HTTPS_PORT=443
# A real shop starts with an empty order book.
SEED_SAMPLE_ORDERS=false
GRAB_MODE=sim
EOF
  chmod 600 .env
  echo "  written — serving on $BASE"
  echo
  echo "  Seeded admin password (admin@orderko.test):"
  echo "      $(grep '^SEED_PASSWORD=' .env | cut -d= -f2-)"
  echo
  echo "  Change it after signing in, then delete the seeded accounts you do"
  echo "  not want. It is only used to create them on first boot."
fi

say "Building and starting"
sudo docker compose up -d --build

say "Nightly backup of the store"
# The whole shop is one JSON file, which makes backing it up trivial and makes
# not doing it unforgivable. The volume name is read from the running container
# rather than assumed: compose prefixes it with the directory name.
VOLUME=$(sudo docker compose ps -q api | xargs -r sudo docker inspect \
  -f '{{ range .Mounts }}{{ if eq .Destination "/app/apps/api/data" }}{{ .Name }}{{ end }}{{ end }}' || true)
if [ -z "$VOLUME" ]; then
  echo "  could not identify the data volume — skipping"
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
  echo "  $VOLUME -> /var/backups/orderko (14 days)"
fi

say "Done"
BASE_SHOWN=$(grep '^PUBLIC_BASE_URL=' .env | cut -d= -f2-)
echo "  Shop:   $BASE_SHOWN"
echo "  Health: $BASE_SHOWN/api/health"
echo
echo "  Open ports 80 and 443 in the security group if you have not."
[ -z "$DOMAIN" ] && cat <<'NOTE'

  This is plain HTTP, which a bare IP is limited to. Google Sign-In,
  tap-to-copy and "use my location" all need a secure origin, so they will
  not work until there is a hostname. Get a free one at duckdns.org, then:

      ./scripts/enable-https.sh yourname.duckdns.org
NOTE
echo
echo "  Logs:    cd $DIR && sudo docker compose logs -f"
echo "  Update:  cd $DIR && git pull && sudo docker compose up -d --build"
