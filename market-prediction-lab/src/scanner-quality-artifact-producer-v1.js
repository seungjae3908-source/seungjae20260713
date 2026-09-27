import { createHash } from "node:crypto";
import { summarizeResearchPerformance } from "./research-validation-layer.js";
import { TRANSACTION_COST_COMPONENTS } from "../../market-intelligence-sidecar/src/transaction-cost-evidence.mjs";

export const SCANNER_QUALITY_ARTIFACT_PRODUCER_V1 =
  "scanner-quality-artifact-producer-v1";

const MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
const STOCK_MARKETS = new Set(["KR_STOCK", "US_STOCK"]);
const CASH_MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT"]);
const SHA40 = /^[0-9a-f]{40}$/iu;
const SHA64 = /^[0-9a-f]{64}$/iu;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function blocked(reason, details = {}) {
  return deepFreeze({
    schemaVersion: SCANNER_QUALITY_ARTIFACT_PRODUCER_V1,
    status: "BLOCKED_DATA",
    reason,
    details,
    entry: null,
    profitabilityClaimAllowed: false,
    automaticPromotionAuthority: false,
    economicSampleCredit: 0,
    executionAuthority: "NONE",
  });
}

function normalizeDirection(identity) {
  const direction = String(identity?.direction ?? "").toUpperCase();
  if (identity?.market === "CRYPTO_FUTURES") {
    return direction === "LONG" || direction === "SHORT" ? direction : null;
  }
  return direction === "BUY" ? "BUY" : null;
}

function validateIdentity(identity) {
  if (!identity || typeof identity !== "object") return "QUALITY_IDENTITY_REQUIRED";
  if (!MARKETS.has(identity.market)) return "QUALITY_MARKET_UNSUPPORTED";
  if (!text(identity.strategyId) || !text(identity.strategyVersion)) return "QUALITY_STRATEGY_IDENTITY_REQUIRED";
  if (!SHA64.test(String(identity.parameterHash ?? ""))) return "QUALITY_PARAMETER_HASH_REQUIRED";
  if (!SHA40.test(String(identity.researchCodeSha ?? ""))) return "QUALITY_RESEARCH_SHA_REQUIRED";
  if (!SHA64.test(String(identity.datasetSnapshotHash ?? ""))) return "QUALITY_DATASET_SNAPSHOT_HASH_REQUIRED";
  if (!text(identity.symbol) || !text(identity.timeframe)) return "QUALITY_SYMBOL_TIMEFRAME_REQUIRED";
  if (!normalizeDirection(identity)) {
    return CASH_MARKETS.has(identity.market)
      ? "QUALITY_CASH_BUY_ONLY"
      : "QUALITY_DIRECTION_REQUIRED";
  }
  return null;
}

function exactBinding(binding, identity) {
  if (!binding || typeof binding !== "object") return false;
  for (const key of [
    "strategyId", "strategyVersion", "parameterHash", "researchCodeSha",
    "market", "symbol", "timeframe", "datasetSnapshotHash",
  ]) {
    if (String(binding[key] ?? "") !== String(identity[key] ?? "")) return false;
  }
  return String(binding.direction ?? "").toUpperCase() === normalizeDirection(identity);
}

function foldWindow(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const anchors = rows.map((row) => Number(row?.anchorTimestamp));
  const futureEnds = rows.map((row) => Number(row?.futureEndTimestamp));
  if (!anchors.every(Number.isSafeInteger) || !futureEnds.every(Number.isSafeInteger)) return null;
  const startTime = Math.min(...anchors);
  const endTime = Math.max(...futureEnds);
  return startTime > 0 && endTime >= startTime ? { startTime, endTime } : null;
}

function validateFold(fold) {
  if (!fold || !Number.isInteger(fold.fold) || fold.fold < 1) return "QUALITY_FOLD_ID_INVALID";
  if (fold.leakFree !== true) return "QUALITY_FOLD_NOT_LEAK_FREE";
  const oosWindow = foldWindow(fold.outOfSample);
  const wfWindow = foldWindow(fold.walkForwardTest);
  if (!oosWindow || !wfWindow) return "QUALITY_FOLD_WINDOW_INVALID";
  const report = fold.report ?? {};
  const firstOos = Math.min(...fold.outOfSample.map((row) => row.anchorTimestamp));
  const firstWf = Math.min(...fold.walkForwardTest.map((row) => row.anchorTimestamp));
  if (!Number.isSafeInteger(report.maxTrainFuture)
      || !Number.isSafeInteger(report.maxValidationFuture)
      || firstOos <= report.maxTrainFuture
      || firstWf <= report.maxValidationFuture) {
    return "QUALITY_FOLD_PURGE_BOUNDARY_INVALID";
  }
  return null;
}

function expectedResultDirection(identity) {
  if (identity.market === "CRYPTO_FUTURES") {
    return normalizeDirection(identity) === "LONG" ? "long" : "short";
  }
  return "long";
}

function validateResult(result, identity, window, label) {
  const blockers = [];
  if (!result || result.ok !== true || result.mode !== "backtest-only") blockers.push(`${label}_RESULT_INVALID`);
  if (result?.orderSubmitted !== false || result?.privateAccountRequestAllowed !== false) {
    blockers.push(`${label}_SAFETY_INVALID`);
  }
  if (result?.market !== identity.market) blockers.push(`${label}_MARKET_MISMATCH`);
  if (String(result?.symbol ?? "").toUpperCase() !== String(identity.symbol).toUpperCase()) {
    blockers.push(`${label}_SYMBOL_MISMATCH`);
  }
  if (result?.timeframe !== identity.timeframe) blockers.push(`${label}_TIMEFRAME_MISMATCH`);
  if (String(result?.side ?? "").toLowerCase() !== expectedResultDirection(identity)) {
    blockers.push(`${label}_DIRECTION_MISMATCH`);
  }
  if (result?.period?.startTime !== window.startTime
      || result?.period?.effectiveEndTime !== window.endTime) {
    blockers.push(`${label}_WINDOW_MISMATCH`);
  }
  const safeguards = result?.safeguards ?? {};
  if (safeguards.signalUsesClosedCandle !== true) blockers.push(`${label}_CLOSED_CANDLE_GUARD_MISSING`);
  if (safeguards.entryUsesNextCandleOpen !== true) blockers.push(`${label}_NEXT_OPEN_GUARD_MISSING`);
  if (safeguards.stopFirstOnAmbiguousBar !== true) blockers.push(`${label}_STOP_FIRST_GUARD_MISSING`);
  if (safeguards.costsIncluded !== true) blockers.push(`${label}_COST_GUARD_MISSING`);
  if (!(finite(result?.initialCapital) > 0)) blockers.push(`${label}_INITIAL_CAPITAL_INVALID`);
  if (!Array.isArray(result?.trades)) blockers.push(`${label}_TRADES_MISSING`);

  const costModel = result?.costModel ?? {};
  for (const field of [
    "entryFeeRate", "exitFeeRate", "taxRate", "slippageRate", "spreadRate", "latencyDriftRate",
  ]) {
    if (!(finite(costModel[field]) >= 0)) blockers.push(`${label}_COST_MODEL_${field.toUpperCase()}_INVALID`);
  }
  if (!Number.isInteger(costModel.latencyBars) || costModel.latencyBars < 0) {
    blockers.push(`${label}_COST_MODEL_LATENCY_BARS_INVALID`);
  }

  if (Array.isArray(result?.trades)) {
    const ids = new Set();
    for (const trade of result.trades) {
      if (!text(trade?.id) || ids.has(trade.id)) blockers.push(`${label}_TRADE_ID_INVALID_OR_DUPLICATE`);
      ids.add(trade?.id);
      if (trade?.market !== identity.market
          || String(trade?.symbol ?? "").toUpperCase() !== String(identity.symbol).toUpperCase()
          || trade?.timeframe !== identity.timeframe
          || String(trade?.side ?? "").toLowerCase() !== expectedResultDirection(identity)) {
        blockers.push(`${label}_TRADE_IDENTITY_MISMATCH`);
      }
      if (!(finite(trade?.netPnl) != null)
          || !(finite(trade?.netReturnOnMargin) != null)
          || trade?.costsIncluded !== true
          || !(finite(trade?.costs?.total) >= 0)
          || !Number.isSafeInteger(trade?.entryTime)
          || !Number.isSafeInteger(trade?.exitTime)
          || trade.entryTime < window.startTime
          || trade.exitTime > window.endTime
          || trade.exitTime < trade.entryTime) {
        blockers.push(`${label}_TRADE_CONTRACT_INVALID`);
      }
    }
  }
  return [...new Set(blockers)];
}

function validateDatasetEvidence(identity, datasetAudit, stockUniverseBiasAudit) {
  const blockers = [];
  if (datasetAudit?.eligible !== true) blockers.push("QUALITY_DATASET_AUDIT_NOT_ELIGIBLE");
  const safeguards = datasetAudit?.safeguards ?? {};
  if (safeguards.lookaheadBlocked !== true) blockers.push("QUALITY_DATASET_LOOKAHEAD_GUARD_MISSING");
  if (safeguards.closedCandlesOnly !== true) blockers.push("QUALITY_DATASET_CLOSED_CANDLE_GUARD_MISSING");
  if (safeguards.survivorshipProtected !== true) blockers.push("QUALITY_DATASET_SURVIVORSHIP_GUARD_MISSING");
  if (STOCK_MARKETS.has(identity.market)) {
    if (stockUniverseBiasAudit?.status !== "point_in_time_bias_gate_passed") {
      blockers.push("QUALITY_STOCK_PIT_UNIVERSE_AUDIT_REQUIRED");
    }
    if (stockUniverseBiasAudit?.market !== identity.market) blockers.push("QUALITY_STOCK_PIT_MARKET_MISMATCH");
    if (stockUniverseBiasAudit?.safeguards?.currentConstituentListAloneCannotPass !== true
        || stockUniverseBiasAudit?.safeguards?.missingHistoriesFailClosed !== true) {
      blockers.push("QUALITY_STOCK_PIT_SAFEGUARDS_INVALID");
    }
  }
  return [...new Set(blockers)];
}

function validateCostEvidence(identity, costEvidence) {
  const blockers = [];
  if (costEvidence?.contract !== "market-intelligence-transaction-cost-evidence/v1"
      || costEvidence?.status !== "READY"
      || costEvidence?.readyForNetAlpha !== true
      || costEvidence?.market !== identity.market) {
    blockers.push("QUALITY_TRANSACTION_COST_EVIDENCE_NOT_READY");
  }
  if (!(finite(costEvidence?.totalPointCostBps) >= 0)
      || !(finite(costEvidence?.totalConservativeCostBps) >= finite(costEvidence?.totalPointCostBps))) {
    blockers.push("QUALITY_TRANSACTION_COST_TOTAL_INVALID");
  }
  if (costEvidence?.safety?.executionAuthority !== "NONE"
      || costEvidence?.safety?.promotionAuthority !== false
      || costEvidence?.safety?.orderAllowed !== false
      || costEvidence?.safety?.privateTradingApiAllowed !== false) {
    blockers.push("QUALITY_TRANSACTION_COST_SAFETY_INVALID");
  }
  for (const component of TRANSACTION_COST_COMPONENTS) {
    if (costEvidence?.components?.[component]?.status !== "READY"
        || !(finite(costEvidence?.pointCosts?.[component]) >= 0)
        || !(finite(costEvidence?.conservativeCosts?.[component]) >= finite(costEvidence?.pointCosts?.[component]))) {
      blockers.push(`QUALITY_TRANSACTION_COST_COMPONENT_INVALID:${component}`);
    }
  }
  return [...new Set(blockers)];
}

function summarizeTrades(trades, initialCapital) {
  const performance = summarizeResearchPerformance(trades, { initialCapital }).overall;
  const returns = trades.map((trade) => trade.netReturnOnMargin * 100);
  return {
    sampleCount: performance.sampleCount,
    winRatePercent: performance.winRate * 100,
    expectancyPercent: mean(returns),
    profitFactor: performance.profitFactor,
    maximumDrawdownPercent: performance.maximumDrawdownPercent * 100,
    netReturnPercent: performance.totalReturn * 100,
    sharpe: performance.tradeSharpe,
  };
}

export function buildScannerQualityEntryV1(input = {}) {
  const identity = input.identity;
  const identityReason = validateIdentity(identity);
  if (identityReason) return blocked(identityReason);
  if (!Array.isArray(input.folds) || input.folds.length === 0) {
    return blocked("QUALITY_PURGED_WALK_FORWARD_FOLDS_REQUIRED");
  }
  if (!Array.isArray(input.foldResults) || input.foldResults.length !== input.folds.length) {
    return blocked("QUALITY_FOLD_RESULT_COUNT_MISMATCH");
  }

  const datasetBlockers = validateDatasetEvidence(
    identity,
    input.datasetAudit,
    input.stockUniverseBiasAudit,
  );
  if (datasetBlockers.length) return blocked("QUALITY_DATASET_EVIDENCE_BLOCKED", { blockers: datasetBlockers });

  const costBlockers = validateCostEvidence(identity, input.transactionCostEvidence);
  if (costBlockers.length) return blocked("QUALITY_COST_EVIDENCE_BLOCKED", { blockers: costBlockers });

  const oosTrades = [];
  const wfTrades = [];
  let researchFrom = Number.POSITIVE_INFINITY;
  let researchTo = Number.NEGATIVE_INFINITY;
  let initialCapital = null;

  for (let index = 0; index < input.folds.length; index += 1) {
    const fold = input.folds[index];
    const foldReason = validateFold(fold);
    if (foldReason) return blocked(foldReason, { fold: fold?.fold ?? null });
    const packet = input.foldResults[index];
    if (packet?.fold !== fold.fold) return blocked("QUALITY_FOLD_ID_MISMATCH", { index });
    if (!exactBinding(packet?.binding, identity)) {
      return blocked("QUALITY_EXACT_BINDING_MISMATCH", { fold: fold.fold });
    }

    const oosWindow = foldWindow(fold.outOfSample);
    const wfWindow = foldWindow(fold.walkForwardTest);
    const oosBlockers = validateResult(packet?.outOfSampleResult, identity, oosWindow, `FOLD_${fold.fold}_OOS`);
    const wfBlockers = validateResult(packet?.walkForwardResult, identity, wfWindow, `FOLD_${fold.fold}_WF`);
    if (oosBlockers.length || wfBlockers.length) {
      return blocked("QUALITY_BACKTEST_RESULT_INVALID", {
        fold: fold.fold,
        blockers: [...oosBlockers, ...wfBlockers],
      });
    }

    const capitals = [
      packet.outOfSampleResult.initialCapital,
      packet.walkForwardResult.initialCapital,
    ];
    if (initialCapital == null) initialCapital = capitals[0];
    if (capitals.some((value) => value !== initialCapital)) {
      return blocked("QUALITY_INITIAL_CAPITAL_MISMATCH", { fold: fold.fold });
    }

    researchFrom = Math.min(researchFrom, oosWindow.startTime, wfWindow.startTime);
    researchTo = Math.max(researchTo, oosWindow.endTime, wfWindow.endTime);
    oosTrades.push(...packet.outOfSampleResult.trades);
    wfTrades.push(...packet.walkForwardResult.trades);
  }

  if (!(initialCapital > 0)) return blocked("QUALITY_INITIAL_CAPITAL_REQUIRED");
  if (oosTrades.length === 0 || wfTrades.length === 0) {
    return blocked("QUALITY_OOS_AND_WALK_FORWARD_TRADES_REQUIRED");
  }

  const oos = summarizeTrades(oosTrades, initialCapital);
  const walkForward = summarizeTrades(wfTrades, initialCapital);
  const minimumTradeCount = Number.isInteger(input.minimumTradeCount) && input.minimumTradeCount > 0
    ? input.minimumTradeCount : 40;

  const quality = {
    status: "verified",
    researchFrom: new Date(researchFrom).toISOString(),
    researchTo: new Date(researchTo).toISOString(),
    oosWinRate: oos.winRatePercent,
    walkForwardWinRate: walkForward.winRatePercent,
    expectancyPercent: walkForward.expectancyPercent,
    profitFactor: walkForward.profitFactor,
    maxDrawdownPercent: -Math.abs(walkForward.maximumDrawdownPercent),
    tradeCount: walkForward.sampleCount,
    minimumTradeCount,
    sharpe: walkForward.sharpe,
    netReturnPercent: walkForward.netReturnPercent,
    regime: null,
    regimeScore: null,
    oosStabilityScore: null,
    costsIncluded: true,
    slippageIncluded: true,
    lookaheadGuarded: true,
    survivorshipGuarded: true,
    oos: true,
    walkForward: true,
    source: [
      SCANNER_QUALITY_ARTIFACT_PRODUCER_V1,
      identity.strategyId,
      identity.researchCodeSha,
      identity.datasetSnapshotHash,
      input.transactionCostEvidence.evidenceSetVersion,
    ].join(":"),
  };

  const entry = {
    identity: {
      ...identity,
      direction: normalizeDirection(identity),
      symbol: String(identity.symbol).toUpperCase(),
    },
    quality,
    executionAuthority: "NONE",
    automaticPromotionAuthority: false,
    profitabilityClaimAllowed: false,
  };

  return deepFreeze({
    schemaVersion: SCANNER_QUALITY_ARTIFACT_PRODUCER_V1,
    status: "READY",
    reason: null,
    entry,
    diagnostics: {
      foldCount: input.folds.length,
      oosTrades: oos.sampleCount,
      walkForwardTrades: walkForward.sampleCount,
      oos,
      walkForward,
      transactionCostEvidenceSetVersion: input.transactionCostEvidence.evidenceSetVersion,
    },
    profitabilityClaimAllowed: false,
    automaticPromotionAuthority: false,
    economicSampleCredit: 0,
    executionAuthority: "NONE",
  });
}

export function materializeForwardObserverScannerQualityArtifactV1(input = {}) {
  const researchCodeSha = String(input.researchCodeSha ?? "").toLowerCase();
  if (!SHA40.test(researchCodeSha)) throw new Error("QUALITY_ARTIFACT_RESEARCH_SHA_REQUIRED");
  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    throw new Error("QUALITY_ARTIFACT_ENTRIES_REQUIRED");
  }
  const entries = input.entries.map((value, index) => {
    const entry = value?.status === "READY" ? value.entry : value?.identity ? value : null;
    if (!entry || entry.identity?.researchCodeSha?.toLowerCase() !== researchCodeSha) {
      throw new Error(`QUALITY_ARTIFACT_ENTRY_INVALID:${index}`);
    }
    return entry;
  });

  const artifact = {
    schemaVersion: "forward-observer-scanner-quality-v1",
    researchCodeSha,
    entries,
    safety: {
      executionAuthority: "NONE",
      financialMutationAllowed: false,
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      profitabilityClaimAllowed: false,
    },
  };
  const qualityText = `${JSON.stringify(artifact, null, 2)}\n`;
  const qualitySha256 = sha256Text(qualityText);
  const manifest = {
    schemaVersion: 1,
    kind: "forward-observer-scanner-quality",
    researchCodeSha,
    qualitySha256,
    safety: artifact.safety,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  return deepFreeze({
    schemaVersion: SCANNER_QUALITY_ARTIFACT_PRODUCER_V1,
    status: "READY",
    artifact,
    manifest,
    qualityText,
    manifestText,
    qualitySha256,
    profitabilityClaimAllowed: false,
    automaticPromotionAuthority: false,
    economicSampleCredit: 0,
    executionAuthority: "NONE",
  });
}
