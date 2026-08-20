import assert from 'node:assert/strict';
import test from 'node:test';
import type { ScannerResponse, ScannerSignalCard } from './scanner-signal.types';
import { StrategyPromotionService } from './strategy-promotion.service';
import {
  attachScannerCanonicalPaperIdentity,
  resolveScannerCanonicalPaperIdentity,
} from './scanner-canonical-paper-identity.service';

const SHA = 'c'.repeat(40);
const OBSERVED_AT = '2026-08-20T00:00:00.000Z';

function card(overrides: Partial<ScannerSignalCard> = {}): ScannerSignalCard {
  return {
    signalId: 'canonical-paper-1',
    assetClass: 'stock',
    market: 'KR',
    exchange: 'KRX',
    symbol: '005930',
    name: 'Samsung Electronics',
    currency: 'KRW',
    assetType: 'stock',
    listingStatus: 'LISTED',
    price: 100,
    changePercent: 1,
    direction: 'LONG',
    action: 'BUY',
    signalState: 'CONFIRMED',
    score: 90,
    confidence: 88,
    dataCompleteness: 100,
    riskScore: 10,
    riskLevel: 'LOW',
    liquidity: 100,
    volume: 1_000,
    tradingValue: 100_000,
    spreadPercent: 0.1,
    volatilityPercent: 1,
    matched: ['trend'],
    notMatched: [],
    unverified: [],
    evidence: [],
    pricePlan: { entryZone: { from: 99, to: 101 }, invalidation: 95, stopLoss: 95, targets: [105, 110], riskReward: 2 },
    dataState: 'complete',
    dataSources: ['public-test'],
    observedAt: OBSERVED_AT,
    expiresAt: '2026-08-20T04:00:00.000Z',
    strongSignalEligible: true,
    warnings: [],
    strategyMode: 'swing',
    signalGrade: 'S',
    ...overrides,
  };
}

test('KR SWING forwards the exact authoritative Promotion identity into Paper metadata', () => {
  const source = new StrategyPromotionService({ sourceSha: SHA })
    .list({ market: 'KR_STOCK', strategyHorizon: 'SWING', direction: 'BUY' }).items[0];
  assert.ok(source);

  const result = resolveScannerCanonicalPaperIdentity({ card: card(), market: 'KR_STOCK', researchCodeSha: SHA });
  assert.deepEqual(result.blockers, []);
  assert.ok(result.paperCandidate);
  assert.equal(result.paperCandidate.signal.style, 'SWING');
  assert.equal(result.paperCandidate.signal.timeframe, '60m');
  assert.equal(result.paperCandidate.signal.horizon, 4);
  assert.equal(result.paperCandidate.signal.direction, 'BUY');
  assert.deepEqual(result.paperCandidate.signal.strategyIdentity, {
    strategyId: source.identity.strategyId,
    strategyVersion: source.identity.strategyVersion,
    parameterHash: source.identity.parameterHash,
    researchCodeSha: source.identity.researchCodeSha,
    costPolicyVersion: source.identity.costPolicyVersion,
  });
  assert.equal(result.paperCandidate.executionAuthority, 'NONE');
  assert.equal(result.paperCandidate.liveOrderAllowed, false);
  assert.equal(result.paperCandidate.privateTradingApiAllowed, false);
  assert.equal(result.paperCandidate.orderSubmitted, false);
  assert.equal(result.paperCandidate.exchangeRequestSent, false);
});

test('CRYPTO_SPOT SWING preserves the canonical 4H profile instead of rewriting it to 60m', () => {
  const result = resolveScannerCanonicalPaperIdentity({
    card: card({
      assetClass: 'coin_spot',
      market: 'spot',
      exchange: 'UPBIT',
      symbol: 'KRW-BTC',
      currency: 'KRW',
      assetType: 'coin',
      expiresAt: '2026-08-20T04:00:00.000Z',
    }),
    market: 'CRYPTO_SPOT',
    researchCodeSha: SHA,
  });
  assert.deepEqual(result.blockers, []);
  assert.ok(result.paperCandidate);
  assert.equal(result.paperCandidate.signal.style, 'SWING');
  assert.equal(result.paperCandidate.signal.timeframe, '4H');
  assert.equal(result.paperCandidate.signal.horizon, 1);
  assert.equal(result.paperCandidate.signal.direction, 'BUY');
});

test('CRYPTO_FUTURES SCALP uses the canonical 5m profile and bar-count horizon', () => {
  const result = resolveScannerCanonicalPaperIdentity({
    card: card({
      assetClass: 'coin_futures',
      market: 'futures',
      exchange: 'BITGET',
      symbol: 'BTCUSDT',
      currency: 'USDT',
      assetType: 'coin_futures',
      action: 'LONG',
      strategyMode: 'scalping',
      expiresAt: '2026-08-20T00:15:00.000Z',
    }),
    market: 'CRYPTO_FUTURES',
    researchCodeSha: SHA,
  });
  assert.deepEqual(result.blockers, []);
  assert.ok(result.paperCandidate);
  assert.equal(result.paperCandidate.signal.style, 'SCALPING');
  assert.equal(result.paperCandidate.signal.timeframe, '5m');
  assert.equal(result.paperCandidate.signal.horizon, 3);
  assert.equal(result.paperCandidate.signal.direction, 'LONG');
});

test('POSITION maps to MID_LONG and retains the canonical 1D stock timeframe', () => {
  const result = resolveScannerCanonicalPaperIdentity({
    card: card({ strategyMode: 'position', expiresAt: '2026-08-22T00:00:00.000Z' }),
    market: 'KR_STOCK',
    researchCodeSha: SHA,
  });
  assert.deepEqual(result.blockers, []);
  assert.ok(result.paperCandidate);
  assert.equal(result.paperCandidate.signal.style, 'MID_LONG');
  assert.equal(result.paperCandidate.signal.timeframe, '1D');
  assert.equal(result.paperCandidate.signal.horizon, 2);
});

test('non-divisible expiry fails closed instead of inventing a canonical horizon', () => {
  const result = resolveScannerCanonicalPaperIdentity({
    card: card({
      assetClass: 'coin_spot',
      market: 'spot',
      exchange: 'UPBIT',
      symbol: 'KRW-BTC',
      currency: 'KRW',
      assetType: 'coin',
      expiresAt: '2026-08-20T05:00:00.000Z',
    }),
    market: 'CRYPTO_SPOT',
    researchCodeSha: SHA,
  });
  assert.equal(result.paperCandidate, null);
  assert.ok(result.blockers.includes('SCANNER_CANONICAL_HORIZON_REQUIRED'));
});

test('missing strategy mode and explicit action fail closed', () => {
  const result = resolveScannerCanonicalPaperIdentity({
    card: card({ strategyMode: undefined, action: 'NONE' }),
    market: 'KR_STOCK',
    researchCodeSha: SHA,
  });
  assert.equal(result.paperCandidate, null);
  assert.ok(result.blockers.includes('SCANNER_STRATEGY_MODE_REQUIRED'));
  assert.ok(result.blockers.includes('SCANNER_EXPLICIT_ACTION_REQUIRED'));
});

test('market mismatch fails closed before attaching a Promotion identity', () => {
  const result = resolveScannerCanonicalPaperIdentity({
    card: card({ market: 'US' }),
    market: 'KR_STOCK',
    researchCodeSha: SHA,
  });
  assert.equal(result.paperCandidate, null);
  assert.ok(result.blockers.includes('SCANNER_MARKET_MISMATCH'));
});

test('ambiguous authoritative Promotion identity fails closed', () => {
  const source = new StrategyPromotionService({ sourceSha: SHA })
    .list({ market: 'KR_STOCK', strategyHorizon: 'SWING', direction: 'BUY' }).items[0];
  assert.ok(source);
  const result = resolveScannerCanonicalPaperIdentity({
    card: card(),
    market: 'KR_STOCK',
    researchCodeSha: SHA,
    promotionRecords: [source, source],
  });
  assert.equal(result.paperCandidate, null);
  assert.ok(result.blockers.includes('CANONICAL_PROMOTION_IDENTITY_AMBIGUOUS'));
});

test('immutable research SHA is mandatory', () => {
  const result = resolveScannerCanonicalPaperIdentity({
    card: card(),
    market: 'KR_STOCK',
    researchCodeSha: 'not-a-sha',
  });
  assert.equal(result.paperCandidate, null);
  assert.deepEqual(result.blockers, ['IMMUTABLE_RESEARCH_SHA_REQUIRED']);
});

test('response attachment enriches only exact-resolved cards without changing scanner fields', () => {
  const response = { cards: [card()] } as ScannerResponse;
  const enriched = attachScannerCanonicalPaperIdentity({ response, market: 'KR_STOCK', researchCodeSha: SHA });
  const output = enriched.cards[0] as ScannerSignalCard & { paperCandidate?: unknown };
  assert.ok(output.paperCandidate);
  assert.equal(output.signalId, response.cards[0]!.signalId);
  assert.equal(output.score, response.cards[0]!.score);
});
