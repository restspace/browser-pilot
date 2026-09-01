#!/usr/bin/env bash
#
# Prepare a fresh Linux box (a cloud instance, a container, a CI runner) to run
# the benchmark against the neutral target app that ships in this repo.
#
# This is only possible for --target repairdesk. The other target is a private
# app behind a local mongod, which no cloud instance can reach.
#
# It does NOT run a benchmark. Runs cost money and take 10-40 minutes each, so
# the script sets everything up, verifies it, and prints the command to run.
#
# Usage:
#   bench/cloud-setup.sh                 # browser-pilot arm only
#   bench/cloud-setup.sh --with-arm-b    # also install agent-browser
#   bench/cloud-setup.sh --skip-browser  # a browser is already installed
#   bench/cloud-setup.sh --port 4181     # run the app somewhere else
#
#   # One box, several sweeps: bring up every target once, then reset between
#   # runs instead of re-provisioning. Repeatable.
#   bench/cloud-setup.sh --with-target odoo --with-target grafana
#
# Safe to re-run: every step checks before it acts.

set -euo pipefail

# The agent-browser version to install for arm B.
#
# 0.34.0 is npm latest as of 2026-08-21 (published 2026-08-10), chosen because
# measurement is starting again from scratch and a new baseline should be taken
# against the current tool rather than a stale one.
#
# It is a concrete version and not "latest" on purpose. A floating pin would
# make two boxes set up a week apart quietly disagree, which is exactly the
# failure this line exists to prevent. When you next want to move it, bump it
# here and note the change in HANDOFF.md so the discontinuity is on the record.
#
# This is a BASELINE BREAK: every agent-browser figure recorded in HANDOFF.md
# before 2026-08-21 came from 0.16.3, eighteen minor versions back. Those runs
# and runs made with this pin are not comparable, and neither is a mixture.
#   AGENT_BROWSER_VERSION=0.16.3 bench/cloud-setup.sh --with-arm-b   # old baseline
AGENT_BROWSER_VERSION="${AGENT_BROWSER_VERSION:-0.34.0}"

PORT="${PORT:-4180}"
WITH_ARM_B=0
WITH_ARM_MCP=0
WITH_ARM_BU=0
# Repeatable: `--with-target odoo --with-target grafana` brings up both, so one
# box can run several sweeps back to back. Safe now that every target has a
# real per-run reset (bench/app-reset.mjs) - before that state accumulated
# across sweeps and a fresh box was the only way to get a clean baseline.
WITH_TARGETS=""
SKIP_BROWSER=0
START_APP=1

while [ $# -gt 0 ]; do
  case "$1" in
    --with-arm-b) WITH_ARM_B=1 ;;
    --with-target) WITH_TARGETS="${WITH_TARGETS} $2"; shift ;;
    --with-arm-mcp) WITH_ARM_MCP=1 ;;
    --with-arm-bu) WITH_ARM_BU=1 ;;
    --with-all-arms) WITH_ARM_B=1; WITH_ARM_MCP=1; WITH_ARM_BU=1 ;;
    --skip-browser) SKIP_BROWSER=1 ;;
    --no-start) START_APP=0 ;;
    --port) PORT="$2"; shift ;;
    # Print the header comment block and stop at the first line that is not
    # one, so the help cannot drift out of sync with the comment above.
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m    ! %s\033[0m\n' "$*"; }
die() { printf '\033[31m    x %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- node

say "Checking node"
command -v node >/dev/null || die "node is not installed; need >= 20"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 20 ] || die "node $(node --version) is too old; need >= 20"
echo "    node $(node --version)"

# ---------------------------------------------------------------- repo

say "Installing dependencies and building"
# browser-pilot is TypeScript. Without dist/ the CLI exists but does nothing,
# and the failure looks like a broken install rather than a missing build.
if [ -f package-lock.json ]; then npm ci; else npm install; fi
npm run build
[ -d dist ] && echo "    dist/ built" || die "build produced no dist/"

say "Putting browser-pilot on PATH"
if command -v browser-pilot >/dev/null; then
  echo "    already on PATH: $(command -v browser-pilot)"
else
  # npm link writes to the global prefix, which is root-owned on some images.
  # Falling back to a user-owned prefix is friendlier than telling people to
  # re-run the whole script under sudo.
  if ! npm link 2>/dev/null; then
    warn "npm link failed against the global prefix; using ~/.npm-global"
    npm config set prefix "$HOME/.npm-global"
    export PATH="$HOME/.npm-global/bin:$PATH"
    npm link
    warn "add this to your shell profile: export PATH=\"\$HOME/.npm-global/bin:\$PATH\""
  fi
  command -v browser-pilot >/dev/null || die "browser-pilot still not on PATH"
  echo "    $(command -v browser-pilot)"
fi

# ---------------------------------------------------------------- browser

say "Checking for a browser"
if [ "$SKIP_BROWSER" = "1" ]; then
  echo "    skipped by request"
elif command -v google-chrome >/dev/null || command -v google-chrome-stable >/dev/null; then
  echo "    found Chrome; browser-pilot's first channel will resolve"
else
  # The dependency is playwright-core, which bundles NO browser. browser-pilot
  # tries channels chrome -> msedge -> chromium, so on a bare container all
  # three miss and it fails with "could not launch a browser".
  #
  # The CLI version must match the installed playwright-core, or the downloaded
  # build can be one the pinned core does not know how to drive.
  pw_version="$(node -p "require('./node_modules/playwright-core/package.json').version")"
  echo "    installing chromium via playwright@${pw_version} (matching playwright-core)"
  # --with-deps pulls the shared libraries a headless chromium needs, which are
  # absent from most slim images. It needs root; without it, install them by
  # hand or run this on an image that already has them.
  if [ "$(id -u)" = "0" ]; then
    npx --yes "playwright@${pw_version}" install --with-deps chromium
  else
    warn "not root: installing the browser without system dependencies"
    warn "if chromium fails to start, re-run as root or: sudo npx playwright@${pw_version} install-deps chromium"
    npx --yes "playwright@${pw_version}" install chromium
  fi
fi

# ---------------------------------------------------------------- arm B

if [ "$WITH_ARM_B" = "1" ]; then
  say "Installing agent-browser (arm B)"
  installed=""
  command -v agent-browser >/dev/null && installed="$(agent-browser --version 2>/dev/null | head -1 || true)"
  if [ -n "$installed" ]; then
    echo "    already installed: ${installed}"
    case "$installed" in
      *"$AGENT_BROWSER_VERSION"*) : ;;
      *)
        warn "this is NOT the pinned ${AGENT_BROWSER_VERSION}; arm B results from this box"
        warn "will not be comparable with runs made against the pin. To match:"
        warn "  npm install -g agent-browser@${AGENT_BROWSER_VERSION}"
        ;;
    esac
  else
    npm install -g "agent-browser@${AGENT_BROWSER_VERSION}"
    echo "    $(agent-browser --version 2>/dev/null | head -1)"
  fi
fi

# ---------------------------------------------------------------- arm C (playwright-mcp)

# Pins live in bench/harness.mjs (ARMS) � these must match them.
PLAYWRIGHT_MCP_VERSION="${PLAYWRIGHT_MCP_VERSION:-0.0.79}"
BROWSER_USE_VERSION="${BROWSER_USE_VERSION:-0.13.8}"

if [ "$WITH_ARM_MCP" = "1" ]; then
  say "Preparing Playwright MCP (arm: playwright-mcp)"
  # The package itself came in with npm ci (it is a devDependency); what a
  # fresh box lacks is the server's own browser build, which is NOT the
  # chromium the step above installed.
  npx --yes "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" install-browser chrome-for-testing     || die "playwright-mcp browser install failed"
  echo "    @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} ready"
fi

# ---------------------------------------------------------------- arm D (browser-use)

if [ "$WITH_ARM_BU" = "1" ]; then
  say "Preparing browser-use (arm: browser-use)"
  py="$(command -v python3 || command -v python)" || die "python3 is not installed"
  if [ ! -d bench/arms/.venv-bu ]; then "$py" -m venv bench/arms/.venv-bu; fi
  vpy="bench/arms/.venv-bu/bin/python"; [ -x "$vpy" ] || vpy="bench/arms/.venv-bu/Scripts/python.exe"
  "$vpy" -m pip install -q "browser-use==${BROWSER_USE_VERSION}"
  "$vpy" -c "import browser_use" || die "browser-use import failed after install"
  # browser-use finds a system chrome/chromium or downloads its own on first
  # run; on a bare box that first download happens INSIDE run one and can eat
  # minutes of its wall clock, so trigger it now instead.
  echo '{"task":"noop","runid":"warm","model":"x","maxSteps":1}' | "$vpy" bench/arms/browser_use_runner.py >/dev/null 2>&1 || true
  echo "    browser-use==${BROWSER_USE_VERSION} ready"
fi

# ---------------------------------------------------------------- third-party targets

# --with-target odoo|grafana brings up a bench/thirdparty compose stack. On the
# cloud image the docker daemon is NOT running at boot and `service docker
# start` dies on a ulimit it may not set � but plain `dockerd` as root works
# (probed 2026-08-24: engine 29.3.1, compose v5.1.1, both stacks healthy).
for WITH_TARGET in $WITH_TARGETS; do
  say "Starting target: ${WITH_TARGET}"
  [ -f "bench/thirdparty/${WITH_TARGET}/docker-compose.yml" ] || die "unknown target ${WITH_TARGET}"
  if ! docker info >/dev/null 2>&1; then
    echo "    docker daemon not running; starting dockerd"
    [ "$(id -u)" = "0" ] || die "docker daemon is down and this is not root; start it and re-run"
    nohup dockerd >/tmp/dockerd.log 2>&1 &
    for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
    docker info >/dev/null 2>&1 || die "dockerd did not come up; see /tmp/dockerd.log"
  fi
  # Docker Hub rate-limits anonymous pulls and the 429 kills compose outright
  # (smko1 needed manual retries). Pull each image with backoff first; compose
  # then starts from the local cache.
  for img in $(grep -E '^\s*image:' "bench/thirdparty/${WITH_TARGET}/docker-compose.yml" | awk '{print $2}'); do
    docker image inspect "$img" >/dev/null 2>&1 && continue
    for i in 1 2 3 4 5 6; do
      docker pull "$img" >/dev/null 2>&1 && break
      echo "    pull of $img failed (attempt $i); backing off $((i*20))s"
      sleep $((i*20))
    done
    docker image inspect "$img" >/dev/null 2>&1 || die "could not pull $img (rate limit?)"
  done
  docker compose -f "bench/thirdparty/${WITH_TARGET}/docker-compose.yml" up -d
  case "$WITH_TARGET" in
    odoo)
      # Seed only when the bench DB is absent; the seed takes minutes.
      if curl -s --max-time 10 http://127.0.0.1:8069/web/database/list -X POST            -H 'content-type: application/json' -d '{}' | grep -q '"bench"'; then
        echo "    bench database already present"
      else
        bash bench/thirdparty/odoo/seed.sh
      fi
      for _ in $(seq 1 60); do
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8069/web/login || true)"
        [ "$code" = "200" ] && break; sleep 2
      done
      echo "    odoo login page: HTTP ${code:-unreachable}"
      ;;
    grafana)
      for _ in $(seq 1 45); do
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/login || true)"
        [ "$code" = "200" ] && break; sleep 2
      done
      echo "    grafana login page: HTTP ${code:-unreachable}"
      ;;
    kanboard)
      for _ in $(seq 1 45); do
        code="$(curl -sL -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8085/ || true)"
        [ "$code" = "200" ] && break; sleep 2
      done
      echo "    kanboard login page: HTTP ${code:-unreachable}"
      # The reset doubles as the idempotent seed (Bench Board + seed tasks).
      node bench/reset-app.mjs --target kanboard
      ;;
  esac
done

# ---------------------------------------------------------------- preflight

say "Preflight"

if [ -n "${NOVITA_API_KEY:-}" ]; then
  echo "    NOVITA_API_KEY is set"
  provider=novita
  host=api.novita.ai
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "    ANTHROPIC_API_KEY is set"
  provider=anthropic
  host=api.anthropic.com
else
  warn "no model API key set — export NOVITA_API_KEY or ANTHROPIC_API_KEY before running"
  provider=novita
  host=api.novita.ai
fi

# Restricted egress is a real failure mode here, not a hypothetical: two runs in
# HANDOFF.md died at turn 1 to a DNS failure and a refused request. Better to
# find out now than forty turns in.
if node -e "
  fetch('https://${host}', { method: 'HEAD', signal: AbortSignal.timeout(10000) })
    .then(() => process.exit(0))
    .catch((e) => { console.error('    ' + (e.cause?.code || e.message)); process.exit(1) })
" 2>&1; then
  echo "    ${host} is reachable"
else
  warn "cannot reach ${host} — the sandbox may block outbound network"
  warn "a run will die on its first model call if this is not fixed"
fi

# ---------------------------------------------------------------- app

if [ "$START_APP" = "1" ]; then
  say "Starting the target app on port ${PORT}"
  if node -e "
    fetch('http://127.0.0.1:${PORT}/', { signal: AbortSignal.timeout(2000) })
      .then(() => process.exit(0)).catch(() => process.exit(1))
  " 2>/dev/null; then
    echo "    something is already listening on ${PORT}; leaving it alone"
  else
    PORT="$PORT" nohup node bench/app/server.mjs >/tmp/repairdesk-${PORT}.log 2>&1 &
    for _ in $(seq 1 20); do
      node -e "
        fetch('http://127.0.0.1:${PORT}/', { signal: AbortSignal.timeout(1000) })
          .then(() => process.exit(0)).catch(() => process.exit(1))
      " 2>/dev/null && break
      sleep 0.5
    done
    node -e "
      fetch('http://127.0.0.1:${PORT}/', { signal: AbortSignal.timeout(2000) })
        .then(() => process.exit(0)).catch(() => process.exit(1))
    " 2>/dev/null || die "app did not come up; see /tmp/repairdesk-${PORT}.log"
    echo "    listening on http://127.0.0.1:${PORT} (log: /tmp/repairdesk-${PORT}.log)"
  fi
fi

# ---------------------------------------------------------------- self-test

say "Verifying the stack end to end"
# Proves the browser actually launches, which is the step most likely to be
# broken on a fresh box and the one whose failure is least obvious from the
# harness's own output.
if [ -n "${NOVITA_API_KEY:-}${ANTHROPIC_API_KEY:-}" ]; then
  if browser-pilot open "http://127.0.0.1:${PORT}/" --session cloud-setup-check >/dev/null 2>&1; then
    echo "    browser launched and reached the app"
    browser-pilot stop --session cloud-setup-check >/dev/null 2>&1 || true
  else
    warn "browser-pilot could not open the app — re-run its command to see why:"
    warn "  browser-pilot open http://127.0.0.1:${PORT}/ --session cloud-setup-check"
  fi

  # `open` proves the browser, not the model. browser-pilot's INNER agent picks
  # its provider from BROWSER_PILOT_PROVIDER, not from the harness's --provider,
  # and defaults to zhipu — so with only NOVITA_API_KEY set, every `do` call
  # dies instantly with "no API key" and the run turn-caps at 0/6 (c0822bp
  # attempt 1, 2026-08-22, the first cloud run). Check the resolved config the
  # way the harness will see it.
  inner_provider="${BROWSER_PILOT_PROVIDER:-${provider}}"
  inner_cfg="$(BROWSER_PILOT_PROVIDER="$inner_provider" browser-pilot config --session cloud-setup-check 2>/dev/null || true)"
  browser-pilot stop --session cloud-setup-check >/dev/null 2>&1 || true
  if printf '%s' "$inner_cfg" | grep -q '"apiKeySet": true'; then
    echo "    inner agent resolves provider ${inner_provider} with a key"
  else
    warn "browser-pilot's inner agent has NO usable key for provider ${inner_provider}"
    warn "every 'browser-pilot do' will fail instantly; see 'browser-pilot config'"
  fi
  if [ -z "${BROWSER_PILOT_PROVIDER:-}" ]; then
    warn "BROWSER_PILOT_PROVIDER is not exported; the harness does NOT set it for you:"
    warn "  export BROWSER_PILOT_PROVIDER=${provider}"
  fi
else
  warn "skipped: needs a model API key"
fi

# ---------------------------------------------------------------- next

runid="c$(date +%m%d%H%M)"
cat <<EOF

$(printf '\033[1m==> Ready\033[0m')

Run the browser-pilot arm. The export is REQUIRED: --provider configures the
orchestrator only, and browser-pilot's inner agent reads its own provider from
the environment (default zhipu, which has no key here):

  export BROWSER_PILOT_PROVIDER=${provider}
  node bench/harness.mjs \\
    --arm browser-pilot --target repairdesk \\
    --task bench/tasks/repairdesk-ticket-flow.md \\
    --provider ${provider} \\
    --runid ${runid} --out bench/results --reset

Then score it — this checks all six objectives against the app's own
mutation log, and fails if the run reported a price the app never computed:

  node bench/verify-repairdesk.mjs ${runid}
  node bench/score.mjs ${runid}

Notes:

  * --reset is not optional for a comparable run. It reloads the seed and
    clears the mutation log, which is what makes a run's recorded writes
    attributable to that run.
  * Parallel runs need one app each: /__reset is global to an app instance,
    so concurrent runs sharing one will reset each other mid-flight.

      PORT=4181 BENCH_APP_DATA_DIR=/tmp/rd-a node bench/app/server.mjs &
      APP_URL=http://127.0.0.1:4181/ node bench/harness.mjs ... --runid a

  * bench/results/ is gitignored. Copy results off the box before it dies,
    or they are gone.
EOF
