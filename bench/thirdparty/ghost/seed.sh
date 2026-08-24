#!/usr/bin/env bash
# Complete Ghost's owner setup so the admin is reachable without clicking
# through the first-run wizard. Run once after `docker compose up -d`.
#   admin: bench@example.com / bench-pass-1234
set -euo pipefail
BASE="${GHOST_URL:-http://127.0.0.1:2368}"

echo "==> completing owner setup"
curl -sS -X POST "$BASE/ghost/api/admin/authentication/setup/" \
  -H 'Content-Type: application/json' \
  -H 'Accept-Version: v5.0' \
  -d '{"setup":[{"name":"Bench Admin","email":"bench@example.com","password":"bench-pass-1234","blogTitle":"Bench Blog"}]}' \
  -o /tmp/ghost-setup.json -w '    HTTP %{http_code}\n'
head -c 200 /tmp/ghost-setup.json; echo
echo "done — $BASE/ghost/  (bench@example.com / bench-pass-1234)"
