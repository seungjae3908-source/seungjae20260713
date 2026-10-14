#!/usr/bin/env bash
set -Eeuo pipefail

MODE="${1:-}"
TARGET_SHA="${TARGET_SHA:-}"
RESEARCH_ROOT="${RESEARCH_ROOT:-/opt/investment-research/current}"
STATE_ROOT="${STATE_ROOT:-/var/lib/investment-research-production}"
ENV_ROOT="${ENV_ROOT:-/etc/investment-research}"
PROVIDER_ENV="$ENV_ROOT/research-providers.env"
AI_POLICY_ENV="$ENV_ROOT/research-ai.env"
VIDEO_POLICY_ENV="$ENV_ROOT/research-video.env"
APP_ROOT="${APP_ROOT:-/opt/stock-app}"
CURRENT_RESEARCH_ROOT="${CURRENT_RESEARCH_ROOT:-/opt/investment-research/current}"
RESEARCH_RELEASES_ROOT="${RESEARCH_RELEASES_ROOT:-/opt/investment-research/releases}"
REPOSITORY_URL="${REPOSITORY_URL:-https://github.com/seungjae3908-source/seungjae20260713.git}"
RESEARCH_ENV="$ENV_ROOT/research-production.env"

if [[ ! "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "TARGET_SHA must be an exact lowercase 40-character SHA" >&2
  exit 64
fi

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
else
  sudo -n true
  SUDO=(sudo -n)
fi

timers=(
  research-production-ai-review.timer
  research-production-video-discovery.timer
  research-production-approved-job-intake.timer
)

daemon_services=(
  research-production-workspace-worker.service
)

services=(
  research-production-ai-review.service
  research-production-video-discovery.service
  research-production-approved-job-intake.service
)

managed_units=(
  "${timers[@]}"
  "${daemon_services[@]}"
  "${services[@]}"
)

TRANSITION_ROOT="${TRANSITION_ROOT:-/var/lib/investment-research-transition-v2}"
ISOLATED_VALIDATION_MAX_AGE_MS="${ISOLATED_VALIDATION_MAX_AGE_MS:-86400000}"
SYSTEMD_UNIT_ROOT="${SYSTEMD_UNIT_ROOT:-/etc/systemd/system}"
SYSTEMD_UNIT_OWNER="${SYSTEMD_UNIT_OWNER:-root:root}"
RUNTIME_SNAPSHOT_OWNER="${RUNTIME_SNAPSHOT_OWNER:-root:root}"
RUNTIME_SNAPSHOT_ENV_OWNER="${RUNTIME_SNAPSHOT_ENV_OWNER:-root:investment-research}"

require_idle_one_shots() {
  local service
  for service in "${services[@]}"; do
    local active_state load_state
    active_state="$("${SUDO[@]}" systemctl show "$service" -p ActiveState --value 2>/dev/null || true)"
    load_state="$("${SUDO[@]}" systemctl show "$service" -p LoadState --value 2>/dev/null || true)"
    [[ "$load_state" == 'loaded' || "$load_state" == 'masked' || "$load_state" == 'not-found' ]] || {
      echo "AI_RESEARCH_WORKLOAD_STATE_UNKNOWN:$service" >&2; return 1
    }
    case "$active_state" in
      inactive|failed) ;;
      *) echo "AI_RESEARCH_CUTOVER_BUSY:$service:$active_state" >&2; return 1 ;;
    esac
  done
}

disable_timers() {
  # Refuse before the first mutation when a previous-release one-shot is in
  # flight. A second check below closes the timer-trigger race.
  require_idle_one_shots
  "${SUDO[@]}" systemctl disable --now "${timers[@]}" >/dev/null 2>&1 || true
  local timer
  for timer in "${timers[@]}"; do
    if "${SUDO[@]}" systemctl is-active --quiet "$timer" 2>/dev/null; then
      echo "AI_RESEARCH_TIMER_STILL_ACTIVE:$timer" >&2
      return 1
    fi
    if "${SUDO[@]}" systemctl is-enabled --quiet "$timer" 2>/dev/null; then
      echo "AI_RESEARCH_TIMER_STILL_ENABLED:$timer" >&2
      return 1
    fi
  done
  "${SUDO[@]}" systemctl disable --now "${daemon_services[@]}" >/dev/null 2>&1 || true
  for service in "${daemon_services[@]}"; do
    if "${SUDO[@]}" systemctl is-active --quiet "$service" 2>/dev/null; then
      echo "AI_RESEARCH_DAEMON_STILL_ACTIVE:$service" >&2
      return 1
    fi
    if "${SUDO[@]}" systemctl is-enabled --quiet "$service" 2>/dev/null; then
      echo "AI_RESEARCH_DAEMON_STILL_ENABLED:$service" >&2
      return 1
    fi
  done
  # Never kill a previous-release one-shot. A bounded activation can be retried
  # after it finishes; interrupting it would corrupt continuity evidence.
  require_idle_one_shots
}

capture_runtime_snapshot() {
  local snapshot_root="$1"
  local unit_backup="$snapshot_root/units"
  local restore_unit_backup="$snapshot_root/restore-units"
  local env_backup="$snapshot_root/env"
  local previous_release previous_sha
  previous_release="$(readlink -f "$CURRENT_RESEARCH_ROOT" 2>/dev/null || true)"
  previous_sha="$(git -C "$previous_release" rev-parse HEAD 2>/dev/null || true)"
  [[ "$previous_release" == "$RESEARCH_RELEASES_ROOT/$previous_sha" && "$previous_sha" =~ ^[0-9a-f]{40}$ ]] || {
    echo "AI_RESEARCH_SNAPSHOT_RELEASE_INVALID:${previous_release:-missing}:${previous_sha:-missing}" >&2; return 1;
  }
  "${SUDO[@]}" install -d -o root -g root -m 0755 "$snapshot_root" "$unit_backup" "$restore_unit_backup"
  "${SUDO[@]}" install -d -o root -g investment-research -m 0750 "$env_backup"
  local manifest="$snapshot_root/runtime-before.tsv"
  printf 'kind\tname\texists\tenabled\tactive\tfragment\tsha256\texec_sha256\trestore_sha256\n' | "${SUDO[@]}" tee "$manifest" >/dev/null
  if "${SUDO[@]}" test -f "$RESEARCH_ENV"; then
    "${SUDO[@]}" install -o root -g investment-research -m 0640 "$RESEARCH_ENV" "$env_backup/research-production.env"
    "${SUDO[@]}" node - "$env_backup/research-production.env" "$previous_release" "$previous_sha" <<'NODE'
const fs = require('node:fs');
const [file, releaseRoot, releaseSha] = process.argv.slice(2);
let value = fs.readFileSync(file, 'utf8');
const replaceOne = (pattern, replacement, code) => {
  if ((value.match(pattern) ?? []).length !== 1) throw new Error(code);
  value = value.replace(pattern, replacement);
};
replaceOne(/^RESEARCH_REPO_ROOT=.*$/gmu, 'RESEARCH_REPO_ROOT=' + releaseRoot, 'AI_RESEARCH_SNAPSHOT_REPO_ROOT_INVALID');
replaceOne(/^RESEARCH_CODE_SHA=.*$/gmu, 'RESEARCH_CODE_SHA=' + releaseSha, 'AI_RESEARCH_SNAPSHOT_CODE_SHA_INVALID');
replaceOne(/^GIT_CONFIG_VALUE_0=.*$/gmu, 'GIT_CONFIG_VALUE_0=' + releaseRoot, 'AI_RESEARCH_SNAPSHOT_GIT_ROOT_INVALID');
for (const token of ['LIVE_TRADING=false','LIVE_TRADING_ENABLED=false','REAL_ORDER_ENABLED=false',
  'REAL_TRADING_ENABLED=false','PRIVATE_API_ENABLED=false','PRIVATE_ACCOUNT_ACCESS=false',
  'PRIVATE_TRADING_API_ALLOWED=false','ORDER_AUTHORITY=false','ORDER_SUBMISSION_ENABLED=false']) {
  if (!value.split(/\r?\n/u).includes(token)) throw new Error('AI_RESEARCH_SNAPSHOT_SAFETY_INVALID:' + token);
}
fs.writeFileSync(file, value, { mode: 0o640 });
NODE
  else
    echo "AI_RESEARCH_SNAPSHOT_RESEARCH_ENV_MISSING:$RESEARCH_ENV" >&2
    return 1
  fi
  local unit fragment enabled active unit_sha exec_sha restore_sha
  for unit in "${managed_units[@]}"; do
    fragment="$("${SUDO[@]}" systemctl show "$unit" -p FragmentPath --value 2>/dev/null || true)"
    enabled="$("${SUDO[@]}" systemctl is-enabled "$unit" 2>/dev/null || true)"
    active="$("${SUDO[@]}" systemctl is-active "$unit" 2>/dev/null || true)"
    enabled="${enabled:-not-found}"
    active="${active:-unknown}"
    case "$enabled" in enabled|enabled-runtime|disabled|static|indirect|masked|not-found) ;; *) echo "AI_RESEARCH_SNAPSHOT_UNIT_STATE_INVALID:$unit:$enabled" >&2; return 1;; esac
    case "$active" in active|activating|inactive|failed) ;; *) echo "AI_RESEARCH_SNAPSHOT_ACTIVE_STATE_INVALID:$unit:$active" >&2; return 1;; esac
    case " ${services[*]} " in
      *" $unit "*)
        case "$active" in inactive|failed) ;; *) echo "AI_RESEARCH_CUTOVER_BUSY:$unit:$active" >&2; return 1 ;; esac
        ;;
    esac
    if [[ -n "$fragment" ]]; then
      [[ "$fragment" == "$SYSTEMD_UNIT_ROOT/$unit" && -f "$fragment" && ! -L "$fragment" ]] || {
        echo "AI_RESEARCH_SNAPSHOT_FRAGMENT_UNSAFE:$unit:${fragment:-missing}" >&2; return 1;
      }
      [[ "$("${SUDO[@]}" stat -c '%U:%G:%a' "$fragment")" == "$SYSTEMD_UNIT_OWNER:644" ]] || {
        echo "AI_RESEARCH_SNAPSHOT_FRAGMENT_OWNERSHIP_INVALID:$unit" >&2; return 1;
      }
      "${SUDO[@]}" cp -p -- "$fragment" "$unit_backup/$unit"
      "${SUDO[@]}" node - "$unit_backup/$unit" "$restore_unit_backup/$unit" "$unit" "$previous_release" \
        "$env_backup/research-production.env" <<'NODE'
const fs = require('node:fs');
const [source, output, unit, releaseRoot, environmentFile] = process.argv.slice(2);
let value = fs.readFileSync(source, 'utf8');
if (unit.endsWith('.service')) {
  const working = value.match(/^WorkingDirectory=.*$/gmu) ?? [];
  if (working.length !== 1) throw new Error('AI_RESEARCH_SNAPSHOT_WORKING_DIRECTORY_INVALID:' + unit);
  value = value.replace(/^WorkingDirectory=.*$/mu, 'WorkingDirectory=' + releaseRoot);
  const envRows = value.match(/^EnvironmentFile=.*research-production\.env$/gmu) ?? [];
  if (envRows.length !== 1) throw new Error('AI_RESEARCH_SNAPSHOT_ENVIRONMENT_FILE_INVALID:' + unit);
  value = value.replace(/^EnvironmentFile=.*research-production\.env$/mu, 'EnvironmentFile=' + environmentFile);
}
fs.writeFileSync(output, value, { mode: 0o644, flag: 'wx' });
NODE
      unit_sha="$("${SUDO[@]}" sha256sum "$fragment" | awk '{print $1}')"
      exec_sha="$("${SUDO[@]}" systemctl show "$unit" -p ExecStart --value | sha256sum | awk '{print $1}')"
      restore_sha="$("${SUDO[@]}" sha256sum "$restore_unit_backup/$unit" | awk '{print $1}')"
      printf 'unit\t%s\ttrue\t%s\t%s\t%s\t%s\t%s\t%s\n' "$unit" "$enabled" "$active" "$fragment" "$unit_sha" "$exec_sha" "$restore_sha" \
        | "${SUDO[@]}" tee -a "$manifest" >/dev/null
    else
      printf 'unit\t%s\tfalse\t%s\t%s\t-\t-\t-\t-\n' "$unit" "$enabled" "$active" \
        | "${SUDO[@]}" tee -a "$manifest" >/dev/null
    fi
  done
  printf 'meta\tresearch-sha\ttrue\t-\t-\t%s\t-\t-\t-\n' "$previous_sha" | "${SUDO[@]}" tee -a "$manifest" >/dev/null
  printf 'meta\tresearch-release\ttrue\t-\t-\t%s\t-\t-\t-\n' "$previous_release" | "${SUDO[@]}" tee -a "$manifest" >/dev/null
  printf 'meta\tresearch-env-sha256\ttrue\t-\t-\t%s\t-\t-\t-\n' \
    "$("${SUDO[@]}" sha256sum "$env_backup/research-production.env" | awk '{print $1}')" \
    | "${SUDO[@]}" tee -a "$manifest" >/dev/null
  "${SUDO[@]}" chmod 0644 "$manifest"
  printf '%s\n' "AI_RESEARCH_RUNTIME_SNAPSHOT=$snapshot_root"
}

verify_runtime_snapshot() {
  local snapshot_root="$1"
  local manifest="$snapshot_root/runtime-before.tsv"
  [[ -f "$manifest" && ! -L "$manifest" && -f "$snapshot_root/env/research-production.env" ]] || {
    echo "AI_RESEARCH_ROLLBACK_MANIFEST_MISSING" >&2; return 1;
  }
  [[ "$(stat -c '%U:%G:%a' "$snapshot_root")" == "$RUNTIME_SNAPSHOT_OWNER:755" \
    && "$(stat -c '%U:%G:%a' "$manifest")" == "$RUNTIME_SNAPSHOT_OWNER:644" \
    && "$(stat -c '%U:%G:%a' "$snapshot_root/env")" == "$RUNTIME_SNAPSHOT_ENV_OWNER:750" \
    && "$(stat -c '%U:%G:%a' "$snapshot_root/env/research-production.env")" == "$RUNTIME_SNAPSHOT_ENV_OWNER:640" ]] || {
    echo "AI_RESEARCH_ROLLBACK_SNAPSHOT_OWNERSHIP_INVALID" >&2; return 1;
  }
  local kind name exists enabled active fragment expected_sha exec_sha restore_sha
  while IFS=$'\t' read -r kind name exists enabled active fragment expected_sha exec_sha restore_sha; do
    [[ "$kind" == unit && "$exists" == true ]] || continue
    [[ "$name" =~ ^research-production-[a-z0-9@.-]+$ \
      && "$expected_sha" =~ ^[a-f0-9]{64}$ && "$restore_sha" =~ ^[a-f0-9]{64}$ \
      && -f "$snapshot_root/units/$name" && ! -L "$snapshot_root/units/$name" \
      && -f "$snapshot_root/restore-units/$name" && ! -L "$snapshot_root/restore-units/$name" \
      && "$(sha256sum "$snapshot_root/units/$name" | awk '{print $1}')" == "$expected_sha" \
      && "$(sha256sum "$snapshot_root/restore-units/$name" | awk '{print $1}')" == "$restore_sha" ]] || {
      echo "AI_RESEARCH_ROLLBACK_UNIT_BACKUP_HASH_MISMATCH:$name" >&2; return 1;
    }
  done < "$manifest"
  local previous_sha previous_release
  previous_sha="$(awk -F '\t' '$1=="meta" && $2=="research-sha" {print $6}' "$manifest")"
  previous_release="$(awk -F '\t' '$1=="meta" && $2=="research-release" {print $6}' "$manifest")"
  local expected_env_sha
  expected_env_sha="$(awk -F '\t' '$1=="meta" && $2=="research-env-sha256" {print $6}' "$manifest")"
  [[ "$previous_sha" =~ ^[0-9a-f]{40}$ && "$previous_release" == "$RESEARCH_RELEASES_ROOT/$previous_sha" \
    && "$(git -C "$previous_release" rev-parse HEAD 2>/dev/null || true)" == "$previous_sha" \
    && "$expected_env_sha" =~ ^[a-f0-9]{64}$ \
    && "$(sha256sum "$snapshot_root/env/research-production.env" | awk '{print $1}')" == "$expected_env_sha" ]] || {
    echo "AI_RESEARCH_ROLLBACK_RELEASE_SHA_MISMATCH" >&2; return 1;
  }
}

restore_runtime_snapshot() {
  local snapshot_root="$1"
  local manifest="$snapshot_root/runtime-before.tsv"
  verify_runtime_snapshot "$snapshot_root"
  local previous_sha previous_release
  previous_sha="$(awk -F '\t' '$1=="meta" && $2=="research-sha" {print $6}' "$manifest")"
  previous_release="$(awk -F '\t' '$1=="meta" && $2=="research-release" {print $6}' "$manifest")"
  "${SUDO[@]}" systemctl disable --now "${timers[@]}" "${daemon_services[@]}" >/dev/null 2>&1 || true
  local running_service
  for running_service in "${services[@]}"; do
    local running_state
    running_state="$("${SUDO[@]}" systemctl show "$running_service" -p ActiveState --value 2>/dev/null || true)"
    case "$running_state" in
      inactive|failed) ;;
      *) echo "AI_RESEARCH_ROLLBACK_WORKLOAD_BUSY:$running_service:$running_state" >&2; return 1 ;;
    esac
  done
  local kind name exists enabled active fragment expected_sha exec_sha restore_sha
  while IFS=$'\t' read -r kind name exists enabled active fragment expected_sha exec_sha restore_sha; do
    [[ "$kind" == unit ]] || continue
    if [[ "$exists" == true ]]; then
      [[ -f "$snapshot_root/units/$name" && -f "$snapshot_root/restore-units/$name" ]] || {
        echo "AI_RESEARCH_ROLLBACK_UNIT_BACKUP_MISSING:$name" >&2; return 1;
      }
      [[ "$("${SUDO[@]}" sha256sum "$snapshot_root/units/$name" | awk '{print $1}')" == "$expected_sha" \
        && "$("${SUDO[@]}" sha256sum "$snapshot_root/restore-units/$name" | awk '{print $1}')" == "$restore_sha" ]] || {
        echo "AI_RESEARCH_ROLLBACK_UNIT_BACKUP_HASH_MISMATCH:$name" >&2; return 1;
      }
      "${SUDO[@]}" install -o root -g root -m 0644 "$snapshot_root/restore-units/$name" "$SYSTEMD_UNIT_ROOT/$name"
    else
      "${SUDO[@]}" rm -f -- "$SYSTEMD_UNIT_ROOT/$name"
    fi
  done < "$manifest"
  "${SUDO[@]}" test -f "$snapshot_root/env/research-production.env" || {
    echo "AI_RESEARCH_ROLLBACK_ENV_BACKUP_MISSING:research-production.env" >&2; return 1;
  }
  "${SUDO[@]}" systemctl daemon-reload
  while IFS=$'\t' read -r kind name exists enabled active fragment expected_sha exec_sha restore_sha; do
    [[ "$kind" == unit ]] || continue
    case "$enabled" in
      enabled) "${SUDO[@]}" systemctl enable "$name" >/dev/null ;;
      enabled-runtime) "${SUDO[@]}" systemctl enable --runtime "$name" >/dev/null ;;
      disabled|static|indirect|masked|not-found) ;;
      *) echo "AI_RESEARCH_ROLLBACK_UNIT_STATE_INVALID:$name:$enabled" >&2; return 1 ;;
    esac
    case "$active" in
      active|activating) "${SUDO[@]}" systemctl start "$name" >/dev/null ;;
      inactive|failed) ;;
      *) echo "AI_RESEARCH_ROLLBACK_ACTIVE_STATE_INVALID:$name:$active" >&2; return 1 ;;
    esac
  done < "$manifest"
  while IFS=$'\t' read -r kind name exists enabled active fragment expected_sha exec_sha restore_sha; do
    [[ "$kind" == unit ]] || continue
    local actual_enabled actual_active actual_sha actual_exec_sha
    actual_enabled="$("${SUDO[@]}" systemctl is-enabled "$name" 2>/dev/null || true)"
    actual_active="$("${SUDO[@]}" systemctl is-active "$name" 2>/dev/null || true)"
    actual_enabled="${actual_enabled:-not-found}"
    actual_active="${actual_active:-unknown}"
    if [[ "$enabled" == enabled || "$enabled" == enabled-runtime ]]; then
      [[ "$actual_enabled" == enabled || "$actual_enabled" == enabled-runtime ]] || {
        echo "AI_RESEARCH_ROLLBACK_ENABLE_VERIFY_FAILED:$name:$actual_enabled" >&2; return 1;
      }
    elif [[ "$actual_enabled" == enabled || "$actual_enabled" == enabled-runtime ]]; then
      echo "AI_RESEARCH_ROLLBACK_ENABLE_VERIFY_FAILED:$name:$actual_enabled" >&2; return 1
    fi
    if [[ "$active" == active || "$active" == activating ]]; then
      [[ "$actual_active" == active || "$actual_active" == activating ]] || {
        echo "AI_RESEARCH_ROLLBACK_ACTIVE_VERIFY_FAILED:$name:$actual_active" >&2; return 1;
      }
    elif [[ "$actual_active" == active || "$actual_active" == activating ]]; then
      echo "AI_RESEARCH_ROLLBACK_ACTIVE_VERIFY_FAILED:$name:$actual_active" >&2; return 1
    fi
    if [[ "$exists" == true ]]; then
      actual_sha="$("${SUDO[@]}" sha256sum "$SYSTEMD_UNIT_ROOT/$name" | awk '{print $1}')"
      [[ "$actual_sha" == "$restore_sha" ]] || { echo "AI_RESEARCH_ROLLBACK_UNIT_HASH_MISMATCH:$name" >&2; return 1; }
      actual_exec_sha="$("${SUDO[@]}" systemctl show "$name" -p ExecStart --value | sha256sum | awk '{print $1}')"
      [[ "$actual_exec_sha" == "$exec_sha" ]] || { echo "AI_RESEARCH_ROLLBACK_EXEC_HASH_MISMATCH:$name" >&2; return 1; }
      if [[ "$name" == *.service ]]; then
        [[ "$("${SUDO[@]}" systemctl show "$name" -p WorkingDirectory --value)" == "$previous_release" \
          && "$(grep -Fxc "EnvironmentFile=$snapshot_root/env/research-production.env" "$SYSTEMD_UNIT_ROOT/$name")" == 1 ]] || {
          echo "AI_RESEARCH_ROLLBACK_EXECUTION_BINDING_MISMATCH:$name" >&2; return 1;
        }
      fi
    fi
  done < "$manifest"
  [[ "$previous_sha" =~ ^[0-9a-f]{40}$ && "$previous_release" == "$RESEARCH_RELEASES_ROOT/$previous_sha" \
    && "$(git -C "$previous_release" rev-parse HEAD 2>/dev/null || true)" == "$previous_sha" ]] || {
    echo "AI_RESEARCH_ROLLBACK_RELEASE_SHA_MISMATCH" >&2; return 1;
  }
  printf '%s\n' "AI_RESEARCH_ROLLBACK=RESTORED" "AI_RESEARCH_PREVIOUS_SERVICE_PRESERVED=true" >&2
}

research_sha() {
  git -C "$RESEARCH_ROOT" rev-parse HEAD 2>/dev/null || true
}

require_exact_research_release() {
  [[ -d "$RESEARCH_ROOT" ]]
  local resolved current
  resolved="$(readlink -f "$RESEARCH_ROOT")"
  current="$(research_sha)"
  [[ "$current" == "$TARGET_SHA" ]] || {
    echo "AI_RESEARCH_CURRENT_SHA_MISMATCH:expected=$TARGET_SHA:actual=${current:-missing}" >&2
    exit 65
  }
  case "$resolved" in
    /opt/investment-research/releases/"$TARGET_SHA") ;;
    *)
      echo "AI_RESEARCH_CURRENT_RELEASE_PATH_MISMATCH:$resolved" >&2
      exit 66
      ;;
  esac
}

require_research_safety_env() {
  local file="$ENV_ROOT/research-production.env"
  [[ -r "$file" ]] || {
    echo "AI_RESEARCH_PRODUCTION_ENV_MISSING" >&2
    exit 67
  }
  for token in     'LIVE_TRADING=false'     'LIVE_TRADING_ENABLED=false'     'REAL_ORDER_ENABLED=false'     'REAL_TRADING_ENABLED=false'     'PRIVATE_API_ENABLED=false'     'PRIVATE_ACCOUNT_ACCESS=false'     'PRIVATE_TRADING_API_ALLOWED=false'     'ORDER_AUTHORITY=false'     'ORDER_SUBMISSION_ENABLED=false'; do
    grep -Fxq "$token" "$file" || {
      echo "AI_RESEARCH_UNSAFE_ENV:$token" >&2
      exit 68
    }
  done
}

provider_credentials_present() {
  [[ -e "$PROVIDER_ENV" ]] || return 1
  "${SUDO[@]}" node - "$PROVIDER_ENV" <<'NODE'
const fs = require('node:fs');
const { parseEnv } = require('node:util');
const env = parseEnv(fs.readFileSync(process.argv[2], 'utf8'));
const allowed = new Set(['YOUTUBE_DATA_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','GEMINI_MODEL','GROQ_API_KEY','GROQ_MODEL']);
for (const key of Object.keys(env)) if (!allowed.has(key)) process.exit(3);
const keyPattern = /^[A-Za-z0-9_.-]{8,512}$/u;
const present = (key) => typeof env[key] === 'string' && keyPattern.test(env[key].trim());
const geminiValues = ['GEMINI_API_KEY','GOOGLE_API_KEY'].map(k => env[k]?.trim()).filter(Boolean);
if (!present('YOUTUBE_DATA_API_KEY') || !present('GROQ_API_KEY') || geminiValues.length < 1
  || new Set(geminiValues).size !== 1 || !geminiValues.every(v => keyPattern.test(v))) process.exit(2);
process.stdout.write(JSON.stringify({
  schemaVersion:'research-provider-credential-readiness-v1',
  providers:{youtube:'PRESENT',gemini:'PRESENT',groq:'PRESENT'},
  credentialValuesExposed:false,executionAuthority:'NONE'
})+'\n');
NODE
}

provider_env_ready() {
  provider_credentials_present >/dev/null || return 1
  "${SUDO[@]}" node - "$PROVIDER_ENV" <<'NODE'
const fs = require('node:fs');
const { parseEnv } = require('node:util');
const env = parseEnv(fs.readFileSync(process.argv[2], 'utf8'));
if (String(env.GEMINI_MODEL ?? '').trim() !== 'gemini-3.1-flash-lite'
  || String(env.GROQ_MODEL ?? '').trim() !== 'openai/gpt-oss-20b') process.exit(2);
process.stdout.write(JSON.stringify({
  schemaVersion:'research-provider-env-readiness-v2',
  providers:{youtube:'PRESENT',gemini:'PRESENT',groq:'PRESENT'},
  models:{gemini:'EXPLICIT_FIXED',groq:'EXPLICIT_FIXED'},
  credentialValuesExposed:false,executionAuthority:'NONE'
})+'\n');
NODE
}

require_existing_provider_env() {
  provider_env_ready
  [[ "$("${SUDO[@]}" stat -c '%U:%G:%a' "$PROVIDER_ENV")" == 'root:investment-research:640' ]] || {
    echo "AI_RESEARCH_PROVIDER_ENV_OWNERSHIP_INVALID" >&2
    return 1
  }
  if command -v runuser >/dev/null 2>&1; then
    "${SUDO[@]}" runuser -u investment-research -- test -r "$PROVIDER_ENV"
  else
    sudo -n -u investment-research test -r "$PROVIDER_ENV"
  fi
}

provider_preflight() (
  if provider_env_ready >/dev/null; then
    provider_env_ready
    return 0
  fi
  if provider_credentials_present >/dev/null; then
    provider_credentials_present
    printf '%s\n' "AI_RESEARCH_PROVIDER_MODEL_REPAIR_REQUIRED=true"
    return 0
  fi
  local evidence
  evidence="$(mktemp)"
  # A RETURN trap survives this helper and later sees its expired local.
  # The subshell keeps cleanup and its EXIT trap out of the caller's traps.
  trap 'rm -f -- "$evidence"' EXIT
  "${SUDO[@]}" node "$RESEARCH_ROOT/research-production/bin/research-provider-bootstrap.mjs" preflight \
    --app-root "$APP_ROOT" \
    --process-name stock-app > "$evidence"
  node - "$evidence" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const providers = value?.providers ?? {};
if (value?.schemaVersion !== 'research-provider-bootstrap-v1'
  || value?.fullStackReady !== true
  || providers.youtube !== 'PRESENT'
  || providers.gemini !== 'PRESENT'
  || providers.groq !== 'PRESENT'
  || !Array.isArray(value?.conflicts)
  || value.conflicts.length !== 0
  || value?.credentialValuesExposed !== false
  || value?.executionAuthority !== 'NONE'
  || value?.liveTrading !== false
  || value?.privateTradingApiAllowed !== false) {
  throw new Error('AI_RESEARCH_PROVIDER_PREFLIGHT_NOT_READY');
}
NODE
)

normalize_existing_provider_env() {
  provider_credentials_present >/dev/null
  local tmp
  tmp="$(mktemp)"
  "${SUDO[@]}" node - "$PROVIDER_ENV" "$tmp" <<'NODE'
const fs = require('node:fs');
const { parseEnv } = require('node:util');
const env = parseEnv(fs.readFileSync(process.argv[2], 'utf8'));
const geminiValues = ['GEMINI_API_KEY','GOOGLE_API_KEY'].map(k => env[k]?.trim()).filter(Boolean);
if (geminiValues.length < 1 || new Set(geminiValues).size !== 1) throw new Error('PROVIDER_GEMINI_CONFIGURATION_UNRESOLVED');
const rows = [
  '# Research provider-only environment. Trading/account secrets are forbidden.',
  'YOUTUBE_DATA_API_KEY=' + env.YOUTUBE_DATA_API_KEY.trim(),
  'GEMINI_API_KEY=' + geminiValues[0],
  'GEMINI_MODEL=gemini-3.1-flash-lite',
  'GROQ_API_KEY=' + env.GROQ_API_KEY.trim(),
  'GROQ_MODEL=openai/gpt-oss-20b',
  '',
];
fs.writeFileSync(process.argv[3], rows.join('\n'), {mode:0o600,flag:'w'});
NODE
  "${SUDO[@]}" install -o root -g investment-research -m 0640 "$tmp" "$PROVIDER_ENV"
  rm -f "$tmp"
  provider_env_ready >/dev/null
}

materialize_or_reuse_provider_env() {
  if provider_env_ready >/dev/null; then
    printf '%s\n' "AI_RESEARCH_PROVIDER_ENV_SOURCE=EXISTING_RESEARCH_PROVIDER_ENV"
    return 0
  fi
  if provider_credentials_present >/dev/null; then
    normalize_existing_provider_env
    printf '%s\n' "AI_RESEARCH_PROVIDER_ENV_SOURCE=EXISTING_RESEARCH_PROVIDER_ENV_MODELS_NORMALIZED"
    return 0
  fi
  "${SUDO[@]}" node "$RESEARCH_ROOT/research-production/bin/research-provider-bootstrap.mjs" materialize \
    --app-root "$APP_ROOT" \
    --process-name stock-app \
    --output-root "$ENV_ROOT" >/dev/null
  provider_env_ready >/dev/null
  printf '%s\n' "AI_RESEARCH_PROVIDER_ENV_SOURCE=BOOTSTRAP_MATERIALIZED"
}

require_runtime_policy_env() {
  [[ -r "$AI_POLICY_ENV" ]] || {
    echo "AI_RESEARCH_POLICY_ENV_MISSING:$AI_POLICY_ENV" >&2
    exit 71
  }
  [[ -r "$VIDEO_POLICY_ENV" ]] || {
    echo "VIDEO_RESEARCH_POLICY_ENV_MISSING:$VIDEO_POLICY_ENV" >&2
    exit 72
  }

  "${SUDO[@]}" node --input-type=module - "$AI_POLICY_ENV" "$VIDEO_POLICY_ENV" \
    "$RESEARCH_ROOT/research-production/src/research-video-discovery-policy.mjs" <<'NODE'
import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
const { resolveResearchVideoDiscoveryQueries } = await import(pathToFileURL(process.argv[4]).href);

const aiPath = process.argv[2];
const videoPath = process.argv[3];
const ai = parseEnv(fs.readFileSync(aiPath, 'utf8'));
const video = parseEnv(fs.readFileSync(videoPath, 'utf8'));

const selected = String(ai.AI_CHAT_PROVIDER ?? '').trim().toLowerCase();
const allowedAiKeys = new Set([
  'RESEARCH_AI_FREE_TIER_CONFIRMED',
  'AI_CHAT_PROVIDER',
  'RESEARCH_AI_MAX_CALLS_PER_SCAN',
]);
const allowedVideoKeys = new Set([
  'RESEARCH_VIDEO_DISCOVERY_APPROVED',
  'RESEARCH_VIDEO_DISCOVERY_MAX_RESULTS',
  'RESEARCH_VIDEO_DISCOVERY_QUERIES_JSON',
  'RESEARCH_VIDEO_DISCOVERY_REGION_CODE',
  'RESEARCH_VIDEO_DISCOVERY_RELEVANCE_LANGUAGE',
  'RESEARCH_VIDEO_DISCOVERY_PUBLISHED_AFTER_HOURS',
]);

for (const key of Object.keys(ai)) {
  if (!allowedAiKeys.has(key)) throw new Error('AI_RESEARCH_POLICY_UNSUPPORTED_KEY:' + key);
}
for (const key of Object.keys(video)) {
  if (!allowedVideoKeys.has(key)) throw new Error('VIDEO_RESEARCH_POLICY_UNSUPPORTED_KEY:' + key);
}

if (String(ai.RESEARCH_AI_FREE_TIER_CONFIRMED ?? '').trim().toLowerCase() !== 'true') {
  throw new Error('AI_RESEARCH_FREE_TIER_CONFIRMATION_REQUIRED');
}
if (!['gemini','groq'].includes(selected)) {
  throw new Error('AI_RESEARCH_PROVIDER_SELECTION_REQUIRED');
}
const maxCalls = Number(ai.RESEARCH_AI_MAX_CALLS_PER_SCAN ?? '3');
if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 3) {
  throw new Error('AI_RESEARCH_MAX_CALLS_INVALID');
}

if (String(video.RESEARCH_VIDEO_DISCOVERY_APPROVED ?? '').trim().toLowerCase() !== 'true') {
  throw new Error('VIDEO_RESEARCH_DISCOVERY_APPROVAL_REQUIRED');
}
const maxResults = Number(video.RESEARCH_VIDEO_DISCOVERY_MAX_RESULTS ?? '3');
if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 3) {
  throw new Error('VIDEO_RESEARCH_MAX_RESULTS_INVALID');
}
const queries = resolveResearchVideoDiscoveryQueries(video);
const region = String(video.RESEARCH_VIDEO_DISCOVERY_REGION_CODE ?? '').trim().toUpperCase();
if (region && !/^[A-Z]{2}$/.test(region)) {
  throw new Error('VIDEO_RESEARCH_REGION_INVALID');
}
const language = String(video.RESEARCH_VIDEO_DISCOVERY_RELEVANCE_LANGUAGE ?? '').trim();
if (language && !/^[A-Za-z]{2,3}(?:-[A-Za-z]{2})?$/.test(language)) {
  throw new Error('VIDEO_RESEARCH_LANGUAGE_INVALID');
}
const publishedAfterHours = Number(video.RESEARCH_VIDEO_DISCOVERY_PUBLISHED_AFTER_HOURS ?? '720');
if (!Number.isSafeInteger(publishedAfterHours) || publishedAfterHours < 1 || publishedAfterHours > 2160) {
  throw new Error('VIDEO_RESEARCH_FRESHNESS_WINDOW_INVALID');
}

process.stdout.write(JSON.stringify({
  schemaVersion: 'research-ai-runtime-policy-readiness-v1',
  ai: {
    freeTierConfirmed: true,
    provider: selected,
    maxCalls,
  },
  video: {
    approved: true,
    maxResults,
    queryCount: queries.length,
    region: region || null,
    language: language || null,
    publishedAfterHours,
  },
  credentialValuesExposed: false,
  executionAuthority: 'NONE'
}) + '\n');
NODE

  if command -v runuser >/dev/null 2>&1; then
    "${SUDO[@]}" runuser -u investment-research -- test -r "$AI_POLICY_ENV"
    "${SUDO[@]}" runuser -u investment-research -- test -r "$VIDEO_POLICY_ENV"
  else
    sudo -n -u investment-research test -r "$AI_POLICY_ENV"
    sudo -n -u investment-research test -r "$VIDEO_POLICY_ENV"
  fi
}

print_ai_diagnostic() {
  "${SUDO[@]}" node "$RESEARCH_ROOT/research-production/bin/research-ai-diagnostic.mjs" \
    --state-root "$STATE_ROOT" \
    --research-sha "$TARGET_SHA" >&2 || true
}

print_forward_runtime_diagnostic() {
  "${SUDO[@]}" node "$RESEARCH_ROOT/research-production/bin/research-forward-runtime-diagnostic.mjs" \
    --state-root "$STATE_ROOT" \
    --research-sha "$TARGET_SHA" \
    --env-file "$ENV_ROOT/research-production.env" || true
}

require_current_sha_ai_evidence_ready() {
  "${SUDO[@]}" node - "$STATE_ROOT" "$TARGET_SHA" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const stateRoot = process.argv[2];
const targetSha = process.argv[3];
const allowedStatus = new Set(['complete', 'partial_failure', 'blocked_data']);
const current = [];
for (const profile of ['forward', 'fast-historical', 'long-history']) {
  const file = path.join(stateRoot, 'latest', profile + '.json');
  if (!fs.existsSync(file)) continue;
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('AI_RESEARCH_CURRENT_SHA_EVIDENCE_JSON_INVALID:' + profile); }
  if (String(value?.researchSha ?? '').toLowerCase() !== targetSha) continue;
  if (value?.schemaVersion !== 'research-production-cycle-v1'
    || value?.profile !== profile
    || !allowedStatus.has(String(value?.status ?? ''))) {
    throw new Error('AI_RESEARCH_CURRENT_SHA_EVIDENCE_INVALID:' + profile);
  }
  current.push(profile);
}
if (!current.includes('forward')) throw new Error('AI_RESEARCH_CURRENT_SHA_FORWARD_EVIDENCE_MISSING');
process.stdout.write(JSON.stringify({
  schemaVersion: 'research-ai-current-sha-readiness-v1',
  targetSha, currentProfiles: current, forwardReady: true, executionAuthority: 'NONE'
}) + '\n');
NODE
}

refresh_current_sha_forward_evidence() {
  local service="research-production@forward.service"
  "${SUDO[@]}" systemctl start "$service"
  local result status
  result="$("${SUDO[@]}" systemctl show "$service" -p Result --value)"
  status="$("${SUDO[@]}" systemctl show "$service" -p ExecMainStatus --value)"
  if [[ "$result" != "success" || "$status" != "0" ]]; then
    print_forward_runtime_diagnostic
    echo "AI_RESEARCH_CURRENT_SHA_FORWARD_REFRESH_FAILED:$service:result=$result:status=$status" >&2
    return 1
  fi
  require_current_sha_ai_evidence_ready
}

verify_workspace_worker_health() (
  local evidence
  evidence="$(mktemp)"
  trap 'rm -f -- "$evidence"' EXIT
  local -a research_user_cmd
  if command -v runuser >/dev/null 2>&1; then
    research_user_cmd=("${SUDO[@]}" runuser -u investment-research --)
  else
    research_user_cmd=(sudo -n -u investment-research)
  fi
  local attempt
  for attempt in {1..10}; do
    if "${research_user_cmd[@]}" \
      /usr/bin/env node "$RESEARCH_ROOT/packages/external-research/scripts/run-research-worker-v9.mjs" \
      --root "$STATE_ROOT/workspace-worker" --status >"$evidence" 2>/dev/null; then
      if node - "$evidence" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (value?.schemaVersion !== 'research-worker-status-v9'
  || value?.available !== true
  || value?.workerState !== 'ACTIVE'
  || !value?.lastHeartbeatAt
  || value?.authority?.executionAuthority !== 'NONE'
  || value?.authority?.providerCallsFromStatus !== 0) process.exit(2);
NODE
      then
        return 0
      fi
    fi
    sleep 1
  done
  echo "AI_RESEARCH_WORKSPACE_WORKER_HEARTBEAT_NOT_ACTIVE" >&2
  return 1
)

verify_one_shot_evidence() {
  local started_ms="$1"
  local evidence_root="${2:-$STATE_ROOT}"
  "${SUDO[@]}" node - "$evidence_root" "$TARGET_SHA" "$started_ms" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const stateRoot = process.argv[2];
const targetSha = process.argv[3];
const startedMs = Number(process.argv[4]);

const aiPath = path.join(stateRoot, 'ai-review', 'latest.json');
const videoPath = path.join(stateRoot, 'video-research', 'latest.json');

const ai = JSON.parse(fs.readFileSync(aiPath, 'utf8'));
const video = JSON.parse(fs.readFileSync(videoPath, 'utf8'));

if (ai?.schemaVersion !== 'research-production-ai-scan-v1') {
  throw new Error('AI_RESEARCH_ONE_SHOT_SCHEMA_INVALID');
}
if (ai?.researchSha !== targetSha) {
  throw new Error('AI_RESEARCH_ONE_SHOT_SHA_MISMATCH');
}
const acceptableAiStatus = new Set(['COMPLETE', 'PARTIAL_COVERAGE_COMPLETE']);
if (!acceptableAiStatus.has(String(ai?.status ?? ''))) {
  const leaf = [...(Array.isArray(ai?.blockedProfiles) ? ai.blockedProfiles : []),
    ...(Array.isArray(ai?.deferredProfiles) ? ai.deferredProfiles : [])]
    .map((row) => String(row?.profile ?? 'unknown') + '=' + String(row?.reason ?? 'UNKNOWN'))
    .slice(0, 6).join(',');
  throw new Error('AI_RESEARCH_ONE_SHOT_NOT_READY:' + String(ai?.status ?? 'MISSING') + (leaf ? ':' + leaf : ''));
}
if (!['gemini','groq'].includes(String(ai?.provider ?? ''))) {
  throw new Error('AI_RESEARCH_ONE_SHOT_PROVIDER_INVALID');
}
if (!Number.isSafeInteger(ai?.providerNetworkCalls) || ai.providerNetworkCalls < 0 || ai.providerNetworkCalls > 3
  || !Number.isSafeInteger(ai?.cacheHits) || ai.cacheHits < 0 || ai.cacheHits > 3
  || (ai.providerNetworkCalls < 1 && ai.cacheHits < 1)) {
  throw new Error('AI_RESEARCH_ONE_SHOT_PROVIDER_OR_CACHE_PROOF_MISSING');
}
if (!Array.isArray(ai?.reviews) || ai.reviews.length < 1) {
  throw new Error('AI_RESEARCH_ONE_SHOT_REVIEW_MISSING');
}
if (!Array.isArray(ai?.blockedProfiles) || ai.blockedProfiles.length !== 0) {
  throw new Error('AI_RESEARCH_ONE_SHOT_BLOCKED_PROFILE');
}
if (!Number.isSafeInteger(ai?.observedAt) || ai.observedAt < startedMs) {
  throw new Error('AI_RESEARCH_ONE_SHOT_STALE');
}
if (ai?.safety?.executionAuthority !== 'NONE'
  || ai?.safety?.liveTrading !== false
  || ai?.safety?.privateTradingApiAllowed !== false
  || ai?.safety?.orderAllowed !== false
  || ai?.evidenceCredit !== 0
  || ai?.profitabilityProven !== false) {
  throw new Error('AI_RESEARCH_ONE_SHOT_SAFETY_INVALID');
}

if (video?.schemaVersion !== 'research-video-discovery-scan-v1') {
  throw new Error('VIDEO_DISCOVERY_ONE_SHOT_SCHEMA_INVALID');
}
if (video?.researchSha !== targetSha) {
  throw new Error('VIDEO_DISCOVERY_ONE_SHOT_SHA_MISMATCH');
}
if (video?.status !== 'COMPLETE') {
  throw new Error('VIDEO_DISCOVERY_ONE_SHOT_NOT_COMPLETE:' + String(video?.status ?? 'MISSING'));
}
if (video?.provider !== 'YOUTUBE_DATA_API_V3') {
  throw new Error('VIDEO_DISCOVERY_ONE_SHOT_PROVIDER_INVALID');
}
if (!Number.isSafeInteger(video?.providerNetworkCalls) || video.providerNetworkCalls < 1 || video.providerNetworkCalls > 2) {
  throw new Error('VIDEO_DISCOVERY_ONE_SHOT_NETWORK_PROOF_MISSING');
}
if (!Number.isSafeInteger(video?.sourceCount) || video.sourceCount < 0) {
  throw new Error('VIDEO_DISCOVERY_ONE_SHOT_SOURCE_COUNT_INVALID');
}
const videoObservedAtMs = Date.parse(String(video?.observedAt ?? ''));
if (!Number.isFinite(videoObservedAtMs) || videoObservedAtMs < startedMs) {
  throw new Error('VIDEO_DISCOVERY_ONE_SHOT_STALE');
}
if (video?.safety?.executionAuthority !== 'NONE'
  || video?.safety?.liveTrading !== false
  || video?.safety?.privateTradingApiAllowed !== false
  || video?.safety?.realOrderEnabled !== false
  || video?.safety?.profitabilityCredit !== 0
  || video?.safety?.economicEvidenceCredit !== 0) {
  throw new Error('VIDEO_DISCOVERY_ONE_SHOT_SAFETY_INVALID');
}

process.stdout.write(JSON.stringify({
  schemaVersion: 'research-ai-one-shot-proof-v1',
  targetSha,
  ai: {
    status: ai.status,
    provider: ai.provider,
    providerNetworkCalls: ai.providerNetworkCalls,
    cacheHits: ai.cacheHits,
    reviewCount: ai.reviews.length,
    profileCoverage: ai.profileCoverage,
  },
  video: {
    status: video.status,
    providerNetworkCalls: video.providerNetworkCalls,
    sourceCount: video.sourceCount,
  },
  credentialValuesExposed: false,
  executionAuthority: 'NONE'
}) + '\n');
NODE
}

verify_v2_operational_transition() {
  local started_ms="$1"
  local evidence_root="${2:-$STATE_ROOT}"
  "${SUDO[@]}" node "$RESEARCH_ROOT/research-production/bin/research-ai-operational-transition-v2.mjs" \
    --state-root "$evidence_root" \
    --research-sha "$TARGET_SHA" \
    --started-at-ms "$started_ms"
}

run_as_research_user() {
  if command -v runuser >/dev/null 2>&1; then
    "${SUDO[@]}" runuser -u investment-research -- "$@"
  else
    sudo -n -u investment-research "$@"
  fi
}

isolated_release_is_valid() {
  local candidate="$1"
  [[ "$candidate" == "$TRANSITION_ROOT/releases/$TARGET_SHA" && -d "$candidate" && ! -L "$candidate" ]] || return 1
  [[ "$(git -C "$candidate" rev-parse HEAD 2>/dev/null || true)" == "$TARGET_SHA" ]] || return 1
  [[ -f "$candidate/research-production/bin/research-ai-isolated-transition-v2.mjs" \
    && -f "$candidate/research-production/src/autonomous-research-cycle-v2.mjs" \
    && -f "$candidate/research-production/deploy/activate-ai-research.sh" ]]
}

stage_isolated_release() (
  local release_root="$TRANSITION_ROOT/releases/$TARGET_SHA"
  local staged="$TRANSITION_ROOT/releases/.staging-$TARGET_SHA-$$"
  local staged_created=false
  cleanup_isolated_stage() {
    if [[ "$staged_created" == true && "$staged" == "$TRANSITION_ROOT/releases/.staging-$TARGET_SHA-$$" ]]; then
      "${SUDO[@]}" rm -rf -- "$staged" >/dev/null 2>&1 || true
    fi
  }
  trap cleanup_isolated_stage EXIT
  "${SUDO[@]}" install -d -o root -g root -m 0755 "$TRANSITION_ROOT" "$TRANSITION_ROOT/releases"
  if isolated_release_is_valid "$release_root"; then
    printf '%s\n' "AI_RESEARCH_ISOLATED_RELEASE_REUSED=$TARGET_SHA" >&2
    printf '%s\n' "$release_root"
    return 0
  fi
  [[ ! -e "$release_root" ]] || { echo "AI_RESEARCH_ISOLATED_RELEASE_INVALID:$release_root" >&2; return 1; }
  staged_created=true
  "${SUDO[@]}" git clone --quiet --filter=blob:none --no-checkout "$REPOSITORY_URL" "$staged"
  "${SUDO[@]}" git -C "$staged" fetch --quiet --depth 1 origin "$TARGET_SHA"
  [[ "$("${SUDO[@]}" git -C "$staged" rev-parse FETCH_HEAD^{commit})" == "$TARGET_SHA" ]] || {
    echo "AI_RESEARCH_ISOLATED_RELEASE_SHA_MISMATCH" >&2; return 1;
  }
  "${SUDO[@]}" git -C "$staged" checkout --quiet --detach "$TARGET_SHA"
  "${SUDO[@]}" chown -R root:root "$staged"
  "${SUDO[@]}" mv -- "$staged" "$release_root"
  staged_created=false
  isolated_release_is_valid "$release_root" || { echo "AI_RESEARCH_ISOLATED_RELEASE_INVALID:$release_root" >&2; return 1; }
  printf '%s\n' "AI_RESEARCH_ISOLATED_RELEASE_STAGED=$TARGET_SHA" >&2
  printf '%s\n' "$release_root"
)

validate_isolated() {
  command -v git >/dev/null
  command -v node >/dev/null
  command -v systemd-analyze >/dev/null
  [[ "$TRANSITION_ROOT" == /* && "$TRANSITION_ROOT" != "$STATE_ROOT" && "$TRANSITION_ROOT" != "$STATE_ROOT"/* ]] || {
    echo "AI_RESEARCH_ISOLATED_ROOT_INVALID:$TRANSITION_ROOT" >&2; exit 73;
  }
  local release_root
  release_root="$(stage_isolated_release)"
  local RESEARCH_ROOT="$release_root"
  require_research_safety_env
  require_existing_provider_env >/dev/null
  require_runtime_policy_env
  verify_unit_sources
  local run_id run_root isolated_root proof marker baseline cycles
  run_id="$(date -u +%Y%m%dT%H%M%SZ)-$TARGET_SHA-$$"
  run_root="$TRANSITION_ROOT/runs/$run_id"
  isolated_root="$run_root/state"
  proof="$isolated_root/isolated-transition-proof.json"
  marker="$TRANSITION_ROOT/validated/$TARGET_SHA.json"
  baseline="$run_root/runtime-baseline"
  cycles="${RESEARCH_AI_ISOLATED_CYCLES:-1}"
  [[ "$cycles" == 1 || "$cycles" == 2 ]] || { echo "AI_RESEARCH_ISOLATED_CYCLE_LIMIT_INVALID" >&2; exit 74; }
  "${SUDO[@]}" install -d -o root -g root -m 0755 "$TRANSITION_ROOT" "$TRANSITION_ROOT/runs" "$TRANSITION_ROOT/validated" "$run_root"
  "${SUDO[@]}" install -d -o investment-research -g investment-research -m 0700 "$isolated_root"
  require_idle_one_shots
  capture_runtime_snapshot "$baseline"
  run_as_research_user /usr/bin/env node \
    "$RESEARCH_ROOT/research-production/bin/research-ai-isolated-transition-v2.mjs" \
    --source-state-root "$STATE_ROOT" \
    --isolated-state-root "$isolated_root" \
    --repo-root "$RESEARCH_ROOT" \
    --research-sha "$TARGET_SHA" \
    --provider-env "$PROVIDER_ENV" \
    --ai-policy-env "$AI_POLICY_ENV" \
    --video-policy-env "$VIDEO_POLICY_ENV" \
    --cycles "$cycles"
  [[ -f "$proof" && ! -L "$proof" ]] || { echo "AI_RESEARCH_ISOLATED_PROOF_MISSING" >&2; exit 75; }
  local marker_tmp="$TRANSITION_ROOT/validated/.$TARGET_SHA.tmp-$$"
  "${SUDO[@]}" node - "$proof" "$marker_tmp" "$baseline" <<'NODE'
const fs = require('node:fs');
const [proofPath, markerPath, baselinePath] = process.argv.slice(2);
const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
fs.writeFileSync(markerPath, JSON.stringify({ ...proof, runtimeBaselinePath: baselinePath }, null, 2) + '\n',
  { mode: 0o644, flag: 'wx' });
NODE
  "${SUDO[@]}" mv -f -- "$marker_tmp" "$marker"
  "${SUDO[@]}" node - "$proof" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write([
  'AI_RESEARCH_ACTUAL_STRATEGY_SEARCH_COUNT=' + value.naturalCycleCount,
  'AI_RESEARCH_ORIGINAL_SOURCE_VERIFIED_COUNT=' + value.naturalCycleCount,
  'AI_RESEARCH_FORMULA_CANDIDATE_COUNT=' + value.formulaCandidateCount,
  'AI_RESEARCH_ACTUAL_BACKTEST_COUNT=' + value.actualBacktestCount,
  'AI_RESEARCH_FAILURE_MEMORY_COUNT=' + value.failureMemoryCount,
  'AI_RESEARCH_NEXT_DIRECTIVE_GENERATED=' + value.nextDirectiveGenerated,
  'AI_RESEARCH_COMPATIBILITY_REVIEW_SHA=' + value.aiReview.evidenceResearchSha,
  'AI_RESEARCH_TARGET_SHA_REVIEW=' + value.aiReview.exactTargetEvidence,
].join('\n') + '\n');
NODE
  printf '%s\n' \
    "AI_RESEARCH_ISOLATED_VALIDATION=PASS" \
    "TARGET_SHA=$TARGET_SHA" \
    "ISOLATED_STATE_ROOT=$isolated_root" \
    "PRODUCTION_STATE_MUTATED=false" \
    "LIVE_TRADING=false" \
    "PRIVATE_TRADING_API_ALLOWED=false" \
    "REAL_ORDER_ENABLED=false" \
    "executionAuthority=NONE"
}

require_isolated_validation() {
  local marker="$TRANSITION_ROOT/validated/$TARGET_SHA.json"
  local resolved
  resolved="$(node - "$marker" "$TRANSITION_ROOT" "$TARGET_SHA" "$ISOLATED_VALIDATION_MAX_AGE_MS" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [marker, transitionRoot, targetSha, maximumAgeRaw] = process.argv.slice(2);
const maximumAgeMs = Number(maximumAgeRaw);
if (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 60_000 || maximumAgeMs > 7 * 24 * 60 * 60 * 1000) {
  throw new Error('AI_RESEARCH_ISOLATED_VALIDATION_MAX_AGE_INVALID');
}
const info = fs.lstatSync(marker);
if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== 0
  || info.size < 2 || info.size > 1024 * 1024 || (info.mode & 0o022) !== 0) {
  throw new Error('AI_RESEARCH_ISOLATED_VALIDATION_MARKER_UNSAFE');
}
const value = JSON.parse(fs.readFileSync(marker, 'utf8'));
const completedAtMs = Date.parse(String(value?.completedAt ?? ''));
const age = Date.now() - completedAtMs;
const isolated = path.resolve(String(value?.isolatedStateRoot ?? ''));
const baseline = path.resolve(String(value?.runtimeBaselinePath ?? ''));
const root = fs.realpathSync(transitionRoot);
const expectedPrefix = path.join(root, 'runs') + path.sep;
if (value?.schemaVersion !== 'research-ai-isolated-transition-v2' || value?.status !== 'PASS'
  || value?.targetSha !== targetSha || value?.productionStateMutated !== false
  || !Number.isFinite(completedAtMs) || age < -300_000 || age > maximumAgeMs
  || !isolated.startsWith(expectedPrefix) || fs.realpathSync(isolated) !== isolated
  || !baseline.startsWith(expectedPrefix) || fs.realpathSync(baseline) !== baseline
  || !fs.lstatSync(path.join(baseline, 'runtime-before.tsv')).isFile()
  || fs.lstatSync(path.join(baseline, 'runtime-before.tsv')).isSymbolicLink()
  || !Number.isSafeInteger(value?.naturalCycleCount) || value.naturalCycleCount < 1 || value.naturalCycleCount > 2
  || !Array.isArray(value?.strategies) || value.strategies.length !== value.naturalCycleCount
  || value.strategies.some(row => !/^[a-f0-9]{40}$/u.test(String(row?.sourceRevision ?? ''))
    || !Number.isSafeInteger(row?.formulaGeneratedCount) || row.formulaGeneratedCount < 1
    || !Number.isSafeInteger(row?.actualBacktestCount) || row.actualBacktestCount < 1
    || !row?.metrics || !Number.isSafeInteger(row.metrics.trades)
    || !Number.isFinite(row.metrics.netReturn) || !Number.isFinite(row.metrics.maximumDrawdown))
  || !Number.isSafeInteger(value?.formulaCandidateCount) || value.formulaCandidateCount < value.naturalCycleCount
  || !Number.isSafeInteger(value?.actualBacktestCount) || value.actualBacktestCount < value.naturalCycleCount
  || !Number.isSafeInteger(value?.failureMemoryCount) || value.failureMemoryCount < 0
  || value?.nextDirectiveGenerated !== true
  || !Number.isSafeInteger(value?.actualProviderCalls) || value.actualProviderCalls < 2 * value.naturalCycleCount
  || !Number.isSafeInteger(value?.actualSourceFetches) || value.actualSourceFetches < 3 * value.naturalCycleCount
  || !['COMPLETE','PARTIAL_COVERAGE_COMPLETE'].includes(value?.aiReview?.status)
  || !/^[a-f0-9]{40}$/u.test(String(value?.aiReview?.evidenceResearchSha ?? ''))
  || typeof value?.aiReview?.exactTargetEvidence !== 'boolean'
  || Number(value?.aiReview?.providerNetworkCalls ?? 0) + Number(value?.aiReview?.cacheHits ?? 0) < 1
  || value?.youtube?.status !== 'COMPLETE' || Number(value?.youtube?.providerNetworkCalls ?? 0) < 1
  || value?.paperActivated !== false || value?.actualPaperEntryCount !== 0 || value?.actualPaperExitCount !== 0
  || value?.providerSecretValuesExposed !== false || value?.liveTrading !== false
  || value?.privateTradingApiAllowed !== false || value?.realOrderEnabled !== false
  || value?.executionAuthority !== 'NONE') throw new Error('AI_RESEARCH_ISOLATED_VALIDATION_INVALID');
process.stdout.write(isolated + '\t' + String(Date.parse(value.startedAt)) + '\t' + baseline);
NODE
)"
  IFS=$'\t' read -r ISOLATED_VALIDATION_STATE_ROOT ISOLATED_VALIDATION_STARTED_MS ISOLATED_BASELINE_SNAPSHOT_ROOT <<<"$resolved"
  [[ -n "$ISOLATED_VALIDATION_STATE_ROOT" && "$ISOLATED_VALIDATION_STARTED_MS" =~ ^[0-9]+$ \
    && -n "$ISOLATED_BASELINE_SNAPSHOT_ROOT" ]] || {
    echo "AI_RESEARCH_ISOLATED_VALIDATION_INVALID" >&2; return 1;
  }
  # The compatibility review may intentionally use the previous release's
  # immutable evidence. Do not relabel it as target-SHA one-shot evidence.
  # A fresh target-SHA AI/YouTube one-shot remains mandatory after cutover.
  verify_v2_operational_transition "$ISOLATED_VALIDATION_STARTED_MS" "$ISOLATED_VALIDATION_STATE_ROOT"
  verify_runtime_snapshot "$ISOLATED_BASELINE_SNAPSHOT_ROOT"
  printf '%s\n' "AI_RESEARCH_ISOLATED_VALIDATION_REUSED=true" "ISOLATED_VALIDATION_TARGET_SHA=$TARGET_SHA"
}

verify_unit_sources() {
  local unit
  for unit in "${services[@]}" "${timers[@]}" "${daemon_services[@]}"; do
    local source="$RESEARCH_ROOT/research-production/deploy/$unit"
    [[ -f "$source" ]] || {
      echo "AI_RESEARCH_UNIT_MISSING:$source" >&2
      exit 69
    }
    systemd-analyze verify "$source" >/dev/null
  done
  local core_service="$RESEARCH_ROOT/research-production/deploy/research-production@.service"
  local long_timer="$RESEARCH_ROOT/research-production/deploy/research-production-long-history.timer"
  [[ -f "$core_service" && -f "$long_timer" ]] || {
    echo "AI_RESEARCH_LONG_HISTORY_REFRESH_PATH_MISSING" >&2
    exit 69
  }
  grep -Fq 'ExecStart=/usr/bin/env node research-production/bin/research-cycle.mjs run --profile %i' "$core_service"
  grep -Fq 'Unit=research-production@long-history.service' "$long_timer"
  systemd-analyze verify "$core_service" "$long_timer" >/dev/null
}

verify_installed_unit_ownership() {
  local unit source installed source_sha installed_sha
  for unit in "${managed_units[@]}"; do
    source="$RESEARCH_ROOT/research-production/deploy/$unit"
    installed="$SYSTEMD_UNIT_ROOT/$unit"
    [[ -f "$installed" && ! -L "$installed" ]] || { echo "AI_RESEARCH_INSTALLED_UNIT_MISSING:$unit" >&2; return 1; }
    [[ "$("${SUDO[@]}" stat -c '%U:%G:%a' "$installed")" == "$SYSTEMD_UNIT_OWNER:644" ]] || {
      echo "AI_RESEARCH_INSTALLED_UNIT_OWNERSHIP_INVALID:$unit" >&2; return 1;
    }
    source_sha="$(sha256sum "$source" | awk '{print $1}')"
    installed_sha="$("${SUDO[@]}" sha256sum "$installed" | awk '{print $1}')"
    [[ "$source_sha" == "$installed_sha" ]] || { echo "AI_RESEARCH_INSTALLED_UNIT_SHA_MISMATCH:$unit" >&2; return 1; }
  done
  [[ "$("${SUDO[@]}" systemctl show research-production-ai-review.service -p User --value)" == investment-research ]]
  [[ "$("${SUDO[@]}" systemctl show research-production-ai-review.service -p Group --value)" == investment-research ]]
  [[ "$("${SUDO[@]}" systemctl show research-production-ai-review.service -p WorkingDirectory --value)" == "$RESEARCH_ROOT" ]]
  require_exact_research_release
}

confirm_free_only() {
  # Explicit owner command only. The ordinary preflight remains read-only.
  [[ "${RESEARCH_FREE_ONLY_OWNER_COMMENT_ID:-}" =~ ^[1-9][0-9]{0,19}$ ]] || exit 64
  [[ "$ENV_ROOT" == '/etc/investment-research' ]] || exit 64
  require_exact_research_release
  require_research_safety_env
  provider_preflight >/dev/null
  "${SUDO[@]}" env TARGET_SHA="$TARGET_SHA" RESEARCH_FREE_ONLY_OWNER_COMMENT_ID="$RESEARCH_FREE_ONLY_OWNER_COMMENT_ID" \
    node "$RESEARCH_ROOT/research-production/bin/confirm-research-free-policy.mjs"
  "${SUDO[@]}" chown root:investment-research "$AI_POLICY_ENV" "$VIDEO_POLICY_ENV"
  "${SUDO[@]}" chmod 0640 "$AI_POLICY_ENV" "$VIDEO_POLICY_ENV"
  require_runtime_policy_env
}

preflight() {
  command -v git >/dev/null
  command -v node >/dev/null
  command -v systemctl >/dev/null
  command -v systemd-analyze >/dev/null
  require_exact_research_release
  require_research_safety_env
  print_forward_runtime_diagnostic
  require_existing_provider_env
  require_runtime_policy_env
  verify_unit_sources
  printf '%s\n'     "AI_RESEARCH_PREFLIGHT=PASS"     "TARGET_SHA=$TARGET_SHA"     "PROVIDER_YOUTUBE=PRESENT"     "PROVIDER_GEMINI=PRESENT"     "PROVIDER_GROQ=PRESENT"     "LIVE_TRADING=false"     "PRIVATE_TRADING_API_ALLOWED=false"     "REAL_ORDER_ENABLED=false"     "executionAuthority=NONE"
}

activate() {
  # This exact-SHA proof is created only by the separately approved isolated
  # command. It also carries the pre-cutover legacy-runtime snapshot.
  require_isolated_validation

  local snapshot_root="$ISOLATED_BASELINE_SNAPSHOT_ROOT"

  local activated=false
  # EXIT traps run after this function's local scope can be unwound. Keep the
  # rollback boundary and its immutable snapshot path shell-global so `set -u`
  # can never replace the original activation failure with an unbound-local
  # error.
  AI_RESEARCH_CUTOVER_STARTED=true
  AI_RESEARCH_ROLLBACK_SNAPSHOT_ROOT="$snapshot_root"
  fail_safe() {
    local status=$?
    if (( status != 0 )); then
      if [[ "${AI_RESEARCH_CUTOVER_STARTED:-false}" == true ]]; then
        local rollback_status=0
        restore_runtime_snapshot "$AI_RESEARCH_ROLLBACK_SNAPSHOT_ROOT" || rollback_status=$?
        if (( rollback_status == 0 )); then
          printf '%s\n' "AI_RESEARCH_ACTIVATION_FAILED_ROLLED_BACK=true" "TARGET_SHA=$TARGET_SHA" >&2
        else
          status=86
          printf '%s\n' "ROLLBACK_FAILED=true" "TARGET_SHA=$TARGET_SHA" >&2
        fi
      else
        printf '%s\n' "AI_RESEARCH_EXISTING_RUNTIME_UNCHANGED=true" "TARGET_SHA=$TARGET_SHA" >&2
      fi
    fi
    return "$status"
  }
  trap fail_safe EXIT

  # The preceding Research release cutover intentionally left AI schedules
  # disabled. From here on, every failure restores the pre-cutover pinned
  # service definitions and their prior timer/daemon states.
  preflight

  # Re-check for an unexpected in-flight one-shot before the short reversible
  # definition swap; never kill it to force the cutover.
  require_idle_one_shots
  disable_timers

  RESEARCH_RELEASE_ROOT="$RESEARCH_ROOT"     bash "$RESEARCH_ROOT/research-production/deploy/install-ai-research-units.sh"

  "${SUDO[@]}" systemctl daemon-reload
  verify_installed_unit_ownership

  # Refresh exact-SHA forward evidence synchronously so activation never races the hourly :11 UTC timer.
  # blocked_data is still valid structural evidence; this only requires a current-release cycle artifact.
  refresh_current_sha_forward_evidence

  # A successful one-shot must prove validated current-release review evidence,
  # exact Research SHA, provider identity, and no trading authority before timers enable.
  local one_shot_started_ms
  one_shot_started_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
  "${SUDO[@]}" systemctl start research-production-ai-review.service || true
  "${SUDO[@]}" systemctl start research-production-video-discovery.service || true
  "${SUDO[@]}" systemctl start research-production-approved-job-intake.service || true

  local service
  local one_shot_failed=false
  for service in "${services[@]}"; do
    local result status
    if ! result="$("${SUDO[@]}" systemctl show "$service" -p Result --value)"; then result=UNKNOWN; fi
    if ! status="$("${SUDO[@]}" systemctl show "$service" -p ExecMainStatus --value)"; then status=UNKNOWN; fi
    echo "AI_RESEARCH_ONE_SHOT_RESULT:$service:result=$result:status=$status"
    [[ "$result" == "success" && "$status" == "0" ]] || {
      if [[ "$service" == "research-production-ai-review.service" ]]; then
        print_ai_diagnostic
      fi
      echo "AI_RESEARCH_ONE_SHOT_FAILED:$service:result=$result:status=$status" >&2
      one_shot_failed=true
    }
  done
  # All already-started components are reported before the single fail-closed exit.
  [[ "$one_shot_failed" == false ]] || exit 70

  verify_one_shot_evidence "$one_shot_started_ms"
  # Do not equate a healthy legacy review/provider call with the new V2
  # closed loop. Require a fresh directive, two real free-AI stages, three
  # verified public-source reads, FormulaCandidate creation and an actual
  # existing-queue backtest before recurring schedules can be re-enabled.
  verify_v2_operational_transition "$one_shot_started_ms"

  "${SUDO[@]}" systemctl enable --now "${timers[@]}" "${daemon_services[@]}"
  local timer
  for timer in "${timers[@]}"; do
    "${SUDO[@]}" systemctl is-enabled --quiet "$timer"
    "${SUDO[@]}" systemctl is-active --quiet "$timer"
  done
  local daemon
  for daemon in "${daemon_services[@]}"; do
    "${SUDO[@]}" systemctl is-enabled --quiet "$daemon"
    "${SUDO[@]}" systemctl is-active --quiet "$daemon"
  done
  verify_workspace_worker_health

  require_exact_research_release
  require_research_safety_env
  verify_installed_unit_ownership
  activated=true
  trap - EXIT

  printf '%s\n'     "AI_RESEARCH_ACTIVATED=$activated"     "TARGET_SHA=$TARGET_SHA"     "AI_RESEARCH_PREVIOUS_RUNTIME_SNAPSHOT=$snapshot_root"     "AI_RESEARCH_ISOLATED_VALIDATION_REUSED=true"     "AI_REVIEW_ONE_SHOT=success"     "VIDEO_DISCOVERY_ONE_SHOT=success"     "AI_REVIEW_TIMER_ENABLED=true"     "VIDEO_DISCOVERY_TIMER_ENABLED=true"     "APPROVED_JOB_INTAKE_TIMER_ENABLED=true"     "WORKSPACE_WORKER_ENABLED=true"     "PROVIDER_YOUTUBE=PRESENT"     "PROVIDER_GEMINI=PRESENT"     "PROVIDER_GROQ=PRESENT"     "PROVIDER_ENV_READABLE_BY_RESEARCH_USER=true"     "LIVE_TRADING=false"     "PRIVATE_TRADING_API_ALLOWED=false"     "REAL_ORDER_ENABLED=false"     "executionAuthority=NONE"     "REAL_ORDER_SUBMITTED=false"
}

case "$MODE" in
  confirm-free-only) confirm_free_only ;;
  preflight) preflight ;;
  validate-isolated) validate_isolated ;;
  activate) activate ;;
  *)
    echo "usage: activate-ai-research.sh {confirm-free-only|preflight|validate-isolated|activate}" >&2
    exit 64
    ;;
esac
