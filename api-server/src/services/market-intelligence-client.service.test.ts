import './market-intelligence-ai-analysis.service.test';
import './news-disclosure-market-intelligence.service.test';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchMarketIntelligence,
  marketIntelligenceNotAvailable,
  marketIntelligenceTradeDecision,
  routeNewsDisclosureMarketIntelligence,
  scannerDirectionalAdjustment,
} from './market-intelligence-client.service';
import { MarketIntelligenceAiAnalyzer } from './market-intelligence-ai-analysis.service';
import type { AiChatResult } from './ai-chat.service';

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function readyPayload(input: {
  mode?: 'PAPER_ONLY' | 'BLOCKED_RISK' | 'ELIGIBLE_FOR_PARENT_GATE';
  adjustment?: number;
  hardBlockReason?: string | null;
} = {}) {
  return {
    ok: true,
    serviceSha: 'sidecar-sha',
    result: {
      safety: {
        executionAuthority: 'NONE',
        privateTradingApiAllowed: false,
        realOrderAllowed: false,
        orderSubmissionAllowed: false,
      },
      scanner: {
        mode: 'SOFT_INTELLIGENCE_LAYER',
        adjustment: input.adjustment ?? 8,
        intelligenceScore: 68,
        bullishScore: 68,
        bearishScore: 32,
        hardBlockReason: input.hardBlockReason ?? null,
        candidateDeletionAllowed: false,
      },
      autoTrading: {
        mode: input.mode ?? 'PAPER_ONLY',
        orderAllowed: false,
        evidenceReady: input.mode === 'ELIGIBLE_FOR_PARENT_GATE',
        parentEligibilityReady: input.mode === 'ELIGIBLE_FOR_PARENT_GATE',
        hardBlockReason: input.hardBlockReason ?? null,
      },
      warnings: input.mode === 'PAPER_ONLY' ? ['AUTO_TRADING_FORWARD_EVIDENCE_INSUFFICIENT'] : [],
    },
  };
}

function newsRoutePayload(input: { unsafe?: boolean } = {}) {
  const id = 'a'.repeat(64);
  return {
    ok: true,
    serviceSha: 'sidecar-sha',
    safety: {
      executionAuthority: 'NONE', privateTradingApiAllowed: false, realOrderAllowed: false,
      orderSubmissionAllowed: input.unsafe ? true : false,
    },
    result: {
      contract: 'MarketIntelAiRouteV1',
      status: 'READY',
      event: {
        rawHash: id,
        sourceId: 'FINNHUB:test', sourceType: 'NEWS', sourceTier: 'TIER_3_VERIFIED_NEWS',
        sourceUrl: 'https://news.example.com/1', sourceName: 'Example News', market: 'US_STOCK', symbol: 'AAPL',
        companyName: 'Apple', publishedAt: '2026-08-27T01:00:00.000Z', receivedAt: '2026-08-27T01:01:00.000Z',
        headline: 'Example headline', originalText: null, eventType: 'UNKNOWN',
        evidence: { facts: ['기사 제목 확인'], inferences: [], uncertainty: [] },
      },
      freshness: { state: 'FRESH', ageMs: 1_000, reason: null },
      ai: {
        level: 1, mode: 'CHEAP_AI', modelTier: 'CHEAP', realtimeClass: 'REALTIME', analysisKey: id,
        cacheEligible: true, cacheReuse: false, batchEligible: false, maxOutputClass: 'COMPACT_STRUCTURED',
      },
      reasons: ['STANDARD_EVENT_CLASSIFICATION'],
      safety: {
        executionAuthority: 'NONE', orderAllowed: false, candidateDeletionAllowed: false,
        sentimentIsPriceDirection: false, fabricatedEvidenceAllowed: false,
      },
    },
  };
}

test('canonical client uses loopback public-only endpoint and preserves zero order authority', async () => {
  const requested: string[] = [];
  const intelligence = await fetchMarketIntelligence('CRYPTO_FUTURES', 'BTCUSDT', {
    fetchImpl: async (url) => {
      requested.push(String(url));
      return response(readyPayload());
    },
  });
  assert.equal(requested.length, 1);
  assert.match(requested[0], /^http:\/\/127\.0\.0\.1:8791\/v1\/public\/crypto\/futures\/BTCUSDT$/);
  assert.equal(intelligence.status, 'READY');
  assert.equal(intelligence.serviceSha, 'sidecar-sha');
  assert.equal(intelligence.autoTrading.orderAllowed, false);
  assert.equal(intelligence.scanner.candidateDeletionAllowed, false);
});

test('canonical client rejects non-loopback Market Intelligence configuration', async () => {
  await assert.rejects(
    () => fetchMarketIntelligence('CRYPTO_SPOT', 'KRW-BTC', {
      baseUrl: 'https://example.com',
      fetchImpl: async () => response(readyPayload()),
    }),
    /MARKET_INTELLIGENCE_LOOPBACK_ONLY/,
  );
});

test('news/disclosure router posts only to the loopback sidecar and validates zero authority', async () => {
  let requested = '';
  let method = '';
  let body: any = null;
  const route = await routeNewsDisclosureMarketIntelligence({
    event: {
      sourceType: 'NEWS', sourceTier: 'TIER_3_VERIFIED_NEWS', sourceUrl: 'https://news.example.com/1',
      sourceName: 'Example News', market: 'US_STOCK', symbol: 'AAPL', publishedAt: '2026-08-27T01:00:00.000Z',
      headline: 'Example headline', eventType: 'UNKNOWN', evidence: { facts: ['기사 제목 확인'] },
    },
    nowMs: Date.parse('2026-08-27T02:00:00.000Z'),
  }, {
    fetchImpl: async (url, init) => {
      requested = String(url);
      method = String(init?.method ?? 'GET');
      body = JSON.parse(String(init?.body));
      return response(newsRoutePayload());
    },
  });
  assert.equal(requested, 'http://127.0.0.1:8791/v1/news-disclosure/route');
  assert.equal(method, 'POST');
  assert.equal(body.event.symbol, 'AAPL');
  assert.equal(route.ai.mode, 'CHEAP_AI');
  assert.equal(route.safety.executionAuthority, 'NONE');
  assert.equal(route.safety.orderAllowed, false);
});

test('news/disclosure router rejects unsafe sidecar authority instead of returning it', async () => {
  await assert.rejects(
    routeNewsDisclosureMarketIntelligence({ event: { market: 'US_STOCK', symbol: 'AAPL', headline: 'x' } }, {
      fetchImpl: async () => response(newsRoutePayload({ unsafe: true })),
    }),
    /MARKET_INTELLIGENCE_NEWS_ROUTE_UNSAFE_AUTHORITY/,
  );
});

test('news/disclosure router rejects malformed safety and route enums instead of laundering them', async () => {
  const cases: Array<{ name: string; mutate: (payload: any) => void; pattern: RegExp }> = [
    {
      name: 'route sentiment authority',
      mutate: (payload) => { payload.result.safety.sentimentIsPriceDirection = true; },
      pattern: /MARKET_INTELLIGENCE_NEWS_ROUTE_UNSAFE_AUTHORITY/,
    },
    {
      name: 'envelope execution authority',
      mutate: (payload) => { payload.safety.executionAuthority = 'BROKER'; },
      pattern: /MARKET_INTELLIGENCE_NEWS_ROUTE_UNSAFE_AUTHORITY/,
    },
    {
      name: 'freshness state',
      mutate: (payload) => { payload.result.freshness.state = 'FRESHISH'; },
      pattern: /MARKET_INTELLIGENCE_NEWS_ROUTE_FRESHNESS_INVALID/,
    },
    {
      name: 'model tier',
      mutate: (payload) => { payload.result.ai.modelTier = 'ULTRA'; },
      pattern: /MARKET_INTELLIGENCE_NEWS_ROUTE_MODEL_TIER_INVALID/,
    },
    {
      name: 'realtime class',
      mutate: (payload) => { payload.result.ai.realtimeClass = 'DEFERRED'; },
      pattern: /MARKET_INTELLIGENCE_NEWS_ROUTE_REALTIME_CLASS_INVALID/,
    },
    {
      name: 'output class',
      mutate: (payload) => { payload.result.ai.maxOutputClass = 'FREE_FORM'; },
      pattern: /MARKET_INTELLIGENCE_NEWS_ROUTE_OUTPUT_CLASS_INVALID/,
    },
    {
      name: 'ai level',
      mutate: (payload) => { payload.result.ai.level = 99; },
      pattern: /MARKET_INTELLIGENCE_NEWS_ROUTE_AI_LEVEL_INVALID/,
    },
    {
      name: 'cache flags',
      mutate: (payload) => { payload.result.ai.cacheEligible = 'yes'; },
      pattern: /MARKET_INTELLIGENCE_NEWS_ROUTE_CACHE_FLAGS_INVALID/,
    },
  ];

  for (const row of cases) {
    const payload: any = newsRoutePayload();
    row.mutate(payload);
    await assert.rejects(
      routeNewsDisclosureMarketIntelligence({ event: { market: 'US_STOCK', symbol: 'AAPL', headline: 'x' } }, {
        fetchImpl: async () => response(payload),
      }),
      row.pattern,
      row.name,
    );
  }
});

test('long prompt validation is bound to exactly prompted facts and keeps DATA valid JSON', async () => {
  let prompt = '';
  const analyzer = new MarketIntelligenceAiAnalyzer({
    answerAiChatImpl: async ({ message }) => {
      prompt = String(message);
      const answer = JSON.stringify({
        schemaVersion: 'MarketIntelAiAnalysisV1',
        summaryShort: '공시 금액은 999억원이다.',
        sentiment: 'NEUTRAL',
        importanceScore: 70,
        confidenceScore: 80,
        impactHorizon: 'SWING',
        factEvidenceRefs: [4],
        inferences: [],
        uncertainty: [],
        riskFlags: [],
        catalystFlags: [],
      });
      const result: AiChatResult = {
        answer,
        kind: 'answer',
        model: 'grounding-test',
        generatedAt: '2026-08-27T01:00:00.000Z',
        data: { status: 'not_requested', asOf: null, basis: 'server_collection_time', sources: [], missing: [] },
      };
      return result;
    },
  });
  const result = await analyzer.analyze({
    analysisKey: 'b'.repeat(64),
    aiMode: 'CHEAP_AI',
    evidenceStatus: 'READY',
    market: 'KR_STOCK',
    symbol: '005930',
    sourceType: 'DISCLOSURE',
    sourceTier: 'TIER_1_OFFICIAL',
    sourceName: 'DART',
    sourceUrl: 'https://dart.fss.or.kr/example',
    publishedAt: '2026-08-27T00:55:00.000Z',
    eventType: 'CONTRACT',
    headline: `매우 긴 공시 헤드라인 ${'H'.repeat(320)}`,
    sourceText: `공식 공시 원문 ${'S'.repeat(600)}`,
    evidenceFacts: [
      `사실 0 ${'A'.repeat(250)}`,
      `사실 1 ${'B'.repeat(250)}`,
      `사실 2 ${'C'.repeat(250)}`,
      `사실 3 ${'D'.repeat(250)}`,
      `공시 금액은 999억원이다. ${'E'.repeat(220)}`,
    ],
    conflictDetected: false,
  });

  assert.ok(prompt.length <= 1_950);
  assert.equal(prompt.includes('999억원'), false);
  const dataMarker = '\nDATA=';
  const dataOffset = prompt.indexOf(dataMarker);
  assert.ok(dataOffset >= 0);
  assert.doesNotThrow(() => JSON.parse(prompt.slice(dataOffset + dataMarker.length)));
  assert.equal(result.status, 'AI_ANALYSIS_UNAVAILABLE');
  assert.equal(result.reason, 'AI_STRUCTURED_RESPONSE_INVALID');
  assert.equal(result.analysis, null);
  assert.equal(result.safety.executionAuthority, 'NONE');
  assert.equal(result.safety.orderAllowed, false);
});

test('news/disclosure router also rejects non-loopback configuration', async () => {
  await assert.rejects(
    routeNewsDisclosureMarketIntelligence({ event: { market: 'US_STOCK', symbol: 'AAPL', headline: 'x' } }, {
      baseUrl: 'https://example.com',
      fetchImpl: async () => response(newsRoutePayload()),
    }),
    /MARKET_INTELLIGENCE_LOOPBACK_ONLY/,
  );
});

test('scanner directional adjustment rewards matching direction and reverses for short', () => {
  const intelligence = marketIntelligenceNotAvailable('CRYPTO_FUTURES', 'BTCUSDT');
  const ready = {
    ...intelligence,
    status: 'READY' as const,
    scanner: { ...intelligence.scanner, adjustment: 12 },
  };
  assert.equal(scannerDirectionalAdjustment({ direction: 'LONG' }, ready), 12);
  assert.equal(scannerDirectionalAdjustment({ direction: 'SHORT' }, ready), -12);
});

test('PAPER_ONLY intelligence allows paper but fail-closes live trading', async () => {
  const intelligence = await fetchMarketIntelligence('CRYPTO_FUTURES', 'BTCUSDT', {
    fetchImpl: async () => response(readyPayload({ mode: 'PAPER_ONLY' })),
  });
  const paper = marketIntelligenceTradeDecision(intelligence, 'paper');
  const live = marketIntelligenceTradeDecision(intelligence, 'live');
  assert.equal(paper.allowed, true);
  assert.ok(paper.warnings.includes('MARKET_INTELLIGENCE_PAPER_ONLY'));
  assert.equal(live.allowed, false);
  assert.equal(live.blockCode, 'MARKET_INTELLIGENCE_FORWARD_EVIDENCE_REQUIRED');
});

test('BLOCKED_RISK intelligence blocks every new entry without granting order authority', async () => {
  const intelligence = await fetchMarketIntelligence('CRYPTO_FUTURES', 'BTCUSDT', {
    fetchImpl: async () => response(readyPayload({ mode: 'BLOCKED_RISK', hardBlockReason: 'STALE_INTELLIGENCE_DATA' })),
  });
  for (const accountMode of ['paper', 'mock', 'live'] as const) {
    const decision = marketIntelligenceTradeDecision(intelligence, accountMode);
    assert.equal(decision.allowed, false);
    assert.equal(decision.blockCode, 'STALE_INTELLIGENCE_DATA');
    assert.equal(decision.intelligence.autoTrading.orderAllowed, false);
  }
});

test('unavailable intelligence is fail-soft for paper/mock and fail-closed for live', () => {
  const intelligence = marketIntelligenceNotAvailable('CRYPTO_SPOT', 'KRW-BTC', 'INTELLIGENCE_DOWN');
  assert.equal(marketIntelligenceTradeDecision(intelligence, 'paper').allowed, true);
  assert.equal(marketIntelligenceTradeDecision(intelligence, 'mock').allowed, true);
  const live = marketIntelligenceTradeDecision(intelligence, 'live');
  assert.equal(live.allowed, false);
  assert.equal(live.blockCode, 'MARKET_INTELLIGENCE_NOT_AVAILABLE');
});
