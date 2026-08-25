import { sha256Canonical } from "./research-cache-provenance.js";
import { resolveCanonicalStrategyIdentity } from "./canonical-strategy-identity-v1.js";
import {
  verifyBacktesterStrategyEvidenceAdapterV1,
} from "./backtester-strategy-evidence-adapter-v1.js";

export const CURRENT_PROVISIONAL_CHAMPION = "NONE";
export const CURRENT_VALIDATED_CHAMPION = "NONE";
export const PROVISIONAL_CHAMPION_SAFETY = Object.freeze({
  LIVE_TRADING: false,
  REAL_ORDER_ENABLED: false,
  PRIVATE_TRADING_API_ALLOWED: false,
  executionAuthority: "NONE",
  orderSubmitApiCalls: 0,
  brokerAdapters: 0,
  exchangePrivateEndpointCalls: 0,
  transfers: 0,
  withdrawals: 0,
});
export const PROVISIONAL_CHAMPION_POLICY_V1 = Object.freeze({
  version: "PROVISIONAL_CHAMPION_POLICY_V1",
  minimumOosTradeN: 30,
  requiredStages: Object.freeze(["OOS", "WALK_FORWARD", "COST_STRESS", "STATISTICAL_FIREWALL"]),
  statisticalFirewallRequired: true,
  rankingPolicy: "LEXICOGRAPHIC_SAFETY_V1",
  canonicalEvidenceAuthority: "PHASE5_ADAPTER_REQUIRED",
  environment: "PRODUCTION",
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function unique(values) { return [...new Set(values)].sort(); }

function validatePolicy(policy) {
  const expectedStages = PROVISIONAL_CHAMPION_POLICY_V1.requiredStages;
  if (!policy || policy.version !== PROVISIONAL_CHAMPION_POLICY_V1.version
    || policy.minimumOosTradeN !== PROVISIONAL_CHAMPION_POLICY_V1.minimumOosTradeN
    || policy.statisticalFirewallRequired !== PROVISIONAL_CHAMPION_POLICY_V1.statisticalFirewallRequired
    || policy.rankingPolicy !== PROVISIONAL_CHAMPION_POLICY_V1.rankingPolicy
    || policy.canonicalEvidenceAuthority !== PROVISIONAL_CHAMPION_POLICY_V1.canonicalEvidenceAuthority
    || !Array.isArray(policy.requiredStages)
    || policy.requiredStages.length !== expectedStages.length
    || policy.requiredStages.some((stage, index) => stage !== expectedStages[index])
    || !["PRODUCTION", "TEST_ONLY"].includes(policy.environment)) {
    throw new TypeError("exact versioned provisional champion policy is required");
  }
}

function stageMap(evidenceResults, blockers) {
  const map = new Map();
  for (const result of evidenceResults) {
    if (result?.status !== "LINKED" || !result.envelope || !result.evidenceDigest) {
      blockers.push("UNLINKED_EVIDENCE");
      continue;
    }
    const stage = result.envelope.evidenceStage;
    if (map.has(stage)) blockers.push(`DUPLICATE_STAGE_EVIDENCE:${stage}`);
    else map.set(stage, result);
  }
  return map;
}

function evaluateCandidate(candidate, policy) {
  const blockers = [];
  const resolved = resolveCanonicalStrategyIdentity(candidate?.strategyIdentity);
  if (resolved.status !== "IDENTITY_COMPLETE") blockers.push("IDENTITY_INCOMPLETE");
  if (resolved.status === "IDENTITY_COMPLETE" && candidate.strategyIdentityDigest !== resolved.strategyIdentityDigest) blockers.push("IDENTITY_MISMATCH");
  if (candidate?.testOnly === true && policy.environment !== "TEST_ONLY") blockers.push("TEST_ONLY_CANDIDATE_FORBIDDEN");
  if (policy.environment === "TEST_ONLY" && candidate?.testOnly !== true) blockers.push("TEST_ONLY_MARKER_REQUIRED");
  if (policy.environment === "PRODUCTION") {
    const adapterVerification = verifyBacktesterStrategyEvidenceAdapterV1(candidate);
    if (adapterVerification.verified !== true || candidate?.testOnly === true) {
      blockers.push("CANONICAL_EVIDENCE_ADAPTER_NOT_READY");
      blockers.push(...adapterVerification.blockers.map((blocker) => `CANONICAL_EVIDENCE_ADAPTER_INVALID:${blocker}`));
    }
  }

  const evidenceResults = Array.isArray(candidate?.evidenceEnvelopes) ? candidate.evidenceEnvelopes : [];
  const stages = stageMap(evidenceResults, blockers);
  for (const stage of policy.requiredStages) if (!stages.has(stage)) blockers.push(`MISSING_REQUIRED_STAGE:${stage}`);

  for (const result of stages.values()) {
    const stage = result.envelope.evidenceStage;
    if (resolved.status === "IDENTITY_COMPLETE" && result.envelope.strategyIdentityDigest !== resolved.strategyIdentityDigest) blockers.push("IDENTITY_MISMATCH");
    for (const missing of result.envelope.missingEvidence) blockers.push(`MISSING_EVIDENCE:${stage}:${missing}`);
    if (result.envelope.validation?.datasetIntegrity !== true) blockers.push(`DATASET_INTEGRITY_UNPROVEN:${stage}`);
    if (result.envelope.validation?.noFutureLeakage !== true) blockers.push(`FUTURE_LEAKAGE_UNPROVEN:${stage}`);
    if (result.envelope.validation?.noSameBarLeakage !== true) blockers.push(`SAME_BAR_LEAKAGE_UNPROVEN:${stage}`);
  }

  const oos = stages.get("OOS")?.envelope;
  const walkForward = stages.get("WALK_FORWARD")?.envelope;
  const costStress = stages.get("COST_STRESS")?.envelope;
  const firewall = stages.get("STATISTICAL_FIREWALL")?.envelope;

  if (oos && !(oos.sample.tradeN >= policy.minimumOosTradeN)) blockers.push("OOS_SAMPLE_INSUFFICIENT");
  if (oos && (!finite(oos.metrics.expectancy) || oos.metrics.expectancy <= 0)) blockers.push("OOS_POSITIVE_EXPECTANCY_REQUIRED");
  if (oos && !finite(oos.metrics.profitFactor)) blockers.push("OOS_PROFIT_FACTOR_REQUIRED");
  if (oos && !finite(oos.metrics.mdd)) blockers.push("OOS_MDD_REQUIRED");
  if (oos && oos.validation?.mddAcceptable !== true) blockers.push("OOS_ACCEPTABLE_MDD_REQUIRED");

  if (walkForward && walkForward.validation?.parameterStability !== "PASS") blockers.push("PARAMETER_STABILITY_REQUIRED");
  if (walkForward && !finite(walkForward.metrics.positiveWindowRatio)) blockers.push("WALK_FORWARD_STABILITY_REQUIRED");

  if (costStress && costStress.validation?.costStressSurvived !== true) blockers.push("COST_STRESS_SURVIVAL_REQUIRED");
  if (costStress && costStress.costs?.costPolicyVersion !== resolved.identity?.costPolicyVersion) blockers.push("MANDATORY_COST_EVIDENCE_REQUIRED");
  const costAdjustedExpectation = finite(costStress?.metrics?.costAdjustedReturn)
    ? costStress.metrics.costAdjustedReturn
    : costStress?.metrics?.expectancy;
  if (costStress && !finite(costAdjustedExpectation)) blockers.push("COST_ADJUSTED_EXPECTANCY_REQUIRED");
  if (costStress && finite(costAdjustedExpectation) && costAdjustedExpectation <= 0) blockers.push("COST_ADJUSTED_EXPECTANCY_NOT_POSITIVE");

  if (policy.statisticalFirewallRequired && !firewall) blockers.push("STATISTICAL_FIREWALL_REQUIRED");
  if (firewall && firewall.validation?.overfitVerdict !== "PASS") blockers.push("STATISTICAL_OVERFIT_EVIDENCE_FAILED");
  if (firewall && (!finite(firewall.metrics.dsr) || !finite(firewall.metrics.pbo))) blockers.push("STATISTICAL_FIREWALL_METRICS_REQUIRED");

  const evidenceDigest = sha256Canonical(evidenceResults.map((row) => row?.evidenceDigest ?? null).sort());
  const ranking = blockers.length === 0 ? Object.freeze([
    oos.metrics.expectancy,
    walkForward.metrics.positiveWindowRatio,
    costAdjustedExpectation,
    oos.metrics.profitFactor,
    -Math.abs(oos.metrics.mdd),
    firewall.metrics.dsr,
    -firewall.metrics.pbo,
  ]) : null;
  return deepFreeze({
    status: blockers.length === 0 ? "ELIGIBLE" : "NOT_ELIGIBLE",
    strategyId: resolved.identity?.strategyId ?? candidate?.strategyIdentity?.strategyId ?? null,
    strategyIdentity: resolved.identity,
    strategyIdentityDigest: resolved.strategyIdentityDigest,
    blockers: unique(blockers),
    evidenceDigest,
    ranking,
    evidenceClass: candidate?.testOnly === true ? "TEST_ONLY" : "CANONICAL",
    measuredAt: evidenceResults.map((row) => row?.envelope?.measuredAt).filter(Boolean).sort().at(-1) ?? null,
  });
}

function compareRanking(left, right) {
  for (let index = 0; index < left.ranking.length; index += 1) {
    if (left.ranking[index] !== right.ranking[index]) return left.ranking[index] > right.ranking[index] ? -1 : 1;
  }
  return left.strategyIdentityDigest.localeCompare(right.strategyIdentityDigest);
}

export function selectProvisionalChampion({ candidates = [], policy = PROVISIONAL_CHAMPION_POLICY_V1 } = {}) {
  validatePolicy(policy);
  const evaluations = (Array.isArray(candidates) ? candidates : []).map((candidate) => evaluateCandidate(candidate, policy));
  const eligible = evaluations.filter((candidate) => candidate.status === "ELIGIBLE").sort(compareRanking);
  const selected = eligible[0] ?? null;
  if (!selected) {
    return deepFreeze({
      schemaVersion: "provisional-champion-verdict-v1",
      status: "NONE",
      currentProvisionalChampion: "NONE",
      currentValidatedChampion: CURRENT_VALIDATED_CHAMPION,
      reasons: ["NO_ELIGIBLE_CANDIDATE"],
      blockers: unique(evaluations.flatMap((candidate) => candidate.blockers)),
      evaluations,
      evidenceDigest: sha256Canonical(evaluations.map((candidate) => candidate.evidenceDigest)),
      policyVersion: policy.version,
      canonicalEvidenceAuthority: policy.canonicalEvidenceAuthority,
      selectedAt: null,
      validatedChampion: false,
      profitabilityProven: false,
      liveTradingEligible: false,
      executionAuthority: "NONE",
      orderSubmitted: false,
      safety: PROVISIONAL_CHAMPION_SAFETY,
    });
  }
  const currentProvisionalChampion = deepFreeze({
    strategyId: selected.strategyId,
    strategyIdentity: selected.strategyIdentity,
    strategyIdentityDigest: selected.strategyIdentityDigest,
    evidenceDigest: selected.evidenceDigest,
    evidenceClass: selected.evidenceClass,
    championState: "PROVISIONAL",
  });
  return deepFreeze({
    schemaVersion: "provisional-champion-verdict-v1",
    status: "PROVISIONAL_CHAMPION",
    strategyId: selected.strategyId,
    strategyIdentityDigest: selected.strategyIdentityDigest,
    currentProvisionalChampion,
    currentValidatedChampion: CURRENT_VALIDATED_CHAMPION,
    reasons: ["HARD_GATES_PASSED", `RANKED_BY:${policy.rankingPolicy}`],
    blockers: [],
    evaluations,
    evidenceDigest: selected.evidenceDigest,
    policyVersion: policy.version,
    canonicalEvidenceAuthority: policy.canonicalEvidenceAuthority,
    selectedAt: selected.measuredAt,
    validatedChampion: false,
    profitabilityProven: false,
    liveTradingEligible: false,
    executionAuthority: "NONE",
    orderSubmitted: false,
    safety: PROVISIONAL_CHAMPION_SAFETY,
  });
}
