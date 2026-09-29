import assert from "node:assert/strict";
import test from "node:test";

import {
  RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_CAPABILITY_V1,
  RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_STAGES_V1,
  createResearchTournamentStageCheckpointCapabilityEvidenceV1,
  createResearchTournamentStageCheckpointV1,
  executeResearchTournamentStageCheckpointV1,
  verifyResearchTournamentStageCheckpointV1,
} from "../src/research-tournament-stage-checkpoint-resume-v1.js";

const SOURCE_SHA = "a".repeat(40);
const STRATEGY_HASH = "b".repeat(64);
const PARAMETER_IDENTITY = "c".repeat(64);
const FAMILY_SIZE = 64;

function createCheckpoint() {
  return createResearchTournamentStageCheckpointV1({
    sourceSha: SOURCE_SHA,
    profileId: "US_STOCK:SWING",
    formulaCandidateId: "formula:checkpoint:test",
    generatedCandidateId: "generated:checkpoint:test",
    strategyHash: STRATEGY_HASH,
    parameterIdentity: PARAMETER_IDENTITY,
    datasetIdentity: "dataset:train:checkpoint-test",
    originalCandidateFamilySize: FAMILY_SIZE,
    observedAt: "2026-09-03T03:00:00.000Z",
  });
}

function result(payload, evidence = {}, status = "PASS") {
  return {
    status,
    canonicalOwnerStage: payload.canonicalOwnerStage,
    ownerRefs: payload.ownerRefs,
    strategyHash: payload.identity.strategyHash,
    parameterIdentity: payload.identity.parameterIdentity,
    datasetIdentity: payload.identity.datasetIdentity,
    candidateFamilySize: payload.originalCandidateFamilySize,
    evidence,
    finalHoldoutAccess: false,
    automaticPromotionAllowed: false,
    executionAuthority: "NONE",
  };
}

function costEvidence() {
  return {
    commission: { value: 1, evidenceId: "fee" },
    spread: { value: 1, evidenceId: "spread" },
    slippage: { value: 1, evidenceId: "slippage" },
    tax: { value: 0, evidenceId: "tax" },
    funding: { value: 0, evidenceId: "funding" },
    latency: { value: 1, evidenceId: "latency" },
    liquidityImpact: { value: 1, evidenceId: "liquidity" },
  };
}

async function advance(checkpoint, stage, evidence = {}) {
  const definitionCallbacks = {
    SANITY_CHECK: "runSanityCheck",
    DEVELOPMENT_BACKTEST: "runDevelopmentBacktest",
    BLIND_OOS: "runBlindOos",
    PURGED_OOS: "runPurgedOos",
    WALK_FORWARD: "runWalkForward",
    COST_STRESS: "runCostStress",
    REGIME_STRESS: "runRegimeStress",
    STATISTICAL_FIREWALL: "runStatisticalFirewall",
  };
  const callback = definitionCallbacks[stage];
  const dependencies = callback
    ? { [callback]: async (payload) => result(payload, evidence) }
    : {};
  return executeResearchTournamentStageCheckpointV1(checkpoint, { stage }, dependencies);
}

test("capability exactly advertises #875 checkpoint/resume requirements without Final Holdout", () => {
  assert.deepEqual(
    RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_CAPABILITY_V1.properties.supportedStages,
    RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_STAGES_V1,
  );
  assert.equal(RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_CAPABILITY_V1.capability, "TOURNAMENT_STAGE_CHECKPOINT_RESUME_V1");
  assert.deepEqual(RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_CAPABILITY_V1.ownerRefs, ["#551"]);
  assert.equal(RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_CAPABILITY_V1.properties.checkpointResumeSupported, true);
  assert.equal(RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_CAPABILITY_V1.properties.monolithicFullDepthOnly, false);
  assert.equal(RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_CAPABILITY_V1.properties.finalHoldoutCallable, false);
  assert.equal(RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_STAGES_V1.includes("FINAL_HOLDOUT"), false);

  const evidence = createResearchTournamentStageCheckpointCapabilityEvidenceV1({ sourceSha: SOURCE_SHA });
  assert.equal(evidence.status, "AVAILABLE");
  assert.equal(evidence.sourceSha, SOURCE_SHA);
  assert.equal(evidence.reason, null);
  assert.match(evidence.evidenceId, /^tournament-stage-checkpoint-resume:sha256:[0-9a-f]{64}$/u);
});

test("checkpoint starts at FORMULA_CANDIDATE and rejects stage skipping", async () => {
  let checkpoint = createCheckpoint();
  assert.equal(verifyResearchTournamentStageCheckpointV1(checkpoint), true);
  assert.equal(checkpoint.currentStage, null);
  assert.equal(checkpoint.nextStage, "FORMULA_CANDIDATE");

  await assert.rejects(
    () => executeResearchTournamentStageCheckpointV1(checkpoint, { stage: "SANITY_CHECK" }, {}),
    /CHECKPOINT_STAGE_ORDER_INVALID/u,
  );

  checkpoint = await executeResearchTournamentStageCheckpointV1(
    checkpoint,
    { stage: "FORMULA_CANDIDATE" },
    {},
  );
  assert.equal(checkpoint.currentStage, "FORMULA_CANDIDATE");
  assert.equal(checkpoint.nextStage, "SANITY_CHECK");
  assert.equal(checkpoint.ownerCallCount, 0);
  assert.equal(checkpoint.records.length, 1);
  assert.equal(verifyResearchTournamentStageCheckpointV1(checkpoint), true);
});

test("one stage invocation calls exactly one canonical owner callback and resumes", async () => {
  let checkpoint = createCheckpoint();
  checkpoint = await advance(checkpoint, "FORMULA_CANDIDATE");

  let sanityCalls = 0;
  checkpoint = await executeResearchTournamentStageCheckpointV1(
    checkpoint,
    { stage: "SANITY_CHECK" },
    {
      runSanityCheck: async (payload) => {
        sanityCalls += 1;
        assert.equal(payload.originalCandidateFamilySize, FAMILY_SIZE);
        assert.equal(payload.finalHoldoutAccess, false);
        return result(payload, { checks: "PASS" });
      },
      runDevelopmentBacktest: async () => {
        throw new Error("must not be called in SANITY_CHECK invocation");
      },
    },
  );

  assert.equal(sanityCalls, 1);
  assert.equal(checkpoint.ownerCallCount, 1);
  assert.equal(checkpoint.nextStage, "DEVELOPMENT_BACKTEST");
  assert.equal(checkpoint.actualFinalHoldoutCalls, 0);
});

test("DEVELOPMENT_BASE_COST derives from the same backtest evidence without a second owner call", async () => {
  let checkpoint = createCheckpoint();
  checkpoint = await advance(checkpoint, "FORMULA_CANDIDATE");
  checkpoint = await advance(checkpoint, "SANITY_CHECK", { checks: "PASS" });

  let backtestCalls = 0;
  checkpoint = await executeResearchTournamentStageCheckpointV1(
    checkpoint,
    { stage: "DEVELOPMENT_BACKTEST" },
    {
      runDevelopmentBacktest: async (payload) => {
        backtestCalls += 1;
        return result(payload, {
          metrics: { trades: 60 },
          costEvidence: costEvidence(),
        });
      },
    },
  );
  const callsAfterBacktest = checkpoint.ownerCallCount;

  checkpoint = await executeResearchTournamentStageCheckpointV1(
    checkpoint,
    { stage: "DEVELOPMENT_BASE_COST" },
    {
      runDevelopmentBacktest: async () => {
        throw new Error("base cost must not rerun backtest");
      },
    },
  );

  assert.equal(backtestCalls, 1);
  assert.equal(checkpoint.ownerCallCount, callsAfterBacktest);
  assert.equal(checkpoint.records.at(-1).status, "PASS");
  assert.equal(checkpoint.records.at(-1).evidence.derivedFromStage, "DEVELOPMENT_BACKTEST");
  assert.equal(checkpoint.nextStage, "BLIND_OOS");
});

test("missing base-cost evidence fails closed instead of becoming zero", async () => {
  let checkpoint = createCheckpoint();
  checkpoint = await advance(checkpoint, "FORMULA_CANDIDATE");
  checkpoint = await advance(checkpoint, "SANITY_CHECK");
  checkpoint = await advance(checkpoint, "DEVELOPMENT_BACKTEST", { metrics: { trades: 60 } });
  checkpoint = await advance(checkpoint, "DEVELOPMENT_BASE_COST");

  assert.equal(checkpoint.completed, true);
  assert.equal(checkpoint.status, "TERMINAL_FAIL_CLOSED");
  assert.equal(checkpoint.records.at(-1).status, "MISSING_EVIDENCE");
  assert.equal(checkpoint.records.at(-1).evidence.costEvidence, null);
});

test("candidate-family size cannot be laundered after adaptive halving", async () => {
  let checkpoint = createCheckpoint();
  checkpoint = await advance(checkpoint, "FORMULA_CANDIDATE");

  await assert.rejects(
    () => executeResearchTournamentStageCheckpointV1(
      checkpoint,
      { stage: "SANITY_CHECK" },
      {
        runSanityCheck: async (payload) => ({
          ...result(payload, { checks: "PASS" }),
          candidateFamilySize: FAMILY_SIZE - 1,
        }),
      },
    ),
    /CHECKPOINT_CANDIDATE_FAMILY_SIZE_MISMATCH/u,
  );
  assert.equal(checkpoint.nextStage, "SANITY_CHECK");
  assert.equal(checkpoint.records.length, 1);
});

test("identity substitution and authority elevation are rejected before checkpoint mutation", async () => {
  let checkpoint = createCheckpoint();
  checkpoint = await advance(checkpoint, "FORMULA_CANDIDATE");

  await assert.rejects(
    () => executeResearchTournamentStageCheckpointV1(
      checkpoint,
      { stage: "SANITY_CHECK" },
      {
        runSanityCheck: async (payload) => ({
          ...result(payload, { checks: "PASS" }),
          strategyHash: "d".repeat(64),
        }),
      },
    ),
    /CHECKPOINT_STAGE_IDENTITY_MISMATCH/u,
  );

  await assert.rejects(
    () => executeResearchTournamentStageCheckpointV1(
      checkpoint,
      { stage: "SANITY_CHECK" },
      {
        runSanityCheck: async (payload) => ({
          ...result(payload, { checks: "PASS" }),
          executionAuthority: "TRADE",
        }),
      },
    ),
    /CHECKPOINT_STAGE_AUTHORITY_ESCALATION/u,
  );
});

test("full checkpoint sequence ends at STATISTICAL_FIREWALL and never calls Final Holdout", async () => {
  let checkpoint = createCheckpoint();
  let finalHoldoutCalls = 0;
  let statisticalPayload = null;

  checkpoint = await advance(checkpoint, "FORMULA_CANDIDATE");
  checkpoint = await advance(checkpoint, "SANITY_CHECK", { checks: "PASS" });
  checkpoint = await advance(checkpoint, "DEVELOPMENT_BACKTEST", {
    metrics: { trades: 60 },
    costEvidence: costEvidence(),
  });
  checkpoint = await advance(checkpoint, "DEVELOPMENT_BASE_COST");
  checkpoint = await advance(checkpoint, "BLIND_OOS", { oos: "PASS" });
  checkpoint = await advance(checkpoint, "PURGED_OOS", { purged: "PASS" });
  checkpoint = await advance(checkpoint, "WALK_FORWARD", { windows: 4 });
  checkpoint = await advance(checkpoint, "COST_STRESS", { scenarios: 3 });
  checkpoint = await advance(checkpoint, "REGIME_STRESS", { regimes: 7 });

  checkpoint = await executeResearchTournamentStageCheckpointV1(
    checkpoint,
    { stage: "STATISTICAL_FIREWALL" },
    {
      runStatisticalFirewall: async (payload) => {
        statisticalPayload = payload;
        return result(payload, {
          candidateFamilySize: payload.originalCandidateFamilySize,
          dsr: "PASS",
          pbo: "PASS",
        });
      },
      runFinalHoldout: async () => {
        finalHoldoutCalls += 1;
        throw new Error("Final Holdout must be unreachable");
      },
    },
  );

  assert.equal(statisticalPayload.originalCandidateFamilySize, FAMILY_SIZE);
  assert.equal(finalHoldoutCalls, 0);
  assert.equal(checkpoint.actualFinalHoldoutCalls, 0);
  assert.equal(checkpoint.currentStage, "STATISTICAL_FIREWALL");
  assert.equal(checkpoint.nextStage, null);
  assert.equal(checkpoint.status, "READY_FOR_HANDOFF");
  assert.equal(checkpoint.completed, true);
  assert.equal(checkpoint.records.length, 10);
  assert.equal(verifyResearchTournamentStageCheckpointV1(checkpoint), true);

  await assert.rejects(
    () => executeResearchTournamentStageCheckpointV1(
      checkpoint,
      { stage: "FINAL_HOLDOUT" },
      { runFinalHoldout: async () => result({}, {}) },
    ),
    /CHECKPOINT_ALREADY_COMPLETE/u,
  );
});

test("missing canonical stage callback is explicit MISSING_EVIDENCE and terminal", async () => {
  let checkpoint = createCheckpoint();
  checkpoint = await advance(checkpoint, "FORMULA_CANDIDATE");
  checkpoint = await executeResearchTournamentStageCheckpointV1(
    checkpoint,
    { stage: "SANITY_CHECK" },
    {},
  );
  assert.equal(checkpoint.status, "TERMINAL_FAIL_CLOSED");
  assert.equal(checkpoint.records.at(-1).status, "MISSING_EVIDENCE");
  assert.equal(checkpoint.records.at(-1).evidence.blocker, "MISSING_CANONICAL_STAGE_CALLBACK");
});

test("checkpoint digest detects mutation", () => {
  const checkpoint = createCheckpoint();
  const tampered = {
    ...checkpoint,
    originalCandidateFamilySize: FAMILY_SIZE - 1,
  };
  assert.equal(verifyResearchTournamentStageCheckpointV1(tampered), false);
});
