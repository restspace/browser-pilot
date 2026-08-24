#!/usr/bin/env bash
# Create the first NocoDB user (the first signup becomes super-admin), so the
# instance is reachable without clicking through the welcome screen.
#   admin: bench@example.com / bench-pass-1234
set -euo pipefail
BASE="${NOCODB_URL:-http://127.0.0.1:8090}"
echo "==> signing up the first user (becomes super admin)"
curl -sS -X POST "$BASE/api/v1/auth/user/signup" \
  -H 'Content-Type: application/json' \
  -d '{"email":"bench@example.com","password":"bench-pass-1234"}' \
  -o /tmp/nc.json -w '    HTTP %{http_code}\n'
head -c 200 /tmp/nc.json; echo
echo "done — $BASE  (bench@example.com / bench-pass-1234)"
