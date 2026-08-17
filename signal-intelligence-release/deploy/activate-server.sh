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
SERVICE_NAME="investment-signal-intelligence-v3.service"
RUN_USER="${SIGNAL_INTELLIGENCE_USER:-$(id -un)}"

fail() { echo "SIGNAL_INTELLIGENCE_ACTIVATION_ERROR:$1" >&2; exit 1; }
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "TARGET_SHA_REQUIRED"
[[ -n "$REPOSITORY_URL" ]] || fail "REPOSITORY_URL_REQUIRED"
id "$RUN_USER" >/dev/null 2>&1 || fail "SERVICE_USER_NOT_FOUND"
RUN_GROUP="$(id -gn "$RUN_USER")"

# Hard safety invariants for this release class.
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

privileged() {
  "${SUDO[@]}" "$@"
}

preflight() {
  command -v git >/dev/null || fail "GIT_REQUIRED"
  command -v node >/dev/null || fail "NODE_REQUIRED"
  command -v systemctl >/dev/null || fail "SYSTEMD_REQUIRED"
  command -v curl >/dev/null || fail "CURL_REQUIRED"
  printf '%s\n' \
    "preflight_ok=true" \
    "target_sha=$TARGET_SHA" \
    "service_user=$RUN_USER" \
    "executionAuthority=NONE" \
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
  test -f "$RELEASE_DIR/signal-intelligence-v3/scripts/verify-contract.mjs" || fail "V3_CONTRACT_MISSING"
  node --test "$RELEASE_DIR"/signal-intelligence-v3/tests/*.test.mjs
  node "$RELEASE_DIR/signal-intelligence-v3/scripts/verify-contract.mjs"
}

install_service() {
  local unit_tmp
  unit_tmp="$(mktemp)"
  cat > "$unit_tmp" <<EOF
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
  privileged install -m 0644 "$unit_tmp" "/etc/systemd/system/$SERVICE_NAME"
  rm -f "$unit_tmp"

  ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
  privileged systemctl daemon-reload
  privileged systemctl enable --now "$SERVICE_NAME"
  sleep 1
  privileged systemctl is-active --quiet "$SERVICE_NAME" || fail "SERVICE_NOT_ACTIVE"
  curl --fail --silent --show-error http://127.0.0.1:8790/health > "$BASE_DIR/health.json"
  node -e "const fs=require('fs');const h=JSON.parse(fs.readFileSync(process.argv[1]));if(h.ok!==true||h.executionAuthority!=='NONE'||h.privateTradingApiAllowed!==false||h.realOrderAllowed!==false||h.serviceSha!==process.argv[2]||h.bindHost!=='127.0.0.1')process.exit(1)" "$BASE_DIR/health.json" "$TARGET_SHA"
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
      "state_file=$STATE_FILE" \
      "executionAuthority=NONE"
    ;;
  *) fail "MODE_MUST_BE_PREFLIGHT_OR_ACTIVATE" ;;
esac
