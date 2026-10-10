#!/usr/bin/env bash
# Owner-triggered, bounded read-only evidence for the already-active research-only watcher.
# This script never installs/restarts a service, writes server files, queries
# private provider APIs, or touches app/DB/PM2/trading/Paper/Telegram state.
set -Eeuo pipefail
umask 077

[[ "$RESEARCH_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 64
ROOT=/opt/investment-research
CURRENT="$ROOT/current"
RELEASE="$ROOT/releases/$RESEARCH_SHA"
STATE=/var/lib/investment-research-production
ENV_FILE=/etc/investment-research/research-production.env
UNIT=research-production-market-watch.service

asroot() {
  if (( EUID == 0 )); then "$@"; else sudo -n "$@"; fi
}
[[ "$(readlink -f "$CURRENT")" == "$RELEASE" ]] || {
  echo 'WATCH_DIAG_RELEASE_MISMATCH'; exit 70;
}
[[ "$(git -c "safe.directory=$RELEASE" -C "$CURRENT" rev-parse HEAD)" == "$RESEARCH_SHA" ]] || {
  echo 'WATCH_DIAG_GIT_SHA_MISMATCH'; exit 70;
}
[[ -d "$STATE" && ! -L "$STATE" ]] || exit 70
asroot grep -Fxq "RESEARCH_CODE_SHA=$RESEARCH_SHA" "$ENV_FILE" || exit 70
for guard in LIVE_TRADING=false PRIVATE_API_ENABLED=false ORDER_AUTHORITY=false; do
  asroot grep -Fxq "$guard" "$ENV_FILE" || exit 70
done
asroot systemctl is-enabled --quiet "$UNIT" || {
  echo 'WATCH_DIAG_UNIT_NOT_ENABLED'; exit 72;
}
asroot systemctl is-active --quiet "$UNIT" || {
  echo 'WATCH_DIAG_UNIT_NOT_ACTIVE'; exit 72;
}
command -v node >/dev/null
command -v runuser >/dev/null

# Both commands are existing audited read-only CLIs from the exact installed release.
read_only_cli() {
  asroot runuser -u investment-research -- env -i \
    PATH=/usr/local/bin:/usr/bin:/bin \
    RESEARCH_STATE_ROOT="$STATE" RESEARCH_CODE_SHA="$RESEARCH_SHA" \
    node "$CURRENT/research-production/bin/$1"
}
watch_json="$(read_only_cli lightweight-market-watch-status.mjs)" || exit 73
preflight_json="$(read_only_cli lightweight-market-watch-preflight.mjs)" || exit 73

restarts="$(asroot systemctl show "$UNIT" --property=NRestarts --value)"
memory="$(asroot systemctl show "$UNIT" --property=MemoryCurrent --value)"
if ! [[ "$restarts" =~ ^[0-9]{1,12}$ ]]; then restarts=unknown; fi
if ! [[ "$memory" =~ ^[0-9]{1,20}$ ]]; then memory=unknown; fi

# Project only small, explicitly validated aggregate fields; never log raw files,
# symbols, user data, environment secrets, or untrusted provider error messages.
WATCH_JSON="$watch_json" PREFLIGHT_JSON="$preflight_json" \
WATCH_RESTARTS="$restarts" WATCH_MEMORY="$memory" RESEARCH_SHA="$RESEARCH_SHA" \
node <<'NODE'
'use strict';
const watch = JSON.parse(process.env.WATCH_JSON);
const pre = JSON.parse(process.env.PREFLIGHT_JSON);
const symbols = ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'];
const token = v => typeof v === 'string' && /^[A-Z0-9_]{1,64}$/.test(v) ? v : 'UNKNOWN';
const count = v => Number.isSafeInteger(v) && v >= 0 ? String(v) : 'null';
if (watch.contract !== 'lightweight-market-watch-readback/v1'
  || watch.researchSha !== process.env.RESEARCH_SHA
  || watch.executionAuthority !== 'NONE'
  || watch.profitabilityProven !== false
  || watch.continuous24hProven !== false
  || watch.present !== true
  || !Array.isArray(watch.markets) || watch.markets.length !== 4
  || pre.contract !== 'public-market-watch-preflight-v1'
  || pre.executionAuthority !== 'NONE'
  || pre.independentlyVerified24hUptime !== false
  || pre.fourMarketWholeUniverseProven !== false
  || !pre.checks || pre.checks.marketWatch !== watch.status
  || typeof pre.status !== 'string'
  || watch.markets.some((m,i) => m.market !== symbols[i]))
  throw new Error('WATCH_DIAG_UNTRUSTED_READBACK');
const lines = [
  'WATCH_DIAG_BEGIN',
  'WATCH_RELEASE_SHA=' + process.env.RESEARCH_SHA,
  'WATCH_SERVICE_ACTIVE=true',
  'WATCH_STATUS=' + token(watch.status),
  'WATCH_PREFLIGHT=' + token(pre.status),
  'WATCH_COVERAGE_COUNT=' + count(watch.marketCoverageCount),
  'WATCH_LAST_CYCLE_AGE_MS=' + count(watch.ageMs),
  'WATCH_CYCLES_SINCE_RELEASE=' + count(watch.cyclesSinceRelease),
  'WATCH_CADENCE_SAMPLES=' + count(pre.observedCadenceSamples),
  'WATCH_DISK_RUNWAY_DAYS=' + count(pre.capacityProjectedDays),
  'WATCH_SERVICE_RESTARTS=' + (process.env.WATCH_RESTARTS === 'unknown' ? 'unknown' : count(Number(process.env.WATCH_RESTARTS))),
  'WATCH_MEMORY_CURRENT_BYTES=' + (process.env.WATCH_MEMORY === 'unknown' ? 'unknown' : count(Number(process.env.WATCH_MEMORY))),
];
for (const m of watch.markets) {
  lines.push('WATCH_' + m.market + '_STATUS=' + token(m.status));
  lines.push('WATCH_' + m.market + '_OBSERVED=' + count(m.observedCount));
  lines.push('WATCH_' + m.market + '_LISTED=' + count(m.listedCount));
}
lines.push('WATCH_24H_UPTIME_PROVEN=false');
lines.push('WATCH_FOUR_MARKET_FULL_FEED_PROVEN=false');
lines.push('WATCH_PAPER_EXECUTION_PROVEN=false');
lines.push('WATCH_PROFITABILITY_PROVEN=false');
lines.push('WATCH_EXECUTION_AUTHORITY=NONE');
lines.push('WATCH_RESEARCH_ONLY=true');
lines.push('WATCH_DIAG_END');
process.stdout.write(lines.join('\n') + '\n');
NODE
