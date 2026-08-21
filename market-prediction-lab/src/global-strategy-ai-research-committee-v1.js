import { researchDigest } from "./research-trial-registry.js";

export const GLOBAL_STRATEGY_AI_COMMITTEE_SCHEMA_VERSION = 1;
export const AI_RESEARCH_COMMITTEE_ROLES = Object.freeze([
  "EVIDENCE_REVIEWER",
  "REPLICATION_CRITIC",
  "STATISTICAL_SKEPTIC",
  "ECONOMIC_REALITY_AUDITOR",
  "ADVERSARIAL_REVIEWER",
  "SYNTHESIS_CHAIR",
]);

const ROLE_SET = new Set(AI_RESEARCH_COMMITTEE_ROLES);
const PROVIDER_STATES = new Set(["AVAILABLE", "UNAVAILABLE", "NOT_CONFIGURED"]);
const REVIEW_CONCLUSIONS = new Set([
  "SUPPORTS_FURTHER_RESEARCH",
  "OPPOSES_FURTHER_RESEARCH",
  "INSUFFICIENT_EVIDENCE",
]);

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function normalizeStringList(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return Object.freeze([...new Set(value.map((item, index) => requiredString(item, `${name}[${index}]`)))].sort());
}

function committeeSafety() {
  return Object.freeze({
    advisoryOnly: true,
    aiGeneratedNumbersAreEvidence: false,
    aiCanChangeCanonicalMetrics: false,
    aiCanProveProfitability: false,
    aiCanPromoteStrategy: false,
    aiCanSelectChampion: false,
    aiCanEnableScanner: false,
    aiCanTrade: false,
    paidFallbackAllowed: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
    actualProviderCalls: 0,
    actualPaidProviderCalls: 0,
    actualOrders: 0,
    actualCancels: 0,
    actualAmends: 0,
    actualTransfers: 0,
    actualWithdrawals: 0,
  });
}

function normalizeProvider(raw, index) {
  const providerId = requiredString(raw?.providerId, `providers[${index}].providerId`);
  const modelId = requiredString(raw?.modelId, `providers[${index}].modelId`);
  const billingTier = requiredString(raw?.billingTier, `providers[${index}].billingTier`).toUpperCase();
  if (!new Set(["FREE", "PAID"]).has(billingTier)) throw new RangeError("provider billingTier is unsupported");
  const state = requiredString(raw?.state, `providers[${index}].state`).toUpperCase();
  if (!PROVIDER_STATES.has(state)) throw new RangeError("provider state is unsupported");
  const priority = raw?.priority;
  if (!Number.isInteger(priority) || priority < 0) throw new RangeError("provider priority must be a non-negative integer");
  const supportedRoles = normalizeStringList(raw?.supportedRoles ?? AI_RESEARCH_COMMITTEE_ROLES, `providers[${index}].supportedRoles`);
  if (supportedRoles.some((role) => !ROLE_SET.has(role))) throw new RangeError("provider supports an unknown committee role");
  return Object.freeze({ providerId, modelId, billingTier, state, priority, supportedRoles });
}

function providerChoices(providers, role, failedProviderIds = new Set()) {
  return providers
    .filter((provider) => provider.billingTier === "FREE"
      && provider.state === "AVAILABLE"
      && provider.supportedRoles.includes(role)
      && !failedProviderIds.has(provider.providerId))
    .sort((left, right) => left.priority - right.priority
      || left.providerId.localeCompare(right.providerId)
      || left.modelId.localeCompare(right.modelId));
}

function assignmentFor(providers, role, failedProviderIds = new Set()) {
  const selected = providerChoices(providers, role, failedProviderIds)[0] ?? null;
  return Object.freeze({
    role,
    status: selected ? "FREE_PROVIDER_SELECTED" : "AI_RESEARCH_UNAVAILABLE",
    providerId: selected?.providerId ?? null,
    modelId: selected?.modelId ?? null,
    billingTier: selected?.billingTier ?? null,
    paidFallbackUsed: false,
  });
}

function planCore({ committeeId, evidenceFingerprint, providers, assignments, failedProviderIds }) {
  return Object.freeze({ committeeId, evidenceFingerprint, providers, assignments, failedProviderIds });
}

function withPlanDigest(core) {
  const unavailableRoles = Object.freeze(core.assignments.filter((assignment) => assignment.status === "AI_RESEARCH_UNAVAILABLE").map((assignment) => assignment.role));
  return Object.freeze({
    schemaVersion: GLOBAL_STRATEGY_AI_COMMITTEE_SCHEMA_VERSION,
    ...core,
    status: unavailableRoles.length ? "AI_RESEARCH_UNAVAILABLE" : "COMMITTEE_PLAN_READY",
    unavailableRoles,
    freeProviderFirst: true,
    paidFallbackUsed: false,
    planDigest: researchDigest(core),
    safety: committeeSafety(),
  });
}

export function createAiResearchCommitteePlan({ committeeId = "GLOBAL_STRATEGY_AI_RESEARCH_V1", evidenceFingerprint, providers = [] } = {}) {
  if (!Array.isArray(providers)) throw new TypeError("providers must be an array");
  const normalizedProviders = Object.freeze(providers.map(normalizeProvider));
  const providerIds = normalizedProviders.map((provider) => provider.providerId);
  if (providerIds.length !== new Set(providerIds).size) throw new Error("DUPLICATE_PROVIDER_ID");
  const assignments = Object.freeze(AI_RESEARCH_COMMITTEE_ROLES.map((role) => assignmentFor(normalizedProviders, role)));
  return withPlanDigest(planCore({
    committeeId: requiredString(committeeId, "committeeId"),
    evidenceFingerprint: requiredString(evidenceFingerprint, "evidenceFingerprint"),
    providers: normalizedProviders,
    assignments,
    failedProviderIds: Object.freeze([]),
  }));
}

export function verifyAiResearchCommitteePlan(plan) {
  if (!plan || plan.schemaVersion !== GLOBAL_STRATEGY_AI_COMMITTEE_SCHEMA_VERSION) return false;
  const core = planCore({
    committeeId: plan.committeeId,
    evidenceFingerprint: plan.evidenceFingerprint,
    providers: plan.providers,
    assignments: plan.assignments,
    failedProviderIds: plan.failedProviderIds,
  });
  return plan.planDigest === researchDigest(core)
    && plan.paidFallbackUsed === false
    && plan.assignments?.every((assignment) => assignment.billingTier !== "PAID" && assignment.paidFallbackUsed === false)
    && plan.safety?.aiCanPromoteStrategy === false
    && plan.safety?.executionAuthority === "NONE";
}

export function failAiResearchProvider(plan, { providerId, failureClass } = {}) {
  if (!verifyAiResearchCommitteePlan(plan)) throw new Error("AI_RESEARCH_COMMITTEE_PLAN_INVALID");
  const normalizedProviderId = requiredString(providerId, "providerId");
  if (!plan.providers.some((provider) => provider.providerId === normalizedProviderId)) throw new Error("UNKNOWN_PROVIDER_ID");
  requiredString(failureClass, "failureClass");
  const failedProviderIds = Object.freeze([...new Set([...plan.failedProviderIds, normalizedProviderId])].sort());
  const failedSet = new Set(failedProviderIds);
  const assignments = Object.freeze(AI_RESEARCH_COMMITTEE_ROLES.map((role) => assignmentFor(plan.providers, role, failedSet)));
  return withPlanDigest(planCore({
    committeeId: plan.committeeId,
    evidenceFingerprint: plan.evidenceFingerprint,
    providers: plan.providers,
    assignments,
    failedProviderIds,
  }));
}

function normalizeFinding(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`findings[${index}] must be an object`);
  return Object.freeze({
    category: requiredString(raw.category, `findings[${index}].category`),
    statement: requiredString(raw.statement, `findings[${index}].statement`),
    evidenceReferences: normalizeStringList(raw.evidenceReferences ?? [], `findings[${index}].evidenceReferences`),
  });
}

function assertNoNumericAuthority(raw) {
  for (const field of ["numericalEvidence", "probabilityEstimate", "performanceEstimate", "promotionScore", "winRateEstimate"]) {
    if (raw?.[field] != null) throw new Error(`AI_NUMERIC_AUTHORITY_FORBIDDEN:${field}`);
  }
}

export function createAiResearchReview({ plan, review } = {}) {
  if (!verifyAiResearchCommitteePlan(plan)) throw new Error("AI_RESEARCH_COMMITTEE_PLAN_INVALID");
  const raw = review ?? {};
  assertNoNumericAuthority(raw);
  const role = requiredString(raw.role, "review.role").toUpperCase();
  if (!ROLE_SET.has(role)) throw new RangeError("review.role is unsupported");
  const assignment = plan.assignments.find((item) => item.role === role);
  if (assignment?.status !== "FREE_PROVIDER_SELECTED") throw new Error("AI_RESEARCH_UNAVAILABLE");
  const providerId = requiredString(raw.providerId, "review.providerId");
  const modelId = requiredString(raw.modelId, "review.modelId");
  if (providerId !== assignment.providerId || modelId !== assignment.modelId) throw new Error("REVIEW_PROVIDER_ASSIGNMENT_MISMATCH");
  const evidenceFingerprint = requiredString(raw.evidenceFingerprint, "review.evidenceFingerprint");
  if (evidenceFingerprint !== plan.evidenceFingerprint) throw new Error("REVIEW_EVIDENCE_FINGERPRINT_MISMATCH");
  const conclusion = requiredString(raw.conclusion, "review.conclusion").toUpperCase();
  if (!REVIEW_CONCLUSIONS.has(conclusion)) throw new RangeError("review.conclusion is unsupported");
  if (!Array.isArray(raw.findings) || raw.findings.length === 0) throw new TypeError("review.findings are required");
  const core = Object.freeze({
    committeeId: plan.committeeId,
    planDigest: plan.planDigest,
    evidenceFingerprint,
    role,
    providerId,
    modelId,
    conclusion,
    findings: Object.freeze(raw.findings.map(normalizeFinding)),
    limitations: normalizeStringList(raw.limitations ?? [], "review.limitations"),
    suggestedDeterministicTests: normalizeStringList(raw.suggestedDeterministicTests ?? [], "review.suggestedDeterministicTests"),
  });
  return Object.freeze({
    schemaVersion: GLOBAL_STRATEGY_AI_COMMITTEE_SCHEMA_VERSION,
    ...core,
    reviewId: `ai-research-review:${researchDigest(core)}`,
    numericalEvidence: null,
    promotionScore: null,
    safety: committeeSafety(),
  });
}

function verifyReview(plan, review) {
  if (!review || review.schemaVersion !== GLOBAL_STRATEGY_AI_COMMITTEE_SCHEMA_VERSION) return false;
  const core = {
    committeeId: review.committeeId,
    planDigest: review.planDigest,
    evidenceFingerprint: review.evidenceFingerprint,
    role: review.role,
    providerId: review.providerId,
    modelId: review.modelId,
    conclusion: review.conclusion,
    findings: review.findings,
    limitations: review.limitations,
    suggestedDeterministicTests: review.suggestedDeterministicTests,
  };
  return review.reviewId === `ai-research-review:${researchDigest(core)}`
    && review.committeeId === plan.committeeId
    && review.planDigest === plan.planDigest
    && review.evidenceFingerprint === plan.evidenceFingerprint
    && review.numericalEvidence === null
    && review.promotionScore === null
    && review.safety?.aiCanPromoteStrategy === false;
}

export function synthesizeAiResearchCommittee({ plan, reviews = [] } = {}) {
  if (!verifyAiResearchCommitteePlan(plan)) throw new Error("AI_RESEARCH_COMMITTEE_PLAN_INVALID");
  if (!Array.isArray(reviews)) throw new TypeError("reviews must be an array");
  if (reviews.some((review) => !verifyReview(plan, review))) throw new Error("AI_RESEARCH_REVIEW_INVALID");
  const reviewRoles = reviews.map((review) => review.role);
  if (reviewRoles.length !== new Set(reviewRoles).size) throw new Error("DUPLICATE_ROLE_REVIEW");
  const missingRoles = Object.freeze(AI_RESEARCH_COMMITTEE_ROLES.filter((role) => !reviewRoles.includes(role)));
  const conclusionSet = new Set(reviews.map((review) => review.conclusion));
  const directionalConflict = conclusionSet.has("SUPPORTS_FURTHER_RESEARCH") && conclusionSet.has("OPPOSES_FURTHER_RESEARCH");
  let status = "ADVISORY_REVIEW_COMPLETE";
  if (plan.status !== "COMMITTEE_PLAN_READY" || missingRoles.length) status = "INCOMPLETE_REVIEW";
  else if (directionalConflict) status = "REVIEW_CONFLICT";
  else if (conclusionSet.size === 1 && conclusionSet.has("INSUFFICIENT_EVIDENCE")) status = "INSUFFICIENT_EVIDENCE";
  const preservedOpinions = Object.freeze(reviews
    .map((review) => Object.freeze({ role: review.role, conclusion: review.conclusion, reviewId: review.reviewId }))
    .sort((left, right) => left.role.localeCompare(right.role)));
  return Object.freeze({
    schemaVersion: GLOBAL_STRATEGY_AI_COMMITTEE_SCHEMA_VERSION,
    status,
    committeeId: plan.committeeId,
    planDigest: plan.planDigest,
    evidenceFingerprint: plan.evidenceFingerprint,
    reviewCount: reviews.length,
    missingRoles,
    preservedOpinions,
    disagreementPreserved: directionalConflict,
    consensusScore: null,
    probabilityEstimate: null,
    performanceEstimate: null,
    deterministicRetestRequired: true,
    profitabilityProven: false,
    promotionEligible: false,
    scannerEligible: false,
    championEligible: false,
    safety: committeeSafety(),
  });
}
