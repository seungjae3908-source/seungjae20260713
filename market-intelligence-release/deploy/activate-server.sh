#!/usr/bin/env bash
set -Eeuo pipefail

MODE="${1:-}"
TARGET_SHA="${TARGET_SHA:-}"
REPOSITORY_URL="${REPOSITORY_URL:-}"
BASE_DIR="${MARKET_INTELLIGENCE_BASE_DIR:-/opt/investment-market-intelligence}"
RELEASE_DIR="$BASE_DIR/releases/$TARGET_SHA"
CURRENT_LINK="$BASE_DIR/current"
SERVICE_NAME="investment-market-intelligence.service"
UNIT_PATH="/etc/systemd/system/$SERVICE_NAME"
RUN_USER="${MARKET_INTELLIGENCE_USER:-$(id -un)}"
PORT="${MARKET_INTELLIGENCE_PORT:-8791}"

fail() { echo "MARKET_INTELLIGENCE_ACTIVATION_ERROR:$1" >&2; exit 1; }
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "TARGET_SHA_REQUIRED"
[[ -n "$REPOSITORY_URL" ]] || fail "REPOSITORY_URL_REQUIRED"
id "$RUN_USER" >/dev/null 2>&1 || fail "SERVICE_USER_NOT_FOUND"
RUN_GROUP="$(id -gn "$RUN_USER")"

resolve_node_bin() {
  local candidate resolved
  for candidate in \
    "${MARKET_INTELLIGENCE_NODE_BIN:-}" \
    /usr/bin/node \
    /usr/local/bin/node \
    "$(command -v node 2>/dev/null || true)"; do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    resolved="$(readlink -f "$candidate" 2>/dev/null || printf '%s' "$candidate")"
    [[ -x "$resolved" ]] || continue
    printf '%s\n' "$resolved"
    return 0
  done
  return 1
}

NODE_BIN="$(resolve_node_bin || true)"

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
  [[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || fail "SYSTEMD_SAFE_NODE_REQUIRED"
  command -v systemctl >/dev/null || fail "SYSTEMD_REQUIRED"
  command -v curl >/dev/null || fail "CURL_REQUIRED"
  [[ "$PORT" =~ ^[0-9]+$ ]] || fail "INVALID_PORT"
  [[ "$PORT" -ne 8790 ]] || fail "PORT_CONFLICT_WITH_SIGNAL_INTELLIGENCE_V3"
  printf '%s\n' \
    "preflight_ok=true" \
    "target_sha=$TARGET_SHA" \
    "service_user=$RUN_USER" \
    "node_bin=$NODE_BIN" \
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
    "$NODE_BIN" --test tests/*.test.mjs
    "$NODE_BIN" scripts/verify-contract.mjs
  )
}

health_check() {
  local expected_sha="$1"
  local health_file="$BASE_DIR/health-${expected_sha}.json"
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$PORT/health" > "$health_file" || return 1
  "$NODE_BIN" -e "const fs=require('fs');const h=JSON.parse(fs.readFileSync(process.argv[1]));if(h.ok!==true||h.serviceSha!==process.argv[2]||h.bindHost!=='127.0.0.1'||h.port!==Number(process.argv[3])||h.safety?.executionAuthority!=='NONE'||h.safety?.privateTradingApiAllowed!==false||h.safety?.realOrderAllowed!==false||h.safety?.orderSubmissionAllowed!==false)process.exit(1)" "$health_file" "$expected_sha" "$PORT"
}

dump_service_diagnostics() {
  echo "service_diagnostics_begin=true" >&2
  privileged systemctl --no-pager --full status "$SERVICE_NAME" >&2 || true
  if command -v journalctl >/dev/null; then
    privileged journalctl --no-pager -u "$SERVICE_NAME" -n 80 >&2 || true
  fi
  echo "service_diagnostics_end=true" >&2
}

rollback_service() {
  local previous_target="$1"
  local previous_unit="$2"
  local previous_sha="$3"
  echo "rollback_attempted=true"

  if [[ -n "$previous_target" && -d "$previous_target" && -n "$previous_unit" && -s "$previous_unit" ]]; then
    ln -sfn "$previous_target" "$CURRENT_LINK"
    privileged install -m 0644 "$previous_unit" "$UNIT_PATH"
    privileged systemctl daemon-reload
    if privileged systemctl restart "$SERVICE_NAME" && privileged systemctl is-active --quiet "$SERVICE_NAME"; then
      if [[ "$previous_sha" =~ ^[0-9a-f]{40}$ ]] && health_check "$previous_sha"; then
        echo "rollback_restored_sha=$previous_sha"
        return 0
      fi
    fi
    echo "rollback_restore_failed=true" >&2
    return 1
  fi

  privileged systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
  privileged rm -f "$UNIT_PATH"
  privileged systemctl daemon-reload
  rm -f "$CURRENT_LINK"
  echo "rollback_restored_absent_state=true"
  return 0
}

install_service() {
  local unit_tmp previous_unit previous_target previous_sha
  unit_tmp="$(mktemp)"
  previous_unit="$(mktemp)"
  previous_target=""
  previous_sha=""
  trap 'rm -f "$unit_tmp" "$previous_unit"' RETURN

  if [[ -L "$CURRENT_LINK" ]]; then
    previous_target="$(readlink -f "$CURRENT_LINK" || true)"
  fi
  if privileged test -f "$UNIT_PATH"; then
    privileged cat "$UNIT_PATH" > "$previous_unit"
    previous_sha="$(sed -n 's/^Environment=MARKET_INTELLIGENCE_SERVICE_SHA=//p' "$previous_unit" | head -n 1)"
  else
    : > "$previous_unit"
  fi

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
ExecStart=$NODE_BIN $CURRENT_LINK/market-intelligence-sidecar/src/server.mjs
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

  privileged install -m 0644 "$unit_tmp" "$UNIT_PATH"
  ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
  privileged systemctl daemon-reload
  privileged systemctl enable "$SERVICE_NAME" >/dev/null

  if ! privileged systemctl restart "$SERVICE_NAME"; then
    dump_service_diagnostics
    rollback_service "$previous_target" "$previous_unit" "$previous_sha" || true
    fail "SERVICE_RESTART_FAILED"
  fi
  sleep 2
  if ! privileged systemctl is-active --quiet "$SERVICE_NAME"; then
    dump_service_diagnostics
    rollback_service "$previous_target" "$previous_unit" "$previous_sha" || true
    fail "SERVICE_NOT_ACTIVE"
  fi
  if ! health_check "$TARGET_SHA"; then
    dump_service_diagnostics
    rollback_service "$previous_target" "$previous_unit" "$previous_sha" || true
    fail "HEALTH_CHECK_FAILED_AND_ROLLED_BACK"
  fi
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
      "node_bin=$NODE_BIN" \
      "bind=127.0.0.1:$PORT" \
      "executionAuthority=NONE" \
      "rollback_ready=true"
    ;;
  *) fail "MODE_MUST_BE_PREFLIGHT_OR_ACTIVATE" ;;
esac
