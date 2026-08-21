import test from "node:test";
import assert from "node:assert/strict";
import { evaluateQualityDaytradeUniverseProvenance } from "../src/us-quality-daytrade-universe-provenance-v1.js";

function baseInput() {
  return {
    asOfMs: 8_500,
    instrument: {
      symbol: "MRK",
      exchange: "NYSE",
      securityType: "COMMON_STOCK",
      priceUsd: 150,
      marketCapUsd: 350_000_000_000,
      averageDollarVolumeUsd: 900_000_000,
    },
    universeEvidence: {
      listing: {
        sourceId: "exchange-listing-pit",
        pointInTime: true,
        publicReadOnly: true,
        privateApiUsed: false,
        symbol: "MRK",
        exchange: "NYSE",
        securityType: "COMMON_STOCK",
        observedAtMs: 8_000,
        validFromMs: 1,
        validToMs: 20_000,
      },
      price: {
        sourceId: "public-price-pit",
        pointInTime: true,
        publicReadOnly: true,
        privateApiUsed: false,
        symbol: "MRK",
        priceUsd: 150,
        observedAtMs: 8_000,
        validUntilMs: 20_000,
      },
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
  assert.equal(result.symbol, "MRK");
  assert.equal(result.exchange, "NYSE");
  assert.equal(result.securityType, "COMMON_STOCK");
  assert.equal(result.priceUsd, 150);
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.liveTradingAllowed, false);
  assert.equal(result.privateApiAllowed, false);
});

test("listing provenance is mandatory rather than trusting caller exchange/security type", () => {
  const input = baseInput();
  delete input.universeEvidence.listing;
  const result = evaluateQualityDaytradeUniverseProvenance(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "LISTING_PROVENANCE_REQUIRED");
});

test("private or non-public listing evidence cannot certify the universe", () => {
  const input = baseInput();
  input.universeEvidence.listing.publicReadOnly = false;
  const result = evaluateQualityDaytradeUniverseProvenance(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "LISTING_PUBLIC_READ_ONLY_REQUIRED");
});

test("listing security type must match the instrument", () => {
  const input = baseInput();
  input.universeEvidence.listing.securityType = "ETF";
  const result = evaluateQualityDaytradeUniverseProvenance(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "LISTING_SECURITY_TYPE_MISMATCH");
});

test("point-in-time price evidence is mandatory and symbol scoped", () => {
  const input = baseInput();
  input.universeEvidence.price.symbol = "TGT";
  const result = evaluateQualityDaytradeUniverseProvenance(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "PRICE_SYMBOL_MISMATCH");
});

test("stale universe price evidence is rejected", () => {
  const input = baseInput();
  input.universeEvidence.price.validUntilMs = 8_000;
  const result = evaluateQualityDaytradeUniverseProvenance(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "PRICE_EVIDENCE_STALE");
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
