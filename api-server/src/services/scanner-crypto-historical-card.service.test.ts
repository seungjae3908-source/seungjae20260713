import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

import {
  buildHistoricalCryptoScannerDecisionV1,
} from './scanner-crypto-historical-card.service';
import type {
  CryptoCandle,
  CryptoTicker,
} from './crypto-signal-scanner.service';

const HOUR = 60 * 60_000;
const DECISION = Date.parse('2026-09-27T00:00:00.000Z');

function digest(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

function candles(
  count = 80,
  stepMs = HOUR,
  end = DECISION - HOUR,
): CryptoCandle[] {
  const start = end - (count - 1) * stepMs;
  return Array.from({ length: count }, (_, index) => {
    const base = 100 + index * 0.6;
    return {
      time: start + index * stepMs,
      open: base,
      high: base + 1.2,
      low: base - 0.6,
      close: base + 0.8,
      volume: 1_000 + index * 15,
      quoteVolume: 100_000 + index * 1_000,
    };
  });
}

function ticker(): CryptoTicker {
  return {
    symbol: 'BTCUSDT',
    name: 'BTCUSDT',
    price: 148.2,
    changePercent: 3,
    volume: 50_000,
    tradingValue: 10_000_000,
    bid: 148.1,
    ask: 148.2,
    fundingRate: 0.0001,
    openInterest: 500_000,
    timestamp: DECISION - 30_000,
    warning: false,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  const primary = candles();
  return {
    decisionTimeMs: DECISION,
    market: 'futures' as const,
    timeframe: '60m' as const,
    condition: 'trend' as const,
    strategyMode: 'swing' as const,
    ticker: ticker(),
    spread: { bid: 148.1, ask: 148.2 },
    candlesByTimeframe: { '60m': primary },
    provenance: {
      ticker: {
        sourceId: 'bitget-public-ticker-history',
        sourceDigest: digest('ticker'),
        asOfMs: DECISION - 30_000,
        publicMarketData: true as const,
      },
      spread: {
        sourceId: 'bitget-public-book-history',
        sourceDigest: digest('spread'),
        asOfMs: DECISION - 30_000,
        publicMarketData: true as const,
      },
      candles: {
        '60m': {
          sourceId: 'bitget-public-candle-history',
          sourceDigest: digest('candles'),
          asOfMs: DECISION - HOUR,
          publicMarketData: true as const,
        },
      },
    },
    ...overrides,
  };
}

test('historical futures decision reuses the live crypto Scanner factory with point-in-time public evidence', async () => {
  const result = await buildHistoricalCryptoScannerDecisionV1(input());
  assert.equal(result.status, 'READY');
  assert.equal(result.market, 'futures');
  assert.equal(result.timeframe, '60m');
  assert.equal(result.contextTimeframe, '60m');
  assert.equal(result.response?.orderSubmitted, false);
  assert.equal(result.response?.exchangeRequestSent, false);
  assert.equal(result.rankingQualityInjected, false);
  assert.equal(result.economicSampleCredit, 0);
  assert.equal(result.executionAuthority, 'NONE');
  assert.match(result.evidenceDigest ?? '', /^[0-9a-f]{64}$/u);
  assert.ok((result.response?.cards.length ?? 0) >= 1);
  assert.equal(result.response?.cards[0]?.symbol, 'BTCUSDT');
  assert.equal(result.response?.cards[0]?.action, 'LONG');
});

test('future candle is blocked before the live Scanner factory runs', async () => {
  const rows = candles();
  rows[rows.length - 1] = { ...rows.at(-1)!, time: DECISION + HOUR };
  const result = await buildHistoricalCryptoScannerDecisionV1(input({
    candlesByTimeframe: { '60m': rows },
  }));
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.match(result.reason ?? '', /CANDLE_INVALID_OR_FUTURE/u);
  assert.equal(result.response, null);
});

test('futures funding and open interest are mandatory point-in-time inputs', async () => {
  const missing = ticker();
  missing.openInterest = null;
  const result = await buildHistoricalCryptoScannerDecisionV1(input({ ticker: missing }));
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.reason, 'HISTORICAL_FUTURES_FUNDING_OI_REQUIRED');
});

test('Spot 4H historical decision requires its 60m context series instead of silently falling back', async () => {
  const spotTicker: CryptoTicker = {
    ...ticker(),
    symbol: 'BTC',
    name: 'BTC',
    price: 148_000_000,
    tradingValue: 200_000_000_000,
    bid: null,
    ask: null,
    fundingRate: null,
    openInterest: null,
  };
  const primary = candles(80, 4 * HOUR, DECISION - 4 * HOUR).map((row) => ({
    ...row,
    open: row.open * 1_000_000,
    high: row.high * 1_000_000,
    low: row.low * 1_000_000,
    close: row.close * 1_000_000,
  }));
  const base = input({
    market: 'spot',
    timeframe: '4H',
    ticker: spotTicker,
    spread: { bid: 147_900_000, ask: 148_000_000 },
    candlesByTimeframe: { '4H': primary },
    provenance: {
      ticker: {
        sourceId: 'upbit-public-ticker-history',
        sourceDigest: digest('spot-ticker'),
        asOfMs: DECISION - 30_000,
        publicMarketData: true,
      },
      spread: {
        sourceId: 'upbit-public-orderbook-history',
        sourceDigest: digest('spot-spread'),
        asOfMs: DECISION - 30_000,
        publicMarketData: true,
      },
      candles: {
        '4H': {
          sourceId: 'upbit-public-4h-history',
          sourceDigest: digest('spot-4h'),
          asOfMs: DECISION - 4 * HOUR,
          publicMarketData: true,
        },
      },
    },
  });
  const result = await buildHistoricalCryptoScannerDecisionV1(base);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.reason, 'HISTORICAL_SCANNER_CANDLES_INSUFFICIENT:60m');
});

test('provenance from after the decision boundary is rejected', async () => {
  const value = input();
  value.provenance.ticker = {
    ...value.provenance.ticker,
    asOfMs: DECISION + 1,
  };
  const result = await buildHistoricalCryptoScannerDecisionV1(value);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.reason, 'HISTORICAL_SCANNER_TICKER_OR_SPREAD_PROVENANCE_INVALID');
});
