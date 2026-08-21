import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTONOMOUS_RESEARCH_PILOT_PREQUEUE_STATES,
  buildAutonomousResearchActivationPreflightPlan,
  buildRealResearchPilotCatalog,
  evaluateAutonomousResearchPilotPrequeue,
  runAutonomousResearchFactoryPilot,
} from "../src/autonomous-research-pilot-v1.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const GENERATED_AT = "2026-08-21T09:00:00+09:00";

function run(overrides = {}) {
  return runAutonomousResearchFactoryPilot({
    researchCodeSha: SHA,
    generatedAt: GENERATED_AT,
    validationEvidence: {
      QUEUE_PIPELINE_TESTED: true,
      BACKTEST_HANDOFF_TESTED: true,
      EVIDENCE_PIPELINE_TESTED: true,
    },
    ...overrides,
  });
}

test("real research ingestion records five primary-source metadata records without forcing futures coverage", () => {
  const catalog = buildRealResearchPilotCatalog({ ingestedAt: GENERATED_AT });
  assert.equal(catalog.length, 5);
  assert.equal(catalog.every((item) => item.metadata.sourceQuality === "HIGH"), true);
  assert.equal(catalog.every((item) => item.metadata.ingestedAt.endsWith("Z")), true);
  assert.equal(catalog.every((item) => item.metadata.fullText == null && item.metadata.paperBody == null), true);
  assert.equal(catalog.some((item) => item.metadata.market === "KR_STOCK"), true);
  assert.equal(catalog.some((item) => item.metadata.market === "US_STOCK" || item.metadata.market === "DEVELOPED_STOCK"), true);
  assert.equal(catalog.some((item) => item.metadata.market === "CRYPTO_SPOT"), true);
  assert.equal(catalog.some((item) => item.metadata.market === "CRYPTO_FUTURES"), false);
  assert.deepEqual(catalog.map((item) => item.metadata.doi), [
    "10.1016/j.jfineco.2012.05.011",
    "10.1111/j.1540-6261.1992.tb04681.x",
    "10.1093/rfs/hhj020",
    "10.1016/j.physa.2014.07.075",
    "10.1111/jofi.13119",
  ]);
});

test("real pilot generates bounded DSL identities but fail-closes before queue and backtest when AI or data is unavailable", () => {
  const result = run();
  assert.equal(result.pilotMode, "REAL_PRIMARY_SOURCE_METADATA_SNAPSHOT");
  assert.equal(result.sourceCount, 5);
  assert.equal(result.aiReadiness.AI_DUAL_REVIEW_READY, "UNAVAILABLE");
  assert.deepEqual(Object.fromEntries(result.rows.map((row) => [row.pilotId, row.prequeue.status])), {
    FAMA_FRENCH_2012_MOMENTUM: "NEEDS_REVIEW",
    BROCK_LAKONISHOK_LEBARON_1992: "BLOCKED_DATA",
    GATEV_GOETZMANN_ROUWENHORST_2006: "INVALID_STRATEGY",
    CHOI_2014_PHYSICAL_MOMENTUM: "BLOCKED_DATA",
    LIU_TSYVINSKI_WU_2022: "INVALID_STRATEGY",
  });
  const generated = result.rows.filter((row) => row.strategy.candidate);
  assert.equal(generated.length, 3);
  for (const row of generated) {
    assert.match(row.strategy.candidate.strategyId, /^strategy:[0-9a-f]{64}$/);
    assert.match(row.strategy.candidate.strategyFamilyId, /^strategy-family:[0-9a-f]{64}$/);
    assert.match(row.strategy.candidate.variantId, /^variant:[0-9a-f]{64}$/);
    assert.match(row.strategy.candidate.parameterHash, /^[0-9a-f]{64}$/);
    assert.match(row.strategy.candidate.formulaFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(row.strategy.candidate.researchCodeSha, SHA);
    assert.equal(row.strategy.candidate.scannerEligible, false);
  }
  const fama = result.rows.find((row) => row.pilotId === "FAMA_FRENCH_2012_MOMENTUM");
  assert.deepEqual(fama.prequeue.reasons, ["AI_RESEARCH_UNAVAILABLE", "DUAL_AI_REVIEW_INCOMPLETE", "COST_POLICY_CALIBRATION_REQUIRED"]);
  assert.equal(result.queueJobsCreated.length, 0);
  assert.equal(result.backtestsExecuted.length, 0);
  assert.equal(result.finalHoldoutRequests.length, 0);
  assert.equal(result.evidence.immutable, true);
  assert.match(result.evidence.evidenceDigest, /^[0-9a-f]{64}$/);
  assert.equal(result.evidence.aiReviewEvidence, "NOT_AVAILABLE");
  assert.equal(result.evidence.backtestEvidence, "NOT_AVAILABLE");
});

test("prequeue duplicate and invalid DSL decisions are deterministic and persistent", () => {
  const first = run();
  const fama = first.rows.find((row) => row.pilotId === "FAMA_FRENCH_2012_MOMENTUM");
  const duplicate = run({ noveltyRegistry: { trialFingerprints: [fama.strategy.novelty.exactFingerprint] } });
  const duplicateFama = duplicate.rows.find((row) => row.pilotId === "FAMA_FRENCH_2012_MOMENTUM");
  assert.equal(duplicateFama.prequeue.status, "REJECTED_DUPLICATE");
  assert.equal(duplicateFama.prequeue.persistentFailureRequired, true);

  const invalid = evaluateAutonomousResearchPilotPrequeue({
    noveltyStatus: "NEW_RESEARCH_HYPOTHESIS",
    dslValid: false,
    dslFailureReason: "FUTURE_OR_SAME_BAR_LEAKAGE:MOMENTUM",
    featureSetValid: false,
    leakageDetected: true,
    dataStatus: "READY",
    leverageSupported: false,
    costStatus: "READY",
    aiReadiness: { AI_DUAL_REVIEW_READY: "READY" },
    aiReviewStatus: "AI_REVIEW_AGREE",
  });
  assert.equal(invalid.status, "INVALID_STRATEGY");
  assert.deepEqual(invalid.reasons, ["FUTURE_OR_SAME_BAR_LEAKAGE:MOMENTUM", "INVALID_FEATURE_SET", "LEAKAGE_DETECTED", "UNSUPPORTED_LEVERAGE"]);
  assert.equal(invalid.enqueuePerformed, false);
  assert.equal(invalid.persistentFailureRequired, true);
});

test("prequeue QUEUED outcome targets the existing #226 owner only after every gate passes", () => {
  assert.deepEqual(AUTONOMOUS_RESEARCH_PILOT_PREQUEUE_STATES, ["QUEUED", "REJECTED_DUPLICATE", "BLOCKED_DATA", "INVALID_STRATEGY", "NEEDS_REVIEW"]);
  const decision = evaluateAutonomousResearchPilotPrequeue({
    noveltyStatus: "NEW_RESEARCH_HYPOTHESIS",
    dslValid: true,
    featureSetValid: true,
    leakageDetected: false,
    dataStatus: "READY",
    leverageSupported: true,
    costStatus: "READY",
    aiReadiness: { AI_DUAL_REVIEW_READY: "READY" },
    aiReviewStatus: "AI_REVIEW_CONFLICT",
  });
  assert.equal(decision.status, "QUEUED");
  assert.equal(decision.canonicalQueueOwner, "#226");
  assert.equal(decision.experimentDedupOwner, "#482");
  assert.equal(decision.enqueuePerformed, false);
  assert.equal(decision.finalHoldoutOpened, false);
});

test("extended status and activation plan distinguish tested runtime capability from inactive providers and server", () => {
  const result = run();
  assert.equal(result.status.todayDiscovered, 5);
  assert.equal(result.status.aiReviewed, 0);
  assert.equal(result.status.generatedStrategies, 3);
  assert.equal(result.status.queuedJobs, 0);
  assert.equal(result.status.backtestMetrics, "NOT_AVAILABLE");
  assert.equal(result.status.OOSCandidates, "NOT_AVAILABLE");
  assert.equal(result.status.FREE_AI_RUNTIME_READY, true);
  assert.equal(result.status.AI_DUAL_REVIEW_RUNTIME_READY, true);
  assert.equal(result.status.REAL_RESEARCH_PILOT_RUN, true);
  assert.equal(result.status.REAL_STRATEGY_GENERATION_READY, true);
  assert.equal(result.status.QUEUE_PIPELINE_TESTED, true);
  assert.equal(result.status.BACKTEST_HANDOFF_TESTED, true);
  assert.equal(result.status.EVIDENCE_PIPELINE_TESTED, true);
  assert.equal(result.status.STATUS_API_EXTENDED, true);
  assert.equal(result.status.AUTONOMOUS_RESEARCH_FACTORY_READY_FOR_ACTIVATION, false);
  assert.equal(result.status.AUTONOMOUS_RESEARCH_FACTORY_ACTIVE, false);
  const plan = buildAutonomousResearchActivationPreflightPlan({ aiReadiness: result.aiReadiness });
  assert.equal(plan.activationStatus, "PREFLIGHT_ONLY");
  assert.equal(plan.canonicalOwner, "#226");
  assert.equal(plan.experimentDedup.owner, "#482");
  assert.equal(plan.checkpoint.restartSafe, true);
  assert.equal(plan.externalCalls.privateTradingApiAllowed, false);
  assert.equal(plan.serverRestartRequested, false);
  assert.equal(plan.timerActivationRequested, false);
  assert.equal(plan.permanentWorkerRequested, false);
});

test("pilot result is deterministic for the same exact code SHA and metadata timestamp", () => {
  const first = run();
  const second = run();
  assert.equal(second.evidence.evidenceDigest, first.evidence.evidenceDigest);
  assert.deepEqual(second.rows.map((row) => row.prequeue.decisionDigest), first.rows.map((row) => row.prequeue.decisionDigest));
  assert.deepEqual(second.evidence.strategyIdentities, first.evidence.strategyIdentities);
});
