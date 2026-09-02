#!/usr/bin/env bash
# Seed a fresh Odoo instance for benchmarking: create the database with demo
# data, then install the Sales app (quote -> sales order -> invoice is the
# flow we drive). Run once after `docker compose up -d`.
#
#   bash bench/thirdparty/odoo/seed.sh
#
# Afterwards: http://127.0.0.1:8069  admin / admin
# To start over: docker compose -f bench/thirdparty/odoo/docker-compose.yml down -v
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${ODOO_URL:-http://127.0.0.1:8069}"
DB="${ODOO_DB:-bench}"

# The compose stack reports the container up before Odoo is listening, and a
# database/create posted into that gap fails the whole seed (smko1's box hit
# exactly this). Wait for the HTTP server first.
echo "==> waiting for odoo to listen at $BASE"
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/web/database/selector" || true)"
  case "$code" in 2*|3*) break ;; esac
  sleep 2
done

echo "==> creating database '$DB' with demo data (a few minutes)"
curl -sS -X POST "$BASE/web/database/create" \
  -F master_pwd=admin -F name="$DB" -F login=admin -F password=admin \
  -F lang=en_US -F country_code=GB -F phone= -F demo=1 \
  -o /dev/null -w '    HTTP %{http_code}\n' --max-time 900

# A fresh database carries only the base modules, so there is nothing to
# automate yet. Install Sales offline: the running server holds a registry
# that a live install would have to invalidate, so stop it, install in a
# one-off container, and bring it back.
# Install `contacts` alongside sale_management. Without it, res.partner has no
# top-level "Contacts" app in the menu, and whether one appears at all depends
# on which module happens to pull it in — the recording box (fwod30) had a
# Contacts app and the flow navigates to it, but fresh boxes seeded with only
# sale_management did NOT, so rpod1's 01-open primary `menuitem "Contacts"`
# missed and paid full recovery on every replay. Naming it explicitly makes
# the menu identical across boxes, which is the whole point of a shared seed.
echo "==> installing the Sales + Contacts apps (a few minutes)"
docker compose -f "$HERE/docker-compose.yml" stop odoo >/dev/null
docker compose -f "$HERE/docker-compose.yml" run --rm --no-deps odoo \
  odoo -d "$DB" -i sale_management,contacts --without-demo=False --stop-after-init >/dev/null 2>&1
docker compose -f "$HERE/docker-compose.yml" start odoo >/dev/null

echo -n "==> waiting for the server"
for _ in $(seq 1 45); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/web/login")" = "200" ]; then
    echo " ready"
    echo "    $BASE  (admin / admin)"
    exit 0
  fi
  echo -n .
  sleep 4
done
echo " TIMED OUT"
exit 1
