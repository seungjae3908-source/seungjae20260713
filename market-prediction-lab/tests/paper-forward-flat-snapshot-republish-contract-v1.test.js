import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  canonicalJson,
  sha256,
  validateBinding,
  validateFlatSnapshotForRepublish,
  buildRepublishRequest,
  expectedNormalizedRiskState,
  validateRepublishResponse,
  validateFinalSnapshot,
} from '../../ops/run-paper-forward-flat-snapshot-republish.mjs';

const OLD_SHA = '30c750562fdde49428e4ddd17b889c1bd63ccee8';
const TARGET_SHA = 'a6b0ad25637d61752e44c9e298849029c4c62f2d';
const PUBLISHER = 'a'.repeat(64);
const SNAPSHOT_PATH = '/opt/stock-app-data/paper-forward-v1/publisher/paper-state-v2.json';
const WORKFLOW_FILE = new URL('../../.github/workflows/paper-forward-flat-snapshot-republish.yml', import.meta.url);
const RUNTIME_FILE = new URL('../../ops/run-paper-forward-flat-snapshot-republish.mjs', import.meta.url);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fixtureState() {
  return {
    schemaVersion: 1,
    account: {
      id: 'paper_account_fixture',
      initialBalance: 10000,
      cashBalance: 9876.5,
      realizedPnl: -123.5,
      unrealizedPnl: 0,
      equity: 9876.5,
      usedMargin: 0,
      availableMargin: 9876.5,
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-24T03:20:00.000Z',
    },
    orders: [{
      id: 'order_1',
      symbol: 'BTCUSDT',
      status: 'filled',
      mode: 'paper-only',
      orderSubmitted: false,
      exchangeRequestSent: false,
    }],
    positions: [{
      id: 'position_1',
      symbol: 'BTCUSDT',
      status: 'closed',
      currentPrice: 64000,
      entryPrice: 65000,
      remainingQuantity: 0,
      notionalValue: 0,
      requiredMargin: 0,
      unrealizedPnl: 0,
    }],
    fills: [{
      id: 'fill_1',
      positionId: 'position_1',
      fillReason: 'manual_close',
      price: 64000,
      quantity: 0.1,
    }],
    journal: [{
      id: 'journal_1',
      positionId: 'position_1',
      symbol: 'BTCUSDT',
      status: 'closed',
      exitReason: 'manual_close',
      exitPrice: 64000,
      entryPrice: 65000,
      remainingQuantity: 0,
      netPnl: -123.5,
    }],
    riskState: {
      dayKey: '2026-08-24',
      weekKey: '2026-W35',
      dailyRealizedPnl: -123.5,
      weeklyRealizedPnl: -123.5,
      consecutiveLosses: 1,
    },
    processedEventIds: ['paper-flat-recovery:abcdef123456abcdef123456'],
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-24T03:20:00.000Z',
  };
}

function binding(sourceSha = OLD_SHA) {
  return {
    schemaVersion: 'paper-state-publisher-runtime-binding-v1',
    paperRuntimeSourceSha: sourceSha,
    snapshotPath: SNAPSHOT_PATH,
    publisherAccountIdSha256: PUBLISHER,
    immutable: true,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
  };
}

function snapshot(sourceSha = OLD_SHA, state = fixtureState()) {
  return {
    schemaVersion: 'paper-trading-state-snapshot-v2',
    paperStateSchemaVersion: 1,
    sourceOwner: 'authenticated-paper-trading-evaluate-v2',
    sourceSha,
    market: 'CRYPTO_FUTURES',
    currency: 'USDT',
    provenance: [
      'authenticated-member-session',
      'paper-trading-engine-result',
      'lossless-atomic-shared-path',
      'paper-runtime-source-binding',
    ],
    publisherAccountIdSha256: PUBLISHER,
    observedAtMs: Date.parse(state.updatedAt),
    stateUpdatedAtMs: Date.parse(state.updatedAt),
    maximumAgeMs: 3_900_000,
    accountId: state.account.id,
    equity: state.account.equity,
    openPositionCount: 0,
    stateDigestSha256: sha256(canonicalJson(state)),
    state,
    immutable: true,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
  };
}

function responseFor(beforeSnapshot, targetSha, nowMs) {
  const built = buildRepublishRequest(beforeSnapshot, targetSha, nowMs);
  const state = clone(beforeSnapshot.state);
  state.riskState = expectedNormalizedRiskState(state.riskState, built.nowIso);
  state.processedEventIds = [...state.processedEventIds, built.eventId].slice(-500);
  state.account.updatedAt = built.nowIso;
  state.updatedAt = built.nowIso;
  const stateDigest = sha256(canonicalJson(state));
  return {
    built,
    body: {
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
        order: null,
        position: null,
        fills: [],
        warnings: [],
        duplicateEvent: false,
      },
      paperStateTransport: {
        schemaVersion: 'paper-state-transport-publish-result-v2',
        status: 'PUBLISHED',
        invoked: true,
        callbackEligible: true,
        reason: null,
        snapshotSchemaVersion: 'paper-trading-state-snapshot-v2',
        publisherAccountBound: true,
        stateDigestSha256: stateDigest,
        observedAtMs: nowMs,
        executionAuthority: 'NONE',
        privateApiAllowed: false,
        liveTrading: false,
        financialMutationAllowed: false,
        unknownIsZero: false,
      },
    },
  };
}

test('accepts only an integrity-valid flat predecessor snapshot bound to the same publisher', () => {
  const value = snapshot();
  const result = validateFlatSnapshotForRepublish(value, {
    binding: binding(),
    targetSha: TARGET_SHA,
    publisherDigest: PUBLISHER,
    snapshotPath: SNAPSHOT_PATH,
  });
  assert.equal(result.previousSourceSha, OLD_SHA);
  assert.equal(result.anchor.symbol, 'BTCUSDT');
  assert.equal(result.anchor.price, 64000);
});

test('rejects target-source replay, open exposure, pending orders, and publisher mismatch', () => {
  assert.throws(() => validateFlatSnapshotForRepublish(snapshot(TARGET_SHA), {
    binding: binding(TARGET_SHA),
    targetSha: TARGET_SHA,
    publisherDigest: PUBLISHER,
    snapshotPath: SNAPSHOT_PATH,
  }), /SNAPSHOT_ALREADY_TARGET_SOURCE/);

  const openState = fixtureState();
  openState.positions[0].status = 'open';
  openState.positions[0].remainingQuantity = 0.1;
  const openSnapshot = snapshot(OLD_SHA, openState);
  assert.throws(() => validateFlatSnapshotForRepublish(openSnapshot, {
    binding: binding(),
    targetSha: TARGET_SHA,
    publisherDigest: PUBLISHER,
    snapshotPath: SNAPSHOT_PATH,
  }), /REPUBLISH_REQUIRES_FLAT_POSITION_STATE/);

  const pendingState = fixtureState();
  pendingState.orders[0].status = 'pending';
  const pendingSnapshot = snapshot(OLD_SHA, pendingState);
  assert.throws(() => validateFlatSnapshotForRepublish(pendingSnapshot, {
    binding: binding(),
    targetSha: TARGET_SHA,
    publisherDigest: PUBLISHER,
    snapshotPath: SNAPSHOT_PATH,
  }), /REPUBLISH_PENDING_ORDER_BLOCK/);

  assert.throws(() => validateBinding(binding(), {
    snapshotPath: SNAPSHOT_PATH,
    publisherDigest: 'b'.repeat(64),
  }), /BINDING_ACCOUNT_MISMATCH/);
});

test('builds a mark-price freshness event anchored to a closed position and never a trade action', () => {
  const value = snapshot();
  const built = buildRepublishRequest(value, TARGET_SHA, Date.parse('2026-08-24T03:45:00.000Z'));
  assert.equal(built.request.action.type, 'mark_price');
  assert.equal(built.request.action.symbol, 'BTCUSDT');
  assert.equal(built.request.action.price, 64000);
  assert.equal(built.request.action.at, built.nowIso);
  assert.match(built.eventId, /^paper-flat-republish:[0-9a-f]{12}:[0-9a-f]{12}$/);
  assert.equal('quantity' in built.request.action, false);
  assert.equal('percentage' in built.request.action, false);
});

test('accepts republish response only when financial state and trade history are preserved exactly', () => {
  const before = snapshot();
  const { built, body } = responseFor(before, TARGET_SHA, Date.parse('2026-08-25T03:45:00.000Z'));
  const result = validateRepublishResponse(body, {
    beforeState: before.state,
    eventId: built.eventId,
    nowIso: built.nowIso,
  });
  assert.equal(result.state.account.cashBalance, before.state.account.cashBalance);
  assert.equal(result.state.account.realizedPnl, before.state.account.realizedPnl);
  assert.deepEqual(result.state.positions, before.state.positions);
  assert.deepEqual(result.state.orders, before.state.orders);
  assert.deepEqual(result.state.fills, before.state.fills);
  assert.deepEqual(result.state.journal, before.state.journal);
  assert.equal(result.state.riskState.dailyRealizedPnl, 0);
  assert.equal(result.state.riskState.weeklyRealizedPnl, -123.5);
});

test('fails closed on any account financial, position, fill, or journal mutation', () => {
  const before = snapshot();
  const nowMs = Date.parse('2026-08-24T03:45:00.000Z');
  const base = responseFor(before, TARGET_SHA, nowMs);

  for (const mutate of [
    (body) => { body.result.state.account.cashBalance -= 1; },
    (body) => { body.result.state.positions[0].currentPrice += 1; },
    (body) => { body.result.state.fills.push({ id: 'unexpected' }); },
    (body) => { body.result.state.journal[0].netPnl -= 1; },
  ]) {
    const body = clone(base.body);
    mutate(body);
    body.paperStateTransport.stateDigestSha256 = sha256(canonicalJson(body.result.state));
    assert.throws(() => validateRepublishResponse(body, {
      beforeState: before.state,
      eventId: base.built.eventId,
      nowIso: base.built.nowIso,
    }), /REPUBLISH_/);
  }
});

test('requires the final immutable snapshot to be target-bound, fresh, flat and byte-equivalent to the published state', () => {
  const before = snapshot();
  const nowMs = Date.parse('2026-08-24T03:45:00.000Z');
  const { built, body } = responseFor(before, TARGET_SHA, nowMs);
  const published = validateRepublishResponse(body, {
    beforeState: before.state,
    eventId: built.eventId,
    nowIso: built.nowIso,
  });
  const final = snapshot(TARGET_SHA, published.state);
  final.observedAtMs = nowMs;
  final.stateUpdatedAtMs = nowMs;
  final.stateDigestSha256 = published.stateDigest;
  assert.equal(validateFinalSnapshot(final, {
    targetSha: TARGET_SHA,
    publisherDigest: PUBLISHER,
    responseState: published.state,
    responseDigest: published.stateDigest,
    nowMs: nowMs + 1_000,
  }), true);

  const mutated = clone(final);
  mutated.state.journal = [];
  assert.throws(() => validateFinalSnapshot(mutated, {
    targetSha: TARGET_SHA,
    publisherDigest: PUBLISHER,
    responseState: published.state,
    responseDigest: published.stateDigest,
    nowMs: nowMs + 1_000,
  }), /FINAL_SNAPSHOT_RESPONSE_MISMATCH|SNAPSHOT_DIGEST/);
});

test('workflow is approval-gated, current-main exact, and has no schedule activation trigger', () => {
  const workflow = fs.readFileSync(WORKFLOW_FILE, 'utf8');
  assert.match(workflow, /environment:\s*production/);
  assert.match(workflow, /\/run-paper-forward-flat-snapshot-republish /);
  assert.match(workflow, /Required CI 6\/6/);
  assert.match(workflow, /Staging Readiness/);
  assert.match(workflow, /Staging PostgreSQL Auth Gate/);
  assert.match(workflow, /Production Deploy/);
  assert.match(workflow, /PAPER_FLAT_SNAPSHOT_REPUBLISH_EXECUTE=1/);
  assert.doesNotMatch(workflow, /^\s*schedule:/m);
  assert.doesNotMatch(workflow, /install-paper-forward-schedule\.sh/);
  assert.doesNotMatch(workflow, /activate-paper-forward/);
});

test('runtime source contains rollback and zero-authority safety contracts', () => {
  const source = fs.readFileSync(RUNTIME_FILE, 'utf8');
  assert.match(source, /restoreOriginals/);
  assert.match(source, /REPUBLISH_ROLLBACK/);
  assert.match(source, /paperFinancialMutation:\s*0/);
  assert.match(source, /paperTradeMutation:\s*0/);
  assert.match(source, /naturalSampleCredit:\s*0/);
  assert.match(source, /naturalSettlementCredit:\s*0/);
  assert.match(source, /privateApiUsed:\s*false/);
  assert.match(source, /executionAuthority:\s*'NONE'/);
  assert.doesNotMatch(source, /api\.bitget\.com|api\.upbit\.com|\/api\/(?:orders?|withdraw|transfer)/i);
});
