import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { FOUR_MARKET_EXECUTION_PROFILES } from "../src/four-market-execution-v2.js";
import { createFilePaperLearningStore } from "../src/paper-forward-persistent-learning-store-v1.js";
import {
  readPaperForwardScheduleSnapshot,
  runPaperForwardScheduledInvocation,
} from "../src/paper-forward-schedule-runtime-v1.js";

const RESEARCH_SHA = "a".repeat(40);
const MARKETS = ["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"];
const T0 = 1_800_000_000_000;

function spotCandidate(nowMs) {
  const profile = FOUR_MARKET_EXECUTION_PROFILES.CRYPTO_SPOT;
  const strategyIdentity = {
    strategyId: "scanner-swing-v7",
    strategyVersion: "7.0.0",
    parameterHash: "scanner-params-v7",
    researchCodeSha: RESEARCH_SHA,
  };
  return {
    signal: {
      signalId: "paper-forward-spot-1",
      market: "CRYPTO_SPOT",
      symbol: "BTC",
      timestampMs: nowMs - 2_000,
      style: "SWING",
      timeframe: "1h",
      horizon: 4,
      direction: "BUY",
      strategyIdentity,
      learningSnapshot: {
        signalId: "paper-forward-spot-1",
        timestamp: new Date(nowMs - 2_000).toISOString(),
        market: "CRYPTO_SPOT",
        symbol: "BTC",
        symbolName: null,
        strategyHorizon: "SWING",
        direction: "BUY",
        signalScore: 75,
        displayConfidence: null,
        referencePrice: 100,
        entryPrice: 100,
        stopLoss: null,
        target1: null,
        target2: null,
        riskReward: null,
        timeframes: ["1h"],
        strategyProfileVersion: strategyIdentity.strategyVersion,
        indicatorSnapshot: {},
        indicatorScores: {},
        patternSnapshot: {},
        volumeContext: {},
        volatilityContext: {},
        trendContext: {},
        marketRegime: "UNKNOWN",
        liquidityContext: {},
        aiValidatorResult: null,
        riskEngineResult: null,
        dataProvenance: ["upbit-public"],
        dataTimestamp: new Date(nowMs - 3_000).toISOString(),
        immutable: true,
        executionAuthority: "NONE",
      },
    },
    riskEvidence: { status: "APPROVED", evaluatedAtMs: nowMs - 1_000, simulatedOnly: true },
    profitGate: { decision: "ELIGIBLE", eligible: true, reasons: [], executionAuthority: "NONE" },
    profitEvidence: {
      status: "READY",
      expectedNetEdge: 0.01,
      expectedNetReturn: 0.01,
      riskRewardRatio: 1.5,
      sampleSize: 30,
      costPolicyId: "scanner-cost-v1",
      executionAuthority: "NONE",
    },
    execution: {
      marketAdapterIdentity: profile.marketAdapter,
      strategyIdentity,
      costPolicy: {
        version: "scanner-cost-v1",
        commissionRate: 0.001,
        taxRate: 0,
        spreadRate: 0,
        slippageRate: 0,
        latencyRate: 0,
        liquidityImpactRate: 0,
        partialFillImpactRate: 0,
        fundingRate: 0,
      },
      executionPolicy: {
        version: "scanner-paper-execution-v1",
        fillModel: "TOP_OF_BOOK",
        sameBarPolicy: "STOP_FIRST",
        allowPartialFill: true,
        maxParticipationRate: 1,
      },
      dataEvidence: {
        provider: "upbit",
        publicOnly: true,
        dataQuality: "READY",
        provenance: "upbit-public",
        asOfMs: nowMs - 1_000,
        maxAgeMs: 60_000,
        marketStatus: "TRADABLE",
        tickSize: 1,
        minOrderNotional: 5_000,
        quoteEvidence: {
          available: true,
          bid: 99,
          ask: 100,
          asOfMs: nowMs - 1_000,
          maxAgeMs: 60_000,
        },
      },
    },
    order: { type: "MARKET", quantity: 100, direction: "BUY" },
    quote: {
      bid: 99,
      ask: 100,
      bidSize: 1_000,
      askSize: 1_000,
      asOfMs: nowMs - 1_000,
      maxAgeMs: 60_000,
    },
  };
}

function provider(nowMs, calls) {
  return Object.freeze({
    async collectPublicEvidence({ market }) {
      calls.count += 1;
      return Object.freeze({
        status: "READY",
        publicOnly: true,
        market,
        provider: `test-public-${market.toLowerCase()}`,
        provenance: Object.freeze({ provider: "test", market }),
        observedAtMs: nowMs - 1_000,
        dataAsOfMs: nowMs - 1_000,
        maxAgeMs: 60_000,
        candidates: Object.freeze(market === "CRYPTO_SPOT" ? [spotCandidate(nowMs)] : []),
        exits: Object.freeze([]),
        blocker: null,
      });
    },
  });
}

test("explicit simulated outcome mode persists an OPEN candidate and learning record without live authority", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "paper-forward-sim-outcome-"));
  const root = join(sandbox, "persistent-state");
  let nowMs = T0;
  const calls = { count: 0 };
  try {
    const first = await runPaperForwardScheduledInvocation({
      rootDirectory: root,
      researchCodeSha: RESEARCH_SHA,
      triggerSource: "cron",
      activationAtMs: nowMs - 10_000,
      ownerId: "test-owner:first",
      clock: () => nowMs,
      publicEvidenceProvider: provider(nowMs, calls),
      outcomeAccumulationEnabled: true,
    });

    assert.equal(first.status, "COMPLETED");
    assert.equal(first.summary.entries, 1);
    assert.equal(first.summary.openPositions, 1);
    assert.equal(first.persistedStatus.paperTradeOutcomeAccumulationEnabled, true);
    assert.equal(first.persistedStatus.paperTradeOutcomeAccumulating, false);
    assert.equal(first.persistedStatus.simulatedFinancialAdaptersEnabled, true);
    assert.equal(first.persistedStatus.externalFinancialMutationAllowed, false);
    assert.equal(first.invocation.privateRequestCount, 0);
    assert.equal(first.invocation.orderCount, 0);
    assert.equal(first.invocation.financialMutationCount, 0);
    assert.equal(first.invocation.liveTrading, false);
    assert.equal(first.invocation.orderAuthority, false);
    assert.equal(calls.count, MARKETS.length);

    const learningStore = createFilePaperLearningStore({ directory: join(root, "learning") });
    const learned = await learningStore.snapshot();
    assert.equal(learned.length, 1);
    assert.equal(learned[0].key, "paper-signal:paper-forward-spot-1");
    assert.equal(learned[0].value.market, "CRYPTO_SPOT");
    assert.equal(learned[0].value.strategyId, "scanner-swing-v7");

    const snapshot = await readPaperForwardScheduleSnapshot(root);
    assert.equal(snapshot.positionCount, 1);
    assert.equal(snapshot.settlementCount, 0);

    nowMs += 60_000;
    const replay = await runPaperForwardScheduledInvocation({
      rootDirectory: root,
      researchCodeSha: RESEARCH_SHA,
      triggerSource: "cron",
      activationAtMs: T0 - 10_000,
      ownerId: "test-owner:replay",
      clock: () => nowMs,
      publicEvidenceProvider: provider(nowMs, calls),
      outcomeAccumulationEnabled: true,
    });
    assert.equal(replay.status, "REPLAYED");
    assert.equal(replay.mutationCount, 0);
    assert.equal(calls.count, MARKETS.length);
    assert.equal((await learningStore.snapshot()).length, 1);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("simulated outcome mode is explicit and observation-only mode remains fail closed", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "paper-forward-observation-only-"));
  const root = join(sandbox, "persistent-state");
  const calls = { count: 0 };
  try {
    await assert.rejects(
      runPaperForwardScheduledInvocation({
        rootDirectory: root,
        researchCodeSha: RESEARCH_SHA,
        triggerSource: "cron",
        activationAtMs: T0 - 10_000,
        ownerId: "test-owner:default",
        clock: () => T0,
        publicEvidenceProvider: provider(T0, calls),
      }),
      (error) => error?.code === "PAPER_FORWARD_FINANCIAL_MUTATION_DISABLED",
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
