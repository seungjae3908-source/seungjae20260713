import { createHash } from "node:crypto";

const BUNDLE_VERSION = "scanner-paper-admission-evidence-bundle-v1";
const DEFAULT_MAX_EVIDENCE_AGE_MS = 30_000;
const COST_FIELDS = Object.freeze([
  ["commission", "commissionRate"],
  ["tax", "taxRate"],
  ["spread", "spreadRate"],
  ["slippage", "slippageRate"],
  ["funding", "fundingRate"],
  ["latency", "latencyRate"],
  ["liquidityImpact", "liquidityImpactRate"],
  ["partialFillImpact", "partialFillImpactRate"],
]);

function freeze(value) { return Object.freeze(value); }
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function positive(value) { return finite(value) && value > 0; }
function nonNegative(value) { return finite(value) && value >= 0; }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function immutableSha(value) { return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value); }
function digest64(value) { return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value); }
function closeEnough(left, right, tolerance = 1e-12) { return Math.abs(left - right) <= tolerance; }

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digest(value) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function safeEnvelope(value) {
  return value?.executionAuthority === "NONE"
    && value?.simulatedOnly === true
    && value?.liveOrderAllowed === false
    && value?.privateTradingApiAllowed === false
    && value?.orderSubmitted === false
    && value?.exchangeRequestSent === false
    && value?.productionMutationAllowed === false;
}

function candidateSafety(value) {
  return value?.executionAuthority === "NONE"
    && value?.liveOrderAllowed === false
    && value?.privateTradingApiAllowed === false
    && value?.orderSubmitted === false
    && value?.exchangeRequestSent === false;
}

function add(blockers, code, condition = true) {
  if (condition && !blockers.includes(code)) blockers.push(code);
}

function parseIso(value) {
  if (!nonEmpty(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function result(status, blockers, candidate = null, evidenceDigest = null) {
  return freeze({
    schemaVersion: "canonical-paper-admission-bridge-v1",
    status,
    blockers: freeze([...new Set(blockers)]),
    candidate,
    evidenceDigest,
    bridgeReady: status === "BRIDGE_READY",
    sampleExecutionReady: false,
    sampleExecutionBlockers: freeze([
      "CANONICAL_EXECUTION_POLICY_REQUIRED",
      "CANONICAL_MARKET_ADAPTER_IDENTITY_REQUIRED",
      "SIMULATED_ORDER_REQUIRED",
    ]),
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
    profitabilityClaimAllowed: false,
  });
}

function validateBundleDigest(bundle, blockers) {
  if (!digest64(bundle?.evidenceDigest)) {
    add(blockers, "ADMISSION_EVIDENCE_DIGEST_REQUIRED");
    return;
  }
  const { evidenceDigest, ...payload } = bundle;
  if (digest(payload) !== evidenceDigest) add(blockers, "ADMISSION_EVIDENCE_DIGEST_MISMATCH");
}

function validateCandidateIdentity(candidate, nowMs, blockers) {
  const signal = candidate?.signal;
  const identity = signal?.strategyIdentity;
  if (!signal || !nonEmpty(signal.signalId) || !nonEmpty(signal.market) || !nonEmpty(signal.symbol)) {
    add(blockers, "CANONICAL_PAPER_IDENTITY_REQUIRED");
    return;
  }
  if (!candidateSafety(candidate)) add(blockers, "CANONICAL_PAPER_SAFETY_ENVELOPE_INVALID");
  if (!nonEmpty(signal.timeframe) || !Number.isInteger(signal.horizon) || signal.horizon <= 0) add(blockers, "CANONICAL_PAPER_HORIZON_REQUIRED");
  if (!positive(signal.timestampMs) || !positive(signal.ttlMs) || !positive(signal.expiresAtMs)
    || signal.expiresAtMs !== signal.timestampMs + signal.ttlMs) add(blockers, "CANONICAL_PAPER_LIFETIME_INVALID");
  else {
    if (signal.timestampMs > nowMs) add(blockers, "CANONICAL_PAPER_FROM_FUTURE");
    if (nowMs >= signal.expiresAtMs) add(blockers, "CANONICAL_PAPER_EXPIRED");
  }
  if (!identity || !nonEmpty(identity.strategyId) || !nonEmpty(identity.strategyVersion)
    || !nonEmpty(identity.parameterHash) || !immutableSha(identity.researchCodeSha)
    || !nonEmpty(identity.costPolicyVersion)) add(blockers, "CANONICAL_STRATEGY_IDENTITY_REQUIRED");
}

function validateLearning(bundle, blockers) {
  const signal = bundle?.paperCandidate?.signal;
  const learning = bundle?.learningSnapshot;
  if (!learning || learning.immutable !== true || learning.executionAuthority !== "NONE") {
    add(blockers, "LEARNING_SNAPSHOT_NOT_IMMUTABLE");
    return;
  }
  if (learning.signalId !== signal?.signalId) add(blockers, "LEARNING_SIGNAL_ID_MISMATCH");
  if (learning.market !== signal?.market) add(blockers, "LEARNING_MARKET_MISMATCH");
  if (learning.symbol !== signal?.symbol) add(blockers, "LEARNING_SYMBOL_MISMATCH");
  if (learning.strategyProfileVersion !== signal?.strategyIdentity?.strategyVersion) add(blockers, "LEARNING_STRATEGY_VERSION_MISMATCH");
  if (learning.direction !== signal?.direction) add(blockers, "LEARNING_DIRECTION_MISMATCH");
  if (!Array.isArray(learning.timeframes) || !learning.timeframes.includes(signal?.timeframe)) add(blockers, "LEARNING_TIMEFRAME_MISMATCH");
  const timestampMs = parseIso(learning.timestamp);
  if (timestampMs !== signal?.timestampMs) add(blockers, "LEARNING_TIMESTAMP_MISMATCH");
  const dataTimestampMs = parseIso(learning.dataTimestamp);
  if (dataTimestampMs == null || (timestampMs != null && dataTimestampMs > timestampMs)) add(blockers, "LEARNING_DATA_TIMESTAMP_INVALID");
  if (!Array.isArray(learning.dataProvenance) || learning.dataProvenance.length === 0
    || learning.dataProvenance.some((source) => !nonEmpty(source))) add(blockers, "LEARNING_DATA_PROVENANCE_REQUIRED");
}

function validateRisk(bundle, nowMs, maxEvidenceAgeMs, blockers) {
  const risk = bundle?.riskEvidence;
  if (!risk || risk.status !== "APPROVED" || risk.source !== "TRADING_RISK_ENGINE"
    || risk.simulatedOnly !== true || risk.allowed !== true || risk.executionAuthority !== "NONE") {
    add(blockers, "RISK_EVIDENCE_NOT_APPROVED");
    return;
  }
  if (!Array.isArray(risk.blockCodes) || risk.blockCodes.length !== 0) add(blockers, "RISK_EVIDENCE_HAS_BLOCKERS");
  if (!positive(risk.recommendedQuantity)) add(blockers, "RISK_RECOMMENDED_QUANTITY_REQUIRED");
  if (!positive(risk.evaluatedAtMs)) add(blockers, "RISK_EVIDENCE_TIMESTAMP_INVALID");
  else if (risk.evaluatedAtMs > nowMs) add(blockers, "RISK_EVIDENCE_FROM_FUTURE");
  else if (nowMs - risk.evaluatedAtMs > maxEvidenceAgeMs) add(blockers, "RISK_EVIDENCE_STALE");
}

function validateExecution(bundle, nowMs, maxEvidenceAgeMs, blockers) {
  const signal = bundle?.paperCandidate?.signal;
  const identity = signal?.strategyIdentity;
  const execution = bundle?.executionEvidence;
  const data = execution?.dataEvidence;
  const policy = execution?.costPolicy;
  const provenance = execution?.costProvenance;

  if (!data || data.publicOnly !== true || data.dataQuality !== "READY") add(blockers, "EXECUTION_PUBLIC_READY_EVIDENCE_REQUIRED");
  if (!nonEmpty(data?.provider) || !nonEmpty(data?.provenance)) add(blockers, "EXECUTION_PROVENANCE_REQUIRED");
  if (!positive(data?.asOfMs)) add(blockers, "EXECUTION_TIMESTAMP_REQUIRED");
  else if (data.asOfMs > nowMs) add(blockers, "EXECUTION_EVIDENCE_FROM_FUTURE");
  else {
    const maxAgeMs = positive(data?.maxAgeMs) ? Math.min(data.maxAgeMs, maxEvidenceAgeMs) : null;
    if (maxAgeMs == null || nowMs - data.asOfMs > maxAgeMs) add(blockers, "EXECUTION_EVIDENCE_STALE");
  }
  if (!positive(data?.tickSize)) add(blockers, "EXECUTION_TICK_SIZE_REQUIRED");
  if (data?.privateApiUsed === true || data?.privateTradingApiAllowed === true || data?.liveOrderAllowed === true
    || data?.orderSubmitted === true || data?.exchangeRequestSent === true) add(blockers, "EXECUTION_SAFETY_VIOLATION");

  if (!policy || !nonEmpty(policy.version) || policy.version !== identity?.costPolicyVersion) add(blockers, "EXECUTION_COST_POLICY_IDENTITY_MISMATCH");
  if (policy?.source !== "SCANNER_COST_EVIDENCE_PERCENT_DIV_100" || policy?.unitConversion !== "PERCENT_DIV_100") {
    add(blockers, "EXECUTION_COST_UNIT_CONVERSION_INVALID");
  }
  if (!provenance || provenance.policyId !== identity?.costPolicyVersion) add(blockers, "EXECUTION_COST_PROVENANCE_IDENTITY_MISMATCH");
  if (!nonEmpty(provenance?.providerProvenance)) add(blockers, "EXECUTION_COST_PROVIDER_PROVENANCE_REQUIRED");

  for (const [componentName, policyField] of COST_FIELDS) {
    const rate = policy?.[policyField];
    const component = provenance?.components?.[componentName];
    if (!nonNegative(rate)) {
      add(blockers, `EXECUTION_COST_${componentName.toUpperCase()}_INVALID`);
      continue;
    }
    if (!component || !nonNegative(component.valuePercent)) {
      add(blockers, `EXECUTION_COST_${componentName.toUpperCase()}_PROVENANCE_REQUIRED`);
      continue;
    }
    if (!closeEnough(rate, component.valuePercent / 100)) add(blockers, `EXECUTION_COST_${componentName.toUpperCase()}_CONVERSION_MISMATCH`);
  }
}

export function resolveCanonicalPaperAdmissionBridgeCandidate({
  bundle,
  nowMs = Date.now(),
  maxEvidenceAgeMs = DEFAULT_MAX_EVIDENCE_AGE_MS,
} = {}) {
  const blockers = [];
  if (!positive(nowMs) || !positive(maxEvidenceAgeMs)) return result("BLOCKED", ["ADMISSION_BRIDGE_CLOCK_INVALID"]);
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return result("BLOCKED", ["ADMISSION_EVIDENCE_BUNDLE_REQUIRED"]);
  if (bundle.schemaVersion !== BUNDLE_VERSION) add(blockers, "ADMISSION_EVIDENCE_SCHEMA_UNSUPPORTED");
  if (!safeEnvelope(bundle)) add(blockers, "ADMISSION_EVIDENCE_SAFETY_ENVELOPE_INVALID");

  validateBundleDigest(bundle, blockers);
  validateCandidateIdentity(bundle.paperCandidate, nowMs, blockers);
  validateLearning(bundle, blockers);
  validateRisk(bundle, nowMs, maxEvidenceAgeMs, blockers);
  validateExecution(bundle, nowMs, maxEvidenceAgeMs, blockers);

  if (blockers.length > 0) return result("BLOCKED", blockers, null, bundle.evidenceDigest ?? null);

  const signal = deepFreeze({
    ...clone(bundle.paperCandidate.signal),
    learningSnapshot: clone(bundle.learningSnapshot),
  });
  const candidate = deepFreeze({
    ...clone(bundle.paperCandidate),
    signal,
    riskEvidence: clone(bundle.riskEvidence),
    execution: {
      dataEvidence: clone(bundle.executionEvidence.dataEvidence),
      costPolicy: clone(bundle.executionEvidence.costPolicy),
      strategyIdentity: clone(bundle.paperCandidate.signal.strategyIdentity),
    },
    admissionEvidence: {
      schemaVersion: bundle.schemaVersion,
      evidenceDigest: bundle.evidenceDigest,
      crossRuntimeVerified: true,
    },
    sampleExecutionReady: false,
    sampleExecutionBlockers: [
      "CANONICAL_EXECUTION_POLICY_REQUIRED",
      "CANONICAL_MARKET_ADAPTER_IDENTITY_REQUIRED",
      "SIMULATED_ORDER_REQUIRED",
    ],
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
  });
  return result("BRIDGE_READY", [], candidate, bundle.evidenceDigest);
}

export function createCanonicalPaperAdmissionBridgeForCard({
  bundleForCard,
  now = () => Date.now(),
  maxEvidenceAgeMs = DEFAULT_MAX_EVIDENCE_AGE_MS,
} = {}) {
  if (typeof bundleForCard !== "function") throw new TypeError("bundleForCard is required");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  return async function admissionBridgeForCard(card, selectedMarket) {
    const bundle = await bundleForCard(card, selectedMarket);
    const resolved = resolveCanonicalPaperAdmissionBridgeCandidate({ bundle, nowMs: now(), maxEvidenceAgeMs });
    if (resolved.status !== "BRIDGE_READY" || resolved.candidate?.signal?.market !== selectedMarket) {
      return result("BLOCKED", resolved.blockers.length ? resolved.blockers : ["ADMISSION_BRIDGE_MARKET_MISMATCH"], null, resolved.evidenceDigest);
    }
    return resolved;
  };
}
