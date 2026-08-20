import test from "node:test";
import assert from "node:assert/strict";
import { evaluateQualityDaytradeUniverseProvenance } from "../src/us-quality-daytrade-universe-provenance-v1.js";

function baseInput() {
  return {
    asOfMs: 8_500,
    instrument: {
      marketCapUsd: 350_000_000_000,
      averageDollarVolumeUsd: 900_000_000,
    },
    universeEvidence: {
      marketCap: {
        sourceId: "issuer-sec-market-cap-pit",
        pointInTime: true,
        observedAtMs: 8_000,
        validFromMs: 1,
        validToMs: 20_000,
        marketCapUsd: 350_000_000_000,
      },
      averageDollarVolume: {
        sourceId: "historical-dollar-volume-pit",
        pointInTime: true,
        observedAtMs: 8_000,
        windowStartMs: 1,
        windowEndMs: 8_000,
        validUntilMs: 20_000,
        averageDollarVolumeUsd: 900_000_000,
      },
    },
  };
}

test("source-backed point-in-time universe evidence passes without execution authority", () => {
  const result = evaluateQualityDaytradeUniverseProvenance(baseInput());
  assert.equal(result.status, "PASS");
  assert.equal(result.reason, "POINT_IN_TIME_UNIVERSE_EVIDENCE_VERIFIED");
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.liveTradingAllowed, false);
  assert.equal(result.privateApiAllowed, false);
});

test("market-cap evidence must match the instrument value", () => {
  const input = baseInput();
  input.universeEvidence.marketCap.marketCapUsd += 1;
  const result = evaluateQualityDaytradeUniverseProvenance(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "MARKET_CAP_VALUE_MISMATCH");
});

test("future market-cap evidence is rejected", () => {
  const input = baseInput();
  input.universeEvidence.marketCap.observedAtMs = 9_000;
  const result = evaluateQualityDaytradeUniverseProvenance(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "MARKET_CAP_EVIDENCE_FROM_FUTURE");
});

test("market-cap validity must cover the evaluation time", () => {
  const input = baseInput();
  input.universeEvidence.marketCap.validToMs = 8_000;
  const result = evaluateQualityDaytradeUniverseProvenance(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "MARKET_CAP_COVERAGE_MISMATCH");
});

test("average-dollar-volume window cannot use future observations", () => {
  const input = baseInput();
  input.universeEvidence.averageDollarVolume.windowEndMs = 9_000;
  const result = evaluateQualityDaytradeUniverseProvenance(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "DOLLAR_VOLUME_WINDOW_FROM_FUTURE");
});

test("stale average-dollar-volume evidence is rejected", () => {
  const input = baseInput();
  input.universeEvidence.averageDollarVolume.validUntilMs = 8_000;
  const result = evaluateQualityDaytradeUniverseProvenance(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "DOLLAR_VOLUME_EVIDENCE_STALE");
});
