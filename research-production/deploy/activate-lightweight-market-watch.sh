#!/usr/bin/env bash
# Dedicated owner-approved research-market-watch activation only.
# Never modifies PM2, Caddy, production DB, trading, or existing research timers.
set -Eeuo pipefail
umask 077
MODE="$1"
TARGET_SHA="$TARGET_SHA"
ROOT=/opt/investment-research
CURRENT="$ROOT/current"
STATE=/var/lib/investment-research-production
ENV_FILE=/etc/investment-research/research-production.env
UNIT=research-production-market-watch.service
UNIT_SOURCE="$CURRENT/research-production/deploy/$UNIT"
UNIT_DEST="/etc/systemd/system/$UNIT"
STATUS_BIN="$CURRENT/research-production/bin/lightweight-market-watch-status.mjs"
EXPECTED_RELEASE="$ROOT/releases/$TARGET_SHA"
ACTIVATING=0
NEW_UNIT=0

asroot() {
  if (( EUID == 0 )); then "$@"; else sudo -n "$@"; fi
}
[[ "$MODE" == preflight || "$MODE" == activate || "$MODE" == verify ]] || exit 64
[[ "$TARGET_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 64
for exe in node git systemctl systemd-analyze df awk grep cmp readlink nproc runuser; do
  command -v "$exe" >/dev/null || exit 70
done
if (( EUID != 0 )); then
  command -v sudo >/dev/null || exit 70
  sudo -n true >/dev/null || exit 70
fi
check_release() {
  [[ -d "$ROOT" && -d "$STATE" && ! -L "$STATE" ]] || return 70
  [[ "$(readlink -f "$CURRENT")" == "$EXPECTED_RELEASE" ]] || return 70
  [[ -f "$STATUS_BIN" && -f "$UNIT_SOURCE" ]] || return 70
  local head
  head="$(git -c "safe.directory=$EXPECTED_RELEASE" -C "$CURRENT" rev-parse HEAD)"
  [[ "$head" == "$TARGET_SHA" ]] || return 70
  asroot test -f "$ENV_FILE" || return 70
  asroot grep -Fxq "RESEARCH_CODE_SHA=$TARGET_SHA" "$ENV_FILE" || return 70
  for guard in LIVE_TRADING=false PRIVATE_API_ENABLED=false ORDER_AUTHORITY=false; do
    asroot grep -Fxq "$guard" "$ENV_FILE" || return 70
  done
  id investment-research >/dev/null || return 70
}
check_unit() {
  grep -Fxq 'CPUQuota=40%' "$UNIT_SOURCE"
  grep -Fxq 'MemoryMax=512M' "$UNIT_SOURCE"
  grep -Fxq 'MemoryHigh=384M' "$UNIT_SOURCE"
  grep -Fxq 'NoNewPrivileges=true' "$UNIT_SOURCE"
  grep -Fxq 'ProtectSystem=strict' "$UNIT_SOURCE"
  grep -Fxq 'ReadWritePaths=/var/lib/investment-research-production' "$UNIT_SOURCE"
  grep -Fxq 'User=investment-research' "$UNIT_SOURCE"
  grep -Fq '/bin/lightweight-market-watch.mjs' "$UNIT_SOURCE"
  systemd-analyze verify "$UNIT_SOURCE" >/dev/null
  if asroot test -e "$UNIT_DEST"; then
    asroot cmp -s "$UNIT_SOURCE" "$UNIT_DEST" || return 76
  fi
}
check_budget() {
  local cores mem_kb free_kb load_one
  cores="$(nproc)"
  [[ "$cores" =~ ^[0-9]+$ ]] && (( cores >= 2 && cores <= 4 )) || return 71
  mem_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
  [[ "$mem_kb" =~ ^[0-9]+$ ]] && (( mem_kb >= 1048576 )) || return 71
  free_kb="$(df -Pk "$STATE" | awk 'NR==2 {print $4}')"
  [[ "$free_kb" =~ ^[0-9]+$ ]] && (( free_kb >= 5767168 )) || return 71
  load_one="$(awk '{print $1}' /proc/loadavg)"
  awk -v current_load="$load_one" 'BEGIN {exit !(current_load>=0 && current_load<1.5)}' || return 71
}
preflight() {
  check_release || { echo 'WATCH_EXACT_RESEARCH_RELEASE_REQUIRED'; return 70; }
  check_unit || { echo 'WATCH_ISOLATED_UNIT_UNSAFE'; return 76; }
  check_budget || { echo 'WATCH_HOST_RESOURCE_HEADROOM_MISSING'; return 71; }
  echo 'WATCH_PREFLIGHT_PASSED=true'
  echo "WATCH_TARGET_SHA=$TARGET_SHA"
  echo 'WATCH_EXECUTION_AUTHORITY=NONE'
}
read_watch_status() {
  local output
  output="$(asroot runuser -u investment-research -- env -i \
    PATH=/usr/local/bin:/usr/bin:/bin \
    RESEARCH_STATE_ROOT="$STATE" RESEARCH_CODE_SHA="$TARGET_SHA" \
    node "$STATUS_BIN")" || return 1
  printf '%s' "$output" | node -e '
    let data="";process.stdin.on("data",x=>data+=x);process.stdin.on("end",()=>{
      const v=JSON.parse(data);
      if(v.contract!=="lightweight-market-watch-readback/v1"
        ||!["PARTIAL","OBSERVING"].includes(v.status)
        ||!v.markets.some(m=>["CRYPTO_SPOT","CRYPTO_FUTURES"].includes(m.market)
          && ["READY","PARTIAL_TICKERS"].includes(m.status))
        ||v.researchSha!==process.env.TARGET_SHA
        ||v.executionAuthority!=="NONE"||v.continuous24hProven!==false
        ||v.profitabilityProven!==false||!(v.cyclesSinceRelease>=1)
        ||!(v.ageMs>=0 && v.ageMs<=360000))process.exit(1);
      else process.stdout.write(v.status);
    });
  '
}
verify() {
  check_release || return 70
  check_unit || return 76
  asroot systemctl is-enabled --quiet "$UNIT" || return 72
  asroot systemctl is-active --quiet "$UNIT" || return 72
  local observed
  observed="$(read_watch_status)" || return 72
  echo 'WATCH_SERVICE_ACTIVE=true'
  echo "WATCH_TARGET_SHA=$TARGET_SHA"
  echo "WATCH_LOCAL_STATUS=$observed"
  echo 'WATCH_24H_UPTIME_PROVEN=false'
  echo 'WATCH_FOUR_MARKET_FULL_FEED_PROVEN=false'
  echo 'WATCH_EXECUTION_AUTHORITY=NONE'
}
rollback() {
  local rc=$?
  if (( rc != 0 && ACTIVATING == 1 )); then
    asroot systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
    if (( NEW_UNIT == 1 )); then
      asroot rm -f -- "$UNIT_DEST" || true
      asroot systemctl daemon-reload >/dev/null 2>&1 || true
    fi
    echo 'WATCH_ACTIVATION_ROLLED_BACK=true'
  fi
}
activate() {
  preflight
  if asroot systemctl is-active --quiet "$UNIT"; then
    verify
    echo 'WATCH_ALREADY_RUNNING=true'
    return
  fi
  ACTIVATING=1
  trap rollback EXIT
  if ! asroot test -e "$UNIT_DEST"; then
    asroot install -o root -g root -m 0644 "$UNIT_SOURCE" "$UNIT_DEST"
    NEW_UNIT=1
  fi
  asroot systemctl daemon-reload
  asroot systemctl enable --now "$UNIT"
  local ready=0
  for ((i=0;i<24;i++)); do
    if verify >/dev/null 2>&1; then ready=1; break; fi
    if ! asroot systemctl is-active --quiet "$UNIT"; then break; fi
    sleep 5
  done
  ((ready==1)) || return 72
  verify
  ACTIVATING=0
  trap - EXIT
}
case "$MODE" in
  preflight) preflight ;;
  activate) activate ;;
  verify) verify ;;
esac
