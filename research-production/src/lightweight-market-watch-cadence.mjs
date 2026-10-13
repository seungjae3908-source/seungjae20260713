import { createHash } from 'node:crypto';

// Self-reported, public-source cycle trace, not an external SLA, broker
// connection, 24h service attestation, profitability proof or trading signal.
export const WATCH_CADENCE_CONTRACT = 'public-watch-cadence-observation-v1';
export const WATCH_CADENCE_AUDIT = 'public-watch-cadence-diagnostic-v1';
export const CADENCE_WINDOW_MS = 24 * 60 * 60_000;
export const CADENCE_MAX_GAP_MS = 6 * 60_000;
export const CADENCE_MIN_CYCLES = 600;
export const CADENCE_MAX_WINDOW_ROWS = 2_000;
export const CADENCE_SAFE_STATUSES = Object.freeze([
  'OBSERVING_ALL_FOUR', 'PARTIAL_MARKET_COVERAGE', 'BLOCKED_DATA',
  'THROTTLED', 'HOLD',
]);
const MARKETS = Object.freeze([
  'KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES',
]);
const SHA40 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const BLOCKED = /^BLOCKED_[A-Z0-9_]{1,100}$/u;
const HEALTHY = new Set(['READY', 'PARTIAL_TICKERS', 'PARTIAL_UNIVERSE']);
const STATUS = new Set(CADENCE_SAFE_STATUSES);
const BUDGET = new Set(['RUN','THROTTLED','HOLD']);
const obj = x => x && typeof x === 'object' && !Array.isArray(x);
const count = x => Number.isSafeInteger(x) && x >= 0;
const sha = value => createHash('sha256').update(value).digest('hex');
function ms(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(s))
    return null;
  const t = Date.parse(s);
  return Number.isSafeInteger(t) && new Date(t).toISOString() === s ? t : null;
}
function content(row) {
  return JSON.stringify([
    row.researchSha, row.observedAt, row.cycleStatus,
    row.resourceBudget, row.markets,
  ]);
}
function wellFormed(row) {
  if (!obj(row) || row.schemaVersion !== WATCH_CADENCE_CONTRACT
    || !SHA40.test(row.researchSha ?? '') || ms(row.observedAt) == null
    || !STATUS.has(row.cycleStatus) || !BUDGET.has(row.resourceBudget)
    || !Array.isArray(row.markets) || row.markets.length !== 4
    || row.executionAuthority !== 'NONE' || row.paperCredit !== 0
    || row.oosCredit !== 0 || row.economicEvidenceCredit !== 0
    || row.publicPriceObservationOnly !== true
    || !SHA256.test(row.eventId ?? '')
    || row.eventId !== sha(WATCH_CADENCE_CONTRACT + ':' + content(row)))
    return false;
  let good = 0, partial = 0;
  for (let i = 0; i < MARKETS.length; i++) {
    const v = row.markets[i];
    if (!obj(v) || v.market !== MARKETS[i]
      || typeof v.status !== 'string'
      || !(HEALTHY.has(v.status) || BLOCKED.test(v.status))
      || !count(v.observedCount) || v.observedCount > 8_000
      || (v.status === 'READY' && v.observedCount === 0)
      || (BLOCKED.test(v.status) && v.observedCount !== 0)) return false;
    if (v.status === 'READY') good++;
    else if (HEALTHY.has(v.status)) partial++;
  }
  if (row.resourceBudget !== 'RUN')
    return row.cycleStatus === row.resourceBudget && good + partial === 0;
  if (good === 4) return row.cycleStatus === 'OBSERVING_ALL_FOUR';
  if (good + partial > 0) return row.cycleStatus === 'PARTIAL_MARKET_COVERAGE';
  return row.cycleStatus === 'BLOCKED_DATA';
}

export function makePublicWatchCadenceRecord(state) {
  if (!obj(state) || state.schemaVersion !== 'lightweight-market-opportunity-watch-v1'
    || !SHA40.test(state.researchSha ?? '')
    || ms(state.observedAt) == null || !STATUS.has(state.status)
    || !obj(state.resourceBudget) || !BUDGET.has(state.resourceBudget.status)
    || !Array.isArray(state.markets) || state.markets.length !== MARKETS.length)
    throw new Error('WATCH_CADENCE_SOURCE_INVALID');
  const row = {
    schemaVersion: WATCH_CADENCE_CONTRACT,
    researchSha: state.researchSha,
    observedAt: state.observedAt,
    cycleStatus: state.status,
    resourceBudget: state.resourceBudget.status,
    markets: state.markets.map((v,i) => {
      if (!obj(v) || v.market !== MARKETS[i]) throw new Error('WATCH_CADENCE_MARKET_INVALID');
      return { market:v.market, status:v.status, observedCount:v.observedCount };
    }),
    publicPriceObservationOnly:true, economicEvidenceCredit:0,
    oosCredit:0, paperCredit:0, executionAuthority:'NONE',
  };
  row.eventId = sha(WATCH_CADENCE_CONTRACT + ':' + content(row));
  if (!wellFormed(row)) throw new Error('WATCH_CADENCE_STATUS_MISMATCH');
  return Object.freeze(row);
}

export function createPublicWatchCadenceAudit({ researchSha, nowMs = Date.now() } = {}) {
  if (!SHA40.test(researchSha ?? '') || !Number.isSafeInteger(nowMs) || nowMs <= CADENCE_WINDOW_MS)
    throw new Error('WATCH_CADENCE_AUDIT_INPUT_INVALID');
  return {researchSha, nowMs, entries:new Map(), totalRows:0, duplicateRows:0,
    ignoredOtherRelease:0, filesRead:0, errors:new Set()};
}
export function addPublicWatchCadenceAuditRow(state, row) {
  state.totalRows++;
  if (state.totalRows > CADENCE_MAX_WINDOW_ROWS * 2) {
    state.errors.add('WATCH_CADENCE_TOO_MANY_ROWS');
    return false;
  }
  if (!wellFormed(row)) {
    state.errors.add('WATCH_CADENCE_ROW_INVALID');
    return false;
  }
  if (row.researchSha !== state.researchSha) {
    state.ignoredOtherRelease++;
    return true;
  }
  const at = ms(row.observedAt);
  if (at > state.nowMs + 5_000) {
    state.errors.add('WATCH_CADENCE_FUTURE_TIMESTAMP');
    return false;
  }
  if (at < state.nowMs - CADENCE_WINDOW_MS || at > state.nowMs)
    return true; // adjacent calendar-day input outside the rolling 24h window
  const old = state.entries.get(at);
  if (old) {
    if (old.eventId !== row.eventId) {
      state.errors.add('WATCH_CADENCE_CONFLICTING_CYCLE');
      return false;
    }
    state.duplicateRows++;
    return true;
  }
  if (state.entries.size >= CADENCE_MAX_WINDOW_ROWS) {
    state.errors.add('WATCH_CADENCE_TOO_MANY_CYCLES');
    return false;
  }
  state.entries.set(at, row);
  return true;
}
export function summarizePublicWatchCadenceAudit(state) {
  const times = [...state.entries.keys()].sort((a,b) => a-b);
  const rows = times.map(t => state.entries.get(t));
  let maxGapMs = 0, holdCycles = 0, throttledCycles = 0, noDataCycles = 0;
  const fourReadyCycles = rows.filter(v => v.cycleStatus === 'OBSERVING_ALL_FOUR').length;
  for(let i=0;i<rows.length;i++) {
    if (i) maxGapMs = Math.max(maxGapMs,times[i]-times[i-1]);
    if (rows[i].resourceBudget === 'HOLD') holdCycles++;
    if (rows[i].resourceBudget === 'THROTTLED') throttledCycles++;
    if (rows[i].cycleStatus === 'BLOCKED_DATA') noDataCycles++;
  }
  const firstAgeAtWindowMs = times.length
    ? times[0] - (state.nowMs - CADENCE_WINDOW_MS) : null;
  const latestAgeMs = times.length ? state.nowMs - times.at(-1) : null;
  const cadenceWindowObserved = times.length >= CADENCE_MIN_CYCLES
    && firstAgeAtWindowMs <= CADENCE_MAX_GAP_MS
    && latestAgeMs <= CADENCE_MAX_GAP_MS
    && maxGapMs <= CADENCE_MAX_GAP_MS
    && holdCycles === 0 && throttledCycles === 0;
  const invalid=state.errors.size > 0;
  return Object.freeze({
    contract:WATCH_CADENCE_AUDIT,
    status:invalid?'INVALID':times.length===0?'MISSING'
      :cadenceWindowObserved?'PUBLIC_CADENCE_OBSERVED':'INCOMPLETE_OR_INTERRUPTED',
    researchSha:state.researchSha,
    sampleCount:invalid?null:times.length,
    duplicateRows:state.duplicateRows,
    ignoredOtherReleaseRows:state.ignoredOtherRelease,
    filesRead:state.filesRead,
    earliestAgeFromWindowStartMs:invalid?null:firstAgeAtWindowMs,
    latestAgeMs:invalid?null:latestAgeMs,
    maxGapMs:invalid?null:maxGapMs,
    hostHoldCycles:invalid?null:holdCycles,
    hostThrottledCycles:invalid?null:throttledCycles,
    blockedDataCycles:invalid?null:noDataCycles,
    allFourMarketReadyCycles:invalid?null:fourReadyCycles,
    cadenceWindowObserved:!invalid && cadenceWindowObserved,
    // A private local file is not independently attested server uptime.
    continuous24hProven:false, completeFourMarketCoverageProven:false,
    oosCredit:0, paperCredit:0, economicEvidenceCredit:0,
    profitabilityProven:false, formulaCandidateProduced:false,
    executionAuthority:'NONE',
    errors:[...state.errors].sort().slice(0,8),
  });
}
