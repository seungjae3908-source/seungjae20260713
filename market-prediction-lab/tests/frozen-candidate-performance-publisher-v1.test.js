import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFrozenCandidatePerformanceSourceV1,
  FROZEN_CANDIDATE_PERFORMANCE_RELATIVE_PATH,
  publishFrozenCandidatePerformanceV1,
} from "../src/frozen-candidate-performance-publisher-v1.js";
import {
  buildPhase4ProspectiveHandoffsV1,
  freezePhase4ChallengerV1,
} from "../src/phase4-frozen-challenger-core-v1.js";
import { FROZEN_CANDIDATE_MATCH_EVIDENCE_VERSION } from "../src/frozen-candidate-performance-reader-v1.js";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const CANDIDATE = `phase3-candidate:sha256:${"c".repeat(64)}`;
const FREEZE = "2026-09-13T00:00:00.000Z";
const IDENTITY = Object.freeze({
  candidateId: CANDIDATE,
  strategyFamily: "trend",
  strategyId: "trend-alpha",
  strategyVersion: "v1",
  parameterHash: DIGEST,
  parameterDigest: DIGEST,
  researchCodeSha: SHA,
  costPolicyVersion: "cost-v1",
  executionPolicyVersion: "paper-v1",
  market: "CRYPTO_FUTURES",
  provider: "bitget",
  symbol: "BTCUSDT",
  timeframe: "15m",
  sidePolicy: "LONG",
  accountMode: "PAPER",
});
const PROVENANCE = Object.freeze({
  evidenceClass: "PRODUCTION_AUTHORITATIVE",
  sourceOwner: "canonical-candidate-match-owner-v1",
  fixture: false,
  synthetic: false,
  replay: false,
  backfill: false,
  manual: false,
});

function phase4Result() {
  const admission = Object.freeze({
    status: "ADMITTED",
    candidateId: CANDIDATE,
    strategyFamily: IDENTITY.strategyFamily,
    strategyVersion: IDENTITY.strategyVersion,
    canonicalParameters: Object.freeze({ fast: 3, slow: 8 }),
    parameterDigest: DIGEST,
    marketType: "CRYPTO_FUTURES",
    market: IDENTITY.market,
    provider: IDENTITY.provider,
    symbol: IDENTITY.symbol,
    timeframe: IDENTITY.timeframe,
    sidePolicy: IDENTITY.sidePolicy,
    datasetIdentity: "canonical-future-train-v1",
    datasetDigest: "d".repeat(64),
    sourceFrameIdentity: "bitget-public-candles:BTCUSDT:15m",
    eventWindow: "closed-candle:15m",
    rankingPolicyDigest: "e".repeat(64),
    statisticalPolicyDigest: "f".repeat(64),
    sourceFinalistDigest: "1".repeat(64),
    tournamentRunId: `phase3-tournament:sha256:${"2".repeat(64)}`,
  });
  const frozen = freezePhase4ChallengerV1({
    admission,
    selection: Object.freeze({
      status: "SELECTED",
      candidateId: CANDIDATE,
      selectionPolicyDigest: "3".repeat(64),
    }),
    freezeTimestamp: FREEZE,
  });
  assert.equal(frozen.status, "FROZEN");
  return Object.freeze({
    status: "PROSPECTIVE_ADMISSION_READY",
    challenger: frozen.challenger,
    handoffs: buildPhase4ProspectiveHandoffsV1(frozen.challenger).handoffs,
  });
}

function ownerResult() {
  const phase4 = phase4Result();
  return Object.freeze({
    contract: "phase4-existing-owner-runtime-caller-v1",
    status: "PHASE4_EXISTING_OWNER_RUNTIME_CALLER_READY_NON_ACTIVATING",
    testOnly: false,
    ownerPreflightOnly: true,
    runtimeActivationAllowed: false,
    schedulerActivationAllowed: false,
    dispatchAllowed: false,
    economicCreditCreated: false,
    sampleCredit: 0,
    executionRealismCredit: 0,
    profitabilityCredit: 0,
    FULL_COST_READY: false,
    NET_ALPHA_PROVEN: false,
    PROFITABILITY_PROVEN: false,
    executionAuthority: "NONE",
    LIVE_TRADING: false,
    AUTO_TRADING: false,
    REAL_ORDER_ENABLED: false,
    PRIVATE_TRADING_API_ALLOWED: false,
    realOrderCount: 0,
    phase4Result: phase4,
    routed: Object.freeze({
      binding: Object.freeze({ candidateStrategyIdentity: IDENTITY }),
    }),
    consumer: Object.freeze({
      paper: Object.freeze({
        candidate: Object.freeze({
          paperIdentity: Object.freeze({
            ...IDENTITY,
            direction: IDENTITY.sidePolicy,
          }),
          signal: Object.freeze({
            market: IDENTITY.market,
            symbol: IDENTITY.symbol,
            timeframe: IDENTITY.timeframe,
            signalDirection: IDENTITY.sidePolicy,
            strategyIdentity: IDENTITY,
          }),
          execution: Object.freeze({ dataEvidence: Object.freeze({ provider: IDENTITY.provider }) }),
        }),
      }),
    }),
  });
}

const measured = (id) => Object.freeze({
  status: "MEASURED",
  count: 1,
  blocker: null,
  candidateBound: true,
  observationIds: Object.freeze([id]),
});

function stageEvidence() {
  return Object.freeze({
    schemaVersion: "authoritative-paper-runtime-stage-evidence-reader-v1",
    status: "AUTHORITATIVE_PAPER_RUNTIME_STAGES_RECONCILED",
    candidateIdentity: IDENTITY,
    runtimeStageMeasurements: Object.freeze({
      Entry: measured("entry-1"),
      Position: measured("position-1"),
      Settlement: measured("settlement-1"),
    }),
    sampleCredit: 0,
    executionRealismCredit: 0,
    profitabilityCredit: 0,
    executionAuthority: "NONE",
  });
}

function recurringState() {
  const entry = Object.freeze({
    paperSampleId: "entry-1",
    identity: Object.freeze({ ...IDENTITY, executionDirection: IDENTITY.sidePolicy }),
    profitEvidence: Object.freeze({ costPolicyId: IDENTITY.costPolicyVersion }),
    entryEvidenceProvenance: Object.freeze({ provider: IDENTITY.provider }),
  });
  return Object.freeze({
    samples: Object.freeze([entry]),
    positions: Object.freeze([{
      positionId: "position-1",
      ...IDENTITY,
      direction: IDENTITY.sidePolicy,
      sample: entry,
      lifecycle: Object.freeze({ processedObservationIds: Object.freeze(["mark-1"]) }),
    }]),
    settlements: Object.freeze([{
      settlementId: "settlement-1",
      ...IDENTITY,
      entryDirection: IDENTITY.sidePolicy,
      entryEvidenceProvenance: Object.freeze({ provider: IDENTITY.provider }),
      exitEvidenceProvenance: Object.freeze({ provider: IDENTITY.provider }),
      status: "SETTLED",
      grossPnl: 2,
      grossReturnPercent: 0.2,
      mfePercent: 0.4,
      maePercent: -0.1,
      holdingMs: 60_000,
    }]),
  });
}

function matchEvidence() {
  return Object.freeze({
    schemaVersion: FROZEN_CANDIDATE_MATCH_EVIDENCE_VERSION,
    status: "MEASURED",
    replay: false,
    backfill: false,
    synthetic: false,
    manual: false,
    provenance: PROVENANCE,
    observations: Object.freeze([Object.freeze({
      observationId: "match-1",
      observedAtMs: Date.parse(FREEZE) + 60_000,
      direction: "LONG",
      split: "TRAIN",
      identity: IDENTITY,
    })]),
  });
}

test("publisher writes the exact Dashboard canonical path and preserves owner-bound truth", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "candidate-performance-publisher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = createFrozenCandidatePerformanceSourceV1({
    existingOwnerRuntimeResult: ownerResult(),
    candidateMatchEvidence: matchEvidence(),
    effectiveIndependentMarketN: 92,
  });
  const published = await publishFrozenCandidatePerformanceV1({
    rootDirectory: root,
    source,
    reconciledStageEvidence: stageEvidence(),
    recurringState: recurringState(),
  });
  const artifact = JSON.parse(await readFile(join(root, ...FROZEN_CANDIDATE_PERFORMANCE_RELATIVE_PATH.split("/")), "utf8"));
  assert.equal(published.status, "PUBLISHED");
  assert.equal(published.evidenceStatus, "PRESENT");
  assert.equal(published.artifactRelativePath, "status/candidate-performance.json");
  assert.equal(artifact.candidateId, CANDIDATE);
  assert.equal(artifact.identity14Verified, true);
  assert.equal(artifact.candidateMatchedN, 1);
  assert.equal(artifact.Entry_N, 1);
  assert.equal(artifact.Settlement_N, 1);
  assert.equal(artifact.Gross_PnL, 2);
  assert.equal(artifact.Net_PnL, null);
  assert.equal(artifact.executionAuthority, "NONE");
});

test("missing or non-production owner source still publishes a zero-credit BLOCKED artifact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "candidate-performance-blocked-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = await publishFrozenCandidatePerformanceV1({ rootDirectory: root });
  assert.equal(missing.evidenceStatus, "BLOCKED");
  let artifact = JSON.parse(await readFile(join(root, "status", "candidate-performance.json"), "utf8"));
  assert.equal(artifact.FIRST_ZERO, "PHASE4_EXISTING_OWNER_PERFORMANCE_SOURCE_MISSING");
  assert.equal(artifact.candidateMatchedN, null);

  const unsafeOwner = structuredClone(ownerResult());
  unsafeOwner.testOnly = true;
  assert.throws(
    () => createFrozenCandidatePerformanceSourceV1({ existingOwnerRuntimeResult: unsafeOwner }),
    /PHASE4_EXISTING_OWNER_PERFORMANCE_SOURCE_INVALID/u,
  );
  artifact = JSON.parse(await readFile(join(root, "status", "candidate-performance.json"), "utf8"));
  assert.equal(artifact.backfillCredit, 0);
  assert.equal(artifact.replayCredit, 0);
  assert.equal(artifact.syntheticCredit, 0);
  assert.equal(artifact.manualEconomicCredit, 0);
});
