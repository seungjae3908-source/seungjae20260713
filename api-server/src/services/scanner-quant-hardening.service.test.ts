import test from 'node:test';
import assert from 'node:assert/strict';
import { applyScannerQuantHardening } from './scanner-quant-hardening.service';
import type { ScannerSignalCard } from './scanner-signal.types';
import type { Candle } from '../sample/types';

const NOW = Date.parse('2026-08-08T03:30:00.000Z');

function staleCandles(): Candle[] {
  return Array.from({ length: 80 }, (_, index) => {
    const close = 100 + index * 0.05;
    return {
      time: NOW - 60 * 60_000 - (79 - index) * 5 * 60_000,
      open: close - 0.02,
      high: close + 0.1,
      low: close - 0.1,
      close,
      volume: 1_000 + index * 10,
    };
  });
}

function freshCandles(): Candle[] {
  return Array.from({ length: 80 }, (_, index) => {
    const close = 44 + index * 0.01;
    return {
      time: NOW - 60_000 - (79 - index) * 5 * 60_000,
      open: close - 0.02,
      high: close + 0.08,
      low: close - 0.08,
      close,
      volume: 1_000 + index * 10,
    };
  });
}

function candidate(): ScannerSignalCard {
  const observedAt = new Date(NOW - 60 * 60_000).toISOString();
  return {
    signalId: 'signal:hardening',
    assetClass: 'stock',
    market: 'US',
    exchange: 'NASDAQ',
    symbol: 'TEST',
    name: 'Test',
    currency: 'USD',
    assetType: 'STOCK',
    listingStatus: 'LISTED',
    price: 104,
    changePercent: 1,
    direction: 'LONG',
    signalState: 'CANDIDATE',
    score: 90,
    confidence: 90,
    dataCompleteness: 95,
    riskScore: 20,
    riskLevel: 'LOW',
    liquidity: 10_000_000,
    volume: 100_000,
    tradingValue: 50_000_000,
    spreadPercent: 0.05,
    volatilityPercent: 1.5,
    matched: ['legacy candidate'],
    notMatched: [],
    unverified: [],
    evidence: [{
      key: 'legacy',
      label: 'legacy candidate',
      status: 'matched',
      source: 'scanner-candidate',
      observedAt,
      reasons: ['candidate only'],
    }],
    pricePlan: {
      entryZone: { from: 103, to: 104 },
      invalidation: 99,
      stopLoss: 100,
      targets: [108, 112],
      riskReward: 2,
    },
    dataState: 'complete',
    dataSources: ['public-candles'],
    observedAt,
    expiresAt: new Date(NOW + 60 * 60_000).toISOString(),
    strongSignalEligible: true,
    warnings: [],
  };
}

function futuresCandidate(): ScannerSignalCard {
  return {
    ...candidate(),
    signalId: 'signal:hype-futures',
    assetClass: 'coin_futures',
    market: 'BITGET_USDT_FUTURES',
    exchange: 'BITGET',
    symbol: 'HYPEUSDT',
    name: 'HYPEUSDT',
    currency: 'USDT',
    assetType: 'CRYPTO_FUTURES',
    price: 82.45,
    observedAt: new Date(NOW - 30_000).toISOString(),
    dataSources: ['bitget-public-ticker', 'bitget-public-candles'],
  };
}

test('DATA_UNTRUSTED blocks grade, strong eligibility and execution-compatible price hints', () => {
  const result = applyScannerQuantHardening({
    card: candidate(),
    timeframe: '5m',
    candles: staleCandles(),
    contextCandles: staleCandles(),
    strategyMode: 'scalping',
    now: NOW,
    sessionAware: false,
  });

  assert.equal(result.dataQuality?.state, 'DATA_UNTRUSTED');
  assert.equal(result.dataQuality?.strongSignalAllowed, false);
  assert.equal(result.dataState, 'untrusted');
  assert.equal(result.strongSignalEligible, false);
  assert.notEqual(result.signalGrade, 'S');
  assert.deepEqual(result.pricePlan, {
    entryZone: null,
    invalidation: null,
    stopLoss: null,
    targets: [],
    riskReward: null,
  });
  assert.ok(result.warnings.some((warning) => warning.includes('승인·실행 호환 가격정보를 폐기')));
});

test('coin futures fail closed when ticker price and latest candle close strongly disagree', () => {
  const rows = freshCandles();
  const result = applyScannerQuantHardening({
    card: futuresCandidate(),
    timeframe: '5m',
    candles: rows,
    contextCandles: rows,
    strategyMode: 'scalping',
    allowShort: true,
    now: NOW,
    sessionAware: false,
  });

  const disagreement = result.dataQuality?.issues.find((issue) => issue.code === 'PROVIDER_DISAGREEMENT');
  assert.equal(disagreement?.severity, 'blocking');
  assert.equal(result.dataQuality?.state, 'DATA_UNTRUSTED');
  assert.equal(result.dataQuality?.strongSignalAllowed, false);
  assert.equal(result.dataState, 'untrusted');
  assert.equal(result.strongSignalEligible, false);
  assert.deepEqual(result.pricePlan, {
    entryZone: null,
    invalidation: null,
    stopLoss: null,
    targets: [],
    riskReward: null,
  });
  assert.ok(result.evidence.some((item) => item.key === 'data-quality'
    && item.reasons.some((reason) => reason.startsWith('PROVIDER_DISAGREEMENT:'))));
});

test('stock quotes are not compared with candle close by the futures-only price-axis gate', () => {
  const rows = freshCandles();
  const result = applyScannerQuantHardening({
    card: { ...candidate(), observedAt: new Date(NOW - 30_000).toISOString() },
    timeframe: '5m',
    candles: rows,
    contextCandles: rows,
    strategyMode: 'scalping',
    now: NOW,
    sessionAware: false,
  });

  assert.equal(result.dataQuality?.issues.some((issue) => issue.code === 'PROVIDER_DISAGREEMENT'), false);
});
