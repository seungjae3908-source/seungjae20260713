#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

STATE_ROOT="${PUMP_PROSPECTIVE_STATE_ROOT:-/opt/stock-app-data/pump-reversal-v1}"
TAG="# stock-app-pump-reversal-v1"
[[ "$STATE_ROOT" == /opt/stock-app-data/pump-reversal-v1 ]] || {
  echo '[pump-paper-disable] unexpected state root' >&2
  exit 2
}
mkdir -p "$STATE_ROOT"
PREVIOUS="$(crontab -l 2>/dev/null || true)"
FILTERED="$(printf '%s\n' "$PREVIOUS" | grep -vF "$TAG" || true)"
printf '%s\n' "$FILTERED" | sed '/^[[:space:]]*$/d' | crontab -
: > "$STATE_ROOT/DISABLED"
chmod 600 "$STATE_ROOT/DISABLED"
MATCHES="$(crontab -l 2>/dev/null | grep -Fc "$TAG" || true)"
[[ "$MATCHES" == 0 ]]
printf '{"status":"DISABLED","scheduleActive":false,"executionAuthority":"NONE","liveTrading":false,"realOrderCount":0}\n'
