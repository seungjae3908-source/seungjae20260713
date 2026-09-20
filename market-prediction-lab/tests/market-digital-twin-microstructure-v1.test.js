import test from "node:test";
import assert from "node:assert/strict";

import { COUNTERFACTUAL_TWIN_SWARM_V1 } from "../src/counterfactual-twin-swarm-v1.js";
import {
  DIGITAL_TWIN_REQUIRED_SCENARIOS,
  MARKET_DIGITAL_TWIN_MICROSTRUCTURE_V1,
  buildMarketDigitalTwinPlanV1,
  buildMicrostructureSnapshotV1,
  evaluateMarketDigitalTwinV1,
} from "../src/market-digital-twin-microstructure-v1.js";

const counterfactualResult = Object.freeze({
  schemaVersion: COUNTERFACTUAL_TWIN_SWARM_V1,
  artifactType: "COUNTERFACTUAL_TWIN_RESULT",
  status: "COUNTERFACTUAL_TWIN_EVALUATED_RESEARCH_ONLY",
  candidateId: "alpha-digital-001",
  resultDigest: "c".repeat(64),
  executionAuthority: "NONE",
});

function snapshot(second = 0) {
  return buildMicrostructureSnapshotV1({
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    observedAt: `2026-09-20T03:00:${String(second).padStart(2, "0")}.000Z`,
    sourceDigest: "a".repeat(64),
    bids: [[100, 2], [99.5, 3], [99, 5]],
    asks: [[100.5, 1.5], [101, 3], [101.5, 5]],
    trades: [
      { price: 100.5, quantity: 0.5, aggressorSide: "BUY" },
      { price: 100, quantity: 0.2, aggressorSide: "SELL" },
    ],
    depthLevels: 3,
  });
}

const calibrationEvidence = Object.freeze({
  bookWalkEvidenceId: "execution-quality:book-walk",
  fillModelEvidenceId: "execution-quality:fill-model",
  liquidityImpactEvidenceId: "liquidity-impact:oos",
  latencyEvidenceId: "execution-cost:latency",
  partialFillEvidenceId: "execution-cost:partial-fill",
  tcaEvidenceId: "execution-quality:tca",
  publicOrPaperEvidenceOnly: true,
  pointInTimeSafe: true,
  fullCostComponentsIndependent: true,
  testFixture: false,
  executionAuthority: "NONE",
});

const policy = Object.freeze({
  requiredScenarios: [...DIGITAL_TWIN_REQUIRED_SCENARIOS],
  minimumSnapshots: 3,
  maximumSnapshotGapMs: 2_000,
});

function plan() {
  return buildMarketDigitalTwinPlanV1({
    counterfactualResult,
    snapshots: [snapshot(0), snapshot(1), snapshot(2)],
    calibrationEvidence,
    policy,
  });
}

function scenarioResults(p, overrides = {}) {
  const sequenceDigest = "d".repeat(64);
  return DIGITAL_TWIN_REQUIRED_SCENARIOS.map((scenarioId, index) => ({
    scenarioId,
    evidenceId: `digital-twin:${scenarioId.toLowerCase()}`,
    planDigest: p.planDigest,
    snapshotSequenceDigest: sequenceDigest,
    netPnl: 10 - index * 2,
    maximumDrawdown: 0.03 + index * 0.01,
    fillRatio: Math.max(0.4, 0.95 - index * 0.05),
    realizedSlippageBps: 3 + index,
    calibrationAnchored: true,
    marketImpactModeled: true,
    partialFillModeled: true,
    latencyModeled: true,
    syntheticEconomicCredit: 0,
    executionAuthority: "NONE",
    ...(overrides[scenarioId] ?? {}),
  }));
}

test("microstructure brain derives book and aggressive-flow features without order authority", () => {
  const result = snapshot(0);

  assert.equal(result.status, "MICROSTRUCTURE_SNAPSHOT_READY");
  assert.ok(result.features.spreadBps > 0);
  assert.ok(result.features.bidDepthNotional > 0);
  assert.ok(result.features.askDepthNotional > 0);
  assert.ok(result.features.depthImbalance > -1 && result.features.depthImbalance < 1);
  assert.ok(result.features.flowImbalance > -1 && result.features.flowImbalance < 1);
  assert.equal(result.rawBookPersisted, false);
  assert.equal(result.rawTradesPersisted, false);
  assert.equal(result.executionAuthority, "NONE");
});

test("microstructure brain fails closed on crossed books", () => {
  const result = buildMicrostructureSnapshotV1({
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    observedAt: "2026-09-20T03:00:00.000Z",
    sourceDigest: "a".repeat(64),
    bids: [[101, 1]],
    asks: [[100, 1]],
    trades: [],
  });

  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("MICROSTRUCTURE_CROSSED_OR_LOCKED_BOOK"));
});

test("digital twin requires existing execution cost and liquidity calibration owners", () => {
  const p = plan();

  assert.equal(p.status, "MARKET_DIGITAL_TWIN_PLAN_READY");
  assert.equal(p.scenarioCount, DIGITAL_TWIN_REQUIRED_SCENARIOS.length);
  assert.equal(p.calibrationOwners.visibleBookWalk, "EXISTING_EXECUTION_QUALITY_OWNER");
  assert.equal(p.calibrationOwners.liquidityImpact, "EXISTING_LIQUIDITY_IMPACT_OOS_OWNER");
  assert.equal(p.syntheticScenarioEconomicCredit, 0);
  assert.equal(p.executionAuthority, "NONE");
});

test("digital twin evaluates observed replay and calibrated stress scenarios only as research", () => {
  const p = plan();
  const result = evaluateMarketDigitalTwinV1({
    plan: p,
    scenarioResults: scenarioResults(p),
  });

  assert.equal(result.status, "MARKET_DIGITAL_TWIN_EVALUATED_RESEARCH_ONLY");
  assert.equal(result.observedReplay.scenarioId, "OBSERVED_REPLAY");
  assert.ok(result.worstStressScenario);
  assert.equal(result.selectionAuthority, false);
  assert.equal(result.promotionEligible, false);
  assert.equal(result.syntheticScenarioEconomicCredit, 0);
  assert.equal(result.nextStage, "CHAMPION_CHALLENGER_MEMORY");
});

test("digital twin rejects synthetic scenarios that try to claim economic sample credit", () => {
  const p = plan();
  const result = evaluateMarketDigitalTwinV1({
    plan: p,
    scenarioResults: scenarioResults(p, {
      LIQUIDITY_WITHDRAWAL: { syntheticEconomicCredit: 1 },
    }),
  });

  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("DIGITAL_TWIN_RESULT_CONTRACT_INVALID"));
  const row = result.scenarioResults.find((item) => item.scenarioId === "LIQUIDITY_WITHDRAWAL");
  assert.ok(row.reasons.includes("DIGITAL_TWIN_SYNTHETIC_CREDIT_FORBIDDEN"));
});

test("digital twin refuses incomparable scenario paths", () => {
  const p = plan();
  const rows = scenarioResults(p);
  rows[2] = { ...rows[2], snapshotSequenceDigest: "e".repeat(64) };
  const result = evaluateMarketDigitalTwinV1({ plan: p, scenarioResults: rows });

  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("DIGITAL_TWIN_SEQUENCE_NOT_COMPARABLE"));
  assert.equal(result.nextStage, null);
});

test("digital twin blocks stale/gapped snapshot sequences", () => {
  const result = buildMarketDigitalTwinPlanV1({
    counterfactualResult,
    snapshots: [snapshot(0), snapshot(1), snapshot(8)],
    calibrationEvidence,
    policy,
  });

  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("DIGITAL_TWIN_SNAPSHOT_GAP_EXCEEDED"));
});
