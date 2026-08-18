#!/usr/bin/env bash
set -Eeuo pipefail

MODE="${1:-}"
TARGET_SHA="${TARGET_SHA:-}"
REPOSITORY_URL="${REPOSITORY_URL:-https://github.com/seungjae3908-source/seungjae20260713.git}"
ROOT=/opt/investment-research-dashboard
RELEASES="$ROOT/releases"
CURRENT="$ROOT/current"
STATE=/var/lib/investment-research-production
SERVICE=research-dashboard.service
PORT=18090

[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'TARGET_SHA must be an exact lowercase 40-character SHA' >&2
  exit 64
}

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
else
  SUDO=(sudo -n)
fi

require_tools() {
  for command_name in git python3 systemctl curl df awk readlink sed; do
    command -v "$command_name" >/dev/null 2>&1 || {
      echo "missing required command: $command_name" >&2
      exit 65
    }
  done
  if [[ "$(id -u)" -ne 0 ]]; then sudo -n true; fi
  python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' || {
    echo "Python >=3.10 required; found $(python3 --version 2>&1)" >&2
    exit 66
  }
}

read_app_sha() {
  if [[ -s /opt/stock-app/.deploy/current-sha ]]; then
    tr -d '[:space:]' < /opt/stock-app/.deploy/current-sha
  else
    printf 'absent'
  fi
}

read_research_current() {
  readlink -f /opt/investment-research/current 2>/dev/null || printf 'absent'
}

resource_check() {
  local free_bytes
  free_bytes="$(df -PB1 / | awk 'NR==2 {print $4}')"
  [[ "$free_bytes" =~ ^[0-9]+$ ]] || {
    echo 'unable to determine free disk bytes' >&2
    exit 67
  }
  (( free_bytes >= 1073741824 )) || {
    echo "Need at least 1 GiB free disk; have $free_bytes" >&2
    exit 68
  }
  printf 'FREE_BYTES=%s\n' "$free_bytes"
}

service_runner() {
  if command -v runuser >/dev/null 2>&1; then
    "${SUDO[@]}" runuser -u investment-research -- "$@"
  else
    "${SUDO[@]}" sudo -n -u investment-research "$@"
  fi
}

validate_service_python() {
  service_runner env -i \
    PATH=/usr/local/bin:/usr/bin:/bin \
    HOME=/nonexistent \
    LANG=C.UTF-8 \
    TZ=UTC \
    PYTHONDONTWRITEBYTECODE=1 \
    /usr/bin/env python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'
}

validate_state_access() {
  id investment-research >/dev/null 2>&1 || {
    echo 'investment-research user is missing; activate Research Production first' >&2
    exit 69
  }
  "${SUDO[@]}" test -d "$STATE" || {
    echo "research state root missing: $STATE" >&2
    exit 70
  }
  service_runner test -r "$STATE"
  validate_service_python
}

redact_dashboard_log() {
  sed -E \
    -e 's#https?://[^[:space:]"<>]+#<URL_REDACTED>#g' \
    -e 's#(authorization|apikey|api_key|token|secret|password)[=:][[:space:]]*(Bearer[[:space:]]+)?[^[:space:]]+#\1=<REDACTED>#Ig' \
    -e 's#([?&](token|apikey|api_key|key|secret|password)=)[^&[:space:]]+#\1<REDACTED>#Ig' \
    -e 's#eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}#<JWT_REDACTED>#g'
}

service_diagnostics() {
  printf '%s\n' 'RESEARCH_DASHBOARD_SERVICE_DIAGNOSTICS_BEGIN' >&2
  "${SUDO[@]}" systemctl show "$SERVICE" --no-pager \
    --property=ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,NRestarts,FragmentPath 2>&1 \
    | redact_dashboard_log >&2 || true
  if command -v journalctl >/dev/null 2>&1; then
    "${SUDO[@]}" journalctl -u "$SERVICE" -n 60 --no-pager -o cat 2>&1 \
      | redact_dashboard_log >&2 || true
  fi
  printf '%s\n' 'RESEARCH_DASHBOARD_SERVICE_DIAGNOSTICS_END' >&2
}

preflight() {
  require_tools
  resource_check
  validate_state_access
  printf '%s\n' \
    'RESEARCH_DASHBOARD_PREFLIGHT=PASS' \
    "TARGET_SHA=$TARGET_SHA" \
    "APP_SHA=$(read_app_sha)" \
    "RESEARCH_CURRENT=$(read_research_current)" \
    'SERVICE_PYTHON_RUNTIME=PASS' \
    'BIND_HOST=127.0.0.1' \
    "BIND_PORT=$PORT" \
    'LIVE_TRADING=false' \
    'PRIVATE_API=false' \
    'ORDER_AUTHORITY=false' \
    'CADDY_MUTATION=0' \
    'DATABASE_MUTATION=0' \
    'PRODUCTION_PM2_MUTATION=0'
}

verify_release() {
  local release="$1"
  [[ -d "$release" ]] || return 1
  "${SUDO[@]}" test -f "$release/research-dashboard/server.py" || return 1
  "${SUDO[@]}" test -f "$release/research-dashboard/deploy/research-dashboard.service" || return 1
  "${SUDO[@]}" test -f "$release/research-dashboard/public/index.html" || return 1
  local actual
  actual="$("${SUDO[@]}" git -C "$release" rev-parse HEAD 2>/dev/null || true)"
  [[ "$actual" == "$TARGET_SHA" ]]
}

probe_dashboard() {
  local health overview
  health="$(mktemp)"
  overview="$(mktemp)"
  trap 'rm -f "$health" "$overview"' RETURN
  local attempt ready=false
  for attempt in $(seq 1 20); do
    if curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:$PORT/api/health" -o "$health"; then
      ready=true
      break
    fi
    sleep 1
  done
  if [[ "$ready" != true || ! -s "$health" ]]; then
    echo 'Research Dashboard health endpoint did not become ready.' >&2
    service_diagnostics
    return 1
  fi
  if ! python3 - "$health" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as handle:
    value = json.load(handle)
if value.get('ok') is not True or value.get('service') != 'investment-research-dashboard':
    raise SystemExit(1)
if value.get('readOnly') is not True or value.get('liveTrading') is not False or value.get('privateApi') is not False or value.get('orderAuthority') is not False:
    raise SystemExit(1)
PY
  then
    echo 'Research Dashboard health contract validation failed.' >&2
    service_diagnostics
    return 1
  fi
  if ! curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$PORT/api/research/overview" -o "$overview"; then
    echo 'Research Dashboard overview endpoint request failed.' >&2
    service_diagnostics
    return 1
  fi
  if ! python3 - "$overview" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as handle:
    value = json.load(handle)
if value.get('schemaVersion') != 'research-dashboard-overview-v1':
    raise SystemExit(1)
safety = value.get('safety') or {}
if safety.get('readOnlyDashboard') is not True or safety.get('liveTrading') is not False or safety.get('privateApi') is not False or safety.get('orderAuthority') is not False:
    raise SystemExit(1)
if (value.get('profitability') or {}).get('proven') is not False:
    raise SystemExit(1)
PY
  then
    echo 'Research Dashboard overview contract validation failed.' >&2
    service_diagnostics
    return 1
  fi
  rm -f "$health" "$overview"
  trap - RETURN
}

activate() {
  require_tools
  resource_check
  validate_state_access

  local release="$RELEASES/$TARGET_SHA"
  local staged="$RELEASES/.staging-$TARGET_SHA-$$"
  local next_current="$ROOT/.current-$TARGET_SHA-$$"
  local app_before research_before current_before unit_backup service_was_active service_was_enabled
  app_before="$(read_app_sha)"
  research_before="$(read_research_current)"
  current_before="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  unit_backup="$(mktemp)"
  service_was_active=false
  service_was_enabled=false
  "${SUDO[@]}" systemctl is-active --quiet "$SERVICE" 2>/dev/null && service_was_active=true || true
  "${SUDO[@]}" systemctl is-enabled --quiet "$SERVICE" 2>/dev/null && service_was_enabled=true || true
  if "${SUDO[@]}" test -f "/etc/systemd/system/$SERVICE"; then
    "${SUDO[@]}" cat "/etc/systemd/system/$SERVICE" > "$unit_backup"
  else
    : > "$unit_backup"
  fi

  rollback() {
    local status=$?
    if (( status == 0 )); then
      rm -f "$unit_backup"
      "${SUDO[@]}" rm -rf -- "$staged" >/dev/null 2>&1 || true
      "${SUDO[@]}" rm -f -- "$next_current" >/dev/null 2>&1 || true
      return 0
    fi
    echo 'Research Dashboard activation failed; restoring isolated dashboard state only.' >&2
    "${SUDO[@]}" rm -rf -- "$staged" >/dev/null 2>&1 || true
    "${SUDO[@]}" rm -f -- "$next_current" >/dev/null 2>&1 || true
    if [[ -n "$current_before" ]]; then
      "${SUDO[@]}" ln -sfn -- "$current_before" "$CURRENT" || true
    else
      "${SUDO[@]}" rm -f -- "$CURRENT" || true
    fi
    if [[ -s "$unit_backup" ]]; then
      "${SUDO[@]}" install -o root -g root -m 0644 "$unit_backup" "/etc/systemd/system/$SERVICE" || true
    else
      "${SUDO[@]}" rm -f -- "/etc/systemd/system/$SERVICE" || true
    fi
    "${SUDO[@]}" systemctl daemon-reload >/dev/null 2>&1 || true
    if [[ "$service_was_active" == true ]]; then
      "${SUDO[@]}" systemctl restart "$SERVICE" >/dev/null 2>&1 || true
    else
      "${SUDO[@]}" systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
    fi
    if [[ "$service_was_enabled" == true ]]; then
      "${SUDO[@]}" systemctl enable "$SERVICE" >/dev/null 2>&1 || true
    fi
    rm -f "$unit_backup"
    return "$status"
  }
  trap rollback EXIT

  "${SUDO[@]}" install -d -o root -g root -m 0755 "$ROOT" "$RELEASES"
  if ! verify_release "$release"; then
    "${SUDO[@]}" rm -rf -- "$release" "$staged"
    "${SUDO[@]}" git clone --quiet --filter=blob:none --no-checkout "$REPOSITORY_URL" "$staged"
    "${SUDO[@]}" git -C "$staged" fetch --quiet --depth 1 origin "$TARGET_SHA"
    [[ "$("${SUDO[@]}" git -C "$staged" rev-parse FETCH_HEAD^{commit})" == "$TARGET_SHA" ]]
    "${SUDO[@]}" git -C "$staged" checkout --quiet --detach "$TARGET_SHA"
    "${SUDO[@]}" chown -R root:root "$staged"
    verify_release "$staged"
    "${SUDO[@]}" mv -- "$staged" "$release"
  fi

  "${SUDO[@]}" rm -f -- "$next_current"
  "${SUDO[@]}" ln -s -- "$release" "$next_current"
  "${SUDO[@]}" mv -Tf -- "$next_current" "$CURRENT"
  [[ "$(readlink -f "$CURRENT")" == "$release" ]]

  "${SUDO[@]}" install -o root -g root -m 0644 \
    "$CURRENT/research-dashboard/deploy/research-dashboard.service" \
    "/etc/systemd/system/$SERVICE"
  "${SUDO[@]}" systemctl daemon-reload
  "${SUDO[@]}" systemctl enable --now "$SERVICE"
  if ! "${SUDO[@]}" systemctl is-active --quiet "$SERVICE"; then
    echo 'Research Dashboard service did not enter active state.' >&2
    service_diagnostics
    return 1
  fi
  "${SUDO[@]}" systemctl is-enabled --quiet "$SERVICE"
  probe_dashboard

  local app_after research_after
  app_after="$(read_app_sha)"
  research_after="$(read_research_current)"
  [[ "$app_after" == "$app_before" ]] || {
    echo 'Production application SHA changed unexpectedly' >&2
    exit 71
  }
  [[ "$research_after" == "$research_before" ]] || {
    echo 'Research Production current release changed unexpectedly' >&2
    exit 72
  }

  printf '%s\n' \
    'RESEARCH_DASHBOARD_ACTIVATED=true' \
    "TARGET_SHA=$TARGET_SHA" \
    "CURRENT_RELEASE=$(readlink -f "$CURRENT")" \
    "APP_SHA_BEFORE=$app_before" \
    "APP_SHA_AFTER=$app_after" \
    "RESEARCH_CURRENT_BEFORE=$research_before" \
    "RESEARCH_CURRENT_AFTER=$research_after" \
    'BIND_HOST=127.0.0.1' \
    "BIND_PORT=$PORT" \
    'LIVE_TRADING=false' \
    'PRIVATE_API=false' \
    'ORDER_AUTHORITY=false' \
    'CADDY_MUTATION=0' \
    'DATABASE_MUTATION=0' \
    'PRODUCTION_PM2_MUTATION=0'
}

case "$MODE" in
  preflight) preflight ;;
  activate) activate ;;
  *)
    echo 'usage: activate-server.sh {preflight|activate}' >&2
    exit 64
    ;;
esac
