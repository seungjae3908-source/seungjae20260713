// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPaperTradingAction,
  assertFinitePaperState,
  calculatePaperTradingStatistics,
  createPaperTradingState,
  sanitizePaperJournalNote,
  transitionPaperOrder,
  type PaperContractRules,
  type PaperMarketData,
  type PaperOrder,
  type PaperOrderRequest,
  type PaperTradingState,
} from './paper-trading-engine.service.js';
import type { RiskEngineInput } from './trading-risk-engine.service.js';

const NOW = new Date('2026-08-02T02:30:00.000Z');
const NOW_ISO = NOW.toISOString();

const market = (overrides: Partial<PaperMarketData> = {}): PaperMarketData => ({
  symbol: 'BTCUSDT',
  price: 100,
  lastPrice: 100,
  markPrice: 100,
  bidPrice: 99.9,
  askPrice: 100.1,
  fundingRate: 0.0001,
  status: 'live',
  updatedAt: NOW_ISO,
  warnings: [],
  ...overrides,
});

const rules = (overrides: Partial<PaperContractRules> = {}): PaperContractRules => ({
  symbol: 'BTCUSDT',
  quantityStep: 0.001,
  quantityPrecision: 3,
  minimumQuantity: 0.001,
  minimumNotional: 5,
  maximumLeverage: 10,
  maintenanceMarginRate: 0.005,
  status: 'live',
  updatedAt: NOW_ISO,
  warnings: [],
  ...overrides,
});

const request = (overrides: Partial<PaperOrderRequest> = {}): PaperOrderRequest => ({
  symbol: 'BTCUSDT',
  side: 'long',
  orderType: 'market',
  leverage: 2,
  stopLossPrice: 98,
  takeProfitPrice1: 105,
  takeProfitPrice2: 108,
  targetClosePercent1: 50,
  targetClosePercent2: 50,
  strategyName: 'manual',
  marketRegime: 'trend',
  ...overrides,
});

const riskInput = (overrides: Partial<RiskEngineInput> = {}): RiskEngineInput => ({
  market: 'crypto-futures',
  symbol: 'BTCUSDT',
  side: 'long',
  accountBalance: 10_000,
  entryPrice: 100,
  stopLossPrice: 98,
  targetPrice1: 105,
  targetPrice2: 108,
  leverage: 2,
  riskPercent: 0.5,
  entryFeeRate: 0.0006,
  exitFeeRate: 0.0006,
  slippageRate: 0.0005,
  estimatedFundingRate: 0.0001,
  dataStatus: 'live',
  contractRulesStatus: 'live',
  ...overrides,
});

function place(
  state: PaperTradingState = createPaperTradingState(10_000, NOW),
  options: {
    eventId?: string;
    request?: Partial<PaperOrderRequest>;
    market?: Partial<PaperMarketData>;
    rules?: Partial<PaperContractRules>;
    risk?: Partial<RiskEngineInput>;
    now?: Date;
  } = {},
) {
  const req = request(options.request);
  return applyPaperTradingAction(state, {
    type: 'place_order',
    eventId: options.eventId ?? 'place-1',
    request: req,
    market: market(options.market),
    contractRules: rules(options.rules),
    riskInput: riskInput({
      side: req.side,
      leverage: req.leverage,
      stopLossPrice: req.stopLossPrice,
      targetPrice1: req.takeProfitPrice1,
      targetPrice2: req.takeProfitPrice2,
      ...options.risk,
    }),
  }, options.now ?? NOW);
}

function close(state: PaperTradingState, percentage: 25 | 50 | 75 | 100 = 100, eventId = `close-${percentage}`, at = NOW) {
  const position = state.positions.find((item) => item.status !== 'closed');
  assert.ok(position);
  return applyPaperTradingAction(state, {
    type: 'close_position',
    eventId,
    positionId: position.id,
    percentage,
    market: market({ bidPrice: 104, askPrice: 104.1, price: 104, markPrice: 104, updatedAt: at.toISOString() }),
    at: at.toISOString(),
  }, at);
}

function process(state: PaperTradingState, candle: Partial<{timestamp:number;open:number;high:number;low:number;close:number;isClosed:boolean;symbol:string}>, eventId='candle-1') {
  return applyPaperTradingAction(state, {
    type: 'process_candle',
    eventId,
    candle: {
      symbol: 'BTCUSDT',
      timestamp: NOW.getTime() + 15 * 60_000,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      isClosed: true,
      ...candle,
    },
  }, NOW);
}

test('creates a versioned paper account', () => {
  const state = createPaperTradingState(10_000, NOW);
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.account.cashBalance, 10_000);
  assert.equal(state.account.availableMargin, 10_000);
});

test('rejects zero initial balance', () => assert.throws(() => createPaperTradingState(0, NOW), /초기 자본/));
test('rejects negative initial balance', () => assert.throws(() => createPaperTradingState(-1, NOW), /초기 자본/));

test('market long fills against ask plus adverse slippage', () => {
  const result = place();
  assert.equal(result.order?.status, 'filled');
  assert.equal(result.position?.side, 'long');
  assert.ok((result.position?.entryPrice ?? 0) > 100.1);
});

test('market short fills against bid minus adverse slippage', () => {
  const result = place(undefined, { request: { side: 'short', stopLossPrice: 102, takeProfitPrice1: 95, takeProfitPrice2: 92 }, risk: { side: 'short' } });
  assert.equal(result.order?.status, 'filled');
  assert.equal(result.position?.side, 'short');
  assert.ok((result.position?.entryPrice ?? 100) < 99.9);
});

test('market order falls back to mark price with warning', () => {
  const result = place(undefined, { market: { bidPrice: null, askPrice: null } });
  assert.equal(result.order?.status, 'filled');
  assert.match(result.warnings.join(' '), /실제 호가/);
});

test('market order rejects when no usable price exists', () => {
  const result = place(undefined, { market: { bidPrice: null, askPrice: null, price: null, lastPrice: null, markPrice: null } });
  assert.equal(result.order?.status, 'rejected');
  assert.ok(result.order?.rejectionCodes.includes('MARKET_PRICE_UNAVAILABLE'));
});

test('limit order remains pending before price reach', () => {
  const result = place(undefined, { request: { orderType: 'limit', requestedPrice: 95, stopLossPrice: 92, takeProfitPrice1: 100, takeProfitPrice2: 105 } });
  assert.equal(result.order?.status, 'pending');
  assert.equal(result.position, null);
});

test('long limit fills when completed candle low reaches limit', () => {
  const pending = place(undefined, { request: { orderType: 'limit', requestedPrice: 95, stopLossPrice: 92, takeProfitPrice1: 100, takeProfitPrice2: 105 } });
  const result = process(pending.state, { open: 97, high: 98, low: 94, close: 96 });
  assert.equal(result.order?.status, 'filled');
  assert.equal(result.fills[0]?.fillReason, 'limit');
});

test('short limit fills when completed candle high reaches limit', () => {
  const pending = place(undefined, { request: { side: 'short', orderType: 'limit', requestedPrice: 105, stopLossPrice: 108, takeProfitPrice1: 100, takeProfitPrice2: 98 }, risk: { side: 'short' } });
  const result = process(pending.state, { open: 103, high: 106, low: 102, close: 104 });
  assert.equal(result.order?.status, 'filled');
});

test('favorable long limit gap uses candle open without exceeding limit', () => {
  const pending = place(undefined, { request: { orderType: 'limit', requestedPrice: 95, stopLossPrice: 92, takeProfitPrice1: 100, takeProfitPrice2: 105 } });
  const result = process(pending.state, { open: 93, high: 96, low: 92, close: 94 });
  assert.ok((result.fills[0]?.referencePrice ?? 100) <= 95);
  assert.ok((result.fills[0]?.price ?? 100) <= 95);
});

test('stop market remains pending before trigger', () => {
  const result = place(undefined, { request: { orderType: 'stop_market', triggerPrice: 105, stopLossPrice: 100, takeProfitPrice1: 115, takeProfitPrice2: 120 } });
  assert.equal(result.order?.status, 'pending');
});

test('long stop market fills after trigger', () => {
  const pending = place(undefined, { request: { orderType: 'stop_market', triggerPrice: 105, stopLossPrice: 100, takeProfitPrice1: 115, takeProfitPrice2: 120 } });
  const result = process(pending.state, { open: 103, high: 106, low: 102, close: 105 });
  assert.equal(result.order?.status, 'filled');
  assert.equal(result.fills[0]?.fillReason, 'stop_trigger');
});

test('short stop market fills after downside trigger', () => {
  const pending = place(undefined, { request: { side: 'short', orderType: 'stop_market', triggerPrice: 95, stopLossPrice: 100, takeProfitPrice1: 85, takeProfitPrice2: 80 }, risk: { side: 'short' } });
  const result = process(pending.state, { open: 97, high: 98, low: 94, close: 95 });
  assert.equal(result.order?.status, 'filled');
});

test('pending order can be cancelled', () => {
  const pending = place(undefined, { request: { orderType: 'limit', requestedPrice: 95, stopLossPrice: 92, takeProfitPrice1: 100, takeProfitPrice2: 105 } });
  const result = applyPaperTradingAction(pending.state, { type: 'cancel_order', eventId: 'cancel-1', orderId: pending.order!.id }, NOW);
  assert.equal(result.order?.status, 'cancelled');
});

test('filled order cannot be cancelled', () => {
  const filled = place();
  assert.throws(() => applyPaperTradingAction(filled.state, { type: 'cancel_order', eventId: 'cancel-filled', orderId: filled.order!.id }, NOW), /변경할 수 없습니다/);
});

test('cancelled order cannot fill', () => {
  const pending = place(undefined, { request: { orderType: 'limit', requestedPrice: 95, stopLossPrice: 92, takeProfitPrice1: 100, takeProfitPrice2: 105 } });
  const cancelled = applyPaperTradingAction(pending.state, { type: 'cancel_order', eventId: 'cancel-2', orderId: pending.order!.id }, NOW);
  const result = process(cancelled.state, { open: 95, high: 96, low: 94, close: 95 }, 'after-cancel');
  assert.equal(result.fills.length, 0);
});

test('same event id is idempotent', () => {
  const first = place(undefined, { eventId: 'same-event' });
  const second = place(first.state, { eventId: 'same-event' });
  assert.equal(second.duplicateEvent, true);
  assert.equal(second.state.positions.length, 1);
});

test('invalid event id is rejected', () => assert.throws(() => place(undefined, { eventId: 'bad event' }), /이벤트 ID/));

test('duplicate symbol position is rejected', () => {
  const first = place();
  const second = place(first.state, { eventId: 'place-2' });
  assert.equal(second.order?.status, 'rejected');
  assert.ok(second.order?.rejectionCodes.includes('DUPLICATE_SYMBOL_POSITION'));
});

test('non-live market data rejects paper order', () => {
  const result = place(undefined, { market: { status: 'delayed' } });
  assert.equal(result.order?.status, 'rejected');
  assert.ok(result.order?.rejectionCodes.includes('DATA_NOT_LIVE'));
});

test('stale market timestamp rejects paper order', () => {
  const result = place(undefined, { market: { updatedAt: new Date(NOW.getTime() - 61_000).toISOString() } });
  assert.ok(result.order?.rejectionCodes.includes('DATA_NOT_LIVE'));
});

test('non-live contract rules reject paper order', () => {
  const result = place(undefined, { rules: { status: 'cached' } });
  assert.ok(result.order?.rejectionCodes.includes('CONTRACT_RULES_NOT_LIVE'));
});

test('stale contract rules reject paper order', () => {
  const result = place(undefined, { rules: { updatedAt: new Date(NOW.getTime() - 21 * 60_000).toISOString() } });
  assert.ok(result.order?.rejectionCodes.includes('CONTRACT_RULES_NOT_LIVE'));
});

test('invalid long stop direction is rejected', () => {
  const result = place(undefined, { request: { stopLossPrice: 101 } });
  assert.ok(result.order?.rejectionCodes.includes('INVALID_STOP_LOSS'));
});

test('invalid short stop direction is rejected', () => {
  const result = place(undefined, { request: { side: 'short', stopLossPrice: 99, takeProfitPrice1: 95, takeProfitPrice2: 92 }, risk: { side: 'short' } });
  assert.ok(result.order?.rejectionCodes.includes('INVALID_STOP_LOSS'));
});

test('app leverage limit is enforced', () => {
  const result = place(undefined, { request: { leverage: 11 }, risk: { leverage: 11 } });
  assert.ok(result.order?.rejectionCodes.includes('LEVERAGE_EXCEEDS_APP_LIMIT'));
});

test('exchange leverage limit is enforced', () => {
  const result = place(undefined, { request: { leverage: 6 }, risk: { leverage: 6 }, rules: { maximumLeverage: 5 } });
  assert.ok(result.order?.rejectionCodes.includes('LEVERAGE_EXCEEDS_EXCHANGE_LIMIT'));
});

test('minimum quantity is enforced', () => {
  const result = place(undefined, { rules: { minimumQuantity: 1000 } });
  assert.ok(result.order?.rejectionCodes.includes('MINIMUM_QUANTITY'));
});

test('minimum notional is enforced', () => {
  const result = place(undefined, { rules: { minimumNotional: 1_000_000 } });
  assert.ok(result.order?.rejectionCodes.includes('MINIMUM_NOTIONAL'));
});

test('requested quantity above risk recommendation is rejected', () => {
  const result = place(undefined, { request: { quantity: 999 } });
  assert.ok(result.order?.rejectionCodes.includes('REQUESTED_QUANTITY_EXCEEDS_RISK'));
});

test('insufficient margin is rejected', () => {
  const state = createPaperTradingState(10, NOW);
  const result = place(state, { request: { quantity: 1 }, risk: { accountBalance: 10, riskPercent: 1 } });
  assert.ok(result.order?.rejectionCodes.includes('INSUFFICIENT_MARGIN') || result.order?.status === 'rejected');
});

test('daily loss limit is enforced', () => {
  const state = createPaperTradingState(10_000, NOW);
  state.riskState.dailyRealizedPnl = -100;
  const result = place(state);
  assert.ok(result.order?.rejectionCodes.includes('DAILY_LOSS_LIMIT'));
});

test('weekly loss limit is enforced', () => {
  const state = createPaperTradingState(10_000, NOW);
  state.riskState.weeklyRealizedPnl = -300;
  const result = place(state);
  assert.ok(result.order?.rejectionCodes.includes('WEEKLY_LOSS_LIMIT'));
});

test('consecutive loss limit is enforced', () => {
  const state = createPaperTradingState(10_000, NOW);
  state.riskState.consecutiveLosses = 3;
  const result = place(state);
  assert.ok(result.order?.rejectionCodes.includes('CONSECUTIVE_LOSS_LIMIT'));
});

test('mark price computes long unrealized pnl', () => {
  const opened = place();
  const result = applyPaperTradingAction(opened.state, { type: 'mark_price', eventId: 'mark-long', symbol: 'BTCUSDT', price: 110, at: NOW_ISO }, NOW);
  assert.ok(result.state.account.unrealizedPnl > 0);
});

test('mark price computes short unrealized pnl', () => {
  const opened = place(undefined, { request: { side: 'short', stopLossPrice: 102, takeProfitPrice1: 95, takeProfitPrice2: 92 }, risk: { side: 'short' } });
  const result = applyPaperTradingAction(opened.state, { type: 'mark_price', eventId: 'mark-short', symbol: 'BTCUSDT', price: 90, at: NOW_ISO }, NOW);
  assert.ok(result.state.account.unrealizedPnl > 0);
});

test('25 percent manual close leaves 75 percent', () => {
  const opened = place();
  const result = close(opened.state, 25);
  assert.ok(Math.abs(result.position!.remainingQuantity / result.position!.quantity - 0.75) < 0.001);
  assert.equal(result.position?.status, 'partially_closed');
});

test('50 percent manual close leaves half', () => {
  const opened = place();
  const result = close(opened.state, 50);
  assert.ok(Math.abs(result.position!.remainingQuantity / result.position!.quantity - 0.5) < 0.001);
});

test('75 percent manual close leaves quarter', () => {
  const opened = place();
  const result = close(opened.state, 75);
  assert.ok(Math.abs(result.position!.remainingQuantity / result.position!.quantity - 0.25) < 0.001);
});

test('100 percent manual close closes position', () => {
  const opened = place();
  const result = close(opened.state, 100);
  assert.equal(result.position?.status, 'closed');
  assert.equal(result.position?.remainingQuantity, 0);
});

test('closed position cannot be closed twice', () => {
  const opened = place();
  const first = close(opened.state, 100);
  assert.throws(() => applyPaperTradingAction(first.state, { type: 'close_position', eventId: 'close-again', positionId: first.position!.id, percentage: 100, market: market() }, NOW), /이미 종료/);
});

test('partial close returns proportional margin', () => {
  const opened = place();
  const before = opened.state.account.usedMargin;
  const result = close(opened.state, 50);
  assert.ok(result.state.account.usedMargin < before);
});

test('full close returns all used margin', () => {
  const opened = place();
  const result = close(opened.state, 100);
  assert.equal(result.state.account.usedMargin, 0);
});

test('long stop loss closes on completed candle', () => {
  const opened = place();
  const result = process(opened.state, { open: 100, high: 101, low: 97, close: 98 }, 'stop-long');
  assert.equal(result.position?.status, 'closed');
  assert.equal(result.fills[0]?.fillReason, 'stop_loss');
});

test('short stop loss closes on completed candle', () => {
  const opened = place(undefined, { request: { side: 'short', stopLossPrice: 102, takeProfitPrice1: 95, takeProfitPrice2: 92 }, risk: { side: 'short' } });
  const result = process(opened.state, { open: 100, high: 103, low: 99, close: 102 }, 'stop-short');
  assert.equal(result.fills[0]?.fillReason, 'stop_loss');
});

test('target one partially closes configured ratio', () => {
  const opened = place();
  const result = process(opened.state, { open: 102, high: 106, low: 101, close: 105 }, 'tp1');
  assert.equal(result.position?.status, 'partially_closed');
  assert.equal(result.fills[0]?.fillReason, 'take_profit');
});

test('target two closes remaining quantity', () => {
  const opened = place();
  const first = process(opened.state, { open: 102, high: 106, low: 101, close: 105 }, 'tp1-a');
  const second = process(first.state, { timestamp: NOW.getTime()+30*60_000, open: 106, high: 109, low: 105, close: 108 }, 'tp2-a');
  assert.equal(second.position?.status, 'closed');
});

test('same candle stop and target uses stop first', () => {
  const opened = place();
  const result = process(opened.state, { open: 100, high: 106, low: 97, close: 100 }, 'stop-first');
  assert.equal(result.fills[0]?.fillReason, 'stop_loss');
  assert.equal(result.fills.length, 1);
});

test('target allocation above 100 is rejected', () => {
  assert.throws(() => place(undefined, { request: { targetClosePercent1: 75, targetClosePercent2: 50 } }), /100%/);
});

test('unclosed candle is rejected', () => {
  const opened = place();
  assert.throws(() => process(opened.state, { isClosed: false }), /완료된 캔들/);
});

test('invalid OHLC candle is rejected', () => {
  const opened = place();
  assert.throws(() => process(opened.state, { open: 100, high: 90, low: 95, close: 100 }), /완료 캔들/);
});

test('entry fee is deducted from cash', () => {
  const opened = place();
  assert.ok(opened.state.account.cashBalance < 10_000);
  assert.ok((opened.position?.entryFee ?? 0) > 0);
});

test('exit fee is recorded', () => {
  const opened = place();
  const result = close(opened.state, 100);
  assert.ok(result.fills[0].fee > 0);
  assert.ok(result.position!.totalFees > result.position!.entryFee);
});

test('entry slippage is recorded separately', () => {
  const opened = place();
  assert.ok((opened.position?.entrySlippageCost ?? 0) > 0);
});

test('exit slippage is recorded separately', () => {
  const opened = place();
  const result = close(opened.state, 100);
  assert.ok(result.fills[0].slippageCost > 0);
});

test('positive funding charges long after holding interval', () => {
  const opened = place();
  const later = new Date(NOW.getTime() + 8 * 60 * 60_000);
  const result = close(opened.state, 100, 'close-funded-long', later);
  assert.ok(result.fills[0].fundingCost > 0);
});

test('positive funding is received by short after holding interval', () => {
  const opened = place(undefined, { request: { side: 'short', stopLossPrice: 102, takeProfitPrice1: 95, takeProfitPrice2: 92 }, risk: { side: 'short' } });
  const later = new Date(NOW.getTime() + 8 * 60 * 60_000);
  const result = close(opened.state, 100, 'close-funded-short', later);
  assert.ok(result.fills[0].fundingCost < 0);
});

test('closed trade creates journal entry', () => {
  const opened = place();
  const result = close(opened.state, 100);
  assert.equal(result.state.journal.length, 1);
  assert.equal(result.state.journal[0].status, 'closed');
});

test('partial close updates same journal entry', () => {
  const opened = place();
  const first = close(opened.state, 25, 'partial-a');
  const second = close(first.state, 100, 'partial-b');
  assert.equal(second.state.journal.length, 1);
  assert.equal(second.state.journal[0].status, 'closed');
});

test('journal includes net pnl after costs', () => {
  const opened = place();
  const result = close(opened.state, 100);
  const journal = result.state.journal[0];
  assert.ok(Number.isFinite(journal.netPnl));
  assert.ok(journal.entryFee > 0 && journal.exitFee > 0);
});

test('journal note sanitizer removes control characters', () => {
  assert.equal(sanitizePaperJournalNote('a\u0000b'), 'ab');
});

test('journal note sanitizer limits length', () => {
  assert.equal(sanitizePaperJournalNote('x'.repeat(3000)).length, 2000);
});

test('statistics count closed trades', () => {
  const result = close(place().state, 100);
  const stats = calculatePaperTradingStatistics(result.state.journal);
  assert.equal(stats.totalTrades, 1);
});

test('statistics include side groups', () => {
  const result = close(place().state, 100);
  const stats = calculatePaperTradingStatistics(result.state.journal);
  assert.equal(stats.bySide[0].key, 'long');
});

test('statistics include symbol groups', () => {
  const result = close(place().state, 100);
  assert.equal(calculatePaperTradingStatistics(result.state.journal).bySymbol[0].key, 'BTCUSDT');
});

test('statistics include hour groups', () => {
  const result = close(place().state, 100);
  assert.equal(calculatePaperTradingStatistics(result.state.journal).byHour[0].key, '02');
});

test('statistics include exit reason groups', () => {
  const result = close(place().state, 100);
  assert.equal(calculatePaperTradingStatistics(result.state.journal).byExitReason[0].key, 'manual_close');
});

test('statistics profit factor is null without losses', () => {
  const result = close(place().state, 100);
  const stats = calculatePaperTradingStatistics(result.state.journal);
  if (stats.losses === 0) assert.equal(stats.profitFactor, null);
});

test('statistics total fees match journal', () => {
  const result = close(place().state, 100);
  const entry = result.state.journal[0];
  assert.equal(calculatePaperTradingStatistics(result.state.journal).totalFees, entry.entryFee + entry.exitFee);
});

test('state never contains NaN or Infinity after normal flow', () => {
  const result = close(place().state, 100);
  assert.doesNotThrow(() => assertFinitePaperState(result.state));
});

test('non-finite state is rejected', () => {
  const state = createPaperTradingState(10_000, NOW);
  state.account.cashBalance = Number.NaN;
  assert.throws(() => assertFinitePaperState(state), /유한수/);
});

test('invalid mark price is rejected', () => {
  const opened = place();
  assert.throws(() => applyPaperTradingAction(opened.state, { type: 'mark_price', eventId: 'bad-mark', symbol: 'BTCUSDT', price: 0 }, NOW), /현재가/);
});

test('manual close requires live data', () => {
  const opened = place();
  assert.throws(() => applyPaperTradingAction(opened.state, { type: 'close_position', eventId: 'bad-close-data', positionId: opened.position!.id, percentage: 100, market: market({status:'delayed'}) }, NOW), /실시간 시장 데이터/);
});

test('order response always carries paper-only safety contract', () => {
  const result = place();
  assert.equal(result.mode, 'paper-only');
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.exchangeRequestSent, false);
  assert.equal(result.order?.mode, 'paper-only');
});

test('processed event list is capped', () => {
  let state = createPaperTradingState(10_000, NOW);
  for (let index = 0; index < 520; index += 1) {
    state = applyPaperTradingAction(state, { type: 'mark_price', eventId: `mark-${index}`, symbol: 'NONE', price: 1 }, NOW).state;
  }
  assert.equal(state.processedEventIds.length, 500);
});

test('invalid paper state is rejected before action', () => {
  const state = createPaperTradingState(10_000, NOW) as PaperTradingState;
  (state as any).schemaVersion = 2;
  assert.throws(() => applyPaperTradingAction(state, { type: 'mark_price', eventId: 'state-invalid', symbol: 'BTCUSDT', price: 100 }, NOW), /상태 형식/);
});

test('order transition pending to rejected is allowed', () => {
  const pending = place(undefined, { request: { orderType: 'limit', requestedPrice: 95, stopLossPrice: 92, takeProfitPrice1: 100, takeProfitPrice2: 105 } });
  const order = structuredClone(pending.order) as PaperOrder;
  transitionPaperOrder(order, 'rejected', NOW_ISO);
  assert.equal(order.status, 'rejected');
});

test('order transition rejected to filled is blocked', () => {
  const rejected = place(undefined, { market: { status: 'delayed' } });
  const order = structuredClone(rejected.order) as PaperOrder;
  assert.throws(() => transitionPaperOrder(order, 'filled', NOW_ISO), /변경할 수 없습니다/);
});
