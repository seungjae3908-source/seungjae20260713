import assert from "node:assert/strict";
import test from "node:test";

import { createGlobalStrategyResearchRegistry } from "../src/global-alpha-literature-registry-v1.js";
import {
  admitCollectorRecordToRegistry,
  buildCollectorRegistryRecordInput,
  createGlobalResearchCollector,
  ingestGlobalResearchMetadata,
  summarizeGlobalResearchCollector,
  verifyGlobalResearchCollector,
} from "../src/autonomous-global-research-collector-v1.js";
import {
  classifyStrategyNovelty,
  createBoundedStrategyCandidate,
  createBoundedStrategySpecification,
  createDualFreeAiReviewPlan,
  generateBoundedStrategyVariants,
  recordDualFreeAiReview,
  synthesizeDualFreeAiReview,
  verifyDualFreeAiReviewPlan,
} from "../src/autonomous-strategy-formula-generator-v1.js";

const codeSha = "0123456789abcdef0123456789abcdef01234567";

function famaMetadata(overrides = {}) {
  return {
    title: "Size, value, and momentum in international stock returns",
    authors: ["Eugene F. Fama", "Kenneth R. French"],
    venue: "Journal of Financial Economics",
    publicationDate: "2012-09-01",
    doi: "10.1016/j.jfineco.2012.05.011",
    canonicalUrl: "https://doi.org/10.1016/j.jfineco.2012.05.011",
    sourceClass: "PEER_REVIEWED_JOURNAL",
    sourceQuality: "HIGH",
    licenseStatus: "METADATA_PUBLIC",
    provenanceStatus: "DOCUMENTED",
    assetClass: "EQUITY",
    market: "DEVELOPED_STOCK",
    timeframe: "1mo",
    samplePeriod: { startDate: "1990-11-01", endDate: "2011-03-01" },
    reportedN: 245,
    datasetReference: { datasetId: "KEN_FRENCH_DEVELOPED_MOMENTUM", status: "PUBLIC_AUTHOR_DATA" },
    reportedMetrics: { sharpe: null },
    costAssumptions: null,
    strategyFamily: "CROSS_SECTIONAL_MOMENTUM",
    strategySummary: "Long prior winners and short prior losers",
    formulaSummary: "0.5 * Small WML + 0.5 * Big WML",
    abstractText: "Metadata-safe abstract excerpt supplied by the source adapter.",
    sourceProvenance: { provider: "DOI_METADATA", locator: "doi:10.1016/j.jfineco.2012.05.011" },
    ingestedAt: "2026-08-21T02:20:00Z",
    parserVersion: "collector-test-v1",
    ...overrides,
  };
}

function freeProviders() {
  return [
    { providerId: "free-ai-1", modelId: "open-model-a", billingTier: "FREE", state: "AVAILABLE", priority: 0 },
    { providerId: "free-ai-2", modelId: "open-model-b", billingTier: "FREE", state: "AVAILABLE", priority: 1 },
    { providerId: "paid-ai", modelId: "paid-model", billingTier: "PAID", state: "AVAILABLE", priority: 0 },
  ];
}

function momentumSpecification(overrides = {}) {
  return createBoundedStrategySpecification({
    market: "US_STOCK",
    direction: "BUY",
    timeframe: "1d",
    universe: { type: "POINT_IN_TIME_LIQUID_COMMON_STOCK" },
    availableFeatures: ["MOMENTUM", "LIQUIDITY", "ATR"],
    entryFormula: {
      op: "AND",
      args: [
        { op: "GT", args: [{ op: "FEATURE", feature: "MOMENTUM", lag: 1 }, { op: "CONSTANT", value: 0 }] },
        { op: "GT", args: [{ op: "FEATURE", feature: "LIQUIDITY", lag: 1 }, { op: "CONSTANT", value: 0 }] },
      ],
    },
    exitFormula: { op: "LT", args: [{ op: "FEATURE", feature: "MOMENTUM", lag: 1 }, { op: "CONSTANT", value: 0 }] },
    parameters: { lookback: { value: 20, min: 5, max: 120 }, atrStop: { value: 2, min: 0.5, max: 5 } },
    holdingPeriod: { maxBars: 20 },
    rebalance: { cadence: "DAILY" },
    liquidityRequirement: { status: "EXPLICIT_INPUT_REQUIRED" },
    risk: { maxLeverage: 1, supportedLeverageConstraint: 1, sizingRule: { type: "BOUNDED_NOTIONAL" } },
    ...overrides,
  });
}

test("collector discovers lawful real research metadata without storing a paper body", () => {
  const collector = createGlobalResearchCollector({ cadencePolicy: { discoveryCadence: "CONFIG_REQUIRED", sourceRefreshCadence: "CONFIG_REQUIRED" } });
  const result = ingestGlobalResearchMetadata(collector, famaMetadata(), { nextCursor: "doi-page-2" });
  assert.equal(result.status, "DISCOVERED");
  assert.equal(result.record.reportedN, 245);
  assert.equal(result.record.copyrightedFullTextStored, false);
  assert.equal(result.record.costAssumptions, null);
  assert.equal(result.record.availability.costAssumptions, "NOT_REPORTED");
  assert.equal(verifyGlobalResearchCollector(result.state), true);
  assert.equal(summarizeGlobalResearchCollector(result.state).eventCounts.DISCOVERED, 1);
  assert.throws(() => ingestGlobalResearchMetadata(result.state, famaMetadata({ fullText: "copyrighted body" })), /FULL_TEXT_STORAGE_FORBIDDEN/);
});

test("collector deduplicates DOI ingestion and preserves an updated source revision", () => {
  const first = ingestGlobalResearchMetadata(createGlobalResearchCollector(), famaMetadata());
  const duplicate = ingestGlobalResearchMetadata(first.state, famaMetadata({ ingestedAt: "2026-08-21T02:21:00Z" }));
  assert.equal(duplicate.status, "ALREADY_KNOWN");
  assert.equal(duplicate.state.records.length, 1);
  const updated = ingestGlobalResearchMetadata(duplicate.state, famaMetadata({ venue: "JFE corrected metadata", ingestedAt: "2026-08-21T02:22:00Z" }));
  assert.equal(updated.status, "UPDATED_SOURCE");
  assert.equal(updated.state.records.length, 1);
  assert.equal(updated.state.records[0].revisions.length, 1);
});

test("collector fail-closes low quality, license, and data blockers", () => {
  const low = ingestGlobalResearchMetadata(createGlobalResearchCollector(), famaMetadata({ doi: "10.1234/low", sourceQuality: "LOW" }));
  assert.equal(low.status, "REJECTED_LOW_QUALITY");
  const license = ingestGlobalResearchMetadata(low.state, famaMetadata({ doi: "10.1234/license", licenseStatus: "PROPRIETARY_NO_ACCESS" }));
  assert.equal(license.status, "BLOCKED_LICENSE");
  const data = ingestGlobalResearchMetadata(license.state, famaMetadata({ doi: "10.1234/data", datasetReference: { status: "UNAVAILABLE" } }));
  assert.equal(data.status, "BLOCKED_DATA");
});

test("collector adapts admitted metadata into the canonical registry and Paper Genome", () => {
  const discovered = ingestGlobalResearchMetadata(createGlobalResearchCollector(), famaMetadata());
  const entry = discovered.state.records[0];
  const sourceId = entry.record.researchSourceId;
  const supported = (value, locator) => ({ value, extractionStatus: "SUPPORTED", confidence: "HIGH", sourceProvenance: { researchSourceId: sourceId, locator } });
  const paperGenome = {
    market: supported("DEVELOPED_STOCK", "paper:market"),
    timeframe: supported("1mo", "paper:timeframe"),
    direction: supported("LONG_SHORT", "paper:direction"),
    features: supported(["PRIOR_RETURN"], "paper:features"),
    formula: supported("0.5 * Small WML + 0.5 * Big WML", "paper:formula"),
    entryRule: supported("rank prior 12-2 month returns", "paper:entry"),
    exitRule: supported("monthly rebalance", "paper:exit"),
  };
  assert.equal(buildCollectorRegistryRecordInput(entry, { paperGenome }).study.sample.observationCount, 245);
  const registry = admitCollectorRecordToRegistry(createGlobalStrategyResearchRegistry(), entry, { paperGenome });
  assert.equal(registry.records.length, 1);
  assert.equal(registry.records[0].sourceMetadata.sampleN, 245);
  assert.equal(registry.safety.eligibleForScannerResearchConsideration, false);
});

test("dual review requires two distinct free providers and never uses paid fallback", () => {
  const ready = createDualFreeAiReviewPlan({ evidenceFingerprint: "evidence:real-paper", providers: freeProviders() });
  assert.equal(ready.status, "DUAL_FREE_AI_READY");
  assert.equal(ready.providers.length, 2);
  assert.equal(ready.providers.some((provider) => provider.billingTier === "PAID"), false);
  assert.equal(verifyDualFreeAiReviewPlan(ready), true);
  const incomplete = createDualFreeAiReviewPlan({ evidenceFingerprint: "evidence:real-paper", providers: freeProviders().slice(0, 1) });
  assert.equal(incomplete.status, "AI_REVIEW_INCOMPLETE");
  assert.equal(incomplete.paidAutoFallback, false);
});

test("role-reversed dual AI outputs preserve conflicts for deterministic experiments", () => {
  const plan = createDualFreeAiReviewPlan({ evidenceFingerprint: "evidence:momentum", providers: freeProviders() });
  const rows = plan.slots.map((slot, index) => recordDualFreeAiReview(plan, {
    slot: slot.slot,
    providerId: slot.providerId,
    conclusion: index === 1 ? "REJECT_HYPOTHESIS" : "PROPOSE_DETERMINISTIC_TEST",
    mechanismOrChallenge: index === 1 ? "Turnover may erase the effect" : "Persistent ranking may capture slow information diffusion",
    expectedRegime: "REGIME_REQUIRES_PIT_TEST",
    findings: [index === 1 ? "cost disagreement" : "mechanism hypothesis"],
    proposedBoundedVariants: [{ lookback: 20 }],
    deterministicResolution: "RUN_REAL_COST_STRESSED_BACKTEST",
  }));
  const synthesis = synthesizeDualFreeAiReview({ plan, reviews: rows });
  assert.equal(synthesis.status, "AI_REVIEW_CONFLICT");
  assert.deepEqual(synthesis.reviewConflictReason, ["cost disagreement"]);
  assert.equal(synthesis.preservedReviewOutputs.filter(Boolean).length, 4);
  assert.equal(synthesis.aiReviewCanPassStrategy, false);
});

test("AI review cannot inject PF EV MDD Sharpe or promotion authority", () => {
  const plan = createDualFreeAiReviewPlan({ evidenceFingerprint: "evidence:x", providers: freeProviders() });
  assert.throws(() => recordDualFreeAiReview(plan, {
    slot: plan.slots[0].slot,
    providerId: plan.slots[0].providerId,
    conclusion: "PROPOSE_DETERMINISTIC_TEST",
    mechanismOrChallenge: "test",
    findings: [],
    deterministicResolution: "backtest",
    sharpe: 9,
  }), /AI_NUMERIC_AUTHORITY_FORBIDDEN/);
});

test("bounded DSL blocks look-ahead unavailable features and cash-market leverage", () => {
  assert.throws(() => momentumSpecification({
    entryFormula: { op: "GT", args: [{ op: "FEATURE", feature: "MOMENTUM", lag: 0 }, { op: "CONSTANT", value: 0 }] },
  }), /FUTURE_OR_SAME_BAR_LEAKAGE/);
  assert.throws(() => momentumSpecification({
    entryFormula: { op: "GT", args: [{ op: "FEATURE", feature: "FUNDING", lag: 1 }, { op: "CONSTANT", value: 0 }] },
  }), /FEATURE_NOT_ALLOWED_FOR_MARKET/);
  assert.throws(() => momentumSpecification({ risk: { maxLeverage: 2, supportedLeverageConstraint: 2 } }), /LEVERAGE_FORBIDDEN/);
  assert.throws(() => momentumSpecification({ market: "CRYPTO_SPOT", direction: "SHORT" }), /DIRECTION_NOT_ALLOWED/);
});

test("candidate identities are deterministic and AI hypotheses require dual review", () => {
  const specification = momentumSpecification();
  assert.throws(() => createBoundedStrategyCandidate({
    specification,
    generationKind: "AI_PROPOSED_RESEARCH_HYPOTHESIS",
    researchSourceLinks: ["research-source:one"],
    generationReason: "AI hypothesis",
    researchCodeSha: codeSha,
    costPolicyVersion: "US_COST_V1",
  }), /DUAL_FREE_AI_REVIEW_REQUIRED/);
  const plan = createDualFreeAiReviewPlan({ evidenceFingerprint: "evidence:momentum", providers: freeProviders() });
  const reviews = plan.slots.map((slot) => recordDualFreeAiReview(plan, {
    slot: slot.slot,
    providerId: slot.providerId,
    conclusion: "PROPOSE_DETERMINISTIC_TEST",
    mechanismOrChallenge: "bounded proposal",
    findings: ["requires deterministic evidence"],
    deterministicResolution: "backtest",
  }));
  const dualAiReview = synthesizeDualFreeAiReview({ plan, reviews });
  const candidate = createBoundedStrategyCandidate({
    specification,
    generationKind: "AI_PROPOSED_RESEARCH_HYPOTHESIS",
    researchSourceLinks: ["research-source:one"],
    generationReason: "Test cross-sectional persistence after costs",
    researchCodeSha: codeSha,
    costPolicyVersion: "US_COST_V1",
    dualAiReview,
  });
  assert.match(candidate.strategyId, /^strategy:[0-9a-f]{64}$/);
  assert.match(candidate.variantId, /^variant:[0-9a-f]{64}$/);
  assert.match(candidate.parameterHash, /^[0-9a-f]{64}$/);
  assert.equal(candidate.safety.arbitraryExecutableCodeAllowed, false);
  assert.equal(candidate.scannerEligible, false);
});

test("renaming a failed candidate cannot evade novelty and Trial Registry identity", () => {
  const candidate = createBoundedStrategyCandidate({
    specification: momentumSpecification(),
    generationKind: "EXACT_PUBLISHED_STRATEGY",
    researchSourceLinks: ["research-source:one"],
    generationReason: "published formula",
    researchCodeSha: codeSha,
    costPolicyVersion: "US_COST_V1",
  });
  const exactFingerprint = classifyStrategyNovelty(candidate).exactFingerprint;
  assert.equal(classifyStrategyNovelty({ ...candidate, displayName: "renamed winner" }, { rejectedFingerprints: [exactFingerprint] }).status, "PREVIOUSLY_REJECTED");
  assert.equal(classifyStrategyNovelty(candidate, { trialFingerprints: [exactFingerprint] }).enqueueAllowed, false);
});

test("variant generation is bounded and axis-wise instead of Cartesian", () => {
  const variants = generateBoundedStrategyVariants({
    baseSpecification: momentumSpecification(),
    parameterVariants: { lookback: [10, 20, 40], atrStop: [1, 2, 3] },
    maxCandidates: 5,
  });
  assert.equal(variants.length, 5);
  assert.equal(new Set(variants.map((item) => item.specificationDigest)).size, 5);
  assert.equal(variants.every((item) => item.safety.boundedDslOnly), true);
});
