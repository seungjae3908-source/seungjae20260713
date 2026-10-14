#!/usr/bin/env bash
# Protected, offline, create-only Telegram materialization. No API/worker starts.
set -Eeuo pipefail
umask 077
[[ "$TELEGRAM_DORMANT_PROTECTED_REVIEW" == "true" ]] || {
  echo 'TELEGRAM_DORMANT_PROTECTED_REVIEW_REQUIRED' >&2; exit 21;
}
SHA="$1"
TAR_SHA="$2"
INSTALLER_SHA="$3"
[[ "$SHA" =~ ^[0-9a-f]{40}$ && "$TAR_SHA" =~ ^[0-9a-f]{64}$
   && "$INSTALLER_SHA" =~ ^[0-9a-f]{64}$ ]] || exit 21
BASE=/opt/stock-app-data/telegram-isolated-v1
INPUT="$BASE/incoming/$SHA"
[[ -d "$INPUT" && ! -L "$INPUT" && -d "$BASE/release" && ! -L "$BASE/release" ]] || exit 22
[[ ! -e "$BASE/release/current" && ! -L "$BASE/release/current" ]] || exit 22
for part in telegram-dormant-payload.tar install-telegram-isolated-dormant-package.mjs; do
  [[ -f "$INPUT/$part" && ! -L "$INPUT/$part" ]] || exit 22
done
[[ "$(sha256sum "$INPUT/telegram-dormant-payload.tar" | cut -d' ' -f1)" == "$TAR_SHA" ]] || exit 22
# Pin the exact installer copied over SSH, before ever executing its JavaScript.
[[ "$(sha256sum "$INPUT/install-telegram-isolated-dormant-package.mjs" | cut -d' ' -f1)" == "$INSTALLER_SHA" ]] || {
  echo 'TELEGRAM_DORMANT_INSTALLER_SOURCE_MISMATCH' >&2; exit 22;
}
[[ ! -L /var/lock/stock-app-deploy.lock && ! -L "$BASE/telegram-owner.lock" ]] || exit 23
exec 8>/var/lock/stock-app-deploy.lock
flock -n 8 || exit 23
exec 9>"$BASE/telegram-owner.lock"
flock -n 9 || exit 23
pm2_digest() {
  pm2 jlist | node -e '
    const fs=require("node:fs"),crypto=require("node:crypto");
    try {
      const rows=JSON.parse(fs.readFileSync(0,"utf8")).filter(x=>x.name==="stock-app");
      if(rows.length!==1||rows[0].pm2_env?.status!=="online")throw Error("pm2");
      const sha=fs.readFileSync("/opt/stock-app/.deploy/current-sha","utf8").trim();
      if(!/^[0-9a-f]{40}$/.test(sha)||rows[0].pm2_env.DEPLOY_SHA!==sha)throw Error("sha");
      const input=JSON.stringify({pid:rows[0].pid,marker:sha,env:rows[0].pm2_env});
      process.stdout.write(crypto.createHash("sha256").update(input).digest("hex"));
    }catch {
      console.error("TELEGRAM_DORMANT_PM2_READBACK_INVALID");
      process.exit(26);
    }
  '
}
before="$(pm2_digest)"
mkdir -m 700 -- "$INPUT/unpacked"
actual="$(tar -tf "$INPUT/telegram-dormant-payload.tar" | LC_ALL=C sort)"
expected="$(printf '%s\n' \
  '.deploy/current-sha' '.deploy/preparation.json' '.deploy/telegram-sha256.manifest' \
  'api-server/dist/telegram-isolated-worker.mjs' \
  'ops/run-telegram-isolated-worker.sh' \
  'ops/telegram-legacy-owner-runtime-proof.mjs' | LC_ALL=C sort)"
[[ "$actual" == "$expected" ]] || exit 24
tar --no-same-owner --no-same-permissions \
  -xf "$INPUT/telegram-dormant-payload.tar" -C "$INPUT/unpacked"
NODE_OPTIONS= node "$INPUT/install-telegram-isolated-dormant-package.mjs" \
  "$INPUT/unpacked" "$SHA" > "$INPUT/installation-receipt.json"
NODE_OPTIONS= node - "$INPUT/installation-receipt.json" "$SHA" <<'NODE'
const fs=require('node:fs');
const r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(r.schemaVersion!=='telegram-isolated-dormant-install-v1'
  ||r.sha!==process.argv[3]||r.mode!=='STAGED_INACTIVE'
  ||r.workerStarted!==false||r.productionAppChanged!==false
  ||r.pm2Restarts!==0||r.telegramMessages!==0||r.financialMutations!==0)
  throw Error('TELEGRAM_DORMANT_RECEIPT_INVALID');
NODE
after="$(pm2_digest)"
[[ "$before" == "$after" ]] || {
  echo 'TELEGRAM_DORMANT_PM2_CHANGED_UNEXPECTEDLY' >&2; exit 26;
}
echo 'TELEGRAM_DORMANT_INSTALLED_INACTIVE_PM2_UNCHANGED'
