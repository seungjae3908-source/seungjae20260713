import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAutonomousResearchJob,
  buildAutonomousResearchProductionPlan,
  claimNextAutonomousResearchJob,
  createAutonomousResearchQueue,
  enqueueAutonomousResearchJob,
  executeAutonomousResearchJob,
  finalizeAutonomousResearchJob,
  recordAutonomousResearchResultEvidence,
  verifyAutonomousResearchQueue,
} from "../src/autonomous-research-dispatcher-v1.js";
import { buildHistoricalCacheProvenance } from "../src/research-cache-provenance.js";
import { createGlobalEvidenceLedger } from "../src/global-evidence-dedup-ledger-v1.js";
import { researchDigest } from "../src/research-trial-registry.js";

const SHA = "1234567890abcdef1234567890abcdef12345678";
const DATA_DIGEST = "a".repeat(64);

function historical(overrides = {}) {
  return buildHistoricalCacheProvenance({
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    timeframe: "1d",
    provider: "PUBLIC_FIXTURE",
    providerVersion: "v1",
    requestedStartTime: 1_577_836_800_000,
    requestedEndTime: 1_609_459_200_000,
    datasetDigest: DATA_DIGEST,
    researchCodeSha: SHA,
    candleCount: 366,
    actualStartTime: 1_577_836_800_000,
    actualEndTime: 1_609_372_800_000,
    ...overrides,
  });
}

function candidate(overrides = {}) {
  const base = {
    candidateIdentity: researchDigest({ family: "TREND", formula: "MOMENTUM" }),
    strategyIdentityDigest: researchDigest({ family: "TREND", formula: "MOMENTUM" }),
    parameterHash: researchDigest({ lookback: 20 }),
    formulaHash: researchDigest({ op: "GT", lag: 1 }),
    parameters: { lookback: { value: 20, min: 5, max: 120 } },
  };
  return { ...base, ...overrides };
}

function minimumGate() {
  return {
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
  };
}

function jobInput(overrides = {}) {
  return {
    candidate: candidate(),
    market: "CRYPTO_FUTURES",
    direction: "LONG",
    strategyType: "SWING",
    universeId: "BTCUSDT",
    timeframe: "1d",
    datasetId: "public-btc-daily-2020",
    datasetDigest: DATA_DIGEST,
    costPolicy: { version: "cost-v1", fee: "PROVENANCE_REQUIRED", slippage: "PROVENANCE_REQUIRED" },
    splitPolicy: { version: "split-v1", finalHoldoutExcluded: true, selectionUsesFinalHoldout: false },
    decisionPolicy: { version: "decision-v1", minimumGate: minimumGate() },
    historicalCacheProvenance: historical(),
    evidenceClass: "E2_REPLICATION",
    noveltyClassification: "NOVEL_VARIANT",
    dualAiReviewStatus: "AI_REVIEW_AGREE",
    dataReady: true,
    researchCodeSha: SHA,
    submittedAt: "2026-08-21T03:00:00Z",
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  return {
    loadHistoricalCache: async (expected) => expected,
    runCanonicalBacktest: async () => ({ status: "COMPLETED", grossMetrics: { totalReturn: 0.2, expectancy: 3, profitFactor: 1.8, maximumDrawdown: 0.1, tradeCount: 100 } }),
    evaluateCanonicalCosts: async () => ({ status: "PASS", netMetrics: { totalReturn: 0.14, expectancy: 2, costAdjustedExpectancy: 2, profitFactor: 1.5, maximumDrawdown: 0.12, tradeCount: 100 }, costDrag: 0.06 }),
    runStatisticalFirewall: async () => ({ status: "PASS", dsr: { passed: true }, pbo: { passed: true }, realityCheck: { passed: true }, spa: { passed: true } }),
    runCanonicalOos: async () => ({ status: "PASS", metrics: { totalReturn: 0.08, expectancy: 1, costAdjustedExpectancy: 1, profitFactor: 1.3, maximumDrawdown: 0.14, tradeCount: 50 }, dataCoverage: { sufficient: true, ratio: 0.99 }, holdoutLeakDetected: false }),
    runCanonicalWalkForward: async () => ({ status: "PASS", leakFree: true, windows: [
      { totalReturn: 0.04, profitFactor: 1.3, maximumDrawdown: 0.1 },
      { totalReturn: 0.02, profitFactor: 1.2, maximumDrawdown: 0.12 },
      { totalReturn: -0.01, profitFactor: 0.95, maximumDrawdown: 0.16 },
    ] }),
    runCanonicalCostStress: async () => ({ status: "PASS", survivedMultiples: [1, 1.25, 1.5, 2] }),
    runCanonicalRegimeStress: async () => ({ status: "PASS", regimes: { bull: "PASS", bear: "PASS", range: "PASS" } }),
    ...overrides,
  };
}

test("job schema is deterministic, four-market bounded, and priority cannot use profit", () => {
  const first = buildAutonomousResearchJob(jobInput());
  const second = buildAutonomousResearchJob(jobInput({ submittedAt: "2026-08-21T03:01:00Z" }));
  assert.equal(first.jobId, second.jobId);
  assert.equal(first.rankingGroup, "CRYPTO_FUTURES_SWING_LONG");
  assert.equal(first.canonicalBacktestOwner, "#226");
  assert.equal(first.canonicalEvidenceDedupOwner, "#482");
  assert.equal(first.safety.finalHoldoutOpened, false);
  assert.throws(() => buildAutonomousResearchJob(jobInput({ expectedProfit: 999 })), /CANNOT_USE_PROFIT/);
  assert.throws(() => buildAutonomousResearchJob(jobInput({ market: "CRYPTO_SPOT", direction: "SHORT" })), /DIRECTION_NOT_ALLOWED/);
});

test("queue deduplicates exact experiments and remains digest-verifiable", () => {
  const job = buildAutonomousResearchJob(jobInput());
  const first = enqueueAutonomousResearchJob(createAutonomousResearchQueue(), job);
  const duplicate = enqueueAutonomousResearchJob(first.queue, job);
  assert.equal(first.status, "QUEUED");
  assert.equal(duplicate.status, "DUPLICATE_JOB");
  assert.equal(duplicate.queueDepthDelta, 0);
  assert.equal(verifyAutonomousResearchQueue(duplicate.queue), true);
});

test("resource saturation produces QUEUE_WAIT without dropping a job", () => {
  const job = buildAutonomousResearchJob(jobInput());
  const queued = enqueueAutonomousResearchJob(createAutonomousResearchQueue({ limits: { maxWorkers: 1 } }), job);
  const result = claimNextAutonomousResearchJob(queued.queue, { activeWorkers: 1, cpuPercent: 20, memoryUsedMb: 100, freeDiskMb: 10_000 }, { claimedAt: "2026-08-21T03:02:00Z" });
  assert.equal(result.status, "QUEUE_WAIT");
  assert.equal(result.reason, "MAX_WORKERS");
  assert.equal(result.queue.jobs.length, 1);
});

test("dispatcher uses canonical callbacks and reaches only pre-holdout frozen eligibility", async () => {
  const job = buildAutonomousResearchJob(jobInput());
  const result = await executeAutonomousResearchJob(job, dependencies());
  assert.equal(result.status, "FROZEN_ELIGIBLE");
  assert.equal(result.frozenCandidate, false);
  assert.equal(result.finalHoldoutOpened, false);
  assert.deepEqual(result.evidence.costStress.survivedMultiples, [1, 1.25, 1.5, 2]);
  assert.equal(result.evidence.minimumGate.passed, true);
  assert.equal(result.safety.REAL_ORDER_ENABLED, false);
});

test("negative net expectancy is rejected before statistical or OOS callbacks", async () => {
  const called = [];
  const result = await executeAutonomousResearchJob(buildAutonomousResearchJob(jobInput()), dependencies({
    evaluateCanonicalCosts: async () => ({ status: "PASS", netMetrics: { expectancy: 0 } }),
    runStatisticalFirewall: async () => { called.push("statistics"); },
    runCanonicalOos: async () => { called.push("oos"); },
  }));
  assert.equal(result.status, "REJECTED");
  assert.equal(result.rejectionCode, "NON_POSITIVE_NET_EXPECTANCY");
  assert.deepEqual(called, []);
});

test("cache identity drift fails closed before a backtest", async () => {
  let backtestCalls = 0;
  const drift = historical({ providerVersion: "v2" });
  const result = await executeAutonomousResearchJob(buildAutonomousResearchJob(jobInput()), dependencies({
    loadHistoricalCache: async () => drift,
    runCanonicalBacktest: async () => { backtestCalls += 1; },
  }));
  assert.equal(result.rejectionCode, "CACHE_IDENTITY_MISMATCH");
  assert.equal(backtestCalls, 0);
});

test("statistical calibration remains CALIBRATION_REQUIRED instead of invented thresholds", async () => {
  const result = await executeAutonomousResearchJob(buildAutonomousResearchJob(jobInput()), dependencies({
    runStatisticalFirewall: async () => ({ status: "CALIBRATION_REQUIRED", reason: "DSR_THRESHOLD_NOT_PREREGISTERED" }),
  }));
  assert.equal(result.rejectionCode, "CALIBRATION_REQUIRED");
  assert.equal(result.stage, "STATISTICAL_FIREWALL");
  assert.equal(result.finalHoldoutOpened, false);
});

test("restart-safe terminal checkpoints reject duplicate completion", async () => {
  const job = buildAutonomousResearchJob(jobInput());
  const queued = enqueueAutonomousResearchJob(createAutonomousResearchQueue(), job);
  const claimed = claimNextAutonomousResearchJob(queued.queue, { activeWorkers: 0, cpuPercent: 10, memoryUsedMb: 100, freeDiskMb: 10_000 }, { claimedAt: "2026-08-21T03:02:00Z" });
  const result = await executeAutonomousResearchJob(job, dependencies());
  const completed = finalizeAutonomousResearchJob(claimed.queue, job, result, { completedAt: "2026-08-21T03:03:00Z" });
  assert.equal(completed.status, "FROZEN_ELIGIBLE");
  assert.equal(completed.queue.checkpoints[job.jobId].terminal, true);
  assert.throws(() => finalizeAutonomousResearchJob(completed.queue, job, result, { completedAt: "2026-08-21T03:04:00Z" }), /ACTIVE_JOB_CHECKPOINT_REQUIRED/);
});

test("#482 ledger gives a replay zero additional sample credit", async () => {
  const job = buildAutonomousResearchJob(jobInput());
  const result = await executeAutonomousResearchJob(job, dependencies());
  const runtime = { symbol: "BTCUSDT", observationTimestamp: "2020-12-31T00:00:00Z", horizon: "SWING" };
  const first = recordAutonomousResearchResultEvidence(createGlobalEvidenceLedger(), job, result, runtime);
  const replay = recordAutonomousResearchResultEvidence(first.ledger, job, result, runtime);
  assert.equal(first.status, "EVIDENCE_ACCEPTED");
  assert.equal(first.sampleCountDelta, 1);
  assert.equal(replay.status, "DUPLICATE_ACCEPTED_ONCE");
  assert.equal(replay.sampleCountDelta, 0);
});

test("Research Production plan is executable-only-after-approval and never activates a timer", () => {
  const blocked = buildAutonomousResearchProductionPlan();
  const prepared = buildAutonomousResearchProductionPlan({ stateRoot: "/var/lib/autonomous-research" });
  assert.equal(blocked.activationStatus, "PLAN_ONLY");
  assert.equal(blocked.executableWhenApproved, false);
  assert.equal(prepared.executableWhenApproved, true);
  assert.equal(prepared.timerActivationRequested, false);
  assert.equal(prepared.serverRestartRequested, false);
  assert.equal(prepared.jobSpec.expectedProfitPriorityAllowed, false);
  assert.equal(prepared.safety.LIVE_TRADING, false);
});
