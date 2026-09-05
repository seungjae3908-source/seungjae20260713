import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeBitgetFuturesOrderbook,
  normalizeKiwoomOrderbook,
  normalizeUpbitOrderbook,
} from './stock-orderbook';

const receivedAt = new Date('2026-08-05T03:30:10.000Z');

test('canonical KR book exposes spreadPct, providerTimestamp and forced read-only flags', () => {
  const result = normalizeKiwoomOrderbook('005930', {
    bid_req_base_tm: '20260805123005',
    sel_fpr_bid: '-70,100',
    sel_fpr_req: '120',
    buy_fpr_bid: '+70,000',
    buy_fpr_req: '150',
  }, receivedAt);

  assert.equal(result.status, 'ready');
  assert.equal(result.bestAsk, 70_100);
  assert.equal(result.bestBid, 70_000);
  assert.equal(result.spread, 100);
  assert.equal(typeof result.spreadPct, 'number');
  assert.equal(result.providerTimestamp, '2026-08-05T03:30:05.000Z');
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.exchangeRequestSent, false);
});

test('two-sided stale provider data is canonical status stale', () => {
  const result = normalizeKiwoomOrderbook('005930', {
    bid_req_base_tm: '20260805122800',
    sel_fpr_bid: '70100',
    sel_fpr_req: '1',
    buy_fpr_bid: '70000',
    buy_fpr_req: '1',
  }, receivedAt);

  assert.equal(result.freshness, 'stale');
  assert.equal(result.status, 'stale');
  assert.equal(result.providerTimestamp, '2026-08-05T03:28:00.000Z');
});

test('one-sided book remains partial even when provider timestamp is unknown', () => {
  const result = normalizeKiwoomOrderbook('005930', {
    buy_fpr_bid: '70000',
    buy_fpr_req: '2',
  }, receivedAt);

  assert.equal(result.status, 'partial');
  assert.equal(result.freshness, 'unknown');
  assert.equal(result.asks.length, 0);
  assert.equal(result.bids.length, 1);
  assert.equal(result.spreadPct, null);
});

test('crossed book fails closed as invalid with no exposed levels', () => {
  const result = normalizeKiwoomOrderbook('005930', {
    sel_fpr_bid: '70000',
    sel_fpr_req: '1',
    buy_fpr_bid: '70100',
    buy_fpr_req: '1',
  }, receivedAt);

  assert.equal(result.status, 'invalid');
  assert.deepEqual(result.asks, []);
  assert.deepEqual(result.bids, []);
  assert.equal(result.reason, 'ORDERBOOK_CROSSED');
});

test('malformed Upbit response is unavailable rather than provider_error', () => {
  const result = normalizeUpbitOrderbook('BTC', [], receivedAt);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'UPBIT_ORDERBOOK_RESPONSE_INVALID');
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.exchangeRequestSent, false);
});

test('Bitget provider error is unavailable and never fabricates provider timestamp', () => {
  const result = normalizeBitgetFuturesOrderbook('BTCUSDT', { code: '40001' }, receivedAt);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'BITGET_ORDERBOOK_PROVIDER_ERROR');
  assert.equal(result.providerTimestamp, null);
  assert.equal(result.freshness, 'unknown');
});

test('normalization sorts both sides, removes duplicate and invalid levels, and recomputes cumulative quantity', () => {
  const result = normalizeUpbitOrderbook('BTC', [{
    timestamp: receivedAt.getTime() - 1_000,
    total_ask_size: 12,
    total_bid_size: 12,
    orderbook_units: [
      { ask_price: 102, ask_size: 2, bid_price: 99, bid_size: 1 },
      { ask_price: 101, ask_size: 1, bid_price: 100, bid_size: 2 },
      { ask_price: 101, ask_size: 9, bid_price: 100, bid_size: 9 },
      { ask_price: 103, ask_size: -1, bid_price: 98, bid_size: 0 },
    ],
  }], receivedAt);

  assert.equal(result.status, 'ready');
  assert.deepEqual(result.asks.map((row) => [row.price, row.quantity, row.cumulativeQuantity]), [
    [101, 1, 1],
    [102, 2, 3],
  ]);
  assert.deepEqual(result.bids.map((row) => [row.price, row.quantity, row.cumulativeQuantity]), [
    [100, 2, 2],
    [99, 1, 3],
  ]);
  assert.ok(result.warnings.some((warning) => warning.includes('중복 가격')));
  assert.ok(result.warnings.some((warning) => warning.includes('유효하지 않아 제외')));
});
