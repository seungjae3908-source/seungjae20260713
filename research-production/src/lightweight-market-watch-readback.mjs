// Sanitized, deterministic, read-only status of the isolated public market watch.
// This is not an assertion of 24-hour uptime, profitability or trading authority.

export const WATCH_READBACK_CONTRACT = 'lightweight-market-watch-readback/v1';
const SOURCE_CONTRACT = 'lightweight-market-opportunity-watch-v1';
const MARKETS = Object.freeze([
  'KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES',
]);
const STATES = new Set([
  'OBSERVING_ALL_FOUR', 'PARTIAL_MARKET_COVERAGE', 'BLOCKED_DATA',
  'HOLD', 'THROTTLED',
]);
const HEALTHY_SOURCE = new Set(['READY', 'PARTIAL_TICKERS', 'PARTIAL_UNIVERSE']);
const SHA = /^[a-f0-9]{40}$/;
const SAFE_SOURCE = /^[A-Za-z0-9_-]{1,80}$/;
const BLOCKED = /^BLOCKED_[A-Z0-9_]{1,100}$/;
const MAX_AGE_MS = 6 * 60_000;
const MAX_FUTURE_MS = 5_000;
function object(x) {
  return x && typeof x === 'object' && !Array.isArray(x) ? x : null;
}
function safeCount(v) {
  return Number.isSafeInteger(v) && v >= 0 && v < 1_000_000_000_000;
}
function empty(status = 'MISSING', present = false) {
  return Object.freeze({
    contract: WATCH_READBACK_CONTRACT,
    status, present, researchSha: null, observedAt: null, ageMs: null,
    marketCoverageCount: null, markets: Object.freeze([]),
    cyclesToday: null, candidatesToday: null, cyclesSinceRelease: null,
    continuous24hProven: false,
    formulaCandidateProduced: false, oosProven: false,
    paperExecutionProven: false, profitabilityProven: false,
    executionAuthority: 'NONE',
  });
}
function validTime(v, nowMs, upper = nowMs + MAX_FUTURE_MS) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const n = Date.parse(v);
  return Number.isFinite(n) && n > 0 && n <= upper ? n : null;
}
export function summarizeLightweightMarketWatch(
  raw, nowMs = Date.now(), expectedSha = null,
) {
  if (raw == null) return empty();
  const v = object(raw);
  if (!v || v.schemaVersion !== SOURCE_CONTRACT
    || !SHA.test(v.researchSha ?? '')
    || !STATES.has(v.status)
    || !Number.isFinite(nowMs)
    || (expectedSha != null && expectedSha !== v.researchSha)) return empty('INVALID', true);
  const observedAt = validTime(v.observedAt, nowMs);
  if (observedAt == null) return empty('INVALID', true);
  const budget = object(v.resourceBudget);
  if (!budget || !['RUN', 'THROTTLED', 'HOLD'].includes(budget.status)
    || (v.status === 'THROTTLED' && budget.status !== 'THROTTLED')
    || (v.status === 'HOLD' && budget.status !== 'HOLD')
    || (budget.status === 'RUN' && ['HOLD', 'THROTTLED'].includes(v.status))
    || !SAFE_SOURCE.test(String(budget.reason ?? ''))) return empty('INVALID', true);
  const safety = object(v.safety);
  if (!safety || safety.researchOnly !== true || safety.orderAuthority !== 'NONE'
    || safety.liveTrading !== false || safety.privateProviderApi !== false
    || safety.paperAdmissionAllowed !== false || safety.profitabilityProven !== false
    || safety.aiPassInvented !== false) return empty('INVALID', true);
  if (!Array.isArray(v.markets) || v.markets.length !== MARKETS.length
    || !safeCount(v.newCandidateCount)
    || v.newCandidateCount > 12 * MARKETS.length) return empty('INVALID', true);
  const markets = [];
  for (const [index, market] of MARKETS.entries()) {
    const row = object(v.markets[index]);
    if (!row || row.market !== market || typeof row.status !== 'string'
      || !(HEALTHY_SOURCE.has(row.status) || BLOCKED.test(row.status))
      || !SAFE_SOURCE.test(String(row.source ?? ''))
      || (BLOCKED.test(row.status) && row.source !== 'NONE')
      || (HEALTHY_SOURCE.has(row.status) && row.source === 'NONE')
      || !safeCount(row.listedCount) || row.listedCount > 30_000
      || !safeCount(row.observedCount) || row.observedCount > 8_000
      || row.observedCount > row.listedCount
      || !safeCount(row.newCandidates) || row.newCandidates > 12
      || row.newCandidates > row.observedCount
      || (row.status === 'READY' && row.observedCount !== row.listedCount)
      || (BLOCKED.test(row.status) && (row.observedCount !== 0 || row.newCandidates !== 0))
      || row.executionAuthority !== 'NONE') return empty('INVALID', true);
    markets.push(Object.freeze({
      market, source: row.source, status: row.status,
      listedCount: row.listedCount, observedCount: row.observedCount,
      newCandidates: row.newCandidates,
    }));
  }
  if (markets.reduce((n, x) => n + x.newCandidates, 0) !== v.newCandidateCount)
    return empty('INVALID', true);
  const stats = object(v.statistics);
  if (!stats || stats.dayUtc !== String(v.observedAt).slice(0, 10)
    || !safeCount(stats.cyclesToday) || stats.cyclesToday < 1
    || !safeCount(stats.candidatesToday)
    || !safeCount(stats.cyclesSinceRelease) || stats.cyclesSinceRelease < stats.cyclesToday)
    return empty('INVALID', true);
  if (v.status === 'OBSERVING_ALL_FOUR' && markets.some((x) => x.status !== 'READY'))
    return empty('INVALID', true);
  if (budget.status !== 'RUN' && markets.some((x) => !BLOCKED.test(x.status)))
    return empty('INVALID', true);
  const ageMs = Math.max(0, nowMs - observedAt);
  const coverage = markets.filter((x) => x.status === 'READY').length;
  return Object.freeze({
    contract: WATCH_READBACK_CONTRACT, present: true,
    // 'OBSERVING' describes fresh data discovery ONLY, not actual profitable work.
    status: ageMs > MAX_AGE_MS ? 'STALE'
      : v.status === 'HOLD' || v.status === 'THROTTLED' ? v.status
        : v.status === 'BLOCKED_DATA' ? 'BLOCKED_DATA'
          : coverage === 4 ? 'OBSERVING' : 'PARTIAL',
    researchSha: v.researchSha,
    observedAt, ageMs,
    marketCoverageCount: coverage, markets: Object.freeze(markets),
    cyclesToday: stats.cyclesToday,
    candidatesToday: stats.candidatesToday,
    cyclesSinceRelease: stats.cyclesSinceRelease,
    continuous24hProven: false,
    formulaCandidateProduced: false, oosProven: false,
    paperExecutionProven: false, profitabilityProven: false,
    executionAuthority: 'NONE',
  });
}
