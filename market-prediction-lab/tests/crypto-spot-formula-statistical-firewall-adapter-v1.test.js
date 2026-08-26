import assert from "node:assert/strict";
import test from "node:test";

import {
  CryptoSpotFormulaStatisticalFirewallAdapterError,
  buildAlignedRealizedEquityReturnSeriesV1,
  evaluateCanonicalCryptoSpotFormulaStatisticalEvidenceV1,
} from "../src/crypto-spot-formula-statistical-firewall-adapter-v1.js";

function trade({ id, exitTime, equityBefore, netPnl }) {
  return Object.freeze({
    id,
    exitTime,
    equityBefore,
    netPnl,
    equityAfter: equityBefore + netPnl,
  });
}

test("realized-equity return series is aligned to fixed selection-only buckets without mark-to-market fabrication", () => {
  const result = buildAlignedRealizedEquityReturnSeriesV1({
    backtest: {
      initialCapital: 1000,
      period: {
        startTime: 1000,
        endTime: 3999,
        includeFinalHoldout: false,
        finalHoldoutEvaluation: false,
        selectionAllowed: true,
      },
      trades: [
        trade({ id: "a", exitTime: 1500, equityBefore: 1000, netPnl: 100 }),
        trade({ id: "b", exitTime: 2500, equityBefore: 1100, netPnl: -55 }),
      ],
    },
    bucketMs: 1000,
  });

  assert.deepEqual(result.returns.map((value) => Number(value.toFixed(12))), [0.1, -0.05, 0]);
  assert.equal(result.tradeCount, 2);
  assert.equal(result.buckets[2].tradeCount, 0);
  assert.equal(result.noTradeBucketReturn, 0);
  assert.equal(result.markToMarketFabricated, false);
  assert.equal(result.finalHoldoutUsed, false);
});

test("equity-chain tampering and Final Holdout access fail closed before statistical evidence", () => {
  assert.throws(() => buildAlignedRealizedEquityReturnSeriesV1({
    backtest: {
      initialCapital: 1000,
      period: { startTime: 1000, endTime: 2999, selectionAllowed: true, includeFinalHoldout: false, finalHoldoutEvaluation: false },
      trades: [
        trade({ id: "a", exitTime: 1500, equityBefore: 999, netPnl: 10 }),
      ],
    },
    bucketMs: 1000,
  }), (error) => error instanceof CryptoSpotFormulaStatisticalFirewallAdapterError && error.code === "STATISTICAL_EQUITY_CHAIN_MISMATCH");

  assert.throws(() => buildAlignedRealizedEquityReturnSeriesV1({
    backtest: {
      initialCapital: 1000,
      period: { startTime: 1000, endTime: 2999, selectionAllowed: false, includeFinalHoldout: true, finalHoldoutEvaluation: true },
      trades: [],
    },
    bucketMs: 1000,
  }), (error) => error instanceof CryptoSpotFormulaStatisticalFirewallAdapterError && error.code === "STATISTICAL_FINAL_HOLDOUT_ACCESS_FORBIDDEN");
});

test("actual canonical #547 computes DSR/PBO evidence but remains fail-closed without empirical Reality Check and decision policies", () => {
  const trials = [
    {
      trialId: "trial-a",
      returnSeries: [0.010, 0.020, -0.005, 0.015, 0.010, 0.012, -0.004, 0.011, 0.009, 0.013, -0.002, 0.008],
    },
    {
      trialId: "trial-b",
      returnSeries: [0.008, 0.009, -0.004, 0.007, 0.006, 0.010, -0.003, 0.008, 0.006, 0.007, -0.001, 0.005],
    },
    {
      trialId: "trial-c",
      returnSeries: [0.004, -0.003, 0.006, 0.002, -0.002, 0.005, 0.001, -0.001, 0.003, 0.004, -0.002, 0.002],
    },
  ];

  const result = evaluateCanonicalCryptoSpotFormulaStatisticalEvidenceV1({
    trials,
    selectedTrialId: "trial-a",
    candidateFamilySize: 6,
    requiredAdjustedAlpha: 0.05 / 6,
  });

  assert.equal(result.status, "MISSING_EVIDENCE");
  assert.equal(result.failureCode, "STATISTICAL_EVIDENCE_MISSING");
  assert.equal(result.canonicalOwner, "#547");
  assert.equal(result.canonicalFirewall.trialCount, 3);
  assert.equal(result.canonicalFirewall.selectedTrialId, "trial-a");
  assert.equal(result.canonicalFirewall.dsr.status, "EVIDENCE_READY");
  assert.equal(result.canonicalFirewall.pbo.status, "EVIDENCE_READY");
  assert.equal(result.canonicalFirewall.realityCheckAndSpa.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(result.canonicalFirewall.decision.status, "THRESHOLDS_NOT_APPLIED");
  assert.equal(result.canonicalFirewall.dataSnoopingDisclosure.allSelectionTrialsCounted, true);
  assert.equal(result.canonicalFirewall.dataSnoopingDisclosure.finalHoldoutMayBeUsedForSelection, false);
  assert.equal(result.empiricalDecisionPolicyApplied, false);
  assert.equal(result.executionAuthority, "NONE");
  assert.match(result.failureReason, /REALITY_CHECK_AND_SPA/);
});

test("global family size cannot undercount the exact selection trial registry", () => {
  assert.throws(() => evaluateCanonicalCryptoSpotFormulaStatisticalEvidenceV1({
    trials: [
      { trialId: "trial-a", returnSeries: [0.01, 0.02, 0.03] },
      { trialId: "trial-b", returnSeries: [0.01, 0.02, 0.03] },
      { trialId: "trial-c", returnSeries: [0.01, 0.02, 0.03] },
    ],
    selectedTrialId: "trial-a",
    candidateFamilySize: 2,
    requiredAdjustedAlpha: 0.01,
  }), (error) => error instanceof CryptoSpotFormulaStatisticalFirewallAdapterError && error.code === "STATISTICAL_FAMILY_SIZE_UNDERCOUNTS_TRIALS");
});
