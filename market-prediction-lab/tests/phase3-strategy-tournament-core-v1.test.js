import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPhase3StrategyFamilyRegistryV1,
  createPhase3CandidateIdentityV1,
  phase3DigestV1,
  runPhase3StrategyTournamentCoreV1,
} from "../src/phase3-strategy-tournament-core-v1.js";

const CODE_SHA = "741741cdc8a9438c906204ee9748633378b53199";

function family(overrides = {}) {
  return {
    strategyFamilyId: "MOMENTUM_CROSS",
    strategyVersion: "1.0.0",
    sourceContract: "FormulaCandidateV1",
    sourceIdentity: "formula-family:VOLUME_MOMENTUM_CONTINUATION",
    marketType: "CRYPTO_SPOT",
    allowedSides: ["BUY"],
    supportedTimeframes: ["15m"],
    parameterSchema: {
      fast: { type: "integer", minimum: 2, maximum: 8, step: 1, default: 3, coarseValues: [2, 3, 4], narrowStep: 2, fineStep: 1 },
      slow: { type: "integer", minimum: 5, maximum: 12, step: 1, default: 8, coarseValues: [7, 8], narrowStep: 2, fineStep: 1 },
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
    ...overrides,
  };
}

function universe(overrides = {}) {
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
    ...overrides,
  };
}

function policies(overrides = {}) {
  return {
    search: {
      version: "search-v1",
      seed: 838,
      maxCandidatesPerFamily: 32,
      maxTotalCandidates: 128,
      coarseSurvivorsPerFamily: 2,
      narrowSurvivorsPerFamily: 2,
      fineSurvivorsPerFamily: 2,
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
    ...overrides,
  };
}

function input(overrides = {}) {
  return { codeSha: CODE_SHA, families: [family()], universe: [universe()], policies: policies(), ...overrides };
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
          netReturn: 0.15 + (request.candidate.parameters.fast / 100),
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

test("candidate identity is canonical, stable under key order, and parameter-sensitive", () => {
  const registry = buildPhase3StrategyFamilyRegistryV1([family()]);
  const first = createPhase3CandidateIdentityV1({ family: registry.families[0], universeEntry: universe(), parameters: { fast: 3, slow: 8 } });
  const reordered = createPhase3CandidateIdentityV1({ family: registry.families[0], universeEntry: universe(), parameters: { slow: 8, fast: 3 } });
  const changed = createPhase3CandidateIdentityV1({ family: registry.families[0], universeEntry: universe(), parameters: { fast: 4, slow: 8 } });
  assert.equal(first.candidateId, reordered.candidateId);
  assert.equal(first.parameterDigest, reordered.parameterDigest);
  assert.notEqual(first.candidateId, changed.candidateId);
  assert.notEqual(first.parameterDigest, changed.parameterDigest);
});

test("registry rejects unsupported and incomplete families fail closed", () => {
  assert.throws(() => buildPhase3StrategyFamilyRegistryV1([family({ status: "UNKNOWN" })]), /unsupported/u);
  assert.throws(() => buildPhase3StrategyFamilyRegistryV1([family({ backtestCompatibility: undefined })]), /required/u);
  assert.throws(() => buildPhase3StrategyFamilyRegistryV1([family({
    constraints: [{ left: "missing", operator: "LT", rightValue: 2 }],
  })]), /unknown/u);
});

test("coarse to narrow to fine search is deterministic, bounded, constrained, and de-duplicated", async () => {
  const calls = [];
  const deps = callbacks({
    async runCanonicalBacktest(request) {
      calls.push(`${request.stage}:${request.candidate.candidateId}`);
      return callbacks().runCanonicalBacktest(request);
    },
  });
  const first = await runPhase3StrategyTournamentCoreV1(input(), deps);
  const second = await runPhase3StrategyTournamentCoreV1(input(), callbacks());
  assert.equal(first.status, "COMPLETE");
  assert.deepEqual(first.stages, second.stages);
  assert.deepEqual(first.finalists.map((item) => item.candidateId), second.finalists.map((item) => item.candidateId));
  assert.equal(new Set(calls.map((call) => call.split(":").slice(1).join(":"))).size, calls.length);
  assert.ok(first.totals.uniqueGenerated <= 128);
  assert.ok(first.stages.COARSE.generated > 0);
  assert.ok(first.stages.NARROW.generated > 0);
  assert.ok(first.stages.FINE.generated >= 0);
  assert.ok(first.finalists.every((item) => item.parameters.fast < item.parameters.slow));
  assert.equal(first.observability.TOTAL_EVALUATED, first.totals.evaluated);
  assert.equal(first.observability.FINALIST_COUNT, first.finalists.length);
});

test("duplicate family/universe combinations are evaluated once and observed as deduped", async () => {
  let calls = 0;
  const result = await runPhase3StrategyTournamentCoreV1(input({ universe: [universe(), universe()] }), callbacks({
    async runCanonicalBacktest(request) {
      calls += 1;
      return callbacks().runCanonicalBacktest(request);
    },
  }));
  assert.ok(result.observability.TOTAL_DEDUPED > 0);
  assert.equal(result.totals.uniqueGenerated, calls);
  assert.equal(result.totals.evaluated, calls);
});

test("core delegates every evaluation to the canonical backtester and rejects a second-engine stamp", async () => {
  let calls = 0;
  const result = await runPhase3StrategyTournamentCoreV1(input(), callbacks({
    async runCanonicalBacktest(request) {
      calls += 1;
      const valid = await callbacks().runCanonicalBacktest(request);
      return { ...valid, executionEngine: "duplicate-pnl-engine" };
    },
  }));
  assert.ok(calls > 0);
  assert.equal(result.finalists.length, 0);
  assert.equal(result.eliminationReasonCounts.CANONICAL_BACKTEST_ENGINE_MISMATCH, calls);
});

test("hard-filter failures are never ranked and an eliminated candidate cannot re-enter", async () => {
  const result = await runPhase3StrategyTournamentCoreV1(input(), callbacks({
    async runCanonicalBacktest(request) {
      const valid = await callbacks().runCanonicalBacktest(request);
      return { ...valid, metrics: { ...valid.metrics, tradeCount: request.candidate.parameters.fast === 4 ? 0 : 40 } };
    },
  }));
  const insufficient = result.eliminations.filter((item) => item.reason === "INSUFFICIENT_TRADES").map((item) => item.candidateId);
  assert.ok(insufficient.length > 0);
  assert.ok(insufficient.every((candidateId) => !result.finalists.some((item) => item.candidateId === candidateId)));
});

test("MISSING is not coerced to ZERO in hard filters or ranking", async () => {
  const hardMissing = await runPhase3StrategyTournamentCoreV1(input(), callbacks({
    async runCanonicalBacktest(request) {
      const valid = await callbacks().runCanonicalBacktest(request);
      return { ...valid, metrics: { ...valid.metrics, profitFactor: null } };
    },
  }));
  assert.equal(hardMissing.finalists.length, 0);
  assert.ok(hardMissing.eliminationReasonCounts.HARD_FILTER_METRIC_MISSING > 0);

  const rankingMissing = await runPhase3StrategyTournamentCoreV1(input({
    policies: policies({ hardFilter: { ...policies().hardFilter, requiredMetrics: ["tradeCount", "maxDrawdown", "profitFactor"] } }),
  }), callbacks({
    async runCanonicalBacktest(request) {
      const valid = await callbacks().runCanonicalBacktest(request);
      return { ...valid, metrics: { ...valid.metrics, netReturn: null } };
    },
  }));
  assert.equal(rankingMissing.finalists.length, 0);
  assert.ok(rankingMissing.eliminationReasonCounts.RANKING_METRIC_MISSING > 0);
});

test("non-finite evidence and mismatched cost identity fail closed", async () => {
  const nonFinite = await runPhase3StrategyTournamentCoreV1(input(), callbacks({
    async runCanonicalBacktest(request) {
      const valid = await callbacks().runCanonicalBacktest(request);
      return { ...valid, metrics: { ...valid.metrics, netReturn: Number.NaN } };
    },
  }));
  assert.ok(nonFinite.eliminationReasonCounts.NON_FINITE_EVIDENCE > 0);
  const wrongCost = await runPhase3StrategyTournamentCoreV1(input(), callbacks({
    async runCanonicalBacktest(request) {
      const valid = await callbacks().runCanonicalBacktest(request);
      return { ...valid, costPolicyDigest: "wrong" };
    },
  }));
  assert.ok(wrongCost.eliminationReasonCounts.COST_POLICY_IDENTITY_MISMATCH > 0);
});

test("policy, callback, and statistical ownership gaps are terminal fail-closed boundaries", async () => {
  const noPolicy = await runPhase3StrategyTournamentCoreV1({ ...input(), policies: undefined }, callbacks());
  assert.equal(noPolicy.FIRST_ZERO, "POLICY_MISSING");
  const noBacktester = await runPhase3StrategyTournamentCoreV1(input(), { evaluateStatisticalFirewall: callbacks().evaluateStatisticalFirewall });
  assert.equal(noBacktester.FIRST_ZERO, "CANONICAL_BACKTEST_CALLBACK_MISSING");
  const noStatistics = await runPhase3StrategyTournamentCoreV1(input(), { runCanonicalBacktest: callbacks().runCanonicalBacktest });
  assert.equal(noStatistics.FIRST_ZERO, "STATISTICAL_POLICY_MISSING");
  assert.equal(noStatistics.finalists.length, 0);
});

test("TRAIN is the only permitted data role and no validation/OOS evidence enters selection", async () => {
  const leakedInput = await runPhase3StrategyTournamentCoreV1({ ...input(), validationEvidence: [] }, callbacks());
  assert.equal(leakedInput.FIRST_ZERO, "VALIDATION_OR_OOS_LEAKAGE");
  const roleLeak = await runPhase3StrategyTournamentCoreV1(input({ universe: [universe({ datasetRole: "OOS" })] }), callbacks());
  assert.equal(roleLeak.FIRST_ZERO, "VALIDATION_OR_OOS_LEAKAGE");
  const resultLeak = await runPhase3StrategyTournamentCoreV1(input(), callbacks({
    async runCanonicalBacktest(request) {
      const valid = await callbacks().runCanonicalBacktest(request);
      return { ...valid, datasetRole: "VALIDATION" };
    },
  }));
  assert.ok(resultLeak.eliminationReasonCounts.VALIDATION_OR_OOS_LEAKAGE > 0);
});

test("unsupported universe combinations and incomplete identities block discovery", async () => {
  const unsupported = await runPhase3StrategyTournamentCoreV1(input({ universe: [universe({ timeframe: "1d" })] }), callbacks());
  assert.equal(unsupported.FIRST_ZERO, "UNSUPPORTED_COMBINATION");
  const incomplete = await runPhase3StrategyTournamentCoreV1(input({ universe: [universe({ datasetIdentity: "" })] }), callbacks());
  assert.equal(incomplete.FIRST_ZERO, "INPUT_CONTRACT_INVALID");
});

test("ranking is deterministic with candidate-id tie breaking and explicit score evidence", async () => {
  const tied = callbacks({
    async runCanonicalBacktest(request) {
      const valid = await callbacks().runCanonicalBacktest(request);
      return { ...valid, metrics: { ...valid.metrics, netReturn: 0.1, maxDrawdown: 0.1 } };
    },
  });
  const result = await runPhase3StrategyTournamentCoreV1(input(), tied);
  assert.deepEqual(result.finalists.map((item) => item.candidateId), [...result.finalists.map((item) => item.candidateId)].sort());
  assert.ok(result.finalists.every((item) => item.scoreComponents.length === 2 && /^[0-9a-f]{64}$/u.test(item.scoreDigest)));
});

test("statistical firewall failures cannot become finalists", async () => {
  const result = await runPhase3StrategyTournamentCoreV1(input(), callbacks({
    async evaluateStatisticalFirewall(request) {
      return {
        status: "FAIL",
        policyDigest: request.statisticalPolicyDigest,
        candidateFamilySize: request.candidateFamilySize,
        selectionBiasRecorded: true,
      };
    },
  }));
  assert.equal(result.finalists.length, 0);
  assert.ok(result.eliminationReasonCounts.STATISTICAL_FIREWALL_FAIL > 0);
});

test("finalists are Phase-4 inputs, never profitability proofs or champions", async () => {
  const result = await runPhase3StrategyTournamentCoreV1(input(), callbacks());
  assert.ok(result.finalists.length > 0);
  assert.equal(result.PROFITABILITY_PROVEN, false);
  assert.equal(result.NET_ALPHA_PROVEN, false);
  assert.equal(result.CHAMPION, "NONE");
  assert.equal(result.phase4Handoff.candidateFreezePerformed, false);
  assert.ok(result.finalists.every((item) => item.PROFITABILITY_PROVEN === false && item.CHAMPION === "NONE"));
  assert.ok(result.finalists.every((item) => item.parameterMutationAllowed === false));
  assert.equal(result.executionRealismEvidence.credited, false);
  assert.deepEqual(result.executionRealismEvidence.observations, []);
  assert.equal(result.alphaCandidateEvidence.length, result.finalists.length);
  assert.ok(result.alphaCandidateEvidence.every((item) => item.trainBacktestResult.split === "TRAIN" && item.ranking.scoreComponents.length > 1));
  assert.equal(result.safety.executionAuthority, "NONE");
  assert.equal(result.safety.LIVE_TRADING, false);
  assert.equal(result.safety.economicCreditCreated, false);
});

test("run identity binds code, registry, universe, and every policy digest", async () => {
  const result = await runPhase3StrategyTournamentCoreV1(input(), callbacks());
  assert.match(result.tournamentRunId, /^phase3-tournament:sha256:[0-9a-f]{64}$/u);
  assert.equal(result.registryDigest, buildPhase3StrategyFamilyRegistryV1([family()]).registryDigest);
  assert.equal(Object.keys(result.policyDigests).sort().join(","), "cost,hardFilter,ranking,search,statistical");
  assert.notEqual(result.tournamentRunId, (await runPhase3StrategyTournamentCoreV1(input({ codeSha: "different-sha" }), callbacks())).tournamentRunId);
  assert.match(phase3DigestV1({ b: 2, a: 1 }), /^[0-9a-f]{64}$/u);
});
