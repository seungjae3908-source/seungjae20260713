import { createHash } from "node:crypto";
import { PredictionInputError } from "./contracts.js";
import { classifyStockRegime } from "./stock-regime-router-optimizer.js";
import {
  US_STOCK_FORWARD_CANDIDATE,
  US_STOCK_FORWARD_CANDIDATE_SHA256,
  US_STOCK_FORWARD_START,
} from "./us-stock-forward-candidate.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const US_STOCK_FORWARD_MAX_SIGNAL_LAG_MS = 36 * 60 * 60 * 1000;

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new PredictionInputError(`${label} must be finite`, { value });
  return number;
}

function positive(value, label) {
  const number = finite(value, label);
  if (!(number > 0)) throw new PredictionInputError(`${label} must be positive`, { value });
  return number;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function stddev(values) {
  if (values.length < 2) return null;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}

function trueRange(candle, previousClose) {
  return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
}

function atrAt(candles, endIndex, period = 14) {
  if (endIndex < period) return null;
  let total = 0;
  for (let index = endIndex - period + 1; index <= endIndex; index += 1) {
    if (index <= 0) return null;
    total += trueRange(candles[index], candles[index - 1].close);
  }
  return total / period;
}

function highestHighBefore(candles, index, period) {
  const start = index - period;
  if (start < 0) return null;
  let highest = -Infinity;
  for (let cursor = start; cursor < index; cursor += 1) highest = Math.max(highest, candles[cursor].high);
  return Number.isFinite(highest) ? highest : null;
}

function averageVolumeBefore(candles, index, period = 20) {
  const start = index - period;
  if (start < 0) return null;
  return mean(candles.slice(start, index).map((row) => row.volume));
}

function zscore(candles, endIndex, period) {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  const closes = candles.slice(start, endIndex + 1).map((row) => row.close);
  const avg = mean(closes);
  const deviation = stddev(closes);
  return deviation != null && deviation > 0 ? (candles[endIndex].close - avg) / deviation : null;
}

function canonicalCandles(rawCandles, symbol, cycleTime) {
  if (!Array.isArray(rawCandles) || rawCandles.length < 120) throw new PredictionInputError("at least 120 forward candles are required", { symbol });
  const rows = [...rawCandles].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  let previousTimestamp = 0;
  return Object.freeze(rows.map((raw, index) => {
    const timestamp = Number(raw?.timestamp);
    const open = positive(raw?.open, `candles[${index}].open`);
    const high = positive(raw?.high, `candles[${index}].high`);
    const low = positive(raw?.low, `candles[${index}].low`);
    const close = positive(raw?.close, `candles[${index}].close`);
    const volume = finite(raw?.volume ?? 0, `candles[${index}].volume`);
    if (!Number.isInteger(timestamp) || timestamp <= previousTimestamp || timestamp > cycleTime) throw new PredictionInputError("forward candle timestamps must be increasing and not future", { symbol, index, timestamp });
    if (volume < 0 || high < Math.max(open, close) || low > Math.min(open, close) || high < low) throw new PredictionInputError("invalid forward OHLCV", { symbol, index });
    previousTimestamp = timestamp;
    const isClosed = raw?.isClosed === true;
    const observedAt = Number.isInteger(raw?.observedAt) ? raw.observedAt : cycleTime;
    if (observedAt < timestamp || observedAt > cycleTime) throw new PredictionInputError("forward observedAt is invalid", { symbol, index, observedAt, timestamp });
    return Object.freeze({ timestamp, open, high, low, close, volume, isClosed, observedAt });
  }));
}

function signalAt(candles, index) {
  const params = US_STOCK_FORWARD_CANDIDATE.params;
  const regime = classifyStockRegime(candles, index, params);
  const signalAtr = atrAt(candles, index, 14);
  if (!(signalAtr > 0)) return null;
  if (regime.regime === "trend") {
    const recentHigh = highestHighBefore(candles, index, params.trendPullbackLookback);
    const baseVolume = averageVolumeBefore(candles, index, 20);
    if (!(recentHigh > 0 && baseVolume > 0)) return null;
    const pullbackAtr = (recentHigh - candles[index].close) / signalAtr;
    const relativeVolume = candles[index].volume / baseVolume;
    const recovery = index > 0 && candles[index].close > candles[index].open && candles[index].close > candles[index - 1].close;
    if (!recovery || pullbackAtr < 0.35 || pullbackAtr > params.trendMaxPullbackAtr || relativeVolume < params.trendMinRelativeVolume) return null;
    return Object.freeze({ regime: "trend", atr: signalAtr, pullbackAtr, relativeVolume, regimeEvidence: regime });
  }
  if (regime.regime === "range") {
    const signalZ = zscore(candles, index, params.rangeZPeriod);
    if (signalZ == null || signalZ > params.rangeEntryZ) return null;
    return Object.freeze({ regime: "range", atr: signalAtr, signalZ, regimeEvidence: regime });
  }
  return null;
}

function signalId(symbol, timestamp, regime) {
  return createHash("sha256").update(`${US_STOCK_FORWARD_CANDIDATE_SHA256}|${symbol}|${timestamp}|${regime}`).digest("hex");
}

function settleSignal(record, candles) {
  if (record.status === "settled") return record;
  const future = candles.filter((row) => row.isClosed && row.timestamp > record.signalTimestamp);
  const horizons = [5, 10, 20];
  const returns = {};
  for (const horizon of horizons) {
    if (future.length < horizon) continue;
    returns[`${horizon}d`] = future[horizon - 1].close / record.signalClose - 1;
  }
  if (!Object.prototype.hasOwnProperty.call(returns, "20d")) return record;
  return Object.freeze({
    ...record,
    status: "settled",
    settledAt: future[19].timestamp,
    forwardReturns: Object.freeze(returns),
  });
}

function stateDigest(state) {
  return createHash("sha256").update(JSON.stringify({
    candidateManifestSha256: state.candidateManifestSha256,
    startedAt: state.startedAt,
    lastSignalEvaluatedBySymbol: state.lastSignalEvaluatedBySymbol,
    signals: state.signals.map((row) => ({ id: row.id, status: row.status, settledAt: row.settledAt ?? null, forwardReturns: row.forwardReturns ?? null })),
    missedSignals: state.missedSignals,
  })).digest("hex");
}

export function createUsStockForwardState(startedAt) {
  if (!Number.isInteger(startedAt) || startedAt < US_STOCK_FORWARD_START) throw new PredictionInputError("US stock forward state cannot start before freeze boundary", { startedAt, forwardStart: US_STOCK_FORWARD_START });
  return Object.freeze({
    schemaVersion: 1,
    candidateId: US_STOCK_FORWARD_CANDIDATE.id,
    candidateManifestSha256: US_STOCK_FORWARD_CANDIDATE_SHA256,
    startedAt,
    updatedAt: startedAt,
    lastSignalEvaluatedBySymbol: Object.freeze({}),
    signals: Object.freeze([]),
    missedSignals: Object.freeze([]),
    safeguards: Object.freeze({
      frozenCandidateOnly: true,
      parametersRetunedAfterFreeze: false,
      prospectiveOnlySymbolsUsedForSelection: false,
      forwardSignalsOnly: true,
      lateSignalsNeverBackfilled: true,
      publicMarketDataOnly: true,
      orderSubmitted: false,
      privateAccountRequestAllowed: false,
      liveOrderAllowed: false,
    }),
  });
}

export function advanceUsStockForwardState({ state, candlesBySymbol, cycleTime, maxSignalLagMs = US_STOCK_FORWARD_MAX_SIGNAL_LAG_MS } = {}) {
  if (!Number.isInteger(cycleTime) || cycleTime < US_STOCK_FORWARD_START) throw new PredictionInputError("US stock forward cycleTime is invalid", { cycleTime });
  if (!Number.isInteger(maxSignalLagMs) || maxSignalLagMs < 0 || maxSignalLagMs > 7 * DAY_MS) throw new PredictionInputError("maxSignalLagMs is invalid", { maxSignalLagMs });
  const current = state ?? createUsStockForwardState(cycleTime);
  if (current.candidateId !== US_STOCK_FORWARD_CANDIDATE.id || current.candidateManifestSha256 !== US_STOCK_FORWARD_CANDIDATE_SHA256) {
    throw new PredictionInputError("forward candidate mutation detected");
  }
  if (!candlesBySymbol || typeof candlesBySymbol !== "object") throw new PredictionInputError("candlesBySymbol is required");

  const lastBySymbol = { ...(current.lastSignalEvaluatedBySymbol ?? {}) };
  let signals = [...(current.signals ?? [])];
  const missedSignals = [...(current.missedSignals ?? [])];
  const canonicalBySymbol = {};

  for (const symbol of US_STOCK_FORWARD_CANDIDATE.prospectiveOnlySymbols) {
    const rawCandles = candlesBySymbol[symbol];
    if (!rawCandles) continue;
    const candles = canonicalCandles(rawCandles, symbol, cycleTime);
    canonicalBySymbol[symbol] = candles;
    signals = signals.map((record) => record.symbol === symbol ? settleSignal(record, candles) : record);
    const previousEvaluated = Number(lastBySymbol[symbol] ?? 0);
    for (let index = 0; index < candles.length; index += 1) {
      const candle = candles[index];
      if (!candle.isClosed || candle.timestamp < US_STOCK_FORWARD_START || candle.timestamp <= previousEvaluated) continue;
      const candidateSignal = signalAt(candles, index);
      lastBySymbol[symbol] = candle.timestamp;
      if (!candidateSignal) continue;
      const lagMs = candle.observedAt - candle.timestamp;
      if (lagMs < 0 || lagMs > maxSignalLagMs) {
        missedSignals.push(Object.freeze({ symbol, signalTimestamp: candle.timestamp, regime: candidateSignal.regime, reason: "late_cycle_no_backfill", lagMs, recordedAt: cycleTime }));
        continue;
      }
      const id = signalId(symbol, candle.timestamp, candidateSignal.regime);
      if (signals.some((record) => record.id === id)) continue;
      signals.push(Object.freeze({
        id,
        status: "pending",
        candidateId: US_STOCK_FORWARD_CANDIDATE.id,
        candidateManifestSha256: US_STOCK_FORWARD_CANDIDATE_SHA256,
        market: "US_STOCK",
        symbol,
        timeframe: "1d",
        signalTimestamp: candle.timestamp,
        observedAt: candle.observedAt,
        signalClose: candle.close,
        regime: candidateSignal.regime,
        atr: candidateSignal.atr,
        evidence: candidateSignal,
        usedForSelection: false,
        orderSubmitted: false,
      }));
    }
  }
  signals.sort((a, b) => a.signalTimestamp - b.signalTimestamp || a.symbol.localeCompare(b.symbol));
  const next = Object.freeze({
    ...current,
    updatedAt: cycleTime,
    lastSignalEvaluatedBySymbol: Object.freeze(lastBySymbol),
    signals: Object.freeze(signals),
    missedSignals: Object.freeze(missedSignals),
  });
  return Object.freeze({ ...next, stateSha256: stateDigest(next) });
}

function averageReturn(records, key) {
  const values = records.map((row) => row.forwardReturns?.[key]).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function summarizeUsStockForwardState(state, { minSettled = 30, minSymbols = 6, minElapsedMs = 60 * DAY_MS } = {}) {
  if (!state || typeof state !== "object") throw new PredictionInputError("US stock forward state is required");
  const settled = (state.signals ?? []).filter((row) => row.status === "settled");
  const symbols = [...new Set(settled.map((row) => row.symbol))];
  const regimes = [...new Set(settled.map((row) => row.regime))];
  const elapsedMs = Math.max(0, state.updatedAt - state.startedAt);
  const avg5d = averageReturn(settled, "5d");
  const avg10d = averageReturn(settled, "10d");
  const avg20d = averageReturn(settled, "20d");
  const reasons = [];
  if (settled.length < minSettled) reasons.push("insufficient_settled_signals");
  if (symbols.length < minSymbols) reasons.push("insufficient_cross_symbol_coverage");
  if (regimes.length < 2) reasons.push("insufficient_regime_coverage");
  if (elapsedMs < minElapsedMs) reasons.push("insufficient_elapsed_forward_period");
  if (avg20d == null) reasons.push("no_20d_forward_returns");
  return Object.freeze({
    schemaVersion: 1,
    candidateId: state.candidateId,
    candidateManifestSha256: state.candidateManifestSha256,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    totalSignals: (state.signals ?? []).length,
    settledSignals: settled.length,
    pendingSignals: (state.signals ?? []).length - settled.length,
    missedSignals: (state.missedSignals ?? []).length,
    symbolCount: symbols.length,
    symbols: Object.freeze(symbols),
    regimes: Object.freeze(regimes),
    averageForwardReturns: Object.freeze({ d5: avg5d, d10: avg10d, d20: avg20d }),
    elapsedMs,
    signalShadowStatus: reasons.length === 0 ? "forward_signal_evidence_ready" : "shadow_continue",
    executionPromotionAllowed: false,
    reasons: Object.freeze(reasons),
    blockersBeyondSignalShadow: Object.freeze([
      "point-in-time constituent and removed-name bias gate must pass",
      "cost-aware prospective trade PnL shadow must pass separately",
      "manual integration review is required",
      "live execution is outside this research lane",
    ]),
  });
}
