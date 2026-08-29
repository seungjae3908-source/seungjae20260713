import assert from "node:assert/strict";
import test from "node:test";

import {
  openPositionsForSchedulerMarket,
  validatePaperSchedulerPositionObservationTransport,
} from "../src/paper-scheduler-position-observation-transport-v1.js";
import { runScheduledPaperCycle } from "../src/paper-scheduler-driver-v1.js";

const NOW = 1_800_000_000_000;
const SHA = "a".repeat(40);
const ACCOUNT_DIGEST = "b".repeat(64);
const ENTRY_PROVENANCE_DIGEST = "c".repeat(64);
const ENTRY_SNAPSHOT_DIGEST = "d".repeat(64);
const identity = Object.freeze({
  strategyId: "paper-natural-v1",
  strategyVersion: "1.0.0",
  parameterHash: "parameter-v1",
  researchCodeSha: SHA,
  costPolicyVersion: "cost-v1",
  executionPolicyVersion: "execution-v1",
});
const riskPolicyIdentity = Object.freeze({
  policyId: "risk-policy-v1",
  policyVersion: "1.0.0",
  recordId: "risk-record-v1",
  recordVersion: "7",
  source: "canonical-risk-policy-record",
  researchCodeSha: SHA,
});
const accountIdentity = Object.freeze({
  accountId: "paper-account-v1",
  publisherAccountIdSha256: ACCOUNT_DIGEST,
  sourceSha: SHA,
});
const entryEvidenceProvenance = Object.freeze({
  schemaVersion: "paper-evidence-provenance-v1",
  provider: "bitget",
  provenance: "public-entry-evidence",
  market: "CRYPTO_FUTURES",
  symbol: "BTCUSDT",
  timeframe: "15m",
  asOfMs: NOW - 200,
  publicOnly: true,
  dataQuality: "READY",
  provenanceDigest: ENTRY_PROVENANCE_DIGEST,
  evidenceSnapshotDigest: ENTRY_SNAPSHOT_DIGEST,
});

function position() {
  return Object.freeze({
    positionId: "position-v1",
    paperSampleId: "paper-sample-v1",
    signalId: "signal-v1",
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    direction: "LONG",
    strategyId: identity.strategyId,
    strategyVersion: identity.strategyVersion,
    parameterHash: identity.parameterHash,
    researchCodeSha: SHA,
    costPolicyVersion: identity.costPolicyVersion,
    entryTimestampMs: NOW - 100,
    quantity: 1,
    entryFillPrice: 100,
    lifecycleState: "OPEN",
    riskPolicyIdentity,
    sample: Object.freeze({
      entryEvidenceProvenance,
      riskPolicyIdentity,
    }),
    lifecycle: Object.freeze({
      sampleEligibility: Object.freeze({
        provenanceClass: "NATURAL_FORWARD",
        entryObservationId: "entry-natural-observation-v1",
        naturalSampleCredit: 0,
        testOnlySampleCredit: 0,
      }),
    }),
  });
}

function state(open = true) {
  return Object.freeze({
    identity,
    identityFingerprint: "paper-identity-fingerprint-v1",
    positions: Object.freeze(open ? [position()] : []),
    ledger: Object.freeze({
      accountBinding: Object.freeze({
        ...accountIdentity,
        seedStateDigestSha256: "e".repeat(64),
      }),
    }),
  });
}

function component(name, observedAtMs, value = 0) {
  return Object.freeze({
    state: "PRESENT",
    countsAsExecutionCost: true,
    value,
    unit: "PERCENT",
    quality: value === 0 ? "MEASURED_ZERO" : "OBSERVED",
    source: `public-${name}-evidence`,
    observedAtMs,
  });
}

function observation(cycle, overrides = {}) {
  const observedAtMs = NOW - 10;
  const base = {
    observationId: "position-observation-v1",
    positionId: "position-v1",
    paperSampleId: "paper-sample-v1",
    signalId: "signal-v1",
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    direction: "LONG",
    strategyId: identity.strategyId,
    strategyVersion: identity.strategyVersion,
    parameterHash: identity.parameterHash,
    researchCodeSha: SHA,
    costPolicyVersion: identity.costPolicyVersion,
    cycleIdentity: {
      cycleId: cycle.cycleId,
      strategyId: identity.strategyId,
      strategyVersion: identity.strategyVersion,
      parameterHash: identity.parameterHash,
      researchCodeSha: SHA,
      costPolicyVersion: identity.costPolicyVersion,
    },
    accountIdentity,
    riskPolicyIdentity,
    entryEvidenceProvenance,
    publicOnly: true,
    source: "public-position-observation",
    provenance: "future-natural-public-position-observation",
    observedAtMs,
    maxAgeMs: 60_000,
    bar: { open: 100, high: 102, low: 99, close: 101 },
    naturalEvidence: {
      provenanceClass: "NATURAL_FORWARD",
      synthetic: false,
      replay: false,
      backfill: false,
      duplicate: false,
      testOnly: false,
      observationId: "position-observation-v1",
      source: "public-position-observation",
      provenance: "future-natural-public-position-observation",
      observedAtMs,
    },
    settlementCostEvidence: {
      schemaVersion: "authoritative-paper-execution-cost-sources-v1",
      status: "PRESENT",
      fullCostReady: true,
      unknownIsZero: false,
      unavailableCostConvertedToZero: false,
      supplementalCostInput: { costPolicyId: identity.costPolicyVersion },
      components: {
        fees: component("fees", observedAtMs, 0.1),
        spread: component("spread", observedAtMs),
        slippage: component("slippage", observedAtMs),
        funding: component("funding", observedAtMs),
        latency: component("latency", observedAtMs),
        liquidityImpact: component("liquidity-impact", observedAtMs),
        partialFillImpact: component("partial-fill-impact", observedAtMs),
      },
    },
    settlementInput: {
      exitExecution: { source: "public-exit-execution" },
      fundingEvidence: { complete: true, payments: [] },
    },
  };
  return {
    ...base,
    ...overrides,
    cycleIdentity: { ...base.cycleIdentity, ...(overrides.cycleIdentity ?? {}) },
    naturalEvidence: { ...base.naturalEvidence, ...(overrides.naturalEvidence ?? {}) },
    settlementCostEvidence: overrides.settlementCostEvidence ?? base.settlementCostEvidence,
  };
}

function lanes(cycle, supplied = [observation(cycle)]) {
  return [
    { market: "KR_STOCK", result: { positionObservations: [] } },
    { market: "US_STOCK", result: { positionObservations: [] } },
    { market: "CRYPTO_SPOT", result: { positionObservations: [] } },
    { market: "CRYPTO_FUTURES", result: { positionObservations: supplied } },
  ];
}

function codes(result) {
  return new Set(result.blockers.map((row) => row.code));
}

test("market-scoped open Position snapshots are immutable copies", () => {
  const source = state();
  const rows = openPositionsForSchedulerMarket(source, "CRYPTO_FUTURES");
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0], source.positions[0]);
  assert.equal(rows[0].positionId, source.positions[0].positionId);
  assert.equal(Object.isFrozen(rows[0]), true);
  assert.equal(openPositionsForSchedulerMarket(source, "KR_STOCK").length, 0);
});

test("complete future Natural observation passes exact identity, account, risk, entry and full-cost gates", () => {
  const cycle = { cycleId: "paper-hourly-v1:500000", identity };
  const result = validatePaperSchedulerPositionObservationTransport({
    state: state(), cycle, lanes: lanes(cycle), evaluatedAtMs: NOW,
  });
  assert.equal(result.status, "READY");
  assert.equal(result.blockers.length, 0);
  assert.equal(result.positionObservations.length, 1);
  assert.equal(result.positionObservations[0].observationId, "position-observation-v1");
});

test("replay, backfill, synthetic, duplicate and test-only observations cannot enter the lifecycle", () => {
  const cycle = { cycleId: "paper-hourly-v1:500000", identity };
  for (const flag of ["replay", "backfill", "synthetic", "duplicate", "testOnly"]) {
    const naturalEvidence = {
      replay: false, backfill: false, synthetic: false, duplicate: false, testOnly: false,
      [flag]: true,
    };
    const result = validatePaperSchedulerPositionObservationTransport({
      state: state(),
      cycle,
      lanes: lanes(cycle, [observation(cycle, { naturalEvidence })]),
      evaluatedAtMs: NOW,
    });
    assert.equal(result.status, "BLOCKED_DATA", flag);
    assert.equal(codes(result).has("PAPER_POSITION_NATURAL_PROVENANCE_INVALID"), true, flag);
    assert.equal(result.positionObservations.length, 0, flag);
  }
});

test("wrong cycle/account/risk identity and missing Entry provenance fail closed", () => {
  const cycle = { cycleId: "paper-hourly-v1:500000", identity };
  const cases = [
    [observation(cycle, { cycleIdentity: { cycleId: "wrong-cycle" } }), "PAPER_POSITION_OBSERVATION_CYCLE_IDENTITY_MISMATCH"],
    [observation(cycle, { accountIdentity: { ...accountIdentity, accountId: "wrong-account" } }), "PAPER_POSITION_ACCOUNT_IDENTITY_MISMATCH"],
    [observation(cycle, { riskPolicyIdentity: { ...riskPolicyIdentity, policyVersion: "wrong" } }), "PAPER_POSITION_RISK_POLICY_IDENTITY_MISMATCH"],
    [observation(cycle, { entryEvidenceProvenance: null }), "PAPER_POSITION_ENTRY_PROVENANCE_MISMATCH"],
  ];
  for (const [value, expected] of cases) {
    const result = validatePaperSchedulerPositionObservationTransport({
      state: state(), cycle, lanes: lanes(cycle, [value]), evaluatedAtMs: NOW,
    });
    assert.equal(result.status, "BLOCKED_DATA", expected);
    assert.equal(codes(result).has(expected), true, expected);
    assert.equal(result.positionObservations.length, 0, expected);
  }
});

test("one unknown full-cost component blocks lifecycle handoff instead of becoming zero", () => {
  const cycle = { cycleId: "paper-hourly-v1:500000", identity };
  const value = observation(cycle);
  value.settlementCostEvidence = {
    ...value.settlementCostEvidence,
    components: {
      ...value.settlementCostEvidence.components,
      liquidityImpact: {
        ...value.settlementCostEvidence.components.liquidityImpact,
        state: "MISSING",
        value: null,
      },
    },
  };
  const result = validatePaperSchedulerPositionObservationTransport({
    state: state(), cycle, lanes: lanes(cycle, [value]), evaluatedAtMs: NOW,
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(codes(result).has("PAPER_POSITION_FULL_COST_EVIDENCE_MISSING"), true);
  assert.equal(result.positionObservations.length, 0);
});

test("an open Position requires exactly one observation while a flat market requires none", () => {
  const cycle = { cycleId: "paper-hourly-v1:500000", identity };
  const missing = validatePaperSchedulerPositionObservationTransport({
    state: state(), cycle, lanes: lanes(cycle, undefined), evaluatedAtMs: NOW,
  });
  assert.equal(missing.status, "BLOCKED_DATA");
  assert.equal(codes(missing).has("PAPER_POSITION_OBSERVATION_EVIDENCE_MISSING"), true);

  const flat = validatePaperSchedulerPositionObservationTransport({
    state: state(false),
    cycle,
    lanes: [
      { market: "KR_STOCK", result: {} },
      { market: "US_STOCK", result: {} },
      { market: "CRYPTO_SPOT", result: {} },
      { market: "CRYPTO_FUTURES", result: {} },
    ],
    evaluatedAtMs: NOW,
  });
  assert.equal(flat.status, "READY");
  assert.equal(flat.positionObservations.length, 0);
});

function leaseStore() {
  return {
    async acquire(input) { return { acquired: true, status: "ACQUIRED", token: "lease-token", ...input }; },
    async assertOwned() {},
    async complete() {},
    async release() {},
  };
}

function readyLane(market, cycle, openPositions) {
  return {
    status: "READY",
    publicOnly: true,
    market,
    observedAtMs: NOW - 10,
    maxAgeMs: 60_000,
    candidates: [],
    exits: [],
    positionObservations: market === "CRYPTO_FUTURES" && openPositions.length === 1
      ? [observation(cycle)]
      : [],
  };
}

test("scheduler supplies openPositions and forwards only validated positionObservations to runCycle", async () => {
  const providerCalls = [];
  const runCalls = [];
  const result = await runScheduledPaperCycle({
    state: state(),
    cadence: { version: "paper-hourly-v1", intervalMs: 3_600_000 },
    nowMs: NOW,
    ownerId: "worker-v1",
    leaseStore: leaseStore(),
    leaseDurationMs: 10_000,
    publicEvidenceProvider: {
      async collectPublicEvidence(input) {
        providerCalls.push(input);
        return readyLane(input.market, input.cycle, input.openPositions ?? []);
      },
    },
    retry: { maxAttempts: 1, baseBackoffMs: 1, timeoutMs: 100 },
    sleep: async () => {},
    clock: () => NOW,
    async runCycle(input) {
      runCalls.push(input);
      return { state: input.state, summary: { tradesSettled: 0 } };
    },
  });

  assert.equal(result.status, "COMPLETED");
  const futures = providerCalls.find((row) => row.market === "CRYPTO_FUTURES");
  assert.equal(futures.openPositions.length, 1);
  assert.equal(futures.openPositions[0].positionId, "position-v1");
  assert.equal(futures.cycle.identity.researchCodeSha, SHA);
  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].positionObservations.length, 1);
  assert.equal(runCalls[0].positionObservations[0].observationId, "position-observation-v1");
  assert.equal(runCalls[0].cycle.identity.researchCodeSha, SHA);
});

test("scheduler performs zero runCycle mutation when an open Position lacks genuine observation evidence", async () => {
  let runCalls = 0;
  const result = await runScheduledPaperCycle({
    state: state(),
    cadence: { version: "paper-hourly-v1", intervalMs: 3_600_000 },
    nowMs: NOW,
    ownerId: "worker-v1",
    leaseStore: leaseStore(),
    leaseDurationMs: 10_000,
    publicEvidenceProvider: {
      async collectPublicEvidence(input) {
        return {
          ...readyLane(input.market, input.cycle, input.openPositions ?? []),
          positionObservations: [],
        };
      },
    },
    retry: { maxAttempts: 1, baseBackoffMs: 1, timeoutMs: 100 },
    sleep: async () => {},
    clock: () => NOW,
    async runCycle(input) {
      runCalls += 1;
      return { state: input.state, summary: { tradesSettled: 0 } };
    },
  });

  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.mutationCount, 0);
  assert.equal(runCalls, 0);
  assert.equal(result.blockers.some((row) => row.positionObservationBlocker === "PAPER_POSITION_OBSERVATION_EVIDENCE_MISSING"), true);
});
