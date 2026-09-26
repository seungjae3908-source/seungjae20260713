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
  for command_name in git node python3 systemctl curl df awk readlink; do
    command -v "$command_name" >/dev/null 2>&1 || {
      echo "missing required command: $command_name" >&2
      exit 65
    }
  done
  if [[ "$(id -u)" -ne 0 ]]; then sudo -n true; fi
  local node_major
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  (( node_major >= 20 )) || {
    echo "Node >=20 required for activation probes; found $(node --version)" >&2
    exit 66
  }
  python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' || {
    echo "Python >=3.10 required for Research Dashboard runtime; found $(python3 --version 2>&1)" >&2
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

validate_service_runtime() {
  service_runner env -i \
    PATH=/usr/local/bin:/usr/bin:/bin \
    HOME=/nonexistent \
    LANG=C.UTF-8 \
    TZ=UTC \
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
  validate_service_runtime
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
  "${SUDO[@]}" test -f "$release/research-dashboard/v3_independence.py" || return 1
  "${SUDO[@]}" test -f "$release/research-dashboard/deploy/research-dashboard.service" || return 1
  "${SUDO[@]}" test -f "$release/research-dashboard/public/index.html" || return 1
  local actual
  actual="$("${SUDO[@]}" git -C "$release" rev-parse HEAD 2>/dev/null || true)"
  [[ "$actual" == "$TARGET_SHA" ]]
}

# Bind the response probe to a freshly started process in the exact release.
# A changed current symlink or a new unit file alone is not runtime evidence.
read_runtime_identity() {
  local pid started cwd cmdline interpreter script
  pid="$("${SUDO[@]}" systemctl show "$SERVICE" --property=MainPID --value)" || return 1
  started="$("${SUDO[@]}" systemctl show "$SERVICE" --property=ExecMainStartTimestampMonotonic --value)" || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ && "$started" =~ ^[1-9][0-9]*$ ]] || return 1
  (( started > runtime_start_before )) || return 1
  [[ "$(readlink -e "$CURRENT")" == "$RELEASES/$TARGET_SHA" ]] || return 1
  cwd="$("${SUDO[@]}" readlink -e "/proc/$pid/cwd")" || return 1
  [[ "$cwd" == "$RELEASES/$TARGET_SHA/research-dashboard" ]] || return 1
  cmdline="$("${SUDO[@]}" cat "/proc/$pid/cmdline" | tr '\0' '\n')" || return 1
  interpreter="${cmdline%%$'\n'*}"
  script="${cmdline#*$'\n'}"
  [[ "${interpreter##*/}" =~ ^python3([.][0-9]+)?$ ]] || return 1
  [[ "$script" == "$CURRENT/research-dashboard/server.py" ]] || return 1
  # Prove the loopback listener belongs to MainPID, not an old/foreign server.
  if ! "${SUDO[@]}" python3 - "$pid" "$PORT" <<'PYTHON'
import os
import sys
from pathlib import Path
try:
    proc = Path(f'/proc/{sys.argv[1]}')
    sockets = {os.readlink(fd) for fd in (proc / 'fd').iterdir()}
    address = f'0100007F:{int(sys.argv[2]):04X}'
    rows = [row.split() for row in (proc / 'net/tcp').read_text().splitlines()[1:]]
    listeners = [row[9] for row in rows if row[1] == address and row[3] == '0A']
    valid = bool(listeners) and all(f'socket:[{inode}]' in sockets for inode in listeners)
except (OSError, IndexError, ValueError):
    valid = False
raise SystemExit(0 if valid else 1)
PYTHON
  then
    return 1
  fi
  [[ "$("${SUDO[@]}" systemctl show "$SERVICE" --property=MainPID --value)" == "$pid" ]] || return 1
  [[ "$("${SUDO[@]}" systemctl show "$SERVICE" --property=ExecMainStartTimestampMonotonic --value)" == "$started" ]] || return 1
  printf '%s:%s' "$pid" "$started"
}

probe_dashboard() (
  local health overview
  health="$(mktemp)"
  overview="$(mktemp)"
  trap 'rm -f "$health" "$overview"' EXIT
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
  if ! node - "$health" <<'NODE'
const fs = require('node:fs');
const v = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (v?.ok !== true || v?.service !== 'investment-research-dashboard') process.exit(1);
if (v?.readOnly !== true || v?.liveTrading !== false || v?.privateApi !== false || v?.orderAuthority !== false) process.exit(1);
NODE
  then
    echo 'Research Dashboard health contract validation failed.' >&2
    service_diagnostics
    return 1
  fi
  local identity_before identity_after
  identity_before="$(read_runtime_identity)" || {
    echo 'Research Dashboard target runtime identity is not proven.' >&2
    return 1
  }
  if ! curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$PORT/api/research/overview" -o "$overview"; then
    echo 'Research Dashboard overview endpoint request failed.' >&2
    service_diagnostics
    return 1
  fi
  if ! node - "$overview" <<'NODE'
const fs = require('node:fs');
const v = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (v?.schemaVersion !== 'research-dashboard-overview-v1') process.exit(1);
if (v?.safety?.readOnlyDashboard !== true) process.exit(1);
if (v?.safety?.liveTrading !== false || v?.safety?.privateApi !== false || v?.safety?.orderAuthority !== false) process.exit(1);
if (v?.profitability?.proven !== false) process.exit(1);
// This is a consumer-contract check, not an economic readiness threshold.
const li = v?.research?.liquidityIndependence;
if (!li || typeof li !== 'object' || Array.isArray(li)) process.exit(1);
if (!['PRESENT', 'MISSING', 'INVALID'].includes(li.status)) process.exit(1);
if (li.present !== (li.status !== 'MISSING')) process.exit(1);
console.log(`V3_CONSUMER_STATUS=${li.status}`);
NODE
  then
    echo 'Research Dashboard overview contract validation failed.' >&2
    service_diagnostics
    return 1
  fi
  identity_after="$(read_runtime_identity)" || return 1
  [[ "$identity_after" == "$identity_before" ]] || {
    echo 'Research Dashboard process changed during the response probe.' >&2
    return 1
  }
  printf 'RUNTIME_IDENTITY=%s\n' "$identity_after"
)

# Keep rollback locals alive for every failure, including explicit return 1.
activate() (
  require_tools
  resource_check
  validate_state_access

  local release="$RELEASES/$TARGET_SHA"
  local staged="$RELEASES/.staging-$TARGET_SHA-$$"
  local next_current="$ROOT/.current-$TARGET_SHA-$$"
  local app_before research_before current_before unit_backup service_was_active service_was_enabled
  app_before="$(read_app_sha)"
  research_before="$(read_research_current)"
  current_before="$(readlink -e "$CURRENT" 2>/dev/null || true)"
  service_was_active=false
  service_was_enabled=false
  "${SUDO[@]}" systemctl is-active --quiet "$SERVICE" 2>/dev/null && service_was_active=true || true
  "${SUDO[@]}" systemctl is-enabled --quiet "$SERVICE" 2>/dev/null && service_was_enabled=true || true
  local runtime_start_before=0
  if [[ "$service_was_active" == true ]]; then
    runtime_start_before="$("${SUDO[@]}" systemctl show "$SERVICE" --property=ExecMainStartTimestampMonotonic --value)"
    [[ "$runtime_start_before" =~ ^[1-9][0-9]*$ ]] || return 1
  fi
  unit_backup="$(mktemp)"
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
    else
      "${SUDO[@]}" systemctl disable "$SERVICE" >/dev/null 2>&1 || true
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
  "${SUDO[@]}" systemctl enable "$SERVICE"
  # start/enable --now is a no-op for an active service. Restart also starts an
  # inactive unit and makes the target release effective before probing it.
  if ! "${SUDO[@]}" systemctl restart "$SERVICE"; then
    echo 'Research Dashboard target runtime restart failed.' >&2
    service_diagnostics
    return 1
  fi
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

  # The rollback handler closes over local activation state. Disarm it while
  # those locals are still in scope once every success condition is proven;
  # otherwise Bash runs the EXIT trap after this function returns and nounset
  # turns a successful activation into a false failure.
  trap - EXIT
  rm -f "$unit_backup"
  "${SUDO[@]}" rm -rf -- "$staged" >/dev/null 2>&1 || true
  "${SUDO[@]}" rm -f -- "$next_current" >/dev/null 2>&1 || true

  printf '%s\n' \
    'RESEARCH_DASHBOARD_ACTIVATED=true' \
    'RUNTIME_RELEASE_IDENTITY_VERIFIED=true' \
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
)

case "$MODE" in
  preflight) preflight ;;
  activate) activate ;;
  *)
    echo 'usage: activate-server.sh {preflight|activate}' >&2
    exit 64
    ;;
esac
