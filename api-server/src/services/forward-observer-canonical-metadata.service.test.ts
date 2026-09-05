import assert from 'node:assert/strict';
import test from 'node:test';
import type { ScannerResponse, ScannerSignalCard } from './scanner-signal.types';
import { StrategyPromotionService } from './strategy-promotion.service';
import {
  attachForwardObserverCanonicalMetadata,
  resolveForwardObserverCanonicalMetadata,
} from './forward-observer-canonical-metadata.service';

const SHA = 'b'.repeat(40);
const OBSERVED_AT = '2026-08-20T00:00:00.000Z';

function card(overrides: Partial<ScannerSignalCard> = {}): ScannerSignalCard {
  return {
    signalId: 'forward-canonical-1',
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

const KR_LANE = { market: 'KR_STOCK' as const, timeframe: '60m' as const };

test('authoritative Promotion identity is forwarded unchanged into the pre-Profit paperCandidate', () => {
  const source = new StrategyPromotionService({ sourceSha: SHA })
    .list({ market: 'KR_STOCK', strategyHorizon: 'SWING', direction: 'BUY' }).items[0];
  assert.ok(source);

  const result = resolveForwardObserverCanonicalMetadata({ card: card(), lane: KR_LANE, researchCodeSha: SHA });
  assert.deepEqual(result.blockers, []);
  assert.ok(result.paperCandidate);
  assert.deepEqual(result.paperCandidate.signal.strategyIdentity, {
    strategyId: source.identity.strategyId,
    strategyVersion: source.identity.strategyVersion,
    parameterHash: source.identity.parameterHash,
    researchCodeSha: source.identity.researchCodeSha,
  });
  assert.equal(result.paperCandidate.signal.signalId, 'forward-canonical-1');
  assert.equal(result.paperCandidate.signal.market, 'KR_STOCK');
  assert.equal(result.paperCandidate.signal.symbol, '005930');
  assert.equal(result.paperCandidate.signal.timeframe, '60m');
  assert.equal(result.paperCandidate.signal.horizon, 4);
  assert.equal(result.paperCandidate.signal.direction, 'BUY');
  assert.equal(result.paperCandidate.executionAuthority, 'NONE');
  assert.equal(result.paperCandidate.liveOrderAllowed, false);
  assert.equal(result.paperCandidate.privateTradingApiAllowed, false);
  assert.equal(result.paperCandidate.orderSubmitted, false);
  assert.equal(result.paperCandidate.exchangeRequestSent, false);
});

test('raw response is enriched only when exact canonical metadata resolves', () => {
  const response = { cards: [card()] } as ScannerResponse;
  const enriched = attachForwardObserverCanonicalMetadata({ response, lane: KR_LANE, researchCodeSha: SHA });
  const output = enriched.cards[0] as ScannerSignalCard & { paperCandidate?: unknown };
  assert.ok(output.paperCandidate);
  assert.equal(output.signalId, response.cards[0]!.signalId);
});

test('missing explicit action fails closed without fabricating identity', () => {
  const result = resolveForwardObserverCanonicalMetadata({
    card: card({ action: 'NONE' }),
    lane: KR_LANE,
    researchCodeSha: SHA,
  });
  assert.equal(result.paperCandidate, null);
  assert.ok(result.blockers.includes('SCANNER_EXPLICIT_ACTION_REQUIRED'));
});

test('non-integral signal horizon fails closed instead of inventing a Paper horizon', () => {
  const result = resolveForwardObserverCanonicalMetadata({
    card: card({ expiresAt: '2026-08-20T04:30:00.000Z' }),
    lane: KR_LANE,
    researchCodeSha: SHA,
  });
  assert.equal(result.paperCandidate, null);
  assert.ok(result.blockers.includes('SCANNER_NUMERIC_HORIZON_REQUIRED'));
});

test('immutable research SHA is mandatory', () => {
  const result = resolveForwardObserverCanonicalMetadata({ card: card(), lane: KR_LANE, researchCodeSha: 'not-a-sha' });
  assert.equal(result.paperCandidate, null);
  assert.deepEqual(result.blockers, ['IMMUTABLE_RESEARCH_SHA_REQUIRED']);
});

test('CRYPTO_SPOT SWING 4H Promotion identity is not silently rewritten into the 60m observer lane', () => {
  const spot = card({
    assetClass: 'coin_spot',
    market: 'spot',
    exchange: 'UPBIT',
    symbol: 'BTC',
    currency: 'KRW',
    assetType: 'coin',
    direction: 'LONG',
    action: 'BUY',
  });
  const result = resolveForwardObserverCanonicalMetadata({
    card: spot,
    lane: { market: 'CRYPTO_SPOT', timeframe: '60m' },
    researchCodeSha: SHA,
  });
  assert.equal(result.paperCandidate, null);
  assert.ok(result.blockers.includes('PROMOTION_TIMEFRAME_MISMATCH'));
});
