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

echo "==> creating database '$DB' with demo data (a few minutes)"
curl -sS -X POST "$BASE/web/database/create" \
  -F master_pwd=admin -F name="$DB" -F login=admin -F password=admin \
  -F lang=en_US -F country_code=GB -F phone= -F demo=1 \
  -o /dev/null -w '    HTTP %{http_code}\n' --max-time 900

# A fresh database carries only the base modules, so there is nothing to
# automate yet. Install Sales offline: the running server holds a registry
# that a live install would have to invalidate, so stop it, install in a
# one-off container, and bring it back.
echo "==> installing the Sales app (a few minutes)"
docker compose -f "$HERE/docker-compose.yml" stop odoo >/dev/null
docker compose -f "$HERE/docker-compose.yml" run --rm --no-deps odoo \
  odoo -d "$DB" -i sale_management --without-demo=False --stop-after-init >/dev/null 2>&1
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
