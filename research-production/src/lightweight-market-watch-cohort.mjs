// Read-only, bounded public ticker observation cohort. This is not an OOS,
// backtest, executable signal, paper result, full-cost PnL, or profitability.
import { createHash } from 'node:crypto';

export const WATCH_COHORT_CONTRACT = 'public-watch-cohort-diagnostic-v1';
const DISCOVERY = 'lightweight-market-opportunity-watch-v1';
const PROSPECTIVE = 'public-watch-prospective-price-study-v1';
const MARKETS = new Set(['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES']);
const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SYMBOL = /^[A-Z0-9][A-Z0-9._-]{0,31}$/u;
const SOURCE = /^[A-Za-z0-9._-]{3,80}$/u;
const DAY_MS = 86_400_000;
export const WATCH_COHORT_MAX_ROWS = 45_000;
const number = v => typeof v === 'number' && Number.isFinite(v);
const safeAt = v => Number.isSafeInteger(v) && v > 0;
const record = v => v && typeof v === 'object' && !Array.isArray(v);
const safeCount = v => Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000_000;

export function parseWatchCohortDay(dayUtc) {
  if (typeof dayUtc !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(dayUtc))
    throw new Error('WATCH_COHORT_DATE_INVALID');
  const ms = Date.parse(dayUtc + 'T00:00:00.000Z');
  if (!Number.isSafeInteger(ms) || new Date(ms).toISOString().slice(0,10) !== dayUtc)
    throw new Error('WATCH_COHORT_DATE_INVALID');
  return ms;
}

export function createPublicWatchCohort({ dayUtc, researchSha, nowMs = Date.now() }) {
  const startMs = parseWatchCohortDay(dayUtc);
  if (!SHA40.test(researchSha ?? '') || !safeAt(nowMs))
    throw new Error('WATCH_COHORT_IDENTITY_INVALID');
  return {
    dayUtc, startMs, nowMs, researchSha,
    events: new Map(), outcomes: new Map(), fileCount: 0,
    eventRows: 0, outcomeRows: 0, ignoredOtherReleases: 0,
    duplicateEvents: 0, duplicateOutcomes: 0,
    invalid: new Set(),
  };
}
function problem(state, code) {
  state.invalid.add(code);
  return false;
}
function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
function candidateId(v) {
  return digest(JSON.stringify({
    researchSha:v.researchSha, market:v.market, symbol:v.symbol,
    direction:v.direction, source:v.source, sourceAtMs:v.sourceAtMs,
    priorSourceAtMs:v.priorSourceAtMs,
  }));
}
export function addPublicWatchDiscovery(state, v) {
  state.eventRows++;
  if (state.eventRows > WATCH_COHORT_MAX_ROWS)
    return problem(state, 'WATCH_COHORT_EVENTS_LIMIT');
  if (!record(v) || v.schemaVersion !== DISCOVERY
    || !SHA256.test(v.eventId ?? '') || !SHA40.test(v.researchSha ?? '')
    || !MARKETS.has(v.market) || !SYMBOL.test(v.symbol ?? '')
    || !SOURCE.test(v.source ?? '') || !['UP','DOWN'].includes(v.direction)
    || !safeAt(v.sourceAtMs) || !safeAt(v.priorSourceAtMs)
    || v.priorSourceAtMs >= v.sourceAtMs
    || typeof v.observedAt !== 'string'
    || !safeAt(Date.parse(v.observedAt))
    || v.eventId !== candidateId(v)
    || v.kind !== 'PROVISIONAL_PRICE_ACCELERATION'
    || v.executionAuthority !== 'NONE'
    || v.isTradingSignal !== false || v.aiReviewed !== false
    || v.oosPassed !== false || v.paperAdmitted !== false) {
    return problem(state, 'WATCH_COHORT_DISCOVERY_INVALID');
  }
  // Releasing a new exact SHA may put two valid cohorts in the same day log.
  if (v.researchSha !== state.researchSha) {
    state.ignoredOtherReleases++;
    return true;
  }
  const at = Date.parse(v.observedAt);
  if (at < state.startMs || at >= state.startMs + DAY_MS
    || at > state.nowMs + 5000 || v.sourceAtMs > at + 5000
    || at - v.sourceAtMs > 6 * 60_000)
    return problem(state, 'WATCH_COHORT_DISCOVERY_TIME_INVALID');
  const existing = state.events.get(v.eventId);
  if (existing) {
    if (existing.market !== v.market || existing.source !== v.source
      || existing.symbol !== v.symbol || existing.direction !== v.direction
      || existing.eventAtMs !== v.sourceAtMs)
      return problem(state, 'WATCH_COHORT_DISCOVERY_CONFLICT');
    state.duplicateEvents++;
    return true;
  }
  state.events.set(v.eventId, {
    market:v.market, source:v.source, symbol:v.symbol,
    direction:v.direction, eventAtMs:v.sourceAtMs,
  });
  return true;
}
export function addPublicWatchOutcome(state, v) {
  state.outcomeRows++;
  if (state.outcomeRows > WATCH_COHORT_MAX_ROWS * 2)
    return problem(state, 'WATCH_COHORT_OUTCOMES_LIMIT');
  if (!record(v) || v.contract !== PROSPECTIVE
    || !SHA256.test(v.eventId ?? '') || !SHA256.test(v.outcomeId ?? '')
    || v.outcomeId !== digest(PROSPECTIVE + ':' + v.eventId)
    || !MARKETS.has(v.market) || !SYMBOL.test(v.symbol ?? '')
    || !SOURCE.test(v.source ?? '') || !['UP','DOWN'].includes(v.direction)
    || v.kind !== 'PUBLIC_PRICE_OBSERVATION_ONLY'
    || !['OBSERVED_COARSE','BLOCKED_DATA'].includes(v.status)
    || !safeAt(v.eventAtMs) || !safeAt(v.evaluatedAtMs)
    || v.evaluatedAtMs < v.eventAtMs
    || v.evaluatedAtMs > state.nowMs + 5000
    || !number(v.referencePrice) || v.referencePrice <= 0
    || v.horizonTargetMs !== 20 * 60_000
    || !safeCount(v.sampledFutureN) || v.sampledFutureN > 32
    || v.sourceTimeBound !== true
    || v.economicEvidenceCredit !== 0 || v.paperCredit !== 0
    || v.oosCredit !== 0 || v.executionAuthority !== 'NONE'
    || v.isTradingSignal !== false || v.orderAllowed !== false
    || v.profitabilityProven !== false) {
    return problem(state, 'WATCH_COHORT_OUTCOME_INVALID');
  }
  if (v.status === 'OBSERVED_COARSE') {
    if (!safeAt(v.sampledElapsedMs)
      || v.sampledElapsedMs < 17 * 60_000 || v.sampledElapsedMs > 20 * 60_000
      || v.sampledFutureN < 4
      || !number(v.sampledFavorableExcursionPercent)
      || !number(v.sampledAdverseExcursionPercent)) {
      return problem(state, 'WATCH_COHORT_COARSE_INVALID');
    }
  } else if (v.sampledElapsedMs !== null
    || v.sampledFavorableExcursionPercent !== null
    || v.sampledAdverseExcursionPercent !== null) {
    return problem(state, 'WATCH_COHORT_BLOCKED_INVALID');
  }
  const existing = state.outcomes.get(v.outcomeId);
  if (existing) {
    if (existing.eventId !== v.eventId || existing.status !== v.status
      || existing.market !== v.market || existing.eventAtMs !== v.eventAtMs
      || existing.source !== v.source || existing.symbol !== v.symbol
      || existing.direction !== v.direction) {
      return problem(state, 'WATCH_COHORT_OUTCOME_CONFLICT');
    }
    state.duplicateOutcomes++;
    return true;
  }
  state.outcomes.set(v.outcomeId, {
    eventId:v.eventId, market:v.market, source:v.source, symbol:v.symbol,
    direction:v.direction, eventAtMs:v.eventAtMs, status:v.status,
  });
  return true;
}
export function summarizePublicWatchCohort(state) {
  let observedCoarse = 0, blockedData = 0, unmatchedOtherCohorts = 0;
  const matched = new Set();
  for (const outcome of state.outcomes.values()) {
    const e = state.events.get(outcome.eventId);
    if (!e) { unmatchedOtherCohorts++; continue; }
    if (e.market !== outcome.market || e.source !== outcome.source
      || e.symbol !== outcome.symbol || e.direction !== outcome.direction
      || e.eventAtMs !== outcome.eventAtMs) {
      problem(state, 'WATCH_COHORT_IDENTITY_CONFLICT');
      continue;
    }
    matched.add(outcome.eventId);
    if (outcome.status === 'OBSERVED_COARSE') observedCoarse++;
    else blockedData++;
  }
  const invalid = state.invalid.size > 0;
  const count = state.events.size;
  // All statuses are diagnostics only. Even a fully observed public-ticker
  // cohort has zero economic/strategy/trading admission credit.
  return Object.freeze({
    contract:WATCH_COHORT_CONTRACT,
    status:invalid ? 'INVALID' : state.fileCount === 0 ? 'MISSING'
      : count > 0 ? 'PUBLIC_SAMPLES_ONLY' : 'NO_DISCOVERIES',
    dayUtc:state.dayUtc, researchSha:state.researchSha,
    filesRead:state.fileCount,
    rawEventRows:state.eventRows, rawOutcomeRows:state.outcomeRows,
    discoveryCount:invalid ? null : count,
    deduplicatedDiscoveryRows:state.duplicateEvents,
    deduplicatedOutcomeRows:state.duplicateOutcomes,
    observedCoarseCount:invalid ? null : observedCoarse,
    blockedDataCount:invalid ? null : blockedData,
    missingOutcomeCount:invalid ? null : count - matched.size,
    otherReleaseEventRows:state.ignoredOtherReleases,
    unpairedOtherDayOutcomeRows:unmatchedOtherCohorts,
    errorCodes:[...state.invalid].slice(0,8),
    // A coarse future ticker price movement is never a trade result.
    economicEvidenceCredit:0, oosCredit:0, paperCredit:0,
    fullCostReady:false, profitabilityProven:false,
    continuous24hProven:false, formulaCandidateProduced:false,
    isTradingSignal:false, executionAuthority:'NONE',
  });
}
