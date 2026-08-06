import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeBitgetFuturesOrderbook,
  normalizeKiwoomOrderbook,
  normalizeUpbitOrderbook,
} from './stock-orderbook';

const receivedAt = new Date('2026-08-05T03:30:10.000Z');

function assertAlmostEqual(actual: number | null, expected: number, epsilon = 1e-10) {
  assert.notEqual(actual, null);
  assert.ok(Math.abs((actual ?? 0) - expected) <= epsilon, `${actual} != ${expected}`);
}

test('normalizes Kiwoom signed prices, numeric strings, cumulative depth and metrics', () => {
  const result = normalizeKiwoomOrderbook('005930', {
    bid_req_base_tm: '20260805123005',
    sel_fpr_bid: '-70,100원',
    sel_fpr_req: '120주',
    sel_2th_pre_bid: '-70,200',
    sel_2th_pre_req: '80',
    buy_fpr_bid: '+70,000',
    buy_fpr_req: '150',
    buy_2th_pre_bid: '+69,900',
    buy_2th_pre_req: '100',
    tot_sel_req: '1,200',
    tot_buy_req: '1,500',
  }, receivedAt);

  assert.equal(result.status, 'ready');
  assert.equal(result.bestAsk, 70_100);
  assert.equal(result.bestBid, 70_000);
  assert.equal(result.spread, 100);
  assertAlmostEqual(result.spreadPercent, (100 / 70_050) * 100);
  assert.equal(result.asks[1]?.cumulativeQuantity, 200);
  assert.equal(result.bids[1]?.cumulativeQuantity, 250);
  assert.equal(result.totalAskQuantity, 1_200);
  assert.equal(result.totalBidQuantity, 1_500);
  assertAlmostEqual(result.imbalance, (250 - 200) / 450);
  assert.equal(result.updatedAt, '2026-08-05T03:30:05.000Z');
  assert.equal(result.freshness, 'fresh');
  assert.equal(result.receivedAt, receivedAt.toISOString());
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.exchangeRequestSent, false);
});

test('marks Kiwoom bid-only and ask-only books as partial', () => {
  const bidOnly = normalizeKiwoomOrderbook('005930', {
    buy_fpr_bid: '70000',
    buy_fpr_req: '150',
  }, receivedAt);
  assert.equal(bidOnly.status, 'partial');
  assert.equal(bidOnly.asks.length, 0);
  assert.equal(bidOnly.bids.length, 1);
  assert.equal(bidOnly.spread, null);

  const askOnly = normalizeKiwoomOrderbook('005930', {
    sel_fpr_bid: '70100',
    sel_fpr_req: '120',
  }, receivedAt);
  assert.equal(askOnly.status, 'partial');
  assert.equal(askOnly.asks.length, 1);
  assert.equal(askOnly.bids.length, 0);
  assert.equal(askOnly.spreadPercent, null);
});

test('returns unavailable when both sides are empty and never fabricates timestamp', () => {
  const result = normalizeKiwoomOrderbook('005930', { bid_req_base_tm: '20260805' }, receivedAt);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'ORDERBOOK_LEVELS_EMPTY');
  assert.deepEqual(result.asks, []);
  assert.deepEqual(result.bids, []);
  assert.equal(result.updatedAt, null);
  assert.equal(result.freshness, 'unknown');
  assert.equal(result.stale, true);
});

test('drops NaN, Infinity, zero prices, zero quantities, negatives and duplicate prices', () => {
  const result = normalizeKiwoomOrderbook('005930', {
    sel_fpr_bid: 'NaN',
    sel_fpr_req: '1',
    sel_2th_pre_bid: '0',
    sel_2th_pre_req: '1',
    sel_3th_pre_bid: '70200',
    sel_3th_pre_req: '0',
    sel_4th_pre_bid: '70300',
    sel_4th_pre_req: '-1',
    sel_5th_pre_bid: '70400',
    sel_5th_pre_req: '2',
    sel_6th_pre_bid: '70400',
    sel_6th_pre_req: '3',
    buy_fpr_bid: 'Infinity',
    buy_fpr_req: '1',
    buy_2th_pre_bid: '70000',
    buy_2th_pre_req: '4',
  }, receivedAt);

  assert.deepEqual(result.asks.map((level) => [level.price, level.quantity]), [[70_400, 2]]);
  assert.deepEqual(result.bids.map((level) => [level.price, level.quantity]), [[70_000, 4]]);
  assert.ok(result.warnings.some((warning) => warning.includes('유효하지 않아 제외')));
  assert.ok(result.warnings.some((warning) => warning.includes('중복 가격')));
});

test('blocks crossed books instead of sorting or repairing them', () => {
  const result = normalizeKiwoomOrderbook('005930', {
    sel_fpr_bid: '70000',
    sel_fpr_req: '120',
    buy_fpr_bid: '70100',
    buy_fpr_req: '150',
  }, receivedAt);
  assert.equal(result.status, 'invalid');
  assert.equal(result.reason, 'ORDERBOOK_CROSSED');
  assert.deepEqual(result.asks, []);
  assert.deepEqual(result.bids, []);
  assert.ok(result.warnings.some((warning) => warning.includes('교차 호가')));
});

test('classifies Kiwoom timestamps as stale or unknown independently from receivedAt', () => {
  const stale = normalizeKiwoomOrderbook('005930', {
    bid_req_base_tm: '20260805122800',
    sel_fpr_bid: '70100', sel_fpr_req: '1',
    buy_fpr_bid: '70000', buy_fpr_req: '1',
  }, receivedAt);
  assert.equal(stale.updatedAt, '2026-08-05T03:28:00.000Z');
  assert.equal(stale.receivedAt, receivedAt.toISOString());
  assert.equal(stale.freshness, 'stale');
  assert.equal(stale.stale, true);

  const unknown = normalizeKiwoomOrderbook('005930', {
    bid_req_base_tm: 'missing',
    sel_fpr_bid: '70100', sel_fpr_req: '1',
    buy_fpr_bid: '70000', buy_fpr_req: '1',
  }, receivedAt);
  assert.equal(unknown.updatedAt, null);
  assert.equal(unknown.freshness, 'unknown');
});

test('normalizes Upbit market code, side direction, sorting, totals and provider timestamp', () => {
  const providerTime = Date.parse('2026-08-05T03:30:05.000Z');
  const result = normalizeUpbitOrderbook('KRW-BTC', [{
    market: 'KRW-BTC',
    timestamp: providerTime,
    total_ask_size: '4.2',
    total_bid_size: '5.4',
    orderbook_units: [
      { ask_price: '150200000', ask_size: '0.6', bid_price: '149800000', bid_size: '0.8' },
      { ask_price: '150100000', ask_size: '0.4', bid_price: '149900000', bid_size: '0.7' },
    ],
  }], receivedAt);

  assert.equal(result.symbol, 'BTC');
  assert.deepEqual(result.asks.map((level) => level.price), [150_100_000, 150_200_000]);
  assert.deepEqual(result.bids.map((level) => level.price), [149_900_000, 149_800_000]);
  assert.equal(result.asks[1]?.cumulativeQuantity, 1);
  assert.equal(result.bids[1]?.cumulativeQuantity, 1.5);
  assert.equal(result.totalAskQuantity, 4.2);
  assert.equal(result.totalBidQuantity, 5.4);
  assert.equal(result.sourceTimestampRaw, String(providerTime));
  assert.equal(result.updatedAt, '2026-08-05T03:30:05.000Z');
  assert.equal(result.freshness, 'fresh');
});

test('Upbit rejects negative or zero public prices instead of applying Kiwoom sign rules', () => {
  const result = normalizeUpbitOrderbook('ETH', [{
    orderbook_units: [
      { ask_price: -5_000_000, ask_size: 1, bid_price: 4_990_000, bid_size: 2 },
      { ask_price: 0, ask_size: 1, bid_price: 4_980_000, bid_size: 0 },
      { ask_price: 5_010_000, ask_size: 1, bid_price: 4_970_000, bid_size: 1 },
      { ask_price: 5_010_000, ask_size: 3, bid_price: 4_960_000, bid_size: -1 },
    ],
  }], receivedAt);

  assert.deepEqual(result.asks.map((level) => [level.price, level.quantity]), [[5_010_000, 1]]);
  assert.deepEqual(result.bids.map((level) => [level.price, level.quantity]), [[4_990_000, 2], [4_970_000, 1]]);
  assert.ok(result.warnings.some((warning) => warning.includes('중복 가격')));
});

test('Upbit empty and missing-timestamp responses remain explicit', () => {
  const emptyResponse = normalizeUpbitOrderbook('BTC', [], receivedAt);
  assert.equal(emptyResponse.status, 'provider_error');
  assert.equal(emptyResponse.reason, 'UPBIT_ORDERBOOK_RESPONSE_INVALID');

  const noLevels = normalizeUpbitOrderbook('BTC', [{ orderbook_units: [], timestamp: null }], receivedAt);
  assert.equal(noLevels.status, 'unavailable');
  assert.equal(noLevels.reason, 'ORDERBOOK_LEVELS_EMPTY');
  assert.equal(noLevels.freshness, 'unknown');
  assert.equal(noLevels.updatedAt, null);
});

test('normalizes Bitget symbol, fixed-side depth and matching-engine timestamp', () => {
  const providerTime = Date.parse('2026-08-05T03:30:06.000Z');
  const result = normalizeBitgetFuturesOrderbook('BTC', {
    code: '00000',
    data: {
      asks: [['114010.5', '1.2'], ['114000.5', '0.8']],
      bids: [['113980.5', '1.1'], ['113990.5', '0.9']],
      ts: String(providerTime),
    },
  }, receivedAt);

  assert.equal(result.symbol, 'BTCUSDT');
  assert.deepEqual(result.asks.map((level) => level.price), [114_000.5, 114_010.5]);
  assert.deepEqual(result.bids.map((level) => level.price), [113_990.5, 113_980.5]);
  assert.equal(result.asks[1]?.cumulativeQuantity, 2);
  assert.equal(result.bids[1]?.cumulativeQuantity, 2);
  assert.equal(result.updatedAt, '2026-08-05T03:30:06.000Z');
  assert.equal(result.freshness, 'fresh');
});

test('Bitget drops duplicate, negative and zero levels and reports stale or unknown timestamps', () => {
  const staleTime = Date.parse('2026-08-05T03:28:00.000Z');
  const stale = normalizeBitgetFuturesOrderbook('ETH-USDT', {
    code: '00000',
    data: {
      asks: [['3500', '1'], ['3500', '2'], ['-3510', '1'], ['3520', '0']],
      bids: [['3490', '2'], ['3480', '-1'], ['0', '1']],
      ts: String(staleTime),
    },
  }, receivedAt);
  assert.equal(stale.symbol, 'ETHUSDT');
  assert.deepEqual(stale.asks.map((level) => [level.price, level.quantity]), [[3500, 1]]);
  assert.deepEqual(stale.bids.map((level) => [level.price, level.quantity]), [[3490, 2]]);
  assert.equal(stale.freshness, 'stale');
  assert.ok(stale.warnings.some((warning) => warning.includes('중복 가격')));

  const unknown = normalizeBitgetFuturesOrderbook('ETHUSDT', {
    code: '00000', data: { asks: [['3500', '1']], bids: [['3490', '1']] },
  }, receivedAt);
  assert.equal(unknown.updatedAt, null);
  assert.equal(unknown.freshness, 'unknown');
});

test('fails closed on malformed or provider-error Bitget responses', () => {
  const providerError = normalizeBitgetFuturesOrderbook('ETHUSDT', { code: '40001' }, receivedAt);
  assert.equal(providerError.status, 'provider_error');
  assert.equal(providerError.reason, 'BITGET_ORDERBOOK_PROVIDER_ERROR');
  assert.deepEqual(providerError.asks, []);
  assert.deepEqual(providerError.bids, []);

  const invalidShape = normalizeBitgetFuturesOrderbook('ETHUSDT', { code: '00000', data: null }, receivedAt);
  assert.equal(invalidShape.status, 'provider_error');
  assert.equal(invalidShape.reason, 'BITGET_ORDERBOOK_RESPONSE_INVALID');
});
