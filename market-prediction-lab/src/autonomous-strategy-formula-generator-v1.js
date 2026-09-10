import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  assertHypothesisDecisionV1,
  assertStrategyHypothesisV1,
} from "../../packages/strategy-hypothesis/src/index.js";
import { researchDigest } from "./research-trial-registry.js";

export const AUTONOMOUS_STRATEGY_DSL_SCHEMA_VERSION = 1;
export const STRATEGY_GENERATION_KINDS = Object.freeze([
  "EXACT_PUBLISHED_STRATEGY",
  "JUSTIFIED_PUBLISHED_VARIANT",
  "SUPPORTED_FAMILY_COMBINATION",
  "MARKET_SPECIFIC_ADAPTATION",
  "AI_PROPOSED_RESEARCH_HYPOTHESIS",
]);
export const STRATEGY_NOVELTY_STATES = Object.freeze([
  "NEW_RESEARCH_HYPOTHESIS",
  "KNOWN_VARIANT",
  "DUPLICATE_TRIAL",
  "PREVIOUSLY_REJECTED",
  "EXISTING_ACTIVE_CANDIDATE",
]);
export const DUAL_AI_REVIEW_STATES = Object.freeze([
  "AI_REVIEW_AGREE",
  "AI_REVIEW_CONFLICT",
  "AI_REVIEW_BOTH_REJECT",
  "AI_REVIEW_INCOMPLETE",
]);

const SHA40 = /^[0-9a-f]{40}$/i;
const GENERATION_SET = new Set(STRATEGY_GENERATION_KINDS);
const MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
const DIRECTIONS = Object.freeze({
  KR_STOCK: new Set(["BUY"]),
  US_STOCK: new Set(["BUY"]),
  CRYPTO_SPOT: new Set(["BUY"]),
  CRYPTO_FUTURES: new Set(["LONG", "SHORT"]),
});
const BASE_FEATURES = Object.freeze([
  "RETURNS", "MOMENTUM", "TREND", "VWAP", "RVOL", "ATR", "VOLATILITY",
  "BREAKOUT", "MEAN_REVERSION", "RELATIVE_STRENGTH", "LIQUIDITY", "REGIME",
  "EVENT_EVIDENCE", "BENCHMARK_RETURNS",
]);
export const MARKET_FEATURE_ALLOWLIST = Object.freeze({
  KR_STOCK: Object.freeze([...BASE_FEATURES, "CORPORATE_ACTIONS", "SESSION"]),
  US_STOCK: Object.freeze([...BASE_FEATURES, "CORPORATE_ACTIONS", "SESSION"]),
  CRYPTO_SPOT: Object.freeze([...BASE_FEATURES]),
  CRYPTO_FUTURES: Object.freeze([...BASE_FEATURES, "FUNDING", "OPEN_INTEREST", "BASIS"]),
});
const OPS = new Set([
  "FEATURE", "CONSTANT", "GT", "GTE", "LT", "LTE", "EQ", "AND", "OR", "NOT",
  "ADD", "SUBTRACT", "MULTIPLY", "DIVIDE", "ABS", "CROSS_ABOVE", "CROSS_BELOW",
]);
const BINARY_OPS = new Set(["GT", "GTE", "LT", "LTE", "EQ", "AND", "OR", "ADD", "SUBTRACT", "MULTIPLY", "DIVIDE", "CROSS_ABOVE", "CROSS_BELOW"]);
const UNARY_OPS = new Set(["NOT", "ABS"]);
const REVIEW_SLOTS = Object.freeze([
  Object.freeze({ slot: "AI1_RESEARCHER_PROPOSER", providerPosition: 0, role: "EVIDENCE_REVIEWER" }),
  Object.freeze({ slot: "AI2_ADVERSARIAL_REVIEWER", providerPosition: 1, role: "ADVERSARIAL_REVIEWER" }),
  Object.freeze({ slot: "AI2_ALTERNATIVE_PROPOSER", providerPosition: 1, role: "EVIDENCE_REVIEWER" }),
  Object.freeze({ slot: "AI1_ADVERSARIAL_REVIEWER", providerPosition: 0, role: "ADVERSARIAL_REVIEWER" }),
]);
const REVIEW_CONCLUSIONS = new Set(["PROPOSE_DETERMINISTIC_TEST", "REJECT_HYPOTHESIS", "INSUFFICIENT_EVIDENCE"]);

// The historical #550 branch was stacked on the separate #548 committee PR.
// Phase 1 is now stacked directly on #672, so retain only the small immutable
// plan contract required by the legacy #555 consumer without importing or
// duplicating the committee engine.
function createAiResearchCommitteePlan({ committeeId, evidenceFingerprint, providers }) {
  const core = Object.freeze({ committeeId, evidenceFingerprint, providers: Object.freeze(providers.map((provider) => Object.freeze({ ...provider }))) });
  return Object.freeze({ ...core, planDigest: researchDigest(core), executionAuthority: "NONE" });
}

function verifyAiResearchCommitteePlan(plan) {
  if (!plan || plan.executionAuthority !== "NONE" || !Array.isArray(plan.providers)) return false;
  const core = { committeeId: plan.committeeId, evidenceFingerprint: plan.evidenceFingerprint, providers: plan.providers };
  return plan.planDigest === researchDigest(core);
}

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function assertKnownKeys(value, allowed, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(code);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${code}:${unknown.sort().join(",")}`);
}

function textList(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return Object.freeze([...new Set(value.map((item, index) => requiredText(item, `${name}[${index}]`)))].sort());
}

function canonicalJson(value, name) {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${name} must contain finite values`);
    return value;
  }
  if (Array.isArray(value)) return Object.freeze(value.map((item, index) => canonicalJson(item, `${name}[${index}]`)));
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.freeze(Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key], `${name}.${key}`)])));
  }
  throw new TypeError(`${name} must contain JSON values only`);
}

function formulaSafety() {
  return Object.freeze({
    boundedDslOnly: true,
    arbitraryExecutableCodeAllowed: false,
    futureLeakageAllowed: false,
    lookAheadAllowed: false,
    fabricatedPricesAllowed: false,
    fabricatedLabelsAllowed: false,
    hiddenWeightsAllowed: false,
    hiddenTransactionCostsAllowed: false,
    unsupportedLeverageAllowed: false,
    aiCanDecideProfitability: false,
    paidAutoFallback: false,
    scannerEligible: false,
    autoTradingPreflightEligible: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
    actualOrders: 0,
    actualCancels: 0,
    actualAmends: 0,
    actualTransfers: 0,
    actualWithdrawals: 0,
  });
}

function normalizeFreeProviders(providers) {
  if (!Array.isArray(providers)) throw new TypeError("providers must be an array");
  const rows = providers.map((provider, index) => Object.freeze({
    providerId: requiredText(provider?.providerId, `providers[${index}].providerId`),
    modelId: requiredText(provider?.modelId, `providers[${index}].modelId`),
    billingTier: requiredText(provider?.billingTier, `providers[${index}].billingTier`).toUpperCase(),
    state: requiredText(provider?.state, `providers[${index}].state`).toUpperCase(),
    priority: Number.isInteger(provider?.priority) && provider.priority >= 0 ? provider.priority : index,
    supportedRoles: textList(provider?.supportedRoles ?? ["EVIDENCE_REVIEWER", "ADVERSARIAL_REVIEWER", "REPLICATION_CRITIC", "STATISTICAL_SKEPTIC", "ECONOMIC_REALITY_AUDITOR", "SYNTHESIS_CHAIR"], `providers[${index}].supportedRoles`),
  }));
  const ids = rows.map((row) => row.providerId);
  if (ids.length !== new Set(ids).size) throw new Error("DUPLICATE_PROVIDER_ID");
  return Object.freeze(rows.filter((row) => row.billingTier === "FREE" && row.state === "AVAILABLE")
    .sort((left, right) => left.priority - right.priority || left.providerId.localeCompare(right.providerId)));
}

export function createDualFreeAiReviewPlan({ evidenceFingerprint, providers = [] } = {}) {
  const fingerprint = requiredText(evidenceFingerprint, "evidenceFingerprint");
  const free = normalizeFreeProviders(providers);
  const selected = Object.freeze(free.slice(0, 2));
  const canonicalPlans = Object.freeze(selected.map((provider, index) => createAiResearchCommitteePlan({
    committeeId: `DUAL_FREE_AI_${index + 1}`,
    evidenceFingerprint: fingerprint,
    providers: [provider],
  })));
  const slots = Object.freeze(REVIEW_SLOTS.map((slot) => {
    const provider = selected[slot.providerPosition] ?? null;
    return Object.freeze({
      ...slot,
      providerId: provider?.providerId ?? null,
      modelId: provider?.modelId ?? null,
      status: provider && provider.supportedRoles.includes(slot.role) ? "FREE_PROVIDER_SELECTED" : "AI_RESEARCH_UNAVAILABLE",
    });
  }));
  const core = Object.freeze({ evidenceFingerprint: fingerprint, providers: selected, canonicalPlans, slots });
  return Object.freeze({
    schemaVersion: AUTONOMOUS_STRATEGY_DSL_SCHEMA_VERSION,
    ...core,
    status: selected.length === 2 && slots.every((slot) => slot.status === "FREE_PROVIDER_SELECTED") ? "DUAL_FREE_AI_READY" : "AI_REVIEW_INCOMPLETE",
    paidAutoFallback: false,
    planDigest: researchDigest(core),
    safety: formulaSafety(),
  });
}

export function verifyDualFreeAiReviewPlan(plan) {
  if (!plan || plan.schemaVersion !== AUTONOMOUS_STRATEGY_DSL_SCHEMA_VERSION) return false;
  const core = { evidenceFingerprint: plan.evidenceFingerprint, providers: plan.providers, canonicalPlans: plan.canonicalPlans, slots: plan.slots };
  return plan.planDigest === researchDigest(core)
    && plan.providers?.length <= 2
    && new Set(plan.providers?.map((provider) => provider.providerId)).size === plan.providers?.length
    && plan.providers?.every((provider) => provider.billingTier === "FREE")
    && plan.canonicalPlans?.every(verifyAiResearchCommitteePlan)
    && plan.paidAutoFallback === false;
}

function assertNoAiNumericAuthority(raw) {
  for (const field of ["pf", "ev", "mdd", "sharpe", "dsr", "pbo", "winRate", "sampleN", "cost", "promotionStatus", "profitabilityPass"]) {
    if (raw?.[field] != null) throw new Error(`AI_NUMERIC_AUTHORITY_FORBIDDEN:${field}`);
  }
}

export function recordDualFreeAiReview(plan, raw) {
  if (!verifyDualFreeAiReviewPlan(plan)) throw new Error("DUAL_FREE_AI_PLAN_INVALID");
  assertNoAiNumericAuthority(raw);
  const slot = requiredText(raw?.slot, "review.slot").toUpperCase();
  const assignment = plan.slots.find((item) => item.slot === slot);
  if (!assignment || assignment.status !== "FREE_PROVIDER_SELECTED") throw new Error("AI_RESEARCH_UNAVAILABLE");
  if (requiredText(raw?.providerId, "review.providerId") !== assignment.providerId) throw new Error("DUAL_AI_PROVIDER_ASSIGNMENT_MISMATCH");
  const conclusion = requiredText(raw?.conclusion, "review.conclusion").toUpperCase();
  if (!REVIEW_CONCLUSIONS.has(conclusion)) throw new RangeError("dual AI review conclusion is unsupported");
  const core = Object.freeze({
    planDigest: plan.planDigest,
    evidenceFingerprint: plan.evidenceFingerprint,
    slot,
    providerId: assignment.providerId,
    modelId: assignment.modelId,
    conclusion,
    mechanismOrChallenge: requiredText(raw?.mechanismOrChallenge, "review.mechanismOrChallenge"),
    expectedRegime: raw?.expectedRegime == null ? null : requiredText(raw.expectedRegime, "review.expectedRegime"),
    findings: textList(raw?.findings ?? [], "review.findings"),
    proposedBoundedVariants: Object.freeze((raw?.proposedBoundedVariants ?? []).map((item, index) => canonicalJson(item, `review.proposedBoundedVariants[${index}]`))),
    deterministicResolution: requiredText(raw?.deterministicResolution, "review.deterministicResolution"),
  });
  return Object.freeze({
    schemaVersion: AUTONOMOUS_STRATEGY_DSL_SCHEMA_VERSION,
    ...core,
    reviewId: `dual-ai-review:${researchDigest(core)}`,
    numericalEvidence: null,
    profitabilityAuthority: false,
    safety: formulaSafety(),
  });
}

function verifyDualReview(plan, review) {
  if (!review || review.schemaVersion !== AUTONOMOUS_STRATEGY_DSL_SCHEMA_VERSION) return false;
  const core = {
    planDigest: review.planDigest,
    evidenceFingerprint: review.evidenceFingerprint,
    slot: review.slot,
    providerId: review.providerId,
    modelId: review.modelId,
    conclusion: review.conclusion,
    mechanismOrChallenge: review.mechanismOrChallenge,
    expectedRegime: review.expectedRegime,
    findings: review.findings,
    proposedBoundedVariants: review.proposedBoundedVariants,
    deterministicResolution: review.deterministicResolution,
  };
  return review.reviewId === `dual-ai-review:${researchDigest(core)}`
    && review.planDigest === plan.planDigest
    && review.evidenceFingerprint === plan.evidenceFingerprint
    && review.numericalEvidence === null;
}

export function synthesizeDualFreeAiReview({ plan, reviews = [] } = {}) {
  if (!verifyDualFreeAiReviewPlan(plan)) throw new Error("DUAL_FREE_AI_PLAN_INVALID");
  if (!Array.isArray(reviews) || reviews.some((review) => !verifyDualReview(plan, review))) throw new Error("DUAL_FREE_AI_REVIEW_INVALID");
  const slots = reviews.map((review) => review.slot);
  if (slots.length !== new Set(slots).size) throw new Error("DUPLICATE_DUAL_AI_REVIEW_SLOT");
  const complete = plan.status === "DUAL_FREE_AI_READY" && REVIEW_SLOTS.every((slot) => slots.includes(slot.slot));
  const conclusions = reviews.map((review) => review.conclusion);
  const rejects = conclusions.filter((conclusion) => conclusion === "REJECT_HYPOTHESIS").length;
  const proposes = conclusions.filter((conclusion) => conclusion === "PROPOSE_DETERMINISTIC_TEST").length;
  let status = "AI_REVIEW_INCOMPLETE";
  if (complete && rejects === reviews.length) status = "AI_REVIEW_BOTH_REJECT";
  else if (complete && rejects > 0 && proposes > 0) status = "AI_REVIEW_CONFLICT";
  else if (complete) status = "AI_REVIEW_AGREE";
  const conflictReasons = status === "AI_REVIEW_CONFLICT"
    ? reviews.filter((review) => review.conclusion !== conclusions[0]).flatMap((review) => review.findings)
    : [];
  return Object.freeze({
    schemaVersion: AUTONOMOUS_STRATEGY_DSL_SCHEMA_VERSION,
    status,
    evidenceFingerprint: plan.evidenceFingerprint,
    reviewIds: Object.freeze(reviews.map((review) => review.reviewId).sort()),
    preservedReviewOutputs: Object.freeze(REVIEW_SLOTS.map((slot) => reviews.find((review) => review.slot === slot.slot) ?? null)),
    ai1Review: Object.freeze(reviews.filter((review) => review.slot.startsWith("AI1_"))),
    ai2Review: Object.freeze(reviews.filter((review) => review.slot.startsWith("AI2_"))),
    reviewConflictReason: conflictReasons.length ? Object.freeze([...new Set(conflictReasons)].sort()) : null,
    deterministicExperimentRequired: status !== "AI_REVIEW_BOTH_REJECT",
    aiReviewCanPassStrategy: false,
    paidAutoFallback: false,
    profitabilityProven: false,
    safety: formulaSafety(),
  });
}

function normalizeAst(node, context, depth = 0, counter = { count: 0 }) {
  if (!node || typeof node !== "object" || Array.isArray(node)) throw new TypeError(`${context.name} AST node must be an object`);
  if (depth > context.maxDepth) throw new Error("STRATEGY_DSL_MAX_DEPTH_EXCEEDED");
  counter.count += 1;
  if (counter.count > context.maxNodes) throw new Error("STRATEGY_DSL_MAX_NODES_EXCEEDED");
  const op = requiredText(node.op, `${context.name}.op`).toUpperCase();
  if (!OPS.has(op)) throw new Error(`STRATEGY_DSL_OP_FORBIDDEN:${op}`);
  if (op === "FEATURE") {
    assertKnownKeys(node, ["op", "feature", "lag"], "STRATEGY_DSL_UNKNOWN_NODE_FIELD");
    counter.indicators = (counter.indicators ?? 0) + 1;
    if (counter.indicators > context.maxIndicatorCount) throw new Error("STRATEGY_DSL_MAX_INDICATORS_EXCEEDED");
    const feature = requiredText(node.feature, `${context.name}.feature`).toUpperCase();
    if (!MARKET_FEATURE_ALLOWLIST[context.market].includes(feature)) throw new Error(`FEATURE_NOT_ALLOWED_FOR_MARKET:${feature}`);
    if (!context.availableFeatures.has(feature)) throw new Error(`FEATURE_UNAVAILABLE:${feature}`);
    if (!Number.isInteger(node.lag) || node.lag < 1) throw new Error(`FUTURE_OR_SAME_BAR_LEAKAGE:${feature}`);
    return Object.freeze({ op, feature, lag: node.lag });
  }
  if (op === "CONSTANT") {
    assertKnownKeys(node, ["op", "value"], "STRATEGY_DSL_UNKNOWN_NODE_FIELD");
    if (!Number.isFinite(node.value) || Math.abs(node.value) > 1_000_000) throw new RangeError("STRATEGY_DSL_CONSTANT_OUT_OF_RANGE");
    return Object.freeze({ op, value: node.value });
  }
  if (BINARY_OPS.has(op)) {
    assertKnownKeys(node, ["op", "args"], "STRATEGY_DSL_UNKNOWN_NODE_FIELD");
    if (!Array.isArray(node.args) || node.args.length !== 2) throw new TypeError(`${op} requires exactly two args`);
    return Object.freeze({ op, args: Object.freeze(node.args.map((arg, index) => normalizeAst(arg, { ...context, name: `${context.name}.args[${index}]` }, depth + 1, counter))) });
  }
  if (UNARY_OPS.has(op)) {
    assertKnownKeys(node, ["op", "args"], "STRATEGY_DSL_UNKNOWN_NODE_FIELD");
    if (!Array.isArray(node.args) || node.args.length !== 1) throw new TypeError(`${op} requires exactly one arg`);
    return Object.freeze({ op, args: Object.freeze([normalizeAst(node.args[0], { ...context, name: `${context.name}.args[0]` }, depth + 1, counter)]) });
  }
  throw new Error(`STRATEGY_DSL_OP_UNHANDLED:${op}`);
}

function normalizeParameters(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("parameters must be an object");
  return Object.freeze(Object.fromEntries(Object.keys(raw).sort().map((name) => {
    const parameter = raw[name];
    assertKnownKeys(parameter, ["value", "min", "max"], "STRATEGY_PARAMETER_UNKNOWN_FIELD");
    if (!parameter || !Number.isFinite(parameter.value) || !Number.isFinite(parameter.min) || !Number.isFinite(parameter.max)) throw new TypeError(`parameter ${name} is invalid`);
    if (parameter.min > parameter.max || parameter.value < parameter.min || parameter.value > parameter.max) throw new RangeError(`parameter ${name} is outside its preregistered bounds`);
    return [name, Object.freeze({ value: parameter.value, min: parameter.min, max: parameter.max })];
  })));
}

export function createBoundedStrategySpecification(raw) {
  assertKnownKeys(raw, [
    "market", "direction", "timeframe", "universe", "availableFeatures", "entryFormula", "exitFormula",
    "parameters", "holdingPeriod", "rebalance", "liquidityRequirement", "risk", "limits",
  ], "STRATEGY_SPECIFICATION_UNKNOWN_FIELD");
  const market = requiredText(raw?.market, "market").toUpperCase();
  if (!MARKETS.has(market)) throw new RangeError("market is unsupported");
  const direction = requiredText(raw?.direction, "direction").toUpperCase();
  if (!DIRECTIONS[market].has(direction)) throw new Error(`DIRECTION_NOT_ALLOWED_FOR_MARKET:${market}:${direction}`);
  const availableFeatures = new Set(textList(raw?.availableFeatures ?? [], "availableFeatures").map((feature) => feature.toUpperCase()));
  if (availableFeatures.size > 16) throw new Error("STRATEGY_DSL_MAX_INDICATORS_EXCEEDED");
  assertKnownKeys(raw?.limits ?? {}, ["maxDepth", "maxNodes", "maxIndicatorCount"], "STRATEGY_DSL_LIMITS_UNKNOWN_FIELD");
  const maxDepth = raw?.limits?.maxDepth ?? 8;
  const maxNodes = raw?.limits?.maxNodes ?? 64;
  const maxIndicatorCount = raw?.limits?.maxIndicatorCount ?? 16;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 8
    || !Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 128
    || !Number.isSafeInteger(maxIndicatorCount) || maxIndicatorCount < 1 || maxIndicatorCount > 16) {
    throw new Error("STRATEGY_DSL_LIMITS_OUT_OF_RANGE");
  }
  const context = { market, availableFeatures, maxDepth, maxNodes, maxIndicatorCount, name: "entryFormula" };
  const counter = { count: 0, indicators: 0 };
  const entryFormula = normalizeAst(raw?.entryFormula, context, 0, counter);
  const exitFormula = normalizeAst(raw?.exitFormula, { ...context, name: "exitFormula" }, 0, counter);
  const parameters = normalizeParameters(raw?.parameters ?? {});
  assertKnownKeys(raw?.risk ?? {}, ["maxLeverage", "supportedLeverageConstraint", "sizingRule"], "STRATEGY_RISK_UNKNOWN_FIELD");
  const maxLeverage = raw?.risk?.maxLeverage ?? 1;
  const supportedLeverageConstraint = raw?.risk?.supportedLeverageConstraint ?? 1;
  if (!Number.isFinite(maxLeverage) || maxLeverage <= 0 || !Number.isFinite(supportedLeverageConstraint) || supportedLeverageConstraint <= 0) throw new RangeError("leverage constraints are invalid");
  if (market !== "CRYPTO_FUTURES" && maxLeverage !== 1) throw new Error("LEVERAGE_FORBIDDEN_FOR_CASH_MARKET");
  if (maxLeverage > supportedLeverageConstraint) throw new Error("UNSUPPORTED_LEVERAGE");
  const core = Object.freeze({
    market,
    direction,
    timeframe: requiredText(raw?.timeframe, "timeframe"),
    universe: canonicalJson(raw?.universe, "universe"),
    availableFeatures: Object.freeze([...availableFeatures].sort()),
    requiredFeatures: Object.freeze([...new Set([...JSON.stringify(entryFormula).matchAll(/\"feature\":\"([^\"]+)\"/g)].map((match) => match[1])
      .concat([...JSON.stringify(exitFormula).matchAll(/\"feature\":\"([^\"]+)\"/g)].map((match) => match[1])))].sort()),
    entryFormula,
    exitFormula,
    parameters,
    limits: Object.freeze({ maxDepth, maxNodes, maxIndicatorCount }),
    holdingPeriod: canonicalJson(raw?.holdingPeriod, "holdingPeriod"),
    rebalance: canonicalJson(raw?.rebalance, "rebalance"),
    liquidityRequirement: canonicalJson(raw?.liquidityRequirement, "liquidityRequirement"),
    risk: Object.freeze({ maxLeverage, supportedLeverageConstraint, sizingRule: canonicalJson(raw?.risk?.sizingRule, "risk.sizingRule") }),
    abstainSupported: true,
    noTradeOutcome: "NO_TRADE",
  });
  return Object.freeze({
    schemaVersion: AUTONOMOUS_STRATEGY_DSL_SCHEMA_VERSION,
    ...core,
    specificationDigest: researchDigest(core),
    safety: formulaSafety(),
  });
}

function verifyDualAiSynthesis(value) {
  return value && DUAL_AI_REVIEW_STATES.includes(value.status) && value.aiReviewCanPassStrategy === false && value.paidAutoFallback === false;
}

export function createBoundedStrategyCandidate({
  specification,
  generationKind,
  researchSourceLinks,
  generationReason,
  strategyFamilyId = null,
  researchCodeSha,
  costPolicyVersion,
  dualAiReview = null,
} = {}) {
  if (!specification || specification.schemaVersion !== AUTONOMOUS_STRATEGY_DSL_SCHEMA_VERSION || specification.safety?.boundedDslOnly !== true) throw new Error("STRATEGY_SPECIFICATION_INVALID");
  const kind = requiredText(generationKind, "generationKind").toUpperCase();
  if (!GENERATION_SET.has(kind)) throw new RangeError("generationKind is unsupported");
  if (!SHA40.test(requiredText(researchCodeSha, "researchCodeSha"))) throw new TypeError("researchCodeSha must be an exact 40-character SHA");
  if (kind === "AI_PROPOSED_RESEARCH_HYPOTHESIS" && !verifyDualAiSynthesis(dualAiReview)) throw new Error("DUAL_FREE_AI_REVIEW_REQUIRED");
  const links = textList(researchSourceLinks ?? [], "researchSourceLinks");
  if (links.length === 0) throw new Error("RESEARCH_SOURCE_LINK_REQUIRED");
  const formulaFingerprint = researchDigest({ entry: specification.entryFormula, exit: specification.exitFormula, features: specification.requiredFeatures });
  const parameterHash = researchDigest(specification.parameters);
  const family = strategyFamilyId == null
    ? `strategy-family:${researchDigest({ market: specification.market, direction: specification.direction, formulaFingerprint })}`
    : requiredText(strategyFamilyId, "strategyFamilyId");
  const identityCore = Object.freeze({
    strategyFamilyId: family,
    market: specification.market,
    direction: specification.direction,
    timeframe: specification.timeframe,
    formulaFingerprint,
    parameterHash,
    researchCodeSha: researchCodeSha.toLowerCase(),
    costPolicyVersion: requiredText(costPolicyVersion, "costPolicyVersion"),
  });
  const strategyId = `strategy:${researchDigest(identityCore)}`;
  const variantId = `variant:${researchDigest({ strategyId, generationKind: kind, generationReason: requiredText(generationReason, "generationReason"), researchSourceLinks: links })}`;
  return Object.freeze({
    schemaVersion: AUTONOMOUS_STRATEGY_DSL_SCHEMA_VERSION,
    strategyId,
    strategyFamilyId: family,
    variantId,
    parameterHash,
    formulaFingerprint,
    researchSourceLinks: links,
    generationKind: kind,
    generationReason: requiredText(generationReason, "generationReason"),
    market: specification.market,
    direction: specification.direction,
    timeframe: specification.timeframe,
    requiredFeatures: specification.requiredFeatures,
    costPolicyVersion: identityCore.costPolicyVersion,
    researchCodeSha: identityCore.researchCodeSha,
    specification,
    dualAiReviewStatus: dualAiReview?.status ?? "AI_REVIEW_INCOMPLETE",
    profitabilityProven: false,
    scannerEligible: false,
    autoTradingPreflightEligible: false,
    safety: formulaSafety(),
  });
}

export function classifyStrategyNovelty(candidate, { knownCandidates = [], trialFingerprints = [], rejectedFingerprints = [], activeCandidateFingerprints = [] } = {}) {
  if (!candidate?.formulaFingerprint || !candidate?.parameterHash) throw new Error("STRATEGY_CANDIDATE_INVALID");
  const exactFingerprint = researchDigest({ strategyFamilyId: candidate.strategyFamilyId, formulaFingerprint: candidate.formulaFingerprint, parameterHash: candidate.parameterHash });
  if (activeCandidateFingerprints.includes(exactFingerprint)) return Object.freeze({ status: "EXISTING_ACTIVE_CANDIDATE", exactFingerprint, enqueueAllowed: false });
  if (rejectedFingerprints.includes(exactFingerprint)) return Object.freeze({ status: "PREVIOUSLY_REJECTED", exactFingerprint, enqueueAllowed: false });
  if (trialFingerprints.includes(exactFingerprint)) return Object.freeze({ status: "DUPLICATE_TRIAL", exactFingerprint, enqueueAllowed: false });
  if (knownCandidates.some((known) => known.strategyFamilyId === candidate.strategyFamilyId || known.formulaFingerprint === candidate.formulaFingerprint)) {
    return Object.freeze({ status: "KNOWN_VARIANT", exactFingerprint, enqueueAllowed: true });
  }
  return Object.freeze({ status: "NEW_RESEARCH_HYPOTHESIS", exactFingerprint, enqueueAllowed: true });
}

export function generateBoundedStrategyVariants({ baseSpecification, parameterVariants = {}, maxCandidates = 32 } = {}) {
  if (!baseSpecification?.parameters) throw new Error("BASE_STRATEGY_SPECIFICATION_REQUIRED");
  if (!Number.isInteger(maxCandidates) || maxCandidates <= 0 || maxCandidates > 128) throw new RangeError("maxCandidates must be between 1 and 128");
  const candidates = [baseSpecification];
  for (const name of Object.keys(parameterVariants).sort()) {
    if (!Object.hasOwn(baseSpecification.parameters, name)) throw new Error(`UNKNOWN_PARAMETER_VARIANT:${name}`);
    const values = [...new Set(parameterVariants[name])].filter(Number.isFinite).sort((a, b) => a - b);
    for (const value of values) {
      if (candidates.length >= maxCandidates) break;
      const bound = baseSpecification.parameters[name];
      if (value < bound.min || value > bound.max || value === bound.value) continue;
      const parameters = Object.fromEntries(Object.entries(baseSpecification.parameters).map(([key, item]) => [key, { ...item, value: key === name ? value : item.value }]));
      candidates.push(createBoundedStrategySpecification({
        market: baseSpecification.market,
        direction: baseSpecification.direction,
        timeframe: baseSpecification.timeframe,
        universe: baseSpecification.universe,
        availableFeatures: baseSpecification.availableFeatures,
        entryFormula: baseSpecification.entryFormula,
        exitFormula: baseSpecification.exitFormula,
        parameters,
        limits: baseSpecification.limits,
        holdingPeriod: baseSpecification.holdingPeriod,
        rebalance: baseSpecification.rebalance,
        liquidityRequirement: baseSpecification.liquidityRequirement,
        risk: baseSpecification.risk,
      }));
    }
  }
  return Object.freeze(candidates);
}

export const SAFE_STRATEGY_DSL_SCHEMA_VERSION = 1;
export const FORMULA_CANDIDATE_SCHEMA_VERSION = 1;
export const GENERATED_FORMULA_CANDIDATE_SCHEMA_VERSION = 1;

export const SAFE_STRATEGY_INDICATORS = Object.freeze([
  "SMA", "EMA", "RSI", "MACD", "ATR", "BOLLINGER", "VWAP", "VOLUME",
  "RVOL", "ROC", "MOMENTUM", "ADX", "VOLATILITY", "BREAKOUT", "REGIME",
]);
export const SAFE_STRATEGY_OPERATORS = Object.freeze([
  "GT", "GTE", "LT", "LTE", "BETWEEN", "CROSSOVER", "CROSSUNDER",
  "RISING", "FALLING", "PERCENTILE",
]);
export const SAFE_STRATEGY_ENTRY_ACTIONS = Object.freeze(["LONG", "SHORT", "NO_TRADE"]);
export const SAFE_STRATEGY_EXIT_TYPES = Object.freeze([
  "FIXED_STOP", "ATR_STOP", "TARGET", "TRAILING_STOP", "TIME_EXIT", "INVALIDATION_EXIT",
]);

export const SAFE_STRATEGY_HARD_LIMITS = Object.freeze({
  maxAstDepth: 8,
  maxIndicatorCount: 16,
  maxRuleCount: 32,
  maxAstNodes: 128,
});

export const CANDIDATE_GENERATOR_HARD_CAPS = Object.freeze({
  maxCandidatesPerHypothesis: 32,
  maxCandidatesPerRun: 128,
  maxGenerations: 8,
  maxParameterCombinations: 10_000,
  maxAstNodes: SAFE_STRATEGY_HARD_LIMITS.maxAstNodes,
  maxRuntimeMs: 60_000,
  maxCpuMs: 60_000,
  maxMemoryBytes: 256 * 1024 * 1024,
});

export const PARAMETER_DOMAIN_POLICY_V1 = Object.freeze({
  PERIOD: Object.freeze({ valueType: "INTEGER", hardMin: 2, hardMax: 500 }),
  RSI_LEVEL: Object.freeze({ valueType: "NUMBER", hardMin: 0, hardMax: 100 }),
  PERCENTILE_LEVEL: Object.freeze({ valueType: "NUMBER", hardMin: 0, hardMax: 100 }),
  POSITIVE_MULTIPLIER: Object.freeze({ valueType: "NUMBER", hardMin: 0.01, hardMax: 20 }),
  PRICE_FRACTION: Object.freeze({ valueType: "NUMBER", hardMin: 0.0001, hardMax: 1 }),
  BAR_COUNT: Object.freeze({ valueType: "INTEGER", hardMin: 1, hardMax: 10_000 }),
  NON_NEGATIVE_VALUE: Object.freeze({ valueType: "NUMBER", hardMin: 0, hardMax: 1_000_000 }),
  SIGNED_VALUE: Object.freeze({ valueType: "NUMBER", hardMin: -1_000_000, hardMax: 1_000_000 }),
});

const P1_MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
const P1_TIMEFRAMES = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d", "1wk", "1mo"]);
const P1_DIRECTIONS = Object.freeze({
  KR_STOCK: new Set(["LONG", "NO_TRADE"]),
  US_STOCK: new Set(["LONG", "NO_TRADE"]),
  CRYPTO_SPOT: new Set(["LONG", "NO_TRADE"]),
  CRYPTO_FUTURES: new Set(["LONG", "SHORT", "NO_TRADE"]),
});
const P1_DIRECTIONALITY = Object.freeze({
  POSITIVE: new Set(["LONG", "NO_TRADE"]),
  NEGATIVE: new Set(["SHORT", "NO_TRADE"]),
  NON_DIRECTIONAL: new Set(["LONG", "SHORT", "NO_TRADE"]),
});
const P1_ASSET_MARKETS = Object.freeze({
  EQUITY: new Set(["KR_STOCK", "US_STOCK"]),
  CRYPTO_SPOT: new Set(["CRYPTO_SPOT"]),
  CRYPTO_FUTURES: new Set(["CRYPTO_FUTURES"]),
  FUTURES: new Set(["CRYPTO_FUTURES"]),
});
const P1_INDICATOR_PARAMETERS = Object.freeze({
  SMA: Object.freeze({ period: ["PERIOD"] }),
  EMA: Object.freeze({ period: ["PERIOD"] }),
  RSI: Object.freeze({ period: ["PERIOD"] }),
  MACD: Object.freeze({ fastPeriod: ["PERIOD"], slowPeriod: ["PERIOD"], signalPeriod: ["PERIOD"] }),
  ATR: Object.freeze({ period: ["PERIOD"] }),
  BOLLINGER: Object.freeze({ period: ["PERIOD"], standardDeviations: ["POSITIVE_MULTIPLIER"] }),
  VWAP: Object.freeze({ period: ["PERIOD"] }),
  VOLUME: Object.freeze({}),
  RVOL: Object.freeze({ period: ["PERIOD"] }),
  ROC: Object.freeze({ period: ["PERIOD"] }),
  MOMENTUM: Object.freeze({ period: ["PERIOD"] }),
  ADX: Object.freeze({ period: ["PERIOD"] }),
  VOLATILITY: Object.freeze({ period: ["PERIOD"] }),
  BREAKOUT: Object.freeze({ period: ["PERIOD"] }),
  REGIME: Object.freeze({ period: ["PERIOD"] }),
});
const P1_INDICATOR_INPUT = Object.freeze({
  SMA: Object.freeze({ input: "close", fields: ["close"] }),
  EMA: Object.freeze({ input: "close", fields: ["close"] }),
  RSI: Object.freeze({ input: "close", fields: ["close"] }),
  MACD: Object.freeze({ input: "close", fields: ["close"] }),
  ATR: Object.freeze({ input: "ohlc", fields: ["close", "high", "low"] }),
  BOLLINGER: Object.freeze({ input: "close", fields: ["close"] }),
  VWAP: Object.freeze({ input: "typical_price", fields: ["close", "high", "low", "volume"] }),
  VOLUME: Object.freeze({ input: "volume", fields: ["volume"] }),
  RVOL: Object.freeze({ input: "volume", fields: ["volume"] }),
  ROC: Object.freeze({ input: "close", fields: ["close"] }),
  MOMENTUM: Object.freeze({ input: "close", fields: ["close"] }),
  ADX: Object.freeze({ input: "ohlc", fields: ["close", "high", "low"] }),
  VOLATILITY: Object.freeze({ input: "close", fields: ["close"] }),
  BREAKOUT: Object.freeze({ input: "close", fields: ["close"] }),
  REGIME: Object.freeze({ input: "regime", fields: ["regime"] }),
});
const P1_OPERATOR_ARITY = Object.freeze({
  GT: 2,
  GTE: 2,
  LT: 2,
  LTE: 2,
  BETWEEN: 3,
  CROSSOVER: 2,
  CROSSUNDER: 2,
  RISING: 2,
  FALLING: 2,
  PERCENTILE: 2,
});
const P1_BOOLEAN_OPERATORS = new Set(["GT", "GTE", "LT", "LTE", "BETWEEN", "CROSSOVER", "CROSSUNDER", "RISING", "FALLING"]);
const P1_SEARCH_METHODS = new Set(["BOUNDED_GRID", "SEEDED_RANDOM", "DETERMINISTIC_SAMPLING"]);
const P1_DATASET_ROLES = new Set(["RESEARCH", "TRAIN", "VALIDATION"]);
const P1_HASH = /^[0-9a-f]{64}$/u;
const P1_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/u;

function p1Fail(code, detail = "") {
  throw new Error(detail ? `${code}:${detail}` : code);
}

function p1Plain(value, code) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) p1Fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) p1Fail(code);
  return value;
}

function p1Exact(value, keys, code) {
  p1Plain(value, code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) p1Fail(code);
}

function p1Text(value, code, { upper = false, lower = false } = {}) {
  if (typeof value !== "string" || !value.trim()) p1Fail(code);
  let normalized = value.trim().normalize("NFC");
  if (upper) normalized = normalized.toUpperCase();
  if (lower) normalized = normalized.toLowerCase();
  return normalized;
}

function p1Identifier(value, code) {
  const normalized = p1Text(value, code);
  if (!P1_IDENTIFIER.test(normalized)) p1Fail(code);
  return normalized;
}

function p1Version(value, code) {
  const normalized = p1Text(value, code);
  if (!/^[0-9A-Za-z][0-9A-Za-z_.-]{0,63}$/u.test(normalized)) p1Fail(code);
  return normalized;
}

function p1Canonical(value, stack = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) p1Fail("CANONICAL_JSON_NON_FINITE_NUMBER");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") p1Fail("CANONICAL_JSON_UNSUPPORTED_VALUE");
  if (stack.has(value)) p1Fail("CANONICAL_JSON_CYCLE");
  stack.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry) => p1Canonical(entry, stack));
  } else {
    p1Plain(value, "CANONICAL_JSON_NON_PLAIN_OBJECT");
    result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) p1Fail("CANONICAL_JSON_UNDEFINED_VALUE");
      result[key] = p1Canonical(value[key], stack);
    }
  }
  stack.delete(value);
  return result;
}

export function canonicalSerializeStrategyFormulaV1(value) {
  return JSON.stringify(p1Canonical(value));
}

function p1Hash(value) {
  return createHash("sha256").update(canonicalSerializeStrategyFormulaV1(value), "utf8").digest("hex");
}

function p1Freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) p1Freeze(child);
  }
  return value;
}

function p1Safety() {
  return p1Freeze({
    boundedDslOnly: true,
    arbitraryExecutableCodeAllowed: false,
    networkAccessAllowed: false,
    fileAccessAllowed: false,
    processAccessAllowed: false,
    systemCommandAllowed: false,
    finalHoldoutParameterAccessAllowed: false,
    shadowHindsightTuningAllowed: false,
    profitabilityClaimAllowed: false,
    championPromotionAllowed: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  });
}

function p1PositiveInteger(value, code, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) p1Fail(code);
  return value;
}

export function normalizeCandidateGenerationBudgetV1(raw) {
  p1Exact(raw, Object.keys(CANDIDATE_GENERATOR_HARD_CAPS), "CANDIDATE_BUDGET_SHAPE_INVALID");
  const result = {};
  for (const [key, cap] of Object.entries(CANDIDATE_GENERATOR_HARD_CAPS)) {
    result[key] = p1PositiveInteger(raw[key], `CANDIDATE_BUDGET_${key.toUpperCase()}_INVALID`, cap);
  }
  if (result.maxCandidatesPerHypothesis > result.maxCandidatesPerRun) p1Fail("CANDIDATE_BUDGET_HYPOTHESIS_EXCEEDS_RUN");
  if (result.maxCpuMs > result.maxRuntimeMs) p1Fail("CANDIDATE_CPU_BUDGET_EXCEEDS_RUNTIME");
  return p1Freeze(result);
}

function p1NormalizeLimits(raw) {
  p1Exact(raw, Object.keys(SAFE_STRATEGY_HARD_LIMITS), "STRATEGY_DSL_LIMITS_SHAPE_INVALID");
  return p1Freeze(Object.fromEntries(Object.entries(SAFE_STRATEGY_HARD_LIMITS).map(([key, cap]) => [
    key,
    p1PositiveInteger(raw[key], `STRATEGY_DSL_${key.toUpperCase()}_INVALID`, cap),
  ])));
}

function p1NormalizeParameterSpace(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) p1Fail("PARAMETER_SPACE_INVALID");
  const rows = raw.map((parameter) => {
    p1Exact(parameter, ["name", "domain", "valueType", "min", "max", "step"], "PARAMETER_SHAPE_INVALID");
    const name = p1Identifier(parameter.name, "PARAMETER_NAME_INVALID");
    const domain = p1Text(parameter.domain, "PARAMETER_DOMAIN_INVALID", { upper: true });
    const policy = PARAMETER_DOMAIN_POLICY_V1[domain];
    if (!policy) p1Fail("PARAMETER_DOMAIN_INVALID", domain);
    const valueType = p1Text(parameter.valueType, "PARAMETER_VALUE_TYPE_INVALID", { upper: true });
    if (valueType !== policy.valueType) p1Fail("PARAMETER_VALUE_TYPE_DOMAIN_MISMATCH", name);
    for (const [field, value] of [["min", parameter.min], ["max", parameter.max], ["step", parameter.step]]) {
      if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) p1Fail("PARAMETER_NON_FINITE", `${name}.${field}`);
    }
    if (parameter.min < policy.hardMin || parameter.max > policy.hardMax || parameter.min > parameter.max || parameter.step <= 0) {
      p1Fail("PARAMETER_OUTSIDE_DOMAIN", name);
    }
    if (valueType === "INTEGER" && ![parameter.min, parameter.max, parameter.step].every(Number.isSafeInteger)) {
      p1Fail("INTEGER_PARAMETER_REQUIRES_INTEGERS", name);
    }
    const cardinality = Math.floor(((parameter.max - parameter.min) / parameter.step) + 1e-12) + 1;
    if (!Number.isSafeInteger(cardinality) || cardinality < 1 || cardinality > CANDIDATE_GENERATOR_HARD_CAPS.maxParameterCombinations) {
      p1Fail("PARAMETER_DOMAIN_CARDINALITY_EXCEEDED", name);
    }
    return { name, domain, valueType, min: parameter.min, max: parameter.max, step: parameter.step };
  }).sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(rows.map((row) => row.name)).size !== rows.length) p1Fail("DUPLICATE_PARAMETER_NAME");
  return p1Freeze(rows);
}

function p1ParameterMap(parameterSpace) {
  return new Map(parameterSpace.map((parameter) => [parameter.name, parameter]));
}

function p1RequireParameter(name, domains, context, code = "PARAMETER_REFERENCE_INVALID") {
  const normalized = p1Identifier(name, code);
  const parameter = context.parameters.get(normalized);
  if (!parameter || !domains.includes(parameter.domain)) p1Fail(code, normalized);
  context.usedParameters.add(normalized);
  return normalized;
}

function p1EnterNode(context, depth) {
  if (depth > context.limits.maxAstDepth) p1Fail("STRATEGY_DSL_MAX_DEPTH_EXCEEDED");
  context.astNodes += 1;
  if (context.astNodes > context.limits.maxAstNodes) p1Fail("STRATEGY_DSL_MAX_NODES_EXCEEDED");
}

function p1NormalizeIndicator(node, context, depth) {
  p1EnterNode(context, depth);
  const indicatorKeys = Object.hasOwn(node, "lag")
    ? ["kind", "name", "input", "parameters", "lag"]
    : ["kind", "name", "input", "parameters"];
  p1Exact(node, indicatorKeys, "INDICATOR_NODE_SHAPE_INVALID");
  if (Object.hasOwn(node, "lag") && node.lag !== 1) p1Fail("INDICATOR_LAG_MUST_BE_SYSTEM_FIXED");
  if (node.kind !== "INDICATOR") p1Fail("INDICATOR_NODE_KIND_INVALID");
  const name = p1Text(node.name, "INDICATOR_INVALID", { upper: true });
  if (!SAFE_STRATEGY_INDICATORS.includes(name)) p1Fail("INDICATOR_INVALID", name);
  context.indicatorCount += 1;
  if (context.indicatorCount > context.limits.maxIndicatorCount) p1Fail("STRATEGY_DSL_MAX_INDICATORS_EXCEEDED");
  const input = p1Text(node.input, "INDICATOR_INPUT_INVALID", { lower: true });
  const inputPolicy = P1_INDICATOR_INPUT[name];
  if (input !== inputPolicy.input) p1Fail("INDICATOR_INPUT_INCOMPATIBLE", `${name}:${input}`);
  for (const field of inputPolicy.fields) {
    if (!context.availableDataFields.has(field)) p1Fail("INDICATOR_DATA_FIELD_UNAVAILABLE", `${name}:${field}`);
  }
  const parameterPolicy = P1_INDICATOR_PARAMETERS[name];
  p1Exact(node.parameters, Object.keys(parameterPolicy), "INDICATOR_PARAMETERS_SHAPE_INVALID");
  const parameters = {};
  for (const [role, domains] of Object.entries(parameterPolicy)) {
    parameters[role] = p1RequireParameter(node.parameters[role], domains, context, "INDICATOR_PARAMETER_REFERENCE_INVALID");
  }
  return { node: p1Freeze({ kind: "INDICATOR", name, input, parameters: p1Freeze(parameters), lag: 1 }), type: "NUMBER" };
}

function p1NormalizeParameterNode(node, context, depth) {
  p1EnterNode(context, depth);
  p1Exact(node, ["kind", "name"], "PARAMETER_NODE_SHAPE_INVALID");
  if (node.kind !== "PARAMETER") p1Fail("PARAMETER_NODE_KIND_INVALID");
  const name = p1RequireParameter(node.name, Object.keys(PARAMETER_DOMAIN_POLICY_V1), context);
  return { node: p1Freeze({ kind: "PARAMETER", name }), type: "NUMBER" };
}

function p1NormalizeOperand(node, context, depth) {
  p1Plain(node, "STRATEGY_DSL_NODE_INVALID");
  if (node.kind === "INDICATOR") return p1NormalizeIndicator(node, context, depth);
  if (node.kind === "PARAMETER") return p1NormalizeParameterNode(node, context, depth);
  if (node.kind === "OPERATOR") return p1NormalizeOperator(node, context, depth);
  p1Fail("STRATEGY_DSL_NODE_KIND_FORBIDDEN", String(node.kind));
}

function p1NormalizeOperator(node, context, depth) {
  p1EnterNode(context, depth);
  p1Exact(node, ["kind", "operator", "operands"], "OPERATOR_NODE_SHAPE_INVALID");
  if (node.kind !== "OPERATOR") p1Fail("OPERATOR_NODE_KIND_INVALID");
  const operator = p1Text(node.operator, "STRATEGY_DSL_OPERATOR_INVALID", { upper: true });
  if (!SAFE_STRATEGY_OPERATORS.includes(operator)) p1Fail("STRATEGY_DSL_OPERATOR_INVALID", operator);
  if (!Array.isArray(node.operands) || node.operands.length !== P1_OPERATOR_ARITY[operator]) p1Fail("STRATEGY_DSL_OPERATOR_ARITY_INVALID", operator);
  const operands = node.operands.map((operand) => p1NormalizeOperand(operand, context, depth + 1));
  if (operands.some((operand) => operand.type !== "NUMBER")) p1Fail("STRATEGY_DSL_NUMERIC_OPERAND_REQUIRED", operator);
  if (operator === "PERCENTILE") {
    const percentile = operands[1].node;
    if (percentile.kind !== "PARAMETER" || context.parameters.get(percentile.name)?.domain !== "PERCENTILE_LEVEL") {
      p1Fail("PERCENTILE_PARAMETER_REQUIRED");
    }
  }
  if (["RISING", "FALLING"].includes(operator)) {
    const bars = operands[1].node;
    if (bars.kind !== "PARAMETER" || context.parameters.get(bars.name)?.domain !== "BAR_COUNT") p1Fail("TREND_BAR_COUNT_PARAMETER_REQUIRED");
  }
  return {
    node: p1Freeze({ kind: "OPERATOR", operator, operands: p1Freeze(operands.map((operand) => operand.node)) }),
    type: P1_BOOLEAN_OPERATORS.has(operator) ? "BOOLEAN" : "NUMBER",
  };
}

function p1NormalizeRule(rule, context) {
  const normalized = p1NormalizeOperator(rule, context, 0);
  if (normalized.type !== "BOOLEAN") p1Fail("BOOLEAN_RULE_REQUIRED");
  return normalized.node;
}

function p1NormalizeEntry(raw, direction, context) {
  p1Exact(raw, ["action", "rules"], "ENTRY_DSL_SHAPE_INVALID");
  const action = p1Text(raw.action, "ENTRY_ACTION_INVALID", { upper: true });
  if (!SAFE_STRATEGY_ENTRY_ACTIONS.includes(action) || action !== direction) p1Fail("ENTRY_DIRECTION_MISMATCH");
  if (!Array.isArray(raw.rules)) p1Fail("ENTRY_RULES_INVALID");
  if ((action === "NO_TRADE") !== (raw.rules.length === 0)) p1Fail("NO_TRADE_RULES_MISMATCH");
  context.ruleCount += raw.rules.length;
  if (context.ruleCount > context.limits.maxRuleCount) p1Fail("STRATEGY_DSL_MAX_RULES_EXCEEDED");
  return p1Freeze({ action, rules: p1Freeze(raw.rules.map((rule) => p1NormalizeRule(rule, context))) });
}

function p1NormalizeExitRule(raw, context) {
  p1Plain(raw, "EXIT_RULE_INVALID");
  const type = p1Text(raw.type, "EXIT_TYPE_INVALID", { upper: true });
  if (!SAFE_STRATEGY_EXIT_TYPES.includes(type)) p1Fail("EXIT_TYPE_INVALID", type);
  if (type === "FIXED_STOP" || type === "TARGET" || type === "TRAILING_STOP") {
    p1Exact(raw, ["type", "distanceParameter"], "EXIT_RULE_SHAPE_INVALID");
    return p1Freeze({ type, distanceParameter: p1RequireParameter(raw.distanceParameter, ["PRICE_FRACTION"], context, "EXIT_PARAMETER_INVALID") });
  }
  if (type === "ATR_STOP") {
    p1Exact(raw, ["type", "atrIndicator", "multiplierParameter"], "EXIT_RULE_SHAPE_INVALID");
    const atr = p1NormalizeIndicator(raw.atrIndicator, context, 0).node;
    if (atr.name !== "ATR") p1Fail("ATR_STOP_REQUIRES_ATR_INDICATOR");
    return p1Freeze({ type, atrIndicator: atr, multiplierParameter: p1RequireParameter(raw.multiplierParameter, ["POSITIVE_MULTIPLIER"], context, "EXIT_PARAMETER_INVALID") });
  }
  if (type === "TIME_EXIT") {
    p1Exact(raw, ["type", "barsParameter"], "EXIT_RULE_SHAPE_INVALID");
    return p1Freeze({ type, barsParameter: p1RequireParameter(raw.barsParameter, ["BAR_COUNT"], context, "EXIT_PARAMETER_INVALID") });
  }
  p1Exact(raw, ["type", "rule"], "EXIT_RULE_SHAPE_INVALID");
  return p1Freeze({ type, rule: p1NormalizeRule(raw.rule, context) });
}

function p1NormalizeExit(raw, direction, context) {
  p1Exact(raw, ["rules"], "EXIT_DSL_SHAPE_INVALID");
  if (!Array.isArray(raw.rules)) p1Fail("EXIT_RULES_INVALID");
  if ((direction === "NO_TRADE") !== (raw.rules.length === 0)) p1Fail("NO_TRADE_EXIT_MISMATCH");
  context.ruleCount += raw.rules.length;
  if (context.ruleCount > context.limits.maxRuleCount) p1Fail("STRATEGY_DSL_MAX_RULES_EXCEEDED");
  return p1Freeze({ rules: p1Freeze(raw.rules.map((rule) => p1NormalizeExitRule(rule, context))) });
}

export function createSafeStrategyDslV1(raw) {
  p1Exact(raw, ["market", "timeframe", "direction", "availableDataFields", "entryDsl", "exitDsl", "parameterSpace", "limits"], "SAFE_STRATEGY_DSL_SHAPE_INVALID");
  const market = p1Text(raw.market, "STRATEGY_MARKET_INVALID", { upper: true });
  if (!P1_MARKETS.has(market)) p1Fail("STRATEGY_MARKET_INVALID", market);
  const timeframe = p1Text(raw.timeframe, "STRATEGY_TIMEFRAME_INVALID", { lower: true });
  if (!P1_TIMEFRAMES.has(timeframe)) p1Fail("STRATEGY_TIMEFRAME_INVALID", timeframe);
  const direction = p1Text(raw.direction, "STRATEGY_DIRECTION_INVALID", { upper: true });
  if (!P1_DIRECTIONS[market].has(direction)) p1Fail("STRATEGY_DIRECTION_MARKET_INCOMPATIBLE", `${market}:${direction}`);
  if (!Array.isArray(raw.availableDataFields) || raw.availableDataFields.length === 0) p1Fail("AVAILABLE_DATA_FIELDS_REQUIRED");
  const availableDataFields = [...new Set(raw.availableDataFields.map((field) => p1Identifier(field, "AVAILABLE_DATA_FIELD_INVALID").toLowerCase()))].sort();
  if (availableDataFields.length !== raw.availableDataFields.length) p1Fail("AVAILABLE_DATA_FIELDS_DUPLICATE");
  const parameterSpace = p1NormalizeParameterSpace(raw.parameterSpace);
  const limits = p1NormalizeLimits(raw.limits);
  const context = {
    parameters: p1ParameterMap(parameterSpace),
    usedParameters: new Set(),
    availableDataFields: new Set(availableDataFields),
    limits,
    astNodes: 0,
    indicatorCount: 0,
    ruleCount: 0,
  };
  const entryDsl = p1NormalizeEntry(raw.entryDsl, direction, context);
  const exitDsl = p1NormalizeExit(raw.exitDsl, direction, context);
  const unused = parameterSpace.map((parameter) => parameter.name).filter((name) => !context.usedParameters.has(name));
  if (unused.length > 0) p1Fail("UNUSED_PARAMETERS_FORBIDDEN", unused.join(","));
  const core = {
    schemaVersion: SAFE_STRATEGY_DSL_SCHEMA_VERSION,
    market,
    timeframe,
    direction,
    availableDataFields,
    entryDsl,
    exitDsl,
    parameterSpace,
    limits,
    astStats: { nodes: context.astNodes, indicators: context.indicatorCount, rules: context.ruleCount },
  };
  return p1Freeze({ ...core, dslHash: p1Hash(core), safety: p1Safety() });
}

function p1NormalizePolicy(raw) {
  p1Exact(raw, ["compilerId", "compilerVersion", "costPolicyIdentity", "riskPolicyIdentity", "datasetIdentity", "datasetRole", "budget"], "FORMULA_COMPILER_POLICY_SHAPE_INVALID");
  const datasetRole = p1Text(raw.datasetRole, "DATASET_ROLE_INVALID", { upper: true });
  if (!P1_DATASET_ROLES.has(datasetRole)) p1Fail("FINAL_HOLDOUT_COMPILER_ACCESS_FORBIDDEN");
  return p1Freeze({
    compilerId: p1Identifier(raw.compilerId, "COMPILER_ID_INVALID"),
    compilerVersion: p1Version(raw.compilerVersion, "COMPILER_VERSION_INVALID"),
    costPolicyIdentity: p1Identifier(raw.costPolicyIdentity, "COST_POLICY_IDENTITY_INVALID"),
    riskPolicyIdentity: p1Identifier(raw.riskPolicyIdentity, "RISK_POLICY_IDENTITY_INVALID"),
    datasetIdentity: p1Identifier(raw.datasetIdentity, "DATASET_IDENTITY_INVALID"),
    datasetRole,
    budget: normalizeCandidateGenerationBudgetV1(raw.budget),
  });
}

function p1HypothesisFields(hypothesis) {
  return [...new Set(hypothesis.requiredData.flatMap((entry) => entry.fields.map((field) => field.toLowerCase())))].sort();
}

function p1MarketScopeAllows(marketScope, market) {
  const tokens = marketScope.map((scope) => scope.toUpperCase());
  if (market === "US_STOCK") return tokens.some((scope) => scope.includes("US") || scope.includes("UNITED_STATES"));
  if (market === "KR_STOCK") return tokens.some((scope) => scope.includes("KR") || scope.includes("KOREA"));
  if (market === "CRYPTO_SPOT") return tokens.some((scope) => scope.includes("CRYPTO") || scope.includes("SPOT"));
  if (market === "CRYPTO_FUTURES") return tokens.some((scope) => scope.includes("CRYPTO") || scope.includes("FUTURES"));
  return false;
}

function p1SemanticNode(node, parameterMap) {
  if (node.kind === "PARAMETER") return { kind: "PARAMETER", domain: parameterMap.get(node.name).domain };
  if (node.kind === "INDICATOR") {
    return {
      kind: "INDICATOR",
      name: node.name,
      input: node.input,
      lag: node.lag,
      parameterDomains: Object.fromEntries(Object.entries(node.parameters).map(([role, name]) => [role, parameterMap.get(name).domain])),
    };
  }
  return { kind: "OPERATOR", operator: node.operator, operands: node.operands.map((operand) => p1SemanticNode(operand, parameterMap)) };
}

function p1SemanticMaterial(dsl) {
  const parameters = p1ParameterMap(dsl.parameterSpace);
  return {
    market: dsl.market,
    timeframe: dsl.timeframe,
    direction: dsl.direction,
    entry: { action: dsl.entryDsl.action, rules: dsl.entryDsl.rules.map((rule) => p1SemanticNode(rule, parameters)) },
    exits: dsl.exitDsl.rules.map((rule) => {
      if (rule.type === "ATR_STOP") return { type: rule.type, atrIndicator: p1SemanticNode(rule.atrIndicator, parameters), multiplierDomain: parameters.get(rule.multiplierParameter).domain };
      if (rule.type === "INVALIDATION_EXIT") return { type: rule.type, rule: p1SemanticNode(rule.rule, parameters) };
      const reference = rule.distanceParameter ?? rule.barsParameter;
      return { type: rule.type, parameterDomain: parameters.get(reference).domain };
    }),
  };
}

function p1FormulaIdentity(candidate) {
  return {
    hypothesisId: candidate.hypothesisId,
    strategyFamily: candidate.strategyFamily,
    marketScope: candidate.marketScope,
    market: candidate.market,
    timeframe: candidate.timeframe,
    direction: candidate.direction,
    entryDsl: candidate.entryDsl,
    exitDsl: candidate.exitDsl,
    parameterSpace: candidate.parameterSpace,
    dslLimits: candidate.dslLimits,
    costPolicyIdentity: candidate.costPolicyIdentity,
    riskPolicyIdentity: candidate.riskPolicyIdentity,
  };
}

function p1CandidateIdentity(candidate) {
  return {
    formulaHash: candidate.formulaHash,
    hypothesisId: candidate.hypothesisId,
    rationale: candidate.rationale,
    falsificationCriteria: candidate.falsificationCriteria,
    requiredData: candidate.requiredData,
    provenance: candidate.provenance,
    candidateBudget: candidate.candidateBudget,
  };
}

const P1_BINDING_KEYS = ["hypothesisId", "hypothesisConfigHash", "decisionId", "decisionHash"];
const P1_TEMPLATE_KEYS = ["templateId", "hypothesisBinding", "strategyFamily", "market", "timeframe", "direction", "entryDsl", "exitDsl", "parameterSpace", "limits"];
const P1_CANDIDATE_KEYS = [
  "schemaVersion", "candidateId", "hypothesisId", "strategyFamily", "familyFingerprint", "semanticFingerprint",
  "marketScope", "market", "timeframe", "direction", "availableDataFields", "entryDsl", "exitDsl", "parameterSpace",
  "dslLimits", "dslStats", "dslHash", "rationale", "falsificationCriteria", "requiredData", "costPolicyIdentity",
  "riskPolicyIdentity", "provenance", "candidateBudget", "formulaHash", "evaluationStatus", "formulaPassed", "safety",
];

function p1AssertBinding(binding, hypothesis, decision) {
  p1Exact(binding, P1_BINDING_KEYS, "HYPOTHESIS_BINDING_SHAPE_INVALID");
  if (binding.hypothesisId !== hypothesis.hypothesisId
    || binding.hypothesisConfigHash !== hypothesis.configHash
    || binding.decisionId !== decision.decisionId
    || binding.decisionHash !== decision.decisionHash) p1Fail("HYPOTHESIS_PROVENANCE_MISMATCH");
}

export function compileStrategyHypothesisToFormulaCandidatesV1(input) {
  p1Exact(input, ["hypothesis", "decision", "templates", "policy"], "FORMULA_COMPILER_INPUT_SHAPE_INVALID");
  assertStrategyHypothesisV1(input.hypothesis);
  assertHypothesisDecisionV1(input.decision);
  if (input.decision.hypothesisId !== input.hypothesis.hypothesisId
    || input.decision.hypothesisConfigHash !== input.hypothesis.configHash) p1Fail("HYPOTHESIS_DECISION_BINDING_MISMATCH");
  if (input.decision.verdict !== "APPROVE_FOR_RESEARCH" || input.decision.evidenceAssessment.verdict !== "APPROVE_FOR_RESEARCH") {
    return p1Freeze([]);
  }
  if (!Array.isArray(input.templates)) p1Fail("FORMULA_TEMPLATES_REQUIRED");
  const policy = p1NormalizePolicy(input.policy);
  if (input.templates.length > policy.budget.maxCandidatesPerHypothesis || input.templates.length > policy.budget.maxCandidatesPerRun) {
    p1Fail("FORMULA_TEMPLATE_BUDGET_EXCEEDED");
  }
  const availableDataFields = p1HypothesisFields(input.hypothesis);
  const templates = [...input.templates].sort((left, right) => String(left?.templateId).localeCompare(String(right?.templateId)));
  if (new Set(templates.map((template) => template?.templateId)).size !== templates.length) p1Fail("DUPLICATE_FORMULA_TEMPLATE_ID");
  const candidates = templates.map((template) => {
    p1Exact(template, P1_TEMPLATE_KEYS, "FORMULA_TEMPLATE_SHAPE_INVALID");
    p1AssertBinding(template.hypothesisBinding, input.hypothesis, input.decision);
    const market = p1Text(template.market, "FORMULA_MARKET_INVALID", { upper: true });
    if (!P1_ASSET_MARKETS[input.hypothesis.assetClass]?.has(market) || !p1MarketScopeAllows(input.hypothesis.marketScope, market)) {
      p1Fail("HYPOTHESIS_MARKET_INCOMPATIBLE", market);
    }
    const timeframe = p1Text(template.timeframe, "FORMULA_TIMEFRAME_INVALID", { lower: true });
    if (!input.hypothesis.timeframeScope.map((value) => value.toLowerCase()).includes(timeframe)) p1Fail("HYPOTHESIS_TIMEFRAME_INCOMPATIBLE", timeframe);
    const direction = p1Text(template.direction, "FORMULA_DIRECTION_INVALID", { upper: true });
    if (!P1_DIRECTIONALITY[input.hypothesis.directionality].has(direction)) p1Fail("HYPOTHESIS_DIRECTION_INCOMPATIBLE", direction);
    const dsl = createSafeStrategyDslV1({
      market,
      timeframe,
      direction,
      availableDataFields,
      entryDsl: template.entryDsl,
      exitDsl: template.exitDsl,
      parameterSpace: template.parameterSpace,
      limits: template.limits,
    });
    if (dsl.astStats.nodes > policy.budget.maxAstNodes) p1Fail("CANDIDATE_BUDGET_AST_NODES_EXCEEDED");
    const strategyFamily = p1Identifier(template.strategyFamily, "STRATEGY_FAMILY_INVALID");
    const semanticFingerprint = p1Hash(p1SemanticMaterial(dsl));
    const familyFingerprint = p1Hash({
      hypothesisFamilyFingerprint: input.hypothesis.familyFingerprint,
      strategyFamily,
      market,
      timeframe,
      direction,
      semanticFingerprint,
    });
    const provenance = p1Freeze({
      sourceContract: "StrategyHypothesisV1",
      sourceContractVersion: 1,
      hypothesisConfigHash: input.hypothesis.configHash,
      hypothesisDecisionId: input.decision.decisionId,
      hypothesisDecisionHash: input.decision.decisionHash,
      sourcePaperBindings: p1Canonical(input.hypothesis.provenance.papers),
      compilerId: policy.compilerId,
      compilerVersion: policy.compilerVersion,
      templateId: p1Identifier(template.templateId, "FORMULA_TEMPLATE_ID_INVALID"),
      datasetIdentity: policy.datasetIdentity,
      datasetRole: policy.datasetRole,
      searchSpaceHash: p1Hash(dsl.parameterSpace),
      budgetDigest: p1Hash(policy.budget),
    });
    const candidate = {
      schemaVersion: FORMULA_CANDIDATE_SCHEMA_VERSION,
      candidateId: "",
      hypothesisId: input.hypothesis.hypothesisId,
      strategyFamily,
      familyFingerprint,
      semanticFingerprint,
      marketScope: p1Canonical(input.hypothesis.marketScope),
      market,
      timeframe,
      direction,
      availableDataFields: dsl.availableDataFields,
      entryDsl: dsl.entryDsl,
      exitDsl: dsl.exitDsl,
      parameterSpace: dsl.parameterSpace,
      dslLimits: dsl.limits,
      dslStats: dsl.astStats,
      dslHash: dsl.dslHash,
      rationale: input.hypothesis.rationale,
      falsificationCriteria: p1Canonical(input.hypothesis.falsificationCriteria),
      requiredData: p1Canonical(input.hypothesis.requiredData),
      costPolicyIdentity: policy.costPolicyIdentity,
      riskPolicyIdentity: policy.riskPolicyIdentity,
      provenance,
      candidateBudget: policy.budget,
      formulaHash: "",
      evaluationStatus: "NOT_EVALUATED",
      formulaPassed: false,
      safety: p1Safety(),
    };
    candidate.formulaHash = p1Hash(p1FormulaIdentity(candidate));
    candidate.candidateId = `formula-candidate:sha256:${p1Hash(p1CandidateIdentity(candidate))}`;
    return p1Freeze(candidate);
  });
  return p1Freeze(candidates);
}

export function assertFormulaCandidateV1(candidate) {
  p1Exact(candidate, P1_CANDIDATE_KEYS, "FORMULA_CANDIDATE_SHAPE_INVALID");
  if (candidate.schemaVersion !== FORMULA_CANDIDATE_SCHEMA_VERSION) p1Fail("FORMULA_CANDIDATE_SCHEMA_VERSION_INVALID");
  if (!P1_HASH.test(candidate.formulaHash) || candidate.formulaHash !== p1Hash(p1FormulaIdentity(candidate))) p1Fail("FORMULA_HASH_MISMATCH");
  p1Exact(candidate.provenance, [
    "sourceContract", "sourceContractVersion", "hypothesisConfigHash", "hypothesisDecisionId", "hypothesisDecisionHash",
    "sourcePaperBindings", "compilerId", "compilerVersion", "templateId", "datasetIdentity", "datasetRole",
    "searchSpaceHash", "budgetDigest",
  ], "FORMULA_PROVENANCE_SHAPE_INVALID");
  if (candidate.provenance.sourceContract !== "StrategyHypothesisV1" || candidate.provenance.sourceContractVersion !== 1) p1Fail("FORMULA_SOURCE_CONTRACT_INVALID");
  if (![candidate.provenance.hypothesisConfigHash, candidate.provenance.hypothesisDecisionHash, candidate.provenance.searchSpaceHash, candidate.provenance.budgetDigest].every((hash) => P1_HASH.test(hash))) {
    p1Fail("FORMULA_PROVENANCE_HASH_INVALID");
  }
  if (!Array.isArray(candidate.provenance.sourcePaperBindings)) p1Fail("FORMULA_SOURCE_PAPER_BINDINGS_INVALID");
  for (const binding of candidate.provenance.sourcePaperBindings) {
    p1Exact(binding, ["paperId", "metadataHash", "role"], "FORMULA_SOURCE_PAPER_BINDING_INVALID");
    if (!P1_HASH.test(binding.metadataHash) || !["SUPPORTING", "CONTRADICTORY"].includes(binding.role)) p1Fail("FORMULA_SOURCE_PAPER_BINDING_INVALID");
  }
  const expectedCandidateId = `formula-candidate:sha256:${p1Hash(p1CandidateIdentity(candidate))}`;
  if (candidate.candidateId !== expectedCandidateId) p1Fail("FORMULA_CANDIDATE_ID_MISMATCH");
  const dsl = createSafeStrategyDslV1({
    market: candidate.market,
    timeframe: candidate.timeframe,
    direction: candidate.direction,
    availableDataFields: candidate.availableDataFields,
    entryDsl: candidate.entryDsl,
    exitDsl: candidate.exitDsl,
    parameterSpace: candidate.parameterSpace,
    limits: candidate.dslLimits,
  });
  if (dsl.dslHash !== candidate.dslHash || canonicalSerializeStrategyFormulaV1(dsl.astStats) !== canonicalSerializeStrategyFormulaV1(candidate.dslStats)) {
    p1Fail("FORMULA_DSL_HASH_MISMATCH");
  }
  const normalizedBudget = normalizeCandidateGenerationBudgetV1(candidate.candidateBudget);
  if (candidate.provenance.budgetDigest !== p1Hash(normalizedBudget) || candidate.provenance.searchSpaceHash !== p1Hash(candidate.parameterSpace)) {
    p1Fail("FORMULA_PROVENANCE_MISMATCH");
  }
  if (candidate.evaluationStatus !== "NOT_EVALUATED" || candidate.formulaPassed !== false) p1Fail("FORMULA_EVALUATION_AUTHORITY_FORBIDDEN");
  if (candidate.safety?.executionAuthority !== "NONE" || candidate.safety?.arbitraryExecutableCodeAllowed !== false) p1Fail("FORMULA_SAFETY_INVALID");
  return candidate;
}

function p1DedupDecision(type, action, candidateId, matchedCandidateId) {
  const provenance = { algorithm: "FORMULA_DEDUPLICATION_V1", automaticSemanticMerge: false };
  const core = { type, action, candidateId, matchedCandidateId, provenance };
  return p1Freeze({ decisionId: `dedup:sha256:${p1Hash(core)}`, ...core });
}

export function deduplicateFormulaCandidatesV1(input) {
  p1Exact(input, ["candidates"], "FORMULA_DEDUP_INPUT_SHAPE_INVALID");
  if (!Array.isArray(input.candidates)) p1Fail("FORMULA_CANDIDATES_ARRAY_REQUIRED");
  const rows = [...input.candidates].sort((left, right) => String(left?.candidateId).localeCompare(String(right?.candidateId)));
  rows.forEach(assertFormulaCandidateV1);
  const accepted = [];
  const decisions = [];
  const exact = new Map();
  for (const candidate of rows) {
    const existing = exact.get(candidate.formulaHash);
    if (existing) {
      decisions.push(p1DedupDecision("EXACT_FORMULA_HASH", "DROP_EXACT_DUPLICATE", candidate.candidateId, existing.candidateId));
      continue;
    }
    exact.set(candidate.formulaHash, candidate);
    accepted.push(candidate);
  }
  for (const [field, type] of [["familyFingerprint", "FAMILY_FINGERPRINT"], ["semanticFingerprint", "SEMANTIC_SIMILARITY_CANDIDATE"]]) {
    const groups = new Map();
    for (const candidate of accepted) {
      const prior = groups.get(candidate[field]);
      if (prior) decisions.push(p1DedupDecision(type, "REVIEW_REQUIRED_NO_AUTOMATIC_MERGE", candidate.candidateId, prior.candidateId));
      else groups.set(candidate[field], candidate);
    }
  }
  return p1Freeze({ acceptedCandidates: accepted, decisions });
}

function p1AxisValues(parameter) {
  const count = Math.floor(((parameter.max - parameter.min) / parameter.step) + 1e-12) + 1;
  return Array.from({ length: count }, (_, index) => {
    const value = parameter.min + (parameter.step * index);
    const rounded = parameter.valueType === "INTEGER" ? Math.round(value) : Number(value.toFixed(12));
    return Object.is(rounded, -0) ? 0 : rounded;
  });
}

function p1CombinationFromOrdinal(axes, ordinal) {
  let cursor = BigInt(ordinal);
  const selected = {};
  for (let index = axes.length - 1; index >= 0; index -= 1) {
    const axis = axes[index];
    const radix = BigInt(axis.values.length);
    const valueIndex = Number(cursor % radix);
    cursor /= radix;
    selected[axis.name] = axis.values[valueIndex];
  }
  return Object.fromEntries(Object.keys(selected).sort().map((key) => [key, selected[key]]));
}

function p1XorShift32(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function p1WalkNodes(value, visitor) {
  if (!value || typeof value !== "object") return;
  visitor(value);
  if (Array.isArray(value)) value.forEach((entry) => p1WalkNodes(entry, visitor));
  else Object.values(value).forEach((entry) => p1WalkNodes(entry, visitor));
}

function p1SelectionValid(candidate, selected) {
  let valid = true;
  p1WalkNodes([candidate.entryDsl, candidate.exitDsl], (node) => {
    if (node.kind === "INDICATOR" && node.name === "MACD") {
      valid = valid && selected[node.parameters.fastPeriod] < selected[node.parameters.slowPeriod];
    }
    if (node.kind === "OPERATOR" && node.operator === "BETWEEN") {
      const lower = node.operands[1];
      const upper = node.operands[2];
      if (lower?.kind === "PARAMETER" && upper?.kind === "PARAMETER") valid = valid && selected[lower.name] < selected[upper.name];
    }
  });
  return valid;
}

function p1NormalizeSearch(raw) {
  p1Exact(raw, ["method", "seed", "requestedCandidates", "datasetIdentity", "finalHoldoutAccess"], "PARAMETER_SEARCH_SHAPE_INVALID");
  const method = p1Text(raw.method, "PARAMETER_SEARCH_METHOD_INVALID", { upper: true });
  if (!P1_SEARCH_METHODS.has(method)) p1Fail("PARAMETER_SEARCH_METHOD_INVALID", method);
  if (!Number.isSafeInteger(raw.seed) || raw.seed < 0 || raw.seed > 0xffffffff) p1Fail("PARAMETER_SEARCH_SEED_INVALID");
  if (raw.finalHoldoutAccess !== false) p1Fail("FINAL_HOLDOUT_PARAMETER_ACCESS_FORBIDDEN");
  return p1Freeze({
    method,
    seed: raw.seed,
    requestedCandidates: p1PositiveInteger(raw.requestedCandidates, "PARAMETER_SEARCH_REQUEST_INVALID", CANDIDATE_GENERATOR_HARD_CAPS.maxCandidatesPerRun),
    datasetIdentity: p1Identifier(raw.datasetIdentity, "PARAMETER_SEARCH_DATASET_INVALID"),
    finalHoldoutAccess: false,
  });
}

function p1GeneratedCandidate(formula, selectedParameters, search, budget, ordinal) {
  const parameterIdentity = p1Hash({ formulaHash: formula.formulaHash, selectedParameters });
  const provenance = p1Freeze({
    method: search.method,
    seed: search.seed,
    candidateBudget: budget,
    budgetDigest: p1Hash(budget),
    searchSpaceHash: formula.provenance.searchSpaceHash,
    datasetIdentity: search.datasetIdentity,
    finalHoldoutAccess: false,
    combinationOrdinal: ordinal,
  });
  const identity = { formulaCandidateId: formula.candidateId, parameterIdentity, generation: 0, provenance };
  return p1Freeze({
    schemaVersion: GENERATED_FORMULA_CANDIDATE_SCHEMA_VERSION,
    generatedCandidateId: `generated-formula-candidate:sha256:${p1Hash(identity)}`,
    formulaCandidateId: formula.candidateId,
    formulaHash: formula.formulaHash,
    hypothesisId: formula.hypothesisId,
    strategyFamily: formula.strategyFamily,
    familyFingerprint: formula.familyFingerprint,
    semanticFingerprint: formula.semanticFingerprint,
    selectedParameters: p1Freeze(selectedParameters),
    parameterIdentity,
    generation: 0,
    searchProvenance: provenance,
    safety: p1Safety(),
  });
}

export function generateBoundedFormulaCandidatesV1(input) {
  p1Exact(input, ["formulaCandidates", "budget", "search"], "BOUNDED_GENERATOR_INPUT_SHAPE_INVALID");
  if (!Array.isArray(input.formulaCandidates)) p1Fail("FORMULA_CANDIDATES_ARRAY_REQUIRED");
  const budget = normalizeCandidateGenerationBudgetV1(input.budget);
  const search = p1NormalizeSearch(input.search);
  if (search.requestedCandidates > budget.maxCandidatesPerRun) p1Fail("CANDIDATE_RUN_BUDGET_EXCEEDED");
  const deduplication = deduplicateFormulaCandidatesV1({ candidates: input.formulaCandidates });
  for (const formula of deduplication.acceptedCandidates) {
    if (formula.provenance.datasetIdentity !== search.datasetIdentity) p1Fail("PARAMETER_SEARCH_DATASET_MISMATCH");
    if (formula.dslStats.nodes > budget.maxAstNodes) p1Fail("CANDIDATE_BUDGET_AST_NODES_EXCEEDED");
  }
  const estimatedMemoryBytes = (search.requestedCandidates * 4096) + (deduplication.acceptedCandidates.length * 2048);
  if (estimatedMemoryBytes > budget.maxMemoryBytes) p1Fail("CANDIDATE_MEMORY_BUDGET_EXCEEDED");
  const startedAt = performance.now();
  const deadlineMs = Math.min(budget.maxRuntimeMs, budget.maxCpuMs);
  const generated = [];
  const parameterIdentities = new Set();
  const decisions = [...deduplication.decisions];
  const perHypothesis = new Map();
  let combinationsVisited = 0;
  const guard = () => {
    if (performance.now() - startedAt > deadlineMs) p1Fail("CANDIDATE_RUNTIME_BUDGET_EXCEEDED");
    if (combinationsVisited >= budget.maxParameterCombinations) return false;
    return true;
  };
  for (const formula of deduplication.acceptedCandidates) {
    if (generated.length >= search.requestedCandidates || generated.length >= budget.maxCandidatesPerRun || !guard()) break;
    const axes = formula.parameterSpace.map((parameter) => ({ name: parameter.name, values: p1AxisValues(parameter) }));
    const total = axes.reduce((product, axis) => product * BigInt(axis.values.length), 1n);
    const remainingRun = Math.min(search.requestedCandidates, budget.maxCandidatesPerRun) - generated.length;
    const usedForHypothesis = perHypothesis.get(formula.hypothesisId) ?? 0;
    const target = Math.min(remainingRun, budget.maxCandidatesPerHypothesis - usedForHypothesis);
    if (target <= 0) continue;
    const ordinals = [];
    if (search.method === "BOUNDED_GRID") {
      const count = Math.min(target, budget.maxParameterCombinations - combinationsVisited, Number(total > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(target) : total));
      for (let index = 0; index < count; index += 1) ordinals.push(BigInt(index));
    } else if (search.method === "DETERMINISTIC_SAMPLING") {
      const count = Math.min(target, budget.maxParameterCombinations - combinationsVisited, Number(total > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(target) : total));
      for (let index = 0; index < count; index += 1) {
        ordinals.push(count === 1 ? 0n : (BigInt(index) * (total - 1n)) / BigInt(count - 1));
      }
    } else {
      const next = p1XorShift32(search.seed ^ Number.parseInt(formula.formulaHash.slice(0, 8), 16));
      const attempts = Math.min(budget.maxParameterCombinations - combinationsVisited, target * 16);
      const seen = new Set();
      for (let attempt = 0; attempt < attempts && ordinals.length < target; attempt += 1) {
        const selected = {};
        for (const axis of axes) selected[axis.name] = axis.values[next() % axis.values.length];
        const key = canonicalSerializeStrategyFormulaV1(selected);
        if (seen.has(key)) continue;
        seen.add(key);
        ordinals.push(selected);
      }
    }
    for (let index = 0; index < ordinals.length && generated.length < search.requestedCandidates && guard(); index += 1) {
      combinationsVisited += 1;
      const selected = typeof ordinals[index] === "bigint" ? p1CombinationFromOrdinal(axes, ordinals[index]) : ordinals[index];
      if (!p1SelectionValid(formula, selected)) continue;
      const parameterIdentity = p1Hash({ formulaHash: formula.formulaHash, selectedParameters: selected });
      if (parameterIdentities.has(parameterIdentity)) {
        decisions.push(p1DedupDecision("CANONICAL_PARAMETER_IDENTITY", "DROP_EXACT_DUPLICATE", `${formula.candidateId}:${parameterIdentity}`, formula.candidateId));
        continue;
      }
      parameterIdentities.add(parameterIdentity);
      generated.push(p1GeneratedCandidate(formula, selected, search, budget, combinationsVisited - 1));
      perHypothesis.set(formula.hypothesisId, (perHypothesis.get(formula.hypothesisId) ?? 0) + 1);
      if (perHypothesis.get(formula.hypothesisId) >= budget.maxCandidatesPerHypothesis) break;
    }
  }
  return p1Freeze({
    schemaVersion: GENERATED_FORMULA_CANDIDATE_SCHEMA_VERSION,
    budget,
    search,
    generatedCandidates: generated,
    deduplicationDecisions: decisions,
    budgetUsage: {
      formulaCandidatesAccepted: deduplication.acceptedCandidates.length,
      parameterCombinationsVisited: combinationsVisited,
      generatedCandidates: generated.length,
      generationsUsed: generated.length > 0 ? 1 : 0,
      estimatedMemoryBytes,
    },
    safety: p1Safety(),
  });
}
