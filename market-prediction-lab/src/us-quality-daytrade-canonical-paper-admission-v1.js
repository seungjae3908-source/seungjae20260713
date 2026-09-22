import { resolveCanonicalPaperAdmissionBridgeCandidate } from "./canonical-paper-admission-bridge-v1.js";
import { resolveCanonicalPaperSimulationAuthority } from "./canonical-paper-simulation-authority-v1.js";

export const QUALITY_DAYTRADE_CANONICAL_PAPER_ADMISSION_VERSION =
  "us-quality-daytrade-canonical-paper-admission-v1";

const PAPER_ADMISSION_BUNDLE_SCHEMA = "scanner-paper-admission-evidence-bundle-v1";

function freeze(value) {
  return Object.freeze(value);
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

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function digest64(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function immutableSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function safetyEnvelope() {
  return freeze({
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

function add(blockers, code, condition = true) {
  if (condition && !blockers.includes(code)) blockers.push(code);
}

function blocked(blockers, admission = null, simulation = null) {
  return deepFreeze({
    contractVersion: QUALITY_DAYTRADE_CANONICAL_PAPER_ADMISSION_VERSION,
    status: "BLOCKED_DATA",
    blockers: [...new Set(blockers)],
    paperAdmissionReady: false,
    simulationReady: false,
    sourceEvidenceId: null,
    canonicalBundle: null,
    admission,
    simulation,
    ...safetyEnvelope(),
  });
}

function strategyIdentityBlockers(candidateBinding, bundle) {
  const blockers = [];
  const bindingIdentity = candidateBinding?.strategyIdentity;
  const signal = bundle?.paperCandidate?.signal;
  const canonicalIdentity = signal?.strategyIdentity;

  add(blockers, "US_QUALITY_BOUND_CANDIDATE_REQUIRED",
    candidateBinding?.status !== "BOUND_CANDIDATE" || candidateBinding?.candidateBound !== true);
  add(blockers, "US_QUALITY_EVIDENCE_ID_REQUIRED", !digest64(candidateBinding?.evidenceId));
  add(blockers, "US_QUALITY_OBSERVATION_DIGEST_REQUIRED", !digest64(candidateBinding?.observationDigest));
  add(blockers, "US_QUALITY_SYMBOL_REQUIRED", !nonEmpty(candidateBinding?.symbol));

  add(blockers, "US_QUALITY_STRATEGY_IDENTITY_REQUIRED",
    !bindingIdentity
      || !nonEmpty(bindingIdentity.strategyId)
      || !nonEmpty(bindingIdentity.strategyVersion)
      || !nonEmpty(bindingIdentity.parameterHash)
      || !immutableSha(bindingIdentity.researchCodeSha));
  add(blockers, "US_QUALITY_BINDING_MARKET_INVALID", bindingIdentity?.market !== "US_STOCK");
  add(blockers, "US_QUALITY_BINDING_DIRECTION_INVALID", bindingIdentity?.direction !== "LONG");

  add(blockers, "CANONICAL_PAPER_ADMISSION_BUNDLE_REQUIRED",
    !bundle || typeof bundle !== "object" || Array.isArray(bundle));
  add(blockers, "CANONICAL_PAPER_ADMISSION_SCHEMA_MISMATCH",
    bundle?.schemaVersion !== PAPER_ADMISSION_BUNDLE_SCHEMA);
  add(blockers, "US_QUALITY_CANONICAL_SIGNAL_REQUIRED", !signal);
  add(blockers, "US_QUALITY_CANONICAL_MARKET_MISMATCH", signal?.market !== "US_STOCK");
  add(blockers, "US_QUALITY_CANONICAL_SYMBOL_MISMATCH",
    nonEmpty(candidateBinding?.symbol) && signal?.symbol !== candidateBinding.symbol);
  add(blockers, "US_QUALITY_CANONICAL_SIGNAL_ID_MISMATCH",
    digest64(candidateBinding?.evidenceId) && signal?.signalId !== candidateBinding.evidenceId);
  add(blockers, "US_QUALITY_CANONICAL_ENTRY_DIRECTION_MISMATCH", signal?.direction !== "BUY");

  add(blockers, "US_QUALITY_CANONICAL_STRATEGY_IDENTITY_REQUIRED",
    !canonicalIdentity
      || !nonEmpty(canonicalIdentity.strategyId)
      || !nonEmpty(canonicalIdentity.strategyVersion)
      || !nonEmpty(canonicalIdentity.parameterHash)
      || !immutableSha(canonicalIdentity.researchCodeSha)
      || !nonEmpty(canonicalIdentity.costPolicyVersion));

  if (bindingIdentity && canonicalIdentity) {
    add(blockers, "US_QUALITY_CANONICAL_STRATEGY_ID_MISMATCH",
      canonicalIdentity.strategyId !== bindingIdentity.strategyId);
    add(blockers, "US_QUALITY_CANONICAL_STRATEGY_VERSION_MISMATCH",
      canonicalIdentity.strategyVersion !== bindingIdentity.strategyVersion);
    add(blockers, "US_QUALITY_CANONICAL_PARAMETER_HASH_MISMATCH",
      canonicalIdentity.parameterHash !== bindingIdentity.parameterHash);
    add(blockers, "US_QUALITY_CANONICAL_RESEARCH_SHA_MISMATCH",
      String(canonicalIdentity.researchCodeSha ?? "").toLowerCase()
        !== String(bindingIdentity.researchCodeSha ?? "").toLowerCase());
  }

  const learning = bundle?.learningSnapshot;
  add(blockers, "US_QUALITY_LEARNING_SIGNAL_ID_MISMATCH",
    learning?.signalId !== candidateBinding?.evidenceId);
  add(blockers, "US_QUALITY_LEARNING_MARKET_MISMATCH", learning?.market !== "US_STOCK");
  add(blockers, "US_QUALITY_LEARNING_SYMBOL_MISMATCH",
    nonEmpty(candidateBinding?.symbol) && learning?.symbol !== candidateBinding.symbol);
  add(blockers, "US_QUALITY_LEARNING_DIRECTION_MISMATCH", learning?.direction !== "BUY");

  return blockers;
}

export function resolveUsQualityDaytradeCanonicalPaperAdmission({
  candidateBinding,
  bundle,
  nowMs = Date.now(),
} = {}) {
  if (!(typeof nowMs === "number" && Number.isFinite(nowMs) && nowMs > 0)) {
    return blocked(["US_QUALITY_CANONICAL_ADMISSION_CLOCK_INVALID"]);
  }

  const identityBlockers = strategyIdentityBlockers(candidateBinding, bundle);
  if (identityBlockers.length > 0) return blocked(identityBlockers);

  const admission = resolveCanonicalPaperAdmissionBridgeCandidate({ bundle, nowMs });
  if (admission.status !== "BRIDGE_READY" || !admission.candidate) {
    return blocked(
      (admission.blockers ?? []).map((code) => "CANONICAL_ADMISSION:" + code),
      admission,
      null,
    );
  }

  const simulation = resolveCanonicalPaperSimulationAuthority({
    candidate: admission.candidate,
    nowMs,
  });
  if (simulation.status !== "READY"
    || simulation.sampleExecutionReady !== true
    || !simulation.execution
    || !simulation.order
    || !simulation.quote) {
    return blocked(
      (simulation.blockers ?? []).map((code) => "CANONICAL_SIMULATION:" + code),
      admission,
      simulation,
    );
  }

  return deepFreeze({
    contractVersion: QUALITY_DAYTRADE_CANONICAL_PAPER_ADMISSION_VERSION,
    status: "READY",
    blockers: [],
    paperAdmissionReady: true,
    simulationReady: true,
    sourceEvidenceId: candidateBinding.evidenceId,
    sourceObservationDigest: candidateBinding.observationDigest,
    canonicalBundle: clone(bundle),
    admission,
    simulation,
    ...safetyEnvelope(),
  });
}

export function createUsQualityDaytradeCanonicalPaperAdmissionBundleForCard({
  candidateBindingForCard,
  canonicalBundleForCard,
  now = () => Date.now(),
} = {}) {
  if (typeof candidateBindingForCard !== "function") {
    throw new TypeError("candidateBindingForCard is required");
  }
  if (typeof canonicalBundleForCard !== "function") {
    throw new TypeError("canonicalBundleForCard is required");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");

  return async function paperAdmissionBundleForCard(card, selectedMarket) {
    if (selectedMarket !== "US_STOCK") return null;

    const candidateBinding = await candidateBindingForCard(card, selectedMarket);
    const bundle = await canonicalBundleForCard(card, selectedMarket, candidateBinding);
    const resolved = resolveUsQualityDaytradeCanonicalPaperAdmission({
      candidateBinding,
      bundle,
      nowMs: now(),
    });

    if (resolved.status !== "READY" || !resolved.canonicalBundle) {
      const error = new Error("AUTHORITATIVE_ADMISSION_EVIDENCE_BLOCKED");
      error.code = "AUTHORITATIVE_ADMISSION_EVIDENCE_BLOCKED";
      error.authoritativeAdmissionBlockers = [...resolved.blockers];
      throw error;
    }

    return resolved.canonicalBundle;
  };
}
