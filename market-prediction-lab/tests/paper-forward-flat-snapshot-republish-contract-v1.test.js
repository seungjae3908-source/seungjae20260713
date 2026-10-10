import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  SCHEMA_VERSION,
  buildRefreshAction,
  canonicalJson,
  createMetadataOnlyRefreshState,
  normalizedRiskWindow,
  selectRefreshAnchor,
  requireStableRiskWindow,
  sha256,
  validateBinding,
  validateFlatSnapshot,
  validateSnapshot,
  validateRepublishResponse,
} from '../../ops/run-paper-forward-flat-snapshot-republish.mjs';

const targetSha = 'a'.repeat(40);
const publisherDigest = 'b'.repeat(64);
const nowIso = '2026-08-24T04:00:00.000Z';

function state() {
  return {
    schemaVersion: 1,
    account: {
      id: 'paper_account_1', initialBalance: 10000, cashBalance: 10010, realizedPnl: 10,
      unrealizedPnl: 0, equity: 10010, usedMargin: 0, availableMargin: 10010,
      createdAt: '2026-08-24T02:00:00.000Z', updatedAt: '2026-08-24T03:00:00.000Z',
    },
    orders: [{ id: 'o1', symbol: 'BTCUSDT', status: 'filled' }],
    positions: [{ id: 'p1', symbol: 'BTCUSDT', status: 'closed', remainingQuantity: 0, currentPrice: 65000 }],
    fills: [{ id: 'f1', positionId: 'p1' }],
    journal: [{ id: 'j1', positionId: 'p1', status: 'closed', exitReason: 'manual_close' }],
    riskState: { dayKey: '2026-08-24', weekKey: '2026-W35', dailyRealizedPnl: 10, weeklyRealizedPnl: 10, consecutiveLosses: 0 },
    processedEventIds: ['paper-flat-recovery:123456789012345678901234'],
    createdAt: '2026-08-24T02:00:00.000Z',
    updatedAt: '2026-08-24T03:00:00.000Z',
  };
}

function snapshot(sourceSha = 'c'.repeat(40), stateValue = state()) {
  return {
    schemaVersion: 'paper-trading-state-snapshot-v2', paperStateSchemaVersion: 1,
    sourceOwner: 'authenticated-paper-trading-evaluate-v2', sourceSha,
    market: 'CRYPTO_FUTURES', currency: 'USDT', provenance: ['authenticated-member-session'],
    publisherAccountIdSha256: publisherDigest, observedAtMs: Date.parse(stateValue.updatedAt),
    stateUpdatedAtMs: Date.parse(stateValue.updatedAt), maximumAgeMs: 3_900_000,
    accountId: stateValue.account.id, equity: stateValue.account.equity, openPositionCount: 0,
    stateDigestSha256: sha256(canonicalJson(stateValue)), state: stateValue,
    immutable: true, executionAuthority: 'NONE', privateApiAllowed: false, liveTrading: false, financialMutationAllowed: false,
  };
}

test('binding requires exact target and zero execution authority', () => {
  const path = '/opt/stock-app-data/paper-forward-v1/publisher/paper-state-v2.json';
  assert.equal(validateBinding({
    schemaVersion: 'paper-state-publisher-runtime-binding-v1', paperRuntimeSourceSha: targetSha,
    snapshotPath: path, publisherAccountIdSha256: publisherDigest, immutable: true,
    executionAuthority: 'NONE', privateApiAllowed: false, liveTrading: false, financialMutationAllowed: false,
  }, { targetSha, publisherDigest, snapshotPath: path }), true);
});

test('flat snapshot rejects open exposure and accepts closed history anchor', () => {
  const value = snapshot();
  assert.equal(validateFlatSnapshot(value, { publisherDigest }).openPositionCount, 0);
  assert.deepEqual(selectRefreshAnchor(value.state), { symbol: 'BTCUSDT', price: 65000 });
  const opened = structuredClone(value);
  opened.state.positions[0].status = 'open';
  opened.state.positions[0].remainingQuantity = 1;
  opened.openPositionCount = 1;
  opened.stateDigestSha256 = sha256(canonicalJson(opened.state));
  assert.equal(validateSnapshot(opened, { publisherDigest }).openPositionCount, 1);
  assert.deepEqual(selectRefreshAnchor(opened.state), { symbol: 'BTCUSDT', price: 65000 });
  assert.throws(() => validateFlatSnapshot(opened, { publisherDigest }), /SNAPSHOT_NOT_FLAT/);
});

test('non-flat exact-SHA refresh preserves open positions, balances, and risk state byte-for-byte', () => {
  const before = state();
  before.positions[0] = {
    ...before.positions[0],
    status: 'open',
    remainingQuantity: 0.1,
    entryPrice: 65000,
    currentPrice: 65000,
    notionalValue: 6500,
    unrealizedPnl: 0,
    maximumFavorableExcursion: 0,
    maximumAdverseExcursion: 0,
  };
  before.account.usedMargin = 3250;
  before.account.availableMargin = before.account.equity - before.account.usedMargin;
  const stateDigest = sha256(canonicalJson(before));
  const action = buildRefreshAction({ stateDigest, symbol: 'BTCUSDT', price: 65000, nonFlat: true });
  const after = createMetadataOnlyRefreshState(before, action, nowIso);

  assert.equal(action.eventId, `paper-nonflat-republish:${stateDigest.slice(0, 24)}`);
  assert.deepEqual(after.positions, before.positions);
  assert.deepEqual(after.orders, before.orders);
  assert.deepEqual(after.riskState, before.riskState);
  assert.equal(after.account.cashBalance, before.account.cashBalance);
  assert.equal(after.account.equity, before.account.equity);
  assert.equal(after.account.usedMargin, before.account.usedMargin);
  assert.equal(after.account.availableMargin, before.account.availableMargin);
  assert.equal(after.processedEventIds.at(-1), action.eventId);
  assert.equal(after.updatedAt, nowIso);
  assert.equal(after.account.updatedAt, nowIso);
});

test('refresh action is deterministic from current snapshot digest', () => {
  const value = snapshot();
  assert.deepEqual(buildRefreshAction({ stateDigest: value.stateDigestSha256, symbol: 'BTCUSDT', price: 65000 }), {
    type: 'mark_price',
    eventId: `paper-flat-republish:${value.stateDigestSha256.slice(0, 24)}`,
    symbol: 'BTCUSDT',
    price: 65000,
  });
});

test('republish accepts only metadata refresh with exact economic state preservation', () => {
  const before = state();
  const action = buildRefreshAction({ stateDigest: sha256(canonicalJson(before)), symbol: 'BTCUSDT', price: 65000 });
  const after = structuredClone(before);
  after.updatedAt = nowIso;
  after.account.updatedAt = nowIso;
  after.processedEventIds.push(action.eventId);
  const body = {
    ok: true, mode: 'paper-only', orderSubmitted: false, exchangeRequestSent: false,
    result: { ok: true, mode: 'paper-only', orderSubmitted: false, exchangeRequestSent: false, state: after, order: null, position: null, fills: [], warnings: [], duplicateEvent: false },
    paperStateTransport: {
      status: 'PUBLISHED', publisherAccountBound: true, executionAuthority: 'NONE', privateApiAllowed: false,
      liveTrading: false, financialMutationAllowed: false, reason: null, stateDigestSha256: sha256(canonicalJson(after)), observedAtMs: Date.parse(nowIso),
    },
  };
  const result = validateRepublishResponse(body, { beforeState: before, targetSha, publisherDigest, action, nowIso });
  assert.equal(result.transportDigest, sha256(canonicalJson(after)));
});

test('republish accepts only a bounded authenticated server timestamp', () => {
  const before = state();
  const action = buildRefreshAction({ stateDigest: sha256(canonicalJson(before)), symbol: 'BTCUSDT', price: 65000 });
  const serverNowIso = new Date(Date.parse(nowIso) + 250).toISOString();
  const after = createMetadataOnlyRefreshState(before, action, serverNowIso);
  const body = {
    ok: true, mode: 'paper-only', orderSubmitted: false, exchangeRequestSent: false,
    result: { ok: true, mode: 'paper-only', orderSubmitted: false, exchangeRequestSent: false, state: after, order: null, position: null, fills: [], warnings: [], duplicateEvent: false },
    paperStateTransport: {
      status: 'PUBLISHED', publisherAccountBound: true, executionAuthority: 'NONE', privateApiAllowed: false,
      liveTrading: false, financialMutationAllowed: false, reason: null, stateDigestSha256: sha256(canonicalJson(after)), observedAtMs: Date.parse(serverNowIso),
    },
  };
  const result = validateRepublishResponse(body, {
    beforeState: before, targetSha, publisherDigest, action, nowIso, allowServerTimestamp: true,
  });
  assert.equal(result.effectiveNowIso, serverNowIso);

  after.updatedAt = new Date(Date.parse(nowIso) + 60_001).toISOString();
  after.account.updatedAt = after.updatedAt;
  assert.throws(() => validateRepublishResponse(body, {
    beforeState: before, targetSha, publisherDigest, action, nowIso, allowServerTimestamp: true,
  }), /REPUBLISH_SERVER_TIMESTAMP_INVALID/);
});

test('republish rejects any balance, position, fill, journal, or risk change', () => {
  const before = state();
  const action = buildRefreshAction({ stateDigest: sha256(canonicalJson(before)), symbol: 'BTCUSDT', price: 65000 });
  const after = structuredClone(before);
  after.updatedAt = nowIso;
  after.account.updatedAt = nowIso;
  after.account.cashBalance += 1;
  after.processedEventIds.push(action.eventId);
  const body = {
    ok: true, mode: 'paper-only', orderSubmitted: false, exchangeRequestSent: false,
    result: { ok: true, mode: 'paper-only', orderSubmitted: false, exchangeRequestSent: false, state: after, order: null, position: null, fills: [], duplicateEvent: false },
    paperStateTransport: { status: 'PUBLISHED', publisherAccountBound: true, executionAuthority: 'NONE', privateApiAllowed: false, liveTrading: false, financialMutationAllowed: false, reason: null, stateDigestSha256: sha256(canonicalJson(after)) },
  };
  assert.throws(() => validateRepublishResponse(body, { beforeState: before, targetSha, publisherDigest, action, nowIso }), /REPUBLISH_ECONOMIC_STATE_CHANGED/);
});

test('risk day/week rollover fails before any republish mutation', () => {
  const value = state();
  assert.equal(requireStableRiskWindow(value, new Date('2026-08-24T04:00:00.000Z')), true);
  assert.throws(() => requireStableRiskWindow(value, new Date('2026-08-25T04:00:00.000Z')), /RISK_WINDOW_ROLLOVER_REQUIRES_SEPARATE_ACCOUNTING_ACTION/);
});

test('schema and safety labels are stable', () => {
  assert.equal(SCHEMA_VERSION, 'paper-forward-flat-snapshot-republish-v1');
});

test('explicit refresh rollover resets only expired daily/weekly counters', () => {
  const before = state();
  const nextDay = new Date('2026-08-25T04:00:00.000Z');
  const normalized = normalizedRiskWindow(before, nextDay);
  const action = buildRefreshAction({ stateDigest: sha256(canonicalJson(before)), symbol: 'BTCUSDT', price: 65000 });
  const after = createMetadataOnlyRefreshState(before, action, nextDay.toISOString(), { allowRiskWindowRollover: true });

  assert.equal(normalized.dailyWindowRolled, true);
  assert.equal(normalized.weeklyWindowRolled, false);
  assert.deepEqual(after.riskState, {
    ...before.riskState,
    dayKey: '2026-08-25',
    dailyRealizedPnl: 0,
  });
  assert.deepEqual(after.positions, before.positions);
  assert.deepEqual(after.orders, before.orders);
  assert.equal(after.account.realizedPnl, before.account.realizedPnl);
  assert.equal(after.account.equity, before.account.equity);
});

test('snapshot republish contract test stays registered in bounded validation paths', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/paper-forward-schedule-validation.yml', import.meta.url),
    'utf8',
  );
  const testPath = 'market-prediction-lab/tests/paper-forward-flat-snapshot-republish-contract-v1.test.js';
  assert.equal(workflow.split(testPath).length - 1, 2);
});
