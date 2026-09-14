import assert from "node:assert/strict";
import test from "node:test";
import {
  ADAPTIVE_MULTI_EVIDENCE_REGIME_ROUTER_V2_VERSION,
  buildAdaptiveMultiEvidenceRegimeRouterV2,
} from "../src/adaptive-multi-evidence-regime-router-v2.js";

const DECISION_TIME = "2026-09-14T09:00:00.000Z";

function admissibleEvidence(family) {
  return {
    status: "ADMISSIBLE",
    evidenceId: `evidence:${family}`,
    evidence: { lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2" },
    executionAuthority: "NONE",
  };
}

function marketFeatures(overrides = {}) {
  const base = {
    schemaVersion: "adaptive-multi-evidence-market-features-v2",
    lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    status: "READY_FOR_SPECIALIST_RESEARCH_ONLY",
    decisionTime: DECISION_TIME,
    contentDigest: "a".repeat(64),
    missingEvidence: [],
    features: {
      trend: {
        adx: 40,
        emaDirection: "UP",
        adxDirection: "UP",
        structureTrend: "BULLISH",
        emaFastSlopePctPerBar: 0.01,
        emaSlowSlopePctPerBar: 0.005,
        multiTimeframeStatus: "AVAILABLE",
        higherTimeframes: [{ timeframe: "1h", trend: "BULLISH" }],
      },
      momentum: {},
      volume: { abnormalVolume: false, abnormalVolumeZScore: 0.5 },
      volatility: {
        atrPct: 0.02,
        recentToPriorRangeRatio: 1,
        rangeState: "EXPANSION",
        latestGapPct: 0,
        abnormalRangeZScore: 0.5,
        abnormalVolatility: false,
      },
    },
    evidence: Object.fromEntries(
      ["trend", "momentum", "volume", "volatility"].map((family) => [family, admissibleEvidence(family)]),
    ),
    executionAuthority: "NONE",
  };
  return {
    ...base,
    ...overrides,
    features: {
      ...base.features,
      ...(overrides.features ?? {}),
      trend: { ...base.features.trend, ...(overrides.features?.trend ?? {}) },
      volume: { ...base.features.volume, ...(overrides.features?.volume ?? {}) },
      volatility: { ...base.features.volatility, ...(overrides.features?.volatility ?? {}) },
    },
  };
}

test("strong point-in-time trend routes only validated trend families", () => {
  const result = buildAdaptiveMultiEvidenceRegimeRouterV2({ marketFeatures: marketFeatures() });
  assert.equal(result.schemaVersion, ADAPTIVE_MULTI_EVIDENCE_REGIME_ROUTER_V2_VERSION);
  assert.equal(result.regime, "STRONG_TREND_UP");
  assert.equal(result.directionalRegime, "STRONG_TREND_UP");
  assert.equal(result.multiTimeframeAlignment, "ALIGNED");
  assert.deepEqual(result.routing.allowedStrategyFamilies, ["BREAKOUT", "MOMENTUM", "TREND_FOLLOWING"]);
  assert.equal(result.routing.entryPolicy, "VALIDATED_STRATEGIES_ONLY");
});

test("range and compression select distinct research families", () => {
  const range = buildAdaptiveMultiEvidenceRegimeRouterV2({
    marketFeatures: marketFeatures({ features: { trend: {
      adx: 12,
      emaDirection: "FLAT",
      adxDirection: "FLAT",
      structureTrend: "MIXED",
      emaFastSlopePctPerBar: 0,
      emaSlowSlopePctPerBar: 0,
    } } }),
  });
  assert.equal(range.regime, "RANGE");
  assert.deepEqual(range.routing.allowedStrategyFamilies, ["MEAN_REVERSION", "RANGE", "VWAP_DEVIATION"]);

  const compression = buildAdaptiveMultiEvidenceRegimeRouterV2({
    marketFeatures: marketFeatures({ features: { volatility: {
      recentToPriorRangeRatio: 0.7,
      rangeState: "COMPRESSION",
    } } }),
  });
  assert.equal(compression.regime, "VOLATILITY_COMPRESSION");
  assert.deepEqual(compression.routing.allowedStrategyFamilies, ["BREAKOUT_WATCH"]);
  assert.equal(compression.routing.entryPolicy, "WATCH_ONLY_NO_ENTRY_AUTHORITY");
});

test("panic and high volatility override directional routing and suppress unsupported entry", () => {
  const panic = buildAdaptiveMultiEvidenceRegimeRouterV2({
    marketFeatures: marketFeatures({ features: {
      volume: { abnormalVolume: true, abnormalVolumeZScore: 4 },
      volatility: {
        atrPct: 0.08,
        recentToPriorRangeRatio: 2.2,
        latestGapPct: -0.08,
        abnormalRangeZScore: 4,
        abnormalVolatility: true,
      },
    } }),
  });
  assert.equal(panic.regime, "PANIC_DISLOCATION");
  assert.equal(panic.routing.entryPolicy, "SUPPRESS_NEW_ENTRY");
  assert.deepEqual(panic.routing.allowedStrategyFamilies, []);

  const high = buildAdaptiveMultiEvidenceRegimeRouterV2({
    marketFeatures: marketFeatures({ features: { volatility: { atrPct: 0.06 } } }),
  });
  assert.equal(high.regime, "HIGH_VOLATILITY");
  assert.equal(high.routing.entryPolicy, "VOLATILITY_ADAPTED_POLICY_REQUIRED");
});

test("higher-timeframe conflict is explicit but is not blindly converted to a veto", () => {
  const result = buildAdaptiveMultiEvidenceRegimeRouterV2({
    marketFeatures: marketFeatures({ features: { trend: {
      higherTimeframes: [{ timeframe: "1h", trend: "BEARISH" }],
    } } }),
  });
  assert.equal(result.multiTimeframeAlignment, "CONFLICT");
  assert.equal(result.routing.higherTimeframeAction, "DOWNSTREAM_REVIEW_NOT_AUTOMATIC_VETO");
  assert.notEqual(result.routing.entryPolicy, "FAIL_CLOSED_NO_TRADE");
});

test("insufficient core regime facts remain UNKNOWN and fail closed", () => {
  const result = buildAdaptiveMultiEvidenceRegimeRouterV2({
    marketFeatures: marketFeatures({ features: { trend: { adx: null } } }),
  });
  assert.equal(result.regime, "UNKNOWN");
  assert.equal(result.status, "INSUFFICIENT_EVIDENCE_NO_TRADE");
  assert.equal(result.routing.entryPolicy, "FAIL_CLOSED_NO_TRADE");
  assert.deepEqual(result.routing.allowedStrategyFamilies, []);
});

test("foreign lineage, non-admissible evidence, and execution authority fail closed", () => {
  const result = buildAdaptiveMultiEvidenceRegimeRouterV2({
    marketFeatures: marketFeatures({
      lineageId: "FROZEN_CHALLENGER_V1",
      evidence: {},
      executionAuthority: "PAPER",
    }),
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("V1_OR_FOREIGN_LINEAGE_CONTAMINATION_FORBIDDEN"));
  assert.ok(result.blockers.includes("V2_REGIME_SOURCE_EVIDENCE_NOT_ADMISSIBLE"));
  assert.ok(result.blockers.includes("V2_REGIME_EXECUTION_AUTHORITY_FORBIDDEN"));
  assert.equal(result.regime, "UNKNOWN");
  assert.equal(result.liveTrading, false);
  assert.equal(result.autoTrading, false);
  assert.equal(result.realOrderEnabled, false);
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.executionAuthority, "NONE");
});

test("router never creates probability, profitability, vote, or execution credit", () => {
  const result = buildAdaptiveMultiEvidenceRegimeRouterV2({ marketFeatures: marketFeatures() });
  assert.equal(result.independentVoteCredit, 0);
  assert.equal(result.economicSampleCredit, 0);
  assert.equal(result.profitabilityProven, false);
  assert.equal(result.decisionAuthority, "NONE");
  assert.equal(result.liveTrading, false);
  assert.equal(result.autoTrading, false);
  assert.equal(result.realOrderEnabled, false);
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.executionAuthority, "NONE");
  assert.equal("probability" in result, false);
});
