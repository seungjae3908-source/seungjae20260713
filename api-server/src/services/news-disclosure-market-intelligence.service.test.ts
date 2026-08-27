import test from 'node:test';
import assert from 'node:assert/strict';
import { collectStockNewsDisclosureIntelligence } from './news-disclosure-market-intelligence.service';
import type { MarketIntelligenceNewsDisclosureRoute, MarketIntelligenceNewsDisclosureRouteInput } from './market-intelligence-client.service';
import type { MarketIntelligenceAiAnalysisResult } from './market-intelligence-ai-analysis.service';
import type { FilingResult } from './filing.service';
import type { NewsData } from '../sample/types';

function filingResult(): FilingResult {
  const common = {
    date: '2026-08-27',
    url: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=1',
    sentiment: 'neutral' as const,
    events: [],
    eventLabels: [],
    source: 'DART' as const,
    sourceLabel: 'DART' as const,
    sourceProvenance: 'DIRECT_REGULATORY_PROVIDER' as const,
    publishedAt: '2026-08-27',
    publishedAtPrecision: 'DATE_ONLY' as const,
    collectedAt: '2026-08-27T01:00:00.000Z',
    collectionProvenance: 'SERVICE_ASSEMBLY_TIME' as const,
    revisionStatus: 'ORIGINAL' as const,
    relationProvenance: 'TITLE_OR_FORM_RULE' as const,
    materialEventTypes: ['M_AND_A'] as const,
    materialEventLabels: ['M&A/합병·분할'],
    importance: 'IMPORTANT' as const,
    importanceProvenance: 'DETERMINISTIC_EVENT_TYPE_RULE' as const,
    importanceReasons: ['M&A/합병·분할'],
    classificationProvenance: 'DETERMINISTIC_RULE' as const,
    marketImpactStatus: 'UNVERIFIED' as const,
  };
  return {
    market: 'KR',
    filings: [],
    disclosures: [
      { ...common, report: '합병 관련 주요사항보고서', description: '제출인: 테스트회사' },
      { ...common, url: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=2', report: '유상증자 결정', description: '제출인: 테스트회사', materialEventTypes: ['CAPITAL_RAISE'], materialEventLabels: ['증자/자금조달'] },
      { ...common, url: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=3', report: '정기보고서', description: '제출인: 테스트회사', materialEventTypes: ['EARNINGS'], materialEventLabels: ['실적/정기보고'], importance: 'INFO' },
    ],
  } as FilingResult;
}

function newsData(count = 3): NewsData {
  const news = Array.from({ length: count }, (_, index) => ({
    title: `테스트 뉴스 ${index + 1}`,
    source: '테스트뉴스',
    sourceDomain: 'news.example.com',
    date: `2026-08-${String(27 - index).padStart(2, '0')}`,
    url: `https://news.example.com/${index + 1}`,
    tone: 'neutral' as const,
    provider: 'FINNHUB',
    publishedAt: `2026-08-${String(27 - index).padStart(2, '0')}T00:00:00.000Z`,
    collectedAt: '2026-08-27T01:00:00.000Z',
    relevanceProvenance: 'TICKER_SCOPED_PROVIDER',
  }));
  return { positive: [], negative: [], news, sentimentScore: 0 };
}

let identity = 0;
function routeFor(input: MarketIntelligenceNewsDisclosureRouteInput, mode: MarketIntelligenceNewsDisclosureRoute['ai']['mode'] = 'CHEAP_AI'): MarketIntelligenceNewsDisclosureRoute {
  identity += 1;
  const hex = identity.toString(16).padStart(64, '0');
  const facts = input.event.evidence?.facts ?? [];
  return {
    contract: 'MarketIntelAiRouteV1',
    serviceSha: 'sidecar-sha',
    status: 'READY',
    event: {
      rawHash: hex,
      sourceId: input.event.sourceId ?? null,
      sourceType: input.event.sourceType ?? 'UNKNOWN',
      sourceTier: input.event.sourceTier ?? 'UNKNOWN',
      sourceUrl: input.event.sourceUrl ?? null,
      sourceName: input.event.sourceName ?? null,
      market: input.event.market ?? null,
      symbol: input.event.symbol ?? null,
      companyName: input.event.companyName ?? null,
      publishedAt: input.event.publishedAt ?? null,
      receivedAt: input.event.receivedAt ?? null,
      headline: input.event.headline ?? null,
      originalText: input.event.originalText ?? null,
      eventType: input.event.eventType ?? 'UNKNOWN',
      evidence: {
        facts,
        inferences: input.event.evidence?.inferences ?? [],
        uncertainty: input.event.evidence?.uncertainty ?? [],
      },
    },
    freshness: { state: 'FRESH', ageMs: 1_000, reason: null },
    ai: {
      level: mode === 'NO_AI' ? 0 : 1,
      mode,
      modelTier: mode === 'NO_AI' ? 'NONE' : 'CHEAP',
      realtimeClass: mode === 'NO_AI' ? 'NONE' : 'REALTIME',
      analysisKey: hex,
      cacheEligible: mode !== 'NO_AI',
      cacheReuse: mode === 'NO_AI',
      batchEligible: false,
      maxOutputClass: mode === 'NO_AI' ? 'NONE' : 'COMPACT_STRUCTURED',
    },
    reasons: mode === 'NO_AI' ? ['EXACT_DUPLICATE'] : ['STANDARD_EVENT_CLASSIFICATION'],
    safety: {
      executionAuthority: 'NONE', orderAllowed: false, candidateDeletionAllowed: false,
      sentimentIsPriceDirection: false, fabricatedEvidenceAllowed: false,
    },
  };
}

function analyzed(key: string): MarketIntelligenceAiAnalysisResult {
  return {
    status: 'ANALYZED', analysisKey: key, model: 'free-test-model', reason: null, cache: 'MISS',
    analysis: {
      schemaVersion: 'MarketIntelAiAnalysisV1', summaryShort: '검증된 공개 Evidence 요약', sentiment: 'NEUTRAL',
      importanceScore: 60, confidenceScore: 70, impactHorizon: 'SHORT', factEvidenceRefs: [0],
      inferences: [], uncertainty: [], riskFlags: [], catalystFlags: [],
    },
    safety: {
      publicEvidenceOnly: true, generatedFactsAllowed: false, sentimentIsPriceDirection: false,
      executionAuthority: 'NONE', orderAllowed: false,
    },
  };
}

test('official filings are routed before news and realtime AI calls are capped at two', async () => {
  identity = 0;
  let analyzeCalls = 0;
  const result = await collectStockNewsDisclosureIntelligence({
    ticker: '005930', market: 'KR', companyName: '삼성전자', maxEvents: 5, maxAiEvents: 2,
  }, {
    dependencies: {
      getNews: async () => newsData(3),
      getFilings: async () => filingResult(),
      route: async (input) => routeFor(input),
      analyze: async (input) => { analyzeCalls += 1; return analyzed(input.analysisKey); },
      now: () => Date.parse('2026-08-27T02:00:00.000Z'),
    },
  });

  assert.equal(result.status, 'READY');
  assert.equal(result.events.length, 5);
  assert.deepEqual(result.events.slice(0, 3).map((event) => event.kind), ['DISCLOSURE', 'DISCLOSURE', 'DISCLOSURE']);
  assert.equal(analyzeCalls, 2);
  assert.equal(result.budget.aiAttemptedEvents, 2);
  assert.equal(result.budget.aiDeferredEvents, 3);
  assert.equal(result.events.filter((event) => event.state === 'AI_BUDGET_DEFERRED').length, 3);
  assert.equal(result.safety.executionAuthority, 'NONE');
  assert.equal(result.safety.orderAllowed, false);
});

test('NO_AI routing causes zero provider analysis calls', async () => {
  identity = 0;
  let analyzeCalls = 0;
  const result = await collectStockNewsDisclosureIntelligence({ ticker: '005930', market: 'KR', maxEvents: 1, maxAiEvents: 2 }, {
    dependencies: {
      getNews: async () => newsData(1),
      getFilings: async () => ({ market: 'KR', filings: [], disclosures: [] }),
      route: async (input) => routeFor(input, 'NO_AI'),
      analyze: async (input) => { analyzeCalls += 1; return analyzed(input.analysisKey); },
      now: () => Date.parse('2026-08-27T02:00:00.000Z'),
    },
  });
  assert.equal(analyzeCalls, 0);
  assert.equal(result.events[0]?.state, 'ROUTED_NO_AI');
  assert.equal(result.budget.aiAttemptedEvents, 0);
});

test('one provider failure remains explicit while verified evidence from the other provider is preserved', async () => {
  identity = 0;
  const result = await collectStockNewsDisclosureIntelligence({ ticker: '005930', market: 'KR', maxEvents: 2, maxAiEvents: 1 }, {
    dependencies: {
      getNews: async () => { throw new Error('NEWS_DOWN'); },
      getFilings: async () => filingResult(),
      route: async (input) => routeFor(input),
      analyze: async (input) => analyzed(input.analysisKey),
      now: () => Date.parse('2026-08-27T02:00:00.000Z'),
    },
  });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.sourceStatus.news, 'FAILED');
  assert.equal(result.sourceStatus.filings, 'READY');
  assert.ok(result.warnings.includes('NEWS_PROVIDER_FAILED'));
  assert.ok(result.events.length > 0);
  assert.ok(result.events.every((event) => event.kind === 'DISCLOSURE'));
});

test('route failures never fall back to direct AI calls', async () => {
  let analyzeCalls = 0;
  const result = await collectStockNewsDisclosureIntelligence({ ticker: '005930', market: 'KR', maxEvents: 1 }, {
    dependencies: {
      getNews: async () => newsData(1),
      getFilings: async () => ({ market: 'KR', filings: [], disclosures: [] }),
      route: async () => { throw new Error('SIDECAR_DOWN'); },
      analyze: async (input) => { analyzeCalls += 1; return analyzed(input.analysisKey); },
      now: () => Date.parse('2026-08-27T02:00:00.000Z'),
    },
  });
  assert.equal(analyzeCalls, 0);
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.events[0]?.state, 'ROUTE_UNAVAILABLE');
  assert.ok(result.warnings.includes('MARKET_INTELLIGENCE_ROUTE_FAILED'));
});
