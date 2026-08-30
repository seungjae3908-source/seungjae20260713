import assert from "node:assert/strict";
import test from "node:test";
import {
  NATURAL_PAPER_PUBLIC_POSITION_OBSERVATION_CONTRACT,
  NATURAL_PAPER_PUBLIC_POSITION_OBSERVATION_STATUS,
  createNaturalPaperPublicPositionObservationProducer,
  wrapPaperForwardProviderWithNaturalPositionObservations,
} from "../src/natural-paper-public-position-observation-v1.js";

const INTERVAL_MS = 4 * 60 * 60 * 1000;
const NOW_MS = 1_800_000_000_000;
const RESEARCH_SHA = "1".repeat(40);
const CYCLE_DIGEST = "2".repeat(64);
const ACCOUNT_DIGEST = "3".repeat(64);
const ENTRY_DIGEST = "4".repeat(64);
const RISK_DIGEST = "5".repeat(64);
const COST_POLICY = "canonical-full-cost-v1";
const POSITION_ID = "position-1";
const SAMPLE_ID = "paper-sample-1";
const SIGNAL_ID = "signal-1";
const SYMBOL = "BTCUSDT";

const authority = Object.freeze({
  CRYPTO_FUTURES: Object.freeze({
    provider: "bitget-public-v2",
    symbol: "BTCUSDT",
    timeframe: "4h",
    intervalMs: INTERVAL_MS,
    maxAgeMs: 8 * 60 * 60 * 1000,
  }),
});

function candle(timestamp, close = 100) {
  return Object.freeze({ timestamp, open: close, high: close + 2, low: close - 2, close, volume: 1 });
}

function publicSnapshot({
  market = "CRYPTO_FUTURES",
  symbol = SYMBOL,
  provider = "bitget-public-v2",
  timeframe = "4h",
  frames,
} = {}) {
  const firstOpen = NOW_MS - (3 * INTERVAL_MS);
  return Object.freeze({
    schemaVersion: 1,
    provider,
    market,
    symbol,
    timeframe,
    candles: Object.freeze(frames ?? [
      candle(firstOpen, 100),
      candle(firstOpen + INTERVAL_MS, 101),
      candle(firstOpen + (2 * INTERVAL_MS), 102),
    ]),
  });
}

function identity(overrides = {}) {
  return Object.freeze({
    positionId: POSITION_ID,
    paperSampleId: SAMPLE_ID,
    signalId: SIGNAL_ID,
    market: "CRYPTO_FUTURES",
    symbol: SYMBOL,
    direction: "LONG",
    strategyId: "CANONICAL_STRATEGY",
    strategyVersion: "v1",
    parameterHash: "parameter-hash",
    researchCodeSha: RESEARCH_SHA,
    costPolicyVersion: COST_POLICY,
    ...overrides,
  });
}

function accountIdentity(overrides = {}) {
  return Object.freeze({
    publisherAccountIdSha256: "6".repeat(64),
    sourceSha: "7".repeat(40),
    accountIdSha256: "8".repeat(64),
    identityDigest: ACCOUNT_DIGEST,
    ...overrides,
  });
}

function cycleIdentity(overrides = {}) {
  return Object.freeze({
    cycleId: "paper-forward-public-evidence-4h-v1:999",
    identityFingerprint: "identity-fingerprint",
    scheduledAtMs: NOW_MS - 1_000,
    startedAtMs: NOW_MS - 500,
    identityDigest: CYCLE_DIGEST,
    ...overrides,
  });
}

function position(overrides = {}) {
  const firstClose = NOW_MS - (2 * INTERVAL_MS);
  const baseIdentity = identity();
  return Object.freeze({
    ...baseIdentity,
    entryTimestampMs: firstClose + 1_000,
    quantity: 1,
    entryFillPrice: 100,
    lifecycleState: "OPEN",
    sample: Object.freeze({
      status: "OPEN",
      identity: Object.freeze({
        signalId: SIGNAL_ID,
        market: "CRYPTO_FUTURES",
        symbol: SYMBOL,
        executionDirection: "LONG",
        strategyId: "CANONICAL_STRATEGY",
        strategyVersion: "v1",
        parameterHash: "parameter-hash",
        researchCodeSha: RESEARCH_SHA,
      }),
      profitEvidence: Object.freeze({ costPolicyId: COST_POLICY }),
      entryEvidenceProvenance: Object.freeze({
        schemaVersion: "paper-evidence-provenance-v1",
        provenanceDigest: "9".repeat(64),
        evidenceSnapshotDigest: ENTRY_DIGEST,
      }),
    }),
    lifecycle: Object.freeze({
      status: "OPEN",
      mark: Object.freeze({ lastObservedAtMs: null }),
      processedObservationIds: Object.freeze([]),
    }),
    ...overrides,
  });
}

function binding(options = {}) {
  const {
    positionIdentity = identity(),
    riskPolicyIdentity,
    costPolicyIdentity,
    cycle = cycleIdentity(),
    account = accountIdentity(),
    accountBound = true,
    entryProvenance,
  } = options;
  return Object.freeze({
    schemaVersion: "paper-scheduler-position-observation-handoff-v1",
    positionIdentity,
    cycleIdentity: cycle,
    accountIdentity: account,
    accountBound,
    entryProvenance: entryProvenance ?? Object.freeze({
      schemaVersion: "paper-evidence-provenance-v1",
      provenanceDigest: "9".repeat(64),
      evidenceSnapshotDigest: ENTRY_DIGEST,
    }),
    costPolicyIdentity: costPolicyIdentity ?? Object.freeze({ version: COST_POLICY }),
    riskPolicyIdentity: Object.hasOwn(options, "riskPolicyIdentity") ? riskPolicyIdentity : Object.freeze({
      policyId: "generic-risk-policy",
      policyVersion: "v1",
      source: "authoritative-paper-generic-risk-policy",
      researchCodeSha: RESEARCH_SHA,
      identityDigest: RISK_DIGEST,
    }),
    executionAuthority: "NONE",
    liveTrading: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
  });
}

function producer({ snapshot = publicSnapshot(), policy = authority, nowMs = NOW_MS } = {}) {
  return createNaturalPaperPublicPositionObservationProducer({
    authority: policy,
    collectYahoo: async () => { throw new Error("unexpected Yahoo collector call"); },
    collectUpbit: async () => { throw new Error("unexpected Upbit collector call"); },
    collectBitget: async () => snapshot,
    bitgetClient: Object.freeze({}),
    clock: () => nowMs,
  });
}

async function collect({
  source = producer(),
  openPositions = [position()],
  positionBindings = [binding()],
  cycle = cycleIdentity(),
  account = accountIdentity(),
} = {}) {
  return source.collect({
    market: "CRYPTO_FUTURES",
    openPositions,
    positionBindings,
    cycleIdentity: cycle,
    accountIdentity: account,
  });
}

test("contract is public-only simulation with no Full Cost, risk, settlement, or order authority", () => {
  assert.equal(NATURAL_PAPER_PUBLIC_POSITION_OBSERVATION_CONTRACT.publicDataOnly, true);
  assert.equal(NATURAL_PAPER_PUBLIC_POSITION_OBSERVATION_CONTRACT.fullCostAuthority, false);
  assert.equal(NATURAL_PAPER_PUBLIC_POSITION_OBSERVATION_CONTRACT.riskPolicyAuthority, false);
  assert.equal(NATURAL_PAPER_PUBLIC_POSITION_OBSERVATION_CONTRACT.settlementAuthority, false);
  assert.equal(NATURAL_PAPER_PUBLIC_POSITION_OBSERVATION_CONTRACT.privateApi, false);
  assert.equal(NATURAL_PAPER_PUBLIC_POSITION_OBSERVATION_CONTRACT.liveTrading, false);
  assert.equal(NATURAL_PAPER_PUBLIC_POSITION_OBSERVATION_CONTRACT.executionAuthority, "NONE");
});

test("one genuine OPEN Position emits fresh identity-bound public closed-frame observations", async () => {
  const observed = await collect();
  assert.equal(observed.status, NATURAL_PAPER_PUBLIC_POSITION_OBSERVATION_STATUS.PRESENT);
  assert.equal(observed.openPositionCount, 1);
  assert.equal(observed.observationCount, 2);
  const first = observed.observations[0];
  assert.equal(first.positionId, POSITION_ID);
  assert.equal(first.paperSampleId, SAMPLE_ID);
  assert.equal(first.entryId, SAMPLE_ID);
  assert.equal(first.signalId, SIGNAL_ID);
  assert.equal(first.strategyId, "CANONICAL_STRATEGY");
  assert.equal(first.researchCodeSha, RESEARCH_SHA);
  assert.equal(first.riskPolicyId, "generic-risk-policy");
  assert.equal(first.riskPolicyVersion, "v1");
  assert.equal(first.riskPolicySource, "authoritative-paper-generic-risk-policy");
  assert.equal(first.riskPolicyIdentityDigest, RISK_DIGEST);
  assert.equal(first.costPolicyId, COST_POLICY);
  assert.equal(first.costPolicyVersion, COST_POLICY);
  assert.equal(first.cycleId, cycleIdentity().cycleId);
  assert.equal(first.cycleIdentityDigest, CYCLE_DIGEST);
  assert.equal(first.accountIdentityDigest, ACCOUNT_DIGEST);
  assert.equal(first.market, "CRYPTO_FUTURES");
  assert.equal(first.symbol, SYMBOL);
  assert.equal(first.direction, "LONG");
  assert.equal(first.publicOnly, true);
  assert.equal(first.sourceType, "PUBLIC_CLOSED_CANDLE");
  assert.equal(first.provider, "bitget-public-v2");
  assert.match(first.sourceDigest, /^[0-9a-f]{64}$/u);
  assert.equal(first.evidenceRef, `public-frame:${first.sourceDigest}`);
  assert.equal(first.naturalEvidence.provenanceClass, "NATURAL_FORWARD");
  assert.equal(first.naturalEvidence.synthetic, false);
  assert.equal(first.naturalEvidence.replay, false);
  assert.equal(first.naturalEvidence.backfill, false);
  assert.equal(first.naturalEvidence.historical, false);
  assert.equal(first.naturalEvidence.duplicate, false);
  assert.equal(first.executionAuthority, "NONE");
  assert.equal(Object.hasOwn(first, "settlementCostEvidence"), false);
  assert.equal(Object.hasOwn(first, "settlementInput"), false);
});

test("known zero open Positions is a truthful PRESENT zero and does not call market data", async () => {
  let calls = 0;
  const source = createNaturalPaperPublicPositionObservationProducer({
    authority,
    collectYahoo: async () => { calls += 1; },
    collectUpbit: async () => { calls += 1; },
    collectBitget: async () => { calls += 1; },
    bitgetClient: Object.freeze({}),
    clock: () => NOW_MS,
  });
  const observed = await collect({ source, openPositions: [], positionBindings: [] });
  assert.equal(observed.status, "PRESENT");
  assert.equal(observed.observationCount, 0);
  assert.equal(calls, 0);
});

test("missing canonical freshness policy fails closed instead of inventing an age threshold", async () => {
  const observed = await collect({ source: producer({ policy: Object.freeze({}) }) });
  assert.equal(observed.status, "MISSING");
  assert.equal(observed.blocker, "POSITION_OBSERVATION_FRESHNESS_POLICY_MISSING");
});

const identityFailures = [
  ["wrong positionId", { positionIdentity: identity({ positionId: "wrong-position" }) }, "POSITION_OBSERVATION_POSITION_BINDING_MISSING"],
  ["wrong paperSampleId", { positionIdentity: identity({ paperSampleId: "wrong-sample" }) }, "POSITION_OBSERVATION_BINDING_POSITION_MISMATCH"],
  ["wrong signalId", { positionIdentity: identity({ signalId: "wrong-signal" }) }, "POSITION_OBSERVATION_BINDING_POSITION_MISMATCH"],
  ["wrong strategy", { positionIdentity: identity({ strategyId: "wrong-strategy" }) }, "POSITION_OBSERVATION_BINDING_POSITION_MISMATCH"],
  ["wrong research SHA", { positionIdentity: identity({ researchCodeSha: "a".repeat(40) }) }, "POSITION_OBSERVATION_BINDING_POSITION_MISMATCH"],
  ["wrong cost policy", { costPolicyIdentity: Object.freeze({ version: "wrong-cost-policy" }) }, "POSITION_OBSERVATION_COST_POLICY_IDENTITY_MISMATCH"],
  ["missing risk policy", { riskPolicyIdentity: null }, "POSITION_OBSERVATION_RISK_POLICY_IDENTITY_MISSING_OR_MISMATCH"],
  ["wrong risk policy research SHA", { riskPolicyIdentity: Object.freeze({ policyId: "generic-risk-policy", policyVersion: "v1", source: "authoritative-paper-generic-risk-policy", researchCodeSha: "a".repeat(40), identityDigest: RISK_DIGEST }) }, "POSITION_OBSERVATION_RISK_POLICY_IDENTITY_MISSING_OR_MISMATCH"],
  ["account not bound", { accountBound: false }, "POSITION_OBSERVATION_ACCOUNT_IDENTITY_MISMATCH"],
];

for (const [name, bindingOverride, blocker] of identityFailures) {
  test(`${name} fails closed with zero observations`, async () => {
    const observed = await collect({ positionBindings: [binding(bindingOverride)] });
    assert.equal(observed.status, "WRONG_POSITION");
    assert.equal(observed.blocker, blocker);
    assert.equal(observed.observations, null);
  });
}

test("wrong cycle fails closed", async () => {
  const wrongCycle = cycleIdentity({ identityDigest: "a".repeat(64) });
  const observed = await collect({ cycle: wrongCycle });
  assert.equal(observed.status, "WRONG_POSITION");
  assert.equal(observed.blocker, "POSITION_OBSERVATION_CYCLE_IDENTITY_MISMATCH");
});

test("wrong account fails closed", async () => {
  const wrongAccount = accountIdentity({ identityDigest: "b".repeat(64) });
  const observed = await collect({ account: wrongAccount });
  assert.equal(observed.status, "WRONG_POSITION");
  assert.equal(observed.blocker, "POSITION_OBSERVATION_ACCOUNT_IDENTITY_MISMATCH");
});

test("Entry without an OPEN Position is not observed", async () => {
  const observed = await collect({ openPositions: [position({ lifecycleState: "PENDING" })] });
  assert.equal(observed.status, "WRONG_POSITION");
  assert.equal(observed.blocker, "POSITION_OBSERVATION_POSITION_NOT_OPEN");
});

test("already settled or invalid Position is not observed", async () => {
  const observed = await collect({ openPositions: [position({ lifecycleState: "SETTLED" })] });
  assert.equal(observed.status, "WRONG_POSITION");
  assert.equal(observed.blocker, "POSITION_OBSERVATION_POSITION_NOT_OPEN");
});

test("wrong public source symbol and market fail closed", async () => {
  const wrongSymbol = await collect({ source: producer({ snapshot: publicSnapshot({ symbol: "ETHUSDT" }) }) });
  assert.equal(wrongSymbol.status, "WRONG_SYMBOL");
  assert.equal(wrongSymbol.blocker, "POSITION_OBSERVATION_PUBLIC_SOURCE_SYMBOL_MISMATCH");

  const wrongMarket = await collect({ source: producer({ snapshot: publicSnapshot({ market: "CRYPTO_SPOT" }) }) });
  assert.equal(wrongMarket.status, "WRONG_MARKET");
  assert.equal(wrongMarket.blocker, "POSITION_OBSERVATION_PUBLIC_SOURCE_MARKET_MISMATCH");
});

test("private or non-canonical provider identity fails closed", async () => {
  const observed = await collect({ source: producer({ snapshot: publicSnapshot({ provider: "private-account-endpoint" }) }) });
  assert.equal(observed.status, "INVALID");
  assert.equal(observed.blocker, "POSITION_OBSERVATION_PUBLIC_SOURCE_CONTRACT_MISMATCH");
});

test("missing public observation timestamp fails closed", async () => {
  const frames = [Object.freeze({ timestamp: null, open: 100, high: 102, low: 98, close: 101, volume: 1 })];
  const observed = await collect({ source: producer({ snapshot: publicSnapshot({ frames }) }) });
  assert.equal(observed.status, "INVALID");
  assert.equal(observed.blocker, "POSITION_OBSERVATION_PUBLIC_FRAME_INVALID");
});

test("missing closed-frame anchor fails closed instead of crediting truncated or partial Position history", async () => {
  const firstOpen = NOW_MS - (3 * INTERVAL_MS);
  for (const entryTimestampMs of [firstOpen - 1_000, firstOpen + 1_000]) {
    const observed = await collect({ openPositions: [position({ entryTimestampMs })] });
    assert.equal(observed.status, "MISSING");
    assert.equal(observed.blocker, "POSITION_OBSERVATION_SEQUENCE_ANCHOR_MISSING");
    assert.equal(observed.observations, null);
  }
});

test("stale next frame is not converted into a current price", async () => {
  const staleNow = NOW_MS + (12 * 60 * 60 * 1000);
  const observed = await collect({ source: producer({ nowMs: staleNow }) });
  assert.equal(observed.status, "STALE");
  assert.equal(observed.blocker, "POSITION_OBSERVATION_STALE");
});

test("missing crypto frame interval fails closed instead of backfilling over the gap", async () => {
  const firstOpen = NOW_MS - (3 * INTERVAL_MS);
  const frames = [candle(firstOpen, 100), candle(firstOpen + (2 * INTERVAL_MS), 102)];
  const observed = await collect({ source: producer({ snapshot: publicSnapshot({ frames }) }) });
  assert.equal(observed.status, "INVALID");
  assert.equal(observed.blocker, "POSITION_OBSERVATION_INTERVAL_GAP");
});

test("same public frame already processed cannot increase observation evidence N", async () => {
  const first = await collect();
  assert.equal(first.observationCount, 2);
  const processed = position({
    lifecycle: Object.freeze({
      status: "OPEN",
      mark: Object.freeze({ lastObservedAtMs: null }),
      processedObservationIds: Object.freeze(first.observations.map((row) => row.observationId)),
    }),
  });
  const second = await collect({ openPositions: [processed] });
  assert.equal(second.status, "PRESENT");
  assert.equal(second.observationCount, 0);
});

test("strictly advanced last-observed cursor prevents replay/backfill of older public frames", async () => {
  const first = await collect();
  const last = first.observations.at(-1);
  const advanced = position({
    lifecycle: Object.freeze({
      status: "OPEN",
      mark: Object.freeze({ lastObservedAtMs: last.observedAtMs }),
      processedObservationIds: Object.freeze(first.observations.map((row) => row.observationId)),
    }),
  });
  const second = await collect({ openPositions: [advanced] });
  assert.equal(second.status, "PRESENT");
  assert.equal(second.observationCount, 0);
});

test("wrapper transports exact observations and fail-closes blocked producer output", async () => {
  const baseProvider = Object.freeze({
    async collectPublicEvidence() {
      return Object.freeze({
        status: "READY",
        publicOnly: true,
        market: "CRYPTO_FUTURES",
        provider: "bitget-public-v2",
        observedAtMs: NOW_MS,
        maxAgeMs: 8 * 60 * 60 * 1000,
        candidates: Object.freeze([]),
        exits: Object.freeze([]),
      });
    },
  });
  const wrapped = wrapPaperForwardProviderWithNaturalPositionObservations({ provider: baseProvider, producer: producer() });
  const ready = await wrapped.collectPublicEvidence({
    market: "CRYPTO_FUTURES",
    openPositions: [position()],
    positionBindings: [binding()],
    cycleIdentity: cycleIdentity(),
    accountIdentity: accountIdentity(),
  });
  assert.equal(ready.status, "READY");
  assert.equal(ready.positionObservations.length, 2);
  assert.equal(ready.positionObservationSource.status, "PRESENT");

  const blockedProducer = Object.freeze({
    async collect() {
      return Object.freeze({ status: "STALE", openPositionCount: 1, observationCount: null, observations: null, blocker: "POSITION_OBSERVATION_STALE", sourceType: "PUBLIC_CLOSED_CANDLE", provider: "bitget-public-v2" });
    },
  });
  const blocked = await wrapPaperForwardProviderWithNaturalPositionObservations({ provider: baseProvider, producer: blockedProducer })
    .collectPublicEvidence({ market: "CRYPTO_FUTURES", openPositions: [position()] });
  assert.equal(blocked.status, "BLOCKED_DATA");
  assert.equal(blocked.blocker, "POSITION_OBSERVATION_STALE");
  assert.equal(Object.hasOwn(blocked, "positionObservations"), false);
});

test("calls without scheduler openPositions remain unchanged for read-only validation consumers", async () => {
  const base = Object.freeze({ status: "READY", publicOnly: true, candidates: Object.freeze([]), exits: Object.freeze([]) });
  const baseProvider = Object.freeze({ async collectPublicEvidence() { return base; } });
  const wrapped = wrapPaperForwardProviderWithNaturalPositionObservations({ provider: baseProvider, producer: producer() });
  assert.equal(await wrapped.collectPublicEvidence({ market: "CRYPTO_FUTURES" }), base);
});
