// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPaperTradingAction,
  createPaperTradingState,
} from '../../../api-server/src/services/paper-trading-engine.service.js';

const NOW = new Date('2026-08-24T00:00:00.000Z');
const NOW_ISO = NOW.toISOString();

const market = (symbol = 'BTCUSDT') => ({
  symbol,
  price: 100,
  lastPrice: 100,
  markPrice: 100,
  bidPrice: 99.9,
  askPrice: 100.1,
  fundingRate: 0.0001,
  status: 'live',
  updatedAt: NOW_ISO,
  warnings: [],
});

const rules = {
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
};

const request = {
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
  marketRegime: 'manual',
};

const riskInput = {
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
};

function openPosition() {
  return applyPaperTradingAction(createPaperTradingState(10_000, NOW), {
    type: 'place_order',
    eventId: 'flat-recovery-place',
    request,
    market: market(),
    contractRules: rules,
    riskInput,
  }, NOW);
}

test('manual Paper close rejects market data from a different symbol', () => {
  const opened = openPosition();
  assert.ok(opened.position);
  assert.throws(() => applyPaperTradingAction(opened.state, {
    type: 'close_position',
    eventId: 'flat-recovery-wrong-symbol',
    positionId: opened.position.id,
    percentage: 100,
    market: market('ETHUSDT'),
    at: NOW_ISO,
  }, NOW), (error: any) => {
    assert.equal(error?.code, 'MARKET_SYMBOL_MISMATCH');
    return true;
  });
});

test('manual Paper close still succeeds with fresh matching-symbol market data', () => {
  const opened = openPosition();
  assert.ok(opened.position);
  const result = applyPaperTradingAction(opened.state, {
    type: 'close_position',
    eventId: 'flat-recovery-correct-symbol',
    positionId: opened.position.id,
    percentage: 100,
    market: { ...market('BTCUSDT'), bidPrice: 104, askPrice: 104.1, price: 104, markPrice: 104 },
    at: NOW_ISO,
  }, NOW);
  assert.equal(result.position?.status, 'closed');
  assert.equal(result.position?.remainingQuantity, 0);
  assert.equal(result.state.account.usedMargin, 0);
  assert.equal(result.mode, 'paper-only');
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.exchangeRequestSent, false);
});
