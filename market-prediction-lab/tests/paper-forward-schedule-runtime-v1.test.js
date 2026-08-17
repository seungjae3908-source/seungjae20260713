import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  __paperForwardScheduleTestables,
  readPaperForwardScheduleSnapshot,
  runPaperForwardScheduledInvocation,
} from "../src/paper-forward-schedule-runtime-v1.js";

const RESEARCH_SHA = "a".repeat(40);
const MARKETS = ["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"];

function readyProvider(nowMs) {
  return Object.freeze({
    async collectPublicEvidence({ market }) {
      return Object.freeze({
        status: "READY",
        publicOnly: true,
        market,
        provider: `test-public-${market.toLowerCase()}`,
        provenance: Object.freeze({ provider: "test", market }),
        observedAtMs: nowMs - 1_000,
        dataAsOfMs: nowMs - 1_000,
        maxAgeMs: 60_000,
        candidates: Object.freeze([]),
        exits: Object.freeze([]),
        blocker: null,
      });
    },
  });
}

test("natural cron invocation persists one canonical 4h cycle and active status", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "paper-forward-schedule-"));
  const root = join(sandbox, "persistent-state");
  const nowMs = 1_800_000_000_000;
  const clock = () => nowMs;
  try {
    const first = await runPaperForwardScheduledInvocation({
      rootDirectory: root,
      researchCodeSha: RESEARCH_SHA,
      triggerSource: "cron",
      activationAtMs: nowMs - 10_000,
      ownerId: "test-owner:first",
      clock,
      publicEvidenceProvider: readyProvider(nowMs),
    });

    assert.equal(first.status, "COMPLETED");
    assert.equal(first.mutationCount, 1);
    assert.equal(first.invocation.naturalScheduleInvocation, true);
    assert.equal(first.invocation.newPublicEvidenceAccepted, true);
    assert.equal(first.invocation.publicForwardEvidenceAccumulating, true);
    assert.equal(first.invocation.paperTradeOutcomeAccumulating, false);
    assert.equal(first.persistedStatus.scheduleActive, true);
    assert.equal(first.persistedStatus.allProvidersReady, true);
    assert.equal(first.persistedStatus.privateRequestCount, 0);
    assert.equal(first.persistedStatus.orderCount, 0);
    assert.equal(first.invocation.providerLanes.length, MARKETS.length);
    assert.deepEqual(first.invocation.providerLanes.map((lane) => lane.market), MARKETS);

    const persistedState = JSON.parse(await readFile(
      join(root, "state", "recurring-paper-loop.json"),
      "utf8",
    ));
    assert.equal(persistedState.cycles.length, 1);
    assert.equal(persistedState.positions.length, 0);
    assert.equal(persistedState.settlements.length, 0);
    assert.equal(persistedState.liveOrderAllowed, false);
    assert.equal(persistedState.privateTradingApiAllowed, false);

    const snapshot = await readPaperForwardScheduleSnapshot(root);
    assert.equal(snapshot.scheduleActive, true);
    assert.equal(snapshot.stateCycleCount, 1);
    assert.equal(snapshot.lastInvocation.status, "COMPLETED");
    assert.equal(snapshot.lastInvocation.privateRequestCount, 0);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("same 4h cycle replays without provider calls or duplicate mutation", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "paper-forward-replay-"));
  const root = join(sandbox, "persistent-state");
  let nowMs = 1_800_000_000_000;
  let providerCalls = 0;
  const provider = Object.freeze({
    async collectPublicEvidence({ market }) {
      providerCalls += 1;
      return {
        status: "READY",
        publicOnly: true,
        market,
        provider: "test-public",
        observedAtMs: nowMs - 1_000,
        dataAsOfMs: nowMs - 1_000,
        maxAgeMs: 60_000,
        candidates: [],
        exits: [],
      };
    },
  });
  const clock = () => nowMs;
  try {
    const first = await runPaperForwardScheduledInvocation({
      rootDirectory: root,
      researchCodeSha: RESEARCH_SHA,
      triggerSource: "cron",
      activationAtMs: nowMs - 10_000,
      ownerId: "test-owner:first",
      clock,
      publicEvidenceProvider: provider,
    });
    assert.equal(first.status, "COMPLETED");
    assert.equal(providerCalls, 4);

    nowMs += 60_000;
    const second = await runPaperForwardScheduledInvocation({
      rootDirectory: root,
      researchCodeSha: RESEARCH_SHA,
      triggerSource: "cron",
      activationAtMs: nowMs - 70_000,
      ownerId: "test-owner:second",
      clock,
      publicEvidenceProvider: provider,
    });
    assert.equal(second.status, "REPLAYED");
    assert.equal(second.mutationCount, 0);
    assert.equal(providerCalls, 4);
    assert.equal(second.persistedStatus.allProvidersReady, true);
    assert.equal(second.persistedStatus.lanes.every((lane) => lane.status === "READY"), true);
    assert.equal(second.invocation.newPublicEvidenceAccepted, false);
    assert.equal(second.invocation.publicForwardEvidenceAccumulating, true);

    const persistedState = JSON.parse(await readFile(
      join(root, "state", "recurring-paper-loop.json"),
      "utf8",
    ));
    assert.equal(persistedState.cycles.length, 1);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("disable sentinel blocks direct runtime invocation before provider collection", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "paper-forward-disabled-"));
  const root = join(sandbox, "persistent-state");
  const nowMs = 1_800_000_000_000;
  let providerCalls = 0;
  try {
    await writeFile(join(root, "DISABLED"), "", { mode: 0o600, flag: "wx" }).catch(async (error) => {
      if (error?.code !== "ENOENT") throw error;
      await import("node:fs/promises").then(({ mkdir }) => mkdir(root, { recursive: true, mode: 0o700 }));
      await writeFile(join(root, "DISABLED"), "", { mode: 0o600, flag: "wx" });
    });
    await assert.rejects(
      runPaperForwardScheduledInvocation({
        rootDirectory: root,
        researchCodeSha: RESEARCH_SHA,
        triggerSource: "cron",
        activationAtMs: nowMs - 10_000,
        ownerId: "test-owner:disabled",
        clock: () => nowMs,
        publicEvidenceProvider: {
          async collectPublicEvidence() {
            providerCalls += 1;
            throw new Error("must not collect while disabled");
          },
        },
      }),
      (error) => error?.code === "PAPER_FORWARD_SCHEDULE_DISABLED",
    );
    assert.equal(providerCalls, 0);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("financial adapters fail closed if a future candidate path attempts mutation", async () => {
  const { ledgerAdapter, learningAdapter } = __paperForwardScheduleTestables.failClosedFinancialAdapters();
  await assert.rejects(
    ledgerAdapter.applyEntry({}),
    (error) => error?.code === "PAPER_FORWARD_FINANCIAL_MUTATION_DISABLED",
  );
  await assert.rejects(
    ledgerAdapter.applySettlement({}),
    (error) => error?.code === "PAPER_FORWARD_FINANCIAL_MUTATION_DISABLED",
  );
  await assert.rejects(
    learningAdapter.persistSignal({}),
    (error) => error?.code === "PAPER_FORWARD_FINANCIAL_MUTATION_DISABLED",
  );
  await assert.rejects(
    learningAdapter.persistOutcome({}),
    (error) => error?.code === "PAPER_FORWARD_FINANCIAL_MUTATION_DISABLED",
  );
});

test("state root cannot be relative or inside the live deploy tree", () => {
  assert.throws(
    () => __paperForwardScheduleTestables.assertRootDirectory("relative/path"),
    /absolute Paper Forward state root/u,
  );
  assert.throws(
    () => __paperForwardScheduleTestables.assertRootDirectory("/opt/stock-app/state"),
    /outside the deploy source tree/u,
  );
});

const SIM_T0 = 1_800_000_000_000;

function simulatedSpotCandidate(nowMs) {
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
      marketAdapterIdentity: Object.freeze({ id: "crypto-spot-upbit-execution", version: "v2" }),
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

function simulatedProvider(nowMs, calls) {
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
        candidates: Object.freeze(market === "CRYPTO_SPOT" ? [simulatedSpotCandidate(nowMs)] : []),
        exits: Object.freeze([]),
        blocker: null,
      });
    },
  });
}

test("explicit simulated outcome mode persists an OPEN candidate and learning record without live authority", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "paper-forward-sim-outcome-"));
  const root = join(sandbox, "persistent-state");
  let nowMs = SIM_T0;
  const calls = { count: 0 };
  try {
    const first = await runPaperForwardScheduledInvocation({
      rootDirectory: root,
      researchCodeSha: RESEARCH_SHA,
      triggerSource: "cron",
      activationAtMs: nowMs - 10_000,
      ownerId: "test-owner:simulated-first",
      clock: () => nowMs,
      publicEvidenceProvider: simulatedProvider(nowMs, calls),
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

    const { createFilePaperLearningStore } = await import("../src/paper-forward-persistent-learning-store-v1.js");
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
      activationAtMs: SIM_T0 - 10_000,
      ownerId: "test-owner:simulated-replay",
      clock: () => nowMs,
      publicEvidenceProvider: simulatedProvider(nowMs, calls),
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
        activationAtMs: SIM_T0 - 10_000,
        ownerId: "test-owner:default",
        clock: () => SIM_T0,
        publicEvidenceProvider: simulatedProvider(SIM_T0, calls),
      }),
      (error) => error?.code === "PAPER_FORWARD_FINANCIAL_MUTATION_DISABLED",
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
