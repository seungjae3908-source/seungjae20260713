import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TRADING_POLICY, type TradingPolicy } from './trade-automation.types';
import { normalizeTradingPolicy } from './trade-automation-risk.service';
import type { StoredPaperJournalRecord } from './paper-journal.types';
import {
  AUTOMATIC_PAPER_ACCOUNT_ID,
  readMemberAutoTradingBackgroundRuntimeHealth,
} from './member-auto-trading-background-worker.service';
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
  assert.equal(result.strategyAllowlistReady, true);
  assert.equal(result.workerTickFresh, true);
  assert.equal(result.handoffReady, true);
  assert.equal(result.executionProjectionReady, true);
  assert.equal(result.realOrderAuthorityGranted, false);
  assert.equal('userId' in result, false);
  assert.equal('balance' in result, false);
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
