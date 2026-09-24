#!/usr/bin/env bash
#
# Switches a running deployment from plain HTTP to HTTPS on a hostname.
#
#   ./scripts/enable-https.sh orderko.duckdns.org
#
# Caddy fetches the certificate itself; there is nothing to paste and nothing
# to renew. What it needs is a name that resolves to this machine and a
# reachable port 80, which is how Let's Encrypt checks you own the name.
#
# A bare IP address cannot be used. Nor can the machine's own
# ec2-….compute-1.amazonaws.com name: that sits on the Public Suffix List, so
# it is a public suffix in its own right, and no certificate authority will
# issue for one. A free duckdns.org name works and is on the list as a proper
# suffix, meaning each name gets its own issuance budget.
set -euo pipefail

HOST="${1:-}"
DIR="${DIR:-$HOME/orderko}"

if [ -z "$HOST" ]; then
  echo "usage: enable-https.sh <hostname>" >&2
  exit 1
fi
case "$HOST" in
  *[0-9].[0-9]*) [[ "$HOST" =~ ^[0-9.]+$ ]] && {
    echo "That is an IP address. Certificates are only issued for names." >&2
    exit 1
  } ;;
esac

cd "$DIR"

echo "==> Checking $HOST points here"
MINE="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')"
THEIRS="$(getent hosts "$HOST" | awk '{print $1}' | head -1 || true)"
if [ -z "$THEIRS" ]; then
  echo "  $HOST does not resolve. Create it first, then re-run." >&2
  exit 1
fi
if [ "$MINE" != "$THEIRS" ]; then
  echo "  $HOST -> $THEIRS, but this machine is $MINE." >&2
  echo "  Point the record at this machine, then re-run." >&2
  exit 1
fi
echo "  $HOST -> $THEIRS"

echo "==> Rewriting .env"
cp .env .env.bak
# Only these two lines change. Everything else — the secrets the store was
# seeded with above all — is left exactly as it is.
sed -i "s|^SITE_ADDRESS=.*|SITE_ADDRESS=$HOST|" .env
sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://$HOST|" .env
grep -E '^(SITE_ADDRESS|PUBLIC_BASE_URL)=' .env | sed 's/^/  /'

echo "==> Restarting"
# Recreate rather than restart: both values are baked in as environment at
# container start, so a plain restart would keep serving the old ones.
sudo docker compose up -d
echo "  waiting for the certificate…"

for i in $(seq 1 30); do
  if curl -fsS --max-time 10 "https://$HOST/api/health" >/dev/null 2>&1; then
    echo
    echo "  HTTPS is live: https://$HOST"
    curl -s --max-time 10 "https://$HOST/api/health"; echo
    exit 0
  fi
  sleep 5
done

echo
echo "  No certificate yet. Caddy keeps retrying, so give it a minute." >&2
echo "  If it never arrives:" >&2
echo "    sudo docker compose logs web | tail -40" >&2
echo "  The usual causes are port 80 closed in the security group — Let's" >&2
echo "  Encrypt checks over port 80, not 443 — or DNS not yet spread." >&2
exit 1
