import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCryptoWilliamsShadowOrderPlan,
  evaluateCryptoWilliamsAtrSignal,
} from "../src/crypto-williams-atr-strategy.js";

const fullFuturesInput = Object.freeze({
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

for (const field of ["markPrice", "fundingRate", "leverage", "liquidationPrice"]) {
  test(`futures paper can observe a signal but shadow is blocked when ${field} is omitted`, () => {
    const input = { ...fullFuturesInput };
    delete input[field];

    const result = evaluateCryptoWilliamsAtrSignal(input);

    assert.equal(result.status, "ENTRY");
    assert.equal(result.eligibleForPaper, true);
    assert.equal(result.eligibleForShadow, false);
    assert.equal(result.diagnostics.derivativesContext.complete, false);
    assert.ok(result.reasons.includes("shadow_derivatives_context_incomplete"));
    assert.equal(
      buildCryptoWilliamsShadowOrderPlan(result, {
        symbol: "BTCUSDT",
        timestamp: Date.parse("2026-08-12T12:00:00.000Z"),
      }),
      null,
    );
  });
}

test("complete futures context allows shadow only when the liquidation guard also passes", () => {
  const result = evaluateCryptoWilliamsAtrSignal(fullFuturesInput);

  assert.equal(result.status, "ENTRY");
  assert.equal(result.diagnostics.derivativesContext.complete, true);
  assert.equal(result.diagnostics.liquidation.verified, true);
  assert.equal(result.diagnostics.liquidation.safe, true);
  assert.equal(result.eligibleForShadow, true);
});
