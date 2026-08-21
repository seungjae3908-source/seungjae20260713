import { assertFinalHoldoutIsolation } from "./automated-research-orchestrator.js";
import { researchDigest } from "./research-trial-registry.js";

const SHA40 = /^[0-9a-f]{40}$/i;
const DIGEST64 = /^[0-9a-f]{64}$/i;
const FOUR_MARKET_SLOTS = Object.freeze([
  "KR_STOCK",
  "US_STOCK",
  "CRYPTO_SPOT",
  "CRYPTO_FUTURES_LONG",
  "CRYPTO_FUTURES_SHORT",
]);
const DUAL_AI_STATUSES = new Set([
  "AI_REVIEW_AGREE",
  "AI_REVIEW_CONFLICT",
  "AI_REVIEW_BOTH_REJECT",
  "AI_REVIEW_INCOMPLETE",
]);

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function requiredTimestamp(value, name) {
  const text = requiredText(value, name);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`${name} must be a timestamp`);
  return new Date(text).toISOString();
}

function canonical(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
}

function immutableJson(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} is required`);
  return Object.freeze(canonical(value));
}

function safetyEnvelope() {
  return Object.freeze({
    LIVE_TRADING: false,
    AUTO_TRADING: false,
    REAL_ORDER_ENABLED: false,
    PRIVATE_TRADING_API_ALLOWED: false,
    orderSubmitted: false,
    orderCancelled: false,
    orderModified: false,
    transferSubmitted: false,
    withdrawalSubmitted: false,
    scannerOwnerMutation: false,
    shadowOwnerMutation: false,
    paperOwnerMutation: false,
    healthOwnerMutation: false,
    promotionOwnerMutation: false,
  });
}

function digestRecord(core) {
  return Object.freeze({ ...core, manifestDigest: researchDigest(core) });
}

function freezeBlockers(job, result) {
  const blockers = [];
  if (result?.status !== "FROZEN_ELIGIBLE") blockers.push("PRE_HOLDOUT_PIPELINE_NOT_ELIGIBLE");
  if (result?.finalHoldoutOpened !== false) blockers.push("FINAL_HOLDOUT_ALREADY_OPENED");
  if (result?.evidence?.minimumGate?.passed !== true) blockers.push("PRE_HOLDOUT_GATE_NOT_PASSED");
  if (result?.evidence?.statistics?.status !== "PASS") blockers.push("STATISTICAL_FIREWALL_NOT_PASSED");
  if (result?.evidence?.oos?.status !== "PASS") blockers.push("OOS_NOT_PASSED");
  if (result?.evidence?.walkForward?.status !== "PASS" || result?.evidence?.walkForward?.leakFree !== true) blockers.push("WALK_FORWARD_NOT_PASSED");
  if (result?.evidence?.costStress?.status !== "PASS") blockers.push("COST_STRESS_NOT_PASSED");
  if (result?.evidence?.regime?.status !== "PASS") blockers.push("REGIME_STRESS_NOT_PASSED");
  if (!job?.candidate?.strategyId) blockers.push("STRATEGY_ID_MISSING");
  if (!job?.candidate?.strategyFamilyId) blockers.push("STRATEGY_FAMILY_ID_MISSING");
  if (!DIGEST64.test(job?.candidate?.parameterHash ?? "")) blockers.push("PARAMETER_HASH_INVALID");
  if (!SHA40.test(job?.researchCodeSha ?? "")) blockers.push("RESEARCH_CODE_SHA_INVALID");
  return Object.freeze(blockers);
}

export function freezeAutonomousResearchCandidate(job, result, { freezeTimestamp } = {}) {
  const blockers = freezeBlockers(job, result);
  if (blockers.length > 0) return Object.freeze({
    schemaVersion: 1,
    FROZEN_RESEARCH_CANDIDATE: false,
    FINAL_HOLDOUT_NOT_OPENED: result?.finalHoldoutOpened !== true,
    blockers,
    safety: safetyEnvelope(),
  });
  const core = Object.freeze({
    schemaVersion: 1,
    FROZEN_RESEARCH_CANDIDATE: true,
    FINAL_HOLDOUT_NOT_OPENED: true,
    strategyId: job.candidate.strategyId,
    strategyFamilyId: job.candidate.strategyFamilyId,
    candidateIdentityDigest: job.identity.candidateIdentityDigest,
    parameterHash: job.candidate.parameterHash,
    formulaHash: job.candidate.formulaHash,
    researchCodeSha: job.researchCodeSha,
    datasetId: job.datasetId,
    datasetDigest: job.datasetDigest,
    costPolicyVersion: job.identity.costPolicyVersion,
    decisionPolicyVersion: job.identity.decisionPolicyVersion,
    market: job.market,
    direction: job.direction,
    strategyType: job.strategyType,
    rankingGroup: job.rankingGroup,
    frozenAt: requiredTimestamp(freezeTimestamp, "freezeTimestamp"),
    preHoldoutResultDigest: result.resultDigest,
    immutableParameters: job.candidate.parameters,
    selectionUsesFinalHoldout: false,
    retuningAfterFreezeAllowed: false,
    safety: safetyEnvelope(),
  });
  return digestRecord(core);
}

export function buildOneShotFinalHoldoutRequest(frozen, { requestId = null } = {}) {
  if (frozen?.FROZEN_RESEARCH_CANDIDATE !== true || frozen?.FINAL_HOLDOUT_NOT_OPENED !== true || frozen?.manifestDigest !== researchDigest(Object.freeze(Object.fromEntries(Object.entries(frozen).filter(([key]) => key !== "manifestDigest"))))) {
    throw new Error("VALID_FROZEN_CANDIDATE_REQUIRED");
  }
  const core = Object.freeze({
    schemaVersion: 1,
    requestId: requestId ?? `final-holdout-request-v1:${researchDigest({ manifestDigest: frozen.manifestDigest })}`,
    frozenManifestDigest: frozen.manifestDigest,
    strategyId: frozen.strategyId,
    candidateIdentityDigest: frozen.candidateIdentityDigest,
    parameterHash: frozen.parameterHash,
    researchCodeSha: frozen.researchCodeSha,
    status: "READY_FOR_SEPARATE_APPROVAL",
    oneShot: true,
    consumed: false,
    selectionUsesFinalHoldout: false,
    calibrationUsesFinalHoldout: false,
    retuningAllowed: false,
    executionOwner: "CANONICAL_FINAL_HOLDOUT",
    activationRequested: false,
    safety: safetyEnvelope(),
  });
  return digestRecord(core);
}

export function recordOneShotFinalHoldoutResult(request, frozen, holdoutResult, { executedAt } = {}) {
  if (request?.oneShot !== true || request?.consumed !== false) throw new Error("FINAL_HOLDOUT_REQUEST_ALREADY_CONSUMED");
  if (request.frozenManifestDigest !== frozen?.manifestDigest || request.strategyId !== frozen?.strategyId) throw new Error("FINAL_HOLDOUT_FROZEN_IDENTITY_MISMATCH");
  if (holdoutResult?.requestId !== request.requestId || holdoutResult?.strategyId !== frozen.strategyId || holdoutResult?.parameterHash !== frozen.parameterHash) {
    throw new Error("FINAL_HOLDOUT_RESULT_IDENTITY_MISMATCH");
  }
  assertFinalHoldoutIsolation({
    selectionUsesHoldout: false,
    selectedCandidateId: frozen.candidateIdentityDigest,
    holdoutCandidateId: holdoutResult.candidateIdentityDigest,
    retunedAfterHoldout: holdoutResult.retunedAfterHoldout === true,
  });
  if (!new Set(["PASS", "FAIL", "INSUFFICIENT_EVIDENCE"]).has(holdoutResult.status)) throw new Error("FINAL_HOLDOUT_RESULT_STATUS_INVALID");
  const core = Object.freeze({
    ...request,
    status: holdoutResult.status === "PASS" ? "FINAL_HOLDOUT_PASS" : holdoutResult.status === "FAIL" ? "FINAL_HOLDOUT_FAIL" : "FINAL_HOLDOUT_INSUFFICIENT_EVIDENCE",
    consumed: true,
    consumedAt: requiredTimestamp(executedAt, "executedAt"),
    holdoutResultDigest: researchDigest(holdoutResult),
    immutableHoldoutResult: immutableJson(holdoutResult, "holdoutResult"),
    FINAL_HOLDOUT_NOT_OPENED: false,
    promotionAuthority: false,
    safety: safetyEnvelope(),
  });
  return digestRecord(core);
}

export function buildCanonicalShadowHandoffIntent(frozen, holdoutRecord, { createdAt } = {}) {
  if (frozen?.FROZEN_RESEARCH_CANDIDATE !== true || holdoutRecord?.status !== "FINAL_HOLDOUT_PASS" || holdoutRecord?.frozenManifestDigest !== frozen.manifestDigest) {
    return Object.freeze({ status: "BLOCKED", reason: "FINAL_HOLDOUT_PASS_REQUIRED", ownerMutation: false, safety: safetyEnvelope() });
  }
  const core = Object.freeze({
    schemaVersion: 1,
    intentId: `shadow-handoff-v1:${researchDigest({ frozen: frozen.manifestDigest, holdout: holdoutRecord.holdoutResultDigest })}`,
    status: "ADAPTER_INTENT_READY",
    canonicalOwnerRef: "#419",
    strategyId: frozen.strategyId,
    frozenManifestDigest: frozen.manifestDigest,
    holdoutResultDigest: holdoutRecord.holdoutResultDigest,
    createdAt: requiredTimestamp(createdAt, "createdAt"),
    futureOnly: true,
    historicalBackfillAllowed: false,
    duplicateCreditAllowed: false,
    activationRequested: false,
    ownerMutation: false,
    safety: safetyEnvelope(),
  });
  return digestRecord(core);
}

export function buildCanonicalPaperHandoffIntent(frozen, shadowDecision, { createdAt } = {}) {
  if (frozen?.FROZEN_RESEARCH_CANDIDATE !== true || shadowDecision?.status !== "PASS" || shadowDecision?.strategyId !== frozen.strategyId || shadowDecision?.futureOnly !== true) {
    return Object.freeze({ status: "BLOCKED", reason: "CANONICAL_SHADOW_PASS_REQUIRED", ownerMutation: false, safety: safetyEnvelope() });
  }
  const core = Object.freeze({
    schemaVersion: 1,
    intentId: `paper-handoff-v1:${researchDigest({ frozen: frozen.manifestDigest, shadow: shadowDecision.evidenceDigest })}`,
    status: "ADAPTER_INTENT_READY",
    canonicalOwnerRef: "#299",
    strategyId: frozen.strategyId,
    frozenManifestDigest: frozen.manifestDigest,
    shadowEvidenceDigest: requiredText(shadowDecision.evidenceDigest, "shadowDecision.evidenceDigest"),
    createdAt: requiredTimestamp(createdAt, "createdAt"),
    futureOnly: true,
    historicalBackfillAllowed: false,
    duplicateCreditAllowed: false,
    activationRequested: false,
    ownerMutation: false,
    safety: safetyEnvelope(),
  });
  return digestRecord(core);
}

export function buildSettlementHealthFeedback(frozen, input = {}) {
  if (frozen?.FROZEN_RESEARCH_CANDIDATE !== true) throw new Error("VALID_FROZEN_CANDIDATE_REQUIRED");
  const settlement = immutableJson(input.settlement, "settlement");
  const health = immutableJson(input.health, "health");
  if (settlement.strategyId !== frozen.strategyId || health.strategyId !== frozen.strategyId) throw new Error("LIFECYCLE_FEEDBACK_IDENTITY_MISMATCH");
  const core = Object.freeze({
    schemaVersion: 1,
    strategyId: frozen.strategyId,
    frozenManifestDigest: frozen.manifestDigest,
    settlementOwnerRef: "CANONICAL_SETTLEMENT",
    healthOwnerRef: "#247",
    settlementEvidenceDigest: requiredText(settlement.evidenceDigest, "settlement.evidenceDigest"),
    healthEvidenceDigest: requiredText(health.evidenceDigest, "health.evidenceDigest"),
    healthStatus: requiredText(health.status, "health.status"),
    feedbackUse: "HEALTH_AND_FUTURE_RESEARCH_ONLY",
    frozenParameterMutationAllowed: false,
    selectionHistoryRewriteAllowed: false,
    ownerMutation: false,
    safety: safetyEnvelope(),
  });
  return digestRecord(core);
}

function championSlot(candidate) {
  if (candidate.market === "CRYPTO_FUTURES") return `${candidate.market}_${candidate.direction}`;
  return candidate.market;
}

function candidateEligible(candidate) {
  return candidate?.finalHoldoutStatus === "PASS"
    && candidate?.shadowStatus === "PASS"
    && candidate?.paperStatus === "PASS"
    && candidate?.settlementStatus === "PASS"
    && candidate?.healthStatus === "ACTIVE"
    && Number.isFinite(candidate?.qualityScore);
}

export function buildFourMarketChampionPortfolio(candidates = [], { maxPerSlot = 3, maxCorrelationClusterWeight = 0.5 } = {}) {
  if (!Number.isInteger(maxPerSlot) || maxPerSlot <= 0) throw new RangeError("maxPerSlot must be a positive integer");
  if (!(maxCorrelationClusterWeight > 0 && maxCorrelationClusterWeight <= 1)) throw new RangeError("maxCorrelationClusterWeight must be in (0, 1]");
  const pools = Object.fromEntries(FOUR_MARKET_SLOTS.map((slot) => [slot, []]));
  for (const candidate of candidates) {
    const slot = championSlot(candidate ?? {});
    if (!pools[slot] || !candidateEligible(candidate)) continue;
    pools[slot].push(candidate);
  }
  const rankings = {};
  const selected = [];
  for (const slot of FOUR_MARKET_SLOTS) {
    const ranked = pools[slot].sort((left, right) => right.qualityScore - left.qualityScore || String(left.strategyId).localeCompare(String(right.strategyId)));
    rankings[slot] = Object.freeze(ranked);
    const clusterCounts = new Map();
    const maxClusterMembers = Math.max(1, Math.floor(maxPerSlot * maxCorrelationClusterWeight));
    for (const candidate of ranked) {
      if (selected.filter((item) => item.slot === slot).length >= maxPerSlot) break;
      const cluster = requiredText(candidate.correlationCluster ?? `UNCLASSIFIED:${candidate.strategyId}`, "correlationCluster");
      const count = clusterCounts.get(cluster) ?? 0;
      if (count >= maxClusterMembers) continue;
      clusterCounts.set(cluster, count + 1);
      selected.push(Object.freeze({ slot, strategyId: candidate.strategyId, qualityScore: candidate.qualityScore, correlationCluster: cluster }));
    }
  }
  const riskBudget = selected.length === 0 ? null : Number((1 / selected.length).toFixed(8));
  const portfolio = Object.freeze(selected.map((item) => Object.freeze({ ...item, strategyRiskBudget: riskBudget })));
  return Object.freeze({
    schemaVersion: 1,
    rankings: Object.freeze(rankings),
    KR_bestValidatedStrategy: rankings.KR_STOCK[0]?.strategyId ?? "NONE/INSUFFICIENT_EVIDENCE",
    US_bestValidatedStrategy: rankings.US_STOCK[0]?.strategyId ?? "NONE/INSUFFICIENT_EVIDENCE",
    SPOT_bestValidatedStrategy: rankings.CRYPTO_SPOT[0]?.strategyId ?? "NONE/INSUFFICIENT_EVIDENCE",
    FUTURES_LONG_bestValidatedStrategy: rankings.CRYPTO_FUTURES_LONG[0]?.strategyId ?? "NONE/INSUFFICIENT_EVIDENCE",
    FUTURES_SHORT_bestValidatedStrategy: rankings.CRYPTO_FUTURES_SHORT[0]?.strategyId ?? "NONE/INSUFFICIENT_EVIDENCE",
    currentChampionPortfolio: portfolio.length > 0 ? portfolio : "NONE/INSUFFICIENT_EVIDENCE",
    bestDefinition: "BEST_CURRENTLY_EVIDENCE_VALIDATED_NOT_GUARANTEED_PROFIT",
    correlationManagement: Object.freeze({ maxCorrelationClusterWeight, unclassifiedFailClosedToUniqueCluster: true }),
    profitabilityGuaranteed: false,
    safety: safetyEnvelope(),
  });
}

export function buildCanonicalScannerLifecycleIntents({ championPortfolio, canonicalPromotionDecisions = [], canonicalHealth = [], currentlyScannerEligible = [] } = {}) {
  const selectedIds = new Set(Array.isArray(championPortfolio?.currentChampionPortfolio) ? championPortfolio.currentChampionPortfolio.map((item) => item.strategyId) : []);
  const promotion = new Map(canonicalPromotionDecisions.map((item) => [item.strategyId, item]));
  const health = new Map(canonicalHealth.map((item) => [item.strategyId, item]));
  const promote = [];
  const suspend = [];
  for (const strategyId of [...selectedIds].sort()) {
    const promotionDecision = promotion.get(strategyId);
    const healthDecision = health.get(strategyId);
    if (promotionDecision?.status === "PASS" && promotionDecision?.scannerEligible === true && healthDecision?.status === "ACTIVE") promote.push(strategyId);
  }
  for (const strategyId of [...new Set(currentlyScannerEligible)].sort()) {
    const promotionDecision = promotion.get(strategyId);
    const healthDecision = health.get(strategyId);
    if (!selectedIds.has(strategyId) || promotionDecision?.status !== "PASS" || promotionDecision?.scannerEligible !== true || healthDecision?.status !== "ACTIVE") suspend.push(strategyId);
  }
  const preflight = promote.filter((strategyId) => promotion.get(strategyId)?.autoTradingPreflightEligible === true);
  return Object.freeze({
    schemaVersion: 1,
    canonicalScannerOwnerRef: "#210",
    canonicalPromotionOwnerRef: "#244",
    canonicalHealthOwnerRef: "#247",
    promoteIntents: Object.freeze(promote.map((strategyId) => Object.freeze({ strategyId, action: "REQUEST_CANONICAL_SCANNER_PROMOTION", ownerMutation: false }))),
    suspendIntents: Object.freeze(suspend.map((strategyId) => Object.freeze({ strategyId, action: "REQUEST_CANONICAL_SCANNER_SUSPENSION", ownerMutation: false }))),
    scannerEligibleStrategies: Object.freeze(promote),
    scannerSuspendedStrategies: Object.freeze(suspend),
    autoTradingPreflightEligibleStrategies: Object.freeze(preflight),
    AUTO_TRADING_PREFLIGHT_ELIGIBLE: preflight.length > 0,
    liveTradingEligible: false,
    activationRequested: false,
    ownerMutation: false,
    safety: safetyEnvelope(),
  });
}

function evidenceCount(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}

export function buildAutonomousResearchFactoryStatus(input = {}) {
  const champion = input.championPortfolio ?? buildFourMarketChampionPortfolio([]);
  const scanner = input.scannerLifecycle ?? buildCanonicalScannerLifecycleIntents({ championPortfolio: champion });
  const review = input.dualAiReview ?? {};
  const dualAiReviewStatus = DUAL_AI_STATUSES.has(review.status) ? review.status : "AI_REVIEW_INCOMPLETE";
  const accountingRaw = input.evidenceAccounting ?? {};
  const evidenceAccounting = Object.freeze(Object.fromEntries([
    "externalStudyCount",
    "effectiveIndependentStudyCount",
    "externalObservationN",
    "externalDatasetObservationN",
    "ourReplicationN",
    "ourOosN",
    "ourWalkForwardN",
    "ourHoldoutN",
    "ourShadowN",
    "ourPaperN",
    "ourSettledN",
  ].map((name) => [name, evidenceCount(accountingRaw[name] ?? 0, name)])));
  const blockers = Object.freeze([...(input.activationReadiness?.blockers ?? [])]);
  return Object.freeze({
    schemaVersion: 1,
    kind: "AUTONOMOUS_GLOBAL_RESEARCH_FACTORY_RESEARCH_CENTER_V1",
    generatedAt: requiredTimestamp(input.generatedAt, "generatedAt"),
    AUTONOMOUS_RESEARCH_FACTORY_ACTIVE: false,
    codeComplete: input.codeComplete === true,
    activationReady: input.activationReadiness?.ready === true && blockers.length === 0,
    activationRequested: false,
    blockers,
    KR_bestValidatedStrategy: champion.KR_bestValidatedStrategy,
    US_bestValidatedStrategy: champion.US_bestValidatedStrategy,
    SPOT_bestValidatedStrategy: champion.SPOT_bestValidatedStrategy,
    FUTURES_LONG_bestValidatedStrategy: champion.FUTURES_LONG_bestValidatedStrategy,
    FUTURES_SHORT_bestValidatedStrategy: champion.FUTURES_SHORT_bestValidatedStrategy,
    dualAiReviewStatus,
    ai1Review: review.ai1Review ?? "NONE/INSUFFICIENT_EVIDENCE",
    ai2Review: review.ai2Review ?? "NONE/INSUFFICIENT_EVIDENCE",
    reviewConflictReason: review.conflictReason ?? "NONE/INSUFFICIENT_EVIDENCE",
    scannerEligibleStrategies: scanner.scannerEligibleStrategies,
    scannerSuspendedStrategies: scanner.scannerSuspendedStrategies,
    autoTradingPreflightEligibleStrategies: scanner.autoTradingPreflightEligibleStrategies,
    currentChampionPortfolio: champion.currentChampionPortfolio,
    evidenceAccounting,
    missingEvidenceRenderedAsZero: false,
    bestMeansGuaranteedProfit: false,
    ownerRefs: Object.freeze({ queueBacktestCache: "#226", evidenceDedup: "#482", finalHoldout: "CANONICAL_FINAL_HOLDOUT", shadow: "#419", paper: "#299", settlement: "CANONICAL_SETTLEMENT", health: "#247", promotion: "#244", scanner: "#210" }),
    safety: safetyEnvelope(),
  });
}

export function buildAutonomousResearchActivationReadiness(input = {}) {
  const blockers = [];
  if (!input.persistenceStateRoot) blockers.push("PERSISTENCE_STATE_ROOT_REQUIRED");
  if (input.freeProviderCount !== 2) blockers.push("EXACTLY_TWO_DISTINCT_FREE_AI_PROVIDERS_REQUIRED");
  if (input.canonicalBacktestCallbacksReady !== true) blockers.push("CANONICAL_BACKTEST_CALLBACKS_REQUIRED");
  if (input.canonicalLifecycleAdaptersReady !== true) blockers.push("CANONICAL_LIFECYCLE_ADAPTERS_REQUIRED");
  if (input.serverCapacityValidated !== true) blockers.push("SERVER_CAPACITY_VALIDATION_REQUIRED");
  if (input.immutableDecisionPolicyReady !== true) blockers.push("IMMUTABLE_DECISION_POLICY_REQUIRED");
  return Object.freeze({
    schemaVersion: 1,
    ready: blockers.length === 0,
    blockers: Object.freeze(blockers),
    requiresSeparateApproval: true,
    deploymentRequested: false,
    serverRestartRequested: false,
    timerActivationRequested: false,
    scannerActivationRequested: false,
    safety: safetyEnvelope(),
  });
}

export function buildAutonomousFactoryContractFixtureTrace({ traceId = "AUTONOMOUS_FACTORY_CONTRACT_FIXTURE_V1" } = {}) {
  return Object.freeze({
    schemaVersion: 1,
    traceId,
    evidenceClass: "CONTRACT_FIXTURE_ONLY",
    stages: Object.freeze([
      "WORLD_RESEARCH_METADATA",
      "PAPER_GENOME_STRATEGY_DNA",
      "DUAL_FREE_AI_ROLE_REVERSAL",
      "BOUNDED_FORMULA_DSL",
      "CANONICAL_QUEUE_CACHE_BACKTEST",
      "STATISTICAL_COST_OOS_WF_REGIME",
      "FROZEN_CANDIDATE",
      "ONE_SHOT_FINAL_HOLDOUT",
      "CANONICAL_SHADOW",
      "CANONICAL_PAPER",
      "CANONICAL_SETTLEMENT_HEALTH",
      "FOUR_MARKET_CHAMPIONS",
      "CANONICAL_SCANNER_PROMOTE_DEMOTE_PREFLIGHT",
    ]),
    profitabilityEvidence: false,
    activationEvidence: false,
    naturalForwardEvidence: false,
    liveTradingEvidence: false,
    safety: safetyEnvelope(),
  });
}
