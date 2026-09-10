import test from "node:test";
import assert from "node:assert/strict";
import { prepareMeaningfulSearchPaperCandidate } from "../src/meaningful-search-paper-bridge-v1.js";
import { wrapPaperForwardProviderWithMeaningfulSearch } from "../src/meaningful-search-scheduled-paper-provider-v1.js";

const NOW = Date.UTC(2026, 7, 20, 0, 20, 0);
const SHA = "0123456789abcdef0123456789abcdef01234567";

function baseEvidence(market = "CRYPTO_SPOT") {
  return Object.freeze({
    status: "READY",
    publicOnly: true,
    market,
    provider: "upbit-public-candles",
    provenance: Object.freeze({ provider: "upbit-public-candles", market, symbol: "BTC", timeframe: "4h" }),
    dataAsOfMs: NOW,
    observedAtMs: NOW,
    maxAgeMs: 8 * 60 * 60 * 1000,
    candidates: Object.freeze([]),
    exits: Object.freeze([]),
    blocker: null,
  });
}

function strategyIdentity() {
  return {
    strategyId: "profit-first-swing",
    strategyVersion: "v1",
    parameterHash: "params-v1",
    researchCodeSha: SHA,
  };
}

function candidate(overrides = {}) {
  const signal = {
    signalId: "spot-btc-swing-1",
    market: "CRYPTO_SPOT",
    symbol: "BTC",
    timestampMs: NOW,
    timeframe: "4h",
    horizon: 6,
    direction: "BUY",
    signalDirection: "BUY",
    regime: "TREND",
    strategyIdentity: strategyIdentity(),
  };
  const value = {
    signal,
    paperIdentity: {
      signalId: signal.signalId,
      strategyId: signal.strategyIdentity.strategyId,
      strategyVersion: signal.strategyIdentity.strategyVersion,
      parameterHash: signal.strategyIdentity.parameterHash,
      market: signal.market,
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      horizon: signal.horizon,
      direction: signal.signalDirection,
      regime: signal.regime,
      costPolicyVersion: "paper-cost-policy-v1",
      researchCodeSha: SHA,
      executionAuthority: "NONE",
    },
    profitEvidence: {
      status: "READY",
      costPolicyId: "paper-cost-policy-v1",
      executionAuthority: "NONE",
    },
    execution: {
      costPolicy: { version: "paper-cost-policy-v1" },
    },
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    ...overrides,
  };
  return Object.freeze(value);
}

function canonicalExitCandidate() {
  const signalId = "spot-btc-exit-1";
  const identity = strategyIdentity();
  const decision = prepareMeaningfulSearchPaperCandidate({
    searchOutcome: "TRADE_CANDIDATES",
    candidate: {
      signal: {
        signalId,
        market: "CRYPTO_SPOT",
        symbol: "BTC",
        timestampMs: NOW - 2,
        lifecycle: "ACTIVE",
        style: "SWING",
        timeframe: "4h",
        horizon: 6,
        direction: "SELL",
        positionSide: "LONG",
        regime: "TREND",
        strategyIdentity: identity,
        learningSnapshot: {
          signalId,
          market: "CRYPTO_SPOT",
          symbol: "BTC",
          strategyHorizon: "SWING",
          direction: "SELL",
          strategyProfileVersion: "v1",
          timeframes: ["4h"],
          marketRegime: "TREND",
        },
      },
      riskEvidence: {
        status: "APPROVED",
        simulatedOnly: true,
        evaluatedAtMs: NOW - 1,
      },
      execution: {
        strategyIdentity: identity,
        costPolicy: { version: "paper-cost-policy-v1" },
        dataEvidence: {
          dataQuality: "READY",
          asOfMs: NOW - 1,
          maxAgeMs: 60_000,
        },
      },
      executionAuthority: "NONE",
      simulatedOnly: true,
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      orderSubmitted: false,
      exchangeRequestSent: false,
    },
  });

  assert.equal(decision.status, "PAPER_EXIT_SIGNAL");
  assert.equal(decision.candidate.executionIntent, "EXIT");
  assert.equal(decision.candidate.profitEvidence, undefined);
  return decision.candidate;
}

function runtime({
  status = "PAPER_CANDIDATES_READY",
  candidates = [candidate()],
  exits = [],
  outcome = "TRADE_CANDIDATES",
  naturalMetadata = {},
} = {}) {
  return Object.freeze({
    market: "CRYPTO_SPOT",
    status,
    search: Object.freeze({ outcome }),
    bridgeEligibleCandidates: candidates.length,
    paperBridge: Object.freeze({ candidates: Object.freeze(candidates), exitSignals: Object.freeze(exits), exits: exits.length }),
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    ...naturalMetadata,
  });
}

function exitConditionObservation(value, requirementsSatisfied) {
  return Object.freeze({
    schemaVersion: "canonical-paper-exit-condition-evidence-v1",
    status: "MEASURED",
    exitEvaluationCount: 1,
    observations: Object.freeze([Object.freeze({
      status: "MEASURED",
      observationId: value.signal.signalId,
      evaluated: true,
      requirementsSatisfied,
      executionIntent: requirementsSatisfied ? "EXIT" : "NONE",
      sourceCode: requirementsSatisfied ? "EXIT_REQUIREMENTS_SATISFIED" : "EXIT_REQUIREMENTS_NOT_SATISFIED",
      sourceReason: requirementsSatisfied ? "LONG_EXIT" : "ENTRY_ONLY",
      provenance: "exit-condition-fixture",
      observedAt: NOW,
      paperIdentity: value.paperIdentity,
      naturalCredit: 0,
      replayCredit: 0,
      duplicateCredit: 0,
    })]),
  });
}

function openPositionFor(value) {
  return Object.freeze({
    positionId: "position-1",
    market: value.paperIdentity.market,
    strategyId: value.paperIdentity.strategyId,
    strategyVersion: value.paperIdentity.strategyVersion,
    parameterHash: value.paperIdentity.parameterHash,
    researchCodeSha: value.paperIdentity.researchCodeSha,
    costPolicyVersion: value.paperIdentity.costPolicyVersion,
    sample: Object.freeze({
      identity: Object.freeze({
        market: value.paperIdentity.market,
        symbol: value.paperIdentity.symbol,
        timeframe: value.paperIdentity.timeframe,
        horizon: value.paperIdentity.horizon,
        strategyId: value.paperIdentity.strategyId,
        strategyVersion: value.paperIdentity.strategyVersion,
        parameterHash: value.paperIdentity.parameterHash,
        researchCodeSha: value.paperIdentity.researchCodeSha,
      }),
      profitEvidence: Object.freeze({ costPolicyId: value.paperIdentity.costPolicyVersion }),
    }),
  });
}

function naturalMetadata() {
  const datasetIdentity = "natural-dataset-identity-1";
  return Object.freeze({
    naturalFunnelMeasurements: Object.freeze([
      Object.freeze({ stage: "CANDIDATE", status: "MEASURED", count: 2, blocker: null }),
      Object.freeze({ stage: "EVIDENCE_COMPLETE", status: "MEASURED", count: 0, blocker: null }),
    ]),
    naturalFirstZeroStage: "EVIDENCE_COMPLETE",
    naturalFirstZeroReason: "MEASURED_ZERO",
    naturalEvidenceIdentity: datasetIdentity,
    naturalRuntimeSha: SHA,
    authoritativeFirstZeroReasonEvidenceByStage: Object.freeze({
      EVIDENCE_COMPLETE: Object.freeze({
        authoritative: true,
        freshness: "FRESH",
        reasonCode: "P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING",
        strategySha: SHA,
        runtimeSha: SHA,
        datasetIdentity,
        synthetic: false,
        historical: false,
        replay: false,
      }),
    }),
  });
}

function assertNaturalMetadataPreserved(source, expected) {
  assert.deepEqual(source.naturalFunnelMeasurements, expected.naturalFunnelMeasurements);
  assert.equal(source.naturalFirstZeroStage, expected.naturalFirstZeroStage);
  assert.equal(source.naturalFirstZeroReason, expected.naturalFirstZeroReason);
  assert.equal(source.naturalEvidenceIdentity, expected.naturalEvidenceIdentity);
  assert.equal(source.naturalRuntimeSha, expected.naturalRuntimeSha);
  assert.deepEqual(
    source.authoritativeFirstZeroReasonEvidenceByStage,
    expected.authoritativeFirstZeroReasonEvidenceByStage,
  );
}

test("scheduled provider attaches canonical eligible Paper candidates without execution authority", async () => {
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: { collectPublicEvidence: async ({ market }) => baseEvidence(market) },
    paperRuntimeForMarket: async () => runtime(),
  });

  const result = await provider.collectPublicEvidence({ market: "CRYPTO_SPOT", cycle: { cycleId: "cycle-1" } });
  assert.equal(result.status, "READY");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].signal.signalId, "spot-btc-swing-1");
  assert.equal(result.candidates[0].paperIdentity.researchCodeSha, SHA);
  assert.equal(result.paperCandidateSource.status, "PAPER_CANDIDATES_READY");
  assert.equal(result.paperCandidateSource.eligibleCandidates, 1);
  assert.equal(result.blocker, null);
});

test("scheduled provider preserves authoritative Natural FIRST_ZERO metadata on READY runtime", async () => {
  const expected = naturalMetadata();
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: { collectPublicEvidence: async ({ market }) => baseEvidence(market) },
    paperRuntimeForMarket: async () => runtime({ naturalMetadata: expected }),
  });

  const result = await provider.collectPublicEvidence({ market: "CRYPTO_SPOT", cycle: { cycleId: "cycle-natural-ready" } });
  assert.equal(result.status, "READY");
  assertNaturalMetadataPreserved(result.paperCandidateSource, expected);
  assert.equal(result.paperCandidateSource.authoritativeFirstZeroReasonEvidenceByStage.EVIDENCE_COMPLETE.authoritative, true);
});

test("scheduled provider preserves authoritative Natural FIRST_ZERO metadata on BLOCKED runtime", async () => {
  const expected = naturalMetadata();
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: { collectPublicEvidence: async ({ market }) => baseEvidence(market) },
    paperRuntimeForMarket: async () => runtime({
      status: "SEARCH_FAILURE_BLOCKED",
      candidates: [],
      outcome: "SEARCH_FAILURE",
      naturalMetadata: expected,
    }),
  });

  const result = await provider.collectPublicEvidence({ market: "CRYPTO_SPOT", cycle: { cycleId: "cycle-natural-blocked" } });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.blocker, "SEARCH_FAILURE");
  assertNaturalMetadataPreserved(result.paperCandidateSource, expected);
});

test("ENTRY still requires Profit-First cost evidence", async () => {
  const missingProfitEvidence = candidate({ profitEvidence: undefined });
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: { collectPublicEvidence: async ({ market }) => baseEvidence(market) },
    paperRuntimeForMarket: async () => runtime({ candidates: [missingProfitEvidence] }),
  });

  const result = await provider.collectPublicEvidence({ market: "CRYPTO_SPOT" });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.match(result.blocker, /PAPER_CANDIDATE_COST_POLICY_MISMATCH/);
  assert.equal(result.candidates.length, 0);
});

test("canonical EXIT keeps exact identity without requiring entry-only ProfitEvidence", async () => {
  const exit = canonicalExitCandidate();
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: { collectPublicEvidence: async ({ market }) => baseEvidence(market) },
    paperRuntimeForMarket: async () => runtime({ candidates: [], exits: [exit] }),
  });

  const result = await provider.collectPublicEvidence({ market: "CRYPTO_SPOT" });
  assert.equal(result.status, "READY");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.exits.length, 1);
  assert.equal(result.exits[0].signal.signalId, "spot-btc-exit-1");
  assert.equal(result.exits[0].executionIntent, "EXIT");
  assert.equal(result.exits[0].paperIdentity.costPolicyVersion, "paper-cost-policy-v1");
  assert.equal(result.exits[0].paperIdentity.researchCodeSha, SHA);
  assert.equal(result.exits[0].profitEvidence, undefined);
  assert.equal(result.blocker, null);
});

test("exit condition evaluation without an open-position match is measured but not exitEligible", async () => {
  const exit = canonicalExitCandidate();
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: { collectPublicEvidence: async ({ market }) => baseEvidence(market) },
    paperRuntimeForMarket: async () => runtime({
      candidates: [],
      exits: [exit],
      naturalMetadata: { exitConditionEvidence: exitConditionObservation(exit, true) },
    }),
  });

  const result = await provider.collectPublicEvidence({ market: "CRYPTO_SPOT", openPositions: [] });
  const evidence = result.paperCandidateSource.exitEligibilityEvidence;
  assert.equal(evidence.status, "MEASURED");
  assert.equal(evidence.exitEvaluationCount, 1);
  assert.equal(evidence.matchedOpenPositionCount, 0);
  assert.equal(evidence.exitEligibleCount, 0);
  assert.equal(evidence.reasonObservations[0].sourceCode, "OPEN_POSITION_NOT_MATCHED");
});

test("matching open position remains non-eligible when exit requirements are not satisfied", async () => {
  const entryOnly = candidate();
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: { collectPublicEvidence: async ({ market }) => baseEvidence(market) },
    paperRuntimeForMarket: async () => runtime({
      candidates: [entryOnly],
      exits: [],
      naturalMetadata: { exitConditionEvidence: exitConditionObservation(entryOnly, false) },
    }),
  });

  const result = await provider.collectPublicEvidence({
    market: "CRYPTO_SPOT",
    openPositions: [openPositionFor(entryOnly)],
  });
  const evidence = result.paperCandidateSource.exitEligibilityEvidence;
  assert.equal(evidence.exitEvaluationCount, 1);
  assert.equal(evidence.matchedOpenPositionCount, 1);
  assert.equal(evidence.exitEligibleCount, 0);
  assert.equal(evidence.observations[0].matchedPositionId, "position-1");
});

test("exitEligible requires both satisfied exit requirements and one exact open-position match", async () => {
  const exit = canonicalExitCandidate();
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: { collectPublicEvidence: async ({ market }) => baseEvidence(market) },
    paperRuntimeForMarket: async () => runtime({
      candidates: [],
      exits: [exit],
      naturalMetadata: { exitConditionEvidence: exitConditionObservation(exit, true) },
    }),
  });

  const result = await provider.collectPublicEvidence({
    market: "CRYPTO_SPOT",
    openPositions: [openPositionFor(exit)],
  });
  const evidence = result.paperCandidateSource.exitEligibilityEvidence;
  assert.equal(evidence.exitEvaluationCount, 1);
  assert.equal(evidence.matchedOpenPositionCount, 1);
  assert.equal(evidence.exitEligibleCount, 1);
  assert.equal(evidence.observations[0].exitEligible, true);
});

test("EXIT still blocks cost-policy identity mismatch", async () => {
  const exit = structuredClone(canonicalExitCandidate());
  exit.paperIdentity.costPolicyVersion = "wrong-cost-policy";
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: { collectPublicEvidence: async ({ market }) => baseEvidence(market) },
    paperRuntimeForMarket: async () => runtime({ candidates: [], exits: [exit] }),
  });

  const result = await provider.collectPublicEvidence({ market: "CRYPTO_SPOT" });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.match(result.blocker, /PAPER_CANDIDATE_COST_POLICY_MISMATCH/);
  assert.equal(result.exits.length, 0);
});

test("VALID_NO_TRADE remains a successful zero-candidate scheduled cycle", async () => {
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: { collectPublicEvidence: async ({ market }) => baseEvidence(market) },
    paperRuntimeForMarket: async () => runtime({ status: "VALID_NO_TRADE", candidates: [], outcome: "VALID_NO_TRADE" }),
  });

  const result = await provider.collectPublicEvidence({ market: "CRYPTO_SPOT" });
  assert.equal(result.status, "READY");
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.exits, []);
  assert.equal(result.paperCandidateSource.status, "VALID_NO_TRADE");
});

test("SEARCH_FAILURE fails closed before scheduled Paper mutation", async () => {
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: { collectPublicEvidence: async ({ market }) => baseEvidence(market) },
    paperRuntimeForMarket: async () => runtime({ status: "SEARCH_FAILURE_BLOCKED", candidates: [], outcome: "SEARCH_FAILURE" }),
  });

  const result = await provider.collectPublicEvidence({ market: "CRYPTO_SPOT" });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.blocker, "SEARCH_FAILURE");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.paperCandidateSource.searchOutcome, "SEARCH_FAILURE");
});

test("authoritative source blockers stay observable instead of collapsing to a measured Scanner zero", async () => {
  const admissionBlockers = Object.freeze([
    "AUTHORITATIVE_SCANNER_BATCH_SOURCE_UNAVAILABLE",
    "AUTHORITATIVE_PAPER_STATE_SOURCE_UNAVAILABLE",
  ]);
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: { collectPublicEvidence: async ({ market }) => baseEvidence(market) },
    paperRuntimeForMarket: async () => Object.freeze({
      ...runtime({ status: "AUTHORITATIVE_RECURRING_SOURCE_WIRING_BLOCKED", candidates: [], outcome: "SEARCH_FAILURE" }),
      admissionBlockers,
    }),
  });

  const result = await provider.collectPublicEvidence({ market: "CRYPTO_SPOT" });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.blocker, admissionBlockers.join("|"));
  assert.deepEqual(result.candidates, []);
  assert.equal(result.paperCandidateSource.status, "AUTHORITATIVE_RECURRING_SOURCE_WIRING_BLOCKED");
});

test("identity mismatch is blocked instead of being silently admitted", async () => {
  const bad = candidate({ paperIdentity: { ...candidate().paperIdentity, parameterHash: "wrong" } });
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: { collectPublicEvidence: async ({ market }) => baseEvidence(market) },
    paperRuntimeForMarket: async () => runtime({ candidates: [bad] }),
  });

  const result = await provider.collectPublicEvidence({ market: "CRYPTO_SPOT" });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.match(result.blocker, /PAPER_CANDIDATE_PARAMETER_HASH_MISMATCH/);
  assert.equal(result.candidates.length, 0);
});

test("base provider failure short-circuits scanner candidate collection", async () => {
  let calls = 0;
  const provider = wrapPaperForwardProviderWithMeaningfulSearch({
    provider: {
      collectPublicEvidence: async () => Object.freeze({
        ...baseEvidence(),
        status: "BLOCKED_DATA",
        blocker: "STALE_EVIDENCE",
      }),
    },
    paperRuntimeForMarket: async () => {
      calls += 1;
      return runtime();
    },
  });

  const result = await provider.collectPublicEvidence({ market: "CRYPTO_SPOT" });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.blocker, "STALE_EVIDENCE");
  assert.equal(calls, 0);
});
