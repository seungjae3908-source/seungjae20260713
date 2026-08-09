import { createHash } from "node:crypto";
import { atr } from "./indicators.js";
import { calculateV6Signal } from "./v6-independent-breakout-retest-optimizer.js";
import {
  createShadowTradeRecord,
  settleShadowTradeRecord,
  summarizeResearchPerformance,
  upsertShadowTradeLedger,
} from "./research-validation-layer.js";
import {
  FINAL_HOLDOUT_END,
  FROZEN_CANDIDATE_MANIFEST_SHA256,
  FROZEN_FINAL_HOLDOUT_CANDIDATES,
} from "./final-holdout-evaluator.js";
import { BITGET_STANDARD_TAKER_RESEARCH_COSTS } from "./historical-backtest-data.js";
import { ResearchContractError } from "./research-governance.js";
import {
  buildStandardizedResearchMetrics,
  evaluateForwardPromotionGate,
} from "./research-metric-semantics.js";

export const ETH_V6_FORWARD_START = FINAL_HOLDOUT_END + 1;
export const ETH_V6_FORWARD_CANDIDATE = FROZEN_FINAL_HOLDOUT_CANDIDATES.find((row) => row.id === "eth-futures-long-v6");
export const ETH_V6_FORWARD_MAX_ENTRY_LAG_MS = 6 * 60 * 60 * 1000;
export const ETH_V6_FORWARD_INITIAL_CAPITAL = 1_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

if (!ETH_V6_FORWARD_CANDIDATE) throw new Error("frozen ETH futures V6 candidate is missing");

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ResearchContractError("NON_FINITE_NUMBER", `${label} must be finite`, { label, value });
  return value;
}

function positive(value, label) {
  finite(value, label);
  if (!(value > 0)) throw new ResearchContractError("NON_POSITIVE_NUMBER", `${label} must be positive`, { label, value });
  return value;
}

function canonicalCandles(candles, cycleTime) {
  if (!Array.isArray(candles) || candles.length === 0) throw new ResearchContractError("EMPTY_FORWARD_CANDLES", "forward candles are required");
  const rows = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const seen = new Set();
  for (const [index, candle] of rows.entries()) {
    if (!Number.isInteger(candle?.timestamp) || candle.timestamp <= 0 || candle.timestamp > cycleTime) throw new ResearchContractError("INVALID_FORWARD_TIMESTAMP", `candles[${index}] timestamp is invalid`);
    if (seen.has(candle.timestamp)) throw new ResearchContractError("DUPLICATE_FORWARD_CANDLE", `duplicate forward candle: ${candle.timestamp}`);
    seen.add(candle.timestamp);
    for (const field of ["open", "high", "low", "close"]) positive(candle[field], `candles[${index}].${field}`);
    if (candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close) || candle.high < candle.low) {
      throw new ResearchContractError("INVALID_FORWARD_OHLC", `candles[${index}] OHLC is invalid`);
    }
  }
  return Object.freeze(rows.map((candle) => Object.freeze({
    ...candle,
    symbol: "ETHUSDT",
    observedAt: Number.isInteger(candle.observedAt) ? candle.observedAt : candle.timestamp,
    isClosed: candle.timestamp + DAY_MS <= cycleTime,
  })));
}

function currentOpenOnly(rows, cycleTime) {
  const current = [...rows].reverse().find((candle) => candle.timestamp <= cycleTime && candle.timestamp + DAY_MS > cycleTime);
  if (!current) return null;
  return Object.freeze({ ...current, high: current.open, low: current.open, close: current.open, volume: 0, isClosed: false });
}

function atrAt(rows, index, period) {
  if (index <= period) return null;
  return atr(rows.slice(0, index + 1), period);
}

function signalAt(rows, index) {
  const candidate = ETH_V6_FORWARD_CANDIDATE;
  const atrNow = atrAt(rows, index, candidate.parameters.atrPeriod);
  if (!Number.isFinite(atrNow) || atrNow <= 0) return null;
  const atrVector = new Array(rows.length).fill(null);
  atrVector[index] = atrNow;
  const signal = calculateV6Signal({
    side: candidate.side,
    candles: rows,
    atr: atrVector,
    index,
    filter: candidate.filter,
  });
  return signal ? Object.freeze({ signal, atrNow }) : null;
}

function quantityForRisk(equity, entryPrice, stopPrice) {
  const stopDistance = Math.abs(entryPrice - stopPrice);
  if (!(equity > 0 && stopDistance > 0)) return 0;
  const byRisk = equity * 0.01 / stopDistance;
  const byCapital = equity / entryPrice;
  return Math.min(byRisk, byCapital);
}

function detectLongExit(record, candle, openOnly = false) {
  const stop = record.stop;
  const target = record.targets[0];
  if (candle.open <= stop) return Object.freeze({ price: candle.open, reason: "stop_loss_gap" });
  if (candle.open >= target) return Object.freeze({ price: target, reason: "take_profit_gap" });
  if (openOnly) return null;
  const stopHit = candle.low <= stop;
  const targetHit = candle.high >= target;
  if (stopHit && targetHit) return Object.freeze({ price: stop, reason: "stop_loss_same_bar" });
  if (stopHit) return Object.freeze({ price: stop, reason: "stop_loss" });
  if (targetHit) return Object.freeze({ price: target, reason: "take_profit" });
  return null;
}

function fundingForTrade(fundingRates, entryTime, exitTime) {
  return fundingRates.filter((row) => row.timestamp > entryTime && row.timestamp <= exitTime).map((row) => row.rate);
}

function settleTrackingRecord(record, rows, openOnly, fundingRates) {
  const entryTime = record.entryPlan.entryTime;
  const futureClosed = rows.filter((candle) => candle.isClosed && candle.timestamp >= entryTime);
  for (const candle of futureClosed) {
    const exit = detectLongExit(record, candle, false);
    if (!exit) continue;
    const enriched = Object.freeze({
      ...record,
      feesSlippageModel: Object.freeze({
        ...record.feesSlippageModel,
        fundingRates: fundingForTrade(fundingRates, entryTime, candle.timestamp),
      }),
    });
    return settleShadowTradeRecord(enriched, {
      futureCandles: futureClosed.filter((row) => row.timestamp <= candle.timestamp),
      exitPrice: exit.price,
      exitTimestamp: candle.timestamp,
      marketResult: { exitReason: exit.reason, exitPrice: exit.price, exitTimestamp: candle.timestamp },
    });
  }
  if (openOnly && openOnly.timestamp >= entryTime) {
    const exit = detectLongExit(record, openOnly, true);
    if (exit) {
      const enriched = Object.freeze({
        ...record,
        feesSlippageModel: Object.freeze({
          ...record.feesSlippageModel,
          fundingRates: fundingForTrade(fundingRates, entryTime, openOnly.timestamp),
        }),
      });
      return settleShadowTradeRecord(enriched, {
        futureCandles: [openOnly],
        exitPrice: exit.price,
        exitTimestamp: openOnly.timestamp,
        marketResult: { exitReason: exit.reason, exitPrice: exit.price, exitTimestamp: openOnly.timestamp, openOnly: true },
      });
    }
  }
  return record;
}

function strategyTrade(record) {
  if (record.status !== "settled") return null;
  return Object.freeze({
    market: record.market,
    strategy: record.strategy,
    timeframe: record.timeframe ?? "1d",
    regime: "forward_shadow",
    exitReason: record.subsequentMarketResult?.exitReason ?? null,
    netPnl: record.hypotheticalPnl,
    netReturnOnMargin: record.execution?.netReturnOnMargin,
    entryNotional: record.execution?.entryNotional,
    costs: record.execution?.costs,
  });
}

function stateDigest(state) {
  return createHash("sha256").update(JSON.stringify({
    manifest: state.candidateManifestSha256,
    candidate: state.candidateId,
    records: state.ledger.records.map((record) => ({ id: record.id, status: record.status, hypotheticalPnl: record.hypotheticalPnl, exit: record.subsequentMarketResult })),
    missedSignals: state.missedSignals,
    lastSignalEvaluated: state.lastSignalEvaluated,
  })).digest("hex");
}

export function createEthV6ForwardState(startedAt) {
  if (!Number.isInteger(startedAt) || startedAt < ETH_V6_FORWARD_START) throw new ResearchContractError("INVALID_FORWARD_START", "forward state cannot start before the final holdout closes");
  return Object.freeze({
    schemaVersion: 1,
    candidateId: ETH_V6_FORWARD_CANDIDATE.id,
    candidateManifestSha256: FROZEN_CANDIDATE_MANIFEST_SHA256,
    startedAt,
    updatedAt: startedAt,
    lastSignalEvaluated: null,
    ledger: Object.freeze({ version: 0, records: Object.freeze([]) }),
    missedSignals: Object.freeze([]),
    paper: Object.freeze({ initialCapital: ETH_V6_FORWARD_INITIAL_CAPITAL, equity: ETH_V6_FORWARD_INITIAL_CAPITAL }),
    safeguards: Object.freeze({
      frozenCandidateOnly: true,
      parametersRetunedAfterHoldout: false,
      forwardSignalsOnly: true,
      lateSignalsNeverBackfilled: true,
      oneOpenPositionMaximum: true,
      riskPerTrade: 0.01,
      leverage: 1,
      publicMarketDataOnly: true,
      orderSubmitted: false,
      privateAccountRequestAllowed: false,
      liveOrderAllowed: false,
    }),
  });
}

export function advanceEthV6ForwardState({ state, candles, fundingRates = [], cycleTime, maxEntryLagMs = ETH_V6_FORWARD_MAX_ENTRY_LAG_MS } = {}) {
  if (!Number.isInteger(cycleTime) || cycleTime < ETH_V6_FORWARD_START) throw new ResearchContractError("INVALID_FORWARD_CYCLE", "cycleTime is invalid");
  if (!Number.isInteger(maxEntryLagMs) || maxEntryLagMs < 0) throw new ResearchContractError("INVALID_ENTRY_LAG", "maxEntryLagMs is invalid");
  const current = state ?? createEthV6ForwardState(cycleTime);
  if (current.candidateId !== ETH_V6_FORWARD_CANDIDATE.id || current.candidateManifestSha256 !== FROZEN_CANDIDATE_MANIFEST_SHA256) {
    throw new ResearchContractError("FORWARD_CANDIDATE_MUTATION", "forward state candidate does not match the frozen final-holdout manifest");
  }
  const rows = canonicalCandles(candles, cycleTime);
  const openOnly = currentOpenOnly(rows, cycleTime);
  const closedRows = rows.filter((candle) => candle.isClosed);
  let ledger = { version: current.ledger?.version ?? 0, records: [...(current.ledger?.records ?? [])] };
  let equity = ETH_V6_FORWARD_INITIAL_CAPITAL;

  ledger.records = ledger.records.map((record) => settleTrackingRecord(record, closedRows, openOnly, fundingRates));
  for (const record of ledger.records.filter((row) => row.status === "settled").sort((a, b) => a.evaluatedAt - b.evaluatedAt || a.id.localeCompare(b.id))) {
    equity += record.hypotheticalPnl;
  }

  const missedSignals = [...(current.missedSignals ?? [])];
  let lastSignalEvaluated = current.lastSignalEvaluated;
  const active = () => ledger.records.find((record) => record.status === "tracking") ?? null;

  for (let index = 0; index < rows.length; index += 1) {
    const signalCandle = rows[index];
    if (!signalCandle.isClosed || signalCandle.timestamp < ETH_V6_FORWARD_START) continue;
    if (lastSignalEvaluated !== null && signalCandle.timestamp <= lastSignalEvaluated) continue;
    const evaluated = signalAt(rows, index);
    lastSignalEvaluated = signalCandle.timestamp;
    if (!evaluated) continue;
    const entryCandle = rows.find((row) => row.timestamp > signalCandle.timestamp);
    if (!entryCandle) {
      missedSignals.push(Object.freeze({ signalTime: signalCandle.timestamp, reason: "entry_open_not_available", recordedAt: cycleTime }));
      continue;
    }
    const entryLag = cycleTime - entryCandle.timestamp;
    if (entryLag < 0 || entryLag > maxEntryLagMs || entryCandle.isClosed) {
      missedSignals.push(Object.freeze({ signalTime: signalCandle.timestamp, entryTime: entryCandle.timestamp, reason: "late_cycle_no_backfill", entryLagMs: entryLag, recordedAt: cycleTime }));
      continue;
    }
    if (active()) {
      missedSignals.push(Object.freeze({ signalTime: signalCandle.timestamp, entryTime: entryCandle.timestamp, reason: "existing_position", recordedAt: cycleTime }));
      continue;
    }
    const stopDistance = evaluated.atrNow * ETH_V6_FORWARD_CANDIDATE.parameters.stopAtrMultiple;
    const entryPrice = entryCandle.open;
    const stop = entryPrice - stopDistance;
    const target = entryPrice + stopDistance * ETH_V6_FORWARD_CANDIDATE.parameters.targetRiskMultiple;
    const quantity = quantityForRisk(equity, entryPrice, stop);
    if (!(quantity > 0 && stop > 0 && target > entryPrice)) {
      missedSignals.push(Object.freeze({ signalTime: signalCandle.timestamp, entryTime: entryCandle.timestamp, reason: "invalid_position_size", recordedAt: cycleTime }));
      continue;
    }
    const record = createShadowTradeRecord({
      signalId: `ETH-V6-${signalCandle.timestamp}`,
      strategy: "v6_independent_breakout_retest",
      asset: "ETHUSDT",
      market: "CRYPTO_FUTURES",
      timeframe: "1d",
      timestamp: signalCandle.timestamp,
      dataTimestamp: signalCandle.timestamp,
      entryPlan: {
        action: "LONG",
        entryTime: entryCandle.timestamp,
        entryPrice,
        quantity,
        leverage: 1,
        source: "bitget-public-forward-paper",
      },
      stop,
      targets: [target],
      invalidation: `daily close invalidates frozen V6 breakout/retest thesis or stop ${stop}`,
      feesSlippageModel: {
        ...BITGET_STANDARD_TAKER_RESEARCH_COSTS.CRYPTO_FUTURES,
        fundingRates: [],
      },
    });
    const upserted = upsertShadowTradeLedger(ledger, record, { expectedVersion: ledger.version });
    ledger = { version: upserted.version, records: [...upserted.records] };
  }

  const next = Object.freeze({
    ...current,
    updatedAt: cycleTime,
    lastSignalEvaluated,
    ledger: Object.freeze({ version: ledger.version, records: Object.freeze(ledger.records) }),
    missedSignals: Object.freeze(missedSignals),
    paper: Object.freeze({ initialCapital: ETH_V6_FORWARD_INITIAL_CAPITAL, equity }),
  });
  return Object.freeze({ ...next, stateSha256: stateDigest(next) });
}

export function summarizeEthV6ForwardState(state) {
  if (!state || typeof state !== "object") throw new ResearchContractError("INVALID_FORWARD_STATE", "forward state is required");
  const settled = (state.ledger?.records ?? []).filter((record) => record.status === "settled");
  const tracking = (state.ledger?.records ?? []).filter((record) => record.status === "tracking");
  const trades = settled.map(strategyTrade).filter(Boolean);
  const performance = summarizeResearchPerformance(trades, { initialCapital: state.paper.initialCapital }).overall;
  const elapsedMs = Math.max(0, state.updatedAt - state.startedAt);
  const elapsedDays = elapsedMs / DAY_MS;
  const standardizedMetrics = buildStandardizedResearchMetrics({
    trades,
    initialCapital: state.paper.initialCapital,
    totalReturnPercent: performance.totalReturn * 100,
    profitFactor: performance.profitFactor,
    maximumDrawdownPercent: performance.maximumDrawdownPercent * 100,
    expectancy: performance.expectancy,
  });
  const promotionGate = evaluateForwardPromotionGate({
    metrics: standardizedMetrics,
    elapsedDays,
    safeguards: state.safeguards,
  });
  const researchSample = performance.sampleCount >= 30;
  return Object.freeze({
    schemaVersion: 1,
    candidateId: state.candidateId,
    candidateManifestSha256: state.candidateManifestSha256,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    lastSignalEvaluated: state.lastSignalEvaluated,
    signalsRecorded: (state.ledger?.records ?? []).length,
    settledTrades: settled.length,
    trackingTrades: tracking.length,
    missedSignals: (state.missedSignals ?? []).length,
    initialCapital: state.paper.initialCapital,
    paperEquity: state.paper.equity,
    totalReturnPercent: standardizedMetrics.totalReturnPercent,
    successRateDefinition: standardizedMetrics.successRateDefinition,
    successRatePercent: standardizedMetrics.successRatePercent,
    tpBeforeSlRatePercent: standardizedMetrics.tpBeforeSlRatePercent,
    tpBeforeSlRateAvailable: standardizedMetrics.tpBeforeSlRateAvailable,
    netProfitableTradeRatePercent: standardizedMetrics.netProfitableTradeRatePercent,
    barrierResolvedTradeCount: standardizedMetrics.barrierResolvedTradeCount,
    tpHitCount: standardizedMetrics.tpHitCount,
    slHitCount: standardizedMetrics.slHitCount,
    censoredTradeCount: standardizedMetrics.censoredCount,
    profitFactor: standardizedMetrics.profitFactor,
    maximumDrawdownPercent: standardizedMetrics.maximumDrawdownPercent,
    expectancy: standardizedMetrics.expectancy,
    costStress: standardizedMetrics.costStress,
    elapsedDays,
    researchSampleSufficient: researchSample,
    status: promotionGate.status,
    nextStage: promotionGate.nextStage,
    promotionGate,
    safeguards: state.safeguards,
  });
}

export function compareReplayMetrics(expected, actual, tolerance = 1e-8) {
  const fields = ["finalCapital", "returnPercent", "successRatePercent", "profitFactor", "maximumDrawdownPercent", "expectancy", "trades"];
  const mismatches = [];
  for (const field of fields) {
    const left = expected?.[field];
    const right = actual?.[field];
    if (left === null && right === null) continue;
    if (field === "trades") {
      if (left !== right) mismatches.push(Object.freeze({ field, expected: left, actual: right }));
      continue;
    }
    if (!Number.isFinite(left) || !Number.isFinite(right) || Math.abs(left - right) > tolerance * Math.max(1, Math.abs(left), Math.abs(right))) {
      mismatches.push(Object.freeze({ field, expected: left, actual: right }));
    }
  }
  return Object.freeze({ passed: mismatches.length === 0, mismatches: Object.freeze(mismatches), tolerance, usedForSelection: false, parametersChanged: false });
}
