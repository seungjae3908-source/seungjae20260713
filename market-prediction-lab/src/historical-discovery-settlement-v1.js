import { computeSearchQualityMetrics } from "./search-quality-metrics-v1.js";
import { buildStrategySettlementSchedule, resolveStrategyHorizon } from "./strategy-horizon-contract-v1.js";

const STOCK_OR_SPOT = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT"]);
const FUTURES = "CRYPTO_FUTURES";

function freeze(value) { return Object.freeze(value); }
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function positive(value) { return finite(value) && value > 0; }
function normalizeDirection(value) {
  const direction = String(value ?? "").trim().toUpperCase();
  return direction === "LONG" || direction === "BUY" ? "LONG" : direction === "SHORT" ? "SHORT" : null;
}
function rawReturnPct(entryPrice, price) { return (price / entryPrice - 1) * 100; }
function directionalPct(direction, value) { return direction === "SHORT" ? -value : value; }
function opportunityId({ asOfMs, horizonKey, symbol, direction }) { return `${asOfMs}:${horizonKey}:${symbol}:${direction}`; }
function signalId(candidate, asOfMs, horizonKey) {
  return `${candidate?.signalId ?? candidate?.symbol ?? "UNKNOWN"}:${asOfMs}:${horizonKey}`;
}

function blocked(replay, reason, details = {}) {
  return freeze({
    schemaVersion: "historical-discovery-settlement-v1",
    status: "BLOCKED",
    market: replay?.market ?? null,
    strategyMode: replay?.strategyMode ?? null,
    reason,
    details: freeze(details),
    settledSignals: freeze([]),
    groundTruthOpportunities: freeze([]),
    metrics: null,
    pointInTimeOnly: true,
    futureDataUsedForScoringOnly: true,
    profitabilityClaimAllowed: false,
    executionAuthority: "NONE",
    liveTrading: false,
    realOrder: false,
    privateApi: false,
  });
}

function thresholdsFor(horizon, thresholds) {
  if (!thresholds || typeof thresholds !== "object") throw new TypeError("successThresholdPctByHorizon is required");
  const normalized = {};
  for (const checkpoint of horizon.checkpoints) {
    const value = Number(thresholds[checkpoint.key]);
    if (!finite(value) || value <= 0) throw new TypeError(`positive threshold required for ${checkpoint.key}`);
    normalized[checkpoint.key] = value;
  }
  return freeze(normalized);
}

function normalizeUniverse(raw, asOfMs, settleAtMs) {
  if (!raw || typeof raw !== "object") return { error: "GROUND_TRUTH_UNIVERSE_MISSING" };
  if (raw.syntheticHistoricalData === true || raw.fakeHistoricalData === true) return { error: "SYNTHETIC_GROUND_TRUTH_FORBIDDEN" };
  if (finite(raw.universeAsOfMs) && raw.universeAsOfMs > asOfMs) return { error: "FUTURE_UNIVERSE_MEMBERSHIP_DETECTED" };
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) return { error: "GROUND_TRUTH_UNIVERSE_EMPTY" };
  const entries = [];
  for (const row of raw.entries) {
    const symbol = String(row?.symbol ?? "").trim().toUpperCase();
    const entryPrice = Number(row?.entryPrice);
    if (!symbol || !positive(entryPrice)) return { error: "GROUND_TRUTH_ENTRY_INVALID", symbol: symbol || null };
    if (!Array.isArray(row?.observations)) return { error: "GROUND_TRUTH_PATH_MISSING", symbol };
    const path = row.observations
      .map((observation) => ({ timestampMs: Number(observation?.timestampMs ?? observation?.time), price: Number(observation?.price ?? observation?.close) }))
      .filter((observation) => finite(observation.timestampMs) && positive(observation.price) && observation.timestampMs > asOfMs && observation.timestampMs <= settleAtMs)
      .sort((left, right) => left.timestampMs - right.timestampMs);
    if (!path.length) return { error: "GROUND_TRUTH_PATH_EMPTY", symbol };
    entries.push(freeze({ symbol, entryPrice, path: freeze(path) }));
  }
  return { entries: freeze(entries) };
}

function pathStats(entryPrice, path, direction, thresholdPct, asOfMs) {
  const rawReturns = path.map((row) => rawReturnPct(entryPrice, row.price));
  const directional = rawReturns.map((value) => directionalPct(direction, value));
  const firstHitIndex = directional.findIndex((value) => value >= thresholdPct);
  return freeze({
    returnPct: rawReturns.at(-1),
    mfePct: Math.max(...directional),
    maePct: Math.min(...directional),
    hit: firstHitIndex >= 0,
    leadTimeMs: firstHitIndex >= 0 ? path[firstHitIndex].timestampMs - asOfMs : null,
  });
}

function opportunitiesForEntry({ market, row, asOfMs, horizonKey, thresholdPct }) {
  const directions = market === FUTURES ? ["LONG", "SHORT"] : ["LONG"];
  const opportunities = [];
  for (const direction of directions) {
    const stats = pathStats(row.entryPrice, row.path, direction, thresholdPct, asOfMs);
    if (!stats.hit) continue;
    opportunities.push(freeze({
      opportunityId: opportunityId({ asOfMs, horizonKey, symbol: row.symbol, direction }),
      market,
      symbol: row.symbol,
      direction,
      asOfMs,
      horizonKey,
      thresholdPct,
      leadTimeMs: stats.leadTimeMs,
      mfePct: stats.mfePct,
      maePct: stats.maePct,
    }));
  }
  return opportunities;
}

function candidateMap(candidates) {
  const result = new Map();
  for (const candidate of candidates ?? []) {
    const symbol = String(candidate?.symbol ?? candidate?.ticker ?? "").trim().toUpperCase();
    const direction = normalizeDirection(candidate?.direction ?? candidate?.action);
    if (!symbol || !direction) continue;
    result.set(`${symbol}:${direction}`, candidate);
  }
  return result;
}

export async function settleHistoricalDiscoveryReplay({
  replayResult,
  loadGroundTruthUniverse,
  successThresholdPctByHorizon,
} = {}) {
  if (!replayResult || replayResult.status !== "READY" || replayResult.schemaVersion !== "historical-market-replay-v1") {
    return blocked(replayResult, "REPLAY_NOT_READY");
  }
  if (typeof loadGroundTruthUniverse !== "function") throw new TypeError("loadGroundTruthUniverse is required");
  const market = replayResult.market;
  if (!STOCK_OR_SPOT.has(market) && market !== FUTURES) return blocked(replayResult, "UNSUPPORTED_MARKET");
  if (replayResult.executionAuthority !== "NONE" || replayResult.liveTrading === true || replayResult.realOrder === true || replayResult.privateApi === true) {
    return blocked(replayResult, "REPLAY_SAFETY_ENVELOPE_VIOLATION");
  }
  const horizon = resolveStrategyHorizon(replayResult.strategyMode);
  const thresholds = thresholdsFor(horizon, successThresholdPctByHorizon);
  const settledSignals = [];
  const opportunities = [];

  for (const replayRow of replayResult.replayRows ?? []) {
    const asOfMs = Number(replayRow?.asOfMs);
    if (!positive(asOfMs)) return blocked(replayResult, "REPLAY_TIMESTAMP_INVALID");
    const schedule = buildStrategySettlementSchedule({ mode: horizon.strategyMode, signalAtMs: asOfMs });
    const candidates = candidateMap(replayRow?.discoveryCandidates);

    for (const target of schedule.targets) {
      const universeRaw = await loadGroundTruthUniverse({
        market,
        strategyMode: horizon.strategyMode,
        asOfMs,
        horizonKey: target.key,
        settleAtMs: target.settleAtMs,
      });
      const normalized = normalizeUniverse(universeRaw, asOfMs, target.settleAtMs);
      if (normalized.error) return blocked(replayResult, normalized.error, { asOfMs, horizonKey: target.key, symbol: normalized.symbol ?? null });
      const thresholdPct = thresholds[target.key];
      const horizonOpportunities = normalized.entries.flatMap((row) => opportunitiesForEntry({
        market, row, asOfMs, horizonKey: target.key, thresholdPct,
      }));
      opportunities.push(...horizonOpportunities);
      const opportunityIds = new Set(horizonOpportunities.map((row) => row.opportunityId));

      for (const [key, candidate] of candidates) {
        const [symbol, direction] = key.split(":");
        const universeRow = normalized.entries.find((row) => row.symbol === symbol);
        if (!universeRow) return blocked(replayResult, "DISCOVERY_SYMBOL_MISSING_FROM_POINT_IN_TIME_UNIVERSE", { asOfMs, horizonKey: target.key, symbol });
        if (market !== FUTURES && direction !== "LONG") continue;
        const stats = pathStats(universeRow.entryPrice, universeRow.path, direction, thresholdPct, asOfMs);
        const matchedOpportunityId = opportunityId({ asOfMs, horizonKey: target.key, symbol, direction });
        settledSignals.push(freeze({
          signalId: signalId(candidate, asOfMs, target.key),
          sourceSignalId: candidate?.signalId ?? null,
          market,
          symbol,
          direction,
          asOfMs,
          horizonKey: target.key,
          settleAtMs: target.settleAtMs,
          thresholdPct,
          hit: stats.hit,
          matchedOpportunityId: opportunityIds.has(matchedOpportunityId) ? matchedOpportunityId : null,
          returnPct: stats.returnPct,
          mfePct: stats.mfePct,
          maePct: stats.maePct,
          leadTimeMs: stats.leadTimeMs,
          entryPrice: universeRow.entryPrice,
          settlePrice: universeRow.path.at(-1).price,
        }));
      }
    }
  }

  const metrics = computeSearchQualityMetrics({
    settledSignals,
    groundTruthOpportunities: opportunities,
  });
  return freeze({
    schemaVersion: "historical-discovery-settlement-v1",
    status: "READY",
    market,
    strategyMode: horizon.strategyMode,
    horizon,
    successThresholdPctByHorizon: thresholds,
    settledSignalCount: settledSignals.length,
    groundTruthOpportunityCount: opportunities.length,
    settledSignals: freeze(settledSignals),
    groundTruthOpportunities: freeze(opportunities),
    metrics,
    pointInTimeOnly: true,
    futureDataUsedForScoringOnly: true,
    searchInputContainsFutureData: false,
    syntheticHistoricalDataAllowed: false,
    searchQualityIsNotProfitabilityProof: true,
    profitabilityClaimAllowed: false,
    executionAuthority: "NONE",
    liveTrading: false,
    realOrder: false,
    privateApi: false,
  });
}
