#!/usr/bin/env bash
set -Eeuo pipefail

MODE="${1:-}"
TARGET_SHA="${TARGET_SHA:-}"
REPOSITORY_URL="${REPOSITORY_URL:-}"
BASE_DIR="${MARKET_INTELLIGENCE_BASE_DIR:-/opt/investment-market-intelligence}"
RELEASE_DIR="$BASE_DIR/releases/$TARGET_SHA"
CURRENT_LINK="$BASE_DIR/current"
SERVICE_NAME="investment-market-intelligence.service"
RUN_USER="${MARKET_INTELLIGENCE_USER:-$(id -un)}"
PORT="${MARKET_INTELLIGENCE_PORT:-8791}"

fail() { echo "MARKET_INTELLIGENCE_ACTIVATION_ERROR:$1" >&2; exit 1; }
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "TARGET_SHA_REQUIRED"
[[ -n "$REPOSITORY_URL" ]] || fail "REPOSITORY_URL_REQUIRED"
id "$RUN_USER" >/dev/null 2>&1 || fail "SERVICE_USER_NOT_FOUND"
RUN_GROUP="$(id -gn "$RUN_USER")"

export LIVE_TRADING=false
export PRIVATE_API_ENABLED=false
export ORDER_AUTHORITY=false
export MARKET_INTELLIGENCE_EXECUTION_AUTHORITY=NONE

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
  command -v systemctl >/dev/null || fail "SYSTEMD_REQUIRED"
  command -v curl >/dev/null || fail "CURL_REQUIRED"
  [[ "$PORT" =~ ^[0-9]+$ ]] || fail "INVALID_PORT"
  [[ "$PORT" -ne 8790 ]] || fail "PORT_CONFLICT_WITH_SIGNAL_INTELLIGENCE_V3"
  printf '%s\n' \
    "preflight_ok=true" \
    "target_sha=$TARGET_SHA" \
    "service_user=$RUN_USER" \
    "port=$PORT" \
    "executionAuthority=NONE" \
    "liveTrading=false" \
    "privateApi=false" \
    "orderAuthority=false"
}

checkout_release() {
  privileged install -d -m 0755 -o "$RUN_USER" -g "$RUN_GROUP" "$BASE_DIR" "$BASE_DIR/releases"
  if [[ ! -d "$RELEASE_DIR/.git" ]]; then
    rm -rf "$RELEASE_DIR"
    git clone --filter=blob:none --no-checkout "$REPOSITORY_URL" "$RELEASE_DIR"
  fi
  git -C "$RELEASE_DIR" fetch --force origin "$TARGET_SHA"
  git -C "$RELEASE_DIR" checkout --detach --force "$TARGET_SHA"
  test "$(git -C "$RELEASE_DIR" rev-parse HEAD)" = "$TARGET_SHA" || fail "EXACT_SHA_CHECKOUT_FAILED"
  test -f "$RELEASE_DIR/market-intelligence-sidecar/src/engine.mjs" || fail "ENGINE_MISSING"
  test -f "$RELEASE_DIR/market-intelligence-sidecar/src/server.mjs" || fail "SERVER_MISSING"
  test -f "$RELEASE_DIR/market-intelligence-sidecar/scripts/verify-contract.mjs" || fail "CONTRACT_MISSING"
  (
    cd "$RELEASE_DIR/market-intelligence-sidecar"
    node --test tests/*.test.mjs
    node scripts/verify-contract.mjs
  )
}

install_service() {
  local unit_tmp
  unit_tmp="$(mktemp)"
  cat > "$unit_tmp" <<EOF
[Unit]
Description=Investment Market Intelligence Sidecar (read-only)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$CURRENT_LINK/market-intelligence-sidecar
Environment=NODE_ENV=production
Environment=MARKET_INTELLIGENCE_SERVICE_SHA=$TARGET_SHA
Environment=MARKET_INTELLIGENCE_HOST=127.0.0.1
Environment=MARKET_INTELLIGENCE_PORT=$PORT
Environment=LIVE_TRADING=false
Environment=PRIVATE_API_ENABLED=false
Environment=ORDER_AUTHORITY=false
Environment=MARKET_INTELLIGENCE_EXECUTION_AUTHORITY=NONE
ExecStart=/usr/bin/env node $CURRENT_LINK/market-intelligence-sidecar/src/server.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF
  privileged install -m 0644 "$unit_tmp" "/etc/systemd/system/$SERVICE_NAME"
  rm -f "$unit_tmp"
  ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
  privileged systemctl daemon-reload
  privileged systemctl enable --now "$SERVICE_NAME"
  sleep 2
  privileged systemctl is-active --quiet "$SERVICE_NAME" || fail "SERVICE_NOT_ACTIVE"

  local health="$BASE_DIR/health.json"
  curl --fail --silent --show-error "http://127.0.0.1:$PORT/health" > "$health"
  node -e "const fs=require('fs');const h=JSON.parse(fs.readFileSync(process.argv[1]));if(h.ok!==true||h.serviceSha!==process.argv[2]||h.bindHost!=='127.0.0.1'||h.port!==Number(process.argv[3])||h.safety?.executionAuthority!=='NONE'||h.safety?.privateTradingApiAllowed!==false||h.safety?.realOrderAllowed!==false)process.exit(1)" "$health" "$TARGET_SHA" "$PORT"
}

case "$MODE" in
  preflight) preflight ;;
  activate)
    preflight
    checkout_release
    install_service
    printf '%s\n' \
      "activated=true" \
      "service_sha=$TARGET_SHA" \
      "service=$SERVICE_NAME" \
      "bind=127.0.0.1:$PORT" \
      "executionAuthority=NONE"
    ;;
  *) fail "MODE_MUST_BE_PREFLIGHT_OR_ACTIVATE" ;;
esac
