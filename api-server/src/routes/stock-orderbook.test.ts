import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeBitgetFuturesOrderbook,
  normalizeKiwoomOrderbook,
  normalizeUpbitOrderbook,
} from './stock-orderbook';

const receivedAt = new Date('2026-08-05T03:30:10.000Z');

test('normalizes Kiwoom best and depth levels without fabricating freshness', () => {
  const result = normalizeKiwoomOrderbook(
    '005930',
    {
      bid_req_base_tm: '20260805',
      sel_fpr_bid: '-70100',
      sel_fpr_req: '120',
      sel_2th_pre_bid: '-70200',
      sel_2th_pre_req: '80',
      buy_fpr_bid: '+70000',
      buy_fpr_req: '150',
      buy_2th_pre_bid: '+69900',
      buy_2th_pre_req: '100',
      tot_sel_req: '1,200',
      tot_buy_req: '1,500',
    },
    receivedAt,
  );

  assert.equal(result.assetClass, 'stock');
  assert.equal(result.market, 'KR');
  assert.equal(result.status, 'ready');
  assert.equal(result.available, true);
  assert.equal(result.bestAsk, 70_100);
  assert.equal(result.bestBid, 70_000);
  assert.equal(result.spread, 100);
  assert.equal(result.asks[0]?.cumulativeQuantity, 120);
  assert.equal(result.asks[1]?.cumulativeQuantity, 200);
  assert.equal(result.bids[1]?.cumulativeQuantity, 250);
  assert.equal(result.totalAskQuantity, 1_200);
  assert.equal(result.totalBidQuantity, 1_500);
  assert.equal(result.sourceTimestampRaw, '20260805');
  assert.equal(result.updatedAt, null);
  assert.equal(result.freshness, 'unknown');
  assert.equal(result.stale, true);
  assert.equal(result.receivedAt, receivedAt.toISOString());
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.exchangeRequestSent, false);
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes('최신성을 보장하지 않습니다'),
    ),
  );
});

test('accepts a one-sided Kiwoom book only as explicit partial data', () => {
  const result = normalizeKiwoomOrderbook(
    '005930',
    {
      bid_req_base_tm: '20260805123005',
      buy_fpr_bid: '70000',
      buy_fpr_req: '150',
    },
    receivedAt,
  );

  assert.equal(result.status, 'partial');
  assert.equal(result.available, true);
  assert.equal(result.asks.length, 0);
  assert.equal(result.bids.length, 1);
  assert.ok(result.warnings.some((warning) => warning.includes('부분 데이터')));
});

test('blocks crossed books instead of presenting unsafe levels', () => {
  const result = normalizeKiwoomOrderbook(
    '005930',
    {
      sel_fpr_bid: '70000',
      sel_fpr_req: '120',
      buy_fpr_bid: '70100',
      buy_fpr_req: '150',
    },
    receivedAt,
  );

  assert.equal(result.status, 'invalid');
  assert.equal(result.available, false);
  assert.equal(result.reason, 'ORDERBOOK_CROSSED');
  assert.deepEqual(result.asks, []);
  assert.deepEqual(result.bids, []);
  assert.ok(result.warnings.some((warning) => warning.includes('교차 호가')));
});

test('drops invalid and duplicate Kiwoom levels with explicit warnings', () => {
  const result = normalizeKiwoomOrderbook(
    '005930',
    {
      sel_fpr_bid: '70100',
      sel_fpr_req: '-1',
      sel_2th_pre_bid: '70200',
      sel_2th_pre_req: '80',
      sel_3th_pre_bid: '70200',
      sel_3th_pre_req: '50',
      buy_fpr_bid: '70000',
      buy_fpr_req: '100',
    },
    receivedAt,
  );

  assert.equal(result.asks.length, 1);
  assert.equal(result.asks[0]?.rank, 1);
  assert.equal(result.asks[0]?.price, 70_200);
  assert.ok(
    result.warnings.some((warning) => warning.includes('유효하지 않아 제외')),
  );
  assert.ok(result.warnings.some((warning) => warning.includes('중복 가격')));
});

test('returns unavailable when both Kiwoom sides are empty', () => {
  const result = normalizeKiwoomOrderbook(
    '005930',
    { bid_req_base_tm: '20260805' },
    receivedAt,
  );

  assert.equal(result.status, 'unavailable');
  assert.equal(result.ok, false);
  assert.equal(result.available, false);
  assert.equal(result.reason, 'ORDERBOOK_LEVELS_EMPTY');
  assert.equal(result.updatedAt, null);
  assert.equal(result.freshness, 'unknown');
});

test('normalizes public Upbit spot depth, totals and provider timestamp', () => {
  const providerTime = Date.parse('2026-08-05T03:30:05.000Z');
  const result = normalizeUpbitOrderbook(
    'BTC',
    [
      {
        market: 'KRW-BTC',
        timestamp: providerTime,
        total_ask_size: 4.2,
        total_bid_size: 5.4,
        orderbook_units: [
          { ask_price: 150_100_000, ask_size: 0.4, bid_price: 149_900_000, bid_size: 0.7 },
          { ask_price: 150_200_000, ask_size: 0.6, bid_price: 149_800_000, bid_size: 0.8 },
        ],
      },
    ],
    receivedAt,
  );

  assert.equal(result.assetClass, 'crypto_spot');
  assert.equal(result.market, 'UPBIT');
  assert.equal(result.exchange, 'UPBIT');
  assert.equal(result.provider, 'upbit');
  assert.equal(result.source, 'upbit_v1_orderbook');
  assert.equal(result.currency, 'KRW');
  assert.equal(result.symbol, 'BTC');
  assert.equal(result.status, 'ready');
  assert.equal(result.bestAsk, 150_100_000);
  assert.equal(result.bestBid, 149_900_000);
  assert.equal(result.asks[1]?.cumulativeQuantity, 1);
  assert.equal(result.bids[1]?.cumulativeQuantity, 1.5);
  assert.equal(result.totalAskQuantity, 4.2);
  assert.equal(result.totalBidQuantity, 5.4);
  assert.equal(result.sourceTimestampRaw, String(providerTime));
  assert.equal(result.updatedAt, '2026-08-05T03:30:05.000Z');
  assert.equal(result.freshness, 'fresh');
  assert.equal(result.stale, false);
});

test('filters invalid and duplicate Upbit levels before sorting', () => {
  const result = normalizeUpbitOrderbook(
    'ETH',
    [
      {
        timestamp: Date.parse('2026-08-05T03:30:05.000Z'),
        orderbook_units: [
          { ask_price: 5_000_000, ask_size: -1, bid_price: 4_990_000, bid_size: 2 },
          { ask_price: 5_010_000, ask_size: 1, bid_price: 4_980_000, bid_size: 1 },
          { ask_price: 5_010_000, ask_size: 3, bid_price: 4_970_000, bid_size: 1 },
        ],
      },
    ],
    receivedAt,
  );

  assert.equal(result.status, 'ready');
  assert.equal(result.asks.length, 1);
  assert.equal(result.asks[0]?.rank, 1);
  assert.equal(result.asks[0]?.price, 5_010_000);
  assert.equal(result.bids.length, 3);
  assert.ok(
    result.warnings.some((warning) => warning.includes('유효하지 않아 제외')),
  );
  assert.ok(result.warnings.some((warning) => warning.includes('중복 가격')));
});

test('normalizes public Bitget futures depth and matching-engine timestamp', () => {
  const providerTime = Date.parse('2026-08-05T03:30:06.000Z');
  const result = normalizeBitgetFuturesOrderbook(
    'BTCUSDT',
    {
      code: '00000',
      data: {
        asks: [['114010.5', '1.2'], ['114000.5', '0.8']],
        bids: [['113990.5', '0.9'], ['113980.5', '1.1']],
        ts: String(providerTime),
      },
    },
    receivedAt,
  );

  assert.equal(result.assetClass, 'crypto_futures');
  assert.equal(result.market, 'BITGET');
  assert.equal(result.exchange, 'BITGET');
  assert.equal(result.provider, 'bitget');
  assert.equal(result.source, 'bitget_v2_mix_market_merge_depth');
  assert.equal(result.currency, 'USDT');
  assert.equal(result.symbol, 'BTCUSDT');
  assert.equal(result.status, 'ready');
  assert.equal(result.bestAsk, 114_000.5);
  assert.equal(result.bestBid, 113_990.5);
  assert.equal(result.asks[1]?.cumulativeQuantity, 2);
  assert.equal(result.bids[1]?.cumulativeQuantity, 2);
  assert.equal(result.sourceTimestampRaw, String(providerTime));
  assert.equal(result.updatedAt, '2026-08-05T03:30:06.000Z');
  assert.equal(result.freshness, 'fresh');
  assert.equal(result.stale, false);
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.exchangeRequestSent, false);
});

test('fails closed on malformed Bitget provider responses', () => {
  const providerError = normalizeBitgetFuturesOrderbook(
    'ETHUSDT',
    { code: '40001', message: 'provider error' },
    receivedAt,
  );
  assert.equal(providerError.status, 'provider_error');
  assert.equal(providerError.available, false);
  assert.equal(providerError.reason, 'BITGET_ORDERBOOK_PROVIDER_ERROR');
  assert.deepEqual(providerError.asks, []);
  assert.deepEqual(providerError.bids, []);

  const invalidShape = normalizeBitgetFuturesOrderbook(
    'ETHUSDT',
    { code: '00000', data: null },
    receivedAt,
  );
  assert.equal(invalidShape.status, 'provider_error');
  assert.equal(invalidShape.reason, 'BITGET_ORDERBOOK_RESPONSE_INVALID');
});
