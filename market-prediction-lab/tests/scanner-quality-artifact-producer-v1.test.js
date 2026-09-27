import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  buildScannerQualityEntryV1,
  materializeForwardObserverScannerQualityArtifactV1,
} from "../src/scanner-quality-artifact-producer-v1.js";
import { TRANSACTION_COST_COMPONENTS } from "../../market-intelligence-sidecar/src/transaction-cost-evidence.mjs";

const SHA = "a".repeat(40);
const DATASET = "b".repeat(64);
const PARAMS = "c".repeat(64);
const START = Date.parse("2025-01-01T00:00:00.000Z");

const identity = Object.freeze({
  strategyId: "CRYPTO_FUTURES_SWING_V1_LONG",
  strategyVersion: "signal-profile-v1",
  parameterHash: PARAMS,
  researchCodeSha: SHA,
  market: "CRYPTO_FUTURES",
  symbol: "BTCUSDT",
  timeframe: "60m",
  direction: "LONG",
  datasetSnapshotHash: DATASET,
});

function fold(number, base) {
  return {
    fold: number,
    leakFree: true,
    outOfSample: [
      { anchorTimestamp: base, futureEndTimestamp: base + 1_000 },
      { anchorTimestamp: base + 2_000, futureEndTimestamp: base + 3_000 },
    ],
    walkForwardTest: [
      { anchorTimestamp: base + 4_000, futureEndTimestamp: base + 5_000 },
      { anchorTimestamp: base + 6_000, futureEndTimestamp: base + 7_000 },
    ],
    report: {
      maxTrainFuture: base - 1,
      maxValidationFuture: base + 3_999,
      embargoMs: 0,
    },
  };
}

function trade(id, pnl, ret, entryTime, exitTime) {
  return {
    id,
    market: identity.market,
    symbol: identity.symbol,
    strategy: "V1",
    strategyVersion: "V1",
    timeframe: identity.timeframe,
    side: "long",
    action: "LONG",
    regime: "uptrend",
    entryTime,
    exitTime,
    netPnl: pnl,
    netReturnOnMargin: ret,
    entryNotional: 1_000,
    costsIncluded: true,
    costs: { total: 1 },
  };
}

function result(startTime, endTime, trades, overrides = {}) {
  return {
    ok: true,
    mode: "backtest-only",
    orderSubmitted: false,
    privateAccountRequestAllowed: false,
    market: identity.market,
    symbol: identity.symbol,
    side: "long",
    timeframe: identity.timeframe,
    initialCapital: 10_000,
    period: { startTime, effectiveEndTime: endTime },
    costModel: {
      entryFeeRate: 0.001,
      exitFeeRate: 0.001,
      taxRate: 0,
      slippageRate: 0.0005,
      spreadRate: 0.0002,
      latencyBars: 1,
      latencyDriftRate: 0.0001,
    },
    safeguards: {
      signalUsesClosedCandle: true,
      entryUsesNextCandleOpen: true,
      stopFirstOnAmbiguousBar: true,
      costsIncluded: true,
    },
    trades,
    // Deliberately bogus caller summaries: producer must ignore these.
    successRatePercent: 0,
    profitFactor: 0,
    maximumDrawdownPercent: 99,
    expectancy: -999,
    totalReturnPercent: -100,
    ...overrides,
  };
}

function packet(f) {
  const oStart = f.outOfSample[0].anchorTimestamp;
  const oEnd = f.outOfSample.at(-1).futureEndTimestamp;
  const wStart = f.walkForwardTest[0].anchorTimestamp;
  const wEnd = f.walkForwardTest.at(-1).futureEndTimestamp;
  const oTrades = Array.from({ length: 25 }, (_, i) =>
    trade(`o${f.fold}-${i}`, i % 2 === 0 ? 20 : -10, i % 2 === 0 ? 0.02 : -0.01, oStart, oEnd));
  const wTrades = Array.from({ length: 25 }, (_, i) =>
    trade(`w${f.fold}-${i}`, i % 3 ? 18 : -9, i % 3 ? 0.018 : -0.009, wStart, wEnd));
  return {
    fold: f.fold,
    binding: identity,
    outOfSampleResult: result(oStart, oEnd, oTrades),
    walkForwardResult: result(wStart, wEnd, wTrades),
  };
}

function costEvidence(overrides = {}) {
  const components = {};
  const pointCosts = {};
  const conservativeCosts = {};
  for (const component of TRANSACTION_COST_COMPONENTS) {
    components[component] = { status: "READY" };
    pointCosts[component] = component === "slippageBps" ? 5 : 1;
    conservativeCosts[component] = pointCosts[component] + 1;
  }
  return {
    contract: "market-intelligence-transaction-cost-evidence/v1",
    market: identity.market,
    evidenceSetVersion: "cost-evidence-v1",
    status: "READY",
    readyForNetAlpha: true,
    components,
    pointCosts,
    conservativeCosts,
    totalPointCostBps: Object.values(pointCosts).reduce((a, b) => a + b, 0),
    totalConservativeCostBps: Object.values(conservativeCosts).reduce((a, b) => a + b, 0),
    safety: {
      executionAuthority: "NONE",
      promotionAuthority: false,
      orderAllowed: false,
      privateTradingApiAllowed: false,
    },
    ...overrides,
  };
}

const datasetAudit = Object.freeze({
  eligible: true,
  safeguards: {
    lookaheadBlocked: true,
    closedCandlesOnly: true,
    survivorshipProtected: true,
  },
});

test("producer recomputes verified OOS/WF quality from trade rows instead of caller summaries", () => {
  const folds = [fold(1, START), fold(2, START + 100_000)];
  const built = buildScannerQualityEntryV1({
    identity,
    folds,
    foldResults: folds.map(packet),
    datasetAudit,
    transactionCostEvidence: costEvidence(),
    minimumTradeCount: 40,
  });
  assert.equal(built.status, "READY");
  assert.equal(built.entry.quality.status, "verified");
  assert.equal(built.entry.quality.tradeCount, 50);
  assert.ok(built.entry.quality.walkForwardWinRate > 0);
  assert.ok(built.entry.quality.expectancyPercent > 0);
  assert.ok(built.entry.quality.profitFactor > 1);
  assert.notEqual(built.entry.quality.profitFactor, 0);
  assert.notEqual(built.entry.quality.maxDrawdownPercent, 99);
  assert.equal(built.entry.quality.costsIncluded, true);
  assert.equal(built.entry.quality.slippageIncluded, true);
  assert.equal(built.entry.quality.lookaheadGuarded, true);
  assert.equal(built.entry.quality.survivorshipGuarded, true);
  assert.equal(built.executionAuthority, "NONE");
});

test("missing canonical cost component blocks quality artifact production", () => {
  const f = fold(1, START);
  const costs = costEvidence();
  costs.components.slippageBps = { status: "NOT_AVAILABLE" };
  const built = buildScannerQualityEntryV1({
    identity,
    folds: [f],
    foldResults: [packet(f)],
    datasetAudit,
    transactionCostEvidence: costs,
  });
  assert.equal(built.status, "BLOCKED_DATA");
  assert.equal(built.reason, "QUALITY_COST_EVIDENCE_BLOCKED");
  assert.ok(built.details.blockers.includes("QUALITY_TRANSACTION_COST_COMPONENT_INVALID:slippageBps"));
});

test("purge leakage fails closed before metrics are emitted", () => {
  const f = fold(1, START);
  const leaked = { ...f, leakFree: false };
  const built = buildScannerQualityEntryV1({
    identity,
    folds: [leaked],
    foldResults: [packet(f)],
    datasetAudit,
    transactionCostEvidence: costEvidence(),
  });
  assert.equal(built.status, "BLOCKED_DATA");
  assert.equal(built.reason, "QUALITY_FOLD_NOT_LEAK_FREE");
});

test("exact fold window binding is mandatory", () => {
  const f = fold(1, START);
  const p = packet(f);
  p.walkForwardResult = {
    ...p.walkForwardResult,
    period: { ...p.walkForwardResult.period, startTime: p.walkForwardResult.period.startTime - 1 },
  };
  const built = buildScannerQualityEntryV1({
    identity,
    folds: [f],
    foldResults: [p],
    datasetAudit,
    transactionCostEvidence: costEvidence(),
  });
  assert.equal(built.status, "BLOCKED_DATA");
  assert.equal(built.reason, "QUALITY_BACKTEST_RESULT_INVALID");
  assert.ok(built.details.blockers.some((value) => value.includes("WF_WINDOW_MISMATCH")));
});

test("stock quality requires point-in-time removed-name universe audit", () => {
  const stockIdentity = {
    ...identity,
    market: "KR_STOCK",
    symbol: "005930",
    direction: "BUY",
  };
  const f = fold(1, START);
  const p = packet(f);
  const stockPacket = {
    ...p,
    binding: stockIdentity,
    outOfSampleResult: {
      ...p.outOfSampleResult,
      market: "KR_STOCK",
      symbol: "005930",
      side: "long",
      trades: p.outOfSampleResult.trades.map((row) => ({ ...row, market: "KR_STOCK", symbol: "005930", action: "BUY" })),
    },
    walkForwardResult: {
      ...p.walkForwardResult,
      market: "KR_STOCK",
      symbol: "005930",
      side: "long",
      trades: p.walkForwardResult.trades.map((row) => ({ ...row, market: "KR_STOCK", symbol: "005930", action: "BUY" })),
    },
  };
  const costs = { ...costEvidence(), market: "KR_STOCK" };
  let built = buildScannerQualityEntryV1({
    identity: stockIdentity,
    folds: [f],
    foldResults: [stockPacket],
    datasetAudit,
    transactionCostEvidence: costs,
  });
  assert.equal(built.status, "BLOCKED_DATA");
  assert.equal(built.reason, "QUALITY_DATASET_EVIDENCE_BLOCKED");

  built = buildScannerQualityEntryV1({
    identity: stockIdentity,
    folds: [f],
    foldResults: [stockPacket],
    datasetAudit,
    transactionCostEvidence: costs,
    stockUniverseBiasAudit: {
      status: "point_in_time_bias_gate_passed",
      market: "KR_STOCK",
      safeguards: {
        currentConstituentListAloneCannotPass: true,
        missingHistoriesFailClosed: true,
      },
    },
  });
  assert.equal(built.status, "READY");
});

test("materializer produces consumer-compatible immutable quality and manifest digests", () => {
  const folds = [fold(1, START), fold(2, START + 100_000)];
  const built = buildScannerQualityEntryV1({
    identity,
    folds,
    foldResults: folds.map(packet),
    datasetAudit,
    transactionCostEvidence: costEvidence(),
  });
  assert.equal(built.status, "READY");
  const materialized = materializeForwardObserverScannerQualityArtifactV1({
    researchCodeSha: SHA,
    entries: [built],
  });
  assert.equal(materialized.artifact.schemaVersion, "forward-observer-scanner-quality-v1");
  assert.equal(materialized.manifest.kind, "forward-observer-scanner-quality");
  assert.equal(
    materialized.qualitySha256,
    createHash("sha256").update(materialized.qualityText).digest("hex"),
  );
  assert.equal(materialized.manifest.qualitySha256, materialized.qualitySha256);
  assert.equal(materialized.artifact.entries[0].executionAuthority, "NONE");
  assert.equal(materialized.profitabilityClaimAllowed, false);
});


test("missing trade segment dimensions fail closed before summarization", () => {
  const f = fold(1, START);
  const p = packet(f);
  p.walkForwardResult = {
    ...p.walkForwardResult,
    trades: p.walkForwardResult.trades.map((row, index) =>
      index === 0 ? { ...row, strategy: undefined, regime: undefined } : row),
  };
  const built = buildScannerQualityEntryV1({
    identity,
    folds: [f],
    foldResults: [p],
    datasetAudit,
    transactionCostEvidence: costEvidence(),
  });
  assert.equal(built.status, "BLOCKED_DATA");
  assert.equal(built.reason, "QUALITY_BACKTEST_RESULT_INVALID");
  assert.ok(built.details.blockers.some((value) =>
    value.includes("TRADE_SEGMENT_DIMENSION_MISSING")));
});
