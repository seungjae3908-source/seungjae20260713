import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PAPER_SCHEDULER_CONTRACT,
  PAPER_SCHEDULER_OWNER_LIVENESS,
  createFilePaperSchedulerLeaseStore,
  runScheduledPaperCycle,
} from "../src/paper-scheduler-driver-v1.js";
import { wrapPaperForwardProviderWithMeaningfulSearch } from "../src/meaningful-search-scheduled-paper-provider-v1.js";

const NOW = Date.parse("2026-08-15T03:00:00.000Z");
const CADENCE = Object.freeze({ version: "paper-hourly-v1", intervalMs: 60 * 60 * 1_000 });
const CYCLE_ID = "paper-hourly-v1:496323";
const LEASE_KEY = `paper:paper-identity-v1:${CYCLE_ID}`;
const LEASE_DURATION_MS = 30_000;

function state() {
  return { identityFingerprint: "paper-identity-v1" };
}

function readyLane(overrides = {}) {
  return {
    publicOnly: true,
    status: "READY",
    observedAtMs: NOW,
    maxAgeMs: 60_000,
    candidates: [],
    exits: [],
    ...overrides,
  };
}

function leasePaths(directory, leaseKey = LEASE_KEY) {
  const name = createHash("sha256").update(leaseKey).digest("hex");
  return {
    lease: join(directory, `${name}.lease`),
    owner: join(directory, `${name}.lease`, "owner.json"),
    completed: join(directory, `${name}.complete.json`),
  };
}

function leaseStore(directory, overrides = {}) {
  return createFilePaperSchedulerLeaseStore({
    directory,
    localHostId: "paper-host-a",
    localProcessId: 101,
    ownerLiveness: () => PAPER_SCHEDULER_OWNER_LIVENESS.ALIVE,
    ...overrides,
  });
}

async function harness(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "paper-scheduler-v1-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const providerCalls = [];
  const options = {
    state: state(),
    cadence: CADENCE,
    nowMs: NOW,
    ownerId: "worker-a",
    leaseDurationMs: LEASE_DURATION_MS,
    leaseStore: leaseStore(directory),
    publicEvidenceProvider: {
      async collectPublicEvidence(input) {
        providerCalls.push(input);
        return readyLane();
      },
    },
    retry: { maxAttempts: 3, baseBackoffMs: 1, timeoutMs: 100 },
    sleep: async () => {},
    clock: () => NOW,
    async runCycle(input) {
      calls.push(input);
      return {
        state: input.state,
        summary: { cycleId: input.cycle.cycleId, entries: 0, settled: 0 },
      };
    },
    ...overrides,
  };
  return { directory, calls, providerCalls, options };
}

test("deterministic public-only invocation uses an explicit versioned cadence", async (t) => {
  const { calls, providerCalls, options } = await harness(t);
  const result = await runScheduledPaperCycle(options);
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.cycleId, CYCLE_ID);
  assert.equal(calls.length, 1);
  assert.equal(providerCalls.length, 4);
  assert.deepEqual(
    new Set(providerCalls.map((row) => row.market)),
    new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]),
  );
  assert.deepEqual(result.safety, PAPER_SCHEDULER_CONTRACT);
  assert.equal(result.safety.privateAccountAccess, false);
  assert.equal(result.safety.liveTrading, false);
  assert.equal(result.safety.scheduleActive, false);
  assert.equal(result.safety.leaseScope, "SINGLE_HOST_FILE_CAS");
  assert.equal(result.safety.distributedMultiHostSupported, false);
});

test("two concurrent invocations elect one owner and the loser performs zero mutation", async (t) => {
  let releaseWinner;
  let markWinnerEntered;
  const gate = new Promise((resolve) => { releaseWinner = resolve; });
  const winnerEntered = new Promise((resolve) => { markWinnerEntered = resolve; });
  const { calls, options } = await harness(t, {
    async runCycle(input) {
      calls.push(input);
      markWinnerEntered();
      await gate;
      return { state: input.state, summary: { cycleId: input.cycle.cycleId } };
    },
  });

  const winner = runScheduledPaperCycle(options);
  await winnerEntered;
  const loser = await runScheduledPaperCycle({ ...options, ownerId: "worker-b" });
  releaseWinner();
  const completed = await winner;

  assert.equal(completed.status, "COMPLETED");
  assert.equal(loser.status, "SKIPPED_BUSY");
  assert.equal(loser.busyReason, "LIVE_LOCAL_OWNER");
  assert.equal(loser.mutationCount, 0);
  assert.equal(calls.length, 1);
});

test("a live local owner cannot be stolen after nominal lease duration", async (t) => {
  let releaseWinner;
  let markWinnerEntered;
  const gate = new Promise((resolve) => { releaseWinner = resolve; });
  const winnerEntered = new Promise((resolve) => { markWinnerEntered = resolve; });
  const { directory, calls, options } = await harness(t, {
    async runCycle(input) {
      calls.push(input);
      markWinnerEntered();
      await gate;
      return { state: input.state, summary: { cycleId: input.cycle.cycleId } };
    },
  });

  const winner = runScheduledPaperCycle(options);
  await winnerEntered;
  const competingStore = leaseStore(directory, {
    localProcessId: 202,
    ownerLiveness: () => PAPER_SCHEDULER_OWNER_LIVENESS.ALIVE,
  });
  const loser = await runScheduledPaperCycle({
    ...options,
    ownerId: "worker-b",
    leaseStore: competingStore,
    clock: () => NOW + LEASE_DURATION_MS + 10_000,
  });
  releaseWinner();
  await winner;

  assert.equal(loser.status, "SKIPPED_BUSY");
  assert.equal(loser.busyReason, "LIVE_LOCAL_OWNER");
  assert.equal(loser.mutationCount, 0);
  assert.equal(calls.length, 1);
});

test("an ownerless mkdir-to-owner-write orphan is recovered after bounded grace", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paper-scheduler-orphan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = leasePaths(directory);
  await mkdir(paths.lease, { recursive: true });
  const old = new Date(NOW - LEASE_DURATION_MS - 1);
  await utimes(paths.lease, old, old);

  const acquired = await leaseStore(directory).acquire({
    leaseKey: LEASE_KEY,
    cycleId: CYCLE_ID,
    ownerId: "recovery-worker",
    nowMs: NOW,
    leaseDurationMs: LEASE_DURATION_MS,
  });

  assert.equal(acquired.acquired, true);
  assert.equal(acquired.status, "ACQUIRED");
  assert.equal(acquired.ownerId, "recovery-worker");
});

test("a fresh ownerless lease fails closed while owner initialization may be in progress", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paper-scheduler-initializing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = leasePaths(directory);
  await mkdir(paths.lease, { recursive: true });
  const fresh = new Date(NOW);
  await utimes(paths.lease, fresh, fresh);

  const result = await leaseStore(directory).acquire({
    leaseKey: LEASE_KEY,
    cycleId: CYCLE_ID,
    ownerId: "competing-worker",
    nowMs: NOW,
    leaseDurationMs: LEASE_DURATION_MS,
  });

  assert.equal(result.acquired, false);
  assert.equal(result.status, "BUSY");
  assert.equal(result.reason, "OWNER_INITIALIZING");
});

test("a definitively dead same-host owner is recovered", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paper-scheduler-dead-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const originalStore = leaseStore(directory, { localProcessId: 101 });
  const original = await originalStore.acquire({
    leaseKey: LEASE_KEY,
    cycleId: CYCLE_ID,
    ownerId: "dead-worker",
    nowMs: NOW,
    leaseDurationMs: LEASE_DURATION_MS,
  });
  assert.equal(original.acquired, true);

  const recoveryStore = leaseStore(directory, {
    localProcessId: 202,
    ownerLiveness: () => PAPER_SCHEDULER_OWNER_LIVENESS.DEAD,
  });
  const recovered = await recoveryStore.acquire({
    leaseKey: LEASE_KEY,
    cycleId: CYCLE_ID,
    ownerId: "recovery-worker",
    nowMs: NOW + 1,
    leaseDurationMs: LEASE_DURATION_MS,
  });

  assert.equal(recovered.acquired, true);
  assert.equal(recovered.ownerId, "recovery-worker");
});

test("remote-host ownership fails closed even when the caller cannot prove liveness", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paper-scheduler-remote-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = await leaseStore(directory, {
    localHostId: "paper-host-a",
    localProcessId: 101,
  }).acquire({
    leaseKey: LEASE_KEY,
    cycleId: CYCLE_ID,
    ownerId: "remote-worker",
    nowMs: NOW,
    leaseDurationMs: LEASE_DURATION_MS,
  });
  assert.equal(original.acquired, true);

  const result = await leaseStore(directory, {
    localHostId: "paper-host-b",
    localProcessId: 202,
    ownerLiveness: () => PAPER_SCHEDULER_OWNER_LIVENESS.DEAD,
  }).acquire({
    leaseKey: LEASE_KEY,
    cycleId: CYCLE_ID,
    ownerId: "local-worker",
    nowMs: NOW + LEASE_DURATION_MS + 1,
    leaseDurationMs: LEASE_DURATION_MS,
  });

  assert.equal(result.acquired, false);
  assert.equal(result.status, "BUSY");
  assert.equal(result.reason, "REMOTE_HOST_OWNER");
});

test("unknown same-host owner liveness fails closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paper-scheduler-unknown-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = await leaseStore(directory, { localProcessId: 101 }).acquire({
    leaseKey: LEASE_KEY,
    cycleId: CYCLE_ID,
    ownerId: "uncertain-worker",
    nowMs: NOW,
    leaseDurationMs: LEASE_DURATION_MS,
  });
  assert.equal(original.acquired, true);

  const result = await leaseStore(directory, {
    localProcessId: 202,
    ownerLiveness: () => PAPER_SCHEDULER_OWNER_LIVENESS.UNKNOWN,
  }).acquire({
    leaseKey: LEASE_KEY,
    cycleId: CYCLE_ID,
    ownerId: "competing-worker",
    nowMs: NOW + LEASE_DURATION_MS + 1,
    leaseDurationMs: LEASE_DURATION_MS,
  });

  assert.equal(result.acquired, false);
  assert.equal(result.status, "BUSY");
  assert.equal(result.reason, "UNKNOWN_LOCAL_OWNER");
});

test("completed-cycle retry and restart replay without duplicate mutation", async (t) => {
  const { directory, calls, options } = await harness(t);
  assert.equal((await runScheduledPaperCycle(options)).status, "COMPLETED");
  const restartedStore = leaseStore(directory);
  const replay = await runScheduledPaperCycle({
    ...options,
    ownerId: "worker-restarted",
    leaseStore: restartedStore,
  });
  assert.equal(replay.status, "REPLAYED");
  assert.equal(replay.mutationCount, 0);
  assert.equal(calls.length, 1);
});

test("failed owner releases lease so the same cycle retries safely", async (t) => {
  let attempts = 0;
  const { calls, options } = await harness(t, {
    async runCycle(input) {
      attempts += 1;
      if (attempts === 1) throw new Error("transient persistence failure");
      calls.push(input);
      return { state: input.state, summary: { cycleId: input.cycle.cycleId } };
    },
  });
  await assert.rejects(runScheduledPaperCycle(options), /transient persistence failure/);
  const retry = await runScheduledPaperCycle(options);
  assert.equal(retry.status, "COMPLETED");
  assert.equal(calls.length, 1);
});

test("freshness is evaluated after public collection rather than against cycle start", async (t) => {
  const clockValues = [NOW, NOW + 5_000, NOW + 6_000];
  let clockIndex = 0;
  const { calls, options } = await harness(t, {
    clock: () => clockValues[Math.min(clockIndex++, clockValues.length - 1)],
    publicEvidenceProvider: {
      async collectPublicEvidence() {
        return readyLane({ observedAtMs: NOW + 4_000, maxAgeMs: 10_000 });
      },
    },
  });

  const result = await runScheduledPaperCycle(options);
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.evidenceEvaluatedAtMs, NOW + 5_000);
  assert.equal(result.completedAtMs, NOW + 6_000);
  assert.equal(calls.length, 1);
});

for (const [name, lane] of [
  ["BLOCKED_DATA", readyLane({ status: "BLOCKED_DATA" })],
  ["stale", readyLane({ observedAtMs: NOW - 60_001 })],
  ["future", readyLane({ observedAtMs: NOW + 1 })],
  ["invalid", { publicOnly: true, status: "READY", candidates: [], exits: [] }],
]) {
  test(`${name} public evidence fails closed before Paper mutation`, async (t) => {
    const { calls, options } = await harness(t, {
      publicEvidenceProvider: { async collectPublicEvidence() { return lane; } },
    });
    const result = await runScheduledPaperCycle(options);
    assert.equal(result.status, "BLOCKED_DATA");
    assert.equal(result.mutationCount, 0);
    assert.equal(calls.length, 0);
  });
}

test("scheduled Natural runtime preserves the exact pre-Entry blocker and canonical provenance", async (t) => {
  const naturalRuntimeSha = "a".repeat(40);
  const naturalEvidenceIdentity = "b".repeat(64);
  const exactSourceBlocker = "P0_PAPER_SUPPLEMENTAL_FULL_COST_BLOCKED_DATA:liquidityImpactCostEvidence";
  const naturalFunnelMeasurements = Object.freeze([
    Object.freeze({
      stage: "CANDIDATE",
      status: "MEASURED",
      count: 5,
      blocker: null,
      provenance: "ScannerResponse.cards.length",
      measuredAtMs: NOW,
    }),
    Object.freeze({
      stage: "EVIDENCE_COMPLETE",
      status: "MEASURED",
      count: 0,
      blocker: null,
      provenance: "authoritative source-completeness classification",
      measuredAtMs: NOW,
    }),
    Object.freeze({
      stage: "ADMISSION_PASS",
      status: "UNKNOWN",
      count: null,
      blocker: "ADMISSION_STAGE_DEPENDS_ON_UNRESOLVED_EVIDENCE_OR_PRODUCER_BLOCK",
      provenance: null,
      measuredAtMs: NOW,
    }),
  ]);
  const publicEvidenceProvider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: Object.freeze({ async collectPublicEvidence() { return readyLane(); } }),
    async paperRuntimeForMarket({ market }) {
      const safety = {
        market,
        executionAuthority: "NONE",
        simulatedOnly: true,
        liveOrderAllowed: false,
        privateTradingApiAllowed: false,
        orderSubmitted: false,
        exchangeRequestSent: false,
      };
      if (market !== "CRYPTO_FUTURES") {
        return Object.freeze({
          ...safety,
          status: "VALID_NO_TRADE",
          paperBridge: Object.freeze({ candidates: Object.freeze([]), exitSignals: Object.freeze([]) }),
        });
      }
      return Object.freeze({
        ...safety,
        status: "BLOCKED_DATA",
        search: Object.freeze({ outcome: "CANDIDATES_FOUND" }),
        admissionBlockers: Object.freeze(["P0_PAPER_SUPPLEMENTAL_FULL_COST_BLOCKED_DATA"]),
        firstZeroStage: "EVIDENCE_COMPLETE",
        firstZeroReason: "P0_PAPER_SUPPLEMENTAL_FULL_COST_BLOCKED_DATA",
        naturalFirstZeroStage: "EVIDENCE_COMPLETE",
        naturalFirstZeroReason: "INDEPENDENT_LIQUIDITY_IMPACT_CALIBRATION_NOT_PROVEN",
        naturalEvidenceIdentity,
        naturalRuntimeSha,
        naturalFunnelMeasurements,
        authoritativeFirstZeroReasonEvidenceByStage: Object.freeze({
          EVIDENCE_COMPLETE: Object.freeze({
            authoritative: true,
            freshness: "FRESH",
            reasonCode: "P0_PAPER_SUPPLEMENTAL_FULL_COST_BLOCKED_DATA_LIQUIDITY_IMPACT_COST_EVIDENCE",
            sourceCodes: Object.freeze([exactSourceBlocker]),
            strategySha: naturalRuntimeSha,
            runtimeSha: naturalRuntimeSha,
            datasetIdentity: naturalEvidenceIdentity,
            synthetic: false,
            testFixture: false,
            historical: false,
            replay: false,
            duplicateReplay: false,
          }),
        }),
      });
    },
  });
  const { calls, options } = await harness(t, { publicEvidenceProvider });

  const result = await runScheduledPaperCycle(options);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.mutationCount, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(result.blockers, [{
    market: "CRYPTO_FUTURES",
    reason: "BLOCKED_DATA",
    entryAdmissionEvidence: {
      classification: "BLOCKED_DATA",
      sourceBlocker: "P0_PAPER_SUPPLEMENTAL_FULL_COST_BLOCKED_DATA",
      producerStatus: "BLOCKED_DATA",
      searchOutcome: "CANDIDATES_FOUND",
      firstZeroStage: "EVIDENCE_COMPLETE",
      firstZeroReason: "P0_PAPER_SUPPLEMENTAL_FULL_COST_BLOCKED_DATA",
      naturalFirstZeroStage: "EVIDENCE_COMPLETE",
      naturalFirstZeroReason: "INDEPENDENT_LIQUIDITY_IMPACT_CALIBRATION_NOT_PROVEN",
      stageMeasurements: [],
      naturalFunnelMeasurements,
      authoritativeFirstZeroReasonEvidence: {
        authoritative: true,
        freshness: "FRESH",
        reasonCode: "P0_PAPER_SUPPLEMENTAL_FULL_COST_BLOCKED_DATA_LIQUIDITY_IMPACT_COST_EVIDENCE",
        sourceCodes: [exactSourceBlocker],
        strategySha: naturalRuntimeSha,
        runtimeSha: naturalRuntimeSha,
        datasetIdentity: naturalEvidenceIdentity,
        synthetic: false,
        testFixture: false,
        historical: false,
        replay: false,
        duplicateReplay: false,
      },
      provenance: {
        schemaVersion: "meaningful-search-scheduled-paper-provider-v1",
        naturalEvidenceIdentity,
        naturalRuntimeSha,
      },
    },
  }]);
  assert.equal(result.safety.privateAccountAccess, false);
  assert.equal(result.safety.executionAuthority, "NONE");
  assert.equal(result.safety.orderAuthority, false);
  assert.equal(result.safety.orderSubmitted, false);
  assert.equal(result.safety.liveTrading, false);
});

test("429 exhaustion blocks all lanes and does not fabricate another lane success", async (t) => {
  const attempts = new Map();
  const backoffs = [];
  const { calls, options } = await harness(t, {
    publicEvidenceProvider: {
      async collectPublicEvidence({ market }) {
        attempts.set(market, (attempts.get(market) ?? 0) + 1);
        if (market === "US_STOCK") {
          throw Object.assign(new Error("rate limited"), { status: 429 });
        }
        return readyLane();
      },
    },
    sleep: async (delay) => { backoffs.push(delay); },
  });
  const result = await runScheduledPaperCycle(options);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.mutationCount, 0);
  assert.equal(calls.length, 0);
  assert.equal(attempts.get("US_STOCK"), 3);
  assert.deepEqual(backoffs, [1, 2]);
  assert.deepEqual(result.blockers, [{ market: "US_STOCK", reason: "PROVIDER_RATE_LIMITED" }]);
});

test("provider timeout retry is bounded and fails closed without Paper mutation", async (t) => {
  let futuresAttempts = 0;
  const backoffs = [];
  const { calls, options } = await harness(t, {
    publicEvidenceProvider: {
      async collectPublicEvidence({ market }) {
        if (market === "CRYPTO_FUTURES") {
          futuresAttempts += 1;
          return new Promise(() => {});
        }
        return readyLane();
      },
    },
    retry: { maxAttempts: 2, baseBackoffMs: 1, timeoutMs: 5 },
    sleep: async (delay) => { backoffs.push(delay); },
  });
  const result = await runScheduledPaperCycle(options);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.mutationCount, 0);
  assert.equal(calls.length, 0);
  assert.equal(futuresAttempts, 2);
  assert.deepEqual(backoffs, [1]);
  assert.deepEqual(result.blockers, [{ market: "CRYPTO_FUTURES", reason: "PROVIDER_TIMEOUT" }]);
});

test("NO_TRADE empty public lanes reach canonical path without fake entries or outcomes", async (t) => {
  const { calls, options } = await harness(t);
  const result = await runScheduledPaperCycle(options);
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(calls[0].candidates, []);
  assert.deepEqual(calls[0].exits, []);
  assert.equal(result.summary.entries, 0);
  assert.equal(result.summary.settled, 0);
});

function positionFixture({ withRiskPolicy = false } = {}) {
  const position = {
    positionId: "position-1",
    paperSampleId: "sample-1",
    signalId: "signal-1",
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    direction: "LONG",
    strategyId: "strategy-1",
    strategyVersion: "v1",
    parameterHash: "parameter-1",
    researchCodeSha: "a".repeat(40),
    costPolicyVersion: "cost-v1",
    entryTimestampMs: NOW - 10_000,
    lifecycleState: "OPEN",
    sample: {
      identity: {
        signalId: "signal-1",
        market: "CRYPTO_FUTURES",
        symbol: "BTCUSDT",
        executionDirection: "LONG",
        timeframe: "4h",
        horizon: 12,
        strategyId: "strategy-1",
        strategyVersion: "v1",
        parameterHash: "parameter-1",
        researchCodeSha: "a".repeat(40),
      },
      profitEvidence: { costPolicyId: "cost-v1" },
      entryEvidenceProvenance: {
        schemaVersion: "paper-evidence-provenance-v1",
        provenanceDigest: "b".repeat(64),
        evidenceSnapshotDigest: "c".repeat(64),
      },
    },
  };
  if (withRiskPolicy) {
    position.riskPolicyIdentity = {
      policyId: "risk-v1",
      policyVersion: "1.0.0",
      source: "canonical-risk-record",
      researchCodeSha: "a".repeat(40),
    };
  }
  return position;
}

function stateWithPosition({ withRiskPolicy = false } = {}) {
  const position = positionFixture({ withRiskPolicy });
  return {
    identityFingerprint: "paper-identity-v1",
    positions: [position],
    ledger: {
      accountBinding: {
        publisherAccountIdSha256: "d".repeat(64),
        sourceSha: "a".repeat(40),
        accountId: "canonical-paper-account-1",
      },
      reservations: [{
        status: "OPEN",
        positionId: position.positionId,
        paperSampleId: position.paperSampleId,
      }],
    },
  };
}

function genuineObservationFromProvider(input, overrides = {}) {
  const binding = input.positionBindings[0];
  const identity = binding.positionIdentity;
  const base = {
    observationId: "observation-1",
    positionId: identity.positionId,
    paperSampleId: identity.paperSampleId,
    signalId: identity.signalId,
    market: identity.market,
    symbol: identity.symbol,
    direction: identity.direction,
    signalTimeframe: identity.signalTimeframe,
    horizon: identity.horizon,
    strategyId: identity.strategyId,
    strategyVersion: identity.strategyVersion,
    parameterHash: identity.parameterHash,
    researchCodeSha: identity.researchCodeSha,
    costPolicyVersion: identity.costPolicyVersion,
    publicOnly: true,
    source: "public-position-observation",
    provenance: "public-only-position-observation-v1",
    observedAtMs: NOW,
    maxAgeMs: 60_000,
    cycleIdentityDigest: input.cycleIdentity.identityDigest,
    accountIdentityDigest: input.accountIdentity.identityDigest,
    entryEvidenceDigest: binding.entryProvenance.evidenceSnapshotDigest,
    riskPolicyIdentityDigest: binding.riskPolicyIdentity.identityDigest,
    naturalEvidence: {
      provenanceClass: "NATURAL_FORWARD",
      synthetic: false,
      replay: false,
      testOnly: false,
      backfill: false,
      historical: false,
      duplicate: false,
      observationId: "observation-1",
      observedAtMs: NOW,
      source: "public-position-observation",
      provenance: "public-only-position-observation-v1",
    },
    bar: { open: 100, high: 102, low: 99, close: 101 },
  };
  return {
    ...base,
    ...overrides,
    naturalEvidence: { ...base.naturalEvidence, ...(overrides.naturalEvidence ?? {}) },
  };
}

test("scheduler passes immutable open Positions and account binding while missing observations stay missing", async (t) => {
  const canonicalState = stateWithPosition();
  const { calls, providerCalls, options } = await harness(t, { state: canonicalState });
  const result = await runScheduledPaperCycle(options);
  const futures = providerCalls.find((row) => row.market === "CRYPTO_FUTURES");
  assert.equal(futures.openPositions.length, 1);
  assert.equal(futures.openPositions[0].positionId, "position-1");
  assert.equal(futures.positionBindings[0].positionIdentity.paperSampleId, "sample-1");
  assert.equal(futures.positionBindings[0].entryProvenance.evidenceSnapshotDigest, "c".repeat(64));
  assert.equal(futures.positionBindings[0].costPolicyIdentity.version, "cost-v1");
  assert.equal(futures.positionBindings[0].riskPolicyIdentity, null);
  assert.equal(futures.accountIdentity.publisherAccountIdSha256, "d".repeat(64));
  assert.equal(futures.accountIdentity.accountIdSha256, createHash("sha256").update("canonical-paper-account-1").digest("hex"));
  assert.equal(result.positionObservationHandoff.status, "MISSING");
  assert.equal(result.positionObservationHandoff.observationCount, null);
  assert.equal(Object.hasOwn(calls[0], "positionObservations"), false);
});

test("scheduler passes an explicitly identity-bound genuine Position observation to the lifecycle input", async (t) => {
  const canonicalState = stateWithPosition({ withRiskPolicy: true });
  const { calls, options } = await harness(t, {
    state: canonicalState,
    publicEvidenceProvider: {
      async collectPublicEvidence(input) {
        if (input.market !== "CRYPTO_FUTURES") return readyLane();
        return readyLane({ positionObservations: [genuineObservationFromProvider(input)] });
      },
    },
  });
  const result = await runScheduledPaperCycle(options);
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.positionObservationHandoff.status, "PRESENT");
  assert.equal(result.positionObservationHandoff.observationCount, 1);
  assert.equal(calls[0].positionObservations.length, 1);
  const observation = calls[0].positionObservations[0];
  assert.equal(observation.schedulerHandoff.cycleIdentity.cycleId, CYCLE_ID);
  assert.equal(observation.schedulerHandoff.positionIdentity.signalId, "signal-1");
  assert.equal(observation.schedulerHandoff.accountIdentity.publisherAccountIdSha256, "d".repeat(64));
  assert.equal(observation.schedulerHandoff.entryProvenance.evidenceSnapshotDigest, "c".repeat(64));
  assert.equal(observation.schedulerHandoff.costPolicyIdentity.version, "cost-v1");
  assert.equal(observation.schedulerHandoff.riskPolicyIdentity.policyId, "risk-v1");
  assert.equal(observation.schedulerHandoff.naturalSampleCreditAuthority, "IDENTITY_GATES_PASSED");
});

for (const flag of ["synthetic", "replay", "testOnly", "backfill", "historical", "duplicate"]) {
  test(`genuine Position observation rejects ${flag} credit`, async (t) => {
    const canonicalState = stateWithPosition({ withRiskPolicy: true });
    const { calls, options } = await harness(t, {
      state: canonicalState,
      publicEvidenceProvider: {
        async collectPublicEvidence(input) {
          if (input.market !== "CRYPTO_FUTURES") return readyLane();
          return readyLane({
            positionObservations: [genuineObservationFromProvider(input, { naturalEvidence: { [flag]: true } })],
          });
        },
      },
    });
    const result = await runScheduledPaperCycle(options);
    assert.equal(result.status, "BLOCKED_DATA");
    assert.equal(result.mutationCount, 0);
    assert.equal(calls.length, 0);
    assert.ok(result.positionObservationHandoff.blockers.includes("POSITION_OBSERVATION_GENUINE_PROVENANCE_REQUIRED"));
  });
}

for (const [name, mutate] of [
  ["wrong cycle", (row) => { row.cycleIdentityDigest = "e".repeat(64); }],
  ["wrong account", (row) => { row.accountIdentityDigest = "e".repeat(64); }],
  ["wrong strategy", (row) => { row.strategyId = "wrong-strategy"; }],
  ["wrong signal", (row) => { row.signalId = "wrong-signal"; }],
  ["missing Entry provenance", (row) => { delete row.entryEvidenceDigest; }],
  ["wrong risk policy", (row) => { row.riskPolicyIdentityDigest = "e".repeat(64); }],
]) {
  test(`genuine Position observation rejects ${name}`, async (t) => {
    const canonicalState = stateWithPosition({ withRiskPolicy: true });
    const { calls, options } = await harness(t, {
      state: canonicalState,
      publicEvidenceProvider: {
        async collectPublicEvidence(input) {
          if (input.market !== "CRYPTO_FUTURES") return readyLane();
          const row = genuineObservationFromProvider(input);
          mutate(row);
          return readyLane({ positionObservations: [row] });
        },
      },
    });
    const result = await runScheduledPaperCycle(options);
    assert.equal(result.status, "BLOCKED_DATA");
    assert.equal(result.mutationCount, 0);
    assert.equal(calls.length, 0);
  });
}

test("legacy exits remain exits and are never synthesized into genuine Position observations", async (t) => {
  const canonicalState = stateWithPosition({ withRiskPolicy: true });
  const legacyExit = { positionId: "position-1", settlementInput: { legacy: true } };
  const { calls, options } = await harness(t, {
    state: canonicalState,
    publicEvidenceProvider: {
      async collectPublicEvidence(input) {
        return input.market === "CRYPTO_FUTURES" ? readyLane({ exits: [legacyExit] }) : readyLane();
      },
    },
  });
  const result = await runScheduledPaperCycle(options);
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(calls[0].exits, [legacyExit]);
  assert.equal(Object.hasOwn(calls[0], "positionObservations"), false);
  assert.equal(result.positionObservationHandoff.status, "MISSING");
});
