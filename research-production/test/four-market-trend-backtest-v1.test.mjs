import assert from 'node:assert/strict';
import test from 'node:test';

import { FOUR_MARKET_UNIVERSE_V1, evaluateFourMarketV1, formatFourMarketReportKoV1, fourMarketSymbolTradesV1 } from '../src/four-market-trend-backtest-v1.mjs';

const HOUR = 3_600_000; const DAY = 24 * HOUR;
function walk(n, step, seed, start, drift = 0.0006) {
  let s = seed; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const out = []; let price = 100;
  for (let i = 0; i < n; i += 1) {
    const open = price; const close = open * (1 + drift + ((rnd() - 0.5) * 0.03));
    out.push({ timestamp: start + (i * step), open, close, high: Math.max(open, close) * (1 + (rnd() * 0.005)), low: Math.min(open, close) * (1 - (rnd() * 0.005)), volume: 10 });
    price = close;
  }
  return out;
}

test('universe covers the four app markets; shorts only on futures', () => {
  assert.deepEqual(Object.keys(FOUR_MARKET_UNIVERSE_V1).sort(), ['CRYPTO_FUTURES', 'CRYPTO_SPOT', 'KR_STOCK', 'US_STOCK']);
  for (const [market, cfg] of Object.entries(FOUR_MARKET_UNIVERSE_V1)) {
    assert.equal(cfg.sides.includes('short'), market === 'CRYPTO_FUTURES');
    assert.equal(cfg.leverage, market === 'CRYPTO_FUTURES' ? 5 : 1);
  }
});

test('symbol trades: one at a time, hourly futures resampled, stocks long-only, holdout dropped', () => {
  const fut = fourMarketSymbolTradesV1({ market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT', candles: walk(6000, HOUR, 3, Date.UTC(2024, 0, 1)) });
  assert.equal(fut.status, 'COMPLETE');
  assert.equal(fut.bars, 1500);
  for (let i = 1; i < fut.trades.length; i += 1) assert.ok(fut.trades[i].entryTime >= fut.trades[i - 1].exitTime);
  const stock = fourMarketSymbolTradesV1({ market: 'US_STOCK', symbol: 'SPY', candles: [...walk(1500, DAY, 5, Date.UTC(2019, 0, 1)), { timestamp: Date.UTC(2026, 0, 5), open: 1, high: 1e9, low: 1, close: 1e9 }] });
  assert.ok(stock.trades.every((t) => t.side === 'long' && t.leverage === 1));
  assert.ok(stock.buyHold.totalReturn < 1e6, 'holdout candle ignored');
});

test('evaluation reports every market, the combined account and a Korean summary', () => {
  const datasets = [
    { market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT', candles: walk(6000, HOUR, 7, Date.UTC(2024, 0, 1)) },
    { market: 'CRYPTO_SPOT', symbol: 'KRW-BTC', candles: walk(1500, 4 * HOUR, 9, Date.UTC(2024, 0, 1)) },
    { market: 'KR_STOCK', symbol: '005930', candles: walk(1500, DAY, 11, Date.UTC(2020, 0, 1)) },
  ];
  const result = evaluateFourMarketV1({ datasets });
  assert.equal(result.markets.length, 4);
  assert.equal(result.markets.find((m) => m.market === 'US_STOCK').status, 'WAITING_FOR_DATA');
  const kr = result.markets.find((m) => m.market === 'KR_STOCK');
  assert.equal(kr.status, 'COMPLETE');
  assert.ok(kr.portfolio.trades > 0);
  assert.ok(result.combined.portfolio.trades >= result.combined.futuresOnlySameSpan.trades);
  const text = formatFourMarketReportKoV1(result);
  assert.match(text, /국내주식/);
  assert.match(text, /미국주식: 데이터 없음/);
  assert.match(text, /한 계좌로 같이/);
});
