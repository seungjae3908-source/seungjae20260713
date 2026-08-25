import assert from "node:assert/strict";
import test from "node:test";
import { sha256Canonical } from "../src/research-cache-provenance.js";
import { resolveCanonicalStrategyIdentity } from "../src/canonical-strategy-identity-v1.js";
import { buildStrategyEvidenceEnvelope } from "../src/strategy-evidence-envelope-v1.js";
import { PROVISIONAL_CHAMPION_POLICY_V1, selectProvisionalChampion } from "../src/provisional-champion-selector-v1.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function identity(id = "candidate-a", overrides = {}) {
  return {
    strategyId: id, strategyFamily: "regime", strategyVersion: "v1", market: "US_STOCK", direction: "BUY",
    timeframe: "1D", formulaIdentity: `formula-${id}`, parameterHash: HASH_A, researchCodeSha: "1".repeat(40),
    datasetId: "dataset-v1", datasetDigest: HASH_B, datasetStart: "2020-01-01T00:00:00.000Z",
    datasetEnd: "2025-01-01T00:00:00.000Z", costPolicyVersion: "cost-v1", riskPolicyVersion: "risk-v1",
    evidenceSchemaVersion: "strategy-evidence-envelope-v1", ...overrides,
  };
}

function stage(strategyIdentity, evidenceStage, overrides = {}) {
  const resolved = resolveCanonicalStrategyIdentity(strategyIdentity);
  const payload = { id: strategyIdentity.strategyId, evidenceStage };
  return buildStrategyEvidenceEnvelope({
    strategyIdentity, strategyIdentityDigest: resolved.strategyIdentityDigest, evidenceType: "CANONICAL_ENGINE_RESULT",
    evidenceStage, source: "canonical-owner", sourceSha: "2".repeat(40), artifactId: `${strategyIdentity.strategyId}-${evidenceStage}`,
    artifactDigest: sha256Canonical(payload), artifactPayload: payload, measuredAt: "2026-08-25T00:00:00.000Z",
    datasetIdentity: { datasetId: strategyIdentity.datasetId, datasetDigest: strategyIdentity.datasetDigest, datasetStart: strategyIdentity.datasetStart, datasetEnd: strategyIdentity.datasetEnd },
    sample: { sampleN: 60, tradeN: 60, settledN: null },
    metrics: { expectancy: 0.02, profitFactor: 1.4, mdd: 0.18, netReturn: 0.3, positiveWindowRatio: 0.75, costAdjustedReturn: 0.02, dsr: 0.8, pbo: 0.2 },
    costs: evidenceStage === "COST_STRESS" ? { costPolicyVersion: strategyIdentity.costPolicyVersion, multiplier: 1.5 } : null,
    validation: {
      datasetIntegrity: true,
      noFutureLeakage: true,
      noSameBarLeakage: true,
      parameterStability: "PASS",
      costStressSurvived: true,
      mddAcceptable: true,
      overfitVerdict: "PASS",
    },
    ...overrides,
  });
}

function candidate(id = "candidate-a", overrides = {}) {
  const strategyIdentity = overrides.strategyIdentity ?? identity(id);
  const resolved = resolveCanonicalStrategyIdentity(strategyIdentity);
  return {
    strategyIdentity,
    strategyIdentityDigest: overrides.strategyIdentityDigest ?? resolved.strategyIdentityDigest,
    evidenceEnvelopes: overrides.evidenceEnvelopes ?? [
      stage(strategyIdentity, "OOS"),
      stage(strategyIdentity, "WALK_FORWARD"),
      stage(strategyIdentity, "COST_STRESS"),
      stage(strategyIdentity, "STATISTICAL_FIREWALL"),
    ],
    testOnly: overrides.testOnly ?? true,
  };
}

const TEST_POLICY = Object.freeze({ ...PROVISIONAL_CHAMPION_POLICY_V1, environment: "TEST_ONLY" });

test("no eligible candidates returns NONE and never changes validated champion", () => {
  const none = selectProvisionalChampion({ candidates: [] });
  assert.equal(none.status, "NONE");
  assert.equal(none.currentProvisionalChampion, "NONE");
  assert.equal(none.currentValidatedChampion, "NONE");
  assert.equal(none.validatedChampion, false);
});

test("production selection is locked until the Phase 5 canonical evidence adapter exists", () => {
  const result = selectProvisionalChampion({ candidates: [candidate("production-shaped", { testOnly: false })] });
  assert.equal(result.status, "NONE");
  assert.equal(result.currentProvisionalChampion, "NONE");
  assert.ok(result.blockers.includes("CANONICAL_EVIDENCE_ADAPTER_NOT_READY"));
  assert.equal(result.canonicalEvidenceAuthority, "PHASE5_ADAPTER_REQUIRED");
});

test("highest historical return alone cannot win without mandatory forward-robustness evidence", () => {
  const strategyIdentity = identity("high-return");
  const historicalOnly = candidate("high-return", { evidenceEnvelopes: [stage(strategyIdentity, "HISTORICAL_BACKTEST", { metrics: { netReturn: 99 } })] });
  const result = selectProvisionalChampion({ candidates: [historicalOnly, candidate("eligible")], policy: TEST_POLICY });
  assert.equal(result.status, "PROVISIONAL_CHAMPION");
  assert.equal(result.strategyId, "eligible");
  assert.ok(result.evaluations.find((row) => row.strategyId === "high-return").blockers.includes("MISSING_REQUIRED_STAGE:OOS"));
  assert.ok(result.evaluations.find((row) => row.strategyId === "high-return").blockers.includes("MISSING_REQUIRED_STAGE:STATISTICAL_FIREWALL"));
});

test("missing cost, unstable parameters and identity mismatch reject candidates", () => {
  const base = identity("blocked");
  const missingCost = candidate("blocked", { evidenceEnvelopes: [stage(base, "OOS"), stage(base, "WALK_FORWARD"), stage(base, "STATISTICAL_FIREWALL")] });
  const unstableIdentity = identity("unstable");
  const unstable = candidate("unstable", { evidenceEnvelopes: [
    stage(unstableIdentity, "OOS"),
    stage(unstableIdentity, "WALK_FORWARD", { validation: { datasetIntegrity: true, noFutureLeakage: true, noSameBarLeakage: true, parameterStability: "FAIL", mddAcceptable: true, overfitVerdict: "PASS" } }),
    stage(unstableIdentity, "COST_STRESS"),
    stage(unstableIdentity, "STATISTICAL_FIREWALL"),
  ] });
  const mismatch = candidate("mismatch", { strategyIdentityDigest: HASH_A });
  const result = selectProvisionalChampion({ candidates: [missingCost, unstable, mismatch], policy: TEST_POLICY });
  assert.equal(result.status, "NONE");
  assert.ok(result.blockers.includes("MISSING_REQUIRED_STAGE:COST_STRESS"));
  assert.ok(result.blockers.includes("PARAMETER_STABILITY_REQUIRED"));
  assert.ok(result.blockers.includes("IDENTITY_MISMATCH"));
});

test("statistical firewall, positive expectancy and acceptable MDD are mandatory hard gates", () => {
  const noFirewallIdentity = identity("no-firewall");
  const noFirewall = candidate("no-firewall", { evidenceEnvelopes: [
    stage(noFirewallIdentity, "OOS"),
    stage(noFirewallIdentity, "WALK_FORWARD"),
    stage(noFirewallIdentity, "COST_STRESS"),
  ] });

  const negativeIdentity = identity("negative");
  const negative = candidate("negative", { evidenceEnvelopes: [
    stage(negativeIdentity, "OOS", { metrics: { expectancy: -0.01, profitFactor: 1.2, mdd: 0.1, positiveWindowRatio: 0.7, costAdjustedReturn: 0.01, dsr: 0.8, pbo: 0.2 } }),
    stage(negativeIdentity, "WALK_FORWARD"),
    stage(negativeIdentity, "COST_STRESS"),
    stage(negativeIdentity, "STATISTICAL_FIREWALL"),
  ] });

  const badMddIdentity = identity("bad-mdd");
  const badMdd = candidate("bad-mdd", { evidenceEnvelopes: [
    stage(badMddIdentity, "OOS", { validation: { datasetIntegrity: true, noFutureLeakage: true, noSameBarLeakage: true, parameterStability: "PASS", costStressSurvived: true, mddAcceptable: false, overfitVerdict: "PASS" } }),
    stage(badMddIdentity, "WALK_FORWARD"),
    stage(badMddIdentity, "COST_STRESS"),
    stage(badMddIdentity, "STATISTICAL_FIREWALL"),
  ] });

  const result = selectProvisionalChampion({ candidates: [noFirewall, negative, badMdd], policy: TEST_POLICY });
  assert.equal(result.status, "NONE");
  assert.ok(result.blockers.includes("MISSING_REQUIRED_STAGE:STATISTICAL_FIREWALL"));
  assert.ok(result.blockers.includes("OOS_POSITIVE_EXPECTANCY_REQUIRED"));
  assert.ok(result.blockers.includes("OOS_ACCEPTABLE_MDD_REQUIRED"));
});

test("cost-adjusted survival must remain positive after mandatory costs", () => {
  const strategyIdentity = identity("cost-fail");
  const result = selectProvisionalChampion({ candidates: [candidate("cost-fail", { evidenceEnvelopes: [
    stage(strategyIdentity, "OOS"),
    stage(strategyIdentity, "WALK_FORWARD"),
    stage(strategyIdentity, "COST_STRESS", { metrics: { expectancy: -0.02, profitFactor: 1.1, mdd: 0.18, positiveWindowRatio: 0.7, costAdjustedReturn: -0.02, dsr: 0.8, pbo: 0.2 } }),
    stage(strategyIdentity, "STATISTICAL_FIREWALL"),
  ] })], policy: TEST_POLICY });
  assert.equal(result.status, "NONE");
  assert.ok(result.blockers.includes("COST_ADJUSTED_EXPECTANCY_NOT_POSITIVE"));
});

test("eligible selection is deterministic, TEST_ONLY and never Validated", () => {
  const input = { candidates: [candidate("candidate-b"), candidate("candidate-a")], policy: TEST_POLICY };
  const first = selectProvisionalChampion(input);
  const second = selectProvisionalChampion(input);
  assert.deepEqual(first, second);
  assert.equal(first.status, "PROVISIONAL_CHAMPION");
  assert.equal(first.currentProvisionalChampion.evidenceClass, "TEST_ONLY");
  assert.equal(first.currentValidatedChampion, "NONE");
  assert.equal(first.executionAuthority, "NONE");
  assert.equal(first.safety.LIVE_TRADING, false);
  assert.equal(first.safety.REAL_ORDER_ENABLED, false);
  assert.equal(first.safety.PRIVATE_TRADING_API_ALLOWED, false);
  assert.equal(first.safety.orderSubmitApiCalls, 0);
  assert.throws(
    () => selectProvisionalChampion({ ...input, policy: { ...TEST_POLICY, minimumOosTradeN: 1 } }),
    /exact versioned provisional champion policy/u,
  );
});
