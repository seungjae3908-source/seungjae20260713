import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBitgetFuturesPublicEvidence,
  buildBitgetFuturesPublicRequests,
  normalizeBitgetCandles,
} from './bitget-futures-public-evidence.service';

const NOW = 2_000_000_000_000;

function candleEnvelope(timestampMs: number) {
  return {
    code: '00000',
    data: [[String(timestampMs), '100', '110', '90', '105', '10', '1000']],
  };
}

function validInput() {
  return {
    symbol: 'ETHUSDT',
    nowMs: NOW,
    ticker: {
      code: '00000',
      data: [{
        symbol: 'ETHUSDT', lastPr: '105', bidPr: '104.9', askPr: '105.1', markPrice: '105',
        indexPrice: '104.8', ts: String(NOW - 1_000),
      }],
    },
    funding: {
      code: '00000',
      data: [{ symbol: 'ETHUSDT', fundingRate: '0.0001', fundingRateInterval: '8', nextUpdate: String(NOW + 60_000) }],
    },
    openInterest: {
      code: '00000',
      data: { openInterestList: [{ symbol: 'ETHUSDT', size: '1234.5' }], ts: String(NOW - 1_000) },
    },
    contract: {
      code: '00000',
      data: [{
        symbol: 'ETHUSDT', symbolStatus: 'normal', minTradeNum: '0.01', sizeMultiplier: '0.01',
        minTradeUSDT: '5', pricePlace: '1', priceEndStep: '1', makerFeeRate: '0.0004',
        takerFeeRate: '0.0006', minLever: '1', maxLever: '125',
      }],
    },
    candles5m: candleEnvelope(NOW - 10 * 60_000),
    candles1h: candleEnvelope(NOW - 2 * 60 * 60_000),
    benchmarkBtc1h: candleEnvelope(NOW - 2 * 60 * 60_000),
    benchmarkBtc1d: candleEnvelope(NOW - 2 * 24 * 60 * 60_000),
  };
}

test('builds only canonical Bitget V2 public futures requests', () => {
  const requests = buildBitgetFuturesPublicRequests('eth-usdt');
  assert.equal(requests.ticker.path, '/api/v2/mix/market/ticker');
  assert.equal(requests.funding.path, '/api/v2/mix/market/current-fund-rate');
  assert.equal(requests.openInterest.path, '/api/v2/mix/market/open-interest');
  assert.equal(requests.contract.path, '/api/v2/mix/market/contracts');
  assert.match(requests.symbol5m.query, /symbol=ETHUSDT/);
  assert.match(requests.benchmarkBtc1d.query, /symbol=BTCUSDT/);
  assert.doesNotMatch(JSON.stringify(requests), /binance/i);
});

test('normalizes closed-candle Bitget evidence with fee, precision, funding and OI provenance', () => {
  const result = buildBitgetFuturesPublicEvidence(validInput());
  assert.equal(result.provider, 'bitget');
  assert.equal(result.productType, 'USDT-FUTURES');
  assert.equal(result.symbol, 'ETHUSDT');
  assert.equal(result.dataQuality, 'ready');
  assert.equal(result.fundingRate, 0.0001);
  assert.equal(result.openInterest, 1234.5);
  assert.equal(result.minTradeUsdt, 5);
  assert.equal(result.priceStep, 0.1);
  assert.equal(result.takerFeeRate, 0.0006);
  assert.equal(result.candles5m.length, 1);
});

test('drops the still-open candle instead of treating it as confirmed evidence', () => {
  const rows = normalizeBitgetCandles(candleEnvelope(NOW - 60_000), '5m', NOW);
  assert.deepEqual(rows, []);
});

test('fails closed on stale realtime market evidence', () => {
  const input = validInput();
  input.ticker.data[0].ts = String(NOW - 31_000);
  assert.throws(() => buildBitgetFuturesPublicEvidence(input), /BITGET_TICKER_STALE/);
});

test('fails closed when contract status is not tradable', () => {
  const input = validInput();
  input.contract.data[0].symbolStatus = 'maintain';
  assert.throws(() => buildBitgetFuturesPublicEvidence(input), /BITGET_CONTRACT_NOT_TRADABLE/);
});
