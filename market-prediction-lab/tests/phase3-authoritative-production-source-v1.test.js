import assert from "node:assert/strict";
import test from "node:test";

import { runPhase3AuthoritativeProductionSourceV1 } from "../src/phase3-authoritative-production-source-v1.js";
import { runPhase4ProspectiveResultRuntimeSourceV1 } from "../src/phase4-prospective-result-runtime-source-v1.js";

const CODE_SHA = "741741cdc8a9438c906204ee9748633378b53199";

function family() {
  return {
    strategyFamilyId: "MOMENTUM_CROSS",
    strategyVersion: "1.0.0",
    sourceContract: "FormulaCandidateV1",
    sourceIdentity: "formula-family:VOLUME_MOMENTUM_CONTINUATION",
    marketType: "CRYPTO_SPOT",
    allowedSides: ["BUY"],
    supportedTimeframes: ["15m"],
    parameterSchema: {
      fast: { type: "integer", minimum: 2, maximum: 8, step: 1, default: 3, coarseValues: [3], narrowStep: 2, fineStep: 1 },
      slow: { type: "integer", minimum: 5, maximum: 12, step: 1, default: 8, coarseValues: [8], narrowStep: 2, fineStep: 1 },
    },
    constraints: [{ left: "fast", operator: "LT", rightParameter: "slow" }],
    requiredIndicators: ["EMA"],
    minimumWarmup: 12,
    backtestCompatibility: {
      owner: "#690",
      engine: "runIndependentSignalBacktest",
      executionEquivalentRequired: true,
    },
    status: "ACTIVE",
  };
}

function universe() {
  return {
    marketType: "CRYPTO_SPOT",
    market: "BINANCE_SPOT_PUBLIC",
    symbol: "BTCUSDT",
    timeframe: "15m",
    side: "BUY",
    datasetRole: "TRAIN",
    datasetIdentity: "dataset:phase3:train:v1",
    datasetDigest: "1".repeat(64),
    sourceFrameIdentity: "binance-public-klines:BTCUSDT:15m",
    eventWindow: "closed-candle:15m",
  };
}

function policies() {
  return {
    search: {
      version: "search-v1",
      seed: 838,
      maxCandidatesPerFamily: 16,
      maxTotalCandidates: 64,
      coarseSurvivorsPerFamily: 1,
      narrowSurvivorsPerFamily: 1,
      fineSurvivorsPerFamily: 1,
    },
    hardFilter: {
      version: "filter-v1",
      minimumTrades: 10,
      maximumDrawdown: 0.3,
      requiredMetrics: ["tradeCount", "maxDrawdown", "netReturn", "profitFactor"],
    },
    ranking: {
      version: "ranking-v1",
      components: [
        { metric: "netReturn", direction: "DESC", weight: 2, minimum: -0.2, maximum: 0.4 },
        { metric: "maxDrawdown", direction: "ASC", weight: 1, minimum: 0, maximum: 0.5 },
      ],
    },
    statistical: { version: "statistics-v1", decisionOwner: "HUMAN_FROZEN_POLICY" },
    cost: { version: "cost-v1", commissionBps: 10, spreadBps: 5, slippageBps: 5 },
  };
}

function tournamentInput(overrides = {}) {
  return {
    codeSha: CODE_SHA,
    families: [family()],
    universe: [universe()],
    policies: policies(),
    ...overrides,
  };
}

function callbacks(overrides = {}) {
  return {
    async runCanonicalBacktest(request) {
      return {
        candidateId: request.candidate.candidateId,
        strategyFamily: request.candidate.strategyFamilyId,
        parameterDigest: request.candidate.parameterDigest,
        split: "TRAIN",
        datasetRole: "TRAIN",
        datasetIdentity: request.dataset.identity,
        datasetDigest: request.dataset.digest,
        canonicalBacktestOwner: "#690",
        executionEngine: "runIndependentSignalBacktest",
        executionEquivalent: true,
        leakageChecks: {
          futureCandleLeakage: false,
          validationOutcomeLeakage: false,
          oosOutcomeLeakage: false,
          settlementOutcomeLeakage: false,
        },
        backtestVersion: "independent-signal-backtest-v1",
        costPolicyDigest: request.costPolicyDigest,
        costPolicy: request.costPolicy,
        metrics: {
          grossReturn: 0.2,
          netReturn: 0.15,
          tradeCount: 40,
          winRate: 0.55,
          profitFactor: 1.3,
          maxDrawdown: 0.12,
          volatility: 0.2,
        },
      };
    },
    async evaluateStatisticalFirewall(request) {
      return {
        status: "PASS",
        policyDigest: request.statisticalPolicyDigest,
        candidateFamilySize: request.candidateFamilySize,
        selectionBiasRecorded: true,
      };
    },
    ...overrides,
  };
}

test("canonical Phase3 core is the sole producer of one authoritative production source", async () => {
  const result = await runPhase3AuthoritativeProductionSourceV1(
    { tournamentInput: tournamentInput() },
    callbacks(),
  );

  assert.equal(result.status, "PHASE3_AUTHORITATIVE_PRODUCTION_SOURCE_READY");
  assert.equal(result.sourceCount, 1);
  assert.equal(result.authoritativePhase3Sources.length, 1);
  const source = result.authoritativePhase3Sources[0];
  assert.equal(source.sourceAuthority, "runPhase3StrategyTournamentCoreV1");
  assert.equal(source.synthetic, false);
  assert.equal(source.replay, false);
  assert.equal(source.backfill, false);
  assert.equal(source.tournamentResult.status, "COMPLETE");
  assert.ok(source.tournamentResult.finalists.length > 0);
  assert.equal(source.tournamentResult.tournamentRunId, result.tournamentRunId);
  assert.deepEqual(source.tournamentInput, tournamentInput());
  assert.equal(Object.isFrozen(source), true);
  assert.equal(Object.isFrozen(source.tournamentInput), true);
  assert.equal(result.runtimeActivationAllowed, false);
  assert.equal(result.dispatchAllowed, false);
  assert.equal(result.sampleCredit, 0);
  assert.equal(result.executionRealismCredit, 0);
  assert.equal(result.profitabilityCredit, 0);
  assert.equal(result.PROFITABILITY_PROVEN, false);
  assert.equal(result.NET_ALPHA_PROVEN, false);
  assert.equal(result.CHAMPION, "NONE");
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.realOrderCount, 0);
});

test("missing canonical dependencies remain blocked and create no source", async () => {
  const deps = callbacks();
  const result = await runPhase3AuthoritativeProductionSourceV1(
    { tournamentInput: tournamentInput() },
    { runCanonicalBacktest: deps.runCanonicalBacktest },
  );

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.FIRST_ZERO, "PHASE3_AUTHORITATIVE_PRODUCTION_CORE_BLOCKED");
  assert.equal(result.upstreamReason, "STATISTICAL_POLICY_MISSING");
  assert.equal(result.sourceCount, 0);
  assert.deepEqual(result.authoritativePhase3Sources, []);
});

test("caller-supplied Phase3 results or identities are rejected before core execution", async () => {
  for (const override of [
    { tournamentResult: {} },
    { phase3Result: {} },
    { authoritativePhase3Sources: [] },
    { candidateId: "manual" },
    { finalists: [] },
  ]) {
    const result = await runPhase3AuthoritativeProductionSourceV1(
      { tournamentInput: tournamentInput(), ...override },
      callbacks(),
    );
    assert.equal(result.FIRST_ZERO, "PHASE3_AUTHORITATIVE_PRODUCTION_SOURCE_OVERRIDE_REJECTED");
    assert.equal(result.sourceCount, 0);
  }
});

test("non-JSON tournament input and COMPLETE-without-finalist evidence fail closed", async () => {
  const nonJson = await runPhase3AuthoritativeProductionSourceV1(
    { tournamentInput: tournamentInput({ runtimeCallback: () => true }) },
    callbacks(),
  );
  assert.equal(nonJson.FIRST_ZERO, "PHASE3_AUTHORITATIVE_PRODUCTION_INPUT_INVALID");
  assert.equal(nonJson.sourceCount, 0);

  const base = callbacks();
  const noFinalist = await runPhase3AuthoritativeProductionSourceV1(
    { tournamentInput: tournamentInput() },
    callbacks({
      async runCanonicalBacktest(request) {
        const valid = await base.runCanonicalBacktest(request);
        return { ...valid, metrics: { ...valid.metrics, tradeCount: 0 } };
      },
    }),
  );
  assert.equal(noFinalist.FIRST_ZERO, "PHASE3_AUTHORITATIVE_PRODUCTION_RESULT_INVALID");
  assert.equal(noFinalist.detail, "PHASE3_FINALIST_MISSING");
  assert.equal(noFinalist.sourceCount, 0);
});

test("authoritative Phase3 source feeds the existing Phase4 source without identity remap", async () => {
  const phase3 = await runPhase3AuthoritativeProductionSourceV1(
    { tournamentInput: tournamentInput() },
    callbacks(),
  );
  assert.equal(phase3.status, "PHASE3_AUTHORITATIVE_PRODUCTION_SOURCE_READY");

  const phase4 = runPhase4ProspectiveResultRuntimeSourceV1({
    authoritativePhase3Sources: phase3.authoritativePhase3Sources,
    freezeTimestamp: "2026-09-12T00:00:00.000Z",
  });
  assert.equal(phase4.status, "PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_READY");
  assert.equal(phase4.candidateId, phase3.authoritativePhase3Sources[0].tournamentResult.finalists[0].candidateId);
  assert.equal(phase4.runtimeActivationAllowed, false);
  assert.equal(phase4.sampleCredit, 0);
  assert.equal(phase4.PROFITABILITY_PROVEN, false);
});
