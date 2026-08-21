import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAuthoritativeNaturalPaperLedgerAdapter,
  createAuthoritativeNaturalPaperLedgerFromSnapshot,
  paperStateFromAuthoritativeNaturalPaperLedger,
  validateAuthoritativeNaturalPaperLedger,
} from "../src/authoritative-natural-paper-accounting-v1.js";
import {
  createRecurringPaperLoopState,
  restoreRecurringPaperLoopState,
  serializeRecurringPaperLoopState,
} from "../src/recurring-paper-loop-v1.js";
import {
  runPaperForwardScheduledInvocation,
  __paperForwardScheduleTestables,
} from "../src/paper-forward-schedule-runtime-v1.js";

const NOW = Date.UTC(2026, 7, 22, 0, 0, 0);
const SOURCE_SHA = "a".repeat(40);
const PUBLISHER_DIGEST = "b".repeat(64);
const STATE_DIGEST = "c".repeat(64);
const PARITY = "d".repeat(64);

function paperState(balance = 10_000) {
  const at = new Date(NOW).toISOString();
  return {
    schemaVersion: 1,
    account: {
      id: "paper-account-natural",
      initialBalance: balance,
      cashBalance: balance,
      realizedPnl: 0,
      unrealizedPnl: 0,
      equity: balance,
      usedMargin: 0,
      availableMargin: balance,
      createdAt: at,
      updatedAt: at,
    },
    orders: [],
    positions: [],
    fills: [],
    journal: [],
    riskState: {
      dayKey: "2026-08-22",
      weekKey: "2026-W34",
      dailyRealizedPnl: 0,
      weeklyRealizedPnl: 0,
      consecutiveLosses: 0,
    },
    processedEventIds: [],
    createdAt: at,
    updatedAt: at,
  };
}

function snapshot(balance = 10_000) {
  const state = paperState(balance);
  return {
    schemaVersion: "paper-trading-state-snapshot-v2",
    state,
    sourceOwner: "authenticated-paper-trading-evaluate-v2",
    sourceSha: SOURCE_SHA,
    market: "CRYPTO_FUTURES",
    currency: "USDT",
    provenance: ["authenticated-member-session", "paper-trading-engine-result", "lossless-atomic-shared-path"],
    publisherAccountIdSha256: PUBLISHER_DIGEST,
    observedAtMs: NOW,
    stateUpdatedAtMs: NOW,
    maximumAgeMs: 60 * 60_000,
    accountId: state.account.id,
    equity: state.account.equity,
    openPositionCount: 0,
    stateDigestSha256: STATE_DIGEST,
    immutable: true,
    executionAuthority: "NONE",
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
    unknownIsZero: false,
  };
}

function openPosition({ notional = 2_000, quantity = 1, leverage = 2, immediateCost = 2 } = {}) {
  const sample = {
    schemaVersion: 1,
    status: "OPEN",
    paperSampleId: "sample-natural-1",
    identity: {
      signalId: "signal-natural-1",
      market: "CRYPTO_FUTURES",
      symbol: "BTCUSDT",
      executionDirection: "LONG",
      strategyId: "paper-forward-authoritative-account-v1",
      evaluatedAtMs: NOW,
    },
    fill: {
      status: "FILLED",
      filledQuantity: quantity,
      fillPrice: notional / quantity,
      notional,
      costs: { immediateCost },
    },
    parityFingerprint: PARITY,
  };
  return {
    positionId: "position-natural-1",
    paperSampleId: sample.paperSampleId,
    accountingEvidence: {
      schemaVersion: "authoritative-natural-paper-entry-accounting-v1",
      settlementCurrency: "USDT",
      leverage,
      marginMode: "ISOLATED",
      entryNotional: notional,
      immediateCost,
      quantity,
      fillPrice: sample.fill.fillPrice,
      parityFingerprint: PARITY,
    },
    sample,
  };
}

function settlement({ netPnl = 100, entryCost = 2, exitCost = 1, fundingCost = 0.5 } = {}) {
  return {
    schemaVersion: 1,
    paperSampleId: "sample-natural-1",
    market: "CRYPTO_FUTURES",
    status: "SETTLED",
    settledAtMs: NOW + 60_000,
    quantity: 1,
    entryFillPrice: 2_000,
    exitFillPrice: 2_103.5,
    entryNotional: 2_000,
    grossPnl: 103.5,
    entryCost,
    exitCost,
    fundingCost,
    totalExplicitCost: entryCost + exitCost + fundingCost,
    netPnl,
    netReturnPercent: 5,
    orderSubmitted: false,
    exchangeRequestSent: false,
    liveOrderAllowed: false,
    simulatedOnly: true,
    privateTradingApiAllowed: false,
    productionMutationAllowed: false,
    profitabilityClaimAllowed: false,
  };
}

function identity() {
  return {
    strategyId: "paper-forward-authoritative-account-v1",
    strategyVersion: "1.0.0",
    parameterHash: "parameter-hash",
    researchCodeSha: SOURCE_SHA,
    costPolicyVersion: "paper-forward-authoritative-accounting-v1",
    executionPolicyVersion: "public-evidence-simulated-paper-v1",
  };
}

test("authenticated flat CRYPTO_FUTURES snapshot seeds the only Natural Paper account ledger", () => {
  const ledger = createAuthoritativeNaturalPaperLedgerFromSnapshot({
    snapshot: snapshot(),
    expectedPublisherAccountIdSha256: PUBLISHER_DIGEST,
    expectedSourceSha: SOURCE_SHA,
    nowMs: NOW,
  });
  assert.equal(ledger.baseCurrency, "USDT");
  assert.equal(ledger.initialEquity, 10_000);
  assert.equal(ledger.paperState.account.availableMargin, 10_000);
  assert.equal(ledger.accountBinding.publisherAccountIdSha256, PUBLISHER_DIGEST);
  assert.equal(ledger.reportingKrw.currentEquityKrw, null);
  assert.equal(paperStateFromAuthoritativeNaturalPaperLedger(ledger).account.id, "paper-account-natural");
});

test("snapshot binding, source SHA, and flat-account requirements fail closed", () => {
  assert.throws(() => createAuthoritativeNaturalPaperLedgerFromSnapshot({
    snapshot: snapshot(), expectedPublisherAccountIdSha256: "e".repeat(64), expectedSourceSha: SOURCE_SHA, nowMs: NOW,
  }), /AUTHORITATIVE_NATURAL_PAPER_ACCOUNT_BINDING_MISMATCH/);
  assert.throws(() => createAuthoritativeNaturalPaperLedgerFromSnapshot({
    snapshot: snapshot(), expectedPublisherAccountIdSha256: PUBLISHER_DIGEST, expectedSourceSha: "f".repeat(40), nowMs: NOW,
  }), /AUTHORITATIVE_NATURAL_PAPER_SOURCE_SHA_MISMATCH/);
  const nonFlat = snapshot();
  nonFlat.state.account.usedMargin = 100;
  nonFlat.state.positions.push({ status: "open", notionalValue: 200 });
  assert.throws(() => createAuthoritativeNaturalPaperLedgerFromSnapshot({
    snapshot: nonFlat, expectedPublisherAccountIdSha256: PUBLISHER_DIGEST, expectedSourceSha: SOURCE_SHA, nowMs: NOW,
  }), /AUTHORITATIVE_NATURAL_PAPER_SEED_NOT_FLAT/);
});

test("entry reserves margin and costs once, settlement releases exposure and applies costs/funding once", async () => {
  const adapter = createAuthoritativeNaturalPaperLedgerAdapter({
    accountingEvidenceForSettlement: async (value) => ({
      status: "READY",
      sourceCurrency: "USDT",
      fxRateToKrw: 1_400,
      netPnlKrw: value.netPnl * 1_400,
      source: "public-usdt-krw-fx",
      version: "v1",
      asOfMs: NOW + 60_000,
      maxAgeMs: 60_000,
    }),
  });
  const seed = createAuthoritativeNaturalPaperLedgerFromSnapshot({
    snapshot: snapshot(), expectedPublisherAccountIdSha256: PUBLISHER_DIGEST, expectedSourceSha: SOURCE_SHA, nowMs: NOW,
  });
  const position = openPosition();
  const cycle = { cycleId: "cycle-entry", evaluatedAtMs: NOW + 1_000 };
  const entered = await adapter.applyEntry({ ledger: seed, position, cycle });
  assert.equal(entered.paperState.account.cashBalance, 9_998);
  assert.equal(entered.paperState.account.usedMargin, 1_000);
  assert.equal(entered.paperState.account.availableMargin, 8_998);
  assert.equal(entered.reservations.filter((row) => row.status === "OPEN").length, 1);
  const duplicateEntry = await adapter.applyEntry({ ledger: entered, position, cycle });
  assert.deepEqual(duplicateEntry, entered);

  const closed = await adapter.applySettlement({
    ledger: entered,
    position,
    settlement: settlement(),
    settlementId: "settlement-natural-1",
    cycle: { cycleId: "cycle-exit", evaluatedAtMs: NOW + 60_000 },
  });
  assert.equal(closed.paperState.account.cashBalance, 10_100);
  assert.equal(closed.paperState.account.realizedPnl, 100);
  assert.equal(closed.paperState.account.usedMargin, 0);
  assert.equal(closed.paperState.account.availableMargin, 10_100);
  assert.equal(closed.reservations.filter((row) => row.status === "OPEN").length, 0);
  assert.equal(closed.appliedSettlementIds.length, 1);
  assert.equal(closed.reportingKrw.status, "READY");
  assert.equal(closed.reportingKrw.currentEquityKrw, 14_140_000);
  const duplicateSettlement = await adapter.applySettlement({
    ledger: closed,
    position,
    settlement: settlement(),
    settlementId: "settlement-natural-1",
    cycle: { cycleId: "cycle-exit", evaluatedAtMs: NOW + 60_000 },
  });
  assert.deepEqual(duplicateSettlement, closed);
});

test("missing FX evidence never fabricates KRW reporting and insufficient margin blocks entry", async () => {
  const adapter = createAuthoritativeNaturalPaperLedgerAdapter();
  const seed = createAuthoritativeNaturalPaperLedgerFromSnapshot({
    snapshot: snapshot(1_000), expectedPublisherAccountIdSha256: PUBLISHER_DIGEST, expectedSourceSha: SOURCE_SHA, nowMs: NOW,
  });
  await assert.rejects(
    adapter.applyEntry({
      ledger: seed,
      position: openPosition({ notional: 4_000, leverage: 2, immediateCost: 2 }),
      cycle: { cycleId: "cycle-block", evaluatedAtMs: NOW + 1_000 },
    }),
    (error) => error?.code === "AUTHORITATIVE_NATURAL_PAPER_INSUFFICIENT_MARGIN",
  );

  const roomy = createAuthoritativeNaturalPaperLedgerFromSnapshot({
    snapshot: snapshot(), expectedPublisherAccountIdSha256: PUBLISHER_DIGEST, expectedSourceSha: SOURCE_SHA, nowMs: NOW,
  });
  const position = openPosition();
  const entered = await adapter.applyEntry({
    ledger: roomy, position, cycle: { cycleId: "cycle-entry", evaluatedAtMs: NOW + 1_000 },
  });
  const closed = await adapter.applySettlement({
    ledger: entered,
    position,
    settlement: settlement(),
    settlementId: "settlement-no-fx",
    cycle: { cycleId: "cycle-exit", evaluatedAtMs: NOW + 60_000 },
  });
  assert.equal(closed.reportingKrw.status, "UNAVAILABLE");
  assert.equal(closed.reportingKrw.currentEquityKrw, null);
});

test("recurring state serializes and restores authoritative account ledger without falling back to KRW", () => {
  const ledger = createAuthoritativeNaturalPaperLedgerFromSnapshot({
    snapshot: snapshot(), expectedPublisherAccountIdSha256: PUBLISHER_DIGEST, expectedSourceSha: SOURCE_SHA, nowMs: NOW,
  });
  const state = createRecurringPaperLoopState({ identity: identity(), ledger, createdAtMs: NOW });
  const restored = restoreRecurringPaperLoopState(serializeRecurringPaperLoopState(state), identity());
  validateAuthoritativeNaturalPaperLedger(restored.ledger, {
    expectedPublisherAccountIdSha256: PUBLISHER_DIGEST,
    expectedSourceSha: SOURCE_SHA,
  });
  assert.equal(restored.ledger.baseCurrency, "USDT");
  assert.equal(restored.ledger.initialCapitalKrw, undefined);
});

test("schedule runtime requires authenticated seed on first authoritative run and recovers it on restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "authoritative-natural-paper-"));
  await assert.rejects(
    runPaperForwardScheduledInvocation({
      rootDirectory: root,
      researchCodeSha: SOURCE_SHA,
      triggerSource: "manual-readonly-test",
      activationAtMs: NOW,
      clock: () => NOW,
      outcomeAccumulationEnabled: true,
      authoritativeAccountRequired: true,
      expectedPublisherAccountIdSha256: PUBLISHER_DIGEST,
      runRuntime: async () => ({ status: "COMPLETED", cycleId: "missing-seed", mutationCount: 0, completedAtMs: NOW }),
    }),
    (error) => error?.code === "PAPER_FORWARD_AUTHORITATIVE_ACCOUNT_SEED_REQUIRED",
  );

  const capture = [];
  const runRuntime = async ({ state, runtimeStatusStore }) => {
    capture.push(state);
    await runtimeStatusStore.save({ status: "COMPLETED", scheduleActive: true, lanes: [], outcomeCount: 0 });
    return { status: "COMPLETED", cycleId: `capture-${capture.length}`, mutationCount: 0, completedAtMs: NOW, state };
  };
  const first = await runPaperForwardScheduledInvocation({
    rootDirectory: root,
    researchCodeSha: SOURCE_SHA,
    triggerSource: "manual-readonly-test",
    activationAtMs: NOW,
    clock: () => NOW,
    outcomeAccumulationEnabled: true,
    authoritativeAccountRequired: true,
    authoritativeAccountSeedSnapshot: snapshot(),
    expectedPublisherAccountIdSha256: PUBLISHER_DIGEST,
    runRuntime,
  });
  assert.equal(capture[0].ledger.baseCurrency, "USDT");
  assert.equal(first.invocation.authoritativeAccount.currency, "USDT");

  const second = await runPaperForwardScheduledInvocation({
    rootDirectory: root,
    researchCodeSha: SOURCE_SHA,
    triggerSource: "manual-readonly-test",
    activationAtMs: NOW,
    clock: () => NOW,
    outcomeAccumulationEnabled: true,
    authoritativeAccountRequired: true,
    expectedPublisherAccountIdSha256: PUBLISHER_DIGEST,
    runRuntime,
  });
  assert.equal(capture[1].ledger.accountBinding.publisherAccountIdSha256, PUBLISHER_DIGEST);
  assert.equal(second.invocation.authoritativeAccount.accountBindingVerified, true);
});

test("authoritative mode gets a new identity and never reuses the fixed-KRW strategy identity", () => {
  const legacy = __paperForwardScheduleTestables.buildIdentity(SOURCE_SHA, true, false);
  const authoritative = __paperForwardScheduleTestables.buildIdentity(SOURCE_SHA, true, true);
  assert.equal(legacy.strategyId, "paper-forward-simulated-outcome-v1");
  assert.equal(authoritative.strategyId, "paper-forward-authoritative-account-v1");
  assert.equal(authoritative.costPolicyVersion, "paper-forward-authoritative-accounting-v1");
  assert.notEqual(authoritative.parameterHash, legacy.parameterHash);
});
