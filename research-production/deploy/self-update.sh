#!/usr/bin/env bash
# Research server self-update (owner decision 2026-10-17, option B).
#
# Hourly, as root, from a stable copy at /usr/local/sbin/investment-research-self-update:
#   1. Read main from the public repository. Nothing to do if the Research
#      release is already main, or if no Research path changed since it.
#   2. Validate the target in the isolated environment FIRST (production state
#      untouched), retrying the free-AI natural cycle a bounded number of times.
#   3. Only after a PASS: cut over the Research release, then activate the AI
#      schedules for it, then restore the market watch if it was running.
#   4. Any failure leaves (or rolls back to) the running Research runtime; the
#      activation scripts keep their own rollback. Result goes to a status file.
#
# The same activation scripts as the owner-approved GitHub commands are used,
# taken from the target commit. Research has no order authority; this updater
# never touches the app process, trading, the database or member data.
set -Eeuo pipefail
# Releases staged by the activation scripts must stay readable by the
# investment-research user; a 077 umask made them root-only and every isolated
# validation died with MODULE_NOT_FOUND. The state directory itself is 0700.
umask 022

REPOSITORY_URL="${RESEARCH_SELF_UPDATE_REPOSITORY_URL:-https://github.com/seungjae3908-source/seungjae20260713.git}"
RESEARCH_ROOT=/opt/investment-research
CURRENT="$RESEARCH_ROOT/current"
STATE_DIR=/var/lib/investment-research-self-update
MIRROR="$STATE_DIR/mirror.git"
STATUS="$STATE_DIR/status.json"
FAILURES="$STATE_DIR/failures.json"
RESEARCH_STATE=/var/lib/investment-research-production
PUBLIC_STATUS="$RESEARCH_STATE/latest/self-update-v1.json"
CONFIG=/etc/investment-research/self-update.env
LOCK=/run/lock/investment-research-self-update.lock
ISOLATED_RELEASES=/var/lib/investment-research-transition-v2/releases
VALIDATION_ATTEMPTS="${RESEARCH_SELF_UPDATE_VALIDATION_ATTEMPTS:-3}"
RETRY_AFTER_SECONDS="${RESEARCH_SELF_UPDATE_RETRY_AFTER_SECONDS:-21600}"
IDLE_WAIT_SECONDS="${RESEARCH_SELF_UPDATE_IDLE_WAIT_SECONDS:-1200}"
# Paths whose change requires a new Research release. App-only merges are ignored.
RESEARCH_PATH_PREFIXES=(research-production/ market-prediction-lab/ packages/)
ONESHOT_SERVICES=(
  research-production@fast-historical.service research-production@long-history.service
  research-production@forward.service research-production-temporal-evidence.service
  research-production-factory-status.service research-production-maintenance.service
  research-production-ai-review.service research-production-video-discovery.service
  research-production-approved-job-intake.service
)
WATCH_SERVICE=research-production-market-watch.service
# The ten-minute AI tick (*:09/10) fires right after this timer (*:37): a
# validation that starts seconds before it collides with the tick and fails
# busy, so an imminent tick is let through and finished first.
AI_REVIEW_TIMER=research-production-ai-review.timer
AI_TICK_GUARD_SECONDS="${RESEARCH_SELF_UPDATE_AI_TICK_GUARD_SECONDS:-180}"
# AI units that must run the current release. A failed AI activation rolls
# them back to the previous release and re-enables their timers, so "timers
# on" alone does not prove the AI schedules run the release that is current.
AI_RUNTIME_UNITS=(research-production-ai-review.service research-production-workspace-worker.service)

[[ "$(id -u)" -eq 0 ]] || { echo "SELF_UPDATE_ROOT_REQUIRED" >&2; exit 64; }
if [[ -r "$CONFIG" ]] && grep -Eq '^RESEARCH_SELF_UPDATE_ENABLED=(false|0)$' "$CONFIG"; then
  echo "SELF_UPDATE_DISABLED_BY_CONFIG"
  exit 0
fi

install -d -o root -g root -m 0700 "$STATE_DIR"
exec 9>"$LOCK"
flock -n 9 || { echo "SELF_UPDATE_ALREADY_RUNNING"; exit 0; }

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

write_status() {
  # status target current detail
  local tmp="$STATUS.tmp.$$"
  node -e '
    const [status, target, current, detail, at] = process.argv.slice(1);
    const out = { contract: "research-self-update/v1", status, targetSha: target || null,
      currentSha: current || null, detail: detail || null, observedAt: at,
      executionAuthority: "NONE", liveTrading: false, realOrder: false };
    process.stdout.write(JSON.stringify(out) + "\n");
  ' "$1" "$2" "$3" "$4" "$(now_iso)" > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$STATUS"
  # Readable copy for the Research reports (owned by the research user).
  if [[ -d "$RESEARCH_STATE/latest" ]]; then
    install -o investment-research -g investment-research -m 0600 "$STATUS" "$PUBLIC_STATUS.tmp.$$"
    mv -f "$PUBLIC_STATUS.tmp.$$" "$PUBLIC_STATUS"
  fi
  printf 'SELF_UPDATE_STATUS=%s TARGET=%s CURRENT=%s DETAIL=%s\n' "$1" "${2:-}" "${3:-}" "${4:-}"
}

recent_failure() {
  # true when this target already failed recently (do not burn the free AI quota)
  [[ -f "$FAILURES" ]] || return 1
  node -e '
    const fs = require("node:fs");
    const [path, sha, retryAfter] = process.argv.slice(1);
    const rows = JSON.parse(fs.readFileSync(path, "utf8"));
    const row = rows[sha];
    process.exit(row && Date.now() - Date.parse(row.at) < Number(retryAfter) * 1000 ? 0 : 1);
  ' "$FAILURES" "$1" "$RETRY_AFTER_SECONDS"
}

record_failure() {
  node -e '
    const fs = require("node:fs");
    const [path, sha, stage] = process.argv.slice(1);
    let rows = {};
    try { rows = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
    rows[sha] = { stage, at: new Date().toISOString() };
    const keep = Object.entries(rows).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at)).slice(0, 20);
    fs.writeFileSync(path + ".tmp", JSON.stringify(Object.fromEntries(keep)) + "\n", { mode: 0o600 });
    fs.renameSync(path + ".tmp", path);
  ' "$FAILURES" "$1" "$2"
}

ai_tick_imminent() {
  # true when the AI tick fires within the guard window (it would collide)
  local next now
  next="$(systemctl show "$AI_REVIEW_TIMER" -p NextElapseUSecRealtime --value 2>/dev/null || true)"
  [[ -n "$next" && "$next" != "n/a" ]] || return 1
  next="$(date -d "$next" +%s 2>/dev/null || true)"
  [[ "$next" =~ ^[0-9]+$ ]] || return 1
  now="$(date +%s)"
  (( next >= now && next - now <= AI_TICK_GUARD_SECONDS ))
}

# A running Type=oneshot unit reports ActiveState=activating, which
# `systemctl is-active` does not count as active, so the state itself is read:
# anything but inactive/failed (or an unknown unit) is work in progress. This is
# the same rule the activation script applies (AI_RESEARCH_CUTOVER_BUSY).
oneshot_busy() {
  local state
  state="$(systemctl show "$1" -p ActiveState --value 2>/dev/null || true)"
  case "$state" in inactive|failed|"") return 1 ;; *) return 0 ;; esac
}

wait_for_idle_oneshots() {
  local deadline=$(( $(date +%s) + IDLE_WAIT_SECONDS )) service busy
  while :; do
    busy=""
    for service in "${ONESHOT_SERVICES[@]}"; do
      if oneshot_busy "$service"; then busy="$service"; break; fi
    done
    if [[ -z "$busy" ]] && ai_tick_imminent; then busy="$AI_REVIEW_TIMER:imminent"; fi
    [[ -z "$busy" ]] && return 0
    (( $(date +%s) < deadline )) || { echo "SELF_UPDATE_ONESHOT_STILL_RUNNING:$busy" >&2; return 1; }
    sleep 20
  done
}

# An isolated release staged under the old 077 umask is reused as-is by
# validate-isolated, so open it up for the research user before validating.
repair_isolated_release() {
  local release="$ISOLATED_RELEASES/$1"
  [[ -d "$release" && ! -L "$release" ]] || return 0
  chmod -R u+rwX,go+rX,go-w -- "$release"
}

# First failure code or error line from a validation log, for the status file.
validation_reason() {
  local log="$1" reason
  reason="$(grep -Eo '"reason": *"[^"]+"' "$log" | tail -1 | sed 's/.*: *"//;s/"$//' || true)"
  [[ -n "$reason" ]] || reason="$(grep -Eo '^(AI_RESEARCH_[A-Z0-9_]+(:[^ ]*)?|Error: .*)' "$log" | grep -viE 'token|secret|key|password' | tail -1 || true)"
  printf '%s' "${reason:0:200}"
}

manual_activation_running() {
  pgrep -f -- 'activate-server.sh|activate-ai-research.sh|activate-lightweight-market-watch.sh' >/dev/null 2>&1
}

current_sha=""
if [[ -L "$CURRENT" ]]; then current_sha="$(basename "$(readlink -f "$CURRENT")")"; fi
[[ "$current_sha" =~ ^[0-9a-f]{40}$ ]] || { write_status NO_CURRENT_RELEASE "" "$current_sha" "research release missing"; exit 1; }

main_sha="$(git ls-remote "$REPOSITORY_URL" refs/heads/main | awk '{print $1}')"
[[ "$main_sha" =~ ^[0-9a-f]{40}$ ]] || { write_status MAIN_UNREADABLE "" "$current_sha" "git ls-remote failed"; exit 1; }

ai_schedules_enabled() { systemctl is-enabled --quiet "$AI_REVIEW_TIMER"; }

ai_runtime_bound_to_current() {
  # true when every AI unit's working directory resolves to the current release
  local unit directory current
  current="$(readlink -f -- "$CURRENT" 2>/dev/null || true)"
  [[ -n "$current" ]] || return 1
  for unit in "${AI_RUNTIME_UNITS[@]}"; do
    directory="$(systemctl show "$unit" -p WorkingDirectory --value 2>/dev/null || true)"
    [[ -n "$directory" && "$(readlink -f -- "$directory" 2>/dev/null || true)" == "$current" ]] || return 1
  done
}

ai_runtime_detail() {
  # where the AI review unit actually runs, for the status file
  local directory
  directory="$(systemctl show "${AI_RUNTIME_UNITS[0]}" -p WorkingDirectory --value 2>/dev/null || true)"
  directory="$(readlink -f -- "$directory" 2>/dev/null || printf '%s' "${directory:-unknown}")"
  printf 'AI units run %s' "$(basename -- "$directory" | cut -c1-7)"
}

ai_runtime_healthy() { ai_schedules_enabled && ai_runtime_bound_to_current; }

# Self-heal: a release cutover leaves AI schedules off until AI activation
# succeeds. If they are off for the running release, validate it in isolation
# and turn them back on without any release change.
restore_ai_for_current() {
  local sha="$1" why="${2:-AI schedules were off}" work_dir attempt reason=""
  if manual_activation_running; then
    write_status DEFERRED_MANUAL_ACTIVATION "$sha" "$sha" "an owner-approved activation is running"
    return 0
  fi
  if recent_failure "restore-$sha"; then
    write_status WAITING_AFTER_FAILURE "$sha" "$sha" "AI schedule restore failed recently; retry later"
    return 0
  fi
  work_dir="$(mktemp -d "$STATE_DIR/restore.XXXXXX")"
  for script in activate-ai-research.sh activate-lightweight-market-watch.sh; do
    git -C "$MIRROR" show "$sha:research-production/deploy/$script" > "$work_dir/$script"
  done
  repair_isolated_release "$sha"
  write_status RESTORING_AI "$sha" "$sha" "$why; isolated validation then re-enable"
  for attempt in $(seq 1 "$VALIDATION_ATTEMPTS"); do
    wait_for_idle_oneshots || continue
    if env TARGET_SHA="$sha" RESEARCH_AI_ISOLATED_CYCLES=2 REPOSITORY_URL="$REPOSITORY_URL" \
        bash "$work_dir/activate-ai-research.sh" validate-isolated > "$work_dir/validate.log" 2>&1 \
      && env TARGET_SHA="$sha" bash "$work_dir/activate-ai-research.sh" activate > "$work_dir/ai.log" 2>&1; then
      write_status AI_RESTORED "$sha" "$sha" "AI schedules re-enabled for the running release"
      rm -rf -- "$work_dir"
      return 0
    fi
    reason="$(validation_reason "$work_dir/validate.log")"
    sleep 60
  done
  rm -rf -- "$work_dir"
  if [[ "$reason" == AI_RESEARCH_CUTOVER_BUSY:* ]]; then
    # Only a running research one-shot got in the way: retry next hour without
    # the six-hour failure penalty, exactly as the validation path does.
    write_status DEFERRED_RESEARCH_BUSY "$sha" "$sha" "$reason; $why; retry next hour"
    return 0
  fi
  record_failure "restore-$sha" ai-restore
  write_status AI_RESTORE_FAILED "$sha" "$sha" "${reason:+$reason; }$why; core research timers keep running"
  return 1
}

ensure_mirror() {
  if [[ ! -d "$MIRROR" ]]; then
    git init -q --bare "$MIRROR"
    git -C "$MIRROR" remote add origin "$REPOSITORY_URL"
  fi
  git -C "$MIRROR" fetch -q --depth 500 origin "+refs/heads/main:refs/heads/main"
}

ai_restore_reason() {
  if ! ai_schedules_enabled; then printf 'AI schedules were off'; else ai_runtime_detail; fi
}

if [[ "$main_sha" == "$current_sha" ]]; then
  if ai_runtime_healthy; then
    write_status UP_TO_DATE "$main_sha" "$current_sha" ""
    exit 0
  fi
  ensure_mirror
  restore_ai_for_current "$current_sha" "$(ai_restore_reason)"
  exit $?
fi

ensure_mirror
git -C "$MIRROR" cat-file -e "$main_sha^{commit}"

changed=""
if git -C "$MIRROR" cat-file -e "$current_sha^{commit}" 2>/dev/null; then
  changed="$(git -C "$MIRROR" diff --name-only "$current_sha" "$main_sha" -- "${RESEARCH_PATH_PREFIXES[@]}" | head -n 2000)"
else
  # Current release is older than the fetched history: treat as changed.
  changed="HISTORY_UNAVAILABLE"
fi
if [[ -z "$changed" ]]; then
  if ! ai_runtime_healthy && git -C "$MIRROR" cat-file -e "$current_sha^{commit}" 2>/dev/null; then
    restore_ai_for_current "$current_sha" "$(ai_restore_reason)"
    exit $?
  fi
  write_status NO_RESEARCH_CHANGE "$main_sha" "$current_sha" "only app or workflow paths changed"
  exit 0
fi

if recent_failure "$main_sha"; then
  write_status WAITING_AFTER_FAILURE "$main_sha" "$current_sha" "same target failed recently; retry later"
  exit 0
fi
if manual_activation_running; then
  write_status DEFERRED_MANUAL_ACTIVATION "$main_sha" "$current_sha" "an owner-approved activation is running"
  exit 0
fi

work="$(mktemp -d "$STATE_DIR/run.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
for script in activate-server.sh activate-ai-research.sh activate-lightweight-market-watch.sh; do
  git -C "$MIRROR" show "$main_sha:research-production/deploy/$script" > "$work/$script"
done

watch_was_active=false
systemctl is-active --quiet "$WATCH_SERVICE" && watch_was_active=true

repair_isolated_release "$main_sha"
write_status VALIDATING "$main_sha" "$current_sha" "isolated validation (production untouched)"
validated=false
reason=""
for attempt in $(seq 1 "$VALIDATION_ATTEMPTS"); do
  wait_for_idle_oneshots || continue
  if env TARGET_SHA="$main_sha" RESEARCH_AI_ISOLATED_CYCLES=2 REPOSITORY_URL="$REPOSITORY_URL" \
      bash "$work/activate-ai-research.sh" validate-isolated > "$work/validate-$attempt.log" 2>&1; then
    validated=true
    break
  fi
  reason="$(validation_reason "$work/validate-$attempt.log")"
  echo "SELF_UPDATE_VALIDATION_ATTEMPT_FAILED:$attempt:${reason:-unknown}" >&2
  sleep 60
done
if [[ "$validated" != true ]]; then
  if [[ "$reason" == AI_RESEARCH_CUTOVER_BUSY:* ]]; then
    # A collision with a running research one-shot is not a verdict on the
    # target: do not count it as a failure (that would delay it six hours).
    write_status DEFERRED_RESEARCH_BUSY "$main_sha" "$current_sha" "$reason; retry next hour; running release unchanged"
    exit 0
  fi
  record_failure "$main_sha" validation
  write_status VALIDATION_FAILED "$main_sha" "$current_sha" "${reason:-isolated validation failed}; running release unchanged"
  exit 1
fi

paper_policy="$RESEARCH_ROOT/releases/$main_sha/market-prediction-lab/config/paper-risk-policy/natural-paper-btcusdt-v2.json"
write_status CUTTING_OVER "$main_sha" "$current_sha" "research release cutover"
wait_for_idle_oneshots || true
if ! env TARGET_SHA="$main_sha" REPOSITORY_URL="$REPOSITORY_URL" PAPER_FORWARD_RISK_POLICY_DECISION_PATH="$paper_policy" \
    bash "$work/activate-server.sh" preflight > "$work/preflight.log" 2>&1 \
  || ! env TARGET_SHA="$main_sha" REPOSITORY_URL="$REPOSITORY_URL" PAPER_FORWARD_RISK_POLICY_DECISION_PATH="$paper_policy" \
    bash "$work/activate-server.sh" activate > "$work/cutover.log" 2>&1; then
  record_failure "$main_sha" cutover
  tail -20 "$work/cutover.log" "$work/preflight.log" >&2 2>/dev/null || true
  write_status CUTOVER_FAILED "$main_sha" "$current_sha" "release cutover failed; activation script rolled back"
  exit 1
fi

if ! env TARGET_SHA="$main_sha" bash "$work/activate-ai-research.sh" activate > "$work/ai.log" 2>&1; then
  record_failure "$main_sha" ai-activation
  tail -20 "$work/ai.log" >&2 || true
  write_status AI_ACTIVATION_FAILED "$main_sha" "$main_sha" "AI schedules rolled back to the previous runtime snapshot"
  exit 1
fi

watch_detail="market watch was not running"
if [[ "$watch_was_active" == true ]]; then
  if env TARGET_SHA="$main_sha" bash "$work/activate-lightweight-market-watch.sh" preflight > "$work/watch.log" 2>&1 \
    && env TARGET_SHA="$main_sha" bash "$work/activate-lightweight-market-watch.sh" activate >> "$work/watch.log" 2>&1; then
    watch_detail="market watch restored"
  else
    watch_detail="market watch restore failed (research cycles are running)"
  fi
fi

write_status UPDATED "$main_sha" "$current_sha" "$watch_detail"
