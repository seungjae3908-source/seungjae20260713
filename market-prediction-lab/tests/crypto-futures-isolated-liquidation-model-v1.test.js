import test from "node:test";
import assert from "node:assert/strict";
import {
  CRYPTO_FUTURES_ISOLATED_LIQUIDATION_MODEL_ID,
  CRYPTO_FUTURES_ISOLATED_LIQUIDATION_MODEL_VERSION,
  CRYPTO_FUTURES_ISOLATED_LIQUIDATION_RULE_EFFECTIVE_AT,
  buildCryptoFuturesLiquidationRiskAttestationV1,
  calculateCryptoFuturesIsolatedLiquidationRiskV1,
  cryptoFuturesIsolatedLiquidationModelReadinessV1,
  normalizeCryptoFuturesPositionTiersV1,
} from "../src/crypto-futures-isolated-liquidation-model-v1.js";
import {
  assertCryptoFuturesLiquidationRiskAttestationV1,
} from "../src/crypto-futures-derivatives-evidence-contract-v1.js";

const AS_OF = Date.UTC(2026, 7, 27, 0, 0, 0, 0);
const OPENED_AT = CRYPTO_FUTURES_ISOLATED_LIQUIDATION_RULE_EFFECTIVE_AT + 24 * 60 * 60_000;
const OBSERVED_AT = AS_OF - 60_000;
const TAKER_FEE = 0.0006;

function tierRows() {
  return [
    { tier: "1", minTierValue: "0", maxTierValue: "200000", leverage: "125", mmr: "0.004" },
    { tier: "2", minTierValue: "200000", maxTierValue: "500000", leverage: "100", mmr: "0.005" },
    { tier: "3", minTierValue: "500000", maxTierValue: "1000000", leverage: "75", mmr: "0.01" },
  ];
}

function tiers(overrides = {}) {
  return normalizeCryptoFuturesPositionTiersV1({
    rows: tierRows(),
    observedAt: OBSERVED_AT,
    asOf: AS_OF,
    ...overrides,
  });
}

function liquidationInput(overrides = {}) {
  return {
    direction: "LONG",
    positionSize: 3,
    averageEntryPrice: 110_000,
    markPrice: 110_000,
    positionMarginBeforeFunding: 33_000,
    fundingNetCost: 100,
    takerFeeRate: TAKER_FEE,
    openedAt: OPENED_AT,
    asOf: AS_OF,
    positionTiers: tiers(),
    ...overrides,
  };
}

function approximately(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * tolerance, `${actual} != ${expected}`);
}

test("public Bitget tiers compute the recursive pre-calculated offset exactly", () => {
  const normalized = tiers();
  assert.deepEqual(normalized.rows.map((row) => row.preCalculatedOffset), [0, 200, 2700]);
  assert.equal(normalized.publicDataOnly, true);
  assert.equal(normalized.executionAuthority, "NONE");
  assert.ok(Object.isFrozen(normalized.rows));

  const tier2 = normalized.rows[1];
  const maintenanceMarginWithFee = 330_000 * (tier2.mmr + TAKER_FEE) - tier2.preCalculatedOffset;
  assert.equal(maintenanceMarginWithFee, 1648);
});

test("LONG isolated liquidation price uses mark-price tier, fee, offset and realized funding cost", () => {
  const result = calculateCryptoFuturesIsolatedLiquidationRiskV1(liquidationInput());
  const expectedEffectiveMargin = 33_000 - 100;
  const expected = (expectedEffectiveMargin + 200 - 3 * 110_000) / (3 * (0.005 + TAKER_FEE - 1));

  assert.equal(result.modelId, CRYPTO_FUTURES_ISOLATED_LIQUIDATION_MODEL_ID);
  assert.equal(result.modelVersion, CRYPTO_FUTURES_ISOLATED_LIQUIDATION_MODEL_VERSION);
  assert.equal(result.selectedTier, 2);
  assert.equal(result.positionValue, 330_000);
  assert.equal(result.preCalculatedOffset, 200);
  assert.equal(result.maintenanceMarginRate, 0.005);
  assert.equal(result.effectivePositionMargin, expectedEffectiveMargin);
  approximately(result.liquidationPrice, expected);
  assert.ok(result.liquidationPrice < result.markPrice);
  assert.ok(result.liquidationDistancePercent > 0);
  assert.equal(result.liquidationBreached, false);
  assert.equal(result.privateAccountDataUsed, false);
  assert.equal(result.finalHoldoutUsed, false);
  assert.equal(result.executionAuthority, "NONE");
});

test("SHORT isolated liquidation price is direction-specific and lies above mark before breach", () => {
  const result = calculateCryptoFuturesIsolatedLiquidationRiskV1(liquidationInput({
    direction: "SHORT",
    fundingNetCost: -50,
  }));
  const expectedEffectiveMargin = 33_000 - (-50);
  const expected = (expectedEffectiveMargin + 200 - 3 * 110_000 * -1) / (3 * (0.005 + TAKER_FEE - (-1)));

  approximately(result.liquidationPrice, expected);
  assert.ok(result.liquidationPrice > result.markPrice);
  assert.ok(result.liquidationDistancePercent > 0);
  assert.equal(result.liquidationBreached, false);
});

test("paying funding moves LONG liquidation closer while receiving funding moves it farther", () => {
  const paid = calculateCryptoFuturesIsolatedLiquidationRiskV1(liquidationInput({ fundingNetCost: 300 }));
  const neutral = calculateCryptoFuturesIsolatedLiquidationRiskV1(liquidationInput({ fundingNetCost: 0 }));
  const received = calculateCryptoFuturesIsolatedLiquidationRiskV1(liquidationInput({ fundingNetCost: -300 }));

  assert.ok(paid.liquidationPrice > neutral.liquidationPrice);
  assert.ok(neutral.liquidationPrice > received.liquidationPrice);
  assert.ok(paid.liquidationDistancePercent < neutral.liquidationDistancePercent);
  assert.ok(neutral.liquidationDistancePercent < received.liquidationDistancePercent);
});

test("positions opened before the 2025-11-10 classic-account rule remain fail closed", () => {
  assert.throws(
    () => calculateCryptoFuturesIsolatedLiquidationRiskV1(liquidationInput({
      openedAt: CRYPTO_FUTURES_ISOLATED_LIQUIDATION_RULE_EFFECTIVE_AT - 1,
    })),
    /LIQUIDATION_RULE_HISTORY_UNSUPPORTED/,
  );
});

test("position tier observations must be point-in-time and cannot leak from the future", () => {
  assert.throws(
    () => normalizeCryptoFuturesPositionTiersV1({
      rows: tierRows(),
      observedAt: AS_OF + 1,
      asOf: AS_OF,
    }),
    /POSITION_TIERS_FUTURE_LEAKAGE/,
  );
});

test("tier ranges and maintenance margin ratios are strict and monotonic", () => {
  const gap = tierRows();
  gap[1] = { ...gap[1], minTierValue: "210000" };
  assert.throws(
    () => normalizeCryptoFuturesPositionTiersV1({ rows: gap, observedAt: OBSERVED_AT, asOf: AS_OF }),
    /POSITION_TIER_RANGE_NOT_CONTIGUOUS/,
  );

  const decreasing = tierRows();
  decreasing[2] = { ...decreasing[2], mmr: "0.003" };
  assert.throws(
    () => normalizeCryptoFuturesPositionTiersV1({ rows: decreasing, observedAt: OBSERVED_AT, asOf: AS_OF }),
    /POSITION_TIER_MMR_NOT_MONOTONIC/,
  );
});

test("exact internal tier boundaries fail closed instead of assuming undocumented inclusivity", () => {
  assert.throws(
    () => calculateCryptoFuturesIsolatedLiquidationRiskV1(liquidationInput({
      positionSize: 2,
      averageEntryPrice: 100_000,
      markPrice: 100_000,
      positionMarginBeforeFunding: 20_000,
      fundingNetCost: 0,
    })),
    /POSITION_VALUE_AT_TIER_BOUNDARY_AMBIGUOUS/,
  );
});

test("simulated leverage cannot exceed the selected public tier maximum", () => {
  assert.throws(
    () => calculateCryptoFuturesIsolatedLiquidationRiskV1(liquidationInput({
      positionMarginBeforeFunding: 1_000,
      fundingNetCost: 0,
    })),
    /LIQUIDATION_TIER_MAX_LEVERAGE_EXCEEDED/,
  );
});

test("funding is not a decorative flag: exhausting effective isolated margin blocks the calculation", () => {
  assert.throws(
    () => calculateCryptoFuturesIsolatedLiquidationRiskV1(liquidationInput({
      fundingNetCost: 33_000,
    })),
    /LIQUIDATION_EFFECTIVE_MARGIN_EXHAUSTED/,
  );
});

test("model attestation is structurally compatible with the derivatives evidence contract", () => {
  const attestation = buildCryptoFuturesLiquidationRiskAttestationV1({
    modelSourceSha: "b".repeat(40),
    riskPolicyIdentity: "research-futures-isolated-v1",
    contractRulesIdentity: "bitget-public-position-tier-v3",
  });
  assert.equal(attestation.modelId, CRYPTO_FUTURES_ISOLATED_LIQUIDATION_MODEL_ID);
  assert.equal(attestation.modelVersion, CRYPTO_FUTURES_ISOLATED_LIQUIDATION_MODEL_VERSION);
  assert.equal(attestation.fundingIncluded, true);
  assert.equal(attestation.maintenanceMarginTierEvidence, true);
  assert.equal(assertCryptoFuturesLiquidationRiskAttestationV1(attestation).evidenceDigest, attestation.evidenceDigest);
});

test("readiness keeps Formula Tournament blocked until point-in-time tier history exists", () => {
  const readiness = cryptoFuturesIsolatedLiquidationModelReadinessV1();
  assert.equal(readiness.status, "CURRENT_RULE_FORMULA_READY_HISTORY_BLOCKED");
  assert.equal(readiness.historicalCoverageBeforeEffectiveAt, false);
  assert.equal(readiness.positionTierHistoryProvenanceReady, false);
  assert.equal(readiness.currentPublicPositionTierEndpointReady, true);
  assert.equal(readiness.fundingAppliedToEffectiveMargin, true);
  assert.equal(readiness.formulaTournamentUnblocked, false);
  assert.equal(readiness.blocker, "POINT_IN_TIME_POSITION_TIER_HISTORY_REQUIRED");
  assert.equal(readiness.finalHoldoutAccessAllowed, false);
  assert.equal(readiness.profitabilityClaimAllowed, false);
  assert.equal(readiness.executionAuthority, "NONE");
});
