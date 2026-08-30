import { createHash } from "node:crypto";
import { PAPER_FORWARD_PROVIDER_AUTHORITY } from "./paper-public-provider-authority-v1.js";

export const NATURAL_PAPER_POSITION_SETTLEMENT_LIFECYCLE_VERSION =
  "natural-paper-position-settlement-lifecycle-v1";

const OPEN = "OPEN";
const NATURAL_FORWARD = "NATURAL_FORWARD";
const TEST_ONLY = "TEST_ONLY";
const MISSING_EVIDENCE = "MISSING_EVIDENCE";

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value) {
  return finite(value) && value > 0;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function immutableSha(value) {
  return nonEmpty(value) && /^[0-9a-f]{40}$/iu.test(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function safetyEnvelope() {
  return Object.freeze({
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
    executionAuthority: "NONE",
  });
}

function timeframeMs(timeframe) {
  const match = typeof timeframe === "string" ? /^(\d+)(m|h|d)$/iu.exec(timeframe.trim()) : null;
  if (!match) return null;
  const unit = match[2].toLowerCase();
  const multiplier = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return Number(match[1]) * multiplier;
}

function exactExitHorizon(sample, candidate) {
  const explicit = candidate?.signal?.expiresAtMs;
  if (explicit != null && (!Number.isSafeInteger(explicit) || explicit <= sample.identity.evaluatedAtMs)) {
    throw new Error("PAPER_POSITION_EXIT_HORIZON_INVALID");
  }
  if (Number.isSafeInteger(explicit) && explicit > sample.identity.evaluatedAtMs) {
    return Object.freeze({ expiresAtMs: explicit, source: "signal.expiresAtMs" });
  }
  const intervalMs = timeframeMs(sample.identity.timeframe);
  if (!Number.isSafeInteger(intervalMs) || !Number.isSafeInteger(sample.identity.horizon)) {
    return Object.freeze({ expiresAtMs: null, source: MISSING_EVIDENCE });
  }
  return Object.freeze({
    expiresAtMs: sample.identity.evaluatedAtMs + (intervalMs * sample.identity.horizon),
    source: "immutable sample timeframe x horizon",
  });
}

function optionalCanonicalPrice(value, field) {
  if (value == null) return null;
  if (!positive(value)) throw new Error(`PAPER_POSITION_${field}_INVALID`);
  return value;
}

function normalizeSampleClass(candidate) {
  const evidence = candidate?.naturalEvidence;
  if (candidate?.testOnly === true || evidence?.provenanceClass === TEST_ONLY) return TEST_ONLY;
  if (evidence?.provenanceClass === NATURAL_FORWARD
    && evidence.synthetic === false
    && evidence.replay === false
    && evidence.testOnly === false
    && evidence.backfill === false
    && evidence.historical === false
    && evidence.duplicate === false
    && nonEmpty(evidence.observationId)
    && nonEmpty(evidence.source)
    && finite(evidence.observedAtMs)) return NATURAL_FORWARD;
  return MISSING_EVIDENCE;
}

function canonicalRiskPolicyIdentity(candidate, researchCodeSha) {
  const value = candidate?.riskPolicyIdentity ?? candidate?.riskEvidence?.policyIdentity;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!nonEmpty(value.policyId)
    || !nonEmpty(value.policyVersion)
    || !nonEmpty(value.source)
    || !immutableSha(value.researchCodeSha)
    || value.researchCodeSha.toLowerCase() !== researchCodeSha.toLowerCase()) return null;
  return Object.freeze({
    policyId: value.policyId,
    policyVersion: value.policyVersion,
    source: value.source,
    researchCodeSha: value.researchCodeSha.toLowerCase(),
  });
}

function sameRiskPolicyIdentity(left, right) {
  return Boolean(left && right
    && left.policyId === right.policyId
    && left.policyVersion === right.policyVersion
    && left.source === right.source
    && String(left.researchCodeSha ?? "").toLowerCase() === String(right.researchCodeSha ?? "").toLowerCase());
}

function jsonDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateNaturalHandoff(position, observation, state, cycle) {
  if (position.lifecycle.sampleEligibility.provenanceClass !== NATURAL_FORWARD) return;
  const handoff = observation?.schedulerHandoff;
  if (!handoff || handoff.schemaVersion !== "paper-scheduler-position-observation-handoff-v1"
    || handoff.executionAuthority !== "NONE"
    || handoff.naturalSampleCreditAuthority !== "IDENTITY_GATES_PASSED") {
    throw new Error("PAPER_POSITION_OBSERVATION_HANDOFF_IDENTITY_MISSING");
  }
  if (observationSampleClass(observation) !== NATURAL_FORWARD) {
    throw new Error("PAPER_POSITION_OBSERVATION_GENUINE_PROVENANCE_REQUIRED");
  }
  const expectedPosition = positionIdentity(position);
  for (const [key, value] of Object.entries(expectedPosition)) {
    if (handoff.positionIdentity?.[key] !== value || observation[key] !== value) {
      throw new Error("PAPER_POSITION_OBSERVATION_POSITION_IDENTITY_MISMATCH");
    }
  }
  const currentCycle = handoff.cycleIdentity;
  const cyclePayload = {
    cycleId: cycle?.cycleId,
    identityFingerprint: state?.identityFingerprint,
    scheduledAtMs: currentCycle?.scheduledAtMs,
    startedAtMs: currentCycle?.startedAtMs,
  };
  if (!nonEmpty(cyclePayload.cycleId) || !nonEmpty(cyclePayload.identityFingerprint)
    || !Number.isSafeInteger(cyclePayload.scheduledAtMs) || !Number.isSafeInteger(cyclePayload.startedAtMs)
    || cyclePayload.scheduledAtMs > cyclePayload.startedAtMs || cyclePayload.startedAtMs > cycle.evaluatedAtMs
    || currentCycle?.cycleId !== cyclePayload.cycleId
    || currentCycle.identityFingerprint !== cyclePayload.identityFingerprint
    || currentCycle.identityDigest !== jsonDigest(cyclePayload)
    || observation.cycleIdentityDigest !== currentCycle.identityDigest) {
    throw new Error("PAPER_POSITION_OBSERVATION_CYCLE_IDENTITY_MISMATCH");
  }
  const binding = state?.ledger?.accountBinding;
  if (!binding || !nonEmpty(binding.accountId) || !immutableSha(binding.sourceSha)
    || !/^[0-9a-f]{64}$/iu.test(binding.publisherAccountIdSha256 ?? "")) {
    throw new Error("PAPER_POSITION_OBSERVATION_ACCOUNT_IDENTITY_MISSING");
  }
  const accountPayload = {
    publisherAccountIdSha256: binding.publisherAccountIdSha256.toLowerCase(),
    sourceSha: binding.sourceSha.toLowerCase(),
    accountIdSha256: createHash("sha256").update(binding.accountId).digest("hex"),
  };
  const accountDigest = jsonDigest(accountPayload);
  const reservations = state.ledger.reservations?.filter((row) => row.status === OPEN
    && row.positionId === position.positionId && row.paperSampleId === position.paperSampleId);
  if (reservations?.length !== 1 || handoff.accountIdentity?.identityDigest !== accountDigest
    || observation.accountIdentityDigest !== accountDigest
    || Object.entries(accountPayload).some(([key, value]) => handoff.accountIdentity[key] !== value)) {
    throw new Error("PAPER_POSITION_OBSERVATION_ACCOUNT_IDENTITY_MISMATCH");
  }
  const entry = position.sample.entryEvidenceProvenance;
  if (!entry || hash(handoff.entryProvenance) !== hash(entry)
    || observation.entryEvidenceDigest !== entry.evidenceSnapshotDigest
    || position.lifecycle.entry.evidenceDigest !== entry.evidenceSnapshotDigest) {
    throw new Error("PAPER_POSITION_OBSERVATION_ENTRY_IDENTITY_MISMATCH");
  }
  const risk = position.lifecycle.riskPolicyIdentity;
  if (!sameRiskPolicyIdentity(risk, handoff.riskPolicyIdentity)
    || handoff.riskPolicyIdentity.identityDigest !== jsonDigest(risk)
    || observation.riskPolicyIdentityDigest !== jsonDigest(risk)) {
    throw new Error("PAPER_POSITION_OBSERVATION_RISK_POLICY_IDENTITY_MISMATCH");
  }
  if (handoff.costPolicyIdentity?.version !== position.costPolicyVersion
    || observation.costPolicyIdentity?.version !== position.costPolicyVersion) {
    throw new Error("PAPER_POSITION_OBSERVATION_COST_POLICY_IDENTITY_MISMATCH");
  }
}

function positionIdentity(position) {
  return Object.freeze({
    positionId: position.positionId,
    paperSampleId: position.paperSampleId,
    signalId: position.signalId,
    market: position.market,
    symbol: position.symbol,
    signalTimeframe: position.sample?.identity?.timeframe,
    horizon: position.sample?.identity?.horizon,
    direction: position.direction,
    strategyId: position.strategyId,
    strategyVersion: position.strategyVersion,
    parameterHash: position.parameterHash,
    researchCodeSha: position.researchCodeSha,
    costPolicyVersion: position.costPolicyVersion,
  });
}

function validatePositionIdentity(identity) {
  for (const key of [
    "positionId", "paperSampleId", "signalId", "market", "symbol", "direction",
    "strategyId", "strategyVersion", "parameterHash", "costPolicyVersion",
  ]) {
    if (!nonEmpty(identity?.[key])) throw new Error(`PAPER_POSITION_${key.toUpperCase()}_REQUIRED`);
  }
  if (!immutableSha(identity.researchCodeSha)) throw new Error("PAPER_POSITION_RESEARCH_SHA_REQUIRED");
  if (!positive(timeframeMs(identity.signalTimeframe)) || !Number.isSafeInteger(identity.horizon) || identity.horizon <= 0) {
    throw new Error("PAPER_POSITION_SIGNAL_HORIZON_REQUIRED");
  }
}

function immutableContractDigest(lifecycle) {
  return hash({
    identity: lifecycle.identity,
    strategyIdentity: lifecycle.strategyIdentity,
    riskPolicyIdentity: lifecycle.riskPolicyIdentity,
    riskPolicyIdentityStatus: lifecycle.riskPolicyIdentityStatus,
    modelIdentity: lifecycle.modelIdentity,
    modelIdentityStatus: lifecycle.modelIdentityStatus,
    entry: lifecycle.entry,
    exitPolicy: lifecycle.exitPolicy,
    sampleEligibility: lifecycle.sampleEligibility,
  });
}

function assertLifecycle(position) {
  const lifecycle = position?.lifecycle;
  if (lifecycle?.schemaVersion !== NATURAL_PAPER_POSITION_SETTLEMENT_LIFECYCLE_VERSION) {
    throw new Error("PAPER_POSITION_LIFECYCLE_REQUIRED");
  }
  const identity = positionIdentity(position);
  validatePositionIdentity(identity);
  if (lifecycle.status !== OPEN || position.lifecycleState !== OPEN) {
    throw new Error("PAPER_POSITION_NOT_OPEN");
  }
  if (lifecycle.identityDigest !== hash(identity)) throw new Error("PAPER_POSITION_IDENTITY_DIGEST_MISMATCH");
  if (lifecycle.immutableContractDigest !== immutableContractDigest(lifecycle)) {
    throw new Error("PAPER_POSITION_IMMUTABLE_CONTRACT_DIGEST_MISMATCH");
  }
  if (!positive(lifecycle.entry?.fillPrice) || !positive(lifecycle.entry?.quantity)) {
    throw new Error("PAPER_POSITION_ENTRY_FILL_INVALID");
  }
  if (!Number.isSafeInteger(lifecycle.entry?.timestampMs)) throw new Error("PAPER_POSITION_ENTRY_TIME_REQUIRED");
  if (lifecycle.entry.timestampMs !== position.entryTimestampMs
    || lifecycle.entry.fillPrice !== position.entryFillPrice
    || lifecycle.entry.quantity !== position.quantity
    || lifecycle.strategyIdentity.strategyId !== position.strategyId
    || lifecycle.strategyIdentity.strategyVersion !== position.strategyVersion
    || lifecycle.strategyIdentity.parameterHash !== position.parameterHash
    || lifecycle.strategyIdentity.researchCodeSha !== position.researchCodeSha.toLowerCase()) {
    throw new Error("PAPER_POSITION_IMMUTABLE_LINEAGE_MISMATCH");
  }
  if (lifecycle.sampleEligibility?.provenanceClass === NATURAL_FORWARD) {
    if (lifecycle.riskPolicyIdentityStatus !== "PRESENT"
      || !canonicalRiskPolicyIdentity({ riskPolicyIdentity: lifecycle.riskPolicyIdentity }, identity.researchCodeSha)) {
      throw new Error("PAPER_POSITION_RISK_POLICY_IDENTITY_REQUIRED");
    }
  }
  return lifecycle;
}

function priceRules(direction, exitPolicy, bar) {
  const long = direction === "BUY" || direction === "LONG";
  const short = direction === "SHORT";
  if (!long && !short) throw new Error("PAPER_POSITION_DIRECTION_UNSUPPORTED");

  const stop = exitPolicy.stopLossPrice;
  const targets = exitPolicy.takeProfitPrices.filter(positive);
  const stopHit = positive(stop) && (long ? bar.low <= stop : bar.high >= stop);
  const hitTargets = targets.filter((target) => long ? bar.high >= target : bar.low <= target);
  if (stopHit) return Object.freeze({ reason: "STOP_LOSS", type: "STOP_MARKET", price: stop });
  if (hitTargets.length > 0) {
    const price = long ? Math.min(...hitTargets) : Math.max(...hitTargets);
    return Object.freeze({ reason: "TAKE_PROFIT", type: "LIMIT", price });
  }
  return null;
}

function validateObservation(position, observation, evaluatedAtMs) {
  const identity = positionIdentity(position);
  if (!nonEmpty(observation?.observationId)) throw new Error("PAPER_POSITION_OBSERVATION_ID_REQUIRED");
  if (observation.positionId !== identity.positionId || observation.paperSampleId !== identity.paperSampleId) {
    throw new Error("PAPER_POSITION_OBSERVATION_POSITION_MISMATCH");
  }
  for (const key of ["market", "symbol", "direction", "strategyId", "strategyVersion", "parameterHash", "costPolicyVersion"]) {
    if (observation[key] !== identity[key]) throw new Error(`PAPER_POSITION_OBSERVATION_${key.toUpperCase()}_MISMATCH`);
  }
  if (!immutableSha(observation.researchCodeSha)
    || observation.researchCodeSha.toLowerCase() !== identity.researchCodeSha.toLowerCase()) {
    throw new Error("PAPER_POSITION_OBSERVATION_RESEARCH_SHA_MISMATCH");
  }
  if (observation.publicOnly !== true || !nonEmpty(observation.source) || !nonEmpty(observation.provenance)) {
    throw new Error("PAPER_POSITION_PUBLIC_PROVENANCE_REQUIRED");
  }
  if (!Number.isSafeInteger(observation.observedAtMs)
    || observation.observedAtMs <= position.entryTimestampMs
    || observation.observedAtMs > evaluatedAtMs) {
    throw new Error("PAPER_POSITION_OBSERVATION_TIME_INVALID");
  }
  if (!finite(observation.maxAgeMs) || observation.maxAgeMs <= 0
    || evaluatedAtMs - observation.observedAtMs > observation.maxAgeMs) {
    throw new Error("PAPER_POSITION_OBSERVATION_STALE");
  }
  const bar = observation.bar;
  if (!positive(bar?.open) || !positive(bar?.high) || !positive(bar?.low) || !positive(bar?.close)
    || bar.high < bar.low || bar.open > bar.high || bar.open < bar.low || bar.close > bar.high || bar.close < bar.low) {
    throw new Error("PAPER_POSITION_MARK_BAR_INVALID");
  }
  if (position?.lifecycle?.sampleEligibility?.provenanceClass === NATURAL_FORWARD) {
    const expectedRiskPolicy = position.lifecycle.riskPolicyIdentity;
    const observedRiskPolicy = observation?.schedulerHandoff?.riskPolicyIdentity;
    if (!sameRiskPolicyIdentity(expectedRiskPolicy, observedRiskPolicy)) {
      throw new Error("PAPER_POSITION_OBSERVATION_RISK_POLICY_IDENTITY_MISMATCH");
    }
    const frame = observation.closedFrame;
    const intervalMs = timeframeMs(observation.timeframe);
    const authority = PAPER_FORWARD_PROVIDER_AUTHORITY[position.market];
    const cursor = position.lifecycle.mark.lastObservedAtMs ?? position.entryTimestampMs;
    if (!authority || observation.source !== authority.provider || observation.timeframe !== authority.timeframe
      || observation.maxAgeMs !== authority.maxAgeMs || frame?.intervalMs !== authority.intervalMs
      || frame?.closeOffsetMs !== (authority.closeOffsetMs ?? authority.intervalMs)) {
      throw new Error("PAPER_POSITION_PUBLIC_PROVIDER_AUTHORITY_MISMATCH");
    }
    if (!frame || !Number.isSafeInteger(frame.openAtMs) || frame.closeAtMs !== observation.observedAtMs
      || !Number.isSafeInteger(intervalMs) || intervalMs <= 0 || frame.intervalMs !== intervalMs
      || frame.timeframe !== observation.timeframe || frame.provider !== observation.source
      || !positive(frame.closeOffsetMs) || frame.closeOffsetMs > intervalMs
      || frame.openAtMs + frame.closeOffsetMs !== frame.closeAtMs
      || frame.sourceDigest !== observation.sourceDigest || !/^[0-9a-f]{64}$/u.test(frame.sourceDigest ?? "")) {
      throw new Error("PAPER_POSITION_CLOSED_FRAME_PROVENANCE_REQUIRED");
    }
    if (!position.lifecycle.pendingExit) {
      if (frame.openAtMs < cursor) throw new Error("PAPER_POSITION_OBSERVATION_PARTIAL_FRAME_AT_CURSOR");
      if (position.market.startsWith("CRYPTO_") && frame.openAtMs !== cursor) {
        throw new Error("PAPER_POSITION_OBSERVATION_INTERVAL_GAP");
      }
    }
    const framePayload = {
      provider: frame.provider, market: position.market, symbol: position.symbol, timeframe: frame.timeframe,
      sourceObservedAtMs: frame.closeAtMs, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
    };
    if (frame.sourceDigest !== hash(framePayload)) throw new Error("PAPER_POSITION_FRAME_DIGEST_MISMATCH");
  }
}

function observationSampleClass(observation) {
  const evidence = observation?.naturalEvidence;
  return evidence?.provenanceClass === NATURAL_FORWARD
    && evidence.synthetic === false
    && evidence.replay === false
    && evidence.testOnly === false
    && evidence.backfill === false
    && evidence.historical === false
    && evidence.duplicate === false
    && nonEmpty(evidence.observationId)
    && evidence.observationId === observation.observationId
    && nonEmpty(evidence.source)
    && nonEmpty(evidence.provenance)
    && evidence.observedAtMs === observation.observedAtMs
    ? NATURAL_FORWARD
    : evidence?.provenanceClass === TEST_ONLY ? TEST_ONLY : MISSING_EVIDENCE;
}

function excursion(position, bar, current) {
  const long = position.direction === "BUY" || position.direction === "LONG";
  const sign = long ? 1 : -1;
  const favorablePrice = long ? bar.high : bar.low;
  const adversePrice = long ? bar.low : bar.high;
  const favorable = ((favorablePrice - position.entryFillPrice) / position.entryFillPrice) * sign * 100;
  const adverse = ((adversePrice - position.entryFillPrice) / position.entryFillPrice) * sign * 100;
  return Object.freeze({
    mfePercent: current.mfePercent == null ? favorable : Math.max(current.mfePercent, favorable),
    maePercent: current.maePercent == null ? adverse : Math.min(current.maePercent, adverse),
  });
}

export const NATURAL_SETTLEMENT_COST_COMPONENTS = Object.freeze([
  "commission", "tax", "spread", "slippage", "funding", "latency", "liquidityImpact", "partialFillImpact",
]);

// Transport canonical PercentCostEvidence; never estimate or fill an absent cost.
export function adaptNaturalPaperSettlementFullCost({ position, observation, trigger, evaluatedAtMs } = {}) {
  const blockers = [];
  const cost = observation?.settlementCostEvidence;
  const maximumAgeMs = cost?.maximumAgeMs;
  const policy = observation?.settlementInput?.exitExecution?.costPolicy;
  const qualities = new Set(["OBSERVED", "DOCUMENTED", "ESTIMATED", "NOT_APPLICABLE"]);
  const components = {};
  for (const name of NATURAL_SETTLEMENT_COST_COMPONENTS) {
    const component = cost?.components?.[name];
    if (component?.status !== "PRESENT" || !finite(component.valuePercent) || component.valuePercent < 0
      || !qualities.has(component.quality) || !nonEmpty(component.source) || !nonEmpty(component.provenance)
      || component.policyIdentity?.version !== position.costPolicyVersion
      || !Number.isSafeInteger(component.observedAtMs) || component.observedAtMs > evaluatedAtMs
      || !positive(maximumAgeMs) || maximumAgeMs > observation.maxAgeMs
      || evaluatedAtMs - component.observedAtMs > maximumAgeMs
      || (component.quality === "NOT_APPLICABLE" && component.valuePercent !== 0)) {
      blockers.push(`PAPER_POSITION_SETTLEMENT_${name.toUpperCase()}_COST_EVIDENCE_MISSING`);
      continue;
    }
    if (component.valuePercent / 100 !== policy?.[`${name}Rate`]) {
      blockers.push("BLOCKED_SETTLEMENT_COST_POLICY_MISMATCH");
    }
    if (name === "tax" && (position.market.endsWith("STOCK")
      ? component.quality !== "DOCUMENTED"
      : component.quality !== "NOT_APPLICABLE" || component.valuePercent !== 0)) {
      blockers.push("PAPER_POSITION_SETTLEMENT_TAX_EVIDENCE_MISMATCH");
    }
    if (name === "funding" && position.market !== "CRYPTO_FUTURES"
      && (component.quality !== "NOT_APPLICABLE" || component.valuePercent !== 0)) {
      blockers.push("PAPER_POSITION_FUNDING_EVIDENCE_MISMATCH");
    }
    components[name] = structuredClone(component);
  }
  if (!nonEmpty(cost?.schemaVersion)
    || cost?.status !== "PRESENT"
    || cost?.fullCostReady !== true
    || cost?.unknownIsZero !== false
    || cost?.unavailableCostConvertedToZero !== false
    || cost?.costPolicyIdentity?.version !== position.costPolicyVersion
    || policy?.version !== position.costPolicyVersion) {
    blockers.push("PAPER_POSITION_SETTLEMENT_COST_EVIDENCE_MISSING");
  }
  const funding = observation?.settlementInput?.fundingEvidence;
  if (funding?.complete !== true || !Array.isArray(funding?.payments)) {
    blockers.push("PAPER_POSITION_FUNDING_EVIDENCE_MISSING");
  }
  if (position.market === "CRYPTO_FUTURES") {
    const lineage = cost?.components?.funding?.holdingPeriod;
    const payments = funding?.payments;
    const entryNotional = position.sample?.fill?.notional;
    const totalFunding = Array.isArray(payments) ? payments.reduce((sum, payment) => sum + payment.amount, 0) : NaN;
    if (!positive(entryNotional) || !finite(totalFunding)
      || (totalFunding / entryNotional) * 100 !== cost?.components?.funding?.valuePercent) {
      blockers.push("BLOCKED_SETTLEMENT_COST_POLICY_MISMATCH");
    }
    if (lineage?.entryTimestampMs !== position.entryTimestampMs
      || lineage?.exitTriggerTimestampMs !== trigger.triggeredAtMs
      || lineage?.paperSampleId !== position.paperSampleId
      || lineage?.positionId !== position.positionId
      || !nonEmpty(lineage?.paymentsDigest) || lineage.paymentsDigest !== hash(funding?.payments)
      || funding?.entryTimestampMs !== position.entryTimestampMs
      || funding?.exitTimestampMs !== trigger.triggeredAtMs
      || cost?.components?.funding?.quality !== "OBSERVED"
      || payments?.some((payment, index) => !Number.isSafeInteger(payment.asOfMs)
        || payment.asOfMs < position.entryTimestampMs || payment.asOfMs > trigger.triggeredAtMs
        || (index > 0 && payments[index - 1].asOfMs >= payment.asOfMs)
        || !finite(payment.amount) || !nonEmpty(payment.source) || !nonEmpty(payment.provenance) || !nonEmpty(payment.version))) {
      blockers.push("PAPER_POSITION_FUNDING_HOLDING_PERIOD_MISMATCH");
    }
  } else if (funding?.payments?.length !== 0) {
    blockers.push("PAPER_POSITION_FUNDING_EVIDENCE_MISMATCH");
  }
  if (!observation?.settlementInput?.exitExecution) blockers.push("PAPER_POSITION_EXIT_EXECUTION_EVIDENCE_MISSING");
  return deepFreeze({
    schemaVersion: "natural-paper-settlement-full-cost-v1",
    status: blockers.length ? "BLOCKED_DATA" : "PRESENT",
    fullCostReady: blockers.length === 0,
    components,
    costPolicyIdentity: { version: position.costPolicyVersion },
    exitTriggerId: trigger.exitTriggerId,
    evidenceDigest: hash({ components, exitTriggerId: trigger.exitTriggerId, policy }),
    blockers: [...new Set(blockers)],
    unknownIsZero: false,
    naturalSampleCredit: 0,
    executionAuthority: "NONE",
  });
}

export function createNaturalPaperPositionLifecycle({ position, sample, candidate } = {}) {
  if (sample?.status !== OPEN || !position || typeof position !== "object") {
    throw new Error("PAPER_POSITION_OPEN_SAMPLE_REQUIRED");
  }
  const identity = positionIdentity(position);
  validatePositionIdentity(identity);
  if (sample.identity?.symbol !== identity.symbol
    || sample.identity?.market !== identity.market
    || sample.identity?.executionDirection !== identity.direction
    || sample.identity?.researchCodeSha?.toLowerCase() !== identity.researchCodeSha.toLowerCase()) {
    throw new Error("PAPER_POSITION_ENTRY_LINEAGE_MISMATCH");
  }
  const horizon = exactExitHorizon(sample, candidate);
  const snapshot = candidate?.signal?.learningSnapshot;
  const takeProfitPrices = [
    optionalCanonicalPrice(snapshot?.target1, "TARGET1"),
    optionalCanonicalPrice(snapshot?.target2, "TARGET2"),
  ].filter(positive);
  const sameBarPolicy = candidate?.execution?.executionPolicy?.sameBarPolicy;
  if (sameBarPolicy !== "STOP_FIRST") throw new Error("PAPER_POSITION_SAME_BAR_POLICY_UNSUPPORTED");
  const sampleClass = normalizeSampleClass(candidate);
  const riskPolicyIdentity = canonicalRiskPolicyIdentity(candidate, identity.researchCodeSha);
  if (sampleClass === NATURAL_FORWARD && !riskPolicyIdentity) {
    throw new Error("PAPER_POSITION_RISK_POLICY_IDENTITY_REQUIRED");
  }
  const entry = Object.freeze({
    timestampMs: sample.identity.evaluatedAtMs,
    signalTimestampMs: candidate?.signal?.timestampMs ?? null,
    fillPrice: sample.fill.fillPrice,
    quantity: sample.fill.filledQuantity,
    fillStatus: sample.fill.status,
    evidenceProvenance: deepFreeze(structuredClone(sample.entryEvidenceProvenance)),
    evidenceDigest: sample.entryEvidenceProvenance?.evidenceSnapshotDigest ?? null,
  });
  const strategyIdentity = Object.freeze({
    strategyId: identity.strategyId,
    strategyVersion: identity.strategyVersion,
    parameterHash: identity.parameterHash,
    researchCodeSha: identity.researchCodeSha.toLowerCase(),
  });
  const modelIdentity = candidate?.signal?.modelIdentity
    ? deepFreeze(structuredClone(candidate.signal.modelIdentity))
    : null;
  const exitPolicy = Object.freeze({
    sameBarPolicy,
    expiresAtMs: horizon.expiresAtMs,
    horizonSource: horizon.source,
    stopLossPrice: optionalCanonicalPrice(snapshot?.stopLoss, "STOP_LOSS"),
    takeProfitPrices: Object.freeze(takeProfitPrices),
    invalidationPolicyId: nonEmpty(candidate?.signal?.invalidationPolicyId) ? candidate.signal.invalidationPolicyId : null,
  });
  const sampleEligibility = Object.freeze({
    provenanceClass: sampleClass,
    entryObservationId: sampleClass === NATURAL_FORWARD ? candidate.naturalEvidence.observationId : null,
    naturalSampleCredit: 0,
    testOnlySampleCredit: 0,
  });
  const immutableContract = {
    identity: Object.freeze(identity),
    strategyIdentity,
    riskPolicyIdentity,
    riskPolicyIdentityStatus: riskPolicyIdentity ? "PRESENT" : MISSING_EVIDENCE,
    modelIdentity,
    modelIdentityStatus: modelIdentity ? "PRESENT" : MISSING_EVIDENCE,
    entry,
    exitPolicy,
    sampleEligibility,
  };
  return Object.freeze({
    schemaVersion: NATURAL_PAPER_POSITION_SETTLEMENT_LIFECYCLE_VERSION,
    status: OPEN,
    ...immutableContract,
    identityDigest: hash(identity),
    immutableContractDigest: immutableContractDigest(immutableContract),
    mark: Object.freeze({
      lastObservedAtMs: null,
      lastPrice: null,
      observationCount: 0,
      mfePercent: null,
      maePercent: null,
    }),
    processedObservationIds: Object.freeze([]),
    pathBars: Object.freeze([]),
    pendingExit: null,
    ...safetyEnvelope(),
  });
}

function exitMarketEvidence(input) {
  return {
    exitBar: input?.exitBar ?? null,
    exitQuote: input?.exitQuote ?? null,
    exitDepth: input?.exitDepth ?? null,
    dataEvidence: input?.exitExecution?.dataEvidence ?? null,
  };
}

function freezeExitTrigger(position, lifecycle, observation, exit) {
  const payload = {
    ...exit,
    positionId: position.positionId,
    paperSampleId: position.paperSampleId,
    observationId: observation.observationId,
    triggeredAtMs: observation.observedAtMs,
    triggerTimestamp: observation.observedAtMs,
    triggerPrice: exit.price ?? observation.bar.close,
    exitReason: exit.reason,
    exitType: exit.type,
    source: observation.source,
    provenance: observation.provenance,
    sourceDigest: observation.sourceDigest ?? null,
    pathEvidenceDigest: hash(lifecycle.pathBars),
    positionLifecycleDigest: lifecycle.immutableContractDigest,
    strategyIdentity: lifecycle.strategyIdentity,
    researchCodeSha: position.researchCodeSha,
    costPolicyVersion: position.costPolicyVersion,
    marketEvidence: exitMarketEvidence(observation.settlementInput),
    bar: structuredClone(observation.bar),
    naturalEvidence: structuredClone(observation.naturalEvidence),
  };
  return deepFreeze({ ...payload, exitTriggerId: hash(payload) });
}

function finalizeExit(position, observation, evaluatedAtMs) {
  const lifecycle = position.lifecycle;
  const trigger = lifecycle.pendingExit;
  const { exitTriggerId, ...payload } = trigger;
  if (exitTriggerId !== hash(payload) || trigger.pathEvidenceDigest !== hash(lifecycle.pathBars)
    || trigger.positionLifecycleDigest !== lifecycle.immutableContractDigest) {
    throw new Error("PAPER_POSITION_EXIT_TRIGGER_IDENTITY_MISMATCH");
  }
  const input = observation.settlementInput;
  const delayed = observation.observationId !== trigger.observationId || observation.observedAtMs !== trigger.triggeredAtMs;
  const triggerMismatch = (delayed && (input?.exitTriggerId !== exitTriggerId
      || observation.settlementCostEvidence?.exitTriggerId !== exitTriggerId))
    || hash(exitMarketEvidence(input)) !== hash(trigger.marketEvidence)
    || input?.exitBar?.timestampMs !== trigger.triggeredAtMs
    || input.exitBar.open !== trigger.bar.open || input.exitBar.high !== trigger.bar.high
    || input.exitBar.low !== trigger.bar.low || input.exitBar.close !== trigger.bar.close;
  const cost = adaptNaturalPaperSettlementFullCost({ position, observation, trigger, evaluatedAtMs });
  const blockers = [...cost.blockers];
  if (triggerMismatch) blockers.push("PAPER_POSITION_EXIT_TRIGGER_EVIDENCE_MISMATCH");
  if (lifecycle.sampleEligibility.provenanceClass === NATURAL_FORWARD
    && Array.isArray(input?.pathBars) && input.pathBars.length > 0
    && hash(input.pathBars) !== hash(lifecycle.pathBars)) {
    blockers.push("PAPER_POSITION_SETTLEMENT_PATH_UNIVERSE_MISMATCH");
  }
  if (blockers.length > 0) return Object.freeze({
    status: "BLOCKED_SETTLEMENT_EVIDENCE", position, exitReason: trigger.reason, blockers: Object.freeze(blockers),
  });
  const naturalSampleCredit = lifecycle.sampleEligibility.provenanceClass === NATURAL_FORWARD
    && trigger.naturalEvidence?.provenanceClass === NATURAL_FORWARD ? 1 : 0;
  const settlementInput = {
    ...structuredClone(input),
    exitOrderType: trigger.type,
    pathBars: lifecycle.sampleEligibility.provenanceClass === NATURAL_FORWARD
      ? structuredClone(lifecycle.pathBars)
      : [...(input.pathBars ?? []), ...lifecycle.pathBars],
  };
  if (trigger.type === "LIMIT") settlementInput.exitLimitPrice = trigger.price;
  if (trigger.type === "STOP_MARKET") settlementInput.exitStopPrice = trigger.price;
  return Object.freeze({
    status: "EXIT_ELIGIBLE", position, exitReason: trigger.reason,
    settlementInput: deepFreeze(settlementInput),
    evidence: deepFreeze({
      observationId: trigger.observationId,
      observedAtMs: trigger.triggeredAtMs,
      exitTriggerId,
      exitTriggerTimestampMs: trigger.triggeredAtMs,
      source: trigger.source,
      provenance: trigger.provenance,
      pathEvidenceDigest: trigger.pathEvidenceDigest,
      costEvidence: cost,
      naturalSampleCredit,
      testOnlySampleCredit: 0,
      executionAuthority: "NONE",
      orderSubmitted: false,
    }),
  });
}

export function advanceNaturalPaperPositionLifecycle({ position, observation, evaluatedAtMs, state, cycle } = {}) {
  const lifecycle = assertLifecycle(position);
  if (!Number.isSafeInteger(evaluatedAtMs)) throw new Error("PAPER_POSITION_EVALUATED_AT_REQUIRED");
  validateObservation(position, observation, evaluatedAtMs);
  validateNaturalHandoff(position, observation, state, cycle);
  if (lifecycle.pendingExit) return finalizeExit(position, observation, evaluatedAtMs);
  if (lifecycle.processedObservationIds.includes(observation.observationId)) {
    return Object.freeze({ status: "DUPLICATE_OBSERVATION", blocker: "DUPLICATE_POSITION_OBSERVATION", position });
  }
  if (lifecycle.mark.lastObservedAtMs != null && observation.observedAtMs <= lifecycle.mark.lastObservedAtMs) {
    throw new Error("PAPER_POSITION_OBSERVATION_ORDER_INVALID");
  }

  const excursions = excursion(position, observation.bar, lifecycle.mark);
  let nextLifecycle = Object.freeze({
    ...lifecycle,
    mark: Object.freeze({
      lastObservedAtMs: observation.observedAtMs,
      lastPrice: observation.bar.close,
      observationCount: lifecycle.mark.observationCount + 1,
      ...excursions,
    }),
    processedObservationIds: Object.freeze([...lifecycle.processedObservationIds, observation.observationId]),
    pathBars: Object.freeze([...lifecycle.pathBars, Object.freeze({
      timestampMs: observation.observedAtMs,
      high: observation.bar.high,
      low: observation.bar.low,
    })]),
  });

  let exit = priceRules(position.direction, lifecycle.exitPolicy, observation.bar);
  const invalidation = observation.invalidationEvidence;
  if (!exit && invalidation?.invalidated === true) {
    if (!nonEmpty(lifecycle.exitPolicy.invalidationPolicyId)
      || invalidation.policyId !== lifecycle.exitPolicy.invalidationPolicyId
      || invalidation.status !== "PRESENT"
      || !nonEmpty(invalidation.source)
      || !nonEmpty(invalidation.provenance)
      || invalidation.observedAtMs !== observation.observedAtMs) {
      throw new Error("PAPER_POSITION_INVALIDATION_EVIDENCE_MISMATCH");
    }
    exit = Object.freeze({ reason: "INVALIDATION", type: "MARKET", price: null });
  }
  if (!exit && Number.isSafeInteger(lifecycle.exitPolicy.expiresAtMs)
    && observation.observedAtMs >= lifecycle.exitPolicy.expiresAtMs) {
    exit = Object.freeze({ reason: "TIMEOUT", type: "MARKET", price: null });
  }
  if (exit && lifecycle.pendingExit == null) {
    nextLifecycle = Object.freeze({
      ...nextLifecycle,
      pendingExit: freezeExitTrigger(position, nextLifecycle, observation, exit),
    });
  }
  const updatedPosition = Object.freeze({ ...position, lifecycle: nextLifecycle });
  if (!exit) return Object.freeze({ status: "HOLD", position: updatedPosition, exitReason: null });

  return finalizeExit(updatedPosition, observation, evaluatedAtMs);
}
