import { resolveForwardCalibrationProfitInput } from "./forward-calibration-profit-input-v1.js";

const COST_QUALITY = new Set(["OBSERVED", "DOCUMENTED", "ESTIMATED", "NOT_APPLICABLE"]);
const COST_COMPONENTS = Object.freeze([
  ["commission", "commissionPercent"],
  ["tax", "taxPercent"],
  ["spread", "spreadPercent"],
  ["slippage", "slippagePercent"],
  ["funding", "fundingPercent"],
  ["latency", "latencyPercent"],
  ["liquidityImpact", "liquidityImpactPercent"],
  ["partialFillImpact", "partialFillImpactPercent"],
]);
const DEFAULT_MAX_COST_EVIDENCE_AGE_MS = 30_000;

function freeze(value) { return Object.freeze(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function finiteNonNegative(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function positiveTimestamp(value) { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function closeEnough(left, right, tolerance = 1e-12) { return Math.abs(left - right) <= tolerance; }

function missingProfitInput(calibrationInput = null, featureParity = null) {
  const calibration = calibrationInput?.calibration ?? {};
  return freeze({
    probabilities: freeze({
      tp: calibrationInput?.probabilities?.tp ?? null,
      sl: calibrationInput?.probabilities?.sl ?? null,
      expire: calibrationInput?.probabilities?.expire ?? null,
    }),
    returns: freeze({
      target: calibrationInput?.returns?.target ?? null,
      stop: calibrationInput?.returns?.stop ?? null,
      expire: calibrationInput?.returns?.expire ?? null,
    }),
    costs: freeze({ status: "MISSING", components: freeze({}) }),
    calibration: freeze({
      status: nonEmpty(calibration.status) ? calibration.status : "INSUFFICIENT_SAMPLE",
      sampleSize: Number.isInteger(calibration.sampleSize) && calibration.sampleSize >= 0 ? calibration.sampleSize : 0,
      tpFirstCount: Number.isInteger(calibration.tpFirstCount) && calibration.tpFirstCount >= 0 ? calibration.tpFirstCount : 0,
    }),
    ...(featureParity ? { featureParity } : {}),
  });
}

function candidateIdentity(candidate) {
  const signal = candidate?.signal;
  const strategy = signal?.strategyIdentity;
  if (!signal || !strategy || !nonEmpty(strategy.costPolicyVersion)) return null;
  return freeze({
    strategyId: strategy.strategyId,
    strategyVersion: strategy.strategyVersion,
    parameterHash: strategy.parameterHash,
    researchCodeSha: strategy.researchCodeSha,
    market: signal.market,
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    horizon: signal.horizon,
    direction: signal.direction,
    costPolicyVersion: strategy.costPolicyVersion,
  });
}

function safeCostEnvelope(costEvidence) {
  return costEvidence?.executionAuthority === "NONE"
    && costEvidence?.orderSubmitted === false
    && costEvidence?.exchangeRequestSent === false
    && costEvidence?.privateApiUsed === false
    && costEvidence?.liveTrading === false;
}

function blockedCostEvidence(blockers) {
  return freeze({
    status: "MISSING",
    blockers: freeze([...new Set(blockers)]),
    costs: freeze({ status: "MISSING", components: freeze({}) }),
  });
}

/**
 * Consumes the JSON-safe output of api-server's #322
 * buildScannerTradingCostPolicy() contract. API cost fields are percentages
 * (for example 0.10 means 0.10%), while Meaningful Search returns/costs use
 * return ratios (0.001 means 0.10%). Conversion is therefore explicitly /100.
 */
export function resolveCanonicalPaperCostInput({
  costEvidence,
  paperCandidate,
  nowMs = Date.now(),
  maxCostEvidenceAgeMs = DEFAULT_MAX_COST_EVIDENCE_AGE_MS,
} = {}) {
  const blockers = [];
  const identity = candidateIdentity(paperCandidate);
  if (!identity) blockers.push("CANONICAL_COST_IDENTITY_REQUIRED");
  if (costEvidence?.status !== "READY") blockers.push("COST_EVIDENCE_NOT_READY");
  if (Array.isArray(costEvidence?.blockers) && costEvidence.blockers.length > 0) blockers.push("COST_EVIDENCE_HAS_BLOCKERS");
  if (!safeCostEnvelope(costEvidence)) blockers.push("COST_EVIDENCE_SAFETY_INVALID");
  if (!positiveTimestamp(nowMs)) blockers.push("COST_EVIDENCE_NOW_INVALID");
  if (!Number.isInteger(maxCostEvidenceAgeMs) || maxCostEvidenceAgeMs < 1) blockers.push("COST_EVIDENCE_MAX_AGE_INVALID");

  const policy = costEvidence?.policy;
  const provenance = costEvidence?.provenance;
  if (!policy || policy.source !== "EXPLICIT_RUNTIME_POLICY") blockers.push("EXPLICIT_RUNTIME_COST_POLICY_REQUIRED");
  if (!provenance || typeof provenance !== "object") blockers.push("COST_PROVENANCE_REQUIRED");

  if (identity && policy) {
    if (policy.market !== identity.market) blockers.push("COST_POLICY_MARKET_MISMATCH");
    if (!nonEmpty(policy.id) || policy.id !== identity.costPolicyVersion) blockers.push("COST_POLICY_IDENTITY_MISMATCH");
  }
  if (identity && provenance) {
    if (provenance.market !== identity.market) blockers.push("COST_PROVENANCE_MARKET_MISMATCH");
    if (!nonEmpty(provenance.policyId) || provenance.policyId !== identity.costPolicyVersion) blockers.push("COST_PROVENANCE_POLICY_MISMATCH");
    if (!nonEmpty(provenance.providerProvenance)) blockers.push("COST_PROVIDER_PROVENANCE_REQUIRED");
  }
  if (policy && provenance && provenance.policyId !== policy.id) blockers.push("COST_POLICY_PROVENANCE_ID_MISMATCH");

  const ratioComponents = {};
  for (const [name, policyField] of COST_COMPONENTS) {
    const policyValue = policy?.[policyField];
    const component = provenance?.components?.[name];
    if (!finiteNonNegative(policyValue)) {
      blockers.push(`COST_${name.toUpperCase()}_INVALID`);
      continue;
    }
    if (!component || !finiteNonNegative(component.valuePercent)) {
      blockers.push(`COST_${name.toUpperCase()}_PROVENANCE_REQUIRED`);
      continue;
    }
    if (!closeEnough(component.valuePercent, policyValue)) blockers.push(`COST_${name.toUpperCase()}_VALUE_MISMATCH`);
    if (!COST_QUALITY.has(component.quality)) blockers.push(`COST_${name.toUpperCase()}_QUALITY_INVALID`);
    if (!nonEmpty(component.source)) blockers.push(`COST_${name.toUpperCase()}_SOURCE_REQUIRED`);
    if (!positiveTimestamp(component.observedAtMs)) blockers.push(`COST_${name.toUpperCase()}_TIMESTAMP_INVALID`);
    else if (positiveTimestamp(nowMs) && component.observedAtMs > nowMs) blockers.push(`COST_${name.toUpperCase()}_FROM_FUTURE`);
    else if (positiveTimestamp(nowMs) && Number.isInteger(maxCostEvidenceAgeMs)
      && nowMs - component.observedAtMs > maxCostEvidenceAgeMs) blockers.push(`COST_${name.toUpperCase()}_STALE`);
    if (component.quality === "NOT_APPLICABLE" && component.valuePercent !== 0) blockers.push(`COST_${name.toUpperCase()}_NOT_APPLICABLE_NONZERO`);
    ratioComponents[name] = policyValue / 100;
  }

  if (blockers.length > 0) return blockedCostEvidence(blockers);
  return freeze({
    status: "READY",
    blockers: freeze([]),
    costs: freeze({
      status: "READY",
      unit: "RETURN_RATIO",
      sourceUnit: "PERCENT",
      conversion: "PERCENT_DIV_100",
      costPolicyId: policy.id,
      components: freeze({ ...ratioComponents }),
      provenance: freeze({
        providerProvenance: provenance.providerProvenance,
        paperCostPolicyVersion: provenance.paperCostPolicyVersion ?? null,
        taxPolicyVersion: provenance.taxPolicyVersion ?? null,
      }),
    }),
  });
}

function featureParityForMarket(market, featureParity) {
  if (market !== "CRYPTO_FUTURES") return freeze({ pass: true });
  const valid = featureParity?.pass === true
    && Array.isArray(featureParity.allowedFeatures)
    && Array.isArray(featureParity.blockedFeatures)
    && featureParity.blockedFeatures.length === 0;
  if (!valid) {
    return freeze({
      pass: false,
      allowedFeatures: freeze(Array.isArray(featureParity?.allowedFeatures) ? [...featureParity.allowedFeatures] : []),
      blockedFeatures: freeze(Array.isArray(featureParity?.blockedFeatures) ? [...featureParity.blockedFeatures] : ["FEATURE_PARITY_EVIDENCE_MISSING"]),
    });
  }
  return freeze({
    pass: true,
    allowedFeatures: freeze([...featureParity.allowedFeatures]),
    blockedFeatures: freeze([]),
  });
}

function result(status, blockers, identity, profitInput, costEvidenceStatus) {
  return freeze({
    schemaVersion: "canonical-paper-profit-input-composer-v1",
    status,
    blockers: freeze([...new Set(blockers)]),
    identity,
    profitInput,
    costEvidenceStatus,
    executionAuthority: "NONE",
    financialMutationAllowed: false,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    profitabilityClaimAllowed: false,
  });
}

export function composeCanonicalPaperProfitInput({
  paperCandidate,
  calibration,
  costEvidence,
  featureParity = null,
  nowMs = Date.now(),
  maxCostEvidenceAgeMs = DEFAULT_MAX_COST_EVIDENCE_AGE_MS,
} = {}) {
  const calibrationResult = resolveForwardCalibrationProfitInput({ calibration, paperCandidate });
  const identity = calibrationResult.identity ?? candidateIdentity(paperCandidate);
  const market = identity?.market ?? paperCandidate?.signal?.market ?? null;
  const parity = featureParityForMarket(market, featureParity);
  const blockers = [...(calibrationResult.blockers ?? [])];

  if (market === "CRYPTO_FUTURES" && parity.pass !== true) blockers.push("FUTURES_FEATURE_PARITY_EVIDENCE_REQUIRED");
  if (calibrationResult.status !== "CALIBRATION_READY") {
    return result("NO_TRADE", blockers, identity, missingProfitInput(calibrationResult.profitInput, parity), "MISSING");
  }

  const cost = resolveCanonicalPaperCostInput({ costEvidence, paperCandidate, nowMs, maxCostEvidenceAgeMs });
  blockers.push(...cost.blockers);
  if (cost.status !== "READY" || blockers.length > 0) {
    return result("NO_TRADE", blockers, identity, missingProfitInput(calibrationResult.profitInput, parity), cost.status);
  }

  const profitInput = freeze({
    probabilities: calibrationResult.profitInput.probabilities,
    returns: calibrationResult.profitInput.returns,
    costs: cost.costs,
    calibration: calibrationResult.profitInput.calibration,
    featureParity: parity,
  });
  return result("PROFIT_INPUT_READY", [], identity, profitInput, "READY");
}

/**
 * Adapter seam for #512 runCanonicalMeaningfulSearchPaperMarket(). It does not
 * fetch data or invent evidence. Callers must supply authoritative resolvers.
 */
export function createCanonicalPaperProfitInputForCard({
  calibrationForCard,
  costEvidenceForCard,
  featureParityForCard = null,
  now = () => Date.now(),
  maxCostEvidenceAgeMs = DEFAULT_MAX_COST_EVIDENCE_AGE_MS,
} = {}) {
  if (typeof calibrationForCard !== "function") throw new TypeError("calibrationForCard is required");
  if (typeof costEvidenceForCard !== "function") throw new TypeError("costEvidenceForCard is required");
  if (featureParityForCard != null && typeof featureParityForCard !== "function") throw new TypeError("featureParityForCard must be a function");
  if (typeof now !== "function") throw new TypeError("now must be a function");

  return async function profitInputForCard(card, selectedMarket) {
    const paperCandidate = card?.paperCandidate && typeof card.paperCandidate === "object" ? card.paperCandidate : card;
    const market = paperCandidate?.signal?.market ?? null;
    if (market !== selectedMarket) {
      return missingProfitInput(null, featureParityForMarket(selectedMarket, null));
    }
    const calibration = await calibrationForCard(card, selectedMarket, paperCandidate);
    const costEvidence = await costEvidenceForCard(card, selectedMarket, paperCandidate);
    const featureParity = featureParityForCard == null
      ? null
      : await featureParityForCard(card, selectedMarket, paperCandidate);
    return composeCanonicalPaperProfitInput({
      paperCandidate,
      calibration,
      costEvidence,
      featureParity,
      nowMs: now(),
      maxCostEvidenceAgeMs,
    }).profitInput;
  };
}
