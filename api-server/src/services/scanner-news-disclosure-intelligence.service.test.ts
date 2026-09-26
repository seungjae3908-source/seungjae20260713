import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichStockScannerCardsWithNewsDisclosureIntelligence,
  type ScannerNewsDisclosureAugmentedCard,
} from './scanner-news-disclosure-intelligence.service';
import type { StockNewsDisclosureIntelligenceResult } from './news-disclosure-market-intelligence.service';
import type { ScannerSignalCard } from './scanner-signal.types';

function card(symbol: string, overrides: Partial<ScannerSignalCard> = {}): ScannerSignalCard {
  return {
    signalId: `sig-${symbol}`, assetClass: 'stock', market: 'KR', exchange: null, symbol,
    name: symbol, currency: 'KRW', assetType: 'stock', listingStatus: 'LISTED', price: 100,
    changePercent: 1, direction: 'LONG', signalState: 'CONFIRMED', score: 80, confidence: 80,
    dataCompleteness: 100, riskScore: 20, riskLevel: 'LOW', liquidity: 100, volume: 100,
    tradingValue: 100, spreadPercent: 0.01, volatilityPercent: 1, matched: [], notMatched: [], unverified: [],
    evidence: [], pricePlan: { entryZone: null, invalidation: null, stopLoss: null, targets: [], riskReward: null },
    dataState: 'complete', dataSources: ['test'], observedAt: '2026-08-27T02:00:00.000Z', expiresAt: '2026-08-27T03:00:00.000Z',
    strongSignalEligible: true, warnings: [], signalGrade: 'A',
    ...overrides,
  };
}

function result(ticker: string, eventType = 'EARNINGS'): StockNewsDisclosureIntelligenceResult {
  return {
    contract: 'StockNewsDisclosureIntelligenceV1', status: 'READY', ticker, market: 'KR',
    collectedAt: '2026-08-27T02:00:00.000Z',
    sourceStatus: { news: 'READY', filings: 'READY' },
    budget: { maxEvents: 3, maxAiEvents: 1, routedEvents: 1, aiEligibleEvents: 1, aiAttemptedEvents: 1, aiDeferredEvents: 0 },
    warnings: [],
    safety: { publicEvidenceOnly: true, generatedFactsAllowed: false, executionAuthority: 'NONE', orderAllowed: false },
    events: [{
      kind: 'DISCLOSURE', headline: `${ticker} official filing`, sourceName: 'DART', sourceUrl: 'https://dart.fss.or.kr/example',
      publishedAt: '2026-08-27T00:00:00.000Z', state: 'ANALYZED', reason: null,
      route: {
        contract: 'MarketIntelAiRouteV1', serviceSha: 'sidecar', status: 'READY',
        event: {
          rawHash: 'a'.repeat(64), sourceId: 'DART:x', sourceType: 'DISCLOSURE', sourceTier: 'TIER_1_OFFICIAL',
          sourceUrl: 'https://dart.fss.or.kr/example', sourceName: 'DART', market: 'KR_STOCK', symbol: ticker,
          companyName: ticker, publishedAt: '2026-08-27T00:00:00.000Z', receivedAt: '2026-08-27T00:01:00.000Z',
          headline: `${ticker} official filing`, originalText: null, eventType,
          evidence: { facts: ['공식 출처: DART'], inferences: [], uncertainty: [] },
        },
        freshness: { state: 'FRESH', ageMs: 1_000, reason: null },
        ai: { level: 2, mode: 'DEEP_AI', modelTier: 'DEEP', realtimeClass: 'REALTIME', analysisKey: 'b'.repeat(64), cacheEligible: true, cacheReuse: false, batchEligible: false, maxOutputClass: 'DETAILED_STRUCTURED' },
        reasons: ['CRITICAL_EVENT_TYPE'],
        safety: { executionAuthority: 'NONE', orderAllowed: false, candidateDeletionAllowed: false, sentimentIsPriceDirection: false, fabricatedEvidenceAllowed: false },
      },
      ai: {
        status: 'ANALYZED', analysisKey: 'b'.repeat(64), model: 'test-model', reason: null, cache: 'MISS',
        analysis: {
          schemaVersion: 'MarketIntelAiAnalysisV1', summaryShort: '공식 공시 요약', sentiment: 'NEGATIVE', importanceScore: 90,
          confidenceScore: 80, impactHorizon: 'SWING', factEvidenceRefs: [0], inferences: [], uncertainty: [], riskFlags: ['RISK'], catalystFlags: [],
        },
        safety: { publicEvidenceOnly: true, generatedFactsAllowed: false, sentimentIsPriceDirection: false, executionAuthority: 'NONE', orderAllowed: false },
      },
    }],
  };
}

test('scanner news/disclosure enrichment touches at most two final candidates and never changes score/rank inputs', async () => {
  const calls: Array<{ ticker: string; maxAiEvents?: number }> = [];
  const input = [
    card('005930', { score: 91, signalGrade: 'S' }),
    card('000660', { score: 86, signalGrade: 'B', strongSignalEligible: false }),
    card('035420', { score: 82, signalGrade: 'A' }),
  ];
  const output = await enrichStockScannerCardsWithNewsDisclosureIntelligence(input, {
    market: 'KR', maxCandidates: 2, budgetMs: 1_000,
    collector: async (request) => {
      calls.push({ ticker: request.ticker, maxAiEvents: request.maxAiEvents });
      return result(request.ticker);
    },
  });

  assert.deepEqual(calls, [
    { ticker: '005930', maxAiEvents: 1 },
    { ticker: '000660', maxAiEvents: 0 },
  ]);
  assert.deepEqual(output.map((row) => row.score), [91, 86, 82]);
  assert.deepEqual(output.map((row) => row.direction), ['LONG', 'LONG', 'LONG']);
  assert.equal(output[0].newsDisclosureIntelligence.safety.scoreImpact, 0);
  assert.equal(output[0].newsDisclosureIntelligence.safety.rankImpact, 0);
  assert.equal(output[2].newsDisclosureIntelligence.status, 'NOT_RUN');
  assert.equal(output[2].newsDisclosureIntelligence.reason, 'SCANNER_EVIDENCE_BUDGET_NOT_SELECTED');
});

test('official risk event is surfaced as warning but cannot mutate score or execution authority', async () => {
  const [output] = await enrichStockScannerCardsWithNewsDisclosureIntelligence([card('005930', { score: 93 })], {
    market: 'KR', maxCandidates: 1, budgetMs: 1_000,
    collector: async () => result('005930', 'DELISTING'),
  });
  assert.equal(output.score, 93);
  assert.equal(output.strongSignalEligible, true);
  assert.deepEqual(output.newsDisclosureIntelligence.officialRiskEvents, ['DELISTING']);
  assert.ok(output.warnings.includes('MI_OFFICIAL_RISK_EVENT:DELISTING'));
  assert.equal(output.newsDisclosureIntelligence.safety.executionAuthority, 'NONE');
  assert.equal(output.newsDisclosureIntelligence.safety.orderAllowed, false);
  assert.equal(output.newsDisclosureIntelligence.events[0].sentiment, 'NEGATIVE');
  assert.equal(output.direction, 'LONG');
});

test('disabled/public-core path performs zero collector calls and remains explicit NOT_RUN', async () => {
  let calls = 0;
  const output = await enrichStockScannerCardsWithNewsDisclosureIntelligence([card('005930')], {
    market: 'KR', enabled: false, disabledReason: 'PUBLIC_CORE_RECURSION_GUARD',
    collector: async () => { calls += 1; return result('005930'); },
  });
  assert.equal(calls, 0);
  assert.equal(output[0].newsDisclosureIntelligence.status, 'NOT_RUN');
  assert.equal(output[0].newsDisclosureIntelligence.reason, 'PUBLIC_CORE_RECURSION_GUARD');
});

test('budget timeout is fail-soft and preserves the original scanner card', async () => {
  const original = card('005930', { score: 77, confidence: 66 });
  const [output] = await enrichStockScannerCardsWithNewsDisclosureIntelligence([original], {
    market: 'KR', maxCandidates: 1, budgetMs: 250,
    collector: async () => await new Promise<StockNewsDisclosureIntelligenceResult>(() => {}),
  });
  const augmented = output as ScannerNewsDisclosureAugmentedCard;
  assert.equal(augmented.score, 77);
  assert.equal(augmented.confidence, 66);
  assert.equal(augmented.newsDisclosureIntelligence.status, 'TIMEOUT');
  assert.ok(augmented.warnings.includes('MI_NEWS_DISCLOSURE_TIMEOUT'));
});

test('collector rejection is isolated as NOT_AVAILABLE and preserves the core scanner card', async () => {
  const original = card('005930', { score: 79, confidence: 67, direction: 'LONG' });
  const [output] = await enrichStockScannerCardsWithNewsDisclosureIntelligence([original], {
    market: 'KR', maxCandidates: 1, budgetMs: 500,
    collector: async () => { throw new Error('provider failed'); },
  });
  assert.equal(output.score, 79);
  assert.equal(output.confidence, 67);
  assert.equal(output.direction, 'LONG');
  assert.equal(output.strongSignalEligible, original.strongSignalEligible);
  assert.deepEqual(output.pricePlan, original.pricePlan);
  assert.equal(output.newsDisclosureIntelligence.status, 'NOT_AVAILABLE');
  assert.equal(output.newsDisclosureIntelligence.reason, 'SCANNER_NEWS_DISCLOSURE_COLLECTOR_FAILED');
  assert.equal(output.newsDisclosureIntelligence.safety.executionAuthority, 'NONE');
  assert.equal(output.newsDisclosureIntelligence.safety.orderAllowed, false);
  assert.ok(output.warnings.includes('MI_NEWS_DISCLOSURE_NOT_AVAILABLE'));
});
