#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

MODE="${1:-}"
STAGING_DIR="${STAGING_DIR:-/srv/seungjae-staging}"
RELEASE_ROOT="${RELEASE_ROOT:-/srv/seungjae-staging-releases}"
BACKUP_ROOT="${BACKUP_ROOT:-/srv/seungjae-staging-backups}"
STATE_DIR="${STATE_DIR:-$STAGING_DIR/.deploy}"
STAGING_LOCK_FILE="${STAGING_LOCK_FILE:-/var/lock/seungjae-staging-deploy.lock}"
PRODUCTION_LOCK_FILE="${PRODUCTION_LOCK_FILE:-/var/lock/stock-app-deploy.lock}"
KEEP_COUNT="${KEEP_COUNT:-4}"
TMP_MIN_AGE_MINUTES="${TMP_MIN_AGE_MINUTES:-1440}"
PLAYWRIGHT_CACHE="${PLAYWRIGHT_CACHE:-$HOME/.cache/ms-playwright}"

fail() {
  echo "[server-disk-cleanup] $1" >&2
  exit "${2:-1}"
}

[[ "$MODE" == plan || "$MODE" == apply ]] || fail 'usage: server-safe-disk-cleanup.sh <plan|apply>' 2
[[ "$KEEP_COUNT" =~ ^[0-9]+$ ]] && (( KEEP_COUNT >= 2 )) || fail 'KEEP_COUNT must be an integer >= 2' 3
[[ "$TMP_MIN_AGE_MINUTES" =~ ^[0-9]+$ ]] && (( TMP_MIN_AGE_MINUTES >= 60 )) || fail 'TMP_MIN_AGE_MINUTES must be >= 60' 4

for command_name in flock find sort awk du df realpath readlink rm ps grep pm2 node pnpm; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name" 5
done

[[ -d "$STAGING_DIR" ]] || fail "staging directory missing: $STAGING_DIR" 6
[[ -d "$RELEASE_ROOT" ]] || fail "staging release root missing: $RELEASE_ROOT" 7
[[ -d "$BACKUP_ROOT" ]] || fail "staging backup root missing: $BACKUP_ROOT" 8
[[ -d "$STATE_DIR" ]] || fail "staging deploy state missing: $STATE_DIR" 9

# Serialize against both staging and production deployments. If either deployment
# is active, cleanup exits before computing or deleting candidates.
exec 8>"$STAGING_LOCK_FILE"
flock -n 8 || fail 'staging deployment is active; cleanup aborted before deletion' 10
exec 9>"$PRODUCTION_LOCK_FILE"
flock -n 9 || fail 'production deployment is active; cleanup aborted before deletion' 11

canonical_root() {
  realpath -e -- "$1"
}

RELEASE_ROOT_REAL="$(canonical_root "$RELEASE_ROOT")"
BACKUP_ROOT_REAL="$(canonical_root "$BACKUP_ROOT")"
TMP_ROOT_REAL="$(canonical_root /tmp)"

canonical_child() {
  local root_real="$1"
  local candidate="$2"
  local resolved
  resolved="$(realpath -e -- "$candidate" 2>/dev/null)" || return 1
  case "$resolved" in
    "$root_real"/*) printf '%s\n' "$resolved" ;;
    *) return 1 ;;
  esac
}

read_required_state_path() {
  local file="$1"
  local root_real="$2"
  local label="$3"
  local raw resolved
  [[ -s "$file" ]] || fail "$label state is missing: $file" 12
  raw="$(tr -d '\r\n' < "$file")"
  [[ -n "$raw" ]] || fail "$label state is empty" 13
  resolved="$(canonical_child "$root_real" "$raw")" || fail "$label is outside its allowed root or missing" 14
  [[ -d "$resolved" ]] || fail "$label does not point to a directory" 15
  printf '%s\n' "$resolved"
}

read_optional_metadata_path() {
  local file="$1"
  local root_real="$2"
  local label="$3"
  local raw resolved
  [[ -e "$file" ]] || return 0
  raw="$(tr -d '\r\n' < "$file")"
  [[ -n "$raw" ]] || return 0
  resolved="$(canonical_child "$root_real" "$raw")" || fail "$label metadata is outside its allowed root or missing" 16
  [[ -d "$resolved" ]] || fail "$label metadata does not point to a directory" 17
  printf '%s\n' "$resolved"
}

CURRENT_RELEASE="$(read_required_state_path "$STATE_DIR/current-release" "$RELEASE_ROOT_REAL" 'current release')"
LAST_BACKUP="$(read_required_state_path "$STATE_DIR/last-backup" "$BACKUP_ROOT_REAL" 'last backup')"
PREVIOUS_RELEASE="$(read_optional_metadata_path "$LAST_BACKUP/previous-release.txt" "$RELEASE_ROOT_REAL" 'previous release')"
LAST_ROLLBACK_BACKUP="$(read_optional_metadata_path "$STATE_DIR/last-rollback-backup" "$BACKUP_ROOT_REAL" 'last rollback backup')"

PROTECTED_RELEASES=("$CURRENT_RELEASE")
[[ -n "$PREVIOUS_RELEASE" ]] && PROTECTED_RELEASES+=("$PREVIOUS_RELEASE")
PROTECTED_BACKUPS=("$LAST_BACKUP")
[[ -n "$LAST_ROLLBACK_BACKUP" ]] && PROTECTED_BACKUPS+=("$LAST_ROLLBACK_BACKUP")

is_protected() {
  local candidate="$1"
  shift
  local protected
  for protected in "$@"; do
    [[ "$candidate" == "$protected" ]] && return 0
  done
  return 1
}

pm2_snapshot() {
  pm2 jlist | node -e '
    const fs = require("node:fs");
    const raw = fs.readFileSync(0, "utf8");
    const list = JSON.parse(raw || "[]");
    const wanted = new Set(["stock-app", "seungjae-staging"]);
    const rows = list
      .filter((item) => wanted.has(String(item.name || "")))
      .map((item) => ({
        name: String(item.name || ""),
        status: String(item.pm2_env?.status || "missing"),
        restart_count: Number(item.pm2_env?.restart_time ?? -1),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    process.stdout.write(JSON.stringify(rows));
  '
}

PM2_BEFORE="$(pm2_snapshot)"
[[ "$PM2_BEFORE" == *'"name":"stock-app"'* ]] || fail 'production PM2 process is missing from safety snapshot' 18
[[ "$PM2_BEFORE" == *'"name":"seungjae-staging"'* ]] || fail 'staging PM2 process is missing from safety snapshot' 19
[[ "$PM2_BEFORE" != *'"status":"stopped"'* && "$PM2_BEFORE" != *'"status":"errored"'* ]] || fail 'a protected PM2 process is not healthy enough for cleanup' 20

mapfile -t ALL_BACKUPS < <(find "$BACKUP_ROOT_REAL" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | awk '{sub(/^[^ ]+ /, ""); print}')
mapfile -t ALL_RELEASES < <(find "$RELEASE_ROOT_REAL" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | awk '{sub(/^[^ ]+ /, ""); print}')

BACKUP_CANDIDATES=()
for index in "${!ALL_BACKUPS[@]}"; do
  (( index < KEEP_COUNT )) && continue
  candidate="$(canonical_child "$BACKUP_ROOT_REAL" "${ALL_BACKUPS[$index]}")" || fail 'invalid backup cleanup candidate' 21
  is_protected "$candidate" "${PROTECTED_BACKUPS[@]}" && continue
  BACKUP_CANDIDATES+=("$candidate")
done

RELEASE_CANDIDATES=()
for index in "${!ALL_RELEASES[@]}"; do
  (( index < KEEP_COUNT )) && continue
  candidate="$(canonical_child "$RELEASE_ROOT_REAL" "${ALL_RELEASES[$index]}")" || fail 'invalid release cleanup candidate' 22
  is_protected "$candidate" "${PROTECTED_RELEASES[@]}" && continue
  RELEASE_CANDIDATES+=("$candidate")
done

path_in_use_as_cwd() {
  local candidate="$1"
  local cwd_link cwd
  for cwd_link in /proc/[0-9]*/cwd; do
    cwd="$(readlink -f -- "$cwd_link" 2>/dev/null || true)"
    [[ -n "$cwd" ]] || continue
    case "$cwd" in
      "$candidate"|"$candidate"/*) return 0 ;;
    esac
  done
  return 1
}

TMP_CANDIDATES=()
while IFS= read -r tmp_candidate; do
  [[ -n "$tmp_candidate" ]] || continue
  resolved="$(canonical_child "$TMP_ROOT_REAL" "$tmp_candidate")" || fail 'invalid tmp cleanup candidate' 23
  case "$(basename -- "$resolved")" in
    seungjae-staging-source.*|seungjae-staging-canary.*|seungjae-staging-canary-health.*|seungjae-staging-live-health.*|seungjae-staging-*.env|stock-app-canary-env.*|stock-app-canary-log.*|stock-app-source.*) ;;
    *) fail 'tmp candidate did not match the cleanup allowlist' 24 ;;
  esac
  path_in_use_as_cwd "$resolved" && continue
  TMP_CANDIDATES+=("$resolved")
done < <(
  find "$TMP_ROOT_REAL" -mindepth 1 -maxdepth 1 \
    \( -name 'seungjae-staging-source.*' \
       -o -name 'seungjae-staging-canary.*' \
       -o -name 'seungjae-staging-canary-health.*' \
       -o -name 'seungjae-staging-live-health.*' \
       -o -name 'seungjae-staging-*.env' \
       -o -name 'stock-app-canary-env.*' \
       -o -name 'stock-app-canary-log.*' \
       -o -name 'stock-app-source.*' \) \
    -mmin "+$TMP_MIN_AGE_MINUTES" -print
)

PLAYWRIGHT_CACHE_CANDIDATE=""
if [[ -d "$PLAYWRIGHT_CACHE" ]]; then
  PLAYWRIGHT_CACHE_REAL="$(realpath -e -- "$PLAYWRIGHT_CACHE")"
  EXPECTED_PLAYWRIGHT_CACHE="$(realpath -m -- "$HOME/.cache/ms-playwright")"
  [[ "$PLAYWRIGHT_CACHE_REAL" == "$EXPECTED_PLAYWRIGHT_CACHE" ]] || fail 'Playwright cache path is outside the fixed user cache location' 25
  if ! path_in_use_as_cwd "$PLAYWRIGHT_CACHE_REAL" && ! ps -eo args= | grep -F -- "$PLAYWRIGHT_CACHE_REAL" | grep -v -F 'grep -F' >/dev/null 2>&1; then
    PLAYWRIGHT_CACHE_CANDIDATE="$PLAYWRIGHT_CACHE_REAL"
  fi
fi

sum_kb() {
  local total=0 path size
  for path in "$@"; do
    [[ -e "$path" ]] || continue
    size="$(du -sk -- "$path" 2>/dev/null | awk 'NR==1 {print $1}')"
    [[ "$size" =~ ^[0-9]+$ ]] || size=0
    (( total += size ))
  done
  printf '%s\n' "$total"
}

BACKUP_KB="$(sum_kb "${BACKUP_CANDIDATES[@]:-}")"
RELEASE_KB="$(sum_kb "${RELEASE_CANDIDATES[@]:-}")"
TMP_KB="$(sum_kb "${TMP_CANDIDATES[@]:-}")"
PLAYWRIGHT_KB=0
[[ -n "$PLAYWRIGHT_CACHE_CANDIDATE" ]] && PLAYWRIGHT_KB="$(sum_kb "$PLAYWRIGHT_CACHE_CANDIDATE")"
ESTIMATED_RECLAIM_KB=$(( BACKUP_KB + RELEASE_KB + TMP_KB + PLAYWRIGHT_KB ))

DISK_BEFORE_FREE_KB="$(df -Pk / | awk 'NR==2 {print $4}')"
DISK_BEFORE_USE_PERCENT="$(df -Pk / | awk 'NR==2 {print $5}')"
[[ "$DISK_BEFORE_FREE_KB" =~ ^[0-9]+$ ]] || fail 'could not read disk free space' 26

emit_common() {
  printf 'mode=%s\n' "$MODE"
  printf 'keep_count=%s\n' "$KEEP_COUNT"
  printf 'protected_current_release=%s\n' "$CURRENT_RELEASE"
  printf 'protected_last_backup=%s\n' "$LAST_BACKUP"
  printf 'protected_previous_release=%s\n' "${PREVIOUS_RELEASE:-none}"
  printf 'protected_last_rollback_backup=%s\n' "${LAST_ROLLBACK_BACKUP:-none}"
  printf 'backup_delete_count=%s\n' "${#BACKUP_CANDIDATES[@]}"
  printf 'backup_delete_kb=%s\n' "$BACKUP_KB"
  printf 'release_delete_count=%s\n' "${#RELEASE_CANDIDATES[@]}"
  printf 'release_delete_kb=%s\n' "$RELEASE_KB"
  printf 'tmp_delete_count=%s\n' "${#TMP_CANDIDATES[@]}"
  printf 'tmp_delete_kb=%s\n' "$TMP_KB"
  printf 'playwright_cache_delete=%s\n' "$([[ -n "$PLAYWRIGHT_CACHE_CANDIDATE" ]] && echo true || echo false)"
  printf 'playwright_cache_delete_kb=%s\n' "$PLAYWRIGHT_KB"
  printf 'pnpm_store_prune=eligible\n'
  printf 'estimated_reclaim_kb=%s\n' "$ESTIMATED_RECLAIM_KB"
  printf 'disk_before_free_kb=%s\n' "$DISK_BEFORE_FREE_KB"
  printf 'disk_before_use_percent=%s\n' "$DISK_BEFORE_USE_PERCENT"
}

if [[ "$MODE" == plan ]]; then
  emit_common
  printf 'server_files_deleted=0\n'
  printf 'server_processes_restarted=0\n'
  printf 'staging_deployment_executed=false\n'
  printf 'production_deployment_executed=false\n'
  printf 'database_changes=0\n'
  printf 'secret_values_collected=0\n'
  printf 'SAFE_DISK_CLEANUP_PLAN_READY\n'
  exit 0
fi

remove_root_candidate() {
  local root_real="$1"
  local candidate="$2"
  local resolved
  resolved="$(canonical_child "$root_real" "$candidate")" || fail 'candidate escaped cleanup root during apply' 27
  [[ "$resolved" != "$root_real" ]] || fail 'cleanup root itself cannot be deleted' 28
  rm -rf -- "$resolved"
}

for candidate in "${BACKUP_CANDIDATES[@]:-}"; do
  [[ -n "$candidate" ]] || continue
  is_protected "$candidate" "${PROTECTED_BACKUPS[@]}" && fail 'protected backup reached apply list' 29
  remove_root_candidate "$BACKUP_ROOT_REAL" "$candidate"
done

for candidate in "${RELEASE_CANDIDATES[@]:-}"; do
  [[ -n "$candidate" ]] || continue
  is_protected "$candidate" "${PROTECTED_RELEASES[@]}" && fail 'protected release reached apply list' 30
  remove_root_candidate "$RELEASE_ROOT_REAL" "$candidate"
done

for candidate in "${TMP_CANDIDATES[@]:-}"; do
  [[ -n "$candidate" ]] || continue
  path_in_use_as_cwd "$candidate" && fail 'tmp candidate became active during cleanup' 31
  remove_root_candidate "$TMP_ROOT_REAL" "$candidate"
done

if [[ -n "$PLAYWRIGHT_CACHE_CANDIDATE" && -d "$PLAYWRIGHT_CACHE_CANDIDATE" ]]; then
  path_in_use_as_cwd "$PLAYWRIGHT_CACHE_CANDIDATE" && fail 'Playwright cache became active during cleanup' 32
  if ps -eo args= | grep -F -- "$PLAYWRIGHT_CACHE_CANDIDATE" | grep -v -F 'grep -F' >/dev/null 2>&1; then
    fail 'Playwright cache is referenced by a running process' 33
  fi
  rm -rf -- "$PLAYWRIGHT_CACHE_CANDIDATE"
fi

# Prune only the pnpm content-addressed store. Running applications use their
# installed node_modules trees; both deployment locks are held to avoid install races.
pnpm store prune >/dev/null 2>&1 || fail 'pnpm store prune failed' 34

PM2_AFTER="$(pm2_snapshot)"
[[ "$PM2_AFTER" == "$PM2_BEFORE" ]] || fail 'protected PM2 status or restart count changed during cleanup' 35

DISK_AFTER_FREE_KB="$(df -Pk / | awk 'NR==2 {print $4}')"
DISK_AFTER_USE_PERCENT="$(df -Pk / | awk 'NR==2 {print $5}')"
[[ "$DISK_AFTER_FREE_KB" =~ ^[0-9]+$ ]] || fail 'could not read post-cleanup disk free space' 36
FREED_KB=$(( DISK_AFTER_FREE_KB - DISK_BEFORE_FREE_KB ))

emit_common
printf 'disk_after_free_kb=%s\n' "$DISK_AFTER_FREE_KB"
printf 'disk_after_use_percent=%s\n' "$DISK_AFTER_USE_PERCENT"
printf 'freed_kb=%s\n' "$FREED_KB"
printf 'server_processes_restarted=0\n'
printf 'staging_deployment_executed=false\n'
printf 'production_deployment_executed=false\n'
printf 'database_changes=0\n'
printf 'secret_values_collected=0\n'
printf 'SAFE_DISK_CLEANUP_COMPLETE\n'
