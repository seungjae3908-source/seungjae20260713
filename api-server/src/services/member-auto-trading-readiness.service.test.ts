import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TRADING_POLICY, type TradingPolicy } from './trade-automation.types';
import { normalizeTradingPolicy } from './trade-automation-risk.service';
import type { StoredPaperJournalRecord } from './paper-journal.types';
import {
  AUTOMATIC_PAPER_ACCOUNT_ID,
  readMemberAutoTradingBackgroundRuntimeHealth,
} from './member-auto-trading-background-worker.service';
import { buildAdminFourMarketPaperBootstrap } from './admin-four-market-paper-capital.service';
import {
  memberAutomaticPaperReadiness,
  type MemberAutomaticPaperReadinessInput,
} from './member-auto-trading-readiness.service';

const NOW = Date.UTC(2026, 9, 9, 2, 0, 0);

function policy(): TradingPolicy {
  return normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    mode: 'automatic',
    automaticEnabled: true,
    marketEnabled: { domestic_stock: false, us_stock: false, crypto_spot: true, crypto_futures: false },
    exchangeEnabled: { bitget: false, upbit: true, kiwoom: false, toss: false },
    enabledStrategies: ['PAPER_SAFE_CANARY'],
  });
}

function wallet(overrides: Partial<StoredPaperJournalRecord> = {}): StoredPaperJournalRecord {
  const serverTime = new Date(NOW - 2000).toISOString();
  return {
    kind: 'account',
    id: AUTOMATIC_PAPER_ACCOUNT_ID,
    version: 1,
    updatedAt: serverTime,
    createdAt: serverTime,
    serverUpdatedAt: serverTime,
    deletedAt: null,
    payload: {
      id: AUTOMATIC_PAPER_ACCOUNT_ID,
      initialBalance: 500_000,
      equity: 500_000,
      cashBalance: 500_000,
      usedMargin: 0,
      availableMargin: 500_000,
    },
    ...overrides,
  };
}

function input(changes: Partial<MemberAutomaticPaperReadinessInput> = {}): MemberAutomaticPaperReadinessInput {
  return {
    policy: policy(),
    wallet: wallet(),
    workerMode: 'PAPER_ONLY',
    globalStopped: false,
    nowMs: NOW,
    workerHealth: {
      ...readMemberAutoTradingBackgroundRuntimeHealth(),
      enabled: true,
      lastTickAt: new Date(NOW - 30_000).toISOString(),
      tickOk: true,
      handoffStatus: 'READY',
      handoffReady: true,
      newEntriesFailClosed: false,
      liveModeRequested: false,
      liveEntriesArmed: false,
      executionSyncFailures: 0,
      executionSyncMissingReferences: 0,
      errorCode: null,
    },
    ...changes,
  };
}

test('Paper-only worker readiness is member-scoped and never grants real order authority', () => {
  const result = memberAutomaticPaperReadiness(input());
  assert.equal(result.readyForPaperEvaluation, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.workerMode, 'PAPER_ONLY');
  assert.equal(result.paperWalletReady, true);
  assert.equal(result.paperCapitalPolicyReady, true);
  assert.equal(result.strategyAllowlistReady, true);
  assert.equal(result.workerTickFresh, true);
  assert.equal(result.handoffReady, true);
  assert.equal(result.executionProjectionReady, true);
  assert.equal(result.realOrderAuthorityGranted, false);
  assert.equal('userId' in result, false);
  assert.equal('balance' in result, false);
});

test('500k wallet readiness must not authorize a member policy still capped at 100k', () => {
  const underfunded = normalizeTradingPolicy({ ...policy(), totalCapitalKrw: 100_000 });
  const result = memberAutomaticPaperReadiness(input({ policy: underfunded }));
  assert.equal(result.paperWalletReady, true);
  assert.equal(result.paperCapitalPolicyReady, false);
  assert.equal(result.readyForPaperEvaluation, false);
  assert.ok(result.blockers.includes('BACKGROUND_PAPER_CAPITAL_POLICY_TOO_LOW'));
  assert.equal(result.realOrderAuthorityGranted, false);
  const exactlyFunded = memberAutomaticPaperReadiness(input({
    policy: normalizeTradingPolicy({ ...policy(), totalCapitalKrw: 500_000 }),
  }));
  assert.equal(exactlyFunded.paperCapitalPolicyReady, true);
  assert.equal(exactlyFunded.readyForPaperEvaluation, true);
});

test('missing or tampered Paper wallet and empty allowlist fail closed', () => {
  const missing = memberAutomaticPaperReadiness(input({
    wallet: null,
    policy: normalizeTradingPolicy({ ...policy(), enabledStrategies: [] }),
  }));
  assert.equal(missing.readyForPaperEvaluation, false);
  assert.ok(missing.blockers.includes('BACKGROUND_PAPER_WALLET_REQUIRED'));
  assert.ok(missing.blockers.includes('BACKGROUND_STRATEGY_ALLOWLIST_REQUIRED'));

  for (const corrupt of [
    wallet({ deletedAt: new Date(NOW).toISOString() }),
    wallet({ payload: { ...wallet().payload, initialBalance: 1_000_000 } }),
    wallet({ createdAt: 'not-a-server-time' }),
  ]) {
    const blocked = memberAutomaticPaperReadiness(input({ wallet: corrupt }));
    assert.equal(blocked.paperWalletReady, false);
    assert.ok(blocked.blockers.includes('BACKGROUND_PAPER_WALLET_REQUIRED'));
  }
});

test('Paper readiness requires at least one market with its matching provider enabled', () => {
  const policySnapshot = policy();
  const disconnectedPolicy = normalizeTradingPolicy({
    ...policySnapshot,
    exchangeEnabled: { bitget: false, upbit: false, kiwoom: false, toss: false },
  });
  const blocked = memberAutomaticPaperReadiness(input({ policy: disconnectedPolicy }));
  assert.equal(blocked.enabledMarketCount, 1);
  assert.equal(blocked.connectedPolicyMarketCount, 0);
  assert.ok(blocked.blockers.includes('BACKGROUND_MARKET_PROVIDER_POLICY_DISABLED'));
  assert.equal(blocked.readyForPaperEvaluation, false);
});

test('shared Worker, explicit stop, stale tick and bad projections independently block Paper evaluation', () => {
  const baseline = input();
  const shared = memberAutomaticPaperReadiness(input({ workerMode: 'SHARED_BACKGROUND' }));
  assert.ok(shared.blockers.includes('BACKGROUND_PAPER_ONLY_WORKER_REQUIRED'));
  const stopped = memberAutomaticPaperReadiness(input({ globalStopped: true }));
  assert.ok(stopped.blockers.includes('BACKGROUND_TRADING_STOP_ACTIVE'));
  const stale = memberAutomaticPaperReadiness(input({
    workerHealth: { ...baseline.workerHealth, lastTickAt: new Date(NOW - 400_000).toISOString() },
  }));
  assert.ok(stale.blockers.includes('BACKGROUND_WORKER_TICK_NOT_HEALTHY'));
  assert.ok(stale.blockers.includes('BACKGROUND_CANONICAL_HANDOFF_NOT_READY'));
  const failure = memberAutomaticPaperReadiness(input({
    workerHealth: {
      ...baseline.workerHealth,
      executionSyncFailures: 1,
      executionSyncMissingReferences: 2,
      errorCode: 'BACKGROUND_PROJECTION_BLOCKED',
    },
  }));
  assert.ok(failure.blockers.includes('BACKGROUND_EXECUTION_PROJECTION_NOT_HEALTHY'));
  const failClosedWorker = memberAutomaticPaperReadiness(input({
    workerHealth: { ...baseline.workerHealth, newEntriesFailClosed: true },
  }));
  assert.ok(failClosedWorker.blockers.includes('BACKGROUND_NEW_ENTRIES_FAIL_CLOSED'));
  assert.equal(failClosedWorker.readyForPaperEvaluation, false);
  const liveRequested = memberAutomaticPaperReadiness(input({
    workerHealth: { ...baseline.workerHealth, liveModeRequested: true },
  }));
  assert.ok(liveRequested.blockers.includes('BACKGROUND_PAPER_ONLY_WORKER_REQUIRED'));
});

test('administrator Paper readiness requires four 1m wallets and all four routed markets', () => {
  const before = memberAutomaticPaperReadiness(input({
    administratorFourMarket: true, adminMarketWalletRecords: [],
  }));
  assert.equal(before.paperWalletReady, false);
  assert.ok(before.blockers.includes('BACKGROUND_ADMIN_FOUR_MARKET_WALLETS_REQUIRED'));

  const adminWallets = buildAdminFourMarketPaperBootstrap(new Date(NOW)).map((row) => ({
    ...row, createdAt: new Date(NOW).toISOString(),
    serverUpdatedAt: new Date(NOW).toISOString(),
  }));
  const allFour = normalizeTradingPolicy({
    ...policy(), totalCapitalKrw: 1_000_000,
    marketEnabled: {domestic_stock:true,us_stock:true,crypto_spot:true,crypto_futures:true},
    exchangeEnabled: {toss:true,kiwoom:true,upbit:true,bitget:true},
  });
  const ready = memberAutomaticPaperReadiness(input({
    administratorFourMarket: true, adminMarketWalletRecords: adminWallets,
    adminDatabaseGuardReady: true,
    policy: allFour,
  }));
  assert.equal(ready.paperWalletReady,true);
  assert.equal(ready.paperCapitalPolicyReady,true);
  assert.equal(ready.adminMarketWalletsReady,true);
  assert.equal(ready.readyForPaperEvaluation,true);
  assert.equal(ready.realOrderAuthorityGranted,false);

  const underfunded = memberAutomaticPaperReadiness(input({
    administratorFourMarket: true, adminMarketWalletRecords: adminWallets,
    adminDatabaseGuardReady: true,
    policy: normalizeTradingPolicy({...allFour,totalCapitalKrw:900_000}),
  }));
  assert.ok(underfunded.blockers.includes('BACKGROUND_ADMIN_MARKET_POLICY_1M_REQUIRED'));
  const incomplete = memberAutomaticPaperReadiness(input({
    administratorFourMarket: true, adminMarketWalletRecords: adminWallets.slice(0,3),
    adminDatabaseGuardReady: true,
    policy: allFour,
  }));
  assert.equal(incomplete.readyForPaperEvaluation,false);
  assert.ok(incomplete.blockers.includes('BACKGROUND_ADMIN_FOUR_MARKET_WALLETS_REQUIRED'));
});

test('admin readiness never reports READY after DB RLS guard rollback', () => {
  const rows = buildAdminFourMarketPaperBootstrap(new Date(NOW)).map(row => ({
    ...row, createdAt:new Date(NOW).toISOString(),
    serverUpdatedAt:new Date(NOW).toISOString(),
  }));
  const all = normalizeTradingPolicy({
    ...policy(), totalCapitalKrw:1_000_000,
    marketEnabled:{domestic_stock:true,us_stock:true,crypto_spot:true,crypto_futures:true},
    exchangeEnabled:{toss:true,kiwoom:true,upbit:true,bitget:true},
  });
  for(const flag of [undefined,false]){
    const result=memberAutomaticPaperReadiness(input({
      policy:all,administratorFourMarket:true,
      adminMarketWalletRecords:rows,adminDatabaseGuardReady:flag,
    }));
    assert.equal(result.paperWalletReady,true);
    assert.equal(result.adminDatabaseGuardReady,false);
    assert.equal(result.readyForPaperEvaluation,false);
    assert.ok(result.blockers.includes('BACKGROUND_ADMIN_DATABASE_GUARD_REQUIRED'));
    assert.equal(result.realOrderAuthorityGranted,false);
  }
});
