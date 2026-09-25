import assert from "node:assert/strict";
import test from "node:test";

import {
  FROZEN_CANDIDATE_FULL_COST_EVIDENCE_VERSION,
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
const PROVENANCE = Object.freeze({
  evidenceClass: "PRODUCTION_AUTHORITATIVE",
  sourceOwner: "canonical-phase4-owner-v1",
  fixture: false,
  synthetic: false,
  replay: false,
  backfill: false,
  manual: false,
});

function frozen(overrides = {}) {
  return Object.freeze({
    identity: Object.freeze({ ...IDENTITY, ...(overrides.identity ?? {}) }),
    freezeTimestamp: "2026-09-13T00:00:00.000Z",
    freezeTimestampMs: Date.parse("2026-09-13T00:00:00.000Z"),
    prospectiveOnly: true,
    retroactiveCreditAllowed: false,
    provenance: PROVENANCE,
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
    status: "MEASURED",
    provenance: PROVENANCE,
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
    recurringState: Object.freeze({
      samples: [], positions: [], settlements: [],
      ledger: Object.freeze({ sampleCount: 999, positionCount: 888, settlementCount: 777 }),
    }),
  });
  for (const key of ["candidateMatchedN", "Entry_N", "Position_N", "PositionObservation_N", "Settlement_N", "Gross_PnL", "Net_PnL"]) {
    assert.equal(result[key], null, key);
  }
  assert.equal(result.FIRST_ZERO, "CANDIDATE_MATCH_EVIDENCE_UNKNOWN");
  assert.equal(result.candidateMatchedN, null, "aggregate Paper ledger counts must never be borrowed");
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

test("fixture, test-path, synthetic, replay, backfill, and manual evidence are rejected", () => {
  const cases = [
    matches({ provenance: Object.freeze({ ...PROVENANCE, sourceOwner: "fixture-loader" }) }),
    matches({ provenance: Object.freeze({ ...PROVENANCE, sourcePath: "C:\\repo\\tests\\candidate.json" }) }),
    matches({ synthetic: true }),
    matches({ replay: true }),
    matches({ backfill: true }),
    matches({ manual: true }),
  ];
  for (const candidateMatchEvidence of cases) {
    const result = read({
      frozenCandidate: frozen(),
      reconciledStageEvidence: stageEvidence(),
      recurringState: state(),
      candidateMatchEvidence,
    });
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.candidateMatchedN, null);
    assert.equal(result.profitabilityCredit, 0);
  }
});

test("candidate match rejects candidate, strategy, symbol, timeframe, and provider mismatches independently", () => {
  const mismatches = {
    candidateId: `phase3-candidate:sha256:${"d".repeat(64)}`,
    strategyId: "other-strategy",
    symbol: "ETHUSDT",
    timeframe: "1h",
    provider: "other-provider",
  };
  for (const [field, value] of Object.entries(mismatches)) {
    const observations = matches().observations.map((row) => Object.freeze({
      ...row,
      identity: Object.freeze({ ...row.identity, [field]: value }),
    }));
    const result = read({
      frozenCandidate: frozen(),
      reconciledStageEvidence: stageEvidence(),
      recurringState: state(),
      candidateMatchEvidence: matches({ observations: Object.freeze(observations) }),
    });
    assert.equal(result.status, "BLOCKED", field);
    assert.match(result.reason, new RegExp(`${field}_MISMATCH`, "u"), field);
  }
});

test("measured zero remains zero and impossible lifecycle ordering fails closed", () => {
  const zero = stage(0, []);
  const measuredZero = read({
    frozenCandidate: frozen(),
    reconciledStageEvidence: stageEvidence({ stages: { Entry: zero, Position: zero, Settlement: zero } }),
    recurringState: Object.freeze({ samples: [], positions: [], settlements: [] }),
    candidateMatchEvidence: matches({ observations: Object.freeze([]) }),
  });
  for (const key of ["candidateMatchedN", "LONG_SIGNAL_N", "SHORT_SIGNAL_N", "NO_TRADE_N",
    "Entry_N", "Position_N", "PositionObservation_N", "Settlement_N", "WIN_N", "LOSS_N", "BREAKEVEN_N", "Gross_PnL"]) {
    assert.equal(measuredZero[key], 0, key);
  }

  const impossible = read({
    frozenCandidate: frozen(),
    reconciledStageEvidence: stageEvidence({
      stages: {
        Entry: stage(0, []),
        Position: stage(1, ["position-1"]),
        Settlement: stage(1, ["settlement-1"]),
      },
    }),
    recurringState: state(),
    candidateMatchEvidence: matches(),
  });
  assert.equal(impossible.status, "BLOCKED");
  assert.equal(impossible.reason, "CANDIDATE_PERFORMANCE_POSITION_EXCEEDS_ENTRY");
});

test("full cost categories preserve independent measured, modeled, unknown, and blocked states", () => {
  const components = Object.fromEntries([
    ["commission", { state: "MEASURED", valuePercent: 0.04, provenance: "canonical-fee-ledger-v1" }],
    ["tax", { state: "MODELED", valuePercent: 0, provenance: "canonical-tax-policy-v1" }],
    ["spread", { state: "UNKNOWN", valuePercent: null, provenance: null }],
    ["slippage", { state: "BLOCKED_DATA", valuePercent: null, provenance: null }],
    ["funding", { state: "UNKNOWN", valuePercent: null, provenance: null }],
    ["latency", { state: "UNKNOWN", valuePercent: null, provenance: null }],
    ["liquidityImpact", { state: "UNKNOWN", valuePercent: null, provenance: null }],
    ["partialFillImpact", { state: "UNKNOWN", valuePercent: null, provenance: null }],
  ]);
  const result = read({
    frozenCandidate: frozen(),
    reconciledStageEvidence: stageEvidence(),
    recurringState: state(),
    candidateMatchEvidence: matches(),
    fullCostEvidence: Object.freeze({
      schemaVersion: FROZEN_CANDIDATE_FULL_COST_EVIDENCE_VERSION,
      fullCostReady: false,
      components: Object.freeze(components),
      provenance: PROVENANCE,
    }),
  });
  assert.equal(result.status, "PRESENT");
  assert.equal(result.fullCostEvidence.components.commission.state, "MEASURED");
  assert.equal(result.fullCostEvidence.components.tax.state, "MODELED");
  assert.equal(result.fullCostEvidence.components.spread.state, "UNKNOWN");
  assert.equal(result.fullCostEvidence.components.slippage.state, "BLOCKED_DATA");
  assert.equal(result.FULL_COST_READY, false);
  assert.equal(result.Net_PnL, null);
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
