import test from "node:test";
import assert from "node:assert/strict";
import { evaluateUsQualityDaytradeCatalystEvidence } from "../src/us-quality-daytrade-catalyst-evidence-v1.js";

function baseEvidence() {
  return {
    asOfMs: 100_000_000,
    symbol: "ROST",
    catalystPolicy: {
      lookbackMs: 24 * 60 * 60 * 1_000,
      maxCheckAgeMs: 30 * 60 * 1_000,
    },
    catalystEvidence: {
      publicReadOnly: true,
      privateApiUsed: false,
      symbol: "ROST",
      sourceId: "public-news-aggregator",
      checkedAtMs: 99_940_000,
      validUntilMs: 100_060_000,
      coverageStartMs: 10_000_000,
      coverageEndMs: 100_000_000,
      coverageComplete: true,
      catalystCount: 1,
      catalysts: [
        {
          catalystId: "rost-q2-2026",
          symbol: "ROST",
          catalystType: "EARNINGS_RESULT",
          sourceId: "rost-ir-q2-2026",
          pointInTime: true,
          publicReadOnly: true,
          privateApiUsed: false,
          publishedAtMs: 99_000_000,
          marketMovingTimestampMs: 99_000_000,
          headlineDigest: "sha256:rost-q2-2026",
        },
      ],
    },
  };
}

test("catalyst evidence accepts complete public PIT same-symbol catalyst coverage", () => {
  const result = evaluateUsQualityDaytradeCatalystEvidence(baseEvidence());
  assert.equal(result.status, "PASS");
  assert.equal(result.hasVerifiedCatalyst, true);
  assert.equal(result.catalystClass, "VERIFIED_CATALYST");
  assert.equal(result.primaryCatalyst.catalystId, "rost-q2-2026");
  assert.equal(result.executionAuthority, "NONE");
});

test("catalyst evidence can prove no verified catalyst in a complete lookback", () => {
  const input = baseEvidence();
  input.catalystEvidence.catalystCount = 0;
  input.catalystEvidence.catalysts = [];
  const result = evaluateUsQualityDaytradeCatalystEvidence(input);
  assert.equal(result.status, "PASS");
  assert.equal(result.hasVerifiedCatalyst, false);
  assert.equal(result.catalystClass, "NO_VERIFIED_CATALYST");
  assert.equal(result.primaryCatalyst, null);
});

test("catalyst evidence fails closed on cross-symbol catalyst contamination", () => {
  const input = baseEvidence();
  input.catalystEvidence.catalysts[0].symbol = "TJX";
  const result = evaluateUsQualityDaytradeCatalystEvidence(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "CATALYST_SYMBOL_MISMATCH");
});

test("catalyst evidence fails closed on private evidence", () => {
  const input = baseEvidence();
  input.catalystEvidence.privateApiUsed = true;
  const result = evaluateUsQualityDaytradeCatalystEvidence(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "CATALYST_EVIDENCE_PUBLIC_READ_ONLY_REQUIRED");
});

test("catalyst evidence fails closed on stale coverage check", () => {
  const input = baseEvidence();
  input.catalystEvidence.checkedAtMs = 98_000_000;
  const result = evaluateUsQualityDaytradeCatalystEvidence(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "CATALYST_EVIDENCE_STALE");
});

test("catalyst evidence fails closed on future catalyst timestamps", () => {
  const input = baseEvidence();
  input.catalystEvidence.catalysts[0].publishedAtMs = 101_000_000;
  const result = evaluateUsQualityDaytradeCatalystEvidence(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "CATALYST_FROM_FUTURE");
});

test("catalyst evidence fails closed when complete coverage does not span the lookback", () => {
  const input = baseEvidence();
  input.catalystEvidence.coverageStartMs = 20_000_000;
  const result = evaluateUsQualityDaytradeCatalystEvidence(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "CATALYST_EVIDENCE_COVERAGE_INSUFFICIENT");
});

test("catalyst evidence rejects duplicate catalyst identities", () => {
  const input = baseEvidence();
  input.catalystEvidence.catalystCount = 2;
  input.catalystEvidence.catalysts.push({ ...input.catalystEvidence.catalysts[0] });
  const result = evaluateUsQualityDaytradeCatalystEvidence(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "CATALYST_DUPLICATE_ID");
});
