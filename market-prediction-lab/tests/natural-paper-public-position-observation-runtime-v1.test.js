import assert from "node:assert/strict";
import test from "node:test";
import {
  PAPER_FORWARD_PROVIDER_AUTHORITY,
  createCanonicalPaperForwardEvidenceProvider,
} from "../src/paper-forward-evidence-runtime-v1.js";

const NOW_MS = 1_800_000_000_000;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RESEARCH_SHA = "1".repeat(40);
const CYCLE_DIGEST = "2".repeat(64);
const ACCOUNT_DIGEST = "3".repeat(64);
const ENTRY_DIGEST = "4".repeat(64);
const RISK_DIGEST = "5".repeat(64);
const COST_POLICY = "canonical-full-cost-v1";

const researchEnv = Object.freeze({
  RESEARCH_PRODUCTION: "true",
  PAPER_FORWARD_RESEARCH_SHA: RESEARCH_SHA,
  PAPER_FORWARD_ROOT: "/tmp/research-production-paper",
});

function candles(intervalMs, count = 6) {
  const lastOpen = Math.floor(NOW_MS / intervalMs) * intervalMs - intervalMs;
  return Array.from({ length: count }, (_, index) => {
    const timestamp = lastOpen - ((count - 1 - index) * intervalMs);
    const close = 100 + index;
    return Object.freeze({
      timestamp,
      open: close,
      high: close + 2,
      low: close - 2,
      close,
      volume: 1,
    });
  });
}

function noOpNaturalSourceFactory() {
  return Object.freeze({
    async collect() {
      return Object.freeze({
        status: "NO_FRESH_TRACKING_OR_SETTLEMENT",
        candidates: Object.freeze([]),
        exits: Object.freeze([]),
        blocker: null,
      });
    },
  });
}

async function validNoTradeRuntime({ market }) {
  return Object.freeze({
    market,
    status: "VALID_NO_TRADE",
    search: Object.freeze({ outcome: "VALID_NO_TRADE", validNoTrade: true, searchFailure: false }),
    admissionBlockers: Object.freeze([]),
    stageMeasurements: Object.freeze([]),
    paperBridge: Object.freeze({
      candidates: Object.freeze([]),
      exitSignals: Object.freeze([]),
      exits: 0,
    }),
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
}

function cycleIdentity() {
  return Object.freeze({
    cycleId: "paper-forward-public-evidence-4h-v1:999",
    identityFingerprint: "identity-fingerprint",
    scheduledAtMs: NOW_MS - 1_000,
    startedAtMs: NOW_MS - 500,
    identityDigest: CYCLE_DIGEST,
  });
}

function accountIdentity() {
  return Object.freeze({
    publisherAccountIdSha256: "6".repeat(64),
    sourceSha: "7".repeat(40),
    accountIdSha256: "8".repeat(64),
    identityDigest: ACCOUNT_DIGEST,
  });
}

function futuresPosition() {
  return Object.freeze({
    positionId: "position-1",
    paperSampleId: "paper-sample-1",
    signalId: "signal-1",
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    direction: "LONG",
    strategyId: "CANONICAL_STRATEGY",
    strategyVersion: "v1",
    parameterHash: "parameter-hash",
    researchCodeSha: RESEARCH_SHA,
    costPolicyVersion: COST_POLICY,
    entryTimestampMs: NOW_MS - (2 * FOUR_HOURS_MS),
    quantity: 1,
    entryFillPrice: 100,
    lifecycleState: "OPEN",
    sample: Object.freeze({
      status: "OPEN",
      identity: Object.freeze({
        signalId: "signal-1",
        market: "CRYPTO_FUTURES",
        symbol: "BTCUSDT",
        executionDirection: "LONG",
        timeframe: "4h",
        horizon: 12,
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
  });
}

function futuresBinding() {
  const position = futuresPosition();
  return Object.freeze({
    schemaVersion: "paper-scheduler-position-observation-handoff-v1",
    positionIdentity: Object.freeze({
      positionId: position.positionId,
      paperSampleId: position.paperSampleId,
      signalId: position.signalId,
      market: position.market,
      symbol: position.symbol,
      direction: position.direction,
      signalTimeframe: position.sample.identity.timeframe,
      horizon: position.sample.identity.horizon,
      strategyId: position.strategyId,
      strategyVersion: position.strategyVersion,
      parameterHash: position.parameterHash,
      researchCodeSha: position.researchCodeSha,
      costPolicyVersion: position.costPolicyVersion,
    }),
    cycleIdentity: cycleIdentity(),
    accountIdentity: accountIdentity(),
    accountBound: true,
    entryProvenance: Object.freeze({
      schemaVersion: "paper-evidence-provenance-v1",
      provenanceDigest: "9".repeat(64),
      evidenceSnapshotDigest: ENTRY_DIGEST,
    }),
    costPolicyIdentity: Object.freeze({ version: COST_POLICY }),
    riskPolicyIdentity: Object.freeze({
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

function runtimeProvider(overrides = {}) {
  return createCanonicalPaperForwardEvidenceProvider({
    clock: () => NOW_MS,
    env: researchEnv,
    bitgetClient: Object.freeze({}),
    naturalSourceFactory: noOpNaturalSourceFactory,
    paperRuntimeForMarket: validNoTradeRuntime,
    collectYahoo: async ({ market, symbol }) => Object.freeze({
      market,
      symbol,
      source: "yahoo-public-chart",
      timeframe: "1d",
      candles: candles(DAY_MS),
    }),
    collectUpbit: async ({ symbol }) => Object.freeze({
      market: "CRYPTO_SPOT",
      symbol,
      source: "upbit-public-candles",
      timeframe: "4h",
      candles: candles(FOUR_HOURS_MS),
    }),
    collectBitget: async ({ market, symbol, timeframe }) => Object.freeze({
      market,
      symbol,
      provider: "bitget-public-v2",
      timeframe,
      candles: candles(FOUR_HOURS_MS),
    }),
    ...overrides,
  });
}

function observationInput(market = "CRYPTO_FUTURES") {
  return Object.freeze({
    market,
    openPositions: market === "CRYPTO_FUTURES" ? Object.freeze([futuresPosition()]) : Object.freeze([Object.freeze({ market })]),
    positionBindings: market === "CRYPTO_FUTURES" ? Object.freeze([futuresBinding()]) : Object.freeze([]),
    cycleIdentity: cycleIdentity(),
    accountIdentity: accountIdentity(),
  });
}

test("canonical Research Production provider emits exact public Position observations through the runtime wrapper", async () => {
  const evidence = await runtimeProvider().collectPublicEvidence(observationInput());
  assert.equal(evidence.status, "READY");
  assert.equal(evidence.positionObservationSource.status, "PRESENT");
  assert.equal(evidence.positionObservationSource.publicOnly, true);
  assert.equal(evidence.positionObservationSource.executionAuthority, "NONE");
  assert.ok(evidence.positionObservations.length > 0);

  const observation = evidence.positionObservations[0];
  assert.equal(observation.positionId, "position-1");
  assert.equal(observation.paperSampleId, "paper-sample-1");
  assert.equal(observation.signalId, "signal-1");
  assert.equal(observation.strategyId, "CANONICAL_STRATEGY");
  assert.equal(observation.strategyVersion, "v1");
  assert.equal(observation.parameterHash, "parameter-hash");
  assert.equal(observation.researchCodeSha, RESEARCH_SHA);
  assert.equal(observation.riskPolicyId, "generic-risk-policy");
  assert.equal(observation.riskPolicyVersion, "v1");
  assert.equal(observation.riskPolicySource, "authoritative-paper-generic-risk-policy");
  assert.equal(observation.riskPolicyIdentityDigest, RISK_DIGEST);
  assert.equal(observation.costPolicyId, COST_POLICY);
  assert.equal(observation.costPolicyVersion, COST_POLICY);
  assert.equal(observation.cycleId, cycleIdentity().cycleId);
  assert.equal(observation.cycleIdentityDigest, CYCLE_DIGEST);
  assert.equal(observation.accountIdentityDigest, ACCOUNT_DIGEST);
  assert.equal(observation.provider, "bitget-public-v2");
  assert.equal(observation.publicOnly, true);
  assert.equal(observation.naturalEvidence.provenanceClass, "NATURAL_FORWARD");
  assert.equal(observation.naturalEvidence.synthetic, false);
  assert.equal(observation.naturalEvidence.replay, false);
  assert.equal(observation.naturalEvidence.backfill, false);
  assert.equal(observation.executionAuthority, "NONE");
  assert.equal(observation.privateTradingApiAllowed, false);
  assert.equal(observation.orderSubmitted, false);
  assert.match(observation.sourceDigest, /^[0-9a-f]{64}$/u);
  assert.equal(observation.evidenceRef, `public-frame:${observation.sourceDigest}`);
});

for (const [name, market, override] of [
  ["Yahoo", "KR_STOCK", { collectYahoo: async () => { throw new Error("YAHOO_PUBLIC_FAILED"); } }],
  ["Upbit", "CRYPTO_SPOT", { collectUpbit: async () => { throw new Error("UPBIT_PUBLIC_FAILED"); } }],
  ["Bitget", "CRYPTO_FUTURES", { collectBitget: async () => { throw new Error("BITGET_PUBLIC_FAILED"); } }],
]) {
  test(`${name} public provider failure never creates a Position observation or private fallback`, async () => {
    const evidence = await runtimeProvider(override).collectPublicEvidence(observationInput(market));
    assert.equal(evidence.status, "BLOCKED_DATA");
    assert.equal(evidence.blocker, "PROVIDER_FAILED");
    assert.equal(Object.hasOwn(evidence, "positionObservations"), false);
    assert.equal(evidence.publicOnly, true);
    assert.equal(evidence.candidates.length, 0);
    assert.equal(evidence.exits.length, 0);
  });
}

test("runtime wrapper propagates an observation-provider identity mismatch fail closed", async () => {
  let calls = 0;
  const provider = runtimeProvider({
    collectBitget: async ({ market, symbol, timeframe }) => {
      calls += 1;
      return Object.freeze({
        market,
        symbol,
        provider: calls === 1 ? "bitget-public-v2" : "private-account-endpoint",
        timeframe,
        candles: candles(FOUR_HOURS_MS),
      });
    },
  });
  const evidence = await provider.collectPublicEvidence(observationInput());
  assert.equal(evidence.status, "BLOCKED_DATA");
  assert.equal(evidence.blocker, "POSITION_OBSERVATION_PUBLIC_SOURCE_CONTRACT_MISMATCH");
  assert.equal(Object.hasOwn(evidence, "positionObservations"), false);
  assert.equal(evidence.positionObservationSource.status, "INVALID");
  assert.equal(evidence.positionObservationSource.publicOnly, true);
  assert.equal(evidence.positionObservationSource.executionAuthority, "NONE");
});

test("non-Research provider is unchanged and does not manufacture Position observations", async () => {
  const provider = createCanonicalPaperForwardEvidenceProvider({
    clock: () => NOW_MS,
    env: Object.freeze({}),
    bitgetClient: Object.freeze({}),
    collectYahoo: async ({ market, symbol }) => Object.freeze({ market, symbol, source: "yahoo-public-chart", timeframe: "1d", candles: candles(DAY_MS) }),
    collectUpbit: async ({ symbol }) => Object.freeze({ market: "CRYPTO_SPOT", symbol, source: "upbit-public-candles", timeframe: "4h", candles: candles(FOUR_HOURS_MS) }),
    collectBitget: async ({ market, symbol, timeframe }) => Object.freeze({ market, symbol, provider: "bitget-public-v2", timeframe, candles: candles(FOUR_HOURS_MS) }),
  });
  const evidence = await provider.collectPublicEvidence({ market: "CRYPTO_FUTURES" });
  assert.equal(evidence.status, "READY");
  assert.equal(Object.hasOwn(evidence, "positionObservations"), false);
  assert.equal(evidence.publicOnly, true);
  assert.equal(PAPER_FORWARD_PROVIDER_AUTHORITY.CRYPTO_FUTURES.maxAgeMs, 8 * 60 * 60 * 1000);
});
