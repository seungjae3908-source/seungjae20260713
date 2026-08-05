import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScannerPerformanceKey,
  enrichScannerMarketAction,
  evaluateScannerMarketApproval,
  isScannerActionAllowed,
  resolveScannerExecutionIntent,
  resolveScannerTradeAction,
} from './scanner-market-action.service';
import type {
  ScannerMarketClass,
  ScannerSignalCard,
} from './scanner-signal.types';

function card(overrides: Partial<ScannerSignalCard> = {}): ScannerSignalCard {
  const observedAt = '2026-08-05T00:00:00.000Z';
  return {
    signalId: 'signal:test',
    assetClass: 'stock',
    market: 'KR',
    exchange: 'KRX',
    symbol: '005930',
    name: '삼성전자',
    currency: 'KRW',
    assetType: 'STOCK',
    listingStatus: 'LISTED',
    price: 100,
    changePercent: 1,
    direction: 'LONG',
    signalState: 'DETECTED',
    score: 85,
    confidence: 82,
    dataCompleteness: 92,
    riskScore: 20,
    riskLevel: 'LOW',
    liquidity: 10_000_000_000,
    volume: 100_000,
    tradingValue: 10_000_000_000,
    spreadPercent: null,
    volatilityPercent: 2,
    matched: ['거래량 증가'],
    notMatched: [],
    unverified: [],
    evidence: [{
      key: 'volume',
      label: '거래량',
      status: 'matched',
      source: 'test',
      observedAt,
      reasons: ['실데이터 확인'],
    }],
    pricePlan: {
      entryZone: { from: 99, to: 100 },
      invalidation: 95,
      stopLoss: 95,
      targets: [108, 112],
      riskReward: 1.6,
    },
    dataState: 'complete',
    dataSources: ['test'],
    observedAt,
    expiresAt: '2026-08-06T00:00:00.000Z',
    strongSignalEligible: true,
    warnings: [],
    ...overrides,
  };
}

function cryptoEvidence(includeFunding = false): ScannerSignalCard['evidence'] {
  const rows: ScannerSignalCard['evidence'] = [
    { key: 'trend', label: '추세 일치', status: 'matched', source: 'test', observedAt: null, reasons: ['추세'] },
    { key: 'volume', label: '거래량', status: 'matched', source: 'test', observedAt: null, reasons: ['거래량'] },
    { key: 'liquidity', label: '유동성', status: 'matched', source: 'test', observedAt: null, reasons: ['유동성'] },
    { key: 'spread', label: '스프레드', status: 'matched', source: 'test', observedAt: null, reasons: ['스프레드'] },
    { key: 'risk', label: '위험', status: 'matched', source: 'test', observedAt: null, reasons: ['위험'] },
  ];
  if (includeFunding) {
    rows.push({
      key: 'funding-open-interest',
      label: '펀딩비·미결제약정',
      status: 'matched',
      source: 'test',
      observedAt: null,
      reasons: ['펀딩비와 OI 확인'],
    });
  }
  return rows;
}

test('cash markets map directional signals to BUY and reduce-only SELL', () => {
  const cashMarkets: ScannerMarketClass[] = ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT'];
  for (const marketClass of cashMarkets) {
    assert.equal(resolveScannerTradeAction(marketClass, 'LONG'), 'BUY');
    assert.equal(resolveScannerTradeAction(marketClass, 'SHORT'), 'SELL');
    assert.equal(isScannerActionAllowed(marketClass, 'LONG'), false);
    assert.equal(isScannerActionAllowed(marketClass, 'SHORT'), false);
  }
  assert.equal(resolveScannerExecutionIntent('BUY'), 'OPEN_OR_ADD');
  assert.equal(resolveScannerExecutionIntent('SELL'), 'REDUCE_OR_EXIT');
});

test('crypto futures maps only to LONG or SHORT', () => {
  assert.equal(resolveScannerTradeAction('CRYPTO_FUTURES', 'LONG'), 'LONG');
  assert.equal(resolveScannerTradeAction('CRYPTO_FUTURES', 'SHORT'), 'SHORT');
  assert.equal(resolveScannerTradeAction('CRYPTO_FUTURES', 'NEUTRAL'), 'NONE');
  assert.equal(isScannerActionAllowed('CRYPTO_FUTURES', 'BUY'), false);
  assert.equal(isScannerActionAllowed('CRYPTO_FUTURES', 'SELL'), false);
});

test('stock RSI overheat becomes a reduce-only SELL signal', () => {
  const result = enrichScannerMarketAction(card({
    matched: ['RSI 과열'],
    evidence: [{
      key: 'rsi_overheat',
      label: 'RSI 과열',
      status: 'matched',
      source: 'test',
      observedAt: null,
      reasons: ['과열 확인'],
    }],
  }));
  assert.equal(result.marketClass, 'KR_STOCK');
  assert.equal(result.action, 'SELL');
  assert.equal(result.executionIntent, 'REDUCE_OR_EXIT');
  assert.equal(result.direction, 'SHORT');
  assert.equal(result.marketApprovalEligible, true);
  assert.equal(result.pricePlan.stopLoss, null);
  assert.deepEqual(result.pricePlan.targets, []);
  assert.match(result.warnings.join(' '), /신규 숏 주문을 만들지 않습니다/);
});

test('spot deterioration can emit SELL but never a new short position', () => {
  const result = enrichScannerMarketAction(card({
    assetClass: 'coin_spot',
    market: 'UPBIT_KRW',
    exchange: 'UPBIT',
    assetType: 'CRYPTO_SPOT',
    symbol: 'BTC',
    currency: 'KRW',
    direction: 'NEUTRAL',
    changePercent: -3,
    score: 82,
    confidence: 80,
    dataCompleteness: 92,
    riskScore: 20,
    spreadPercent: 0.08,
    evidence: cryptoEvidence(false),
    strongSignalEligible: false,
  }));
  assert.equal(result.marketClass, 'CRYPTO_SPOT');
  assert.equal(result.action, 'SELL');
  assert.equal(result.executionIntent, 'REDUCE_OR_EXIT');
  assert.equal(result.marketApprovalEligible, true);
});

test('futures approval requires stricter score and funding plus open interest evidence', () => {
  const futures = card({
    assetClass: 'coin_futures',
    market: 'BITGET_USDT_FUTURES',
    exchange: 'BITGET',
    assetType: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    currency: 'USDT',
    direction: 'LONG',
    score: 84,
    confidence: 82,
    dataCompleteness: 95,
    riskScore: 20,
    spreadPercent: 0.08,
    volatilityPercent: 3,
    evidence: cryptoEvidence(false),
  });
  const blocked = evaluateScannerMarketApproval(futures, 'CRYPTO_FUTURES', 'LONG');
  assert.equal(blocked.eligible, false);
  assert.match(blocked.failures.join(' '), /funding-open-interest/);

  const allowed = evaluateScannerMarketApproval(
    { ...futures, evidence: cryptoEvidence(true) },
    'CRYPTO_FUTURES',
    'LONG',
  );
  assert.equal(allowed.eligible, true);
});

test('performance key separates market strategy timeframe action regime and model', () => {
  assert.equal(
    buildScannerPerformanceKey({
      marketClass: 'CRYPTO_FUTURES',
      strategy: 'BREAKOUT',
      timeframe: '5m',
      action: 'SHORT',
      regime: 'BEAR',
      modelVersion: 'market-action-v1',
    }),
    'CRYPTO_FUTURES|BREAKOUT|5m|SHORT|BEAR|market-action-v1',
  );
});
