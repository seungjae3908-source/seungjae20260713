import {
  createAiResearchCommitteePlan,
  verifyAiResearchCommitteePlan,
} from "./global-strategy-ai-research-committee-v1.js";
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

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
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
    const feature = requiredText(node.feature, `${context.name}.feature`).toUpperCase();
    if (!MARKET_FEATURE_ALLOWLIST[context.market].includes(feature)) throw new Error(`FEATURE_NOT_ALLOWED_FOR_MARKET:${feature}`);
    if (!context.availableFeatures.has(feature)) throw new Error(`FEATURE_UNAVAILABLE:${feature}`);
    if (!Number.isInteger(node.lag) || node.lag < 1) throw new Error(`FUTURE_OR_SAME_BAR_LEAKAGE:${feature}`);
    return Object.freeze({ op, feature, lag: node.lag });
  }
  if (op === "CONSTANT") {
    if (!Number.isFinite(node.value) || Math.abs(node.value) > 1_000_000) throw new RangeError("STRATEGY_DSL_CONSTANT_OUT_OF_RANGE");
    return Object.freeze({ op, value: node.value });
  }
  if (BINARY_OPS.has(op)) {
    if (!Array.isArray(node.args) || node.args.length !== 2) throw new TypeError(`${op} requires exactly two args`);
    return Object.freeze({ op, args: Object.freeze(node.args.map((arg, index) => normalizeAst(arg, { ...context, name: `${context.name}.args[${index}]` }, depth + 1, counter))) });
  }
  if (UNARY_OPS.has(op)) {
    if (!Array.isArray(node.args) || node.args.length !== 1) throw new TypeError(`${op} requires exactly one arg`);
    return Object.freeze({ op, args: Object.freeze([normalizeAst(node.args[0], { ...context, name: `${context.name}.args[0]` }, depth + 1, counter)]) });
  }
  throw new Error(`STRATEGY_DSL_OP_UNHANDLED:${op}`);
}

function normalizeParameters(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("parameters must be an object");
  return Object.freeze(Object.fromEntries(Object.keys(raw).sort().map((name) => {
    const parameter = raw[name];
    if (!parameter || !Number.isFinite(parameter.value) || !Number.isFinite(parameter.min) || !Number.isFinite(parameter.max)) throw new TypeError(`parameter ${name} is invalid`);
    if (parameter.min > parameter.max || parameter.value < parameter.min || parameter.value > parameter.max) throw new RangeError(`parameter ${name} is outside its preregistered bounds`);
    return [name, Object.freeze({ value: parameter.value, min: parameter.min, max: parameter.max })];
  })));
}

export function createBoundedStrategySpecification(raw) {
  const market = requiredText(raw?.market, "market").toUpperCase();
  if (!MARKETS.has(market)) throw new RangeError("market is unsupported");
  const direction = requiredText(raw?.direction, "direction").toUpperCase();
  if (!DIRECTIONS[market].has(direction)) throw new Error(`DIRECTION_NOT_ALLOWED_FOR_MARKET:${market}:${direction}`);
  const availableFeatures = new Set(textList(raw?.availableFeatures ?? [], "availableFeatures").map((feature) => feature.toUpperCase()));
  const context = { market, availableFeatures, maxDepth: raw?.limits?.maxDepth ?? 8, maxNodes: raw?.limits?.maxNodes ?? 64, name: "entryFormula" };
  const entryFormula = normalizeAst(raw?.entryFormula, context);
  const exitFormula = normalizeAst(raw?.exitFormula, { ...context, name: "exitFormula" });
  const parameters = normalizeParameters(raw?.parameters ?? {});
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
      candidates.push(createBoundedStrategySpecification({ ...baseSpecification, parameters }));
    }
  }
  return Object.freeze(candidates);
}
