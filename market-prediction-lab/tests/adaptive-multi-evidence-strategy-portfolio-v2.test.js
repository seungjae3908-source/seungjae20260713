import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAdaptiveMultiEvidenceStrategyPortfolioV2,
  verifyAdaptiveMultiEvidenceStrategyPortfolioV2,
} from "../src/adaptive-multi-evidence-strategy-portfolio-v2.js";

const FROZEN_AT = "2026-09-14T06:00:00.000Z";

function finalist(candidateId, suffix) {
  return {
    candidateId,
    formulaCandidateId: `formula-${suffix}`,
    strategyHash: suffix.repeat(64),
    parameterIdentity: String(Number(suffix) + 2).repeat(64),
    validationDigest: String(Number(suffix) + 4).repeat(64),
  };
}

function validation(overrides = {}) {
  return {
    schemaVersion: "adaptive-multi-evidence-validation-v2",
    lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    status: "VALIDATED_FINALISTS_AVAILABLE",
    finalists: [finalist("trend", "1"), finalist("mean-reversion", "2")],
    executionAuthority: "NONE",
    ...overrides,
  };
}

function members(overrides = {}) {
  return [
    {
      candidateId: "trend",
      formulaCandidateId: "formula-1",
      strategyFamily: "TREND_FOLLOWING",
      market: "US_STOCK",
      timeframe: "1h",
      side: "BUY",
      strategyHash: "1".repeat(64),
      parameterIdentity: "3".repeat(64),
      signalKeys: ["s1", "s2", "s3"],
      tradeKeys: ["t1", "t2", "t3"],
      returnSeries: [1, 2, -1, 3, -2, 4],
      drawdownSeries: [0, -1, -2, -1, -3, -1],
      regimes: ["TREND_UP", "TREND_DOWN"],
    },
    {
      candidateId: "mean-reversion",
      formulaCandidateId: "formula-2",
      strategyFamily: "MEAN_REVERSION",
      market: "US_STOCK",
      timeframe: "1h",
      side: "BUY",
      strategyHash: "2".repeat(64),
      parameterIdentity: "4".repeat(64),
      signalKeys: ["s4", "s5"],
      tradeKeys: ["t4", "t5"],
      returnSeries: [-1, -2, 1, -3, 2, -4],
      drawdownSeries: [-3, -2, -1, -3, -1, 0],
      regimes: ["RANGE"],
    },
  ].map((member) => ({ ...member, ...(overrides[member.candidateId] ?? {}) }));
}

const diversificationPolicy = {
  maximumSignalOverlap: 0.4,
  maximumTradeOverlap: 0.4,
  maximumReturnCorrelation: 0.7,
  maximumDrawdownCorrelation: 0.7,
  maximumRegimeOverlap: 0.5,
  minimumCorrelationSamples: 5,
};

function build(proposedMembers = members(), overrides = {}) {
  return buildAdaptiveMultiEvidenceStrategyPortfolioV2({
    validation: validation(),
    proposedMembers,
    diversificationPolicy,
    frozenAt: FROZEN_AT,
    prospectiveBoundary: FROZEN_AT,
    executionAuthority: "NONE",
    ...overrides,
  });
}

test("orthogonal validated strategies freeze into an immutable V2 portfolio", () => {
  const result = build();
  assert.equal(result.status, "FROZEN_V2_STRATEGY_PORTFOLIO");
  assert.equal(result.portfolio.memberCount, 2);
  assert.equal(result.portfolio.pairwise[0].status, "COMPLEMENTARY");
  assert.equal(result.portfolio.objective, "ORTHOGONAL_COMPLEMENTARY_VALIDATED_STRATEGIES");
  assert.equal(verifyAdaptiveMultiEvidenceStrategyPortfolioV2(result), true);
});

test("five copies of momentum-like signals fail the overlap gate", () => {
  const proposed = members({
    "mean-reversion": {
      strategyFamily: "MOMENTUM_COPY",
      signalKeys: ["s1", "s2", "s3"],
      tradeKeys: ["t1", "t2", "t3"],
      regimes: ["TREND_UP", "TREND_DOWN"],
      returnSeries: [1, 2, -1, 3, -2, 4],
      drawdownSeries: [0, -1, -2, -1, -3, -1],
    },
  });
  const result = build(proposed);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("V2_PORTFOLIO_ORTHOGONALITY_GATE_FAILED"));
});

test("missing correlation evidence is unknown, never fabricated as zero", () => {
  const proposed = members({
    trend: { returnSeries: [1, 2], drawdownSeries: [0, -1] },
    "mean-reversion": { returnSeries: [-1, -2], drawdownSeries: [-1, 0] },
  });
  const result = build(proposed);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("V2_PORTFOLIO_DIVERSIFICATION_EVIDENCE_INSUFFICIENT"));
});

test("a single validated strategy may freeze without pretending to be diversified", () => {
  const result = build([members()[0]]);
  assert.equal(result.status, "FROZEN_V2_STRATEGY_PORTFOLIO");
  assert.equal(result.portfolio.singleStrategyPortfolio, true);
  assert.deepEqual(result.portfolio.pairwise, []);
});

test("tampering invalidates the portfolio digest", () => {
  const result = build();
  const tampered = {
    ...result,
    portfolio: { ...result.portfolio, memberCount: 3 },
  };
  assert.equal(verifyAdaptiveMultiEvidenceStrategyPortfolioV2(tampered), false);
});

test("Frozen V1 contamination and execution authority remain zero", () => {
  const blocked = build(members(), {
    validation: validation({ lineageId: "FROZEN_CHALLENGER_V1" }),
    executionAuthority: "PAPER",
  });
  assert.equal(blocked.status, "BLOCKED_DATA");
  assert.equal(blocked.frozenV1MutationAllowed, false);
  assert.equal(blocked.liveTrading, false);
  assert.equal(blocked.autoTrading, false);
  assert.equal(blocked.realOrderEnabled, false);
  assert.equal(blocked.privateTradingApiAllowed, false);
  assert.equal(blocked.executionAuthority, "NONE");

  const valid = build();
  assert.equal(valid.frozenV1Contamination, 0);
  assert.equal(valid.portfolio.executionAuthority, "NONE");
});
