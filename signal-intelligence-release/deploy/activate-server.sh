#!/usr/bin/env bash
set -Eeuo pipefail

MODE="${1:-}"
TARGET_SHA="${TARGET_SHA:-}"
REPOSITORY_URL="${REPOSITORY_URL:-}"
BASE_DIR="${SIGNAL_INTELLIGENCE_BASE_DIR:-/opt/investment-signal-intelligence}"
RELEASE_DIR="$BASE_DIR/releases/$TARGET_SHA"
CURRENT_LINK="$BASE_DIR/current"
STATE_DIR="$BASE_DIR/state"
STATE_FILE="$STATE_DIR/latest-snapshot.json"
BRIDGE_ENV_FILE="$STATE_DIR/bridge.env"
BRIDGE_STATE_FILE="$STATE_DIR/telegram-ai-bridge-state.json"
BRIDGE_STATUS_FILE="$STATE_DIR/telegram-ai-bridge-status.json"
SERVICE_NAME="investment-signal-intelligence-v3.service"
CYCLE_SERVICE="investment-signal-intelligence-v3-cycle.service"
CYCLE_TIMER="investment-signal-intelligence-v3-cycle.timer"
BRIDGE_SERVICE="investment-signal-intelligence-v3-bridge.service"
SOURCE_PM2_NAME="${SIGNAL_INTELLIGENCE_SOURCE_PM2_NAME:-stock-app}"
RUN_USER="${SIGNAL_INTELLIGENCE_USER:-$(id -un)}"

fail() { echo "SIGNAL_INTELLIGENCE_ACTIVATION_ERROR:$1" >&2; exit 1; }
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "TARGET_SHA_REQUIRED"
[[ -n "$REPOSITORY_URL" ]] || fail "REPOSITORY_URL_REQUIRED"
id "$RUN_USER" >/dev/null 2>&1 || fail "SERVICE_USER_NOT_FOUND"
RUN_GROUP="$(id -gn "$RUN_USER")"

export LIVE_TRADING=false
export PRIVATE_API_ENABLED=false
export ORDER_AUTHORITY=false
export SIGNAL_INTELLIGENCE_EXECUTION_AUTHORITY=NONE
export SIGNAL_INTELLIGENCE_PUBLIC_ONLY_UNIVERSE=true

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
else
  command -v sudo >/dev/null || fail "SUDO_REQUIRED"
  sudo -n true >/dev/null 2>&1 || fail "PASSWORDLESS_SUDO_REQUIRED"
  SUDO=(sudo -n)
fi

privileged() { "${SUDO[@]}" "$@"; }

preflight() {
  command -v git >/dev/null || fail "GIT_REQUIRED"
  command -v node >/dev/null || fail "NODE_REQUIRED"
  command -v corepack >/dev/null || fail "COREPACK_REQUIRED"
  command -v systemctl >/dev/null || fail "SYSTEMD_REQUIRED"
  command -v curl >/dev/null || fail "CURL_REQUIRED"
  printf '%s\n' \
    "preflight_ok=true" \
    "target_sha=$TARGET_SHA" \
    "service_user=$RUN_USER" \
    "executionAuthority=NONE" \
    "publicOnlyUniverse=true" \
    "liveTrading=false" \
    "privateApi=false" \
    "orderAuthority=false"
}

prepare_directories() {
  privileged install -d -m 0755 -o "$RUN_USER" -g "$RUN_GROUP" "$BASE_DIR"
  privileged install -d -m 0755 -o "$RUN_USER" -g "$RUN_GROUP" "$BASE_DIR/releases"
  privileged install -d -m 0750 -o "$RUN_USER" -g "$RUN_GROUP" "$STATE_DIR"
}

checkout_release() {
  prepare_directories
  if [[ ! -d "$RELEASE_DIR/.git" ]]; then
    rm -rf "$RELEASE_DIR"
    git clone --filter=blob:none --no-checkout "$REPOSITORY_URL" "$RELEASE_DIR"
  fi
  git -C "$RELEASE_DIR" fetch --force origin "$TARGET_SHA"
  git -C "$RELEASE_DIR" checkout --detach --force "$TARGET_SHA"
  test "$(git -C "$RELEASE_DIR" rev-parse HEAD)" = "$TARGET_SHA" || fail "EXACT_SHA_CHECKOUT_FAILED"
  test -f "$RELEASE_DIR/signal-intelligence-v3/src/engine.mjs" || fail "V3_ENGINE_MISSING"
  test -f "$RELEASE_DIR/signal-intelligence-v3/src/server.mjs" || fail "V3_SERVER_MISSING"
  test -f "$RELEASE_DIR/signal-intelligence-v3/scripts/run-public-scanner-cycle.ts" || fail "V3_PUBLIC_CYCLE_MISSING"
  test -f "$RELEASE_DIR/signal-intelligence-v3/scripts/verify-contract.mjs" || fail "V3_CONTRACT_MISSING"
  (
    cd "$RELEASE_DIR"
    node --test signal-intelligence-v3/tests/*.test.mjs
    node signal-intelligence-v3/scripts/verify-contract.mjs
  )
}

build_runtime() {
  (
    cd "$RELEASE_DIR"
    corepack pnpm install --frozen-lockfile --filter '@workspace/api-server...'
    install -d -m 0755 api-server/.signal-intelligence
    corepack pnpm --dir api-server exec esbuild ../signal-intelligence-v3/scripts/run-public-scanner-cycle.ts \
      --bundle \
      --platform=node \
      --format=esm \
      --target=node20 \
      --packages=external \
      --outfile=./.signal-intelligence/public-cycle.mjs
    node --check api-server/.signal-intelligence/public-cycle.mjs

    if [[ -f signal-intelligence-v3/scripts/run-standalone-telegram-ai-bridge.ts ]]; then
      corepack pnpm --dir api-server exec esbuild ../signal-intelligence-v3/scripts/run-standalone-telegram-ai-bridge.ts \
        --bundle \
        --platform=node \
        --format=esm \
        --target=node20 \
        --packages=external \
        --outfile=./.signal-intelligence/telegram-ai-bridge.mjs
      node --check api-server/.signal-intelligence/telegram-ai-bridge.mjs
    fi
  )
}

run_initial_cycle() {
  (
    cd "$RELEASE_DIR/api-server"
    SIGNAL_INTELLIGENCE_SERVICE_SHA="$TARGET_SHA" \
    SIGNAL_INTELLIGENCE_STATE_DIR="$STATE_DIR" \
    SIGNAL_INTELLIGENCE_STATE_FILE="$STATE_FILE" \
    SIGNAL_INTELLIGENCE_PUBLIC_ONLY_UNIVERSE=true \
    LIVE_TRADING=false \
    PRIVATE_API_ENABLED=false \
    ORDER_AUTHORITY=false \
    SIGNAL_INTELLIGENCE_EXECUTION_AUTHORITY=NONE \
      node .signal-intelligence/public-cycle.mjs
  )
  test -s "$STATE_FILE" || fail "INITIAL_SNAPSHOT_MISSING"
}

prepare_bridge_env() {
  [[ -f "$RELEASE_DIR/api-server/.signal-intelligence/telegram-ai-bridge.mjs" ]] || return 0
  command -v pm2 >/dev/null || fail "PM2_REQUIRED_FOR_BRIDGE_ENV"
  local pm2_json temporary
  pm2_json="$(mktemp)"
  temporary="$(mktemp)"
  pm2 jlist > "$pm2_json"
  node - "$pm2_json" "$SOURCE_PM2_NAME" "$temporary" <<'NODE'
const fs = require('fs');
const [input, processName, output] = process.argv.slice(2);
const processes = JSON.parse(fs.readFileSync(input, 'utf8'));
const selected = processes.find((item) => item.name === processName);
const env = selected?.pm2_env;
if (!env || env.status !== 'online') throw new Error('SOURCE_PM2_ENV_NOT_AVAILABLE');
const allow = [
  'TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','TELEGRAM_STOCK_CHAT_ID','TELEGRAM_CRYPTO_CHAT_ID',
  'AI_CHAT_PROVIDER','AI_CHAT_API_KEY','AI_CHAT_MODEL','GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_GENAI_MODEL','GEMINI_MODEL',
  'GROQ_API_KEY','GROQ_MODEL',
];
const lines = [];
for (const key of allow) {
  const value = env[key];
  if (value === null || value === undefined || String(value).trim() === '') continue;
  lines.push(`${key}=${JSON.stringify(String(value))}`);
}
fs.writeFileSync(output, `${lines.join('\n')}\n`, { mode: 0o600 });
NODE
  rm -f "$pm2_json"
  node - "$temporary" <<'NODE'
const fs = require('fs');
const text = fs.readFileSync(process.argv[2], 'utf8');
const has = (key) => new RegExp(`^${key}=`, 'm').test(text);
const telegram = has('TELEGRAM_BOT_TOKEN') && (has('TELEGRAM_CHAT_ID') || has('TELEGRAM_STOCK_CHAT_ID') || has('TELEGRAM_CRYPTO_CHAT_ID'));
const ai = has('GEMINI_API_KEY') || has('GOOGLE_API_KEY') || has('GROQ_API_KEY') || has('AI_CHAT_API_KEY');
if (!telegram) process.exit(2);
if (!ai) process.exit(3);
NODE
  case "$?" in
    0) ;;
    2) rm -f "$temporary"; fail "TELEGRAM_BRIDGE_ENV_NOT_CONFIGURED" ;;
    3) rm -f "$temporary"; fail "AI_BRIDGE_ENV_NOT_CONFIGURED" ;;
    *) rm -f "$temporary"; fail "BRIDGE_ENV_VALIDATION_FAILED" ;;
  esac
  privileged install -m 0600 -o "$RUN_USER" -g "$RUN_GROUP" "$temporary" "$BRIDGE_ENV_FILE"
  rm -f "$temporary"
}

write_unit() {
  local destination="$1"
  local temporary="$2"
  privileged install -m 0644 "$temporary" "$destination"
  rm -f "$temporary"
}

install_units() {
  local server_tmp cycle_tmp timer_tmp bridge_tmp
  server_tmp="$(mktemp)"
  cycle_tmp="$(mktemp)"
  timer_tmp="$(mktemp)"
  bridge_tmp="$(mktemp)"

  cat > "$server_tmp" <<EOF
[Unit]
Description=Investment Signal Intelligence V3 (public/recommendation only)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$CURRENT_LINK/signal-intelligence-v3
Environment=NODE_ENV=production
Environment=SIGNAL_INTELLIGENCE_SERVICE_SHA=$TARGET_SHA
Environment=SIGNAL_INTELLIGENCE_HOST=127.0.0.1
Environment=SIGNAL_INTELLIGENCE_PORT=8790
Environment=SIGNAL_INTELLIGENCE_STATE_FILE=$STATE_FILE
Environment=SIGNAL_INTELLIGENCE_PRODUCER_PATH=$CURRENT_LINK/api-server/.signal-intelligence/public-cycle.mjs
Environment=SIGNAL_INTELLIGENCE_PUBLIC_ONLY_UNIVERSE=true
Environment=LIVE_TRADING=false
Environment=PRIVATE_API_ENABLED=false
Environment=ORDER_AUTHORITY=false
Environment=SIGNAL_INTELLIGENCE_EXECUTION_AUTHORITY=NONE
ExecStart=/usr/bin/env node $CURRENT_LINK/signal-intelligence-v3/src/server.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$BASE_DIR

[Install]
WantedBy=multi-user.target
EOF

  cat > "$cycle_tmp" <<EOF
[Unit]
Description=Investment Signal Intelligence V3 rolling public Scanner cycle
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$CURRENT_LINK/api-server
Environment=NODE_ENV=production
Environment=SIGNAL_INTELLIGENCE_SERVICE_SHA=$TARGET_SHA
Environment=SIGNAL_INTELLIGENCE_STATE_DIR=$STATE_DIR
Environment=SIGNAL_INTELLIGENCE_STATE_FILE=$STATE_FILE
Environment=SIGNAL_INTELLIGENCE_PUBLIC_ONLY_UNIVERSE=true
Environment=LIVE_TRADING=false
Environment=PRIVATE_API_ENABLED=false
Environment=ORDER_AUTHORITY=false
Environment=SIGNAL_INTELLIGENCE_EXECUTION_AUTHORITY=NONE
ExecStart=/usr/bin/env node $CURRENT_LINK/api-server/.signal-intelligence/public-cycle.mjs
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$BASE_DIR
EOF

  cat > "$timer_tmp" <<EOF
[Unit]
Description=Run Signal Intelligence V3 public Scanner every five minutes

[Timer]
OnBootSec=30s
OnUnitActiveSec=5min
AccuracySec=15s
Persistent=true
Unit=$CYCLE_SERVICE

[Install]
WantedBy=timers.target
EOF

  write_unit "/etc/systemd/system/$SERVICE_NAME" "$server_tmp"
  write_unit "/etc/systemd/system/$CYCLE_SERVICE" "$cycle_tmp"
  write_unit "/etc/systemd/system/$CYCLE_TIMER" "$timer_tmp"

  if [[ -f "$RELEASE_DIR/api-server/.signal-intelligence/telegram-ai-bridge.mjs" ]]; then
    cat > "$bridge_tmp" <<EOF
[Unit]
Description=Investment Signal Intelligence V3 Telegram + AI public bridge
After=network-online.target $SERVICE_NAME
Wants=network-online.target
Requires=$SERVICE_NAME

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$CURRENT_LINK/api-server
EnvironmentFile=$BRIDGE_ENV_FILE
Environment=NODE_ENV=production
Environment=SIGNAL_INTELLIGENCE_URL=http://127.0.0.1:8790/v1/signals
Environment=SIGNAL_INTELLIGENCE_BRIDGE_STATE_PATH=$BRIDGE_STATE_FILE
Environment=SIGNAL_INTELLIGENCE_BRIDGE_STATUS_PATH=$BRIDGE_STATUS_FILE
Environment=SIGNAL_INTELLIGENCE_BRIDGE_STARTUP_VERIFY=true
Environment=LIVE_TELEGRAM_ACTIVATION_APPROVED=true
Environment=LIVE_TRADING=false
Environment=PRIVATE_API_ENABLED=false
Environment=ORDER_AUTHORITY=false
Environment=SIGNAL_INTELLIGENCE_EXECUTION_AUTHORITY=NONE
ExecStart=/usr/bin/env node $CURRENT_LINK/api-server/.signal-intelligence/telegram-ai-bridge.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$BASE_DIR

[Install]
WantedBy=multi-user.target
EOF
    write_unit "/etc/systemd/system/$BRIDGE_SERVICE" "$bridge_tmp"
  else
    rm -f "$bridge_tmp"
  fi

  ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
  privileged systemctl daemon-reload
  privileged systemctl enable --now "$SERVICE_NAME"
  privileged systemctl enable --now "$CYCLE_TIMER"
  if [[ -f "$RELEASE_DIR/api-server/.signal-intelligence/telegram-ai-bridge.mjs" ]]; then
    privileged systemctl enable --now "$BRIDGE_SERVICE"
  elif systemctl list-unit-files "$BRIDGE_SERVICE" >/dev/null 2>&1; then
    privileged systemctl disable --now "$BRIDGE_SERVICE" >/dev/null 2>&1 || true
  fi
  sleep 1
  privileged systemctl is-active --quiet "$SERVICE_NAME" || fail "SERVICE_NOT_ACTIVE"
  privileged systemctl is-active --quiet "$CYCLE_TIMER" || fail "CYCLE_TIMER_NOT_ACTIVE"
  if [[ -f "$RELEASE_DIR/api-server/.signal-intelligence/telegram-ai-bridge.mjs" ]]; then
    privileged systemctl is-active --quiet "$BRIDGE_SERVICE" || fail "BRIDGE_SERVICE_NOT_ACTIVE"
  fi

  curl --fail --silent --show-error http://127.0.0.1:8790/health > "$BASE_DIR/health.json"
  node -e "const fs=require('fs');const h=JSON.parse(fs.readFileSync(process.argv[1]));if(h.ok!==true||h.executionAuthority!=='NONE'||h.privateTradingApiAllowed!==false||h.realOrderAllowed!==false||h.serviceSha!==process.argv[2]||h.bindHost!=='127.0.0.1'||h.snapshotReady!==true)process.exit(1)" "$BASE_DIR/health.json" "$TARGET_SHA"

  if [[ -f "$RELEASE_DIR/api-server/.signal-intelligence/telegram-ai-bridge.mjs" ]]; then
    local bridge_ready=0
    for _ in $(seq 1 30); do
      if [[ -s "$BRIDGE_STATUS_FILE" ]] && node - "$BRIDGE_STATUS_FILE" "$TARGET_SHA" <<'NODE'
const fs = require('fs');
const [file, expectedSha] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(file, 'utf8'));
if (p.serviceSha !== expectedSha || p.signalReachable !== true || p.telegramConfigured !== true || p.aiConfigured !== true
  || p.executionAuthority !== 'NONE' || p.privateTradingApiAllowed !== false || p.realOrderAllowed !== false || p.error !== null) process.exit(1);
NODE
      then bridge_ready=1; break; fi
      sleep 3
    done
    [[ "$bridge_ready" == "1" ]] || fail "BRIDGE_HEALTH_NOT_READY"
    node - "$BRIDGE_STATE_FILE" "$TARGET_SHA" <<'NODE'
const fs = require('fs');
const [file, expectedSha] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(file, 'utf8'));
if (p?.version !== 1 || !p?.startupVerified?.[expectedSha]) process.exit(1);
NODE
  fi
}

case "$MODE" in
  preflight) preflight ;;
  activate)
    preflight
    checkout_release
    build_runtime
    run_initial_cycle
    prepare_bridge_env
    install_units
    printf '%s\n' \
      "activated=true" \
      "service_sha=$TARGET_SHA" \
      "state_file=$STATE_FILE" \
      "cycle_timer=$CYCLE_TIMER" \
      "bridge_service=$BRIDGE_SERVICE" \
      "executionAuthority=NONE"
    ;;
  *) fail "MODE_MUST_BE_PREFLIGHT_OR_ACTIVATE" ;;
esac
