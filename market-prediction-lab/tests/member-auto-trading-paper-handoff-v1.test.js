import assert from "node:assert/strict";
import test from "node:test";
import {
  MEMBER_AUTO_TRADING_PAPER_HANDOFF_VERSION,
  buildMemberAutoTradingPaperHandoff,
  validateMemberAutoTradingPaperHandoff,
} from "../src/member-auto-trading-paper-handoff-v1.js";

const NOW = Date.parse("2026-09-19T02:00:00.000Z");
const SHA = "a".repeat(40);

function candidate({
  market = "CRYPTO_SPOT",
  signalId = "signal-1",
  direction = market === "CRYPTO_FUTURES" ? "LONG" : "BUY",
  symbol = market === "CRYPTO_FUTURES" ? "BTCUSDT" : "BTC",
  overrides = {},
} = {}) {
  const signal = {
    signalId,
    market,
    symbol,
    timestampMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
    style: "SWING",
    timeframe: "4h",
    horizon: 6,
    direction,
    signalDirection: direction,
    regime: "TREND",
    strategyIdentity: {
      candidateId: `paper-candidate-v1:${"b".repeat(64)}`,
      strategyId: "trend-breakout-v1",
      strategyVersion: "1.0.0",
      parameterHash: "params-v1",
      researchCodeSha: SHA,
    },
    learningSnapshot: {
      stopLoss: 95,
      target1: 110,
      target2: 120,
      strategyHorizon: "SWING",
      marketRegime: "TREND",
    },
  };
  const costPolicy = {
    version: "cost-v1",
    commissionRate: 0.001,
    taxRate: 0,
    spreadRate: 0.001,
    slippageRate: 0.001,
    latencyRate: 0.0002,
    liquidityImpactRate: 0.0003,
    partialFillImpactRate: 0.0001,
    fundingRate: 0,
  };
  return {
    signal,
    paperIdentity: {
      signalId,
      candidateId: signal.strategyIdentity.candidateId,
      strategyId: signal.strategyIdentity.strategyId,
      strategyVersion: signal.strategyIdentity.strategyVersion,
      parameterHash: signal.strategyIdentity.parameterHash,
      market,
      symbol,
      timeframe: signal.timeframe,
      horizon: signal.horizon,
      direction,
      regime: signal.regime,
      costPolicyVersion: costPolicy.version,
      researchCodeSha: SHA,
      executionAuthority: "NONE",
    },
    profitEvidence: {
      status: "READY",
      expectedNetEdge: 0.02,
      expectedNetReturn: 0.01,
      riskRewardRatio: 2,
      sampleSize: 80,
      costPolicyId: costPolicy.version,
      executionAuthority: "NONE",
    },
    riskEvidence: {
      status: "APPROVED",
      source: "TRADING_RISK_ENGINE",
      evaluatedAtMs: NOW - 500,
      simulatedOnly: true,
      allowed: true,
      blockCodes: [],
      recommendedQuantity: 1,
      actualRiskPercent: 0.4,
      riskReward1: 1.8,
      riskReward2: 2.4,
      policyIdentity: null,
      executionAuthority: "NONE",
    },
    execution: {
      marketAdapterIdentity: { id: "public-adapter-v1", version: "1" },
      costPolicy,
      executionPolicy: {
        version: "execution-v1",
        fillModel: "DEPTH_PARTICIPATION",
        sameBarPolicy: "STOP_FIRST",
        allowPartialFill: true,
        maxParticipationRate: 0.1,
      },
      dataEvidence: {
        provider: market === "CRYPTO_FUTURES" ? "bitget" : "upbit",
        publicOnly: true,
        dataQuality: "READY",
        provenance: "canonical-public-market-v1",
        asOfMs: NOW - 500,
        maxAgeMs: 60_000,
        quoteEvidence: { bid: 100, ask: 101, asOfMs: NOW - 500, maxAgeMs: 60_000 },
        depthEvidence: { available: true, bidSize: 100, askSize: 100 },
      },
    },
    order: { type: "MARKET", quantity: 1, direction },
    quote: { bid: 100, ask: 101, last: 100.5, asOfMs: NOW - 500, maxAgeMs: 60_000 },
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    ...overrides,
  };
}

function lane(market, candidates) {
  return { market, result: { candidates } };
}

test("builds a deterministic immutable public-only handoff", () => {
  const value = buildMemberAutoTradingPaperHandoff({
    cycleId: "cycle-1",
    evaluatedAtMs: NOW,
    lanes: [lane("CRYPTO_SPOT", [candidate()])],
  });
  assert.equal(value.schemaVersion, MEMBER_AUTO_TRADING_PAPER_HANDOFF_VERSION);
  assert.equal(value.status, "READY");
  assert.equal(value.entryCount, 1);
  assert.match(value.handoffDigest, /^[0-9a-f]{64}$/u);
  assert.match(value.entries[0].handoffId, /^paper-auto-handoff:sha256:[0-9a-f]{64}$/u);
  assert.equal(value.entries[0].identity.signalId, "signal-1");
  assert.equal(value.entries[0].signal.learningSnapshot.stopLoss, 95);
  assert.equal(value.entries[0].execution.dataEvidence.publicOnly, true);
  assert.equal(value.entries[0].riskEvidence.recommendedQuantity, 1);
  assert.equal(value.entries[0].riskEvidence.source, "TRADING_RISK_ENGINE");
  assert.equal(value.entries[0].safety.executionAuthority, "NONE");
  assert.equal(value.entries[0].safety.privateTradingApiAllowed, false);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.entries[0].execution.dataEvidence), true);
});

test("supports the four canonical market entry directions", () => {
  const rows = [
    ["KR_STOCK", "BUY", "005930"],
    ["US_STOCK", "BUY", "AAPL"],
    ["CRYPTO_SPOT", "BUY", "BTC"],
    ["CRYPTO_FUTURES", "LONG", "BTCUSDT"],
    ["CRYPTO_FUTURES", "SHORT", "ETHUSDT"],
  ].map(([market, direction, symbol], index) => lane(
    market,
    [candidate({ market, direction, symbol, signalId: `signal-${index}` })],
  ));
  const value = buildMemberAutoTradingPaperHandoff({
    cycleId: "cycle-four-markets",
    evaluatedAtMs: NOW,
    lanes: rows,
  });
  assert.equal(value.status, "READY");
  assert.equal(value.entryCount, 5);
  assert.deepEqual(
    new Set(value.entries.map((entry) => entry.identity.market)),
    new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]),
  );
});

test("exact duplicate signal is deduped without creating double work", () => {
  const row = candidate();
  const value = buildMemberAutoTradingPaperHandoff({
    cycleId: "cycle-dedupe",
    evaluatedAtMs: NOW,
    lanes: [lane("CRYPTO_SPOT", [row, structuredClone(row)])],
  });
  assert.equal(value.status, "READY");
  assert.equal(value.entryCount, 1);
});

test("conflicting duplicate signal fails closed", () => {
  const first = candidate();
  const second = candidate({ overrides: { quote: { bid: 99, ask: 101, last: 100, asOfMs: NOW - 500, maxAgeMs: 60_000 } } });
  const value = buildMemberAutoTradingPaperHandoff({
    cycleId: "cycle-conflict",
    evaluatedAtMs: NOW,
    lanes: [lane("CRYPTO_SPOT", [first, second])],
  });
  assert.equal(value.status, "BLOCKED_DATA");
  assert.equal(value.entryCount, 0);
  assert.deepEqual(value.entries, []);
  assert.deepEqual(value.blockers, ["HANDOFF_SIGNAL_ID_CONFLICT:signal-1"]);
});

test("unsafe execution authority never reaches the handoff", () => {
  const value = buildMemberAutoTradingPaperHandoff({
    cycleId: "cycle-unsafe",
    evaluatedAtMs: NOW,
    lanes: [lane("CRYPTO_SPOT", [candidate({ overrides: { liveOrderAllowed: true } })])],
  });
  assert.equal(value.status, "BLOCKED_DATA");
  assert.equal(value.entryCount, 0);
  assert.ok(value.blockers.some((code) => code.includes("HANDOFF_EXECUTION_AUTHORITY_FORBIDDEN")));
});

test("stale public market evidence fails closed", () => {
  const row = candidate();
  row.execution.dataEvidence.asOfMs = NOW - 120_000;
  row.execution.dataEvidence.maxAgeMs = 60_000;
  const value = buildMemberAutoTradingPaperHandoff({
    cycleId: "cycle-stale",
    evaluatedAtMs: NOW,
    lanes: [lane("CRYPTO_SPOT", [row])],
  });
  assert.equal(value.status, "BLOCKED_DATA");
  assert.ok(value.blockers.some((code) => code.includes("HANDOFF_DATA_STALE")));
});

test("private credential-like fields in public evidence are rejected", () => {
  const row = candidate();
  row.execution.dataEvidence.apiKey = "forbidden";
  const value = buildMemberAutoTradingPaperHandoff({
    cycleId: "cycle-private",
    evaluatedAtMs: NOW,
    lanes: [lane("CRYPTO_SPOT", [row])],
  });
  assert.equal(value.status, "BLOCKED_DATA");
  assert.ok(value.blockers.some((code) => code.includes("HANDOFF_PRIVATE_FIELD_FORBIDDEN:dataEvidence.apiKey")));
});

test("cash markets reject short-entry substitution", () => {
  const value = buildMemberAutoTradingPaperHandoff({
    cycleId: "cycle-cash-short",
    evaluatedAtMs: NOW,
    lanes: [lane("US_STOCK", [candidate({ market: "US_STOCK", direction: "SHORT", symbol: "AAPL" })])],
  });
  assert.equal(value.status, "BLOCKED_DATA");
  assert.ok(value.blockers.some((code) => code.includes("HANDOFF_DIRECTION_INVALID")));
});

test("persisted READY handoff is revalidated by digest and market-data freshness", () => {
  const value = buildMemberAutoTradingPaperHandoff({
    cycleId: "cycle-readback",
    evaluatedAtMs: NOW,
    lanes: [lane("CRYPTO_SPOT", [candidate()])],
  });
  const readback = validateMemberAutoTradingPaperHandoff(structuredClone(value), NOW + 1_000);
  assert.deepEqual(readback, value);
  assert.equal(Object.isFrozen(readback.entries[0]), true);

  const stale = structuredClone(value);
  assert.throws(
    () => validateMemberAutoTradingPaperHandoff(stale, NOW + 61_000),
    /HANDOFF_ENTRY_STALE/u,
  );
});

test("persisted handoff rejects payload tampering even when safety flags are unchanged", () => {
  const value = buildMemberAutoTradingPaperHandoff({
    cycleId: "cycle-tamper",
    evaluatedAtMs: NOW,
    lanes: [lane("CRYPTO_SPOT", [candidate()])],
  });
  const tampered = structuredClone(value);
  tampered.entries[0].signal.learningSnapshot.target1 = 999;
  assert.throws(
    () => validateMemberAutoTradingPaperHandoff(tampered, NOW + 1_000),
    /HANDOFF_ENTRY_DIGEST_MISMATCH/u,
  );
});

test("persisted BLOCKED handoff is valid only as zero-entry latest state", () => {
  const blocked = buildMemberAutoTradingPaperHandoff({
    cycleId: "cycle-blocked-readback",
    evaluatedAtMs: NOW,
    lanes: [lane("CRYPTO_SPOT", [candidate({ overrides: { liveOrderAllowed: true } })])],
  });
  assert.equal(validateMemberAutoTradingPaperHandoff(blocked, NOW).status, "BLOCKED_DATA");
  const forged = structuredClone(blocked);
  forged.entries.push({});
  assert.throws(
    () => validateMemberAutoTradingPaperHandoff(forged, NOW),
    /MEMBER_AUTO_TRADING_BLOCKED_HANDOFF_INVALID/u,
  );
});
