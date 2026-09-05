import { createHash } from "node:crypto";
import { PredictionInputError } from "./contracts.js";
import {
  US_STOCK_FORWARD_CANDIDATE,
  US_STOCK_FORWARD_CANDIDATE_SHA256,
  US_STOCK_FORWARD_START,
} from "./us-stock-forward-candidate.js";

const DAY_MS = 24 * 60 * 60 * 1000;

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
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}

function canonicalCandles(rawCandles, symbol, cycleTime) {
  if (!Array.isArray(rawCandles) || rawCandles.length < 120) throw new PredictionInputError("at least 120 PnL shadow candles are required", { symbol });
  const rows = [...rawCandles].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  let previousTimestamp = 0;
  return Object.freeze(rows.map((raw, index) => {
    const timestamp = Number(raw?.timestamp);
    const open = positive(raw?.open, `candles[${index}].open`);
    const high = positive(raw?.high, `candles[${index}].high`);
    const low = positive(raw?.low, `candles[${index}].low`);
    const close = positive(raw?.close, `candles[${index}].close`);
    const volume = finite(raw?.volume ?? 0, `candles[${index}].volume`);
    if (!Number.isInteger(timestamp) || timestamp <= previousTimestamp || timestamp > cycleTime) throw new PredictionInputError("PnL shadow candle timestamps must be increasing and not future", { symbol, index, timestamp });
    if (volume < 0 || high < Math.max(open, close) || low > Math.min(open, close) || high < low) throw new PredictionInputError("invalid PnL shadow OHLCV", { symbol, index });
    previousTimestamp = timestamp;
    const isClosed = raw?.isClosed === true;
    const observedAt = Number.isInteger(raw?.observedAt) ? raw.observedAt : cycleTime;
    if (observedAt < timestamp || observedAt > cycleTime) throw new PredictionInputError("PnL shadow observedAt is invalid", { symbol, index, observedAt, timestamp });
    return Object.freeze({ timestamp, open, high, low, close, volume, isClosed, observedAt });
  }));
}

function zscore(candles, endIndex, period) {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  const closes = candles.slice(start, endIndex + 1).map((row) => row.close);
  const avg = mean(closes);
  const deviation = stddev(closes);
  return deviation > 0 ? (candles[endIndex].close - avg) / deviation : null;
}

function netReturn(entryOpen, rawExit, costRatePerSide) {
  return rawExit * (1 - costRatePerSide) / (entryOpen * (1 + costRatePerSide)) - 1;
}

function tradeId(signal) {
  return createHash("sha256").update(`${US_STOCK_FORWARD_CANDIDATE_SHA256}|pnl|${signal.id}`).digest("hex");
}

function settleTrade(trade, rawExit, exitTimestamp, exitReason) {
  const grossReturn = rawExit / trade.entryOpen - 1;
  const baseNetReturn = netReturn(trade.entryOpen, rawExit, US_STOCK_FORWARD_CANDIDATE.costRatePerSide);
  const stressedNetReturn = netReturn(
    trade.entryOpen,
    rawExit,
    US_STOCK_FORWARD_CANDIDATE.costRatePerSide * US_STOCK_FORWARD_CANDIDATE.stressMultiplier,
  );
  return Object.freeze({
    ...trade,
    status: "settled",
    rawExit,
    exitTimestamp,
    exitReason,
    grossReturn,
    baseNetReturn,
    stressedNetReturn,
    baseCostDrag: grossReturn - baseNetReturn,
    stressedCostDrag: grossReturn - stressedNetReturn,
  });
}

function advanceOpenTrade(trade, candles) {
  if (trade.status !== "open") return trade;
  const entryIndex = candles.findIndex((row) => row.timestamp === trade.entryTimestamp);
  if (entryIndex < 0) return trade;
  const closed = candles
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.isClosed && row.timestamp >= trade.entryTimestamp && row.timestamp > (trade.lastProcessedTimestamp ?? 0));
  let next = trade;
  for (const { row: candle, index } of closed) {
    if (next.status !== "open") break;
    if (next.rangeExitSignalTimestamp != null && candle.timestamp > next.rangeExitSignalTimestamp) {
      next = settleTrade(next, candle.open, candle.timestamp, "range_revert_next_open");
      break;
    }

    const barsHeld = index - entryIndex + 1;
    if (candle.open <= next.stop) {
      next = settleTrade(next, candle.open, candle.timestamp, "stop_gap");
      break;
    }
    const stopTouched = candle.low <= next.stop;
    if (next.regime === "trend") {
      const targetTouched = candle.high >= next.target;
      if (stopTouched && targetTouched) {
        next = settleTrade(next, next.stop, candle.timestamp, "stop_same_bar_conservative");
        break;
      }
      if (stopTouched) {
        next = settleTrade(next, next.stop, candle.timestamp, "stop");
        break;
      }
      if (targetTouched) {
        next = settleTrade(next, next.target, candle.timestamp, "target");
        break;
      }
    } else {
      if (stopTouched) {
        next = settleTrade(next, next.stop, candle.timestamp, "stop");
        break;
      }
      const exitZ = zscore(candles, index, US_STOCK_FORWARD_CANDIDATE.params.rangeZPeriod);
      if (exitZ != null && exitZ >= US_STOCK_FORWARD_CANDIDATE.params.rangeExitZ) {
        next = Object.freeze({
          ...next,
          rangeExitSignalTimestamp: candle.timestamp,
          rangeExitSignalZ: exitZ,
          lastProcessedTimestamp: candle.timestamp,
          barsHeld,
        });
        continue;
      }
    }

    if (barsHeld >= US_STOCK_FORWARD_CANDIDATE.params.maxHoldBars) {
      next = settleTrade(next, candle.close, candle.timestamp, "time");
      break;
    }
    next = Object.freeze({ ...next, lastProcessedTimestamp: candle.timestamp, barsHeld });
  }
  return next;
}

function createTradeFromSignal(signal, candles) {
  if (signal.candidateManifestSha256 !== US_STOCK_FORWARD_CANDIDATE_SHA256 || signal.candidateId !== US_STOCK_FORWARD_CANDIDATE.id) {
    throw new PredictionInputError("PnL shadow signal candidate mismatch", { signalId: signal.id });
  }
  if (signal.usedForSelection !== false || signal.orderSubmitted !== false) throw new PredictionInputError("PnL shadow accepts research-only signals", { signalId: signal.id });
  const entry = candles.find((row) => row.isClosed && row.timestamp > signal.observedAt);
  if (!entry) return null;
  const gapPercent = Math.abs(entry.open / signal.signalClose - 1) * 100;
  if (gapPercent > US_STOCK_FORWARD_CANDIDATE.params.maxGapPercent) {
    return Object.freeze({ skipped: true, reason: "entry_gap_exceeded", entryTimestamp: entry.timestamp, gapPercent });
  }
  const stopDistance = positive(signal.atr, "signal.atr") * (
    signal.regime === "trend"
      ? US_STOCK_FORWARD_CANDIDATE.params.trendStopAtr
      : US_STOCK_FORWARD_CANDIDATE.params.rangeStopAtr
  );
  const stop = entry.open - stopDistance;
  if (!(stop > 0)) return Object.freeze({ skipped: true, reason: "invalid_stop", entryTimestamp: entry.timestamp, gapPercent });
  const target = signal.regime === "trend"
    ? entry.open + stopDistance * US_STOCK_FORWARD_CANDIDATE.params.trendRewardRisk
    : null;
  return Object.freeze({
    id: tradeId(signal),
    signalId: signal.id,
    candidateId: US_STOCK_FORWARD_CANDIDATE.id,
    candidateManifestSha256: US_STOCK_FORWARD_CANDIDATE_SHA256,
    status: "open",
    market: "US_STOCK",
    symbol: signal.symbol,
    timeframe: "1d",
    regime: signal.regime,
    signalTimestamp: signal.signalTimestamp,
    signalObservedAt: signal.observedAt,
    signalClose: signal.signalClose,
    entryTimestamp: entry.timestamp,
    entryOpen: entry.open,
    entryObservedAt: entry.observedAt,
    gapPercent,
    atr: signal.atr,
    stop,
    target,
    barsHeld: 0,
    lastProcessedTimestamp: 0,
    rangeExitSignalTimestamp: null,
    baseCostRatePerSide: US_STOCK_FORWARD_CANDIDATE.costRatePerSide,
    stressedCostRatePerSide: US_STOCK_FORWARD_CANDIDATE.costRatePerSide * US_STOCK_FORWARD_CANDIDATE.stressMultiplier,
    usedForSelection: false,
    orderSubmitted: false,
  });
}

function summarizeReturns(trades, key) {
  const returns = trades.map((trade) => trade[key]).filter(Number.isFinite);
  const wins = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const value of returns) {
    equity *= Math.max(0.000001, 1 + value);
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  return Object.freeze({
    tradeCount: returns.length,
    winRate: returns.length ? wins.length / returns.length : 0,
    expectancy: mean(returns),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
    maxDrawdown,
    pooledSequentialNetReturn: equity - 1,
  });
}

function stateDigest(state) {
  return createHash("sha256").update(JSON.stringify({
    candidateManifestSha256: state.candidateManifestSha256,
    startedAt: state.startedAt,
    processedSignalIds: state.processedSignalIds,
    trades: state.trades.map((row) => ({
      id: row.id,
      status: row.status,
      exitTimestamp: row.exitTimestamp ?? null,
      baseNetReturn: row.baseNetReturn ?? null,
      stressedNetReturn: row.stressedNetReturn ?? null,
      lastProcessedTimestamp: row.lastProcessedTimestamp ?? null,
    })),
    skippedSignals: state.skippedSignals,
  })).digest("hex");
}

export function createUsStockForwardPnlState(startedAt) {
  if (!Number.isInteger(startedAt) || startedAt < US_STOCK_FORWARD_START) throw new PredictionInputError("US stock PnL shadow cannot start before freeze boundary", { startedAt });
  return Object.freeze({
    schemaVersion: 1,
    candidateId: US_STOCK_FORWARD_CANDIDATE.id,
    candidateManifestSha256: US_STOCK_FORWARD_CANDIDATE_SHA256,
    startedAt,
    updatedAt: startedAt,
    processedSignalIds: Object.freeze([]),
    trades: Object.freeze([]),
    skippedSignals: Object.freeze([]),
    safeguards: Object.freeze({
      frozenCandidateOnly: true,
      nextSessionOpenEntryOnly: true,
      sameBarStopFirstConservative: true,
      parametersRetunedAfterFreeze: false,
      prospectiveSignalsUsedForSelection: false,
      publicMarketDataOnly: true,
      orderSubmitted: false,
      privateAccountRequestAllowed: false,
      liveOrderAllowed: false,
    }),
  });
}

export function advanceUsStockForwardPnlState({ state, signalState, candlesBySymbol, cycleTime } = {}) {
  if (!Number.isInteger(cycleTime) || cycleTime < US_STOCK_FORWARD_START) throw new PredictionInputError("US stock PnL cycleTime is invalid", { cycleTime });
  const current = state ?? createUsStockForwardPnlState(cycleTime);
  if (current.candidateId !== US_STOCK_FORWARD_CANDIDATE.id || current.candidateManifestSha256 !== US_STOCK_FORWARD_CANDIDATE_SHA256) throw new PredictionInputError("PnL shadow candidate mutation detected");
  if (!signalState || signalState.candidateId !== US_STOCK_FORWARD_CANDIDATE.id || signalState.candidateManifestSha256 !== US_STOCK_FORWARD_CANDIDATE_SHA256) throw new PredictionInputError("PnL shadow signal state mismatch");
  if (!candlesBySymbol || typeof candlesBySymbol !== "object") throw new PredictionInputError("PnL shadow candlesBySymbol is required");

  const canonicalBySymbol = {};
  for (const symbol of US_STOCK_FORWARD_CANDIDATE.prospectiveOnlySymbols) {
    if (candlesBySymbol[symbol]) canonicalBySymbol[symbol] = canonicalCandles(candlesBySymbol[symbol], symbol, cycleTime);
  }

  let trades = [...(current.trades ?? [])].map((trade) => {
    const candles = canonicalBySymbol[trade.symbol];
    return candles ? advanceOpenTrade(trade, candles) : trade;
  });
  const processed = new Set(current.processedSignalIds ?? []);
  const skippedSignals = [...(current.skippedSignals ?? [])];
  const signals = [...(signalState.signals ?? [])].sort((a, b) => a.signalTimestamp - b.signalTimestamp || a.symbol.localeCompare(b.symbol));

  for (const signal of signals) {
    if (processed.has(signal.id)) continue;
    if (signal.observedAt >= cycleTime) continue;
    const candles = canonicalBySymbol[signal.symbol];
    if (!candles) continue;
    const hasOpenTrade = trades.some((trade) => trade.symbol === signal.symbol && trade.status === "open");
    if (hasOpenTrade) {
      processed.add(signal.id);
      skippedSignals.push(Object.freeze({ signalId: signal.id, symbol: signal.symbol, signalTimestamp: signal.signalTimestamp, reason: "existing_position", recordedAt: cycleTime }));
      continue;
    }
    const created = createTradeFromSignal(signal, candles);
    if (!created) continue;
    processed.add(signal.id);
    if (created.skipped) {
      skippedSignals.push(Object.freeze({ signalId: signal.id, symbol: signal.symbol, signalTimestamp: signal.signalTimestamp, reason: created.reason, entryTimestamp: created.entryTimestamp, gapPercent: created.gapPercent, recordedAt: cycleTime }));
      continue;
    }
    trades.push(advanceOpenTrade(created, candles));
  }

  trades.sort((a, b) => a.entryTimestamp - b.entryTimestamp || a.symbol.localeCompare(b.symbol));
  const next = Object.freeze({
    ...current,
    updatedAt: cycleTime,
    processedSignalIds: Object.freeze([...processed].sort()),
    trades: Object.freeze(trades),
    skippedSignals: Object.freeze(skippedSignals),
  });
  return Object.freeze({ ...next, stateSha256: stateDigest(next) });
}

export function summarizeUsStockForwardPnlState(state, { minSettled = 30, minSymbols = 6, minElapsedMs = 60 * DAY_MS } = {}) {
  if (!state || typeof state !== "object") throw new PredictionInputError("US stock PnL shadow state is required");
  const settled = (state.trades ?? []).filter((trade) => trade.status === "settled");
  const open = (state.trades ?? []).filter((trade) => trade.status === "open");
  const symbols = [...new Set(settled.map((trade) => trade.symbol))];
  const regimes = [...new Set(settled.map((trade) => trade.regime))];
  const base = summarizeReturns(settled, "baseNetReturn");
  const stressed = summarizeReturns(settled, "stressedNetReturn");
  const elapsedMs = Math.max(0, state.updatedAt - state.startedAt);
  const samplePassed = settled.length >= minSettled;
  const symbolPassed = symbols.length >= minSymbols;
  const regimePassed = regimes.length >= 2;
  const elapsedPassed = elapsedMs >= minElapsedMs;
  const basePerformancePassed = samplePassed && base.expectancy > 0 && base.profitFactor >= 1.05 && base.maxDrawdown <= 0.35;
  const stressPerformancePassed = samplePassed && stressed.expectancy > 0 && stressed.profitFactor >= 1.0 && stressed.maxDrawdown <= 0.40;
  const reasons = [];
  if (!samplePassed) reasons.push("insufficient_settled_trades");
  if (!symbolPassed) reasons.push("insufficient_cross_symbol_coverage");
  if (!regimePassed) reasons.push("insufficient_regime_coverage");
  if (!elapsedPassed) reasons.push("insufficient_elapsed_pnl_period");
  if (samplePassed && !basePerformancePassed) reasons.push("base_cost_pnl_gate_failed");
  if (samplePassed && !stressPerformancePassed) reasons.push("stressed_cost_pnl_gate_failed");
  const ready = samplePassed && symbolPassed && regimePassed && elapsedPassed && basePerformancePassed && stressPerformancePassed;
  return Object.freeze({
    schemaVersion: 1,
    candidateId: state.candidateId,
    candidateManifestSha256: state.candidateManifestSha256,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    totalTrades: (state.trades ?? []).length,
    settledTrades: settled.length,
    openTrades: open.length,
    skippedSignals: (state.skippedSignals ?? []).length,
    symbolCount: symbols.length,
    symbols: Object.freeze(symbols),
    regimes: Object.freeze(regimes),
    base,
    stressed,
    elapsedMs,
    gates: Object.freeze({ samplePassed, symbolPassed, regimePassed, elapsedPassed, basePerformancePassed, stressPerformancePassed }),
    pnlShadowStatus: ready ? "prospective_pnl_evidence_ready" : "shadow_continue",
    executionPromotionAllowed: false,
    reasons: Object.freeze(reasons),
    limitations: Object.freeze([
      "pooled sequential return is a research summary and not a capital-allocation portfolio simulation",
      "public daily OHLC cannot prove intraday stop/target path when both touch; stop-first is used conservatively",
      "point-in-time constituent and removed-name bias gate must pass separately",
      "manual integration review remains required",
      "live execution is outside this research lane",
    ]),
  });
}
