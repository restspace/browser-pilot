#!/usr/bin/env bash
# Create the benchmark database on a fresh Odoo instance, WITH demo data
# (customers, products, sales orders) so there is real content to drive.
# Idempotent-ish: fails loudly if the database already exists.
#
#   bash bench/thirdparty/odoo/seed.sh
#
# Login afterwards: admin / admin at http://127.0.0.1:8069
set -euo pipefail
BASE="${ODOO_URL:-http://127.0.0.1:8069}"
DB="${ODOO_DB:-bench}"

echo "creating database '$DB' with demo data (this takes a few minutes)..."
curl -sS -X POST "$BASE/web/database/create" \
  -F master_pwd=admin \
  -F name="$DB" \
  -F login=admin \
  -F password=admin \
  -F lang=en_US \
  -F country_code=GB \
  -F phone= \
  -F demo=1 \
  -o /dev/null -w 'HTTP %{http_code}\n' --max-time 900
echo "done — $BASE  (admin / admin)"
