#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

STATE_ROOT="${PAPER_FORWARD_STATE_ROOT:-/opt/stock-app-data/paper-forward-v1}"
TAG="# stock-app-paper-forward-v1"
BACKUP_DIR="$STATE_ROOT/crontab-backups"

fail() {
  echo "[paper-forward-disable] $1" >&2
  exit "${2:-1}"
}

[[ "$STATE_ROOT" == /opt/stock-app-data/paper-forward-v1 ]] || fail "unexpected persistent state root" 2
for command_name in crontab mkdir date grep sed node chmod tr; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name" 3
done

mkdir -p "$STATE_ROOT" "$BACKUP_DIR"
chmod 700 "$STATE_ROOT" "$BACKUP_DIR"
: > "$STATE_ROOT/DISABLED"
chmod 600 "$STATE_ROOT/DISABLED"

PREVIOUS_CRONTAB="$(crontab -l 2>/dev/null || true)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_PATH="$BACKUP_DIR/$STAMP-before-disable.crontab"
printf '%s' "$PREVIOUS_CRONTAB" > "$BACKUP_PATH"
chmod 600 "$BACKUP_PATH"

FILTERED="$(printf '%s\n' "$PREVIOUS_CRONTAB" | grep -vF "$TAG" || true)"
if [[ -n "$(printf '%s' "$FILTERED" | tr -d '[:space:]')" ]]; then
  printf '%s\n' "$FILTERED" | sed '/^[[:space:]]*$/d' | crontab -
else
  crontab -r 2>/dev/null || true
fi

if crontab -l 2>/dev/null | grep -F "$TAG" >/dev/null; then
  fail "Paper Forward cron entry remained after disable" 4
fi

DISABLED_AT_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
node - "$STATE_ROOT/disabled.json" "$DISABLED_AT_MS" "$BACKUP_PATH" <<'NODE'
const fs = require('node:fs');
const [path, disabledAtMs, backupPath] = process.argv.slice(2);
const value = {
  schemaVersion: 'paper-forward-schedule-disable-v1',
  status: 'DISABLED',
  disabledAtMs: Number(disabledAtMs),
  disabledAt: new Date(Number(disabledAtMs)).toISOString(),
  crontabBackupPath: backupPath,
  statePreserved: true,
  scheduleActive: false,
  liveTrading: false,
  privateAccountAccess: false,
  orderAuthority: false,
};
const temp = `${path}.tmp-${process.pid}`;
fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temp, path);
NODE

printf '{"status":"DISABLED","scheduleActive":false,"statePreserved":true,"privateRequestCount":0,"financialMutationCount":0,"liveTrading":false}\n'
