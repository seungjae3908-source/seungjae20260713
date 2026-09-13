import assert from "node:assert/strict";
import test from "node:test";

import {
  FROZEN_CANDIDATE_MATCH_EVIDENCE_VERSION,
  readFrozenCandidatePerformanceV1 as read,
} from "../src/frozen-candidate-performance-reader-v1.js";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const CANDIDATE = `phase3-candidate:sha256:${"c".repeat(64)}`;
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

function frozen(overrides = {}) {
  return Object.freeze({
    identity: Object.freeze({ ...IDENTITY, ...(overrides.identity ?? {}) }),
    freezeTimestamp: "2026-09-13T00:00:00.000Z",
    freezeTimestampMs: Date.parse("2026-09-13T00:00:00.000Z"),
    prospectiveOnly: true,
    retroactiveCreditAllowed: false,
    ...overrides,
  });
}

const stage = (count, ids) => Object.freeze({
  status: "MEASURED",
  count,
  blocker: null,
  candidateBound: true,
  observationIds: Object.freeze(ids),
});

function stageEvidence(overrides = {}) {
  return Object.freeze({
    schemaVersion: "authoritative-paper-runtime-stage-evidence-reader-v1",
    status: "AUTHORITATIVE_PAPER_RUNTIME_STAGES_RECONCILED",
    candidateIdentity: Object.freeze({ ...IDENTITY, ...(overrides.identity ?? {}) }),
    runtimeStageMeasurements: Object.freeze({
      Entry: stage(1, ["entry-1"]),
      Position: stage(1, ["position-1"]),
      Settlement: stage(1, ["settlement-1"]),
      ...(overrides.stages ?? {}),
    }),
    sampleCredit: 0,
    executionRealismCredit: 0,
    profitabilityCredit: 0,
    executionAuthority: "NONE",
    ...overrides.root,
  });
}

function state() {
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
      entryEvidenceProvenance: Object.freeze({ provider: IDENTITY.provider }),
      sample: entry,
      lifecycle: Object.freeze({ processedObservationIds: Object.freeze(["mark-1", "mark-2"]) }),
    }]),
    settlements: Object.freeze([{
      settlementId: "settlement-1",
      ...IDENTITY,
      entryDirection: IDENTITY.sidePolicy,
      entryEvidenceProvenance: Object.freeze({ provider: IDENTITY.provider }),
      exitEvidenceProvenance: Object.freeze({ provider: IDENTITY.provider }),
      status: "SETTLED",
      grossPnl: 12,
      grossReturnPercent: 1.2,
      mfePercent: 2.1,
      maePercent: -0.4,
      holdingMs: 60_000,
    }]),
  });
}

function matches(overrides = {}) {
  const observation = (id, direction, split, identity = IDENTITY) => Object.freeze({
    observationId: id,
    observedAtMs: Date.parse("2026-09-13T00:01:00.000Z"),
    direction,
    split,
    identity: Object.freeze({ ...identity }),
  });
  return Object.freeze({
    schemaVersion: FROZEN_CANDIDATE_MATCH_EVIDENCE_VERSION,
    replay: false,
    backfill: false,
    synthetic: false,
    manual: false,
    observations: Object.freeze([
      observation("match-1", "LONG", "TRAIN"),
      observation("match-2", "SHORT", "VALIDATION"),
      observation("match-3", "NO_TRADE", "OOS"),
    ]),
    ...overrides,
  });
}

test("exact candidate-bound evidence exposes separate market N, lifecycle counts, and TRAIN diagnostic", () => {
  const result = read({
    frozenCandidate: frozen(),
    reconciledStageEvidence: stageEvidence(),
    recurringState: state(),
    candidateMatchEvidence: matches(),
    effectiveIndependentMarketN: 92,
  });

  assert.equal(result.status, "PRESENT");
  assert.equal(result.effectiveIndependentMarketN, 92);
  assert.equal(result.candidateMatchedN, 3);
  assert.equal(result.LONG_SIGNAL_N, 1);
  assert.equal(result.SHORT_SIGNAL_N, 1);
  assert.equal(result.NO_TRADE_N, 1);
  assert.equal(result.Entry_N, 1);
  assert.equal(result.Position_N, 1);
  assert.equal(result.PositionObservation_N, 2);
  assert.equal(result.Settlement_N, 1);
  assert.equal(result.TRAIN_N, 1);
  assert.equal(result.VALIDATION_N, 1);
  assert.equal(result.OOS_N, 1);
  assert.equal(result.Gross_PnL, 12);
  assert.equal(result.Net_PnL, null);
  assert.equal(result.FULL_COST_READY, false);
  assert.equal(result.NET_ALPHA_PROVEN, false);
  assert.equal(result.PROFITABILITY_PROVEN, false);
  assert.equal(result.executionAuthority, "NONE");
});

test("missing match and lifecycle evidence remains UNKNOWN rather than zero", () => {
  const unknown = Object.freeze({ status: "UNKNOWN", count: null, candidateBound: false, observationIds: Object.freeze([]) });
  const result = read({
    frozenCandidate: frozen(),
    reconciledStageEvidence: stageEvidence({ stages: { Entry: unknown, Position: unknown, Settlement: unknown } }),
    recurringState: Object.freeze({ samples: [], positions: [], settlements: [] }),
  });
  for (const key of ["candidateMatchedN", "Entry_N", "Position_N", "PositionObservation_N", "Settlement_N", "Gross_PnL", "Net_PnL"]) {
    assert.equal(result[key], null, key);
  }
  assert.equal(result.FIRST_ZERO, "CANDIDATE_MATCH_EVIDENCE_UNKNOWN");
});

test("full identity mismatch, replay, duplicate, and retroactive evidence fail closed", () => {
  const bad = `phase3-candidate:sha256:${"d".repeat(64)}`;
  const cases = [
    { reconciledStageEvidence: stageEvidence({ identity: { candidateId: bad } }), candidateMatchEvidence: matches() },
    { reconciledStageEvidence: stageEvidence(), candidateMatchEvidence: matches({ replay: true }) },
    { reconciledStageEvidence: stageEvidence(), candidateMatchEvidence: matches({ observations: Object.freeze([
      matches().observations[0], matches().observations[0],
    ]) }) },
    { reconciledStageEvidence: stageEvidence(), candidateMatchEvidence: matches({ observations: Object.freeze([{
      ...matches().observations[0], observedAtMs: Date.parse("2026-09-13T00:00:00.000Z"),
    }]) }) },
  ];
  for (const input of cases) {
    const result = read({ frozenCandidate: frozen(), recurringState: state(), ...input });
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.candidateMatchedN, null);
    assert.equal(result.profitabilityCredit, 0);
  }
});

test("duplicate lifecycle binding and missing freeze are blocked with no credit", () => {
  const duplicate = state();
  const result = read({
    frozenCandidate: frozen(),
    reconciledStageEvidence: stageEvidence(),
    recurringState: Object.freeze({ ...duplicate, samples: Object.freeze([...duplicate.samples, ...duplicate.samples]) }),
    candidateMatchEvidence: matches(),
  });
  assert.equal(result.status, "BLOCKED");
  assert.match(result.reason, /ENTRY_ROW_BINDING_INVALID/u);

  const missing = read({ reconciledStageEvidence: stageEvidence(), recurringState: state() });
  assert.equal(missing.status, "BLOCKED");
  assert.equal(missing.Entry_N, null);
  assert.equal(missing.replayCredit, 0);
});

test("stage evidence cannot be mixed with lifecycle rows from another candidate", () => {
  const recurringState = state();
  const result = read({
    frozenCandidate: frozen(),
    reconciledStageEvidence: stageEvidence(),
    recurringState: Object.freeze({
      ...recurringState,
      settlements: Object.freeze([{
        ...recurringState.settlements[0],
        candidateId: `phase3-candidate:sha256:${"d".repeat(64)}`,
      }]),
    }),
    candidateMatchEvidence: matches(),
  });
  assert.equal(result.status, "BLOCKED");
  assert.match(result.reason, /SETTLEMENT_candidateId_MISMATCH/u);
  assert.equal(result.Gross_PnL, null);
  assert.equal(result.profitabilityCredit, 0);
});

test("reader never mutates inputs", () => {
  const input = {
    frozenCandidate: structuredClone(frozen()),
    reconciledStageEvidence: structuredClone(stageEvidence()),
    recurringState: structuredClone(state()),
    candidateMatchEvidence: structuredClone(matches()),
    effectiveIndependentMarketN: 92,
  };
  const before = structuredClone(input);
  read(input);
  assert.deepEqual(input, before);
});
