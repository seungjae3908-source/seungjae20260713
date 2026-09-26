import { resolveStrategyHorizon } from "./strategy-horizon-contract-v1.js";

const MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
const STOCK_MARKETS = new Set(["KR_STOCK", "US_STOCK"]);

function freeze(value) { return Object.freeze(value); }
function positiveTime(value) { return Number.isFinite(value) && value > 0; }

function blocked({ market, strategyMode, reason, asOfMs = null, pointInTimeUniverseAudit = null }) {
  return freeze({
    schemaVersion: "historical-market-replay-v1",
    status: "BLOCKED",
    market,
    strategyMode,
    reason,
    blockedAtMs: asOfMs,
    pointInTimeUniverseAudit,
    replayRows: freeze([]),
    executionAuthority: "NONE",
    liveTrading: false,
    realOrder: false,
    privateApi: false,
    profitabilityClaimAllowed: false,
  });
}

function stockAuditReason(audit, market, firstMs, lastMs) {
  if (!audit || audit.status !== "point_in_time_bias_gate_passed") return "POINT_IN_TIME_STOCK_UNIVERSE_NOT_PROVEN";
  if (audit.market !== market) return "POINT_IN_TIME_STOCK_UNIVERSE_MARKET_MISMATCH";
  if (!positiveTime(audit.evaluationStartTime) || audit.evaluationStartTime > firstMs) return "POINT_IN_TIME_STOCK_UNIVERSE_RANGE_GAP";
  if (!positiveTime(audit.evaluationEndTime) || audit.evaluationEndTime < lastMs) return "POINT_IN_TIME_STOCK_UNIVERSE_RANGE_GAP";
  const gates = audit.gates ?? {};
  if (gates.pointInTimeMembershipsPresent !== true || gates.removedNamesPresent !== true
    || gates.membershipHistoryCoveragePassed !== true || gates.removedNameHistoryCoveragePassed !== true) {
    return "SURVIVORSHIP_BIAS_GUARD_NOT_PROVEN";
  }
  return null;
}

function futureObservation(snapshot, asOfMs) {
  const cutoff = snapshot?.dataCutoffMs ?? snapshot?.observedAtMs ?? snapshot?.asOfMs;
  if (Number.isFinite(cutoff) && cutoff > asOfMs) return true;
  const observations = Array.isArray(snapshot?.observations) ? snapshot.observations : [];
  return observations.some((row) => {
    const timestamp = row?.observedAtMs ?? row?.timestampMs ?? row?.time;
    return Number.isFinite(timestamp) && timestamp > asOfMs;
  });
}

function violatesSafety(value) {
  return value?.executionAuthority != null && value.executionAuthority !== "NONE"
    || value?.liveTrading === true
    || value?.liveOrderAllowed === true
    || value?.realOrder === true
    || value?.orderSubmitted === true
    || value?.exchangeRequestSent === true
    || value?.privateApiUsed === true
    || value?.privateTradingApiAllowed === true;
}

export async function runHistoricalMarketReplay({
  market,
  strategyMode,
  replayTimes,
  loadSnapshot,
  searchSnapshot,
  pointInTimeUniverseAudit = null,
} = {}) {
  if (!MARKETS.has(market)) throw new TypeError("supported market is required");
  const horizon = resolveStrategyHorizon(strategyMode);
  if (!Array.isArray(replayTimes) || replayTimes.length === 0 || replayTimes.some((value) => !positiveTime(value))) {
    throw new TypeError("replayTimes must contain positive timestamps");
  }
  if (typeof loadSnapshot !== "function" || typeof searchSnapshot !== "function") throw new TypeError("loadSnapshot and searchSnapshot are required");

  const times = [...new Set(replayTimes)].sort((a, b) => a - b);
  if (STOCK_MARKETS.has(market)) {
    const reason = stockAuditReason(pointInTimeUniverseAudit, market, times[0], times.at(-1));
    if (reason) return blocked({ market, strategyMode: horizon.strategyMode, reason, pointInTimeUniverseAudit });
  }

  const replayRows = [];
  for (const asOfMs of times) {
    const snapshot = await loadSnapshot({ market, strategyMode: horizon.strategyMode, asOfMs, horizon });
    if (!snapshot || typeof snapshot !== "object") return blocked({ market, strategyMode: horizon.strategyMode, reason: "HISTORICAL_SNAPSHOT_MISSING", asOfMs, pointInTimeUniverseAudit });
    if (snapshot.syntheticHistoricalData === true || snapshot.fakeHistoricalData === true) {
      return blocked({ market, strategyMode: horizon.strategyMode, reason: "SYNTHETIC_HISTORICAL_DATA_FORBIDDEN", asOfMs, pointInTimeUniverseAudit });
    }
    if (futureObservation(snapshot, asOfMs)) {
      return blocked({ market, strategyMode: horizon.strategyMode, reason: "LOOKAHEAD_DATA_DETECTED", asOfMs, pointInTimeUniverseAudit });
    }
    if (Number.isFinite(snapshot.universeAsOfMs) && snapshot.universeAsOfMs > asOfMs) {
      return blocked({ market, strategyMode: horizon.strategyMode, reason: "FUTURE_UNIVERSE_MEMBERSHIP_DETECTED", asOfMs, pointInTimeUniverseAudit });
    }
    if (violatesSafety(snapshot)) return blocked({ market, strategyMode: horizon.strategyMode, reason: "REPLAY_SAFETY_ENVELOPE_VIOLATION", asOfMs, pointInTimeUniverseAudit });

    const result = await searchSnapshot({ market, strategyMode: horizon.strategyMode, asOfMs, snapshot, horizon });
    if (violatesSafety(result)) return blocked({ market, strategyMode: horizon.strategyMode, reason: "SEARCH_SAFETY_ENVELOPE_VIOLATION", asOfMs, pointInTimeUniverseAudit });
    const candidates = Array.isArray(result?.discoveryCandidates)
      ? result.discoveryCandidates
      : Array.isArray(result?.cards) ? result.cards : [];
    replayRows.push(freeze({
      asOfMs,
      discoveryCandidateCount: candidates.length,
      discoveryCandidates: freeze([...candidates]),
      searchOutcome: result?.discoveryOutcome ?? result?.outcome ?? null,
    }));
  }

  return freeze({
    schemaVersion: "historical-market-replay-v1",
    status: "READY",
    market,
    strategyMode: horizon.strategyMode,
    horizon,
    replayCount: replayRows.length,
    replayRows: freeze(replayRows),
    pointInTimeUniverseAudit,
    pointInTimeOnly: true,
    syntheticHistoricalDataAllowed: false,
    selectionUsesFutureData: false,
    executionAuthority: "NONE",
    liveTrading: false,
    realOrder: false,
    privateApi: false,
    profitabilityClaimAllowed: false,
  });
}
