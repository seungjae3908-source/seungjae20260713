import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_TRADING_V2_CONFIG,
  assertAutoTradingV2Transition,
  autoTradingV2OwnTrendGate,
  autoTradingV2PositionSizing,
  autoTradingV2Regime,
  autoTradingV2SignalKey,
  autoTradingV2StopPrice,
  autoTradingV2TargetPrice,
  evaluateAutoTradingV2KillSwitch,
  evaluateAutoTradingV2Signal,
  simulateAutoTradingV2Execution,
  type AutoTradingV2MarketSnapshot,
} from './auto-trading-v2.service';

function snapshot(overrides: Partial<AutoTradingV2MarketSnapshot> = {}): AutoTradingV2MarketSnapshot {
  return {
    symbol: 'BTCUSDT',
    observedAt: new Date().toISOString(),
    source: 'BINANCE_USDT_M_PUBLIC',
    publicOnly: true,
    closedCandleOnly: true,
    markPrice: 100,
    indexPrice: 100,
    bidPrice: 99.99,
    askPrice: 100.01,
    spreadPercent: 0.02,
    markIndexDislocationPercent: 0,
    fundingRate: 0.0001,
    nextFundingTime: Date.now() + 8 * 60 * 60 * 1000,
    btc1dClose: 110,
    btc1dMa20: 100,
    btc1hClose: 105,
    btc1hMa20: 100,
    symbol1hClose: 105,
    symbol1hMa20: 100,
    symbol5mClose: 101,
    symbol5mMa20: 100,
    atr14: 1,
    atrPercent: 1,
    oneMinuteMovePercent: 0.1,
    expansionRvolPercent: 450,
    volumeContraction: true,
    pullbackDistancePercent: 0.2,
    continuationLong: true,
    continuationShort: false,
    lastClosedCandleTime: 1_786_575_000_000,
    dataStale: false,
    ...overrides,
  };
}

test('BTC 1D + 1H closed-candle regime resolves LONG, SHORT, conflict', () => {
  assert.equal(autoTradingV2Regime({ btc1dClose: 110, btc1dMa20: 100, btc1hClose: 105, btc1hMa20: 100 }), 'LONG_ONLY');
  assert.equal(autoTradingV2Regime({ btc1dClose: 90, btc1dMa20: 100, btc1hClose: 95, btc1hMa20: 100 }), 'SHORT_ONLY');
  assert.equal(autoTradingV2Regime({ btc1dClose: 110, btc1dMa20: 100, btc1hClose: 95, btc1hMa20: 100 }), 'NO_TRADE');
});

test('symbol own trend gate blocks bearish alt even when BTC is long', () => {
  assert.equal(autoTradingV2OwnTrendGate('LONG_ONLY', 95, 100), false);
  assert.equal(autoTradingV2OwnTrendGate('LONG_ONLY', 105, 100), true);
  const decision = evaluateAutoTradingV2Signal(snapshot({ symbol: 'SOLUSDT', symbol1hClose: 95, symbol1hMa20: 100 }), {
    equityKrw: 1_000_000,
    mode: 'PAPER',
  });
  assert.equal(decision.regime, 'LONG_ONLY');
  assert.equal(decision.allowed, false);
  assert.ok(decision.blockReasons.includes('SYMBOL_TREND_GATE'));
});

test('position sizing keeps account risk fixed while leverage only changes required margin', () => {
  const lowLeverage = autoTradingV2PositionSizing({
    equityKrw: 1_000_000,
    riskPerTradePercent: 0.5,
    leverage: 2,
    entryPrice: 100,
    stopPrice: 98.5,
    feePercent: 0.1,
    slippagePercent: 0.05,
    spreadPercent: 0.05,
  });
  const highLeverage = autoTradingV2PositionSizing({
    equityKrw: 1_000_000,
    riskPerTradePercent: 0.5,
    leverage: 5,
    entryPrice: 100,
    stopPrice: 98.5,
    feePercent: 0.1,
    slippagePercent: 0.05,
    spreadPercent: 0.05,
  });
  assert.equal(lowLeverage.allowedLossKrw, 5_000);
  assert.equal(highLeverage.allowedLossKrw, 5_000);
  assert.ok(Math.abs(lowLeverage.positionNotionalKrw - highLeverage.positionNotionalKrw) < 1e-8);
  assert.ok(highLeverage.requiredMarginKrw < lowLeverage.requiredMarginKrw);
  assert.equal(highLeverage.leverage, 5);
});

test('risk per trade and leverage are hard capped at P0 safety values', () => {
  const result = autoTradingV2PositionSizing({
    equityKrw: 1_000_000,
    riskPerTradePercent: 5,
    leverage: 20,
    entryPrice: 100,
    stopPrice: 98,
  });
  assert.equal(result.riskPerTradePercent, AUTO_TRADING_V2_CONFIG.riskPerTradeMaxPercent);
  assert.equal(result.leverage, AUTO_TRADING_V2_CONFIG.leverageCap);
  assert.equal(result.allowedLossKrw, 5_000);
});

test('fixed and ATR stops plus TP1 are direction aware', () => {
  assert.equal(autoTradingV2StopPrice('LONG', 100, 1, 'FIXED_STOP'), 98.5);
  assert.equal(autoTradingV2StopPrice('SHORT', 100, 1, 'FIXED_STOP'), 101.5);
  assert.equal(autoTradingV2StopPrice('LONG', 100, 2, 'ATR_STOP', 2), 96);
  assert.equal(autoTradingV2StopPrice('SHORT', 100, 2, 'ATR_STOP', 2), 104);
  assert.equal(autoTradingV2TargetPrice('LONG', 100), 103.5);
  assert.equal(autoTradingV2TargetPrice('SHORT', 100), 96.5);
});

test('multi-layer kill switch disables entries and escalates severe states', () => {
  const soft = evaluateAutoTradingV2KillSwitch({ dailyPnlPercent: -1.5 });
  assert.equal(soft.newEntryDisabled, true);
  assert.equal(soft.safeHalt, false);
  assert.ok(soft.reasons.includes('DAILY_LOSS_LIMIT'));

  const hard = evaluateAutoTradingV2KillSwitch({
    dailyPnlPercent: -2,
    consecutiveLosses: 3,
    protectiveStopMissing: true,
  });
  assert.equal(hard.newEntryDisabled, true);
  assert.equal(hard.safeHalt, true);
  assert.ok(hard.reasons.includes('DAILY_LOSS_HARD_CAP'));
  assert.ok(hard.reasons.includes('CONSECUTIVE_LOSSES'));
  assert.ok(hard.reasons.includes('PROTECTIVE_STOP_MISSING'));
});

test('market data and state mismatches disable new entries', () => {
  const decision = evaluateAutoTradingV2KillSwitch({
    marketDataStale: true,
    websocketDisconnected: true,
    orderStateMismatch: true,
    positionStateMismatch: true,
    spreadAbnormal: true,
    volatilityAbnormal: true,
  });
  assert.equal(decision.newEntryDisabled, true);
  assert.equal(decision.safeHalt, true);
  assert.ok(decision.reasons.includes('MARKET_DATA_STALE'));
  assert.ok(decision.reasons.includes('ORDER_STATE_MISMATCH'));
  assert.ok(decision.reasons.includes('POSITION_STATE_MISMATCH'));
});

test('signal lifecycle identity is deterministic and candle scoped', () => {
  const first = autoTradingV2SignalKey({ symbol: 'BTCUSDT', direction: 'LONG', candleCloseTime: 1000 });
  const duplicate = autoTradingV2SignalKey({ symbol: 'BTCUSDT', direction: 'LONG', candleCloseTime: 1000 });
  const next = autoTradingV2SignalKey({ symbol: 'BTCUSDT', direction: 'LONG', candleCloseTime: 2000 });
  assert.deepEqual(first, duplicate);
  assert.notEqual(first.signalId, next.signalId);
  assert.notEqual(first.idempotencyKey, next.idempotencyKey);
});

test('pullback decision requires regime, own trend, RVOL, contraction and continuation', () => {
  const ready = evaluateAutoTradingV2Signal(snapshot(), {
    equityKrw: 1_000_000,
    mode: 'PAPER',
    riskPerTradePercent: 0.25,
    leverage: 3,
  });
  assert.equal(ready.allowed, true);
  assert.equal(ready.direction, 'LONG');
  assert.equal(ready.eligibility, 'PAPER_READY');
  assert.equal(ready.orderPlan?.marginMode, 'ISOLATED');
  assert.ok((ready.orderPlan?.position.allowedLossKrw ?? 0) <= 2_500 + 1e-8);

  const noRvol = evaluateAutoTradingV2Signal(snapshot({ expansionRvolPercent: 250 }), {
    equityKrw: 1_000_000,
    mode: 'PAPER',
  });
  assert.equal(noRvol.allowed, false);
  assert.ok(noRvol.blockReasons.includes('PULLBACK_PATTERN_NOT_READY'));
});

test('LIVE mode is backend-locked before any execution plan can be created', () => {
  assert.throws(() => evaluateAutoTradingV2Signal(snapshot(), {
    equityKrw: 1_000_000,
    mode: 'LIVE',
  }), /AUTO_TRADING_V2_LIVE_LOCKED/);
});

test('execution state machine reaches POSITION_PROTECTED without real/private calls', () => {
  const decision = evaluateAutoTradingV2Signal(snapshot(), { equityKrw: 1_000_000, mode: 'SHADOW' });
  const execution = simulateAutoTradingV2Execution(decision, 'SHADOW');
  assert.deepEqual(execution.states, [
    'SIGNAL_DETECTED', 'SIGNAL_VALIDATED', 'RISK_APPROVED', 'ORDER_PLANNED',
    'ENTRY_SUBMITTED', 'ENTRY_FILLED', 'STOP_REGISTERED', 'TP_REGISTERED', 'POSITION_PROTECTED',
  ]);
  assert.equal(execution.positionProtected, true);
  assert.equal(execution.realOrderCount, 0);
  assert.equal(execution.realCancelCount, 0);
  assert.equal(execution.privateTradingApiCount, 0);
});

test('partial fill shares the same state machine and remains protected', () => {
  const decision = evaluateAutoTradingV2Signal(snapshot(), { equityKrw: 1_000_000, mode: 'PAPER' });
  const execution = simulateAutoTradingV2Execution(decision, 'PAPER', { partialFillFraction: 0.4 });
  assert.ok(execution.states.includes('ENTRY_PARTIAL'));
  assert.equal(execution.positionProtected, true);
});

test('protective stop registration failure goes ERROR then SAFE_HALT', () => {
  const decision = evaluateAutoTradingV2Signal(snapshot(), { equityKrw: 1_000_000, mode: 'PAPER' });
  const execution = simulateAutoTradingV2Execution(decision, 'PAPER', { stopRegistrationFails: true });
  assert.deepEqual(execution.states.slice(-2), ['ERROR', 'SAFE_HALT']);
  assert.equal(execution.positionProtected, false);
  assert.equal(execution.errorCode, 'PROTECTIVE_STOP_MISSING');
  assert.equal(execution.realOrderCount, 0);
  assert.equal(execution.privateTradingApiCount, 0);
});

test('invalid execution transition is rejected', () => {
  assert.throws(() => assertAutoTradingV2Transition('SIGNAL_DETECTED', 'ENTRY_FILLED'), /INVALID_STATE_TRANSITION/);
});
