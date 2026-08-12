import test from "node:test";
import assert from "node:assert/strict";
import {
  CRYPTO_WILLIAMS_ATR_DEFAULTS,
  buildCryptoWilliamsScannerSignal,
  buildCryptoWilliamsShadowOrderPlan,
  evaluateCryptoWilliamsAtrSignal,
  getKst09SessionKey,
} from "../src/crypto-williams-atr-strategy.js";

const baseSpot = Object.freeze({
  market: "CRYPTO_SPOT",
  previousHigh: 110,
  previousLow: 100,
  sessionOpen: 105,
  currentPrice: 110,
  movingAverage: 104,
  atr: 2,
  capital: 10_000,
  feeRate: 0.001,
  spreadRate: 0.002,
  slippageRate: 0.001,
});

const baseFutures = Object.freeze({
  market: "CRYPTO_FUTURES",
  previousHigh: 110,
  previousLow: 100,
  sessionOpen: 105,
  currentPrice: 110,
  movingAverage: 104,
  atr: 2,
  capital: 10_000,
  markPrice: 109.9,
  fundingRate: 0.0001,
  leverage: 2,
  liquidationPrice: 90,
  feeRate: 0.0006,
  spreadRate: 0.001,
  slippageRate: 0.0005,
});

test("V1 defaults are conservative and cannot enable Kelly or live execution", () => {
  assert.equal(CRYPTO_WILLIAMS_ATR_DEFAULTS.k, 0.5);
  assert.equal(CRYPTO_WILLIAMS_ATR_DEFAULTS.atrPeriod, 14);
  assert.equal(CRYPTO_WILLIAMS_ATR_DEFAULTS.atrStopMultiplier, 2);
  assert.equal(CRYPTO_WILLIAMS_ATR_DEFAULTS.riskFraction, 0.005);
  assert.equal(CRYPTO_WILLIAMS_ATR_DEFAULTS.maPeriod, 5);
  assert.equal(CRYPTO_WILLIAMS_ATR_DEFAULTS.executionMode, "PAPER_SHADOW_ONLY");
  assert.equal(CRYPTO_WILLIAMS_ATR_DEFAULTS.kellyEnabled, false);

  assert.throws(() => evaluateCryptoWilliamsAtrSignal(baseSpot, { kellyEnabled: true }), /Kelly sizing is disabled/);
  assert.throws(() => evaluateCryptoWilliamsAtrSignal(baseSpot, { executionMode: "LIVE" }), /PAPER_SHADOW_ONLY/);
  assert.throws(() => evaluateCryptoWilliamsAtrSignal(baseSpot, { riskFraction: 0.02 }), /must be <= 0.01/);
});

test("spot long breakout uses Williams target, ATR stop, and account-risk sizing", () => {
  const result = evaluateCryptoWilliamsAtrSignal(baseSpot);

  assert.equal(result.status, "ENTRY");
  assert.equal(result.direction, "LONG");
  assert.equal(result.levels.previousRange, 10);
  assert.equal(result.levels.longTarget, 110);
  assert.equal(result.levels.shortTarget, null);
  assert.equal(result.levels.entryPrice, 110);
  assert.equal(result.levels.stopDistance, 4);
  assert.equal(result.levels.stopPrice, 106);
  assert.equal(result.sizing.riskMoney, 50);
  assert.equal(result.sizing.quantity, 12.5);
  assert.equal(result.eligibleForPaper, true);
  assert.equal(result.eligibleForShadow, true);
  assert.equal(result.liveExecutionAllowed, false);
  assert.equal(result.kellyEnabled, false);
  assert.equal(result.diagnostics.estimatedRoundTripExecutionCostRate, 0.006);
});

test("trend filter rejects a spot breakout when session open is not above the moving average", () => {
  const result = evaluateCryptoWilliamsAtrSignal({
    ...baseSpot,
    sessionOpen: 103,
    movingAverage: 104,
    currentPrice: 109,
  });

  assert.equal(result.status, "NO_ENTRY");
  assert.equal(result.direction, null);
  assert.equal(result.sizing.quantity, 0);
  assert.ok(result.reasons.includes("long_trend_filter_rejected"));
});

test("spot never opens a short even when price breaks the symmetric lower target", () => {
  const result = evaluateCryptoWilliamsAtrSignal({
    ...baseSpot,
    sessionOpen: 105,
    movingAverage: 106,
    currentPrice: 99,
  });

  assert.equal(result.status, "NO_ENTRY");
  assert.equal(result.direction, null);
  assert.equal(result.levels.shortTarget, null);
  assert.ok(result.reasons.includes("spot_short_disabled"));
});

test("futures supports long and requires verified liquidation distance for shadow eligibility", () => {
  const result = evaluateCryptoWilliamsAtrSignal(baseFutures);

  assert.equal(result.status, "ENTRY");
  assert.equal(result.direction, "LONG");
  assert.equal(result.levels.longTarget, 110);
  assert.equal(result.levels.stopPrice, 106);
  assert.equal(result.diagnostics.markPrice, 109.9);
  assert.equal(result.diagnostics.fundingRate, 0.0001);
  assert.equal(result.diagnostics.liquidation.verified, true);
  assert.equal(result.diagnostics.liquidation.safe, true);
  assert.equal(result.eligibleForShadow, true);
});

test("futures supports a symmetric short breakout with ATR stop above entry", () => {
  const result = evaluateCryptoWilliamsAtrSignal({
    ...baseFutures,
    currentPrice: 100,
    movingAverage: 106,
    markPrice: 100.1,
    liquidationPrice: 120,
  });

  assert.equal(result.status, "ENTRY");
  assert.equal(result.direction, "SHORT");
  assert.equal(result.levels.shortTarget, 100);
  assert.equal(result.levels.entryPrice, 100);
  assert.equal(result.levels.stopPrice, 104);
  assert.equal(result.sizing.riskMoney, 50);
  assert.equal(result.sizing.quantity, 12.5);
  assert.equal(result.diagnostics.liquidation.safe, true);
});

test("futures liquidation guard rejects a setup when liquidation can happen before the ATR stop", () => {
  const result = evaluateCryptoWilliamsAtrSignal({
    ...baseFutures,
    liquidationPrice: 107,
  });

  assert.equal(result.status, "REJECTED");
  assert.equal(result.direction, "LONG");
  assert.equal(result.eligibleForPaper, false);
  assert.equal(result.eligibleForShadow, false);
  assert.equal(result.diagnostics.liquidation.safe, false);
  assert.ok(result.reasons.includes("liquidation_guard_rejected"));
});

test("futures can be observed in paper mode without liquidation data but cannot produce a shadow order plan", () => {
  const { liquidationPrice: _omitted, ...input } = baseFutures;
  const result = evaluateCryptoWilliamsAtrSignal(input);

  assert.equal(result.status, "ENTRY");
  assert.equal(result.eligibleForPaper, true);
  assert.equal(result.eligibleForShadow, false);
  assert.equal(result.diagnostics.liquidation.verified, false);
  assert.equal(buildCryptoWilliamsShadowOrderPlan(result, { symbol: "BTCUSDT" }), null);
});

test("scanner and shadow plan are derived from the same strategy result and shadow is simulated only", () => {
  const result = evaluateCryptoWilliamsAtrSignal(baseFutures);
  const scanner = buildCryptoWilliamsScannerSignal(result, { symbol: "btcusdt" });
  const shadow = buildCryptoWilliamsShadowOrderPlan(result, { symbol: "btcusdt" });

  assert.equal(scanner.strategyId, result.strategyId);
  assert.equal(scanner.symbol, "BTCUSDT");
  assert.equal(scanner.direction, "LONG");
  assert.equal(scanner.stopPrice, 106);
  assert.equal(scanner.liveExecutionAllowed, false);

  assert.equal(shadow.strategyId, result.strategyId);
  assert.equal(shadow.mode, "SHADOW");
  assert.equal(shadow.symbol, "BTCUSDT");
  assert.equal(shadow.side, "BUY");
  assert.equal(shadow.positionDirection, "LONG");
  assert.equal(shadow.orderType, "MARKET_SIMULATED");
  assert.equal(shadow.reduceOnlyOnExit, true);
  assert.equal(shadow.liveExecutionAllowed, false);
  assert.equal(shadow.privateExchangeApiAllowed, false);
});

test("KST 09:00 session boundary is exactly UTC 00:00", () => {
  assert.equal(getKst09SessionKey(Date.parse("2026-08-12T23:59:59.999Z")), "2026-08-12");
  assert.equal(getKst09SessionKey(Date.parse("2026-08-13T00:00:00.000Z")), "2026-08-13");
});

test("invalid prices, ATR, and spot derivatives fields fail closed", () => {
  assert.throws(() => evaluateCryptoWilliamsAtrSignal({ ...baseSpot, atr: 0 }), /atr must be greater than zero/);
  assert.throws(() => evaluateCryptoWilliamsAtrSignal({ ...baseSpot, capital: 0 }), /capital must be greater than zero/);
  assert.throws(() => evaluateCryptoWilliamsAtrSignal({ ...baseSpot, previousHigh: 99 }), /previousHigh must be >= previousLow/);
  assert.throws(() => evaluateCryptoWilliamsAtrSignal({ ...baseSpot, leverage: 2 }), /CRYPTO_SPOT leverage must be 1/);
  assert.throws(() => evaluateCryptoWilliamsAtrSignal({ ...baseSpot, fundingRate: 0 }), /derivatives-only fields are not allowed/);
});
