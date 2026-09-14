import assert from "node:assert/strict";
import test from "node:test";
import { sha256Canonical } from "../src/research-cache-provenance.js";
import { buildAdaptiveMultiEvidenceMetaDecisionV2 } from "../src/adaptive-multi-evidence-meta-decision-v2.js";

function portfolio() {
  const members = [{
    candidateId: "strategy-1",
    formulaCandidateId: "formula-1",
    strategyFamily: "TREND_FOLLOWING",
    market: "US_STOCK",
    timeframe: "1h",
    side: "BUY",
    strategyHash: "a".repeat(64),
    parameterIdentity: "b".repeat(64),
    signalKeys: ["s1"],
    tradeKeys: ["t1"],
    returnSeries: [1, 2, 3, 4, 5],
    drawdownSeries: [0, -1, -2, -1, 0],
    regimes: ["TREND_UP"],
    validationDigest: "c".repeat(64),
  }];
  const core = {
    lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    frozenAt: "2026-09-14T06:00:00.000Z",
    prospectiveBoundary: "2026-09-14T06:00:00.000Z",
    members,
    memberCount: 1,
    pairwise: [],
    diversificationPolicy: {
      maximumSignalOverlap: 0.4,
      maximumTradeOverlap: 0.4,
      maximumReturnCorrelation: 0.7,
      maximumDrawdownCorrelation: 0.7,
      maximumRegimeOverlap: 0.5,
      minimumCorrelationSamples: 5,
    },
  };
  const portfolioDigest = sha256Canonical(core);
  return {
    schemaVersion: "adaptive-multi-evidence-strategy-portfolio-v2",
    lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    status: "FROZEN_V2_STRATEGY_PORTFOLIO",
    portfolio: {
      ...core,
      portfolioId: `adaptive-v2-portfolio:${portfolioDigest}`,
      portfolioDigest,
      immutable: true,
      executionAuthority: "NONE",
    },
    frozenV1Contamination: 0,
    executionAuthority: "NONE",
  };
}

function independence() {
  return {
    schemaVersion: "adaptive-multi-evidence-independence-v2",
    lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    status: "GROUPED_FOR_RESEARCH_ONLY",
    canonicalEvidence: [{ evidenceId: "evidence-1" }, { evidenceId: "evidence-2" }],
    groups: [
      { groupId: "group-support", evidenceIds: ["evidence-1"] },
      { groupId: "group-oppose", evidenceIds: ["evidence-2"] },
    ],
    executionAuthority: "NONE",
  };
}

function router(overrides = {}) {
  return {
    schemaVersion: "adaptive-multi-evidence-regime-router-v2",
    lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    status: "READY_FOR_STRATEGY_ROUTING_RESEARCH_ONLY",
    regime: "TREND_UP",
    regimeDigest: "d".repeat(64),
    executionAuthority: "NONE",
    ...overrides,
  };
}

function hardGates(overrides = {}) {
  return Object.fromEntries([
    "DATA_QUALITY", "IDENTITY", "FRESHNESS", "REGIME", "EVENT_RISK",
    "LIQUIDITY", "COST", "GLOBAL_RISK", "STRATEGY_HEALTH",
  ].map((name) => [name, overrides[name] ?? { state: "PASS", evidenceId: `gate-${name}`, reason: null }]));
}

function input(overrides = {}) {
  return {
    portfolio: portfolio(),
    regimeRouter: router(),
    independence: independence(),
    market: "US_STOCK",
    symbol: "AAPL",
    timeframe: "1h",
    strategyIdentity: "strategy-1",
    currentPositionSide: "NONE",
    requestedDecision: "BUY",
    hardGates: hardGates(),
    specialistEvidence: [{ evidenceId: "evidence-1", independenceGroupId: "group-support", stance: "SUPPORT" }],
    executionAuthority: "NONE",
    ...overrides,
  };
}

test("all hard gates pass before a research-only long decision", () => {
  const result = buildAdaptiveMultiEvidenceMetaDecisionV2(input());
  assert.equal(result.status, "RESEARCH_DECISION_READY");
  assert.equal(result.decision, "BUY");
  assert.equal(result.hardVetoApplied, false);
  assert.equal(result.probability.status, "UNAVAILABLE");
  assert.equal(result.probability.value, null);
});

test("a hard veto beats any number of duplicated positive indicators", () => {
  const positive = Array.from({ length: 10 }, () => ({
    evidenceId: "evidence-1",
    independenceGroupId: "group-support",
    stance: "SUPPORT",
  }));
  const result = buildAdaptiveMultiEvidenceMetaDecisionV2(input({
    hardGates: hardGates({ LIQUIDITY: { state: "UNKNOWN", evidenceId: null, reason: "LIQUIDITY_UNAVAILABLE" } }),
    specialistEvidence: positive,
  }));
  assert.equal(result.decision, "NO_TRADE");
  assert.equal(result.hardVetoApplied, true);
  assert.equal(result.evidenceSummary.supportGroups.length, 1);
  assert.equal(result.evidenceSummary.duplicateGroupVotesDiscarded, 9);
});

test("conflicting independent evidence abstains instead of forcing a prediction", () => {
  const result = buildAdaptiveMultiEvidenceMetaDecisionV2(input({
    specialistEvidence: [
      { evidenceId: "evidence-1", independenceGroupId: "group-support", stance: "SUPPORT" },
      { evidenceId: "evidence-2", independenceGroupId: "group-oppose", stance: "OPPOSE" },
    ],
  }));
  assert.equal(result.status, "ABSTAINED");
  assert.equal(result.decision, "NO_TRADE");
  assert.ok(result.reasons.includes("CONFLICTING_SPECIALIST_EVIDENCE"));
});

test("LONG_ONLY markets cannot invent a short decision", () => {
  const result = buildAdaptiveMultiEvidenceMetaDecisionV2(input({ requestedDecision: "SHORT" }));
  assert.equal(result.decision, "NO_TRADE");
  assert.ok(result.reasons.includes("MARKET_DIRECTION_POLICY_FORBIDS_REQUESTED_DECISION"));
});

test("unknown or panic regime vetoes new entry", () => {
  const result = buildAdaptiveMultiEvidenceMetaDecisionV2(input({
    regimeRouter: router({ regime: "PANIC_DISLOCATION" }),
  }));
  assert.equal(result.decision, "NO_TRADE");
  assert.ok(result.reasons.some((reason) => reason.includes("PANIC_DISLOCATION")));
});

test("probability appears only with matching calibrated prospective evidence", () => {
  const invalid = buildAdaptiveMultiEvidenceMetaDecisionV2(input({
    probabilityEvidence: { value: 0.78 },
  }));
  assert.equal(invalid.probability.status, "UNAVAILABLE");
  assert.equal(invalid.probability.value, null);

  const available = buildAdaptiveMultiEvidenceMetaDecisionV2(input({
    probabilityEvidence: {
      market: "US_STOCK",
      symbol: "AAPL",
      timeframe: "1h",
      side: "BUY",
      strategyIdentity: "strategy-1",
      prospectiveOrOos: true,
      sampleSize: 500,
      minimumSampleSize: 200,
      value: 0.61,
      brierScore: 0.19,
      calibrationError: 0.03,
      calibrationCurve: [{ predicted: 0.6, observed: 0.58 }],
      evidenceId: "calibration-1",
    },
  }));
  assert.equal(available.probability.status, "AVAILABLE_CALIBRATED_EMPIRICAL_ONLY");
  assert.equal(available.probability.value, 0.61);
});

test("Frozen V1 and execution authority fail closed", () => {
  const result = buildAdaptiveMultiEvidenceMetaDecisionV2(input({
    regimeRouter: router({ lineageId: "FROZEN_CHALLENGER_V1" }),
    executionAuthority: "PAPER",
  }));
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.decision, "BLOCKED");
  assert.equal(result.liveTrading, false);
  assert.equal(result.autoTrading, false);
  assert.equal(result.realOrderEnabled, false);
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.executionAuthority, "NONE");
});
