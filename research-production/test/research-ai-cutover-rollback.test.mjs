import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const source = readFileSync(new URL('../deploy/activate-ai-research.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const helpers = source.slice(source.indexOf('capture_runtime_snapshot()'), source.indexOf('research_sha()'));

function invoke({ damageBackup = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'research-ai-rollback-'));
  const script = String.raw`
set -Eeuo pipefail
SUDO=()
SYSTEMD_UNIT_ROOT="$TEST_ROOT/systemd"
SYSTEMD_UNIT_OWNER="$(id -un):$(id -gn)"
RUNTIME_SNAPSHOT_OWNER="$(id -un):$(id -gn)"
RUNTIME_SNAPSHOT_ENV_OWNER="$(id -un):$(id -gn)"
RESEARCH_RELEASES_ROOT="$TEST_ROOT/releases"
CURRENT_RESEARCH_ROOT="$TEST_ROOT/current"
RESEARCH_ENV="$TEST_ROOT/env/research-production.env"
timers=(research-production-old.timer)
daemon_services=(research-production-old-daemon.service)
services=(research-production-old-worker.service)
managed_units=(research-production-old.timer research-production-old-daemon.service research-production-old-worker.service)
mkdir -p "$SYSTEMD_UNIT_ROOT" "$TEST_ROOT/env" "$RESEARCH_RELEASES_ROOT/__SHA__"
ln -s "$RESEARCH_RELEASES_ROOT/__SHA__" "$CURRENT_RESEARCH_ROOT"
printf '[Unit]\nDescription=old timer\n[Timer]\nOnCalendar=hourly\n' > "$SYSTEMD_UNIT_ROOT/research-production-old.timer"
for unit in research-production-old-daemon.service research-production-old-worker.service; do
  printf '[Service]\nWorkingDirectory=/opt/investment-research/current\nEnvironmentFile=/etc/investment-research/research-production.env\nExecStart=/bin/true\n' > "$SYSTEMD_UNIT_ROOT/$unit"
done
chmod 0644 "$SYSTEMD_UNIT_ROOT"/*
printf '%s\n' \
  'RESEARCH_REPO_ROOT=/opt/investment-research/current' 'RESEARCH_CODE_SHA=__SHA__' \
  'GIT_CONFIG_VALUE_0=/opt/investment-research/releases/__SHA__' \
  'LIVE_TRADING=false' 'LIVE_TRADING_ENABLED=false' 'REAL_ORDER_ENABLED=false' 'REAL_TRADING_ENABLED=false' \
  'PRIVATE_API_ENABLED=false' 'PRIVATE_ACCOUNT_ACCESS=false' 'PRIVATE_TRADING_API_ALLOWED=false' \
  'ORDER_AUTHORITY=false' 'ORDER_SUBMISSION_ENABLED=false' > "$RESEARCH_ENV"
chmod 0640 "$RESEARCH_ENV"
declare -A ENABLED=([research-production-old.timer]=enabled [research-production-old-daemon.service]=disabled [research-production-old-worker.service]=static)
declare -A ACTIVE=([research-production-old.timer]=active [research-production-old-daemon.service]=inactive [research-production-old-worker.service]=inactive)
install() {
  local -a args=()
  while (($#)); do
    case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac
  done
  command install "__DL__args[@]}"
}
systemctl() {
  local command="$1"; shift
  case "$command" in
    show)
      local unit="$1" property="$3"
      case "$property" in
        FragmentPath) printf '%s\n' "$SYSTEMD_UNIT_ROOT/$unit" ;;
        ExecStart) printf '/old/%s\n' "$unit" ;;
        ActiveState) printf '%s\n' "__DL__ACTIVE[$unit]}" ;;
        WorkingDirectory) printf '%s\n' "$RESEARCH_RELEASES_ROOT/__SHA__" ;;
        *) return 2 ;;
      esac ;;
    is-enabled) printf '%s\n' "__DL__ENABLED[$1]}"; [[ "__DL__ENABLED[$1]}" == enabled || "__DL__ENABLED[$1]}" == enabled-runtime ]] ;;
    is-active) printf '%s\n' "__DL__ACTIVE[$1]}"; [[ "__DL__ACTIVE[$1]}" == active || "__DL__ACTIVE[$1]}" == activating ]] ;;
    disable)
      for unit in "$@"; do [[ "$unit" == --now ]] && continue; ENABLED[$unit]=disabled; ACTIVE[$unit]=inactive; done ;;
    enable)
      local runtime=false; [[ "__DL__1:-}" == --runtime ]] && { runtime=true; shift; }
      ENABLED[$1]=$([[ "$runtime" == true ]] && printf enabled-runtime || printf enabled) ;;
    start) for unit in "$@"; do ACTIVE[$unit]=active; done ;;
    stop) for unit in "$@"; do ACTIVE[$unit]=inactive; done ;;
    daemon-reload) : ;;
    *) return 3 ;;
  esac
}
git() { [[ "$1" == -C && "$3" == rev-parse && "$4" == HEAD ]] && printf '%s\n' "__SHA__"; }
__HELPERS__
snapshot="$TEST_ROOT/snapshot"
capture_runtime_snapshot "$snapshot"
for unit in "__DL__managed_units[@]}"; do printf 'new:%s\n' "$unit" > "$SYSTEMD_UNIT_ROOT/$unit"; ENABLED[$unit]=enabled; ACTIVE[$unit]=active; done
ACTIVE[research-production-old-worker.service]=inactive
printf 'new-research-env\n' > "$RESEARCH_ENV"
__DAMAGE__
if [[ "$EXPECT_FAILURE" == true ]]; then
  set +e
  restore_runtime_snapshot "$snapshot"
  status=$?
  set -e
  [[ "$status" -ne 0 ]]
  exit 0
fi
restore_runtime_snapshot "$snapshot"
grep -Fxq "WorkingDirectory=$RESEARCH_RELEASES_ROOT/__SHA__" "$SYSTEMD_UNIT_ROOT/research-production-old-worker.service"
grep -Fxq "EnvironmentFile=$snapshot/env/research-production.env" "$SYSTEMD_UNIT_ROOT/research-production-old-worker.service"
grep -Fxq 'new-research-env' "$RESEARCH_ENV"
[[ "__DL__ENABLED[research-production-old.timer]}:__DL__ACTIVE[research-production-old.timer]}" == enabled:active ]]
[[ "__DL__ENABLED[research-production-old-daemon.service]}:__DL__ACTIVE[research-production-old-daemon.service]}" == disabled:inactive ]]
[[ "__DL__ENABLED[research-production-old-worker.service]}:__DL__ACTIVE[research-production-old-worker.service]}" == static:inactive ]]
printf 'ROLLBACK_HARNESS=PASS\n'
`.replaceAll('__DL__', '${')
    .replace('__SHA__', 'a'.repeat(40))
    .replace('__HELPERS__', () => helpers)
    .replaceAll('__SHA__', 'a'.repeat(40))
    .replace('__DAMAGE__', () => damageBackup ? 'rm -f "$snapshot/units/research-production-old.timer"' : ':');
  const result = spawnSync('bash', ['-s'], {
    input: script,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, TEST_ROOT: root, EXPECT_FAILURE: String(damageBackup) },
  });
  rmSync(root, { recursive: true, force: true });
  assert.ifError(result.error);
  return result;
}

test('cutover rollback restores prior unit bytes, env files and service state', () => {
  const result = invoke();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ROLLBACK_HARNESS=PASS/u);
  assert.match(result.stderr, /AI_RESEARCH_ROLLBACK=RESTORED/u);
});

test('missing rollback material fails closed instead of claiming recovery', () => {
  const result = invoke({ damageBackup: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /AI_RESEARCH_ROLLBACK_UNIT_BACKUP_(?:MISSING|HASH_MISMATCH):research-production-old\.timer/u);
  assert.doesNotMatch(result.stderr, /AI_RESEARCH_ROLLBACK=RESTORED/u);
});
