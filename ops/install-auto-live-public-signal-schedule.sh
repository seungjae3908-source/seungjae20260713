#!/usr/bin/env bash
# Independent 15m PUBLIC-ONLY observation source. NEVER modifies Paper
# Forward's original cron, state, accounts, DB, PM2 or user funds.
# Not wired into Production release; requires separate owner approval.
set -Eeuo pipefail
umask 077
fail() { printf '[auto-live-independent] %s\n' "$1" >&2; exit 1; }
(( $# == 1 )) || fail 'exact source SHA required'
SHA="$1"
ROOT='/opt/stock-app-data/auto-live-signal-v1'
PARENT='/opt/stock-app-data'
APP='/opt/stock-app'
LOCK="$PARENT/auto-live-signal-v1-install.lock"
WRAPPER="$ROOT/bin/run-auto-live-public-signal"
CRON_LINE="*/15 * * * * /usr/bin/flock -n $ROOT/cron.lock $WRAPPER # stock-app-auto-live-public-signal-v1"
STAGED=''
CHANGED_CRON=0
COMMITTED_ROOT=0
OLD_CRON=''
cleanup() {
  status=$?
  trap - EXIT
  if (( status != 0 )) && (( CHANGED_CRON == 1 )); then
    if [[ -n "$OLD_CRON" ]]; then
      printf '%s\n' "$OLD_CRON" | crontab - || true
    else crontab -r 2>/dev/null || true; fi
  fi
  if (( status != 0 )) && (( COMMITTED_ROOT == 1 )); then
    : > "$ROOT/DISABLED" || true
    chmod 600 "$ROOT/DISABLED" || true
  fi
  if [[ -n "$STAGED" && -d "$STAGED" ]]; then rm -rf -- "$STAGED"; fi
  exit "$status"
}
trap cleanup EXIT
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'SHA invalid'
[[ "$(printenv AUTO_LIVE_PUBLIC_SIGNAL_INSTALL_APPROVED || true)" == 'true' ]] || fail 'owner approval required'
[[ -d "$PARENT" && ! -L "$PARENT" ]] || fail 'protected parent missing'
[[ -f "$APP/.deploy/current-sha" ]] || fail 'deployed SHA marker missing'
[[ "$(tr -d '[:space:]' < "$APP/.deploy/current-sha")" == "$SHA" ]] || fail 'deployed SHA mismatch'
[[ ! -e "$ROOT" && ! -L "$ROOT" ]] || fail 'isolated state already owned'
for cmd in rsync crontab flock node find sort xargs sha256sum; do
  command -v "$cmd" >/dev/null 2>&1 || fail 'dependency missing'
done
[[ -x /usr/bin/flock ]] || fail 'canonical flock path invalid'
for f in "$APP/market-prediction-lab/scripts/run-paper-forward-schedule.js" \
  "$APP/packages/strategy-hypothesis/src/index.js" "$APP/packages/external-research/src/index.js"; do
  [[ -r "$f" ]] || fail 'canonical public source missing'
done
exec 9>"$LOCK"
flock -n 9 || fail 'installer already running'
set +e
OLD_CRON="$(crontab -l 2>/dev/null)"
rc=$?
set -e
[[ "$rc" == 0 || "$rc" == 1 ]] || fail 'cannot inspect cron'
[[ "$OLD_CRON" != *'stock-app-auto-live-public-signal-v1'* ]] || fail 'dedicated cron already owned'
[[ "$OLD_CRON" != *"$WRAPPER"* ]] || fail 'dedicated wrapper already owned'
STAGED="$(mktemp -d "$PARENT/.auto-live-source-stage.XXXXXXXX")"
chmod 700 "$STAGED"
mkdir -p "$STAGED/release/market-prediction-lab" \
  "$STAGED/release/packages/strategy-hypothesis" \
  "$STAGED/release/packages/external-research" \
  "$STAGED/runtime-state" "$STAGED/bin" "$STAGED/logs"
# Copy only canonical code; NEVER copy runtime state, secrets or journal data.
for rel in market-prediction-lab packages/strategy-hypothesis packages/external-research; do
  rsync -a --delete --exclude='node_modules/' --exclude='runtime/' \
    --exclude='.env' --exclude='.env.*' --exclude='*.key' \
    "$APP/$rel/" "$STAGED/release/$rel/"
done
find "$STAGED/release" -type f -exec chmod go-rwx {} +
find "$STAGED/release" -type d -exec chmod 700 {} +
ACTIVATED_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
cat > "$STAGED/bin/run-auto-live-public-signal" <<WRAPPER
#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ ! -e "$ROOT/DISABLED" ]] || exit 0
[[ ! -e "$ROOT/runtime-state/DISABLED" ]] || exit 0
exec /usr/bin/env -i \\
  HOME='/tmp' PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \\
  NODE_ENV='production' PAPER_FORWARD_SCHEDULE_ACTIVE='true' \\
  PAPER_FORWARD_TRIGGER_SOURCE='cron' \\
  PAPER_FORWARD_ROOT='$ROOT/runtime-state' \\
  PAPER_FORWARD_RESEARCH_SHA='$SHA' \\
  PAPER_FORWARD_ACTIVATION_AT_MS='$ACTIVATED_MS' \\
  AUTO_LIVE_PUBLIC_SIGNAL_REFRESH_ENABLED='true' \\
  PAPER_FORWARD_OUTCOME_ACCUMULATION_ENABLED='false' RESEARCH_PRODUCTION='false' \\
  LIVE_TRADING='false' LIVE_TRADING_ENABLED='false' \\
  REAL_ORDER_ENABLED='false' PRIVATE_TRADING_API_ALLOWED='false' \\
  PRIVATE_API_ENABLED='false' PRIVATE_ACCOUNT_ACCESS='false' \\
  node '$ROOT/release/market-prediction-lab/scripts/run-paper-forward-schedule.js' \\
  >> '$ROOT/logs/cron.log' 2>&1
WRAPPER
chmod 700 "$STAGED/bin/run-auto-live-public-signal"
TREE_SHA="$(find "$STAGED/release" -type f -print0 | sort -z | xargs -0 -r sha256sum | sha256sum | awk '{print $1}')"
CRON_HASH="$(printf '%s' "$CRON_LINE" | sha256sum | awk '{print $1}')"
node - "$STAGED/activation.json" "$SHA" "$ACTIVATED_MS" "$TREE_SHA" "$CRON_HASH" <<'NODE'
const fs=require('fs');
const [dest,sha,at,digest,cronHash]=process.argv.slice(2);
const value={
  schemaVersion:'auto-live-public-signal-activation-v1',
  status:'WAITING_FOR_GENUINE_PUBLIC_CYCLE',targetSha:sha,
  activationAtMs:Number(at), installedAt:new Date(Number(at)).toISOString(),
  isolatedRoot:'/opt/stock-app-data/auto-live-signal-v1',
  paperRootMutated:false, paperCronReplaced:false,
  pollIntervalMs:900000, runtimeDigest:digest, cronHash,
  sourceTransportOnly:true, issuerVerified:false, orderAuthority:false,
  privateApiAllowed:false, financialMutationAllowed:false, liveTrading:false,
  autoTradingActivationReady:false,
};
fs.writeFileSync(dest,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});
NODE
# Publish immutable isolated files first, register cron last. On failed cron
# readback leave DISABLED marker to prevent an accidental background run.
mv -T "$STAGED" "$ROOT"
STAGED=''
COMMITTED_ROOT=1
if [[ -n "$OLD_CRON" ]]; then
  printf '%s\n%s\n' "$OLD_CRON" "$CRON_LINE" | crontab -
else printf '%s\n' "$CRON_LINE" | crontab -; fi
CHANGED_CRON=1
CURRENT="$(crontab -l)"
[[ "$(printf '%s\n' "$CURRENT" | grep -Fxc "$CRON_LINE" || true)" == "1" ]] || fail 'dedicated cron readback invalid'
if [[ -n "$OLD_CRON" ]]; then
  [[ "$CURRENT" == "$OLD_CRON"$'\n'"$CRON_LINE" ]] || fail 'unrelated crontab changed'
fi
CHANGED_CRON=0
COMMITTED_ROOT=0
trap - EXIT
printf '{"status":"WAITING_FOR_GENUINE_PUBLIC_CYCLE","targetSha":"%s","paperRootMutated":false,"paperCronReplaced":false,"issuerVerified":false,"autoTradingActivated":false,"financialMutationCount":0,"realOrderCount":0}\n' "$SHA"
