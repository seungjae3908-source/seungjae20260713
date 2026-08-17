#!/usr/bin/env bash
set -Eeuo pipefail

MODE="${1:-}"
TARGET_SHA="${TARGET_SHA:-}"
REPOSITORY_URL="${REPOSITORY_URL:-}"
BASE_DIR="${SIGNAL_INTELLIGENCE_BASE_DIR:-/opt/investment-signal-intelligence}"
RELEASE_DIR="$BASE_DIR/releases/$TARGET_SHA"
CURRENT_LINK="$BASE_DIR/current"
SERVICE_NAME="investment-signal-intelligence-v3.service"

fail() { echo "SIGNAL_INTELLIGENCE_ACTIVATION_ERROR:$1" >&2; exit 1; }
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "TARGET_SHA_REQUIRED"
[[ -n "$REPOSITORY_URL" ]] || fail "REPOSITORY_URL_REQUIRED"

# Hard safety invariants for this release class.
export LIVE_TRADING=false
export PRIVATE_API_ENABLED=false
export ORDER_AUTHORITY=false
export SIGNAL_INTELLIGENCE_EXECUTION_AUTHORITY=NONE

preflight() {
  command -v git >/dev/null || fail "GIT_REQUIRED"
  command -v node >/dev/null || fail "NODE_REQUIRED"
  command -v systemctl >/dev/null || fail "SYSTEMD_REQUIRED"
  printf '%s\n' "preflight_ok=true" "target_sha=$TARGET_SHA" "executionAuthority=NONE" "liveTrading=false" "privateApi=false" "orderAuthority=false"
}

checkout_release() {
  install -d -m 0755 "$BASE_DIR/releases"
  if [[ ! -d "$RELEASE_DIR/.git" ]]; then
    rm -rf "$RELEASE_DIR"
    git clone --filter=blob:none --no-checkout "$REPOSITORY_URL" "$RELEASE_DIR"
  fi
  git -C "$RELEASE_DIR" fetch --force origin "$TARGET_SHA"
  git -C "$RELEASE_DIR" checkout --detach --force "$TARGET_SHA"
  test "$(git -C "$RELEASE_DIR" rev-parse HEAD)" = "$TARGET_SHA" || fail "EXACT_SHA_CHECKOUT_FAILED"
  test -f "$RELEASE_DIR/signal-intelligence-v3/src/engine.mjs" || fail "V3_ENGINE_MISSING"
  test -f "$RELEASE_DIR/signal-intelligence-v3/scripts/verify-contract.mjs" || fail "V3_CONTRACT_MISSING"
  node --test "$RELEASE_DIR"/signal-intelligence-v3/tests/*.test.mjs
  node "$RELEASE_DIR/signal-intelligence-v3/scripts/verify-contract.mjs"
}

install_service() {
  test -f "$RELEASE_DIR/signal-intelligence-v3/src/server.mjs" || fail "V3_SERVER_MISSING"
  cat > "/etc/systemd/system/$SERVICE_NAME" <<EOF
[Unit]
Description=Investment Signal Intelligence V3 (public/recommendation only)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SIGNAL_INTELLIGENCE_USER:-root}
WorkingDirectory=$CURRENT_LINK/signal-intelligence-v3
Environment=NODE_ENV=production
Environment=SIGNAL_INTELLIGENCE_HOST=127.0.0.1
Environment=SIGNAL_INTELLIGENCE_PORT=8790
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
  ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME"
  sleep 1
  systemctl is-active --quiet "$SERVICE_NAME" || fail "SERVICE_NOT_ACTIVE"
  curl --fail --silent --show-error http://127.0.0.1:8790/health > "$BASE_DIR/health.json"
  node -e "const fs=require('fs');const h=JSON.parse(fs.readFileSync(process.argv[1]));if(h.ok!==true||h.executionAuthority!=='NONE'||h.privateTradingApiAllowed!==false||h.realOrderAllowed!==false||h.serviceSha!==process.argv[2])process.exit(1)" "$BASE_DIR/health.json" "$TARGET_SHA"
}

case "$MODE" in
  preflight) preflight ;;
  activate)
    preflight
    checkout_release
    install_service
    printf '%s\n' "activated=true" "service_sha=$TARGET_SHA" "executionAuthority=NONE"
    ;;
  *) fail "MODE_MUST_BE_PREFLIGHT_OR_ACTIVATE" ;;
esac
