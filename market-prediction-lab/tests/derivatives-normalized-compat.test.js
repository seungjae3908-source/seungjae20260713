import test from "node:test";
import assert from "node:assert/strict";
import { createTemporalDerivativesProvider, normalizeFundingRateRecord } from "../src/derivatives-history.js";

const START = Date.UTC(2026, 0, 1);

test("temporal provider accepts records already normalized by the collector", () => {
  const normalized = normalizeFundingRateRecord({ fundingRate: "0.000125", fundingTime: String(START) });
  const provider = createTemporalDerivativesProvider({ fundingHistory: [normalized] });
  const result = provider({ anchorTimestamp: START + 60_000 });
  assert.equal(result.derivativesFeatures.fundingRate, 0.000125);
  assert.equal(result.featureAvailability.fundingKnown, true);
  assert.equal(result.featureAvailability.fundingTimestamp, START);
});
