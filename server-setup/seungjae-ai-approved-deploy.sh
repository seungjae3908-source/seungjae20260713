#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

JOB_ID="${1:-}"
WORKSPACE_RAW="${2:-}"
EXPECTED_COMMIT="${3:-}"
BRANCH="${4:-}"

DATA_ROOT="${AI_REPAIR_DATA_DIR:-/var/lib/seungjae-ai-repair}"
TARGET="${AI_REPAIR_TARGET_PATH:-/opt/stock-app}"
BACKUP_ROOT="${AI_REPAIR_BACKUP_ROOT:-/var/backups/seungjae-ai-repair}"
HEALTH_URL="${AI_REPAIR_HEALTH_URL:-https://lsj119.duckdns.org/api/health}"
PM2_APP="${AI_REPAIR_PM2_APP:-stock-app}"
PNPM_BIN="${AI_REPAIR_PNPM_BIN:-pnpm}"
HEALTH_ATTEMPTS="${AI_REPAIR_HEALTH_ATTEMPTS:-30}"
HEALTH_SLEEP_SECONDS="${AI_REPAIR_HEALTH_SLEEP_SECONDS:-2}"
LOCK_FILE="${AI_REPAIR_DEPLOY_LOCK:-/var/lock/seungjae-ai-repair-deploy.lock}"

[[ "$JOB_ID" =~ ^repair-[0-9]+-[a-f0-9]{8}$ ]] || { echo "INVALID_JOB_ID" >&2; exit 2; }
[[ "$EXPECTED_COMMIT" =~ ^[a-f0-9]{40}$ ]] || { echo "INVALID_COMMIT" >&2; exit 2; }
[[ "$BRANCH" =~ ^ai-repair/[A-Za-z0-9._/-]+$ ]] || { echo "INVALID_BRANCH" >&2; exit 2; }
[[ -d "$WORKSPACE_RAW" ]] || { echo "WORKSPACE_NOT_FOUND" >&2; exit 2; }
[[ -d "$TARGET" ]] || { echo "TARGET_NOT_FOUND" >&2; exit 2; }
[[ "$HEALTH_ATTEMPTS" =~ ^[0-9]+$ ]] && (( HEALTH_ATTEMPTS >= 1 && HEALTH_ATTEMPTS <= 120 )) || { echo "INVALID_HEALTH_ATTEMPTS" >&2; exit 2; }
[[ "$HEALTH_SLEEP_SECONDS" =~ ^[0-9]+$ ]] && (( HEALTH_SLEEP_SECONDS <= 30 )) || { echo "INVALID_HEALTH_SLEEP" >&2; exit 2; }

mkdir -p "$(dirname "$LOCK_FILE")" "$BACKUP_ROOT"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "DEPLOY_ALREADY_RUNNING" >&2; exit 3; }

WORKSPACE="$(realpath -e "$WORKSPACE_RAW")"
DATA_ROOT_REAL="$(realpath -m "$DATA_ROOT")"
TARGET_REAL="$(realpath -e "$TARGET")"
case "$WORKSPACE" in
  "$DATA_ROOT_REAL"/workspaces/*) ;;
  *) echo "WORKSPACE_OUTSIDE_ALLOWED_ROOT" >&2; exit 4 ;;
esac

cd "$WORKSPACE"
[[ "$(git rev-parse HEAD)" == "$EXPECTED_COMMIT" ]] || { echo "COMMIT_MISMATCH" >&2; exit 5; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo "WORKSPACE_NOT_CLEAN" >&2; exit 5; }

echo "[1/6] 승인된 커밋 재검증"
"$PNPM_BIN" --dir stock-analyzer run typecheck
"$PNPM_BIN" --dir api-server run typecheck
"$PNPM_BIN" --dir stock-analyzer run build
(
  cd api-server
  node build.mjs
)

STAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP="$BACKUP_ROOT/${JOB_ID}_${STAMP}"
mkdir -p "$BACKUP"

echo "[2/6] 운영본 백업: $BACKUP"
rsync -a --checksum --numeric-ids \
  --exclude='.git/' \
  --exclude='.env' --exclude='.env.*' \
  --exclude='node_modules/' \
  --exclude='.ai-repair-data/' \
  "$TARGET_REAL/" "$BACKUP/"

restart_app() {
  if command -v pm2 >/dev/null 2>&1 && pm2 describe "$PM2_APP" >/dev/null 2>&1; then
    pm2 restart "$PM2_APP" --update-env
    pm2 save >/dev/null 2>&1 || true
  elif systemctl list-unit-files "${PM2_APP}.service" >/dev/null 2>&1; then
    systemctl restart "${PM2_APP}.service"
  else
    echo "APP_RESTART_METHOD_NOT_FOUND" >&2
    return 1
  fi
}

rollback() {
  local exit_code=$?
  trap - ERR
  echo "배포 실패 — 직전 백업으로 자동 복구합니다." >&2
  rsync -a --checksum --numeric-ids \
    --exclude='.git/' \
    --exclude='.env' --exclude='.env.*' \
    --exclude='node_modules/' \
    --exclude='.ai-repair-data/' \
    "$BACKUP/" "$TARGET_REAL/" || true
  restart_app || true
  echo "ROLLBACK_COMPLETED backup=$BACKUP" >&2
  exit "$exit_code"
}
trap rollback ERR

echo "[3/6] 승인된 작업공간 운영 반영"
rsync -a --checksum --numeric-ids \
  --exclude='.git/' \
  --exclude='.env' --exclude='.env.*' \
  --exclude='node_modules/' \
  --exclude='.ai-repair-data/' \
  "$WORKSPACE/" "$TARGET_REAL/"

echo "[4/6] 앱 재시작"
restart_app

echo "[5/6] 운영 상태 검사"
HEALTH_OK=0
for _ in $(seq 1 "$HEALTH_ATTEMPTS"); do
  if curl --fail --silent --show-error --max-time 10 "$HEALTH_URL" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
    HEALTH_OK=1
    break
  fi
  sleep "$HEALTH_SLEEP_SECONDS"
done
[[ "$HEALTH_OK" == "1" ]] || { echo "HEALTH_CHECK_FAILED: $HEALTH_URL" >&2; false; }

echo "[6/6] 배포 완료"
trap - ERR
echo "DEPLOY_OK job=$JOB_ID commit=$EXPECTED_COMMIT branch=$BRANCH backup=$BACKUP"
