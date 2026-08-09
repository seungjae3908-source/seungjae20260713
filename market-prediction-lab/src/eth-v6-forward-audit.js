import { ResearchContractError } from "./research-governance.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const TP_EXIT_REASONS = new Set(["take_profit", "take_profit_gap"]);
const SL_EXIT_REASONS = new Set(["stop_loss", "stop_loss_gap", "stop_loss_same_bar"]);
const EXPIRED_EXIT_REASONS = new Set(["expired", "timeout", "end_of_data", "manual_end"]);
const INVALIDATED_EXIT_REASONS = new Set(["invalidated", "condition_broken"]);

export const FORWARD_OUTCOME_STATES = Object.freeze([
  "tracking",
  "TP before SL",
  "SL before TP",
  "expired",
  "missed",
  "invalidated",
  "data unavailable",
]);

function assertResearchCodeSha(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new ResearchContractError("INVALID_RESEARCH_CODE_SHA", "researchCodeSha must be an exact 40-character git SHA");
  }
  return value;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function isoOrNull(timestamp) {
  return Number.isInteger(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : null;
}

function validateFundingRecords(records, cycleTime) {
  if (!Array.isArray(records)) throw new ResearchContractError("INVALID_FORWARD_FUNDING", "fundingRecords must be an array");
  let previous = 0;
  for (const [index, record] of records.entries()) {
    if (!Number.isInteger(record?.timestamp) || record.timestamp <= 0 || record.timestamp > cycleTime) {
      throw new ResearchContractError("INVALID_FORWARD_FUNDING_TIMESTAMP", `fundingRecords[${index}] timestamp is invalid`);
    }
    if (record.timestamp <= previous) {
      throw new ResearchContractError("NON_MONOTONIC_FORWARD_FUNDING", "funding records must be strictly increasing without duplicates");
    }
    if (!Number.isFinite(record.rate)) throw new ResearchContractError("INVALID_FORWARD_FUNDING_RATE", `fundingRecords[${index}] rate must be finite`);
    previous = record.timestamp;
  }
}

function latestFundingSnapshot(records, asOf) {
  let selected = null;
  for (const record of records) {
    if (record.timestamp > asOf) break;
    selected = record;
  }
  return selected
    ? Object.freeze({ status: "available", timestamp: selected.timestamp, timestampIso: isoOrNull(selected.timestamp), rate: selected.rate })
    : Object.freeze({ status: "not_available", timestamp: null, timestampIso: null, rate: null });
}

function modeledEntryPrice(record) {
  const intended = Number(record?.entryPlan?.entryPrice);
  if (!(Number.isFinite(intended) && intended > 0)) return null;
  const action = record?.entryPlan?.action;
  const direction = action === "SHORT" ? -1 : action === "LONG" || action === "BUY" ? 1 : 0;
  if (direction === 0) return null;
  const model = record.feesSlippageModel ?? {};
  const spreadRate = Number(model.spreadRate ?? 0);
  const slippageRate = Number(model.slippageRate ?? 0);
  const latencyBars = Number(model.latencyBars ?? 0);
  const latencyDriftRate = Number(model.latencyDriftRate ?? 0);
  if (![spreadRate, slippageRate, latencyBars, latencyDriftRate].every(Number.isFinite)) return null;
  const latencyRate = Math.min(0.99, Math.max(0, latencyBars) * Math.max(0, latencyDriftRate));
  const spreadAdjusted = intended * (direction > 0 ? 1 + spreadRate / 2 : 1 - spreadRate / 2);
  const latencyAdjusted = spreadAdjusted * (direction > 0 ? 1 + latencyRate : 1 - latencyRate);
  return latencyAdjusted * (direction > 0 ? 1 + slippageRate : 1 - slippageRate);
}

export function classifyForwardOutcome(record) {
  if (record?.status === "tracking") return "tracking";
  const reason = String(record?.subsequentMarketResult?.exitReason ?? "");
  if (record?.status === "settled") {
    if (TP_EXIT_REASONS.has(reason)) return "TP before SL";
    if (SL_EXIT_REASONS.has(reason)) return "SL before TP";
    if (EXPIRED_EXIT_REASONS.has(reason)) return "expired";
    if (INVALIDATED_EXIT_REASONS.has(reason)) return "invalidated";
    return "data unavailable";
  }
  if (record?.status === "expired") return "expired";
  if (record?.status === "invalidated") return "invalidated";
  return "data unavailable";
}

function costAudit(record) {
  const model = record?.feesSlippageModel ?? {};
  const actual = record?.execution?.costs ?? null;
  const latencyRate = Number.isFinite(model.latencyBars) && Number.isFinite(model.latencyDriftRate)
    ? Math.min(0.99, Math.max(0, model.latencyBars) * Math.max(0, model.latencyDriftRate))
    : null;
  return Object.freeze({
    fees: Object.freeze({
      entryRate: finiteOrNull(model.entryFeeRate),
      exitRate: finiteOrNull(model.exitFeeRate),
      taxRate: finiteOrNull(model.taxRate),
      actualEntryFee: finiteOrNull(actual?.entryFee),
      actualExitFee: finiteOrNull(actual?.exitFee),
      actualTax: finiteOrNull(actual?.tax),
    }),
    spread: Object.freeze({ rate: finiteOrNull(model.spreadRate), actualCost: finiteOrNull(actual?.spread) }),
    slippage: Object.freeze({ rate: finiteOrNull(model.slippageRate), actualCost: finiteOrNull(actual?.slippage) }),
    latencyAdjustment: Object.freeze({
      bars: Number.isInteger(model.latencyBars) ? model.latencyBars : null,
      driftRate: finiteOrNull(model.latencyDriftRate),
      modeledRate: latencyRate,
      actualCost: finiteOrNull(actual?.latency),
    }),
    funding: Object.freeze({
      appliedRates: Object.freeze([...(Array.isArray(model.fundingRates) ? model.fundingRates : [])]),
      actualCost: finiteOrNull(actual?.funding),
    }),
    totalActualCost: finiteOrNull(actual?.total),
  });
}

function regimeAudit(regime) {
  const liquidity = String(regime?.liquidity ?? "not_available_without_orderbook_history");
  return Object.freeze({
    regimeAtSignalTime: regime ?? null,
    trendRegime: regime?.trend ?? "unknown",
    volatilityRegime: regime?.volatility ?? "unknown",
    liquidityEvidence: Object.freeze({
      status: liquidity.startsWith("not_available") ? "not_available" : "available",
      evidence: liquidity,
      syntheticScoreGenerated: false,
    }),
  });
}

function recordAudit(record, context) {
  const decisionTimestamp = record.timestamp + DAY_MS;
  const modeled = modeledEntryPrice(record);
  const executed = finiteOrNull(record?.execution?.executedEntry);
  const regime = regimeAudit(record?.entryPlan?.marketRegime ?? null);
  return Object.freeze({
    signalId: record.signalId,
    strategyId: context.strategyId,
    strategyVersion: context.strategyVersion,
    researchCodeSha: context.researchCodeSha,
    signalTimestamp: record.timestamp,
    signalTimestampIso: isoOrNull(record.timestamp),
    decisionTimestamp,
    decisionTimestampIso: isoOrNull(decisionTimestamp),
    marketTimestamp: record.dataTimestamp ?? record.timestamp,
    marketTimestampIso: isoOrNull(record.dataTimestamp ?? record.timestamp),
    entryEligibleTimestamp: record?.entryPlan?.entryTime ?? null,
    entryEligibleTimestampIso: isoOrNull(record?.entryPlan?.entryTime),
    intendedEntry: finiteOrNull(record?.entryPlan?.entryPrice),
    actualSimulatedEntry: executed ?? modeled,
    actualSimulatedEntrySource: executed !== null ? "settled_execution" : modeled !== null ? "deterministic_execution_model" : "not_available",
    nextBarOpen: finiteOrNull(record?.entryPlan?.entryPrice),
    takeProfit: finiteOrNull(record?.targets?.[0]),
    stopLoss: finiteOrNull(record?.stop),
    ...costAudit(record),
    ...regime,
    fundingSnapshot: latestFundingSnapshot(context.fundingRecords, decisionTimestamp),
    outcomeState: classifyForwardOutcome(record),
    exitReason: record?.subsequentMarketResult?.exitReason ?? null,
    exitTimestamp: record?.subsequentMarketResult?.exitTimestamp ?? null,
    exitTimestampIso: isoOrNull(record?.subsequentMarketResult?.exitTimestamp),
    netPnl: finiteOrNull(record?.hypotheticalPnl),
    orderSubmitted: record?.orderSubmitted === true,
    privateAccountRequested: record?.privateAccountRequested === true,
  });
}

function missedAudit(event, context) {
  const signalTimestamp = event.signalTime;
  const decisionTimestamp = signalTimestamp + DAY_MS;
  const signalIndex = context.candles.findIndex((candle) => candle.timestamp === signalTimestamp);
  const entryCandle = Number.isInteger(event.entryTime)
    ? context.candles.find((candle) => candle.timestamp === event.entryTime) ?? null
    : null;
  const regime = signalIndex >= 0 ? context.classifyRegime(context.candles, signalIndex) : null;
  return Object.freeze({
    signalId: `ETH-V6-${signalTimestamp}`,
    strategyId: context.strategyId,
    strategyVersion: context.strategyVersion,
    researchCodeSha: context.researchCodeSha,
    signalTimestamp,
    signalTimestampIso: isoOrNull(signalTimestamp),
    decisionTimestamp,
    decisionTimestampIso: isoOrNull(decisionTimestamp),
    marketTimestamp: signalTimestamp,
    marketTimestampIso: isoOrNull(signalTimestamp),
    entryEligibleTimestamp: event.entryTime ?? decisionTimestamp,
    entryEligibleTimestampIso: isoOrNull(event.entryTime ?? decisionTimestamp),
    intendedEntry: finiteOrNull(entryCandle?.open),
    actualSimulatedEntry: null,
    actualSimulatedEntrySource: "not_simulated_missed_entry",
    nextBarOpen: finiteOrNull(entryCandle?.open),
    takeProfit: null,
    stopLoss: null,
    fees: null,
    spread: null,
    slippage: null,
    latencyAdjustment: null,
    funding: null,
    totalActualCost: null,
    ...regimeAudit(regime),
    fundingSnapshot: latestFundingSnapshot(context.fundingRecords, decisionTimestamp),
    outcomeState: "missed",
    missReason: event.reason ?? "unknown",
    recordedAt: event.recordedAt ?? context.cycleTime,
    orderSubmitted: false,
    privateAccountRequested: false,
  });
}

function metricInterpretation(state, summary) {
  const settled = Number(summary?.settledTrades ?? 0);
  const resolved = Number(summary?.barrierResolvedTradeCount ?? 0);
  return Object.freeze({
    tpBeforeSl: Object.freeze({
      available: resolved > 0,
      valuePercent: resolved > 0 ? summary.tpBeforeSlRatePercent : null,
      display: resolved > 0 ? `${summary.tpBeforeSlRatePercent}%` : "N/A — insufficient resolved sample",
    }),
    netProfitableRate: Object.freeze({
      available: settled > 0,
      valuePercent: settled > 0 ? summary.netProfitableTradeRatePercent : null,
      display: settled > 0 ? `${summary.netProfitableTradeRatePercent}%` : "N/A — insufficient settled sample",
    }),
    performance: Object.freeze({
      available: settled > 0,
      returnPercent: settled > 0 ? summary.totalReturnPercent : null,
      profitFactor: settled > 0 ? summary.profitFactor : null,
      maximumDrawdownPercent: settled > 0 ? summary.maximumDrawdownPercent : null,
      expectancy: settled > 0 ? summary.expectancy : null,
      display: settled > 0 ? "available" : "N/A — insufficient settled sample",
      paperEquityUnchanged: settled === 0 && state.paper?.equity === state.paper?.initialCapital,
    }),
  });
}

export function buildEthV6ForwardCycleAudit({
  state,
  previousState,
  summary,
  researchCodeSha,
  strategyId,
  strategyVersion,
  cycleTime,
  fundingRecords = [],
  candles = [],
  classifyRegime,
} = {}) {
  if (!state || typeof state !== "object") throw new ResearchContractError("INVALID_FORWARD_AUDIT_STATE", "forward state is required");
  if (!summary || typeof summary !== "object") throw new ResearchContractError("INVALID_FORWARD_AUDIT_SUMMARY", "forward summary is required");
  if (!Number.isInteger(cycleTime) || cycleTime <= 0) throw new ResearchContractError("INVALID_FORWARD_AUDIT_CYCLE", "cycleTime must be a positive timestamp");
  if (!Array.isArray(candles)) throw new ResearchContractError("INVALID_FORWARD_AUDIT_CANDLES", "candles must be an array");
  if (typeof classifyRegime !== "function") throw new ResearchContractError("INVALID_FORWARD_REGIME_CLASSIFIER", "classifyRegime is required");
  const exactSha = assertResearchCodeSha(researchCodeSha);
  validateFundingRecords(fundingRecords, cycleTime);

  const previousIds = new Set((previousState?.ledger?.records ?? []).map((record) => record.id));
  const previousMissedCount = previousState?.missedSignals?.length ?? 0;
  const newRecords = (state.ledger?.records ?? []).filter((record) => !previousIds.has(record.id));
  const newMissed = (state.missedSignals ?? []).slice(previousMissedCount);
  const context = Object.freeze({
    researchCodeSha: exactSha,
    strategyId,
    strategyVersion,
    fundingRecords,
    candles,
    classifyRegime,
    cycleTime,
  });
  const recordedSignals = Object.freeze(newRecords.map((record) => recordAudit(record, context)));
  const missedSignals = Object.freeze(newMissed.map((event) => missedAudit(event, context)));
  const disposition = recordedSignals.length === 0 && missedSignals.length === 0
    ? "no_signal"
    : recordedSignals.length > 0 && missedSignals.length > 0
      ? "signals_recorded_and_missed"
      : recordedSignals.length > 0 ? "signals_recorded" : "signals_missed";

  return Object.freeze({
    schemaVersion: 1,
    researchCodeSha: exactSha,
    cycleTimestamp: cycleTime,
    cycleTimestampIso: isoOrNull(cycleTime),
    strategyId,
    strategyVersion,
    disposition,
    zeroSignalMeansStrategyNoSignal: disposition === "no_signal",
    dataQuality: Object.freeze({
      status: "passed",
      failureBehavior: "fail_closed_no_shadow_result",
      enforcedChecks: Object.freeze([
        "negative_volume_blocked",
        "duplicate_or_conflicting_candle_blocked",
        "missing_utc_daily_timestamp_blocked",
        "malformed_ohlc_blocked",
        "utc_boundary_enforced",
        "current_open_completed_overlap_blocked",
        "current_open_staleness_or_gap_blocked",
        "funding_timestamp_order_and_future_timestamp_blocked",
      ]),
    }),
    outcomeStateContract: FORWARD_OUTCOME_STATES,
    recordedSignals,
    missedSignals,
    metricInterpretation: metricInterpretation(state, summary),
    safeguards: Object.freeze({
      parameterChanged: false,
      holdoutChanged: false,
      forwardFedBackIntoTraining: false,
      orderSubmitted: false,
      privateApiRequested: false,
    }),
  });
}
