#!/usr/bin/env bash
set -Eeuo pipefail

MODE="${1:-}"
TARGET_SHA="${TARGET_SHA:-}"
REPOSITORY_URL="${REPOSITORY_URL:-https://github.com/seungjae3908-source/seungjae20260713.git}"

if [[ ! "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "TARGET_SHA must be an exact lowercase 40-character SHA" >&2
  exit 64
fi

# Validate explicit transport before any activation mutation (including traps).
# Missing/empty remains missing; this does not read or publish a policy record.
node <<'NODE'
const { isAbsolute, resolve } = require('node:path').posix;
const value = process.env.PAPER_FORWARD_RISK_POLICY_RECORD_PATH;
if (value && (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)
  || !isAbsolute(value) || resolve(value) !== value)) {
  console.error('PAPER_FORWARD_RISK_POLICY_RECORD_PATH must be a normalized absolute path without control characters');
  process.exit(64);
}
const decision = process.env.PAPER_FORWARD_RISK_POLICY_DECISION_PATH;
if (decision && (decision.trim() !== decision || /[\u0000-\u001f\u007f]/u.test(decision)
  || !isAbsolute(decision) || resolve(decision) !== decision)) {
  console.error('PAPER_FORWARD_RISK_POLICY_DECISION_PATH must be a normalized absolute path without control characters');
  process.exit(64);
}
if (value && decision) {
  console.error('CANONICAL_RISK_POLICY_SOURCE_AMBIGUOUS: provide either record or approved decision path');
  process.exit(64);
}
const supplemental = process.env.PAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH;
if (supplemental && (supplemental.trim() !== supplemental || /[\u0000-\u001f\u007f]/u.test(supplemental)
  || !isAbsolute(supplemental) || resolve(supplemental) !== supplemental)) {
  console.error('PAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH must be a normalized absolute path without control characters');
  process.exit(64);
}
NODE

require_base_tools() {
  command -v git >/dev/null
  command -v node >/dev/null
  command -v systemctl >/dev/null
  command -v systemd-analyze >/dev/null
  if [[ "$(id -u)" -ne 0 ]]; then sudo -n true; fi
  local node_major
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  (( node_major >= 20 )) || {
    echo "Node >=20 required; found $(node --version)" >&2
    exit 70
  }
  node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<20||(major===20&&minor<12)||typeof require("node:util").parseEnv!=="function")process.exit(1)' || {
    echo 'RESEARCH_NODE_ENV_PARSER_REQUIRED: Node >=20.12 with parseEnv' >&2
    exit 70
  }
}

read_app_sha() {
  local state=/opt/stock-app/.deploy/current-sha
  if [[ -s "$state" ]]; then
    tr -d '[:space:]' < "$state"
  else
    printf 'absent'
  fi
}

resource_snapshot() {
  FREE_BYTES="$(df -PB1 / | awk 'NR==2 {print $4}')"
  FREE_INODES="$(df -Pi / | awk 'NR==2 {print $4}')"
  MEM_AVAILABLE_BYTES="$(awk '/MemAvailable:/ {print $2 * 1024}' /proc/meminfo)"
  CPU_CORES="$(nproc)"
  (( FREE_BYTES >= 5368709120 )) || {
    echo "Need at least 5 GiB free disk; have $FREE_BYTES" >&2
    exit 71
  }
  (( FREE_INODES >= 50000 )) || {
    echo "Need at least 50000 free inodes; have $FREE_INODES" >&2
    exit 72
  }
}

preflight() {
  require_base_tools
  resource_snapshot
  local app_sha
  app_sha="$(read_app_sha)"
  printf '%s\n' \
    "SERVER_PREFLIGHT=PASS" \
    "TARGET_SHA=$TARGET_SHA" \
    "NODE=$(node --version)" \
    "CPU_CORES=$CPU_CORES" \
    "MEM_AVAILABLE_BYTES=$MEM_AVAILABLE_BYTES" \
    "FREE_BYTES=$FREE_BYTES" \
    "FREE_INODES=$FREE_INODES" \
    "APP_SHA=$app_sha" \
    "LIVE_TRADING=false" \
    "PRIVATE_API=false" \
    "ORDER_AUTHORITY=false"
}

activate() {
  require_base_tools
  resource_snapshot

  if [[ "$(id -u)" -eq 0 ]]; then
    SUDO=()
  else
    SUDO=(sudo -n)
  fi

  ROOT=/opt/investment-research
  RELEASES="$ROOT/releases"
  RELEASE="$RELEASES/$TARGET_SHA"
  STAGED_RELEASE="$RELEASES/.staging-$TARGET_SHA-$$"
  CURRENT="$ROOT/current"
  NEXT_CURRENT="$ROOT/.current-$TARGET_SHA-$$"
  STATE=/var/lib/investment-research-production
  ENV_DIR=/etc/investment-research
  ENV_FILE="$ENV_DIR/research-production.env"
  APP_SHA_BEFORE="$(read_app_sha)"
  PREVIOUS_CURRENT="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  ROLLBACK_ENV="$ROOT/.research-production-env-rollback-$$"
  # EXIT runs after activate's local scope unwinds. Keep its fixed unit lists
  # and previous enabled state available to the failure/rollback handler.
  declare -ga CORE_TIMERS=(
    research-production-fast-historical.timer
    research-production-long-history.timer
    research-production-forward.timer
    research-production-temporal-evidence.timer
    research-production-factory-status.timer
    research-production-maintenance.timer
  )
  declare -ga AI_TIMERS=(
    research-production-ai-review.timer
    research-production-video-discovery.timer
    research-production-approved-job-intake.timer
  )
  declare -ga AI_DAEMONS=(
    research-production-workspace-worker.service
  )
  declare -ga WATCH_SERVICES=(
    research-production-market-watch.service
  )
  declare -ga ONESHOT_SERVICES=(
    research-production@fast-historical.service
    research-production@long-history.service
    research-production@forward.service
    research-production-temporal-evidence.service
    research-production-factory-status.service
    research-production-maintenance.service
    research-production-ai-review.service
    research-production-video-discovery.service
    research-production-approved-job-intake.service
  )
  # Capture the *installed* unit bytes and previous active/enabled flags.
  # Comparing against prior source code alone cannot verify host rollback.
  declare -gA WAS_ENABLED=()
  declare -gA WAS_ACTIVE=()
  declare -gA WAS_INSTALLED=()
  declare -gA WAS_LOAD_STATE=()
  declare -ga CORE_UNIT_DEFINITIONS=(
    research-production@.service
    research-production-temporal-evidence.service
    research-production-factory-status.service
    research-production-maintenance.service
    research-production-fast-historical.timer
    research-production-long-history.timer
    research-production-forward.timer
    research-production-temporal-evidence.timer
    research-production-factory-status.timer
    research-production-maintenance.timer
  )
  ROLLBACK_UNITS="$ROOT/.research-production-units-rollback-$$"
  CUTOVER_MUTATION_STARTED=false
  CUTOVER_POINTER_SWITCHED=false
  ROLLBACK_VERIFIED=false
  PREVIOUS_SHA="$("${SUDO[@]}" git -C "$PREVIOUS_CURRENT" rev-parse HEAD 2>/dev/null || true)"
  [[ "$PREVIOUS_SHA" =~ ^[0-9a-f]{40}$ && "$PREVIOUS_CURRENT" == "$RELEASES/$PREVIOUS_SHA" ]] || {
    echo "RESEARCH_CORE_PREVIOUS_RELEASE_UNVERIFIED" >&2; exit 69;
  }
  "${SUDO[@]}" test -f "$ENV_FILE" || { echo "RESEARCH_CORE_PREVIOUS_ENV_MISSING" >&2; exit 69; }
  for timer in "${CORE_TIMERS[@]}" "${AI_TIMERS[@]}" "${AI_DAEMONS[@]}" "${WATCH_SERVICES[@]}"; do
    local load_state
    load_state="$("${SUDO[@]}" systemctl show "$timer" -p LoadState --value 2>/dev/null || true)"
    case "$load_state" in
      loaded|not-found) ;;
      *) echo "RESEARCH_CORE_UNIT_LOAD_STATE_UNSAFE:$timer:$load_state" >&2; exit 69 ;;
    esac
    WAS_LOAD_STATE["$timer"]="$load_state"
    if "${SUDO[@]}" systemctl is-enabled --quiet "$timer" 2>/dev/null; then WAS_ENABLED["$timer"]=1
    else WAS_ENABLED["$timer"]=0; fi
    if "${SUDO[@]}" systemctl is-active --quiet "$timer" 2>/dev/null; then WAS_ACTIVE["$timer"]=1
    else WAS_ACTIVE["$timer"]=0; fi
  done
  [[ ! -e "$ROLLBACK_UNITS" && ! -L "$ROLLBACK_UNITS" ]] || {
    echo "RESEARCH_CORE_ROLLBACK_SNAPSHOT_ALREADY_EXISTS" >&2; exit 69;
  }
  "${SUDO[@]}" install -d -o root -g root -m 0700 "$ROLLBACK_UNITS"
  for unit in "${CORE_UNIT_DEFINITIONS[@]}"; do
    if "${SUDO[@]}" test -f "/etc/systemd/system/$unit"; then
      "${SUDO[@]}" cp -p "/etc/systemd/system/$unit" "$ROLLBACK_UNITS/$unit"
      WAS_INSTALLED["$unit"]=1
    else
      WAS_INSTALLED["$unit"]=0
    fi
  done
  "${SUDO[@]}" cp -p "$ENV_FILE" "$ROLLBACK_ENV"

  cleanup_transient() {
    "${SUDO[@]}" rm -rf -- "$STAGED_RELEASE" >/dev/null 2>&1 || true
    "${SUDO[@]}" rm -f -- "$NEXT_CURRENT" >/dev/null 2>&1 || true
  }

  verify_timers_stopped() {
    local timer active_state unit_state
    for timer in "$@"; do
      active_state="$("${SUDO[@]}" systemctl show "$timer" -p ActiveState --value 2>/dev/null || true)"
      unit_state="$("${SUDO[@]}" systemctl show "$timer" -p UnitFileState --value 2>/dev/null || true)"
      case "$active_state" in
        active|activating|reloading|deactivating)
          echo "RESEARCH_TIMER_STILL_ACTIVE:$timer:$active_state" >&2
          return 1
          ;;
      esac
      case "$unit_state" in
        enabled|enabled-runtime|linked|linked-runtime)
          echo "RESEARCH_TIMER_STILL_ENABLED:$timer:$unit_state" >&2
          return 1
          ;;
      esac
    done
  }

  freeze_research_schedules() {
    # Optional units may not exist on this host. Skip only verified
    # not-found/masked units; never swallow a real disable failure.
    local unit load_state failed=false
    for unit in "${CORE_TIMERS[@]}" "${AI_TIMERS[@]}" "${AI_DAEMONS[@]}" "${WATCH_SERVICES[@]}"; do
      load_state="$("${SUDO[@]}" systemctl show "$unit" -p LoadState --value 2>/dev/null || true)"
      case "$load_state" in
        not-found|masked) ;;
        loaded)
          "${SUDO[@]}" systemctl disable --now "$unit" >/dev/null 2>&1 || {
            echo "RESEARCH_SCHEDULE_FREEZE_FAILED:$unit" >&2
            failed=true
          }
          ;;
        *)
          echo "RESEARCH_SCHEDULE_FREEZE_UNKNOWN:$unit:$load_state" >&2
          failed=true
          ;;
      esac
    done
    [[ "$failed" == false ]]
  }

  require_idle_one_shots() {
    # Refuse a busy release; never kill in-flight Research to force a cutover.
    local service active_state load_state
    for service in "${ONESHOT_SERVICES[@]}"; do
      active_state="$("${SUDO[@]}" systemctl show "$service" -p ActiveState --value 2>/dev/null || true)"
      load_state="$("${SUDO[@]}" systemctl show "$service" -p LoadState --value 2>/dev/null || true)"
      [[ "$load_state" == 'loaded' || "$load_state" == 'masked' || "$load_state" == 'not-found' ]] || {
        echo "RESEARCH_WORKLOAD_STATE_UNKNOWN:$service" >&2; return 1;
      }
      case "$active_state" in
        inactive|failed) ;;
        *) echo "RESEARCH_CUTOVER_BUSY:$service:$active_state" >&2; return 1 ;;
      esac
    done
  }

  restore_previous_schedules_only() {
    # Before the /current pointer moves, existing one-shots still use the
    # previous release. Do not stop them, reload their units, or rewrite env.
    local timer
    for timer in "${CORE_TIMERS[@]}" "${AI_TIMERS[@]}" "${AI_DAEMONS[@]}" "${WATCH_SERVICES[@]}"; do
      if [[ "${WAS_LOAD_STATE[$timer]:-}" == not-found ]]; then continue; fi
      if [[ "${WAS_ENABLED[$timer]:-0}" == 1 ]]; then
        "${SUDO[@]}" systemctl enable "$timer" >/dev/null 2>&1 || return 1
      else
        "${SUDO[@]}" systemctl disable "$timer" >/dev/null 2>&1 || return 1
      fi
      if [[ "${WAS_ACTIVE[$timer]:-0}" == 1 ]]; then
        "${SUDO[@]}" systemctl start "$timer" >/dev/null 2>&1 || return 1
      else
        "${SUDO[@]}" systemctl stop "$timer" >/dev/null 2>&1 || return 1
      fi
    done
    for timer in "${CORE_TIMERS[@]}" "${AI_TIMERS[@]}" "${AI_DAEMONS[@]}" "${WATCH_SERVICES[@]}"; do
      local enabled=0 active=0 load_state
      load_state="$("${SUDO[@]}" systemctl show "$timer" -p LoadState --value 2>/dev/null || true)"
      [[ "$load_state" == "${WAS_LOAD_STATE[$timer]:-}" ]] || {
        echo "RESEARCH_PRE_CUTOVER_UNIT_LOAD_STATE_MISMATCH:$timer" >&2; return 1;
      }
      if "${SUDO[@]}" systemctl is-enabled --quiet "$timer" 2>/dev/null; then enabled=1; fi
      if "${SUDO[@]}" systemctl is-active --quiet "$timer" 2>/dev/null; then active=1; fi
      [[ "$enabled" == "${WAS_ENABLED[$timer]:-0}" && "$active" == "${WAS_ACTIVE[$timer]:-0}" ]] || {
        echo "RESEARCH_PRE_CUTOVER_UNIT_STATE_MISMATCH:$timer" >&2; return 1;
      }
    done
    [[ "$(readlink -f "$CURRENT")" == "$PREVIOUS_CURRENT" ]] || {
      echo "RESEARCH_PRE_CUTOVER_POINTER_CHANGED" >&2; return 1;
    }
    echo "RESEARCH_PRODUCTION_PRE_CUTOVER_SCHEDULES_RESTORED=true" >&2
  }

  restore_pre_cutover_state() {
    if [[ "${CUTOVER_POINTER_SWITCHED:-false}" == false ]]; then
      restore_previous_schedules_only
    else
      require_idle_one_shots && restore_previous_runtime
    fi
  }

  restore_previous_runtime() {
    [[ -d "$PREVIOUS_CURRENT" && "$PREVIOUS_CURRENT" == "$RELEASES/$PREVIOUS_SHA" ]] || {
      echo "RESEARCH_ROLLBACK_RELEASE_MISSING" >&2; return 1;
    }
    [[ "$("${SUDO[@]}" git -C "$PREVIOUS_CURRENT" rev-parse HEAD 2>/dev/null || true)" == "$PREVIOUS_SHA" ]] || {
      echo "RESEARCH_ROLLBACK_PREVIOUS_SHA_MISMATCH" >&2; return 1;
    }
    "${SUDO[@]}" test -f "$ROLLBACK_ENV" || { echo "RESEARCH_ROLLBACK_ENV_BACKUP_MISSING" >&2; return 1; }
    local unit
    for unit in "${CORE_UNIT_DEFINITIONS[@]}"; do
      if [[ "${WAS_INSTALLED[$unit]:-0}" == 1 ]]; then
        "${SUDO[@]}" test -f "$ROLLBACK_UNITS/$unit" || {
          echo "RESEARCH_ROLLBACK_UNIT_BACKUP_MISSING:$unit" >&2; return 1;
        }
      fi
    done
    local rollback_link="$ROOT/.rollback-current-$$"
    "${SUDO[@]}" rm -f -- "$rollback_link" || return 1
    "${SUDO[@]}" ln -s -- "$PREVIOUS_CURRENT" "$rollback_link" || return 1
    "${SUDO[@]}" mv -Tf -- "$rollback_link" "$CURRENT" || return 1
    "${SUDO[@]}" cp -p "$ROLLBACK_ENV" "$ENV_FILE" || return 1
    for unit in "${CORE_UNIT_DEFINITIONS[@]}"; do
      if [[ "${WAS_INSTALLED[$unit]:-0}" == 1 ]]; then
        "${SUDO[@]}" install -o root -g root -m 0644 "$ROLLBACK_UNITS/$unit" "/etc/systemd/system/$unit" || return 1
      else
        "${SUDO[@]}" rm -f -- "/etc/systemd/system/$unit" || return 1
      fi
    done
    "${SUDO[@]}" systemctl daemon-reload || return 1
    local timer
    for timer in "${CORE_TIMERS[@]}" "${AI_TIMERS[@]}" "${AI_DAEMONS[@]}" "${WATCH_SERVICES[@]}"; do
      # Previously absent optional units must remain absent after rollback.
      if [[ "${WAS_LOAD_STATE[$timer]:-}" == not-found ]]; then continue; fi
      if [[ "${WAS_ENABLED[$timer]:-0}" == 1 ]]; then
        "${SUDO[@]}" systemctl enable "$timer" >/dev/null 2>&1 || return 1
      else
        "${SUDO[@]}" systemctl disable "$timer" >/dev/null 2>&1 || return 1
      fi
      if [[ "${WAS_ACTIVE[$timer]:-0}" == 1 ]]; then
        "${SUDO[@]}" systemctl start "$timer" >/dev/null 2>&1 || return 1
      else
        "${SUDO[@]}" systemctl stop "$timer" >/dev/null 2>&1 || return 1
      fi
    done
    [[ "$(readlink -f "$CURRENT")" == "$PREVIOUS_CURRENT" ]] || {
      echo "RESEARCH_ROLLBACK_CURRENT_PATH_MISMATCH" >&2; return 1;
    }
    [[ "$("${SUDO[@]}" git -C "$CURRENT" rev-parse HEAD 2>/dev/null || true)" == "$PREVIOUS_SHA" ]] || {
      echo "RESEARCH_ROLLBACK_CURRENT_SHA_MISMATCH" >&2; return 1;
    }
    "${SUDO[@]}" cmp -s "$ROLLBACK_ENV" "$ENV_FILE" || {
      echo "RESEARCH_ROLLBACK_ENV_MISMATCH" >&2; return 1;
    }
    for unit in "${CORE_UNIT_DEFINITIONS[@]}"; do
      if [[ "${WAS_INSTALLED[$unit]:-0}" == 1 ]]; then
        "${SUDO[@]}" cmp -s "$ROLLBACK_UNITS/$unit" "/etc/systemd/system/$unit" || {
          echo "RESEARCH_ROLLBACK_UNIT_BYTES_MISMATCH:$unit" >&2; return 1;
        }
      else
        "${SUDO[@]}" test ! -e "/etc/systemd/system/$unit" || {
          echo "RESEARCH_ROLLBACK_UNIT_UNEXPECTED:$unit" >&2; return 1;
        }
      fi
    done
    for timer in "${CORE_TIMERS[@]}" "${AI_TIMERS[@]}" "${AI_DAEMONS[@]}" "${WATCH_SERVICES[@]}"; do
      local restored_enabled=0 restored_active=0 restored_load_state
      restored_load_state="$("${SUDO[@]}" systemctl show "$timer" -p LoadState --value 2>/dev/null || true)"
      [[ "$restored_load_state" == "${WAS_LOAD_STATE[$timer]:-}" ]] || {
        echo "RESEARCH_ROLLBACK_UNIT_LOAD_STATE_MISMATCH:$timer" >&2; return 1;
      }
      if "${SUDO[@]}" systemctl is-enabled --quiet "$timer" 2>/dev/null; then restored_enabled=1; fi
      if "${SUDO[@]}" systemctl is-active --quiet "$timer" 2>/dev/null; then restored_active=1; fi
      [[ "$restored_enabled" == "${WAS_ENABLED[$timer]:-0}" && "$restored_active" == "${WAS_ACTIVE[$timer]:-0}" ]] || {
        echo "RESEARCH_ROLLBACK_UNIT_STATE_MISMATCH:$timer" >&2; return 1;
      }
    done
    printf '%s\n' "RESEARCH_PRODUCTION_ROLLBACK=RESTORED_VERIFIED" >&2
  }

  fail_safe() {
    local status=$?
    if (( status != 0 )) && [[ "${CUTOVER_MUTATION_STARTED:-false}" == true ]]; then
      local freeze_failed=false
      freeze_research_schedules || freeze_failed=true
      if [[ "$freeze_failed" == false ]] && restore_pre_cutover_state; then
        ROLLBACK_VERIFIED=true
        echo "RESEARCH_PRODUCTION_ACTIVATION_FAILED_ROLLED_BACK=true" >&2
      else
        status=86
        echo "RESEARCH_PRODUCTION_ROLLBACK_FAILED=true" >&2
        echo "RESEARCH_PRODUCTION_MANUAL_RECOVERY_REQUIRED=true" >&2
      fi
    elif (( status != 0 )); then
      echo "RESEARCH_PRODUCTION_PRE_CUTOVER_FAILURE_RUNTIME_UNCHANGED=true" >&2
    fi
    cleanup_transient
    if (( status == 0 )) || [[ "${ROLLBACK_VERIFIED:-false}" == true ]]; then
      "${SUDO[@]}" rm -f -- "$ROLLBACK_ENV" >/dev/null 2>&1 || true
      "${SUDO[@]}" rm -rf -- "$ROLLBACK_UNITS" >/dev/null 2>&1 || true
    else
      echo "RESEARCH_PRODUCTION_RECOVERY_BACKUPS_RETAINED=true" >&2
    fi
    # Bash ignores a plain return value as the process status of an EXIT
    # trap. Disarm and exit explicitly so ROLLBACK_FAILED propagates as 86.
    trap - EXIT
    exit "$status"
  }

  trap fail_safe EXIT

  release_is_valid() {
    local candidate="$1"
    [[ -d "$candidate" ]] || return 1
    "${SUDO[@]}" test -f "$candidate/research-production/bin/research-cycle.mjs" || return 1
    "${SUDO[@]}" test -f "$candidate/research-production/src/engine.mjs" || return 1
    "${SUDO[@]}" test -f "$candidate/research-production/deploy/research-production@.service" || return 1
    "${SUDO[@]}" test -f "$candidate/research-production/deploy/research-production-forward.timer" || return 1
    "${SUDO[@]}" test -f "$candidate/research-production/deploy/research-production-temporal-evidence.service" || return 1
    "${SUDO[@]}" test -f "$candidate/research-production/deploy/research-production-temporal-evidence.timer" || return 1
    "${SUDO[@]}" test -f "$candidate/research-production/deploy/research-production-factory-status.service" || return 1
    "${SUDO[@]}" test -f "$candidate/research-production/deploy/research-production-factory-status.timer" || return 1
    "${SUDO[@]}" test -f "$candidate/research-production/deploy/research-production-maintenance.service" || return 1
    "${SUDO[@]}" test -f "$candidate/research-production/deploy/research-production-maintenance.timer" || return 1
    "${SUDO[@]}" test -f "$candidate/research-production/bin/research-maintenance.mjs" || return 1
    local candidate_sha
    candidate_sha="$("${SUDO[@]}" git -C "$candidate" rev-parse HEAD 2>/dev/null || true)"
    [[ "$candidate_sha" == "$TARGET_SHA" ]]
  }

  if ! id investment-research >/dev/null 2>&1; then
    "${SUDO[@]}" useradd --system --home /nonexistent --shell /usr/sbin/nologin investment-research
  fi
  "${SUDO[@]}" install -d -o root -g root -m 0755 "$ROOT" "$RELEASES"
  "${SUDO[@]}" install -d -o investment-research -g investment-research -m 0750 "$STATE"
  "${SUDO[@]}" install -d -o root -g investment-research -m 0750 "$ENV_DIR"

  # Stage and verify the pinned release before freezing any old timers.
  # External checkout failures do not mutate the working Research runtime.

  if release_is_valid "$RELEASE"; then
    echo "RESEARCH_RELEASE_REUSED=true"
  else
    if [[ -e "$RELEASE" ]]; then
      echo "RESEARCH_RELEASE_REPAIR=required"
      "${SUDO[@]}" rm -rf -- "$RELEASE"
    fi
    cleanup_transient
    "${SUDO[@]}" git clone --quiet --filter=blob:none --no-checkout "$REPOSITORY_URL" "$STAGED_RELEASE"
    "${SUDO[@]}" git -C "$STAGED_RELEASE" fetch --quiet --depth 1 origin "$TARGET_SHA"
    local resolved
    resolved="$("${SUDO[@]}" git -C "$STAGED_RELEASE" rev-parse FETCH_HEAD^{commit})"
    [[ "$resolved" == "$TARGET_SHA" ]] || {
      echo "Exact SHA resolution mismatch" >&2
      exit 73
    }
    "${SUDO[@]}" git -C "$STAGED_RELEASE" checkout --quiet --detach "$TARGET_SHA"
    "${SUDO[@]}" chown -R root:root "$STAGED_RELEASE"
    if ! release_is_valid "$STAGED_RELEASE"; then
      echo "Staged Research release verification failed" >&2
      exit 75
    fi
    "${SUDO[@]}" mv -- "$STAGED_RELEASE" "$RELEASE"
    echo "RESEARCH_RELEASE_BUILT=true"
  fi

  if ! release_is_valid "$RELEASE"; then
    echo "Final Research release verification failed" >&2
    exit 76
  fi

  # Never interrupt an active Research one-shot for a release.
  require_idle_one_shots
  CUTOVER_MUTATION_STARTED=true
  # AI/YouTube and Market Watch stay disabled until their separately approved gates.
  freeze_research_schedules
  verify_timers_stopped "${CORE_TIMERS[@]}" "${AI_TIMERS[@]}" "${AI_DAEMONS[@]}" "${WATCH_SERVICES[@]}"
  require_idle_one_shots

  "${SUDO[@]}" rm -f -- "$NEXT_CURRENT"
  "${SUDO[@]}" ln -s -- "$RELEASE" "$NEXT_CURRENT"
  "${SUDO[@]}" mv -Tf -- "$NEXT_CURRENT" "$CURRENT"
  CUTOVER_POINTER_SWITCHED=true
  local resolved_current
  resolved_current="$(readlink -f "$CURRENT")"
  [[ "$resolved_current" == "$RELEASE" ]] || {
    echo "Research current symlink mismatch: expected=$RELEASE actual=$resolved_current" >&2
    exit 77
  }
  "${SUDO[@]}" test -f "$CURRENT/research-production/bin/research-cycle.mjs"
  local current_sha
  current_sha="$("${SUDO[@]}" git -C "$CURRENT" rev-parse HEAD)"
  [[ "$current_sha" == "$TARGET_SHA" ]] || {
    echo "Research current SHA mismatch: expected=$TARGET_SHA actual=$current_sha" >&2
    exit 78
  }

  # The Research service shares the host with the production app. Keep small
  # servers conservative; scale only when both CPU and memory are clearly ample.
  local concurrency=1
  if (( CPU_CORES >= 8 && MEM_AVAILABLE_BYTES >= 8589934592 && FREE_BYTES >= 21474836480 )); then
    concurrency=4
  elif (( CPU_CORES >= 4 && MEM_AVAILABLE_BYTES >= 4294967296 && FREE_BYTES >= 10737418240 )); then
    concurrency=2
  fi

  if [[ -n "${PAPER_FORWARD_RISK_POLICY_DECISION_PATH:-}" ]]; then
    case "$PAPER_FORWARD_RISK_POLICY_DECISION_PATH" in
      "$RELEASE"/market-prediction-lab/config/paper-risk-policy/*) ;;
      *)
        echo "PAPER_FORWARD_RISK_POLICY_DECISION_PATH must be pinned inside the exact Research release policy directory" >&2
        exit 64
        ;;
    esac
    [[ -f "$PAPER_FORWARD_RISK_POLICY_DECISION_PATH" && -r "$PAPER_FORWARD_RISK_POLICY_DECISION_PATH" ]] || {
      echo "CANONICAL_RISK_POLICY_DECISION_MISSING: approved Research policy decision missing or unreadable" >&2
      exit 64
    }
  fi

  local env_tmp
  env_tmp="$(mktemp)"
  # Preserve only safe Research tuning keys from the previous release.
  # SHA/path/trading/private/order authority fields are always regenerated below.
  if "${SUDO[@]}" test -f "$ENV_FILE"; then
    "${SUDO[@]}" grep -E '^(RESEARCH_TEMPORAL_CRYPTO_SYMBOLS|RESEARCH_TEMPORAL_LONG_SHORT_PERIOD|RESEARCH_ADAPTIVE_POLICY_RECORD_PATH|RESEARCH_DATA_FACTORY_EVIDENCE_PATH|RESEARCH_ADAPTIVE_EVIDENCE_CATALOG_PATH|RESEARCH_ADAPTIVE_DEVELOPMENT_DIAGNOSTICS_PATH|RESEARCH_ADAPTIVE_RUNTIME_BINDINGS_PATH)=' "$ENV_FILE" > "$env_tmp" || true
    if [[ -z "${PAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH:-}" ]]; then
      "${SUDO[@]}" grep -E '^PAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH=' "$ENV_FILE" >> "$env_tmp" || true
    fi
  fi
  cat >> "$env_tmp" <<ENV
RESEARCH_REPO_ROOT=$CURRENT
RESEARCH_STATE_ROOT=$STATE
RESEARCH_CODE_SHA=$TARGET_SHA
RESEARCH_CONCURRENCY=$concurrency
RESEARCH_MIN_FREE_BYTES=5368709120
GIT_CONFIG_COUNT=1
GIT_CONFIG_KEY_0=safe.directory
GIT_CONFIG_VALUE_0=$RELEASE
LIVE_TRADING=false
LIVE_TRADING_ENABLED=false
REAL_ORDER_ENABLED=false
REAL_TRADING_ENABLED=false
PRIVATE_API_ENABLED=false
PRIVATE_ACCOUNT_ACCESS=false
PRIVATE_TRADING_API_ALLOWED=false
ORDER_AUTHORITY=false
ORDER_SUBMISSION_ENABLED=false
ENV
  if [[ -n "${PAPER_FORWARD_RISK_POLICY_RECORD_PATH:-}" ]]; then
    # systemd EnvironmentFile double quotes require escaping backslashes/quotes.
    # printf data is never evaluated as shell code or expanded by systemd.
    local risk_policy_record_path="$PAPER_FORWARD_RISK_POLICY_RECORD_PATH"
    risk_policy_record_path="${risk_policy_record_path//\\/\\\\}"
    risk_policy_record_path="${risk_policy_record_path//\"/\\\"}"
    printf 'PAPER_FORWARD_RISK_POLICY_RECORD_PATH="%s"\n' "$risk_policy_record_path" >> "$env_tmp"
  fi
  if [[ -n "${PAPER_FORWARD_RISK_POLICY_DECISION_PATH:-}" ]]; then
    local risk_policy_decision_path="$PAPER_FORWARD_RISK_POLICY_DECISION_PATH"
    risk_policy_decision_path="${risk_policy_decision_path//\\/\\\\}"
    risk_policy_decision_path="${risk_policy_decision_path//\"/\\\"}"
    printf 'PAPER_FORWARD_RISK_POLICY_DECISION_PATH="%s"\n' "$risk_policy_decision_path" >> "$env_tmp"
  fi
  if [[ -n "${PAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH:-}" ]]; then
    local supplemental_cost_evidence_path="$PAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH"
    supplemental_cost_evidence_path="${supplemental_cost_evidence_path//\\/\\\\}"
    supplemental_cost_evidence_path="${supplemental_cost_evidence_path//\"/\\\"}"
    printf 'PAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH="%s"\n' "$supplemental_cost_evidence_path" >> "$env_tmp"
  fi
  "${SUDO[@]}" install -o root -g investment-research -m 0640 "$env_tmp" "$ENV_FILE"
  rm -f "$env_tmp"

  local unit
  for unit in research-production@.service research-production-temporal-evidence.service research-production-factory-status.service research-production-maintenance.service; do
    systemd-analyze verify "$CURRENT/research-production/deploy/$unit" >/dev/null
    "${SUDO[@]}" install -o root -g root -m 0644 \
      "$CURRENT/research-production/deploy/$unit" \
      "/etc/systemd/system/$unit"
  done
  local timer
  for timer in fast-historical long-history forward temporal-evidence factory-status maintenance; do
    systemd-analyze verify "$CURRENT/research-production/deploy/research-production-$timer.timer" >/dev/null
    "${SUDO[@]}" install -o root -g root -m 0644 \
      "$CURRENT/research-production/deploy/research-production-$timer.timer" \
      "/etc/systemd/system/research-production-$timer.timer"
  done
  "${SUDO[@]}" systemctl daemon-reload

  local -a RUN_AS_RESEARCH
  if command -v runuser >/dev/null 2>&1; then
    RUN_AS_RESEARCH=("${SUDO[@]}" runuser -u investment-research --)
  else
    RUN_AS_RESEARCH=(sudo -n -u investment-research)
  fi

  "${RUN_AS_RESEARCH[@]}" env -i \
    PATH=/usr/local/bin:/usr/bin:/bin \
    HOME=/nonexistent \
    LANG=C.UTF-8 \
    TZ=UTC \
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=safe.directory \
    GIT_CONFIG_VALUE_0="$RELEASE" \
    RESEARCH_REPO_ROOT="$CURRENT" \
    RESEARCH_STATE_ROOT="$STATE" \
    RESEARCH_CODE_SHA="$TARGET_SHA" \
    RESEARCH_CONCURRENCY="$concurrency" \
    RESEARCH_MIN_FREE_BYTES=5368709120 \
    LIVE_TRADING=false \
    PRIVATE_API_ENABLED=false \
    ORDER_AUTHORITY=false \
    node "$CURRENT/research-production/bin/research-cycle.mjs" preflight \
      --repo-root "$CURRENT" \
      --state-root "$STATE" \
      --research-sha "$TARGET_SHA"

  "${SUDO[@]}" systemctl enable --now "${CORE_TIMERS[@]}"

  for timer in "${CORE_TIMERS[@]}"; do
    "${SUDO[@]}" systemctl is-enabled --quiet "$timer"
    "${SUDO[@]}" systemctl is-active --quiet "$timer"
  done

  local app_sha_after
  app_sha_after="$(read_app_sha)"
  [[ "$app_sha_after" == "$APP_SHA_BEFORE" ]] || {
    echo "Existing application deployment SHA changed unexpectedly" >&2
    exit 74
  }

  printf '%s\n' \
    "RESEARCH_PRODUCTION_ACTIVATED=true" \
    "TARGET_SHA=$TARGET_SHA" \
    "CURRENT_RELEASE=$resolved_current" \
    "CONCURRENCY=$concurrency" \
    "APP_SHA_BEFORE=$APP_SHA_BEFORE" \
    "APP_SHA_AFTER=$app_sha_after" \
    "LIVE_TRADING=false" \
    "PRIVATE_API=false" \
    "ORDER_AUTHORITY=false"

  "${SUDO[@]}" systemctl list-timers --all "${CORE_TIMERS[@]}" --no-pager
  printf '%s\n' "AI_REVIEW_TIMER_ENABLED=false" "VIDEO_DISCOVERY_TIMER_ENABLED=false" "APPROVED_JOB_INTAKE_TIMER_ENABLED=false" "WORKSPACE_WORKER_ENABLED=false" "MARKET_WATCH_SERVICE_ENABLED=false"
}

case "$MODE" in
  preflight) preflight ;;
  activate) activate ;;
  *)
    echo "usage: activate-server.sh {preflight|activate}" >&2
    exit 64
    ;;
esac
