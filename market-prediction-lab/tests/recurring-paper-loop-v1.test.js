import assert from "node:assert/strict";
import test from "node:test";
import {
  createRecurringPaperLoopState,
  restoreRecurringPaperLoopState,
  runRecurringPaperCycle,
  serializeRecurringPaperLoopState,
} from "../src/recurring-paper-loop-v1.js";
import { FOUR_MARKET_EXECUTION_PROFILES } from "../src/four-market-execution-v2.js";

const T0 = 1_800_000_000_000;
const SHA = "a".repeat(40);
const identity = Object.freeze({
  strategyId: "profit-first-v1",
  strategyVersion: "v1",
  parameterHash: "params-v1",
  researchCodeSha: SHA,
  costPolicyVersion: "cost-v1",
  executionPolicyVersion: "execution-v1",
});

function ledger(status = "READY") {
  return {
    status,
    initialCapitalKrw: 1_000_000,
    baseCurrency: "KRW",
    knownEquityKrw: 1_000_000,
    totalEquityKrw: status === "READY" ? 1_000_000 : null,
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

function execution(market, now = T0, overrides = {}) {
  const profile = FOUR_MARKET_EXECUTION_PROFILES[market];
  const common = {
    marketAdapterIdentity: profile.marketAdapter,
    strategyIdentity: identity,
    costPolicy: {
      version: "cost-v1", commissionRate: 0.001, taxRate: 0, spreadRate: 0,
      slippageRate: 0, latencyRate: 0, liquidityImpactRate: 0,
      partialFillImpactRate: 0, fundingRate: 0,
    },
    executionPolicy: {
      version: "execution-v1", fillModel: "TOP_OF_BOOK", sameBarPolicy: "STOP_FIRST",
      allowPartialFill: true, maxParticipationRate: 1,
    },
    dataEvidence: {
      provider: profile.provider, publicOnly: true, dataQuality: "READY", provenance: "public-fixture",
      asOfMs: now - 1, maxAgeMs: 60_000, quoteEvidence: { available: true, bid: 99, ask: 100, asOfMs: now - 1, maxAgeMs: 60_000 },
    },
  };
  if (market === "KR_STOCK") Object.assign(common.dataEvidence, { tickSize: 1, taxPolicyKnown: true, session: { version: "krx-v1", status: "OPEN" }, volatilityInterruptionKnown: true, volatilityInterruptionActive: false });
  if (market === "US_STOCK") Object.assign(common.dataEvidence, { tickSize: 0.01, taxPolicyKnown: true, session: { version: "us-v1", status: "OPEN", kind: "REGULAR" } });
  if (market === "CRYPTO_SPOT") Object.assign(common.dataEvidence, { marketStatus: "TRADABLE", tickSize: 1, minOrderNotional: 5_000 });
  if (market === "CRYPTO_FUTURES") Object.assign(common.dataEvidence, { contractStatus: "TRADABLE", tickSize: 0.1, minQty: 0.001, qtyStep: 0.001, markPrice: 100, indexPrice: 100, fundingRate: 0, openInterest: 1, leverage: 2, maxLeverage: 20, marginMode: "ISOLATED", liquidationDistancePct: 20 });
  return { ...common, ...overrides, dataEvidence: { ...common.dataEvidence, ...(overrides.dataEvidence ?? {}) } };
}

function candidate(market, id, decision = "ELIGIBLE", direction = market === "CRYPTO_FUTURES" ? "LONG" : "BUY", now = T0) {
  return {
    signal: { signalId: id, market, symbol: `${market}:${id}`, timestampMs: now - 2, style: "SWING", timeframe: "1h", horizon: 4, direction, strategyIdentity: identity },
    riskEvidence: { status: "APPROVED", evaluatedAtMs: now - 1, simulatedOnly: true },
    profitGate: { decision, eligible: decision === "ELIGIBLE", reasons: decision === "ELIGIBLE" ? [] : ["NO_POSITIVE_NET_EDGE"], executionAuthority: "NONE" },
    profitEvidence: { status: decision === "ELIGIBLE" ? "READY" : "INSUFFICIENT_SAMPLE", expectedNetEdge: decision === "ELIGIBLE" ? 0.01 : null, expectedNetReturn: decision === "ELIGIBLE" ? 0.01 : null, riskRewardRatio: decision === "ELIGIBLE" ? 1.5 : null, sampleSize: decision === "ELIGIBLE" ? 30 : 0, costPolicyId: "cost-v1", executionAuthority: "NONE" },
    execution: execution(market, now),
    order: { type: "MARKET", quantity: 1, direction },
    quote: { bid: 99, ask: 100, bidSize: 10, askSize: 10, asOfMs: now - 1, maxAgeMs: 60_000 },
  };
}

function harness(initial = ledger()) {
  let entryMutations = 0;
  let settlementMutations = 0;
  let saves = 0;
  return {
    state: createRecurringPaperLoopState({ identity, ledger: initial, createdAtMs: T0 - 10 }),
    ledgerAdapter: {
      async applyEntry({ ledger: current }) { entryMutations += 1; return current; },
      async applySettlement({ ledger: current, settlement }) {
        settlementMutations += 1;
        return { ...current, knownEquityKrw: current.knownEquityKrw + settlement.netPnl, totalEquityKrw: current.totalEquityKrw == null ? null : current.totalEquityKrw + settlement.netPnl };
      },
    },
    stateStore: { async save() { saves += 1; } },
    counts: () => ({ entryMutations, settlementMutations, saves }),
  };
}

function cycle(id, time = T0) { return { cycleId: id, evaluatedAtMs: time, identity }; }

test("NO_TRADE creates no entry and same cycle replay is idempotent", async () => {
  const h = harness();
  const first = await runRecurringPaperCycle({ state: h.state, cycle: cycle("c1"), candidates: [candidate("KR_STOCK", "s1", "NO_TRADE")], ledgerAdapter: h.ledgerAdapter, stateStore: h.stateStore });
  assert.equal(first.summary.entries, 0);
  assert.equal(first.summary.noTrade, 1);
  const replay = await runRecurringPaperCycle({ state: first.state, cycle: cycle("c1"), candidates: [candidate("KR_STOCK", "s1")], ledgerAdapter: h.ledgerAdapter, stateStore: h.stateStore });
  assert.equal(replay.summary.replayed, true);
  assert.deepEqual(h.counts(), { entryMutations: 0, settlementMutations: 0, saves: 1 });
});

test("four markets and futures SHORT enter once with canonical public evidence", async () => {
  const h = harness();
  const rows = [candidate("KR_STOCK", "kr"), candidate("US_STOCK", "us"), candidate("CRYPTO_SPOT", "spot"), candidate("CRYPTO_FUTURES", "long"), candidate("CRYPTO_FUTURES", "short", "ELIGIBLE", "SHORT")];
  const first = await runRecurringPaperCycle({ state: h.state, cycle: cycle("c1"), candidates: rows, ledgerAdapter: h.ledgerAdapter, stateStore: h.stateStore });
  assert.equal(first.summary.entries, 5);
  const second = await runRecurringPaperCycle({ state: first.state, cycle: cycle("c2", T0 + 1), candidates: rows, ledgerAdapter: h.ledgerAdapter, stateStore: h.stateStore });
  assert.equal(second.summary.entries, 0);
  assert.equal(h.counts().entryMutations, 5);
});

test("future and stale market evidence fail closed", async () => {
  const h = harness();
  const future = candidate("CRYPTO_SPOT", "future");
  future.execution.dataEvidence.asOfMs = T0 + 1;
  const stale = candidate("CRYPTO_SPOT", "stale");
  stale.execution.dataEvidence.asOfMs = T0 - 61_000;
  const result = await runRecurringPaperCycle({ state: h.state, cycle: cycle("c1"), candidates: [future, stale], ledgerAdapter: h.ledgerAdapter, stateStore: h.stateStore });
  assert.equal(result.summary.blocked, 2);
  assert.equal(result.summary.entries, 0);
});

test("valid future exit settles exactly once and replay cannot mutate ledger", async () => {
  const h = harness();
  const opened = await runRecurringPaperCycle({ state: h.state, cycle: cycle("c1"), candidates: [candidate("CRYPTO_SPOT", "spot")], ledgerAdapter: h.ledgerAdapter, stateStore: h.stateStore });
  const positionId = opened.state.positions[0].positionId;
  const exitExecution = execution("CRYPTO_SPOT", T0 + 10);
  const exit = { positionId, settlementInput: { exitExecution, exitQuote: { bid: 105, ask: 106, bidSize: 10, askSize: 10, asOfMs: T0 + 9, maxAgeMs: 60_000 }, pathBars: [{ timestampMs: T0 + 5, high: 107, low: 98 }], fundingEvidence: { complete: true, payments: [] } } };
  const settled = await runRecurringPaperCycle({ state: opened.state, cycle: cycle("c2", T0 + 10), exits: [exit], ledgerAdapter: h.ledgerAdapter, stateStore: h.stateStore });
  assert.equal(settled.summary.tradesSettled, 1);
  assert.equal(settled.state.positions.length, 0);
  const replay = await runRecurringPaperCycle({ state: settled.state, cycle: cycle("c3", T0 + 11), exits: [exit], ledgerAdapter: h.ledgerAdapter, stateStore: h.stateStore });
  assert.equal(replay.summary.tradesSettled, 0);
  assert.equal(h.counts().settlementMutations, 1);
});

test("restart restores open position and rejects policy identity mismatch", async () => {
  const h = harness();
  const opened = await runRecurringPaperCycle({ state: h.state, cycle: cycle("c1"), candidates: [candidate("US_STOCK", "us")], ledgerAdapter: h.ledgerAdapter, stateStore: h.stateStore });
  const restored = restoreRecurringPaperLoopState(serializeRecurringPaperLoopState(opened.state), identity);
  assert.equal(restored.positions.length, 1);
  assert.throws(() => restoreRecurringPaperLoopState(serializeRecurringPaperLoopState(opened.state), { ...identity, costPolicyVersion: "cost-v2" }), /PREDECESSOR_IDENTITY_MISMATCH/);
});

test("missing FX keeps total equity N/A and never fabricates a number", async () => {
  const h = harness(ledger("PARTIAL"));
  const result = await runRecurringPaperCycle({ state: h.state, cycle: cycle("c1"), candidates: [], ledgerAdapter: h.ledgerAdapter, stateStore: h.stateStore });
  assert.equal(result.summary.totalEquityKrw, null);
  assert.equal(result.summary.equityStatus, "PARTIAL");
  assert.equal(result.summary.sampleStatus, "N/A_INSUFFICIENT_SETTLED_SAMPLE");
});
