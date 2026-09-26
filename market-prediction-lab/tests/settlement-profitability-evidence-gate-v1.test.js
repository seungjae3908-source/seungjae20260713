import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSettlementEvidenceDigest,
  buildSettlementProfitabilityEvidenceGate,
  SETTLEMENT_PROFITABILITY_EVIDENCE_GATE_MINIMUM_SAMPLE_SIZE,
  SETTLEMENT_PROFITABILITY_SCALAR_MAE_MFE_POLICY,
} from "../src/settlement-profitability-evidence-gate-v1.js";

const RESEARCH_SHA = "a".repeat(40);
const RUNTIME_SHA = "b".repeat(40);
const DIGEST_A = "1".repeat(64);
const DIGEST_B = "2".repeat(64);
const DIGEST_C = "3".repeat(64);
const NOW = 1_800_000_000_000;

function settlement(index, overrides = {}) {
  const netPnl = index % 3 === 0 ? -2 : index % 3 === 1 ? 3 : 0;
  return {
    schemaVersion: 1,
    paperSampleId: `paper-${String(index).padStart(3, "0")}`,
    market: "KR_STOCK",
    symbol: "005930",
    style: "SWING",
    timeframe: "1h",
    horizon: 12,
    strategyId: "profit-first-v2",
    strategyVersion: "v2",
    parameterHash: "params-v2",
    researchCodeSha: RESEARCH_SHA,
    status: "SETTLED",
    entryEvaluatedAtMs: NOW + index * 60_000,
    settledAtMs: NOW + index * 60_000 + 30_000,
    netPnl,
    netReturnPercent: netPnl / 10,
    totalExplicitCost: 0.25,
    costPolicyVersion: "KR_STOCK-cost-v1",
    fundingEvidence: {
      schemaVersion: "paper-funding-evidence-v1",
      fundingEvidenceDigest: DIGEST_A,
    },
    entryEvidenceProvenance: {
      schemaVersion: "paper-evidence-provenance-v1",
      publicOnly: true,
      dataQuality: "READY",
      provenanceDigest: DIGEST_A,
      evidenceSnapshotDigest: DIGEST_B,
    },
    exitEvidenceProvenance: {
      schemaVersion: "paper-evidence-provenance-v1",
      publicOnly: true,
      dataQuality: "READY",
      provenanceDigest: DIGEST_B,
      evidenceSnapshotDigest: DIGEST_C,
    },
    entryParityFingerprint: `entry-parity-${index}`,
    exitParityFingerprint: `exit-parity-${index}`,
    mfePercent: 1.5 + index / 100,
    maePercent: -0.8 - index / 200,
    usablePathBars: 3,
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    profitabilityClaimAllowed: false,
    ...overrides,
  };
}

function naturalReceipt(item, overrides = {}) {
  return {
    schemaVersion: "natural-settlement-eligibility-receipt-v1",
    paperSampleId: item.paperSampleId,
    settlementDigest: buildSettlementEvidenceDigest(item),
    sampleClass: "NATURAL",
    creditEligible: true,
    triggerSource: "CRON",
    replay: false,
    backfill: false,
    synthetic: false,
    testOnly: false,
    finalHoldoutUsed: false,
    runtimeSourceSha: RUNTIME_SHA,
    executionAuthority: "NONE",
    privateTradingApiAllowed: false,
    realOrderCount: 0,
    ...overrides,
  };
}

function fullCostReceipt(item, overrides = {}) {
  return {
    schemaVersion: "full-cost-settlement-receipt-v1",
    paperSampleId: item.paperSampleId,
    settlementDigest: buildSettlementEvidenceDigest(item),
    status: "FULL_COST_READY",
    allRequiredComponentsAccountedFor: true,
    unknownComponents: [],
    unknownCostIsZero: false,
    costEvidenceDigest: DIGEST_C,
    costPolicyVersion: item.costPolicyVersion,
    ...overrides,
  };
}

function regimeReceipt(item, regimeId = "BULL", overrides = {}) {
  return {
    schemaVersion: "settlement-regime-evidence-v1",
    paperSampleId: item.paperSampleId,
    settlementDigest: buildSettlementEvidenceDigest(item),
    regimeId,
    regimeVersion: "canonical-regime-v1",
    sourceSha: RUNTIME_SHA,
    regimeEvidenceDigest: DIGEST_B,
    inferred: false,
    finalHoldoutUsed: false,
    ...overrides,
  };
}

function receiptsFor(items) {
  return {
    naturalEligibilityReceipts: items.map((item) => naturalReceipt(item)),
    fullCostReceipts: items.map((item) => fullCostReceipt(item)),
    regimeReceipts: items.map((item, index) => regimeReceipt(item, index % 2 === 0 ? "BULL" : "BEAR")),
  };
}

test("zero settlements preserve every profitability metric as unknown and never claim success", () => {
  const result = buildSettlementProfitabilityEvidenceGate();
  assert.equal(SETTLEMENT_PROFITABILITY_EVIDENCE_GATE_MINIMUM_SAMPLE_SIZE, 30);
  assert.equal(SETTLEMENT_PROFITABILITY_SCALAR_MAE_MFE_POLICY, "POLICY_MISSING");
  assert.equal(result.sampleCount, 0);
  assert.equal(result.sampleCountStatus, "INSUFFICIENT_SAMPLE");
  assert.equal(result.canonicalMetrics.averageNetReturnPercent, null);
  assert.equal(result.canonicalMetrics.expectancyNetPnl, null);
  assert.equal(result.canonicalMetrics.profitFactor, null);
  assert.equal(result.canonicalMetrics.maxDrawdownPercent, null);
  assert.equal(result.naturalEligibility.status, "MISSING_EVIDENCE");
  assert.equal(result.fullCostEvidence.status, "MISSING_EVIDENCE");
  assert.equal(result.pathEvidence.status, "MISSING_EVIDENCE");
  assert.equal(result.regimeEvidence.status, "MISSING_EVIDENCE");
  assert.equal(result.pathEvidence.mae, null);
  assert.equal(result.pathEvidence.mfe, null);
  assert.equal(result.p1_5Complete, false);
  assert.equal(result.profitabilityProven, false);
  assert.equal(result.currentValidatedChampion, "NONE");
});

test("canonical EV/PF/MDD remain observable below N=30 while evidence credit stays blocked", () => {
  const item = settlement(0);
  const result = buildSettlementProfitabilityEvidenceGate({ settlements: [item] });
  assert.equal(result.sampleCount, 1);
  assert.equal(result.sampleCountStatus, "INSUFFICIENT_SAMPLE");
  assert.ok(Number.isFinite(result.canonicalMetrics.averageNetReturnPercent));
  assert.ok(Number.isFinite(result.canonicalMetrics.expectancyNetPnl));
  assert.ok(result.canonicalMetrics.profitFactor === null || Number.isFinite(result.canonicalMetrics.profitFactor));
  assert.ok(Number.isFinite(result.canonicalMetrics.maxDrawdownPercent));
  assert.equal(result.pathEvidence.status, "PRESENT");
  assert.equal(result.pathEvidence.scalarAggregationPolicy, "POLICY_MISSING");
  assert.equal(result.prerequisiteEvidenceComplete, false);
  assert.equal(result.p1_5Status, "BLOCKED_EVIDENCE");
  assert.equal(result.profitabilityClaimAllowed, false);
});

test("30 genuine fully-receipted settlements satisfy prerequisites but scalar MAE/MFE policy still blocks P1-5 completion", () => {
  const items = Array.from({ length: 30 }, (_, index) => settlement(index));
  const result = buildSettlementProfitabilityEvidenceGate({ settlements: items, ...receiptsFor(items) });
  assert.equal(result.sampleCount, 30);
  assert.equal(result.sampleCountStatus, "READY");
  assert.equal(result.naturalEligibility.status, "PRESENT");
  assert.equal(result.fullCostEvidence.status, "PRESENT");
  assert.equal(result.pathEvidence.status, "PRESENT");
  assert.equal(result.regimeEvidence.status, "PRESENT");
  assert.equal(result.regimeStatistics.length, 2);
  assert.ok(result.regimeStatistics.every((entry) => Number.isFinite(entry.expectancyNetPnl)));
  assert.equal(result.prerequisiteEvidenceComplete, true);
  assert.equal(result.scalarMaeMfeAggregationPolicy, "POLICY_MISSING");
  assert.equal(result.pathEvidence.mae, null);
  assert.equal(result.pathEvidence.mfe, null);
  assert.equal(result.p1_5Status, "BLOCKED_POLICY_MISSING");
  assert.equal(result.p1_5Complete, false);
  assert.equal(result.profitabilityProven, false);
  assert.equal(result.promotion, false);
});

test("TEST_ONLY, replay, backfill, synthetic, or Final Holdout Natural receipts fail closed", () => {
  for (const override of [
    { testOnly: true },
    { replay: true },
    { backfill: true },
    { synthetic: true },
    { finalHoldoutUsed: true },
  ]) {
    const item = settlement(0);
    assert.throws(() => buildSettlementProfitabilityEvidenceGate({
      settlements: [item],
      naturalEligibilityReceipts: [naturalReceipt(item, override)],
    }), /P1_5_FORBIDDEN_SAMPLE_CLASS/);
  }
});

test("non-cron or non-Natural receipts cannot receive Natural profitability credit", () => {
  const item = settlement(0);
  assert.throws(() => buildSettlementProfitabilityEvidenceGate({
    settlements: [item],
    naturalEligibilityReceipts: [naturalReceipt(item, { triggerSource: "MANUAL" })],
  }), /P1_5_NATURAL_CREDIT_NOT_ELIGIBLE/);
  assert.throws(() => buildSettlementProfitabilityEvidenceGate({
    settlements: [item],
    naturalEligibilityReceipts: [naturalReceipt(item, { sampleClass: "REPLAY" })],
  }), /P1_5_NATURAL_CREDIT_NOT_ELIGIBLE/);
});

test("receipt digest mismatch fails closed instead of attaching evidence to the wrong settlement", () => {
  const item = settlement(0);
  assert.throws(() => buildSettlementProfitabilityEvidenceGate({
    settlements: [item],
    naturalEligibilityReceipts: [naturalReceipt(item, { settlementDigest: DIGEST_A })],
  }), /P1_5_NATURAL_SETTLEMENT_DIGEST_MISMATCH/);
  assert.throws(() => buildSettlementProfitabilityEvidenceGate({
    settlements: [item],
    fullCostReceipts: [fullCostReceipt(item, { settlementDigest: DIGEST_B })],
  }), /P1_5_FULL_COST_SETTLEMENT_DIGEST_MISMATCH/);
});

test("duplicate settlement identity and mixed strategy cohort fail closed", () => {
  const first = settlement(0);
  assert.throws(() => buildSettlementProfitabilityEvidenceGate({ settlements: [first, { ...first }] }), /P1_5_DUPLICATE_SETTLEMENT_ID/);

  const second = settlement(1, { strategyId: "other-strategy" });
  assert.throws(() => buildSettlementProfitabilityEvidenceGate({ settlements: [first, second] }), /P1_5_MIXED_STRATEGY_COHORT_FORBIDDEN/);
});

test("MDD input order must be canonical settlement chronology", () => {
  const first = settlement(0);
  const second = settlement(1);
  assert.throws(() => buildSettlementProfitabilityEvidenceGate({ settlements: [second, first] }), /P1_5_SETTLEMENT_ORDER_NOT_CANONICAL/);
});

test("missing MAE/MFE path evidence remains explicit and never becomes measured zero", () => {
  const item = settlement(0, { maePercent: null, mfePercent: null, usablePathBars: 0 });
  const result = buildSettlementProfitabilityEvidenceGate({ settlements: [item] });
  assert.equal(result.pathEvidence.status, "MISSING_EVIDENCE");
  assert.equal(result.pathEvidence.covered, 0);
  assert.equal(result.pathEvidence.mae, null);
  assert.equal(result.pathEvidence.mfe, null);
});

test("unknown full-cost components and zero coercion are forbidden", () => {
  const item = settlement(0);
  assert.throws(() => buildSettlementProfitabilityEvidenceGate({
    settlements: [item],
    fullCostReceipts: [fullCostReceipt(item, { unknownComponents: ["liquidityImpact"] })],
  }), /P1_5_UNKNOWN_COST_COMPONENTS_PRESENT/);
  assert.throws(() => buildSettlementProfitabilityEvidenceGate({
    settlements: [item],
    fullCostReceipts: [fullCostReceipt(item, { unknownCostIsZero: true })],
  }), /P1_5_UNKNOWN_COST_ZERO_COERCION_FORBIDDEN/);
});

test("regime statistics require explicit non-inferred provenance and complete receipt coverage", () => {
  const items = [settlement(0), settlement(1)];
  const partial = buildSettlementProfitabilityEvidenceGate({
    settlements: items,
    regimeReceipts: [regimeReceipt(items[0])],
  });
  assert.equal(partial.regimeEvidence.status, "INCOMPLETE");
  assert.deepEqual(partial.regimeStatistics, []);

  assert.throws(() => buildSettlementProfitabilityEvidenceGate({
    settlements: [items[0]],
    regimeReceipts: [regimeReceipt(items[0], "BULL", { inferred: true })],
  }), /P1_5_INFERRED_OR_HOLDOUT_REGIME_FORBIDDEN/);
});

test("unsafe settlement or Natural receipt can never reach the statistics gate", () => {
  const unsafeSettlement = settlement(0, { liveOrderAllowed: true });
  assert.throws(() => buildSettlementProfitabilityEvidenceGate({ settlements: [unsafeSettlement] }), /P1_5_SETTLEMENT_SAFETY_VIOLATION/);

  const item = settlement(0);
  assert.throws(() => buildSettlementProfitabilityEvidenceGate({
    settlements: [item],
    naturalEligibilityReceipts: [naturalReceipt(item, { realOrderCount: 1 })],
  }), /P1_5_NATURAL_RECEIPT_SAFETY_VIOLATION/);
});

test("orphan receipts fail closed even when the settlement set is empty", () => {
  const item = settlement(0);
  assert.throws(() => buildSettlementProfitabilityEvidenceGate({
    settlements: [],
    naturalEligibilityReceipts: [naturalReceipt(item)],
  }), /P1_5_NATURAL_ORPHAN_RECEIPT/);
  assert.throws(() => buildSettlementProfitabilityEvidenceGate({
    settlements: [],
    fullCostReceipts: [fullCostReceipt(item)],
  }), /P1_5_FULL_COST_ORPHAN_RECEIPT/);
  assert.throws(() => buildSettlementProfitabilityEvidenceGate({
    settlements: [],
    regimeReceipts: [regimeReceipt(item)],
  }), /P1_5_REGIME_ORPHAN_RECEIPT/);
});
