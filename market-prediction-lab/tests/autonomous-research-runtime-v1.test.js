import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSafeFreeAiProviderMetadata,
  accessAutonomousFeatureCache,
  AUTONOMOUS_RUNTIME_WORKER_STAGES,
  buildAutonomousResearchRuntimeReadiness,
  buildAutonomousResearchRuntimeProductionPlan,
  buildAutonomousResearchRuntimeStatus,
  checkpointAutonomousRuntimeWorkerForRestart,
  createAutonomousResearchRuntimeState,
  executeAutonomousResearchWorkerRuntime,
  executeDualFreeAiRuntime,
  inspectAutonomousDatasetRuntime,
  recoverAutonomousRuntimeWorkers,
  verifyAutonomousFeatureCacheEntry,
  verifyAutonomousResearchRuntimeState,
} from "../src/autonomous-research-runtime-v1.js";
import { createDualFreeAiReviewPlan } from "../src/autonomous-strategy-formula-generator-v1.js";
import { buildAutonomousResearchJob } from "../src/autonomous-research-dispatcher-v1.js";
import { buildHistoricalCacheProvenance } from "../src/research-cache-provenance.js";

const SHA = "1234567890abcdef1234567890abcdef12345678";
const DATA_DIGEST = "a".repeat(64);
const CANDIDATE_DIGEST = "b".repeat(64);

function providers() {
  return [
    { providerId: "free-provider-one", modelId: "free-model-one", billingTier: "FREE", state: "AVAILABLE", priority: 0 },
    { providerId: "free-provider-two", modelId: "free-model-two", billingTier: "FREE", state: "AVAILABLE", priority: 1 },
  ];
}

function reviewOutput(slot) {
  return {
    slot: slot.slot,
    providerId: slot.providerId,
    conclusion: "PROPOSE_DETERMINISTIC_TEST",
    mechanismOrChallenge: slot.mode === "ADVERSARIAL" ? "challenge the hypothesis" : "propose the hypothesis",
    expectedRegime: "REQUIRES_TEST",
    findings: ["advisory output only"],
    proposedBoundedVariants: [{ lookback: 20 }],
    deterministicResolution: "RUN_CANONICAL_PIPELINE",
  };
}

function historical(datasetDigest = DATA_DIGEST) {
  return buildHistoricalCacheProvenance({
    market: "US_STOCK",
    symbol: "US_LIQUID_PIT",
    timeframe: "1d",
    provider: "PUBLIC_FIXTURE",
    providerVersion: "v1",
    requestedStartTime: 1_577_836_800_000,
    requestedEndTime: 1_609_459_200_000,
    datasetDigest,
    researchCodeSha: SHA,
    candleCount: 366,
    actualStartTime: 1_577_836_800_000,
    actualEndTime: 1_609_372_800_000,
  });
}

function job(suffix = "one", datasetDigest = DATA_DIGEST) {
  const candidateIdentity = suffix === "one" ? CANDIDATE_DIGEST : `${suffix.charCodeAt(0).toString(16)}`.repeat(64).slice(0, 64);
  return buildAutonomousResearchJob({
    market: "US_STOCK",
    direction: "BUY",
    strategyType: "SWING",
    universeId: `US_LIQUID_PIT_${suffix}`,
    timeframe: "1d",
    datasetId: `public-us-pit-${suffix}`,
    datasetDigest,
    candidate: {
      candidateIdentity,
      parameterHash: "c".repeat(64),
      formulaHash: "d".repeat(64),
      parameters: { lookback: 20 },
      specification: { availableFeatures: ["RETURNS", "ATR", "VWAP", "RVOL", "MOMENTUM", "VOLATILITY", "REGIME", "FUNDING", "OI", "BASIS", "LIQUIDITY"] },
    },
    costPolicy: { version: "cost-v1", provenance: "FIXTURE_ONLY" },
    splitPolicy: { version: "split-v1", finalHoldoutExcluded: true, selectionUsesFinalHoldout: false },
    decisionPolicy: { version: "decision-v1", minimumGate: {
      requirePositiveExpectancy: true,
      requirePositiveOosReturn: true,
      requirePositiveCostAdjustedExpectancy: true,
      requireLeakFreeHoldout: true,
      requireSufficientCoverage: true,
      minProfitFactor: 1.1,
      maxMaximumDrawdown: 0.25,
      minTradeCount: 30,
      minWalkForwardStability: 20,
      minCoverageRatio: 0.95,
    } },
    historicalCacheProvenance: historical(datasetDigest),
    evidenceClass: "E1_LITERATURE",
    noveltyClassification: "NOVEL_VARIANT",
    dualAiReviewStatus: "AI_REVIEW_AGREE",
    dataReady: true,
    researchCodeSha: SHA,
    submittedAt: "2026-08-21T06:00:00Z",
  });
}

function adapter() {
  return { adapterId: "us-stock-public-pit-v1", market: "US_STOCK", provider: "PUBLIC_FIXTURE", state: "AVAILABLE" };
}

async function inspectDataset({ job: current, adapter: currentAdapter }) {
  return {
    status: "READY",
    datasetId: current.datasetId,
    provider: currentAdapter.provider,
    coverage: { start: "2020-01-01T00:00:00Z", end: "2020-12-31T00:00:00Z", observationCount: 366 },
    range: { requestedStart: "2020-01-01T00:00:00Z", requestedEnd: "2020-12-31T00:00:00Z" },
    universe: { universeId: current.universeId, pointInTime: true },
    timeframes: [current.timeframe],
    dataFingerprint: current.datasetDigest,
    quality: { status: "PASS", pointInTimeSafe: true, missingRate: 0, duplicateCount: 0 },
    asOf: "2020-12-31T00:00:00Z",
    maxSourceTimestamp: "2020-12-30T00:00:00Z",
  };
}

async function computeFeatures({ requestedFeatures, datasetInspection }) {
  return {
    datasetFingerprint: datasetInspection.dataFingerprint,
    sourceMaxTimestamp: datasetInspection.maxSourceTimestamp,
    features: Object.fromEntries(requestedFeatures.map((feature) => [feature, { status: "COMPUTED", lag: 1 }])),
  };
}

function backtestDependencies() {
  return {
    loadHistoricalCache: async (expected) => expected,
    runCanonicalBacktest: async () => ({ status: "COMPLETED", grossMetrics: { totalReturn: 0.2, expectancy: 3, profitFactor: 1.8, maximumDrawdown: 0.1, tradeCount: 100 } }),
    evaluateCanonicalCosts: async () => ({ status: "PASS", netMetrics: { totalReturn: 0.14, expectancy: 2, costAdjustedExpectancy: 2, profitFactor: 1.5, maximumDrawdown: 0.12, tradeCount: 100 }, costDrag: 0.06 }),
    runStatisticalFirewall: async () => ({ status: "PASS", dsr: { passed: true }, pbo: { passed: true }, realityCheck: { passed: true }, spa: { passed: true } }),
    runCanonicalOos: async () => ({ status: "PASS", metrics: { totalReturn: 0.08, expectancy: 1, costAdjustedExpectancy: 1, profitFactor: 1.3, maximumDrawdown: 0.14, tradeCount: 50 }, dataCoverage: { sufficient: true, ratio: 0.99 }, holdoutLeakDetected: false }),
    runCanonicalWalkForward: async () => ({ status: "PASS", leakFree: true, windows: [
      { totalReturn: 0.04, profitFactor: 1.3, maximumDrawdown: 0.1 },
      { totalReturn: 0.02, profitFactor: 1.2, maximumDrawdown: 0.12 },
    ] }),
    runCanonicalCostStress: async () => ({ status: "PASS", survivedMultiples: [1, 1.25, 1.5, 2] }),
    runCanonicalRegimeStress: async () => ({ status: "PASS", regimes: { bull: "PASS", bear: "PASS", range: "PASS" } }),
  };
}

function workerDependencies(overrides = {}) {
  return {
    inspectDataset,
    computeFeatureBundle: computeFeatures,
    compileStrategySpecification: async ({ job: current }) => ({ status: "COMPILED", candidateIdentity: current.identity.candidateIdentityDigest }),
    backtestDependencies: backtestDependencies(),
    persistEvidenceArtifact: async ({ result }) => ({ artifactDigest: result.resultDigest, status: "RECORDED" }),
    resolveNextStage: async ({ result }) => ({ status: result.status, frozenCandidate: result.status === "FROZEN_ELIGIBLE" }),
    ...overrides,
  };
}

function workerInput(currentJob, overrides = {}) {
  return {
    job: currentJob,
    dataAdapter: adapter(),
    featureVersion: "runtime-features-v1",
    requestedFeatures: currentJob.candidate.specification.availableFeatures,
    startedAt: "2026-08-21T06:00:00Z",
    completedAt: "2026-08-21T06:00:01Z",
    maxRuntimeMs: 60_000,
    ...overrides,
  };
}

test("dual FREE AI runtime preserves role-swapped calls and persists provider failure for retry", async () => {
  assert.equal(assertSafeFreeAiProviderMetadata(providers()), true);
  const plan = createDualFreeAiReviewPlan({ evidenceFingerprint: "e".repeat(64), providers: providers() });
  const result = await executeDualFreeAiRuntime(createAutonomousResearchRuntimeState(), {
    plan,
    researchSourceId: "research-source-one",
    researchRecord: { title: "fixture" },
    analysis: { evidence: "fixture" },
    calledAt: "2026-08-21T06:00:00Z",
  }, async ({ slot }) => {
    if (slot.providerId === "free-provider-two") throw new Error("AI_PROVIDER_CALL_FAILED");
    return reviewOutput(slot);
  });
  assert.equal(result.calls.length, 4);
  assert.equal(result.calls.filter((call) => call.status === "FAILED").length, 2);
  assert.equal(result.calls.every((call) => call.inputEvidenceFingerprint === "e".repeat(64)), true);
  assert.equal(result.calls.every((call) => Object.hasOwn(call, "outputFingerprint") && Object.hasOwn(call, "failureReason")), true);
  assert.equal(result.calls.every((call) => Object.hasOwn(call, "reviewId") && Object.hasOwn(call, "provider") && Object.hasOwn(call, "model") && Object.hasOwn(call, "sourceFingerprint") && Object.hasOwn(call, "disagreementReason")), true);
  assert.equal(result.synthesis.status, "AI_REVIEW_INCOMPLETE");
  assert.equal(result.AI1Status, "AVAILABLE");
  assert.equal(result.AI2Status, "FAILED");
  assert.equal(Object.values(result.state.waitingForAi)[0].state, "WAITING_FOR_AI");
  assert.equal(Object.values(result.state.waitingForAi)[0].retryDisposition, "RETRY_LATER");
  assert.equal(result.paidFallbackUsed, false);
  assert.throws(() => assertSafeFreeAiProviderMetadata([{ ...providers()[0], apiKey: "must-not-enter-state" }]), /SECRET_METADATA_FORBIDDEN/);
  assert.throws(() => assertSafeFreeAiProviderMetadata([{ ...providers()[0], billingTier: "PAID" }]), /PAID_AI_PROVIDER_FORBIDDEN/);
});

test("missing market data adapter is explicit BLOCKED_DATA", async () => {
  const current = job();
  const result = await inspectAutonomousDatasetRuntime(createAutonomousResearchRuntimeState(), {
    job: current,
    adapter: null,
    observedAt: "2026-08-21T06:00:00Z",
  }, inspectDataset);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.inspection.reason, "DATA_ADAPTER_UNAVAILABLE");
  assert.equal(result.state.datasetInspections[current.jobId].status, "BLOCKED_DATA");
});

test("feature cache is identity-bound, integrity checked, and point-in-time safe", async () => {
  const current = job();
  const inspectionResult = await inspectAutonomousDatasetRuntime(createAutonomousResearchRuntimeState(), {
    job: current,
    adapter: adapter(),
    observedAt: "2026-08-21T06:00:00Z",
  }, inspectDataset);
  const input = {
    datasetId: current.datasetId,
    market: current.market,
    symbol: current.universeId,
    timeframe: current.timeframe,
    featureVersion: "runtime-features-v1",
    asOf: inspectionResult.inspection.asOf,
    observedAt: "2026-08-21T06:00:00Z",
    requestedFeatures: current.candidate.specification.availableFeatures,
    datasetInspection: inspectionResult.inspection,
  };
  const miss = await accessAutonomousFeatureCache(inspectionResult.state, input, computeFeatures);
  assert.equal(miss.status, "CACHE_MISS_STORED");
  assert.equal(verifyAutonomousFeatureCacheEntry(miss.entry), true);
  const hit = await accessAutonomousFeatureCache(miss.state, input, computeFeatures);
  assert.equal(hit.status, "CACHE_HIT");
  assert.equal(hit.entry.entryDigest, miss.entry.entryDigest);
  assert.equal(verifyAutonomousFeatureCacheEntry({ ...miss.entry, featureBundle: { RETURNS: { status: "CORRUPTED" } } }), false);
  await assert.rejects(() => accessAutonomousFeatureCache(inspectionResult.state, { ...input, featureVersion: "future-leak-v1" }, async (request) => ({
    ...(await computeFeatures(request)),
    sourceMaxTimestamp: "2021-01-01T00:00:00Z",
  })), /PIT_LEAK_DETECTED/);
});

test("canonical worker records exact lifecycle, evidence, duration, and duplicate result", async () => {
  const current = job();
  const first = await executeAutonomousResearchWorkerRuntime(createAutonomousResearchRuntimeState(), workerInput(current), workerDependencies());
  assert.equal(first.status, "FROZEN_ELIGIBLE");
  assert.equal(first.completed.durationMs, 1_000);
  assert.equal(first.completed.evidenceArtifact.status, "RECORDED");
  assert.equal(first.state.completedJobs[current.jobId].result.resultDigest, first.result.resultDigest);
  const stages = first.state.events.filter((event) => event.type === "WORKER_STAGE").map((event) => event.stage);
  assert.deepEqual(stages, AUTONOMOUS_RUNTIME_WORKER_STAGES);
  const duplicate = await executeAutonomousResearchWorkerRuntime(first.state, workerInput(current), workerDependencies());
  assert.equal(duplicate.status, "DUPLICATE_RESULT");
  assert.equal(Object.keys(duplicate.state.completedJobs).length, 1);
});

test("worker restart creates retry checkpoint without losing job identity", () => {
  const current = job();
  const checkpointed = checkpointAutonomousRuntimeWorkerForRestart(createAutonomousResearchRuntimeState(), current, {
    stage: "BACKTEST_EXECUTION",
    observedAt: "2026-08-21T06:00:00Z",
  });
  const recovered = recoverAutonomousRuntimeWorkers(checkpointed, { recoveredAt: "2026-08-21T06:01:00Z" });
  assert.equal(recovered.retryQueue[current.jobId].state, "RETRY_LATER");
  assert.equal(recovered.retryQueue[current.jobId].resumeFrom, "BACKTEST_EXECUTION");
  assert.equal(recovered.workerCheckpoints[current.jobId].strategyIdentity, current.identity.candidateIdentityDigest);
  assert.equal(verifyAutonomousResearchRuntimeState(recovered), true);
});

test("failed worker retry preserves the original failure audit and completes on a later attempt", async () => {
  const current = job();
  const failed = await executeAutonomousResearchWorkerRuntime(createAutonomousResearchRuntimeState(), workerInput(current), workerDependencies({
    compileStrategySpecification: async () => { throw new Error("INVALID_DSL"); },
  }));
  const retried = await executeAutonomousResearchWorkerRuntime(failed.state, workerInput(current, { retryFailed: true }), workerDependencies());
  assert.equal(retried.status, "FROZEN_ELIGIBLE");
  assert.equal(retried.state.failureHistory.length, 1);
  assert.equal(retried.state.failedJobs[current.jobId].reason, "INVALID_DSL");
  assert.equal(retried.state.workerCheckpoints[current.jobId].attempts, 2);
  assert.equal(retried.state.completedJobs[current.jobId].status, "FROZEN_ELIGIBLE");
});

test("invalid DSL, missing data, and evidence failure persist independently without stopping later jobs", async () => {
  const invalidJob = job("one");
  const invalid = await executeAutonomousResearchWorkerRuntime(createAutonomousResearchRuntimeState(), workerInput(invalidJob), workerDependencies({
    compileStrategySpecification: async () => { throw new Error("INVALID_DSL"); },
  }));
  assert.equal(invalid.status, "FAILED");
  assert.equal(invalid.failure.reason, "INVALID_DSL");

  const missingJob = job("two", "2".repeat(64));
  const missing = await executeAutonomousResearchWorkerRuntime(invalid.state, workerInput(missingJob, { dataAdapter: null }), workerDependencies());
  assert.equal(missing.status, "FAILED");
  assert.equal(missing.failure.reason, "DATA_ADAPTER_UNAVAILABLE");

  const evidenceJob = job("three", "3".repeat(64));
  const evidence = await executeAutonomousResearchWorkerRuntime(missing.state, workerInput(evidenceJob), workerDependencies({
    persistEvidenceArtifact: async () => { throw new Error("EVIDENCE_STORE_FAILED"); },
  }));
  assert.equal(evidence.status, "FAILED");
  assert.equal(evidence.failure.reason, "EVIDENCE_STORE_FAILED");

  const validJob = job("four", "4".repeat(64));
  const valid = await executeAutonomousResearchWorkerRuntime(evidence.state, workerInput(validJob), workerDependencies());
  assert.equal(valid.status, "FROZEN_ELIGIBLE");
  assert.equal(Object.keys(valid.state.failedJobs).length, 3);
  assert.equal(Object.keys(valid.state.completedJobs).length, 1);
});

test("read-only status uses NOT_AVAILABLE for missing observations and readiness never activates", () => {
  const state = createAutonomousResearchRuntimeState();
  const status = buildAutonomousResearchRuntimeStatus(state, { generatedAt: "2026-08-21T06:00:00Z" });
  assert.equal(status.collectorStatus, "NOT_AVAILABLE");
  assert.equal(status.lastResearchTime, "NOT_AVAILABLE");
  assert.equal(status.queueDepth, "NOT_AVAILABLE");
  assert.equal(status.candidateCount, "NOT_AVAILABLE");
  assert.equal(status.cacheHitRate, "NOT_AVAILABLE");
  assert.equal(status.missingRenderedAsZero, false);
  const readiness = buildAutonomousResearchRuntimeReadiness({
    AI_RUNTIME_CONNECTED: true,
    DATA_ADAPTER_CONNECTED: true,
    QUEUE_RUNTIME_CONNECTED: true,
    BACKTEST_WORKER_CONNECTED: true,
    EVIDENCE_PIPELINE_CONNECTED: true,
    STATUS_MODEL_CONNECTED: true,
    RESTART_SAFETY_VERIFIED: true,
    END_TO_END_RUNTIME_TEST_PASS: true,
  });
  assert.equal(readiness.AUTONOMOUS_RESEARCH_FACTORY_RUNTIME_READY, true);
  assert.equal(readiness.AUTONOMOUS_RESEARCH_FACTORY_ACTIVE, false);
  assert.equal(readiness.timerActivationRequested, false);
  const productionPlan = buildAutonomousResearchRuntimeProductionPlan({ stateRoot: "/approved-separate-runtime-state" });
  assert.deepEqual(productionPlan.workerRuntime.stages, AUTONOMOUS_RUNTIME_WORKER_STAGES);
  assert.equal(productionPlan.aiRuntime.billingTier, "FREE_ONLY");
  assert.equal(productionPlan.activationStatus, "PLAN_ONLY");
  assert.equal(productionPlan.serverRestartRequested, false);
  assert.equal(productionPlan.timerActivationRequested, false);
});
