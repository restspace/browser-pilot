#!/usr/bin/env bash
# Create the benchmark user and a repository with content to drive.
# Run once after `docker compose up -d`.
#   bench user: bench / bench-pass-1234
set -euo pipefail
C=gitea-gitea-1
BASE="${GITEA_URL:-http://127.0.0.1:3001}"

if docker exec -u git "$C" gitea admin user list 2>/dev/null | grep -q '\bbench\b'; then
  echo "==> user 'bench' already exists"
else
  echo "==> creating user 'bench'"
  docker exec -u git "$C" gitea admin user create \
    --username bench --password 'bench-pass-1234' \
    --email bench@example.com --must-change-password=false --admin
fi

echo "==> creating repository 'bench-repo' with a README"
curl -sS -u 'bench:bench-pass-1234' -X POST "$BASE/api/v1/user/repos" \
  -H 'Content-Type: application/json' \
  -d '{"name":"bench-repo","description":"Benchmark fixture repo","private":false,"auto_init":true,"readme":"Default"}' \
  -o /dev/null -w '    HTTP %{http_code}\n' || true

echo "==> opening two issues"
for n in 1 2; do
  curl -sS -u 'bench:bench-pass-1234' -X POST "$BASE/api/v1/repos/bench/bench-repo/issues" \
    -H 'Content-Type: application/json' \
    -d "{\"title\":\"Fixture issue $n\",\"body\":\"Seeded for benchmarking.\"}" \
    -o /dev/null -w "    issue $n HTTP %{http_code}\n" || true
done
echo "done — $BASE  (bench / bench-pass-1234)"
