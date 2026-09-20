import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAlphaGenomeV1,
} from "../src/autonomous-alpha-scientist-foundation-v1.js";
import {
  createWorldKnowledgeReceiptV1,
  buildWorldKnowledgeIngestV1,
} from "../src/world-knowledge-ingest-v1.js";
import {
  REQUIRED_ALPHA_RED_TEAM_SCENARIOS,
  buildAlphaRedTeamAttackPlanV1,
  evaluateAlphaRedTeamV1,
} from "../src/alpha-red-team-v1.js";
import {
  CANONICAL_FORECAST_HORIZONS,
  buildMultiHorizonForecastUncertaintyV1,
} from "../src/multi-horizon-forecast-uncertainty-v1.js";
import {
  buildCounterfactualTwinSwarmPlanV1,
  evaluateCounterfactualTwinSwarmV1,
} from "../src/counterfactual-twin-swarm-v1.js";
import {
  DIGITAL_TWIN_REQUIRED_SCENARIOS,
  buildMarketDigitalTwinPlanV1,
  buildMicrostructureSnapshotV1,
  evaluateMarketDigitalTwinV1,
} from "../src/market-digital-twin-microstructure-v1.js";
import {
  buildChampionChallengerResearchPlanV1,
} from "../src/autonomous-alpha-champion-challenger-v1.js";
import {
  buildAutonomousAlphaArchitectureReadinessV1,
  buildAutonomousAlphaCertificationV1,
} from "../src/autonomous-alpha-certification-v1.js";
import {
  ADAPTIVE_MULTI_EVIDENCE_NATURAL_PAPER_V2_VERSION,
} from "../src/adaptive-multi-evidence-natural-paper-v2.js";

const CANDIDATE_ID = "generated-formula-candidate:sha256:" + "1".repeat(64);
const HEX = (char) => char.repeat(64);

function receipt({ sourceId, sourceType, group, digestChar }) {
  return createWorldKnowledgeReceiptV1({
    sourceType,
    sourceId,
    title: `Source ${sourceId}`,
    canonicalUrl: `https://example.org/${sourceId}`,
    publisher: "Research Publisher",
    retrievedAt: "2026-09-20T04:00:00.000Z",
    provenanceDigest: HEX(digestChar),
    integrityState: "OK",
    rights: {
      accessMode: sourceType === "PUBLIC_BOOK" ? "PUBLIC_DOMAIN" : "PUBLIC_METADATA",
      derivedFactsAllowed: true,
      derivedSummaryAllowed: true,
      fullTextStorageAllowed: sourceType === "PUBLIC_BOOK",
      redistributionAllowed: sourceType === "PUBLIC_BOOK",
      attributionRequired: sourceType !== "PUBLIC_BOOK",
      licenseOrTermsUrl: "https://example.org/terms",
    },
    claims: [{
      claimId: `claim-${sourceId}`,
      derivedSummary: "A falsifiable strategy component is proposed for independent testing.",
      mechanism: "The feature may represent persistent information or execution pressure.",
      markets: ["CRYPTO_FUTURES"],
      horizons: ["15m"],
      features: ["order_flow_imbalance", "vwap_distance"],
      falsifiers: ["no OOS edge after costs", "edge disappears under execution stress"],
      independenceGroupId: group,
      evidenceDigest: HEX(digestChar),
      locator: "derived-research-location",
    }],
  });
}

function buildWorld() {
  return buildWorldKnowledgeIngestV1({
    receipts: [
      receipt({ sourceId: "academic", sourceType: "ACADEMIC_PAPER", group: "academic", digestChar: "a" }),
      receipt({ sourceId: "official", sourceType: "OFFICIAL", group: "official", digestChar: "b" }),
      receipt({ sourceId: "book", sourceType: "PUBLIC_BOOK", group: "book", digestChar: "c" }),
    ],
    edges: [
      { fromClaimId: "claim-official", toClaimId: "claim-academic", type: "SUPPORTS" },
      { fromClaimId: "claim-book", toClaimId: "claim-academic", type: "EXTENDS" },
    ],
  });
}

function buildGenome(world) {
  return buildAlphaGenomeV1({
    candidateId: CANDIDATE_ID,
    hypothesis: "Independent microstructure evidence may retain a cost-adjusted edge.",
    evidenceGraph: world.evidenceGraph,
    genes: [
      {
        geneId: "signal-flow",
        type: "SIGNAL",
        claimIds: ["claim-academic", "claim-official"],
        logic: { feature: "order_flow_imbalance", op: ">", parameter: "threshold" },
      },
      {
        geneId: "risk-first",
        type: "RISK",
        claimIds: ["claim-book"],
        logic: { sizingOrder: ["stop", "risk_budget", "quantity"], averagingDown: false },
      },
    ],
    trialAccounting: {
      priorEvaluatedCandidateCount: 20,
      declaredCandidateFamilySize: 128,
      candidateOrdinal: 21,
    },
  });
}

function buildRedTeam(genome) {
  const plan = buildAlphaRedTeamAttackPlanV1({ genome });
  const receipts = REQUIRED_ALPHA_RED_TEAM_SCENARIOS.map((scenarioId) => ({
    scenarioId,
    candidateId: genome.candidateId,
    genomeDigest: genome.genomeDigest,
    evidenceId: `red-team:${scenarioId.toLowerCase()}`,
    netExpectancy: 0.002,
    profitFactor: 1.25,
    maximumDrawdown: 0.08,
    tradeCount: 150,
    calibrationError: 0.06,
    frozenParameters: true,
    fullCostApplied: true,
    pointInTimeSafe: true,
    finalHoldoutUsed: false,
    executionAuthority: "NONE",
  }));
  return evaluateAlphaRedTeamV1({
    genome,
    attackPlan: plan,
    policy: {
      minNetExpectancy: 0,
      minProfitFactor: 1,
      maxDrawdown: 0.2,
      minTradeCount: 30,
      maxCalibrationError: 0.2,
      minimumScenarioPassRatio: 0.9,
    },
    receipts,
  });
}

function buildForecast(redTeam) {
  const forecasts = CANONICAL_FORECAST_HORIZONS.flatMap((horizon) => [
    {
      horizon,
      modelId: "price-model",
      independenceGroupId: "price",
      evidenceId: `forecast:${horizon}:price`,
      candidateId: CANDIDATE_ID,
      redTeamResultDigest: redTeam.resultDigest,
      asOf: "2026-09-20T04:00:00.000Z",
      quantiles: { q10: -0.01, q25: -0.002, q50: 0.004, q75: 0.011, q90: 0.02 },
      expectedReturn: 0.005,
      expectedDrawdown: 0.012,
      upProbability: 0.62,
      downProbability: 0.31,
      brierScore: 0.18,
      calibrationError: 0.06,
      sampleSize: 500,
      prospectiveOrOos: true,
      pointInTimeSafe: true,
      finalHoldoutUsed: false,
      executionAuthority: "NONE",
    },
    {
      horizon,
      modelId: "orderflow-model",
      independenceGroupId: "orderflow",
      evidenceId: `forecast:${horizon}:orderflow`,
      candidateId: CANDIDATE_ID,
      redTeamResultDigest: redTeam.resultDigest,
      asOf: "2026-09-20T04:00:00.000Z",
      quantiles: { q10: -0.009, q25: -0.001, q50: 0.0045, q75: 0.012, q90: 0.021 },
      expectedReturn: 0.0055,
      expectedDrawdown: 0.011,
      upProbability: 0.63,
      downProbability: 0.30,
      brierScore: 0.17,
      calibrationError: 0.055,
      sampleSize: 500,
      prospectiveOrOos: true,
      pointInTimeSafe: true,
      finalHoldoutUsed: false,
      executionAuthority: "NONE",
    },
  ]);
  return buildMultiHorizonForecastUncertaintyV1({
    redTeamResult: redTeam,
    forecasts,
    policy: {
      requiredHorizons: [...CANONICAL_FORECAST_HORIZONS],
      minimumIndependentModelGroups: 2,
      minimumSampleSize: 100,
      maximumCalibrationError: 0.12,
      maximumBrierScore: 0.24,
      maximumUncertaintyWidth: 0.08,
      minimumAbsoluteExpectedReturn: 0.001,
      maximumCrossModelExpectedReturnDispersion: 0.01,
    },
  });
}

function buildCounterfactual(forecast) {
  const plan = buildCounterfactualTwinSwarmPlanV1({
    forecastResult: forecast,
    policy: {
      maximumTwins: 8,
      sizeFractions: [0.25, 0.5],
      entryDelayBars: [0, 1],
      executionModes: ["LIMIT_SIM"],
      exitModes: ["BASE_POLICY", "TRAIL_ONLY"],
      includeNoTradeTwin: true,
    },
  });
  const path = HEX("d");
  const outcomes = plan.twins.map((twin, index) => {
    const gross = twin.action === "NO_TRADE" ? 0 : 5 + index;
    const fees = twin.action === "NO_TRADE" ? 0 : 0.4;
    const slippageCost = twin.action === "NO_TRADE" ? 0 : 0.2;
    const marketImpactCost = twin.action === "NO_TRADE" ? 0 : 0.1;
    const fundingCost = twin.action === "NO_TRADE" ? 0 : 0.05;
    return {
      twinId: twin.twinId,
      marketPathDigest: path,
      evidenceId: `twin-evidence:${index}`,
      grossPnl: gross,
      fees,
      slippageCost,
      marketImpactCost,
      fundingCost,
      netPnl: gross - fees - slippageCost - marketImpactCost - fundingCost,
      fillRatio: twin.action === "NO_TRADE" ? 0 : 0.9,
      sameMarketPath: true,
      simulated: true,
      pointInTimeSafe: true,
      marketImpactModeled: true,
      partialFillModeled: true,
      finalHoldoutUsed: false,
      executionAuthority: "NONE",
    };
  });
  return evaluateCounterfactualTwinSwarmV1({ plan, outcomes });
}

function microSnapshot(second) {
  return buildMicrostructureSnapshotV1({
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    observedAt: `2026-09-20T04:00:${String(second).padStart(2, "0")}.000Z`,
    sourceDigest: HEX("e"),
    bids: [[100, 2], [99.5, 3], [99, 4]],
    asks: [[100.5, 2], [101, 3], [101.5, 4]],
    trades: [
      { price: 100.5, quantity: 0.5, aggressorSide: "BUY" },
      { price: 100, quantity: 0.2, aggressorSide: "SELL" },
    ],
    depthLevels: 3,
  });
}

function buildDigitalTwin(counterfactual) {
  const plan = buildMarketDigitalTwinPlanV1({
    counterfactualResult: counterfactual,
    snapshots: [microSnapshot(0), microSnapshot(1), microSnapshot(2)],
    calibrationEvidence: {
      bookWalkEvidenceId: "execution-quality:book-walk",
      fillModelEvidenceId: "execution-quality:fill-model",
      liquidityImpactEvidenceId: "liquidity-impact:oos",
      latencyEvidenceId: "execution-cost:latency",
      partialFillEvidenceId: "execution-cost:partial-fill",
      tcaEvidenceId: "execution-quality:tca",
      publicOrPaperEvidenceOnly: true,
      pointInTimeSafe: true,
      fullCostComponentsIndependent: true,
      testFixture: false,
      executionAuthority: "NONE",
    },
    policy: {
      requiredScenarios: [...DIGITAL_TWIN_REQUIRED_SCENARIOS],
      minimumSnapshots: 3,
      maximumSnapshotGapMs: 2_000,
    },
  });
  const sequenceDigest = HEX("f");
  const scenarioResults = DIGITAL_TWIN_REQUIRED_SCENARIOS.map((scenarioId, index) => ({
    scenarioId,
    evidenceId: `digital-twin:${scenarioId.toLowerCase()}`,
    planDigest: plan.planDigest,
    snapshotSequenceDigest: sequenceDigest,
    netPnl: 8 - index,
    maximumDrawdown: 0.04 + index * 0.005,
    fillRatio: 0.9 - index * 0.04,
    realizedSlippageBps: 4 + index,
    calibrationAnchored: true,
    marketImpactModeled: true,
    partialFillModeled: true,
    latencyModeled: true,
    syntheticEconomicCredit: 0,
    executionAuthority: "NONE",
  }));
  return evaluateMarketDigitalTwinV1({ plan, scenarioResults });
}

function buildChampion(digitalTwin, redTeam) {
  return buildChampionChallengerResearchPlanV1({
    digitalTwinResult: digitalTwin,
    candidates: [{
      candidateId: CANDIDATE_ID,
      metrics: {
        costAdjustedExpectancy: 0.01,
        profitFactor: 1.3,
        maximumDrawdown: 0.08,
        walkForwardStability: 0.8,
        calibrationError: 0.07,
      },
      evidenceDigests: {
        sealedOos: HEX("2"),
        redTeam: redTeam.resultDigest,
        digitalTwin: digitalTwin.resultDigest,
        strategyHealth: HEX("4"),
        fullCost: HEX("5"),
      },
      sealedOosPassed: true,
      redTeamPassed: true,
      digitalTwinEvaluated: true,
      strategyHealthOk: true,
      fullCostApplied: true,
      pointInTimeSafe: true,
      finalHoldoutReused: false,
      executionAuthority: "NONE",
    }],
    incumbentCandidateId: CANDIDATE_ID,
  });
}

function inactiveNaturalPaperCandidate() {
  return {
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_NATURAL_PAPER_V2_VERSION,
    status: "NATURAL_PAPER_CANDIDATE_READY_INACTIVE",
    candidate: { candidateId: CANDIDATE_ID },
    handoffDigest: HEX("6"),
    scheduleActive: false,
    runtimeActivated: false,
    activationRequiresSeparateApproval: true,
    executionAuthority: "NONE",
  };
}

test("Autonomous Alpha Scientist eight-stage chain is lineage-continuous and stops before paper activation", () => {
  const worldKnowledge = buildWorld();
  const alphaGenome = buildGenome(worldKnowledge);
  const redTeam = buildRedTeam(alphaGenome);
  const forecast = buildForecast(redTeam);
  const counterfactual = buildCounterfactual(forecast);
  const digitalTwin = buildDigitalTwin(counterfactual);
  const championChallenger = buildChampion(digitalTwin, redTeam);
  const certification = buildAutonomousAlphaCertificationV1({
    championChallengerPlan: championChallenger,
    naturalPaperCandidate: inactiveNaturalPaperCandidate(),
  });
  const readiness = buildAutonomousAlphaArchitectureReadinessV1({
    worldKnowledge,
    alphaGenome,
    redTeam,
    forecast,
    counterfactual,
    digitalTwin,
    championChallenger,
    certification,
  });

  assert.equal(worldKnowledge.status, "WORLD_KNOWLEDGE_READY");
  assert.equal(alphaGenome.status, "ALPHA_GENOME_READY_FOR_FALSIFICATION");
  assert.equal(redTeam.status, "RED_TEAM_SURVIVOR_RESEARCH_ONLY");
  assert.equal(forecast.status, "FORECAST_READY_RESEARCH_ONLY");
  assert.equal(counterfactual.status, "COUNTERFACTUAL_TWIN_EVALUATED_RESEARCH_ONLY");
  assert.equal(digitalTwin.status, "MARKET_DIGITAL_TWIN_EVALUATED_RESEARCH_ONLY");
  assert.equal(championChallenger.status, "CHAMPION_CHALLENGER_READY_FOR_NATURAL_PAPER");
  assert.equal(certification.status, "READY_FOR_SEPARATE_NATURAL_PAPER_ACTIVATION_APPROVAL");

  assert.equal(readiness.status, "ARCHITECTURE_READY_EVIDENCE_PENDING_INACTIVE");
  assert.equal(readiness.architectureReady, true);
  assert.equal(readiness.profitabilityProven, false);
  assert.equal(readiness.acceptance.every((row) => row.passed), true);
  assert.equal(readiness.lineageChecks.every((row) => row.passed), true);
  assert.equal(readiness.executionAuthority, "NONE");
  assert.equal(readiness.liveTradingAllowed, false);
  assert.equal(readiness.autoTradingAllowed, false);
  assert.equal(readiness.realOrderAllowed, false);
});

test("end-to-end readiness fails closed if one middle-stage lineage digest is swapped", () => {
  const worldKnowledge = buildWorld();
  const alphaGenome = buildGenome(worldKnowledge);
  const redTeam = buildRedTeam(alphaGenome);
  const forecast = buildForecast(redTeam);
  const counterfactual = buildCounterfactual(forecast);
  const digitalTwin = buildDigitalTwin(counterfactual);
  const championChallenger = buildChampion(digitalTwin, redTeam);
  const certification = buildAutonomousAlphaCertificationV1({
    championChallengerPlan: championChallenger,
    naturalPaperCandidate: inactiveNaturalPaperCandidate(),
  });

  const readiness = buildAutonomousAlphaArchitectureReadinessV1({
    worldKnowledge,
    alphaGenome,
    redTeam,
    forecast,
    counterfactual: {
      ...counterfactual,
      forecastDigest: HEX("9"),
    },
    digitalTwin,
    championChallenger,
    certification,
  });

  assert.equal(readiness.status, "ARCHITECTURE_BLOCKED");
  assert.equal(readiness.architectureReady, false);
  assert.ok(readiness.blockers.includes("ARCH_LINEAGE_FORECAST_TO_COUNTERFACTUAL_INVALID"));
  assert.equal(readiness.liveTradingAllowed, false);
});
