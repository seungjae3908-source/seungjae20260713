import test from "node:test";
import assert from "node:assert/strict";

import { MULTI_HORIZON_FORECAST_UNCERTAINTY_V1 } from "../src/multi-horizon-forecast-uncertainty-v1.js";
import {
  COUNTERFACTUAL_TWIN_SWARM_V1,
  buildCounterfactualTwinSwarmPlanV1,
  evaluateCounterfactualTwinSwarmV1,
} from "../src/counterfactual-twin-swarm-v1.js";

const forecastResult = Object.freeze({
  schemaVersion: MULTI_HORIZON_FORECAST_UNCERTAINTY_V1,
  artifactType: "MULTI_HORIZON_FORECAST",
  status: "FORECAST_READY_RESEARCH_ONLY",
  candidateId: "alpha-twin-001",
  forecastDigest: "a".repeat(64),
  decision: "RESEARCH_LONG_BIAS",
  executionAuthority: "NONE",
});

const policy = Object.freeze({
  maximumTwins: 16,
  sizeFractions: [0.25, 0.5],
  entryDelayBars: [0, 1],
  executionModes: ["LIMIT_SIM", "MARKET_SIM"],
  exitModes: ["BASE_POLICY", "TRAIL_ONLY"],
  includeNoTradeTwin: true,
});

function plan() {
  return buildCounterfactualTwinSwarmPlanV1({ forecastResult, policy });
}

function outcomesFor(p, overrideByTwinId = {}) {
  const path = "b".repeat(64);
  return p.twins.map((twin, index) => {
    const gross = twin.action === "NO_TRADE" ? 0 : 10 + index;
    const fees = twin.action === "NO_TRADE" ? 0 : 1;
    const slippage = twin.action === "NO_TRADE" ? 0 : 0.5;
    const impact = twin.action === "NO_TRADE" ? 0 : 0.25;
    const funding = twin.action === "NO_TRADE" ? 0 : 0.1;
    return {
      twinId: twin.twinId,
      marketPathDigest: path,
      evidenceId: `twin-outcome:${index}:evidence`,
      grossPnl: gross,
      fees,
      slippageCost: slippage,
      marketImpactCost: impact,
      fundingCost: funding,
      netPnl: gross - fees - slippage - impact - funding,
      fillRatio: twin.action === "NO_TRADE" ? 0 : 0.9,
      sameMarketPath: true,
      simulated: true,
      pointInTimeSafe: true,
      marketImpactModeled: true,
      partialFillModeled: true,
      finalHoldoutUsed: false,
      executionAuthority: "NONE",
      ...(overrideByTwinId[twin.twinId] ?? {}),
    };
  });
}

test("builds a bounded deterministic counterfactual swarm including NO_TRADE", () => {
  const p = plan();

  assert.equal(p.schemaVersion, COUNTERFACTUAL_TWIN_SWARM_V1);
  assert.equal(p.status, "COUNTERFACTUAL_TWIN_PLAN_READY");
  assert.ok(p.twinCount >= 2);
  assert.ok(p.twinCount <= policy.maximumTwins);
  assert.equal(p.twins.some((row) => row.action === "NO_TRADE"), true);
  assert.equal(new Set(p.twins.map((row) => row.twinId)).size, p.twinCount);
  assert.equal(p.sameFuturePathRequired, true);
  assert.equal(p.marketImpactSimulationRequired, true);
  assert.equal(p.partialFillSimulationRequired, true);
  assert.equal(p.executionAuthority, "NONE");
  assert.equal(p.counterfactualEconomicCredit, 0);
});

test("evaluates all twins on exactly the same simulated market path", () => {
  const p = plan();
  const result = evaluateCounterfactualTwinSwarmV1({
    plan: p,
    outcomes: outcomesFor(p),
  });

  assert.equal(result.status, "COUNTERFACTUAL_TWIN_EVALUATED_RESEARCH_ONLY");
  assert.match(result.marketPathDigest, /^[0-9a-f]{64}$/u);
  assert.ok(result.researchLeaderTwinId);
  assert.equal(result.selectionAuthority, false);
  assert.equal(result.promotionEligible, false);
  assert.equal(result.economicSampleCredit, 0);
  assert.equal(result.nextStage, "MARKET_DIGITAL_TWIN");
});

test("counterfactual ranking never becomes economic evidence", () => {
  const p = plan();
  const result = evaluateCounterfactualTwinSwarmV1({
    plan: p,
    outcomes: outcomesFor(p),
  });

  assert.ok(result.researchLeaderNetPnl > result.noTradeTwinNetPnl);
  assert.ok(result.diagnosticRegretVsResearchLeader > 0);
  assert.equal(result.counterfactualEconomicCredit, 0);
  assert.equal(result.profitabilityProven, false);
  assert.equal(result.executionAuthority, "NONE");
});

test("blocks outcomes evaluated on different market paths", () => {
  const p = plan();
  const rows = outcomesFor(p);
  rows[1] = { ...rows[1], marketPathDigest: "c".repeat(64) };
  const result = evaluateCounterfactualTwinSwarmV1({ plan: p, outcomes: rows });

  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("TWIN_MARKET_PATH_NOT_IDENTICAL"));
  assert.equal(result.researchLeaderTwinId, null);
  assert.equal(result.nextStage, null);
});

test("blocks accounting errors and missing execution realism evidence", () => {
  const p = plan();
  const first = p.twins.find((row) => row.action !== "NO_TRADE");
  const result = evaluateCounterfactualTwinSwarmV1({
    plan: p,
    outcomes: outcomesFor(p, {
      [first.twinId]: {
        netPnl: 999,
        marketImpactModeled: false,
        partialFillModeled: false,
      },
    }),
  });

  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("TWIN_OUTCOME_CONTRACT_INVALID"));
  const broken = result.outcomes.find((row) => row.twinId === first.twinId);
  assert.ok(broken.reasons.includes("TWIN_NET_PNL_ACCOUNTING_MISMATCH"));
  assert.ok(broken.reasons.includes("TWIN_MARKET_IMPACT_MODEL_REQUIRED"));
  assert.ok(broken.reasons.includes("TWIN_PARTIAL_FILL_MODEL_REQUIRED"));
});

test("blocks an incomplete swarm rather than comparing only surviving twins", () => {
  const p = plan();
  const rows = outcomesFor(p).slice(1);
  const result = evaluateCounterfactualTwinSwarmV1({ plan: p, outcomes: rows });

  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("TWIN_OUTCOMES_INCOMPLETE"));
  assert.equal(result.researchLeaderTwinId, null);
});
