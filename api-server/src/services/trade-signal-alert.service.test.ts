import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveTradeSignalAlerts, listTradeSignalAlerts } from './trade-signal-alert.service';
import type { TradingPlan, TradingSignalStateEvent } from './trade-automation.types';

const NOW = new Date();

function event(
  fromState: TradingSignalStateEvent['fromState'],
  toState: TradingSignalStateEvent['toState'],
  reason: string,
  offsetMs: number,
): TradingSignalStateEvent {
  return {
    fromState,
    toState,
    reason,
    score: toState === 'READY_FOR_APPROVAL' ? 82 : 55,
    confidence: toState === 'READY_FOR_APPROVAL' ? 78 : 50,
    coreConditionsMaintained: toState === 'READY_FOR_APPROVAL',
    riskReward: 1.8,
    dataTimestamp: new Date(NOW.getTime() + offsetMs).toISOString(),
    createdAt: new Date(NOW.getTime() + offsetMs).toISOString(),
  };
}

function plan(history: TradingSignalStateEvent[], overrides: Partial<TradingPlan> = {}): TradingPlan {
  const latest = history.at(-1) ?? event(null, 'READY_FOR_APPROVAL', 'SIGNAL_READY', 0);
  return {
    id: 'plan-1', userId: 'user-1', idempotencyKey: 'key-1', state: 'APPROVAL_PENDING',
    approvalExpiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(), approvedAt: null,
    exchange: 'kiwoom', accountMode: 'paper', strategyId: 'scanner-1d', signalId: 'signal-1',
    symbol: '005930', market: 'KR', side: 'buy', orderType: 'market', quantity: 1,
    quoteAmount: null, limitPrice: null, estimatedKrw: 70_000, stopPrice: 67_000,
    targetPrices: [74_500], splitRatios: [100], leverage: null, marginMode: null,
    reduceOnly: false, invalidateAction: 'hold', signalReasons: ['trend'], signalWarnings: [],
    signalScore: latest.score, signalConfidence: latest.confidence, minimumSignalScore: 70,
    minimumSignalConfidence: 60, minimumRiskReward: 1.5, signalRiskReward: 1.8,
    signalCoreConditionsMaintained: latest.toState === 'READY_FOR_APPROVAL',
    signalExpiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    lastSignalValidatedAt: latest.createdAt, signalState: latest.toState,
    signalInvalidationReason: latest.toState === 'READY_FOR_APPROVAL' ? null : latest.reason,
    signalStateHistory: history, scannerContext: null,
    marketSnapshot: {
      observedAt: latest.createdAt, dataDelayMs: 0, oneMinuteMovePercent: 0,
      spreadPercent: 0.01, orderbookGapPercent: 0.01, halted: false,
      availableBalance: 1_000_000, accountValueKrw: 1_000_000, dailyPnlPercent: 0,
      assetExposurePercent: 0, openPositionCount: 0, dailyOrderCount: 0, consecutiveLosses: 0,
    },
    createdAt: history[0]?.createdAt ?? NOW.toISOString(), updatedAt: latest.createdAt,
    ...overrides,
  };
}

test('emits one met alert and only one maintained alert per ready cycle', () => {
  const history = [
    event(null, 'READY_FOR_APPROVAL', 'SIGNAL_READY', -3_000),
    event('READY_FOR_APPROVAL', 'READY_FOR_APPROVAL', 'SIGNAL_READY', -2_000),
    event('READY_FOR_APPROVAL', 'READY_FOR_APPROVAL', 'SIGNAL_READY', -1_000),
  ];
  const alerts = deriveTradeSignalAlerts(plan(history), NOW);
  assert.deepEqual(alerts.map((item) => item.kind).sort(), ['CONDITION_MAINTAINED', 'CONDITION_MET']);
  assert.equal(new Set(alerts.map((item) => item.id)).size, alerts.length);
  assert.ok(alerts.every((item) => item.approvalEnabled));
});

test('condition release disables approval and matches the current signal state', () => {
  const history = [
    event(null, 'READY_FOR_APPROVAL', 'SIGNAL_READY', -2_000),
    event('READY_FOR_APPROVAL', 'INVALIDATED', 'SIGNAL_CORE_CONDITION_BROKEN', -1_000),
  ];
  const alerts = deriveTradeSignalAlerts(plan(history), NOW);
  const released = alerts.find((item) => item.kind === 'CONDITION_RELEASED');
  assert.ok(released);
  assert.equal(released.currentSignalState, 'INVALIDATED');
  assert.equal(released.approvalEnabled, false);
  assert.match(released.message, /주문 승인 불가/);
});

test('re-entry starts a distinct cycle with new deterministic alert ids', () => {
  const history = [
    event(null, 'READY_FOR_APPROVAL', 'SIGNAL_READY', -4_000),
    event('READY_FOR_APPROVAL', 'WEAKENED', 'SIGNAL_SCORE_BELOW_MINIMUM', -3_000),
    event('WEAKENED', 'READY_FOR_APPROVAL', 'SIGNAL_READY', -2_000),
    event('READY_FOR_APPROVAL', 'READY_FOR_APPROVAL', 'SIGNAL_READY', -1_000),
  ];
  const alerts = deriveTradeSignalAlerts(plan(history), NOW);
  assert.equal(alerts.filter((item) => item.kind === 'CONDITION_MET').length, 2);
  assert.deepEqual(
    alerts.filter((item) => item.kind === 'CONDITION_MET').map((item) => item.cycle).sort(),
    [1, 2],
  );
  assert.equal(new Set(alerts.map((item) => item.id)).size, alerts.length);
});

test('wall-clock expiry produces one non-approvable expiry alert', () => {
  const history = [event(null, 'READY_FOR_APPROVAL', 'SIGNAL_READY', -60_000)];
  const expiredPlan = plan(history, {
    signalExpiresAt: new Date(NOW.getTime() - 1_000).toISOString(),
    approvalExpiresAt: new Date(NOW.getTime() - 1_000).toISOString(),
  });
  const alerts = deriveTradeSignalAlerts(expiredPlan, NOW);
  const expiry = alerts.filter((item) => item.kind === 'SIGNAL_EXPIRED');
  assert.equal(expiry.length, 1);
  assert.equal(expiry[0].approvalEnabled, false);
  assert.equal(expiry[0].approvalReasonCode, 'SIGNAL_EXPIRED');
});

test('list function merges plans, sorts newest first, and respects the limit', () => {
  const first = plan([event(null, 'READY_FOR_APPROVAL', 'SIGNAL_READY', -10_000)], { id: 'first' });
  const second = plan([event(null, 'READY_FOR_APPROVAL', 'SIGNAL_READY', -1_000)], { id: 'second', signalId: 'signal-2' });
  const alerts = listTradeSignalAlerts([first, second], NOW, 1);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].planId, 'second');
});
