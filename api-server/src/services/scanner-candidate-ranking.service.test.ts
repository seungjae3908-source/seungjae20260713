import './forward-calibration-gross-edge.service.test';
import './forward-recommendation-observer-runtime.service.test';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  passesMinimumBacktestQuality,
  rankScannerCandidates,
} from './scanner-candidate-ranking.service';
import { buildScannerDiscoveryView } from './scanner-discovery-view.service';
import type { ScannerBacktestQualitySummary, ScannerSignalCard } from './scanner-signal.types';

function card(symbol: string, score = 80): ScannerSignalCard {
  return {
    signalId: `signal:${symbol}`,
    assetClass: 'stock',
    market: 'KR',
    exchange: 'KRX',
    symbol,
    name: symbol,
    currency: 'KRW',
    assetType: 'stock',
    listingStatus: 'LISTED',
    price: 100,
    changePercent: 1,
    direction: 'LONG',
    signalState: 'DETECTED',
    score,
    confidence: 82,
    dataCompleteness: 90,
    riskScore: 30,
    riskLevel: 'LOW',
    liquidity: 1_000_000,
    volume: 10_000,
    tradingValue: 1_000_000,
    spreadPercent: 0.1,
    volatilityPercent: 2,
    matched: ['추세'],
    notMatched: ['거래량'],
    unverified: [],
    evidence: [],
    pricePlan: {
      entryZone: { from: 99, to: 100 },
      invalidation: 95,
      stopLoss: 95,
      targets: [108],
      riskReward: 1.6,
    },
    dataState: 'complete',
    dataSources: ['test'],
    observedAt: '2026-08-10T00:00:00.000Z',
    expiresAt: '2026-08-11T00:00:00.000Z',
    strongSignalEligible: true,
    warnings: [],
    strategyMode: 'swing',
    signalGrade: 'A',
    dataQuality: { state: 'TRUSTED', score: 95, strongSignalAllowed: true, issues: [] },
    quantScore: {
      technical: score,
      trend: score,
      momentum: score,
      volume: score,
      liquidity: score,
      volatility: score,
      marketRegime: score,
      risk: 80,
    },
  };
}

function verified(overrides: Partial<ScannerBacktestQualitySummary> = {}): ScannerBacktestQualitySummary {
  return {
    status: 'verified',
    oosWinRate: 55,
    walkForwardWinRate: 54,
    expectancyPercent: 0.8,
    profitFactor: 1.5,
    maxDrawdownPercent: -12,
    tradeCount: 120,
    minimumTradeCount: 40,
    netReturnPercent: 18,
    regimeScore: 75,
    oosStabilityScore: 72,
    costsIncluded: true,
    slippageIncluded: true,
    lookaheadGuarded: true,
    survivorshipGuarded: true,
    oos: true,
    walkForward: true,
    ...overrides,
  };
}

test('high win rate cannot pass when profit factor is below one', () => {
  assert.equal(passesMinimumBacktestQuality(verified({ oosWinRate: 75, profitFactor: 0.9 })), false);
});

test('lower win rate can pass with positive expectancy and strong profit factor', () => {
  assert.equal(passesMinimumBacktestQuality(verified({
    oosWinRate: 48,
    walkForwardWinRate: 49,
    profitFactor: 1.8,
    expectancyPercent: 0.7,
  })), true);
});

test('lookahead and survivorship guards are mandatory', () => {
  assert.equal(passesMinimumBacktestQuality(verified({ lookaheadGuarded: false })), false);
  assert.equal(passesMinimumBacktestQuality(verified({ survivorshipGuarded: false })), false);
});

test('missing OOS/WF metrics fail closed to B watch candidate', () => {
  const result = rankScannerCandidates({ cards: [card('005930')], market: 'KR', strategy: 'swing' });
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].signalGrade, 'B');
  assert.ok(result.cards[0].candidateRanking?.watchReasons.includes('OOS/Walk-forward 검증 데이터 필요'));
  assert.equal(result.diagnostics.backtestMissingCount, 1);
});

test('soft minimum score never removes an otherwise safe watch candidate', () => {
  const result = rankScannerCandidates({
    cards: [card('LOW', 42)],
    market: 'KR',
    strategy: 'swing',
    softMinimumScore: 80,
  });
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].symbol, 'LOW');
  assert.equal(result.cards[0].signalGrade, 'B');
});

test('hard data-quality failure is never relaxed to fill top ten', () => {
  const blocked = card('BLOCKED');
  blocked.dataState = 'stale';
  blocked.dataQuality = {
    state: 'DATA_UNTRUSTED',
    score: 20,
    strongSignalAllowed: false,
    issues: [{ code: 'STALE_TIMESTAMP', severity: 'blocking', message: 'stale' }],
  };
  const result = rankScannerCandidates({
    cards: [blocked, card('SAFE')],
    market: 'KR',
    strategy: 'swing',
    backtests: { SAFE: verified() },
    limit: 10,
  });
  assert.deepEqual(result.cards.map((item) => item.symbol), ['SAFE']);
  assert.equal(result.diagnostics.hardFilterRejectedCount, 1);
});

test('top ten is a maximum and does not synthesize extra candidates', () => {
  const cards = Array.from({ length: 13 }, (_, index) => card(`S${index}`, 70 + index));
  const result = rankScannerCandidates({ cards, market: 'KR', strategy: 'swing', limit: 10 });
  assert.equal(result.cards.length, 10);
  assert.equal(result.diagnostics.finalDisplayedCount, 10);
});

test('discovery keeps broad safe candidates while trade review remains capped at ten', () => {
  const cards = Array.from({ length: 14 }, (_, index) => card(`D${index}`, 60 + index));
  const strict = rankScannerCandidates({ cards, market: 'KR', strategy: 'swing', limit: 10 });
  const discovery = buildScannerDiscoveryView(cards, { tradeReviewCount: strict.cards.length, limit: 100 });
  assert.equal(strict.cards.length, 10);
  assert.equal(discovery.candidateCount, 14);
  assert.equal(discovery.returnedCount, 14);
  assert.equal(discovery.tradeReviewCount, 10);
  assert.equal(discovery.truncated, false);
  assert.equal(discovery.executionAuthority, 'NONE');
  assert.ok(discovery.cards.every((item) => item.discoveryOnly && !item.paperEligible && !item.autoTradeEligible));
  assert.ok(discovery.cards.every((item) => item.tradingBlockers.includes('PROFITABILITY_EVIDENCE_NOT_ATTESTED')));
});

test('discovery accepts futures shorts but rejects stock shorts neutral and stale data', () => {
  const futuresShort = card('FUTURES_SHORT');
  futuresShort.assetClass = 'coin_futures';
  futuresShort.market = 'BITGET';
  futuresShort.exchange = 'BITGET';
  futuresShort.currency = 'USDT';
  futuresShort.assetType = 'futures';
  futuresShort.direction = 'SHORT';

  const stockShort = card('STOCK_SHORT');
  stockShort.direction = 'SHORT';
  const neutral = card('NEUTRAL');
  neutral.direction = 'NEUTRAL';
  const stale = card('STALE');
  stale.dataState = 'stale';

  const discovery = buildScannerDiscoveryView(
    [futuresShort, stockShort, neutral, stale],
    { tradeReviewCount: 0, limit: 100 },
  );
  assert.deepEqual(discovery.cards.map((item) => item.symbol), ['FUTURES_SHORT']);
  assert.equal(discovery.cards[0].direction, 'SHORT');
});
