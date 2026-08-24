import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildCloseAction,
  canonicalJson,
  internalEmail,
  sha256,
  validateBinding,
  validateCloseResponse,
  validateFlatSnapshot,
  validateFreshMarket,
  validateRecoverySnapshot,
} from '../../ops/run-paper-forward-one-shot-close.mjs';

const TARGET = '30c750562fdde49428e4ddd17b889c1bd63ccee8';
const PUBLISHER_ID = 'publisher-account-fixture';
const PUBLISHER_DIGEST = sha256(PUBLISHER_ID);
const SNAPSHOT_PATH = '/opt/stock-app-data/paper-forward-v1/publisher/paper-state-v2.json';

function stateFixture({ flat = false, updatedAt = '2026-08-24T01:45:00.000Z' } = {}) {
  const remainingQuantity = flat ? 0 : 0.25;
  const status = flat ? 'closed' : 'open';
  return {
    schemaVersion: 1,
    account: {
      id: 'paper_account_fixture',
      initialBalance: 10000,
      cashBalance: 9995,
      realizedPnl: -5,
      unrealizedPnl: flat ? 0 : 12,
      equity: flat ? 9995 : 10007,
      usedMargin: flat ? 0 : 1000,
      availableMargin: flat ? 9995 : 9007,
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt,
    },
    orders: [{
      id: 'paper_order_fixture',
      symbol: 'BTCUSDT',
      status: 'filled',
    }],
    positions: [{
      id: 'paper_position_fixture',
      orderId: 'paper_order_fixture',
      symbol: 'BTCUSDT',
      side: 'long',
      remainingQuantity,
      status,
      closedAt: flat ? updatedAt : null,
    }],
    fills: [],
    journal: flat ? [{
      positionId: 'paper_position_fixture',
      status: 'closed',
      exitReason: 'manual_close',
      remainingQuantity: 0,
    }] : [],
    riskState: {
      dayKey: '2026-08-24',
      weekKey: '2026-W35',
      dailyRealizedPnl: 0,
      weeklyRealizedPnl: 0,
      consecutiveLosses: 0,
    },
    processedEventIds: [],
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt,
  };
}

function snapshotFixture({ flat = false, sourceSha = 'b59c2ca8f3f1c66b956ce47e43b4f3f98acbff96', nowMs = Date.parse('2026-08-24T01:45:10.000Z') } = {}) {
  const updatedAt = new Date(nowMs - 1_000).toISOString();
  const state = stateFixture({ flat, updatedAt });
  return {
    schemaVersion: 'paper-trading-state-snapshot-v2',
    paperStateSchemaVersion: 1,
    sourceOwner: 'authenticated-paper-trading-evaluate-v2',
    sourceSha,
    market: 'CRYPTO_FUTURES',
    currency: 'USDT',
    provenance: ['authenticated-member-session', 'paper-trading-engine-result'],
    publisherAccountIdSha256: PUBLISHER_DIGEST,
    observedAtMs: nowMs,
    stateUpdatedAtMs: Date.parse(state.updatedAt),
    maximumAgeMs: 3_900_000,
    accountId: state.account.id,
    equity: state.account.equity,
    openPositionCount: flat ? 0 : 1,
    stateDigestSha256: sha256(canonicalJson(state)),
    state,
    immutable: true,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
  };
}

test('login identity mapping matches the application internal-email contract', () => {
  const normalized = '승재'.normalize('NFKC').toLowerCase();
  const digest = createHash('sha256').update(`seungjae-stock-account:${normalized}`).digest('hex').slice(0, 40);
  assert.equal(internalEmail('  승재  '), `${digest}@accounts.seungjae-stock.com`);
});

test('binding is exact-target, exact-account and execution-authority NONE only', () => {
  const binding = {
    schemaVersion: 'paper-state-publisher-runtime-binding-v1',
    paperRuntimeSourceSha: TARGET,
    snapshotPath: SNAPSHOT_PATH,
    publisherAccountIdSha256: PUBLISHER_DIGEST,
    immutable: true,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
  };
  assert.equal(validateBinding(binding, { targetSha: TARGET, publisherDigest: PUBLISHER_DIGEST, snapshotPath: SNAPSHOT_PATH }), binding);
  assert.throws(() => validateBinding({ ...binding, publisherAccountIdSha256: '0'.repeat(64) }, {
    targetSha: TARGET,
    publisherDigest: PUBLISHER_DIGEST,
    snapshotPath: SNAPSHOT_PATH,
  }), /BINDING_ACCOUNT_MISMATCH/);
});

test('recovery accepts one integrity-valid stale-source open position but rejects pending or ambiguous position state', () => {
  const snapshot = snapshotFixture();
  const recovered = validateRecoverySnapshot(snapshot, { publisherDigest: PUBLISHER_DIGEST });
  assert.equal(recovered.symbol, 'BTCUSDT');
  assert.equal(recovered.openCount, 1);
  assert.equal(recovered.pendingCount, 0);
  assert.notEqual(snapshot.sourceSha, TARGET, 'recovery seed may predate the new exact runtime binding');

  const withPending = structuredClone(snapshot);
  withPending.state.orders.push({ id: 'pending', symbol: 'ETHUSDT', status: 'pending' });
  withPending.stateDigestSha256 = sha256(canonicalJson(withPending.state));
  assert.throws(() => validateRecoverySnapshot(withPending, { publisherDigest: PUBLISHER_DIGEST }), /RECOVERY_PENDING_ORDER_BLOCK/);

  const twoOpen = structuredClone(snapshot);
  twoOpen.state.positions.push({ ...twoOpen.state.positions[0], id: 'second', symbol: 'ETHUSDT' });
  twoOpen.openPositionCount = 2;
  twoOpen.stateDigestSha256 = sha256(canonicalJson(twoOpen.state));
  assert.throws(() => validateRecoverySnapshot(twoOpen, { publisherDigest: PUBLISHER_DIGEST }), /RECOVERY_REQUIRES_EXACTLY_ONE_OPEN_POSITION/);
});

test('fresh public market must match the exact open-position symbol', () => {
  const nowMs = Date.parse('2026-08-24T01:45:30.000Z');
  const market = {
    symbol: 'BTCUSDT',
    status: 'live',
    updatedAt: new Date(nowMs - 2_000).toISOString(),
    bidPrice: 64000,
    askPrice: 64001,
    markPrice: 64000.5,
    price: 64000.5,
    warnings: [],
  };
  assert.equal(validateFreshMarket(market, { symbol: 'BTCUSDT', nowMs }), market);
  assert.throws(() => validateFreshMarket({ ...market, symbol: 'ETHUSDT' }, { symbol: 'BTCUSDT', nowMs }), /MARKET_SYMBOL_MISMATCH/);
  assert.throws(() => validateFreshMarket({ ...market, updatedAt: new Date(nowMs - 60_001).toISOString() }, { symbol: 'BTCUSDT', nowMs }), /MARKET_STALE/);
});

test('close action is deterministic, 100 percent, manual_close and contains no live order authority', () => {
  const snapshot = snapshotFixture();
  const market = {
    symbol: 'BTCUSDT', status: 'live', updatedAt: new Date().toISOString(),
    bidPrice: 64000, askPrice: 64001, markPrice: 64000.5, price: 64000.5, warnings: [],
  };
  const action = buildCloseAction({ snapshotDigest: snapshot.stateDigestSha256, positionId: 'paper_position_fixture', market });
  assert.deepEqual({ type: action.type, percentage: action.percentage, reason: action.reason }, {
    type: 'close_position', percentage: 100, reason: 'manual_close',
  });
  assert.match(action.eventId, /^paper-flat-recovery:[0-9a-f]{24}$/);
  assert.equal('order' in action, false);
});

test('close response must be PUBLISHED and digest-identical to the returned flat Paper state', () => {
  const nowMs = Date.now();
  const state = stateFixture({ flat: true, updatedAt: new Date(nowMs - 500).toISOString() });
  const stateDigestSha256 = sha256(canonicalJson(state));
  const response = {
    ok: true,
    mode: 'paper-only',
    orderSubmitted: false,
    exchangeRequestSent: false,
    result: {
      ok: true,
      mode: 'paper-only',
      orderSubmitted: false,
      exchangeRequestSent: false,
      state,
      position: state.positions[0],
      fills: [{ fillReason: 'manual_close' }],
      warnings: [],
      duplicateEvent: false,
    },
    paperStateTransport: {
      status: 'PUBLISHED',
      reason: null,
      publisherAccountBound: true,
      stateDigestSha256,
      observedAtMs: nowMs,
      executionAuthority: 'NONE',
      privateApiAllowed: false,
      liveTrading: false,
      financialMutationAllowed: false,
    },
  };
  const accepted = validateCloseResponse(response, { targetSha: TARGET, publisherDigest: PUBLISHER_DIGEST });
  assert.equal(accepted.transportDigest, stateDigestSha256);
  assert.throws(() => validateCloseResponse({
    ...response,
    paperStateTransport: { ...response.paperStateTransport, status: 'BLOCKED_DATA', reason: 'blocked' },
  }, { targetSha: TARGET, publisherDigest: PUBLISHER_DIGEST }), /CLOSE_PUBLISHER_NOT_PUBLISHED/);
});

test('persisted final snapshot must be exact-runtime, published digest, flat and manual-close journaled', () => {
  const snapshot = snapshotFixture({ flat: true, sourceSha: TARGET, nowMs: Date.now() - 250 });
  assert.equal(validateFlatSnapshot(snapshot, {
    targetSha: TARGET,
    publisherDigest: PUBLISHER_DIGEST,
    expectedDigest: snapshot.stateDigestSha256,
  }), true);
  const notFlat = structuredClone(snapshot);
  notFlat.openPositionCount = 1;
  assert.throws(() => validateFlatSnapshot(notFlat, {
    targetSha: TARGET,
    publisherDigest: PUBLISHER_DIGEST,
    expectedDigest: notFlat.stateDigestSha256,
  }), /FINAL_SNAPSHOT_NOT_FLAT/);
});

test('source contract cannot directly overwrite snapshot, mutate cron, deploy app, or call private trading/order paths', () => {
  const script = readFileSync(new URL('../../ops/run-paper-forward-one-shot-close.mjs', import.meta.url), 'utf8');
  for (const forbidden of [
    'writeFile(', 'rename(', 'unlink(', 'rm(', 'crontab -', 'pm2 restart', 'pm2 reload', 'deploy-production',
    '/api/trade-automation', '/api/crypto/futures/auto', '/api/crypto/spot/accounts', '/api/crypto/futures/account',
    '/api/crypto/futures/positions', '/api/stocks/auto-trade', 'LIVE_TRADING=true', 'REAL_ORDER_ENABLED=true',
    'PRIVATE_TRADING_API_ALLOWED=true',
  ]) assert.equal(script.includes(forbidden), false, forbidden);
  assert.match(script, /\/api\/paper-trading\/evaluate/);
  assert.match(script, /\/api\/crypto\/futures\/\$\{encodeURIComponent\(recovery\.symbol\)\}\/snapshot/);
  assert.match(script, /paperStateTransport/);
  assert.match(script, /naturalSampleCredit:\s*0/);
  assert.match(script, /naturalSettlementCredit:\s*0/);
});

test('workflow contract is owner-commanded, protected, one-shot only and has no scheduler', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/paper-forward-one-shot-close.yml', import.meta.url), 'utf8');
  assert.match(workflow, /startsWith\(github\.event\.comment\.body, '\/run-paper-forward-one-shot-close '\)/);
  assert.match(workflow, /environment:\s*production/);
  assert.match(workflow, /github\.event\.issue\.number == 23/);
  assert.match(workflow, /github\.event\.issue\.title == 'Staging Readiness Control'/);
  assert.match(workflow, /github\.event\.comment\.user\.login == 'seungjae3908-source'/);
  assert.match(workflow, /paper-forward-publisher-binding-\$\{target\}/);
  assert.match(workflow, /Production Deploy/);
  assert.match(workflow, /PAPER_ONE_SHOT_EXECUTE=1/);
  assert.match(workflow, /natural sample credit: `0`/i);
  assert.equal(/^\s*schedule:/mu.test(workflow), false);
  assert.equal(/^\s*workflow_dispatch:/mu.test(workflow), false);
  assert.equal(/actions:\s*write/u.test(workflow), false);
});
