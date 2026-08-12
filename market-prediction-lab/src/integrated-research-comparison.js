const MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
const STAGE_STATUSES = new Set(["available", "partial", "blocked_data", "not_evaluated", "insufficient_sample", "technical_failure"]);
const RESEARCH_STATUSES = Object.freeze({
  REJECTED: "REJECTED",
  RESEARCHING: "RESEARCHING",
  OOS_VALIDATED: "OOS_VALIDATED",
  WF_VALIDATED: "WF_VALIDATED",
  PAPER_VALIDATED: "PAPER_VALIDATED",
});
const SAFETY_CONTRACT = Object.freeze({
  simulatedOnly: true,
  liveOrderAllowed: false,
  privateAccountRequestAllowed: false,
  orderSubmitted: false,
});

export class IntegratedResearchContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "IntegratedResearchContractError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new IntegratedResearchContractError(code, message, details);
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) fail("INVALID_IDENTITY", `${label} must be a non-empty string`, { label });
  return value.trim();
}

function optionalFinite(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) fail("NON_FINITE_METRIC", `${label} must be finite or null`, { label, value });
  return value;
}

function optionalNonNegativeInteger(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) fail("INVALID_COUNT", `${label} must be a non-negative integer or null`, { label, value });
  return value;
}

function optionalDuration(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail("INVALID_DURATION", `${label} must be a non-negative finite number or null`, { label, value });
  return value;
}

function optionalText(value, label) {
  if (value === null || value === undefined) return null;
  return nonEmptyString(value, label);
}

function normalizeHash(value, label, lengths) {
  const normalized = nonEmptyString(value, label).toLowerCase();
  if (!lengths.includes(normalized.length) || !/^[0-9a-f]+$/.test(normalized)) {
    fail("INVALID_HASH", `${label} must be a hexadecimal digest of length ${lengths.join(" or ")}`, { label, value });
  }
  return normalized;
}

export function normalizeStrategyIdentity(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) fail("INVALID_IDENTITY", "strategy identity must be an object");
  const market = nonEmptyString(identity.market, "identity.market").toUpperCase();
  if (!MARKETS.has(market)) fail("INVALID_MARKET", `unsupported market: ${market}`, { market });
  const side = nonEmptyString(identity.side, "identity.side").toLowerCase();
  if (!new Set(["long", "short"]).has(side)) fail("INVALID_SIDE", "identity.side must be long or short", { side });
  if (market !== "CRYPTO_FUTURES" && side !== "long") fail("CASH_SHORT_NOT_ALLOWED", `${market} identity cannot represent a new short position`, { market, side });
  return Object.freeze({
    strategyFamily: nonEmptyString(identity.strategyFamily, "identity.strategyFamily"),
    strategyVersion: nonEmptyString(identity.strategyVersion, "identity.strategyVersion"),
    parameterHash: normalizeHash(identity.parameterHash, "identity.parameterHash", [64]),
    market,
    symbol: nonEmptyString(identity.symbol, "identity.symbol").toUpperCase(),
    timeframe: nonEmptyString(identity.timeframe, "identity.timeframe"),
    side,
    researchCodeSha: normalizeHash(identity.researchCodeSha, "identity.researchCodeSha", [40, 64]),
  });
}

function identityKey(identity) {
  return [
    identity.strategyFamily,
    identity.strategyVersion,
    identity.parameterHash,
    identity.market,
    identity.symbol,
    identity.timeframe,
    identity.side,
    identity.researchCodeSha,
  ].join("::");
}

function assertIdentityMatches(expected, actual, label) {
  if (actual == null) return;
  const normalized = normalizeStrategyIdentity(actual);
  if (identityKey(expected) !== identityKey(normalized)) {
    fail("STRATEGY_IDENTITY_MISMATCH", `${label} strategy identity does not match the integrated strategy`, {
      expected: identityKey(expected),
      actual: identityKey(normalized),
    });
  }
}

function normalizeRegimeMetrics(regimes, label) {
  if (regimes == null) return Object.freeze({});
  if (typeof regimes !== "object" || Array.isArray(regimes)) fail("INVALID_REGIME_METRICS", `${label} must be an object`);
  const normalized = {};
  for (const [regime, metrics] of Object.entries(regimes)) {
    if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) fail("INVALID_REGIME_METRICS", `${label}.${regime} must be an object`);
    normalized[regime] = normalizeMetrics(metrics, `${label}.${regime}`, { allowRegimes: false });
  }
  return Object.freeze(normalized);
}

function normalizeMetrics(input, label, { allowRegimes = true } = {}) {
  if (input == null) return null;
  if (typeof input !== "object" || Array.isArray(input)) fail("INVALID_METRICS", `${label} metrics must be an object`);
  const status = input.status == null ? "available" : nonEmptyString(input.status, `${label}.status`).toLowerCase();
  if (!STAGE_STATUSES.has(status)) fail("INVALID_STAGE_STATUS", `${label}.status is unsupported`, { status });

  const metrics = {
    status,
    initialCapital: optionalFinite(input.initialCapital, `${label}.initialCapital`),
    finalCapital: optionalFinite(input.finalCapital, `${label}.finalCapital`),
    totalReturnPercent: optionalFinite(input.totalReturnPercent, `${label}.totalReturnPercent`),
    netProfit: optionalFinite(input.netProfit, `${label}.netProfit`),
    winRatePercent: optionalFinite(input.winRatePercent, `${label}.winRatePercent`),
    lossRatePercent: optionalFinite(input.lossRatePercent, `${label}.lossRatePercent`),
    profitFactor: optionalFinite(input.profitFactor, `${label}.profitFactor`),
    expectancy: optionalFinite(input.expectancy, `${label}.expectancy`),
    maxDrawdownPercent: optionalFinite(input.maxDrawdownPercent, `${label}.maxDrawdownPercent`),
    averageWin: optionalFinite(input.averageWin, `${label}.averageWin`),
    averageLoss: optionalFinite(input.averageLoss, `${label}.averageLoss`),
    riskReward: optionalFinite(input.riskReward, `${label}.riskReward`),
    tradeCount: optionalNonNegativeInteger(input.tradeCount, `${label}.tradeCount`),
    averageHoldingDurationMs: optionalDuration(input.averageHoldingDurationMs, `${label}.averageHoldingDurationMs`),
    medianHoldingDurationMs: optionalDuration(input.medianHoldingDurationMs, `${label}.medianHoldingDurationMs`),
    maximumHoldingDurationMs: optionalDuration(input.maximumHoldingDurationMs, `${label}.maximumHoldingDurationMs`),
    consecutiveWins: optionalNonNegativeInteger(input.consecutiveWins, `${label}.consecutiveWins`),
    consecutiveLosses: optionalNonNegativeInteger(input.consecutiveLosses, `${label}.consecutiveLosses`),
    feeCost: optionalFinite(input.feeCost, `${label}.feeCost`),
    slippageCost: optionalFinite(input.slippageCost, `${label}.slippageCost`),
    spreadCost: optionalFinite(input.spreadCost, `${label}.spreadCost`),
    fundingCost: optionalFinite(input.fundingCost, `${label}.fundingCost`),
    exposure: optionalFinite(input.exposure, `${label}.exposure`),
    capitalUtilizationPercent: optionalFinite(input.capitalUtilizationPercent, `${label}.capitalUtilizationPercent`),
    sharpe: optionalFinite(input.sharpe, `${label}.sharpe`),
    sortino: optionalFinite(input.sortino, `${label}.sortino`),
    calmar: optionalFinite(input.calmar, `${label}.calmar`),
    sampleQuality: optionalText(input.sampleQuality, `${label}.sampleQuality`),
    dataQuality: optionalText(input.dataQuality, `${label}.dataQuality`),
    provider: optionalText(input.provider, `${label}.provider`),
    freshness: optionalText(input.freshness, `${label}.freshness`),
    evaluatedAt: optionalText(input.evaluatedAt, `${label}.evaluatedAt`),
  };
  if (metrics.tradeCount === 0) {
    for (const field of ["winRatePercent", "lossRatePercent", "profitFactor", "expectancy"]) {
      if (metrics[field] !== null) fail("EMPTY_SAMPLE_METRIC_FORBIDDEN", `${label}.${field} must be null when tradeCount is zero`, { field });
    }
  }
  if (metrics.winRatePercent !== null && (metrics.winRatePercent < 0 || metrics.winRatePercent > 100)) fail("INVALID_PERCENT", `${label}.winRatePercent must be between 0 and 100`);
  if (metrics.lossRatePercent !== null && (metrics.lossRatePercent < 0 || metrics.lossRatePercent > 100)) fail("INVALID_PERCENT", `${label}.lossRatePercent must be between 0 and 100`);
  if (metrics.capitalUtilizationPercent !== null && (metrics.capitalUtilizationPercent < 0 || metrics.capitalUtilizationPercent > 100)) fail("INVALID_PERCENT", `${label}.capitalUtilizationPercent must be between 0 and 100`);
  if (metrics.profitFactor !== null && metrics.profitFactor < 0) fail("INVALID_PROFIT_FACTOR", `${label}.profitFactor cannot be negative`);

  return Object.freeze({
    ...metrics,
    regimes: allowRegimes ? normalizeRegimeMetrics(input.regimes, `${label}.regimes`) : Object.freeze({}),
  });
}

function normalizeStage(stage, label, expectedIdentity) {
  if (stage == null) return null;
  if (typeof stage !== "object" || Array.isArray(stage)) fail("INVALID_STAGE", `${label} must be an object`);
  assertIdentityMatches(expectedIdentity, stage.identity, label);
  const metrics = normalizeMetrics(stage.metrics ?? stage, `${label}.metrics`);
  return Object.freeze({
    identity: expectedIdentity,
    metrics,
    sourceArtifact: optionalText(stage.sourceArtifact, `${label}.sourceArtifact`),
    datasetDigest: stage.datasetDigest == null ? null : normalizeHash(stage.datasetDigest, `${label}.datasetDigest`, [64]),
    validationPassed: stage.validationPassed === true,
    validationReason: optionalText(stage.validationReason, `${label}.validationReason`),
  });
}

function delta(later, earlier) {
  return later === null || earlier === null ? null : later - earlier;
}

function metricGap(referenceMetrics, liveLikeMetrics) {
  if (!referenceMetrics || !liveLikeMetrics) return null;
  return Object.freeze({
    winRatePercentagePoints: delta(liveLikeMetrics.winRatePercent, referenceMetrics.winRatePercent),
    lossRatePercentagePoints: delta(liveLikeMetrics.lossRatePercent, referenceMetrics.lossRatePercent),
    totalReturnPercentagePoints: delta(liveLikeMetrics.totalReturnPercent, referenceMetrics.totalReturnPercent),
    profitFactorDelta: delta(liveLikeMetrics.profitFactor, referenceMetrics.profitFactor),
    expectancyDelta: delta(liveLikeMetrics.expectancy, referenceMetrics.expectancy),
    maxDrawdownPercentagePoints: delta(liveLikeMetrics.maxDrawdownPercent, referenceMetrics.maxDrawdownPercent),
    averageHoldingDurationMsDelta: delta(liveLikeMetrics.averageHoldingDurationMs, referenceMetrics.averageHoldingDurationMs),
    feeCostDelta: delta(liveLikeMetrics.feeCost, referenceMetrics.feeCost),
    slippageCostDelta: delta(liveLikeMetrics.slippageCost, referenceMetrics.slippageCost),
    spreadCostDelta: delta(liveLikeMetrics.spreadCost, referenceMetrics.spreadCost),
    fundingCostDelta: delta(liveLikeMetrics.fundingCost, referenceMetrics.fundingCost),
    tradeCountDelta: delta(liveLikeMetrics.tradeCount, referenceMetrics.tradeCount),
  });
}

function regimeGaps(referenceMetrics, liveLikeMetrics) {
  if (!referenceMetrics || !liveLikeMetrics) return Object.freeze({});
  const result = {};
  for (const regime of Object.keys(referenceMetrics.regimes ?? {})) {
    if (!liveLikeMetrics.regimes?.[regime]) continue;
    result[regime] = metricGap(referenceMetrics.regimes[regime], liveLikeMetrics.regimes[regime]);
  }
  return Object.freeze(result);
}

function normalizeValidation(input = {}) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) fail("INVALID_VALIDATION", "validation must be an object");
  return Object.freeze({
    rejected: input.rejected === true,
    oosValidated: input.oosValidated === true,
    walkForwardValidated: input.walkForwardValidated === true,
    finalHoldoutValidated: input.finalHoldoutValidated === true,
    paperValidated: input.paperValidated === true,
    shadowValidated: input.shadowValidated === true,
  });
}

function assertSafety(input) {
  const safety = { ...SAFETY_CONTRACT, ...(input ?? {}) };
  for (const [key, expected] of Object.entries(SAFETY_CONTRACT)) {
    if (safety[key] !== expected) fail("UNSAFE_RESEARCH_CONTRACT", `${key} must remain ${expected}`, { key, actual: safety[key] });
  }
  return Object.freeze({
    ...safety,
    livePromotionAllowed: false,
    actualOrderCount: 0,
    privateTradingApiCalls: 0,
  });
}

function deriveResearchStatus(validation, stages) {
  if (validation.rejected) return RESEARCH_STATUSES.REJECTED;
  const paperReady = validation.oosValidated
    && validation.walkForwardValidated
    && validation.finalHoldoutValidated
    && validation.paperValidated
    && validation.shadowValidated
    && stages.paper?.metrics?.status === "available"
    && stages.shadow?.metrics?.status === "available";
  if (paperReady) return RESEARCH_STATUSES.PAPER_VALIDATED;
  if (validation.walkForwardValidated) return RESEARCH_STATUSES.WF_VALIDATED;
  if (validation.oosValidated) return RESEARCH_STATUSES.OOS_VALIDATED;
  return RESEARCH_STATUSES.RESEARCHING;
}

function normalizeProvenance(input = {}) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) fail("INVALID_PROVENANCE", "provenance must be an object");
  return Object.freeze({
    generatedAt: optionalText(input.generatedAt, "provenance.generatedAt"),
    researchCodeSha: input.researchCodeSha == null ? null : normalizeHash(input.researchCodeSha, "provenance.researchCodeSha", [40, 64]),
    comparisonSchemaVersion: nonEmptyString(input.comparisonSchemaVersion ?? "integrated-research-v1", "provenance.comparisonSchemaVersion"),
  });
}

export function buildIntegratedResearchArtifact(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("INVALID_ARTIFACT_INPUT", "integrated research input must be an object");
  const identity = normalizeStrategyIdentity(input.identity);
  const safety = assertSafety(input.safety);
  const provenance = normalizeProvenance(input.provenance);
  if (provenance.researchCodeSha !== null && provenance.researchCodeSha !== identity.researchCodeSha) {
    fail("RESEARCH_CODE_SHA_MISMATCH", "provenance researchCodeSha must match strategy identity", {
      identity: identity.researchCodeSha,
      provenance: provenance.researchCodeSha,
    });
  }
  const stages = Object.freeze({
    backtest: normalizeStage(input.backtest, "backtest", identity),
    oos: normalizeStage(input.oos, "oos", identity),
    walkForward: normalizeStage(input.walkForward, "walkForward", identity),
    holdout: normalizeStage(input.holdout, "holdout", identity),
    paper: normalizeStage(input.paper, "paper", identity),
    shadow: normalizeStage(input.shadow, "shadow", identity),
  });
  const validation = normalizeValidation(input.validation);
  const backtestMetrics = stages.backtest?.metrics ?? null;
  const holdoutMetrics = stages.holdout?.metrics ?? null;
  const paperMetrics = stages.paper?.metrics ?? null;
  const shadowMetrics = stages.shadow?.metrics ?? null;
  const status = deriveResearchStatus(validation, stages);

  return Object.freeze({
    schemaVersion: "integrated-research-v1",
    identity,
    status,
    stages,
    gaps: Object.freeze({
      backtestVsPaper: metricGap(backtestMetrics, paperMetrics),
      backtestVsShadow: metricGap(backtestMetrics, shadowMetrics),
      holdoutVsPaper: metricGap(holdoutMetrics, paperMetrics),
      paperVsShadow: metricGap(paperMetrics, shadowMetrics),
      byRegime: Object.freeze({
        backtestVsPaper: regimeGaps(backtestMetrics, paperMetrics),
        backtestVsShadow: regimeGaps(backtestMetrics, shadowMetrics),
        paperVsShadow: regimeGaps(paperMetrics, shadowMetrics),
      }),
    }),
    validation,
    safety,
    provenance,
    promotion: Object.freeze({
      paperValidated: status === RESEARCH_STATUSES.PAPER_VALIDATED,
      livePromotionAllowed: false,
      livePromotionRequiresSeparateUserApproval: true,
    }),
  });
}

export function summarizeIntegratedResearchArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) fail("INVALID_ARTIFACT_LIST", "artifacts must be an array");
  const normalized = artifacts.map((artifact, index) => {
    if (!artifact || artifact.schemaVersion !== "integrated-research-v1" || !artifact.identity) {
      fail("INVALID_ARTIFACT", `artifacts[${index}] is not an integrated research artifact`);
    }
    return artifact;
  });
  const byStatus = {};
  for (const artifact of normalized) byStatus[artifact.status] = (byStatus[artifact.status] ?? 0) + 1;
  return Object.freeze({
    schemaVersion: "integrated-research-summary-v1",
    strategies: normalized.length,
    byStatus: Object.freeze(byStatus),
    paperValidated: normalized.filter((artifact) => artifact.status === RESEARCH_STATUSES.PAPER_VALIDATED).length,
    livePromotionAllowed: false,
    actualOrderCount: 0,
    privateTradingApiCalls: 0,
  });
}

export { RESEARCH_STATUSES, SAFETY_CONTRACT };
