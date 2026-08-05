import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeKiwoomOrderbook } from './stock-orderbook';

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

test('accepts a one-sided book only as explicit partial data', () => {
  const result = normalizeKiwoomOrderbook(
    '005930',
    {
      bid_req_base_tm: '20260805123005',
      buy_fpr_bid: '70000',
      buy_fpr_req: '150',
    },
    new Date('2026-08-05T03:30:10.000Z'),
  );

  assert.equal(result.status, 'partial');
  assert.equal(result.available, true);
  assert.equal(result.asks.length, 0);
  assert.equal(result.bids.length, 1);
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes('부분 데이터'),
    ),
  );
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
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes('교차 호가'),
    ),
  );
});

test('drops invalid and duplicate levels with explicit warnings', () => {
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
  assert.equal(result.asks[0]?.price, 70_200);
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes('유효하지 않아 제외'),
    ),
  );
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes('중복 가격'),
    ),
  );
});

test('returns unavailable when both sides are empty', () => {
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
