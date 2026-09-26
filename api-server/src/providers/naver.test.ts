import assert from 'node:assert/strict';
import test from 'node:test';

import { getCandles, getQuote } from './naver';

const originalFetch = globalThis.fetch;
const originalNow = Date.now;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}

function updatedAtOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('updatedAt' in value)) return undefined;
  const updatedAt = (value as { updatedAt?: unknown }).updatedAt;
  return typeof updatedAt === 'string' ? updatedAt : undefined;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
});

test('preserves Naver localTradedAt instead of request wall clock', async () => {
  Date.now = () => Date.parse('2026-09-10T10:00:00.000Z');
  globalThis.fetch = async () => jsonResponse({
    datas: [{
      stockName: '삼성전자',
      closePrice: '269,000',
      compareToPreviousClosePrice: '-500',
      fluctuationsRatio: '-0.19',
      accumulatedTradingVolume: '21,010,910',
      openPrice: '269,000',
      highPrice: '270,500',
      lowPrice: '263,500',
      previousClosePrice: '269,500',
      localTradedAt: '2026-09-10T15:30:00+09:00',
    }],
  });

  const quote = await getQuote('005930');
  assert.equal(updatedAtOf(quote), '2026-09-10T06:30:00.000Z');
  assert.notEqual(updatedAtOf(quote), new Date(Date.now()).toISOString());
});

test('uses Naver HTML provider reference time when JSON quote time evidence is missing', async () => {
  Date.now = () => Date.parse('2026-09-10T10:00:00.000Z');
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls <= 2) {
      return jsonResponse({
        datas: [{ stockName: '삼성전자', closePrice: '269,000' }],
      });
    }

    return htmlResponse(`
      <html><head><title>삼성전자 : 네이버페이 증권</title></head><body>
      <div>2026년 09월 10일 16시 10분 기준 장마감</div>
      <div>현재가 269,000 전일가 269,500 시가 269,000 고가 270,500 저가 263,500 거래량 21,010,910 거래대금 5,629,002</div>
      </body></html>
    `);
  };

  const quote = await getQuote('005930');
  assert.equal(calls, 3);
  assert.equal(updatedAtOf(quote), '2026-09-10T07:10:00.000Z');
});

test('fails closed when all Naver quote freshness evidence is materially future', async () => {
  Date.now = () => Date.parse('2026-09-10T10:00:00.000Z');
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls <= 2) {
      return jsonResponse({
        datas: [{
          stockName: '삼성전자',
          closePrice: '269,000',
          localTradedAt: '2026-09-10T19:10:01+09:00',
        }],
      });
    }

    return htmlResponse(`
      <html><body>
      <div>2026년 09월 10일 19시 10분 기준</div>
      <div>현재가 269,000</div>
      </body></html>
    `);
  };

  await assert.rejects(getQuote('005930'), /NAVER_PROVIDER_TIMESTAMP_INVALID/);
});

test('rejects malformed Naver candle dates instead of replacing them with request time', async () => {
  globalThis.fetch = async () => jsonResponse([
    {
      localDate: '20260910',
      closePrice: '269000',
      openPrice: '268000',
      highPrice: '270500',
      lowPrice: '263500',
      accumulatedTradingVolume: '21010910',
    },
    {
      localDate: '20261340',
      closePrice: '270000',
      openPrice: '269000',
      highPrice: '271000',
      lowPrice: '268000',
      accumulatedTradingVolume: '1',
    },
  ]);

  await assert.rejects(getCandles('005930'), /NAVER_CANDLE_DATE_INVALID/);
});
