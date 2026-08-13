import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireAutoTradingV2WorkerLease,
  autoTradingV2WorkerHealth,
  normalizeAutoTradingV2PositionPayload,
  releaseAutoTradingV2WorkerLease,
  restartAutoTradingV2Worker,
  runAutoTradingV2WorkerCycle,
  startAutoTradingV2Worker,
  stopAutoTradingV2Worker,
} from './auto-trading-v2-worker.service';

test('worker can be hard-disabled without touching DB or exchange APIs', async () => {
  const previous = process.env.AUTO_TRADING_V2_WORKER_ENABLED;
  process.env.AUTO_TRADING_V2_WORKER_ENABLED = 'false';
  try {
    stopAutoTradingV2Worker();
    const health = autoTradingV2WorkerHealth();
    assert.equal(health.enabled, false);
    assert.equal(health.ready, false);
    assert.equal(health.reason, 'AUTO_TRADING_V2_WORKER_DISABLED');
    assert.equal(health.realOrderCount, 0);
    assert.equal(health.realCancelCount, 0);
    assert.equal(health.privateTradingApiCount, 0);
    const cycle = await runAutoTradingV2WorkerCycle(new Date('2026-08-13T02:00:00.000Z'));
    assert.equal(cycle.ok, false);
    assert.equal(cycle.users.length, 0);
  } finally {
    stopAutoTradingV2Worker();
    if (previous == null) delete process.env.AUTO_TRADING_V2_WORKER_ENABLED;
    else process.env.AUTO_TRADING_V2_WORKER_ENABLED = previous;
  }
});

test('filesystem owner lease blocks a second worker and permits stale takeover', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atv2-lease-test-'));
  const lockDir = path.join(root, 'owner');
  try {
    const start = new Date('2026-08-13T03:00:00.000Z');
    const ownerA = acquireAutoTradingV2WorkerLease({ ownerId: 'worker-a', lockDir, now: start, leaseMs: 60_000 });
    assert.equal(ownerA.acquired, true);
    const ownerBBlocked = acquireAutoTradingV2WorkerLease({ ownerId: 'worker-b', lockDir, now: new Date(start.getTime() + 30_000), leaseMs: 60_000 });
    assert.equal(ownerBBlocked.acquired, false);
    assert.equal(ownerBBlocked.ownerId, 'worker-a');

    const ownerARenewed = acquireAutoTradingV2WorkerLease({ ownerId: 'worker-a', lockDir, now: new Date(start.getTime() + 40_000), leaseMs: 60_000 });
    assert.equal(ownerARenewed.acquired, true);
    const ownerBStillBlocked = acquireAutoTradingV2WorkerLease({ ownerId: 'worker-b', lockDir, now: new Date(start.getTime() + 70_000), leaseMs: 60_000 });
    assert.equal(ownerBStillBlocked.acquired, false);

    const ownerBTakeover = acquireAutoTradingV2WorkerLease({ ownerId: 'worker-b', lockDir, now: new Date(start.getTime() + 101_000), leaseMs: 60_000 });
    assert.equal(ownerBTakeover.acquired, true);
    assert.equal(ownerBTakeover.ownerId, 'worker-b');
    assert.equal(releaseAutoTradingV2WorkerLease({ ownerId: 'worker-a', lockDir }), false);
    assert.equal(releaseAutoTradingV2WorkerLease({ ownerId: 'worker-b', lockDir }), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy active position is migration-on-read normalized with simulation-only liquidation', () => {
  const normalized = normalizeAutoTradingV2PositionPayload({
    recordType: 'auto_trading_v2_position',
    mode: 'PAPER',
    status: 'ACTIVE',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    strategyId: 'crypto-futures-pullback-v1',
    strategyVersion: '1.0.0',
    signalId: 'signal-legacy',
    executionId: 'execution-legacy',
    clientOrderId: 'client-legacy',
    entryPrice: 100_000,
    stopPrice: 98_500,
    targetPrice: 103_500,
    trailingDistance: 1_500,
    notionalKrw: 250_000,
    requiredMarginKrw: 83_333,
    leverage: 3,
    riskPerTradePercent: 0.25,
    remainingFraction: 1,
    partialTpDone: false,
    positionProtected: true,
    realizedPnlKrw: 0,
    unrealizedPnlKrw: 0,
    entryFeeKrw: 0,
    exitFeesKrw: 0,
    fundingCostKrw: 0,
    maxFavorableExcursionPercent: 0,
    maxAdverseExcursionPercent: 0,
    nextFundingTime: null,
    lastFundingAppliedAt: null,
    openedAt: '2026-08-13T01:00:00.000Z',
    updatedAt: '2026-08-13T01:00:00.000Z',
    closedAt: null,
    exitPrice: null,
    exitReason: null,
    executionStates: ['POSITION_PROTECTED'],
    realOrderCount: 0,
    realCancelCount: 0,
    privateTradingApiCount: 0,
  });
  assert.ok(normalized.position);
  assert.equal(normalized.changed, true);
  assert.equal(normalized.position?.liquidationSimulation.source, 'SIMULATION_ONLY_NOT_EXCHANGE_EXACT');
  assert.equal(normalized.position?.liquidationSimulation.status, 'AVAILABLE');
  assert.ok((normalized.position?.liquidationSimulation.estimatedPrice ?? 0) > 0);
  assert.equal(normalized.position?.realOrderCount, 0);
  assert.equal(normalized.position?.privateTradingApiCount, 0);
});

test('unsafe legacy position keeps liquidation unavailable and cannot become executable', () => {
  const normalized = normalizeAutoTradingV2PositionPayload({
    recordType: 'auto_trading_v2_position',
    mode: 'SHADOW',
    status: 'ACTIVE',
    symbol: 'SOLUSDT',
    direction: 'LONG',
    entryPrice: 200,
    leverage: 3,
    positionProtected: false,
  });
  assert.equal(normalized.position, null);
  assert.equal(normalized.payload?.liquidationModel, 'SIMULATION_ONLY_NOT_EXCHANGE_EXACT');
  assert.deepEqual((normalized.payload?.liquidationSimulation as { status?: string })?.status, 'UNAVAILABLE');
  assert.ok(normalized.reasons.includes('POSITION_STOP_UNAVAILABLE'));
  assert.ok(normalized.reasons.includes('PROTECTIVE_STOP_MISSING'));
});

test('start twice registers one timer; stop cleans it; restart returns to exactly one active timer', () => {
  const previous = {
    enabled: process.env.AUTO_TRADING_V2_WORKER_ENABLED,
    url: process.env.SUPABASE_URL,
    secret: process.env.SUPABASE_SECRET_KEY,
    lock: process.env.AUTO_TRADING_V2_WORKER_LOCK_DIR,
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atv2-timer-test-'));
  process.env.AUTO_TRADING_V2_WORKER_ENABLED = 'true';
  process.env.SUPABASE_URL = 'http://127.0.0.1:9';
  process.env.SUPABASE_SECRET_KEY = 'test-only-secret';
  process.env.AUTO_TRADING_V2_WORKER_LOCK_DIR = path.join(root, 'owner');
  try {
    stopAutoTradingV2Worker();
    const first = startAutoTradingV2Worker();
    assert.equal(first.workerRunning, true);
    assert.ok(first.nextTickAt);
    const firstNextTick = first.nextTickAt;
    const second = startAutoTradingV2Worker();
    assert.equal(second.workerRunning, true);
    assert.equal(second.nextTickAt, firstNextTick);

    const stopped = stopAutoTradingV2Worker();
    assert.equal(stopped.workerRunning, false);
    assert.equal(stopped.nextTickAt, null);

    const restarted = restartAutoTradingV2Worker();
    assert.equal(restarted.workerRunning, true);
    assert.ok(restarted.nextTickAt);
    const stoppedAgain = stopAutoTradingV2Worker();
    assert.equal(stoppedAgain.workerRunning, false);
  } finally {
    stopAutoTradingV2Worker();
    fs.rmSync(root, { recursive: true, force: true });
    if (previous.enabled == null) delete process.env.AUTO_TRADING_V2_WORKER_ENABLED; else process.env.AUTO_TRADING_V2_WORKER_ENABLED = previous.enabled;
    if (previous.url == null) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.secret == null) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = previous.secret;
    if (previous.lock == null) delete process.env.AUTO_TRADING_V2_WORKER_LOCK_DIR; else process.env.AUTO_TRADING_V2_WORKER_LOCK_DIR = previous.lock;
  }
});
