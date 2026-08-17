#!/usr/bin/env bash
set -Eeuo pipefail

MODE="${1:-}"
TARGET_SHA="${TARGET_SHA:-}"
BASE_DIR="${SIGNAL_INTELLIGENCE_BASE_DIR:-/opt/investment-signal-intelligence}"
RELEASE_DIR="$BASE_DIR/releases/$TARGET_SHA"
CURRENT_LINK="$BASE_DIR/current"
STATE_DIR="$BASE_DIR/state"
BRIDGE_ENV_FILE="$STATE_DIR/bridge.env"
BRIDGE_STATE_FILE="$STATE_DIR/telegram-ai-bridge-state.json"
BRIDGE_STATUS_FILE="$STATE_DIR/telegram-ai-bridge-status.json"
BRIDGE_SERVICE="investment-signal-intelligence-v3-bridge.service"
SIGNAL_SERVICE="investment-signal-intelligence-v3.service"
CYCLE_TIMER="investment-signal-intelligence-v3-cycle.timer"
RUN_USER="${SIGNAL_INTELLIGENCE_USER:-$(id -un)}"

fail() { echo "SIGNAL_INTELLIGENCE_BRIDGE_ACTIVATION_ERROR:$1" >&2; exit 1; }
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "TARGET_SHA_REQUIRED"
id "$RUN_USER" >/dev/null 2>&1 || fail "SERVICE_USER_NOT_FOUND"
RUN_GROUP="$(id -gn "$RUN_USER")"

export LIVE_TRADING=false
export PRIVATE_API_ENABLED=false
export ORDER_AUTHORITY=false
export SIGNAL_INTELLIGENCE_EXECUTION_AUTHORITY=NONE

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
  command -v pm2 >/dev/null || fail "PM2_REQUIRED"
  printf '%s\n' \
    "bridge_preflight_ok=true" \
    "target_sha=$TARGET_SHA" \
    "executionAuthority=NONE" \
    "liveTrading=false" \
    "privateApi=false" \
    "orderAuthority=false"
}

verify_active_release() {
  [[ -d "$RELEASE_DIR/.git" ]] || fail "TARGET_RELEASE_NOT_INSTALLED"
  [[ "$(git -C "$RELEASE_DIR" rev-parse HEAD)" == "$TARGET_SHA" ]] || fail "TARGET_RELEASE_SHA_MISMATCH"
  [[ -L "$CURRENT_LINK" ]] || fail "CURRENT_LINK_MISSING"
  [[ "$(readlink -f "$CURRENT_LINK")" == "$(readlink -f "$RELEASE_DIR")" ]] || fail "TARGET_RELEASE_NOT_CURRENT"
  [[ -f "$RELEASE_DIR/signal-intelligence-v3/scripts/run-standalone-telegram-ai-bridge.ts" ]] || fail "BRIDGE_SOURCE_MISSING"
  privileged systemctl is-active --quiet "$SIGNAL_SERVICE" || fail "SIGNAL_SERVICE_NOT_ACTIVE"
  privileged systemctl is-active --quiet "$CYCLE_TIMER" || fail "CYCLE_TIMER_NOT_ACTIVE"
  curl --fail --silent --show-error http://127.0.0.1:8790/health > "$BASE_DIR/bridge-signal-health.json"
  node - "$BASE_DIR/bridge-signal-health.json" "$TARGET_SHA" <<'NODE'
const fs = require('fs');
const [file, expectedSha] = process.argv.slice(2);
const h = JSON.parse(fs.readFileSync(file, 'utf8'));
if (h.ok !== true || h.serviceSha !== expectedSha || h.bindHost !== '127.0.0.1' || h.snapshotReady !== true
  || h.executionAuthority !== 'NONE' || h.privateTradingApiAllowed !== false || h.realOrderAllowed !== false) process.exit(1);
NODE
}

build_bridge() {
  (
    cd "$RELEASE_DIR"
    corepack pnpm install --frozen-lockfile --filter '@workspace/api-server...'
    install -d -m 0755 api-server/.signal-intelligence
    BANNER='import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'
    corepack pnpm --dir api-server exec esbuild ../signal-intelligence-v3/scripts/run-standalone-telegram-ai-bridge.ts \
      --bundle --platform=node --format=esm --target=node20 \
      --banner:js="$BANNER" \
      --outfile=./.signal-intelligence/telegram-ai-bridge.mjs
    node --check api-server/.signal-intelligence/telegram-ai-bridge.mjs
    ! grep -Ei '^import .*?(broker|trading|order|execution|exchange-connection|private)' signal-intelligence-v3/scripts/run-standalone-telegram-ai-bridge.ts
  )
}

prepare_bridge_env() {
  privileged install -d -m 0750 -o "$RUN_USER" -g "$RUN_GROUP" "$STATE_DIR"
  local pm2_json temporary
  pm2_json="$(mktemp)"
  temporary="$(mktemp)"
  pm2 jlist > "$pm2_json"
  node - "$pm2_json" "$temporary" <<'NODE'
const fs = require('fs');
const [input, output] = process.argv.slice(2);
const processes = JSON.parse(fs.readFileSync(input, 'utf8'));
const online = processes.filter((item) => item?.pm2_env?.status === 'online');
const explicit = String(process.env.SIGNAL_INTELLIGENCE_SOURCE_PM2_NAME || '').trim();
const selected = explicit
  ? online.find((item) => item.name === explicit)
  : online.find((item) => item.name === 'stock-app') || online.find((item) => /^stock-app(?:-|$)/.test(String(item.name || '')));
if (!selected?.pm2_env) throw new Error('SOURCE_PM2_ENV_NOT_AVAILABLE');
const env = selected.pm2_env;
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
const has = (key) => lines.some((line) => line.startsWith(`${key}=`));
const telegram = has('TELEGRAM_BOT_TOKEN') && (has('TELEGRAM_CHAT_ID') || has('TELEGRAM_STOCK_CHAT_ID') || has('TELEGRAM_CRYPTO_CHAT_ID'));
const ai = has('GEMINI_API_KEY') || has('GOOGLE_API_KEY') || has('GROQ_API_KEY') || has('AI_CHAT_API_KEY');
if (!telegram) throw new Error('TELEGRAM_BRIDGE_ENV_NOT_CONFIGURED');
if (!ai) throw new Error('AI_BRIDGE_ENV_NOT_CONFIGURED');
fs.writeFileSync(output, `${lines.join('\n')}\n`, { mode: 0o600 });
process.stdout.write(JSON.stringify({ sourceProcess: selected.name, telegramConfigured: true, aiConfigured: true }) + '\n');
NODE
  rm -f "$pm2_json"
  privileged install -m 0600 -o "$RUN_USER" -g "$RUN_GROUP" "$temporary" "$BRIDGE_ENV_FILE"
  rm -f "$temporary"
}

install_bridge_unit() {
  local temporary
  temporary="$(mktemp)"
  cat > "$temporary" <<EOF
[Unit]
Description=Investment Signal Intelligence V3 Telegram + AI public bridge
After=network-online.target $SIGNAL_SERVICE
Wants=network-online.target
Requires=$SIGNAL_SERVICE

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
  privileged install -m 0644 "$temporary" "/etc/systemd/system/$BRIDGE_SERVICE"
  rm -f "$temporary"
  privileged systemctl daemon-reload
  privileged systemctl enable --now "$BRIDGE_SERVICE"
  sleep 1
  privileged systemctl is-active --quiet "$BRIDGE_SERVICE" || fail "BRIDGE_SERVICE_NOT_ACTIVE"
}

verify_bridge_health() {
  local ready=0
  for _ in $(seq 1 40); do
    if [[ -s "$BRIDGE_STATUS_FILE" ]] && node - "$BRIDGE_STATUS_FILE" "$TARGET_SHA" <<'NODE'
const fs = require('fs');
const [file, expectedSha] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(file, 'utf8'));
const ai = p.ai || {};
const parsedAi = Number(ai.reviewed || 0) - Number(ai.unavailable || 0) - Number(ai.invalid || 0);
if (p.serviceSha !== expectedSha || p.signalReachable !== true || p.telegramConfigured !== true || p.aiConfigured !== true
  || p.executionAuthority !== 'NONE' || p.privateTradingApiAllowed !== false || p.realOrderAllowed !== false || p.error !== null
  || Number(ai.reviewed || 0) < 1 || parsedAi < 1) process.exit(1);
NODE
    then ready=1; break; fi
    sleep 3
  done
  [[ "$ready" == "1" ]] || fail "BRIDGE_HEALTH_NOT_READY"
  [[ -s "$BRIDGE_STATE_FILE" ]] || fail "BRIDGE_STATE_MISSING"
  node - "$BRIDGE_STATE_FILE" "$TARGET_SHA" <<'NODE'
const fs = require('fs');
const [file, expectedSha] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(file, 'utf8'));
if (p?.version !== 1 || !p?.startupVerified?.[expectedSha]) process.exit(1);
NODE
}

case "$MODE" in
  preflight)
    preflight
    ;;
  activate)
    preflight
    verify_active_release
    build_bridge
    prepare_bridge_env
    install_bridge_unit
    verify_bridge_health
    printf '%s\n' \
      "bridge_activated=true" \
      "service_sha=$TARGET_SHA" \
      "bridge_service=$BRIDGE_SERVICE" \
      "telegram_verified=true" \
      "ai_verified=true" \
      "executionAuthority=NONE"
    ;;
  *) fail "MODE_MUST_BE_PREFLIGHT_OR_ACTIVATE" ;;
esac
