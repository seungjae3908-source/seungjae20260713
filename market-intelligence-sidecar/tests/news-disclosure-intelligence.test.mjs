import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAnalysisKey,
  canonicalizeMarketIntelEvent,
  clusterMarketIntelEvents,
  routeMarketIntelAi,
} from '../src/news-disclosure-intelligence.mjs';

const NOW = Date.parse('2026-08-27T01:00:00.000Z');
const FRESHNESS = Object.freeze({
  futureToleranceMs: 1_000,
  freshMs: 15 * 60_000,
  agingMs: 60 * 60_000,
  staleMs: 24 * 60 * 60_000,
});

function baseEvent(overrides = {}) {
  return {
    sourceId: 'dart-20260827-0001',
    sourceType: 'DISCLOSURE',
    sourceTier: 'TIER_1_OFFICIAL',
    sourceUrl: 'https://dart.fss.or.kr/example?id=1#fragment',
    sourceName: 'DART',
    market: 'KR_STOCK',
    symbol: '005930',
    companyName: '삼성전자',
    publishedAt: '2026-08-27T00:55:00.000Z',
    receivedAt: '2026-08-27T00:55:05.000Z',
    headline: '공급계약 체결 공시',
    originalText: '공식 공시 원문에서 수집한 사실 데이터',
    eventType: 'CONTRACT',
    direction: 'UNKNOWN',
    importanceScore: 75,
    confidenceScore: 92,
    noveltyScore: 88,
    evidence: {
      facts: ['공급계약 체결 사실이 공식 공시에 존재'],
      inferences: ['실적 기여 가능성은 추가 검증 필요'],
      uncertainty: ['계약 이행률과 마진은 현재 근거 부족'],
    },
    ...overrides,
  };
}

test('same exact event and AI policy produces deterministic rawHash and reusable analysisKey', () => {
  const first = canonicalizeMarketIntelEvent(baseEvent());
  const second = canonicalizeMarketIntelEvent(baseEvent());
  assert.equal(first.rawHash, second.rawHash);
  assert.equal(
    buildAnalysisKey(first, { promptVersion: 'market-intel-v1', analysisScope: 'CORE', aiMode: 'CHEAP_AI' }),
    buildAnalysisKey(second, { promptVersion: 'market-intel-v1', analysisScope: 'CORE', aiMode: 'CHEAP_AI' }),
  );
});

test('prompt version change invalidates analysis cache identity without changing raw evidence identity', () => {
  const event = canonicalizeMarketIntelEvent(baseEvent());
  const v1 = buildAnalysisKey(event, { promptVersion: 'market-intel-v1', analysisScope: 'CORE', aiMode: 'CHEAP_AI' });
  const v2 = buildAnalysisKey(event, { promptVersion: 'market-intel-v2', analysisScope: 'CORE', aiMode: 'CHEAP_AI' });
  assert.notEqual(v1, v2);
  assert.equal(event.rawHash, canonicalizeMarketIntelEvent(baseEvent()).rawHash);
});

test('exact duplicate or matching-policy cached analysis reuses evidence without another AI call', () => {
  const event = canonicalizeMarketIntelEvent(baseEvent());
  const analysisKey = buildAnalysisKey(event, { promptVersion: 'market-intel-v1', analysisScope: 'CORE', aiMode: 'CHEAP_AI' });
  const duplicate = routeMarketIntelAi({
    event: baseEvent(), nowMs: NOW, freshnessPolicyMs: FRESHNESS,
    seenRawHashes: [event.rawHash], promptVersion: 'market-intel-v1',
  });
  assert.equal(duplicate.ai.level, 0);
  assert.equal(duplicate.ai.mode, 'NO_AI');
  assert.equal(duplicate.ai.cacheReuse, true);
  assert.ok(duplicate.reasons.includes('EXACT_DUPLICATE'));

  const cached = routeMarketIntelAi({
    event: baseEvent(), nowMs: NOW, freshnessPolicyMs: FRESHNESS,
    cachedAnalysisKeys: [analysisKey], promptVersion: 'market-intel-v1',
  });
  assert.equal(cached.ai.level, 0);
  assert.equal(cached.ai.cacheReuse, true);
  assert.ok(cached.reasons.includes('ANALYSIS_CACHE_HIT'));
});

test('cheap and deep policy identities never share cache entries', () => {
  const cheap = routeMarketIntelAi({
    event: baseEvent({ eventType: 'CONTRACT' }),
    nowMs: NOW,
    freshnessPolicyMs: FRESHNESS,
    promptVersion: 'market-intel-v1',
    analysisScope: 'CORE',
  });
  const deep = routeMarketIntelAi({
    event: baseEvent({ eventType: 'CONTRACT' }),
    nowMs: NOW,
    freshnessPolicyMs: FRESHNESS,
    promptVersion: 'market-intel-v1',
    analysisScope: 'CORE',
    context: { portfolioHolding: true },
  });
  assert.equal(cheap.ai.mode, 'CHEAP_AI');
  assert.equal(deep.ai.mode, 'DEEP_AI');
  assert.notEqual(cheap.ai.analysisKey, deep.ai.analysisKey);

  const deepWithCheapCache = routeMarketIntelAi({
    event: baseEvent({ eventType: 'CONTRACT' }),
    nowMs: NOW,
    freshnessPolicyMs: FRESHNESS,
    promptVersion: 'market-intel-v1',
    analysisScope: 'CORE',
    context: { portfolioHolding: true },
    cachedAnalysisKeys: [cheap.ai.analysisKey],
  });
  assert.equal(deepWithCheapCache.ai.mode, 'DEEP_AI');
  assert.equal(deepWithCheapCache.ai.cacheReuse, false);
  assert.ok(!deepWithCheapCache.reasons.includes('ANALYSIS_CACHE_HIT'));

  const deepWithDeepCache = routeMarketIntelAi({
    event: baseEvent({ eventType: 'CONTRACT' }),
    nowMs: NOW,
    freshnessPolicyMs: FRESHNESS,
    promptVersion: 'market-intel-v1',
    analysisScope: 'CORE',
    context: { portfolioHolding: true },
    cachedAnalysisKeys: [deep.ai.analysisKey],
  });
  assert.equal(deepWithDeepCache.ai.mode, 'NO_AI');
  assert.equal(deepWithDeepCache.ai.cacheReuse, true);
  assert.equal(deepWithDeepCache.ai.analysisKey, deep.ai.analysisKey);
  assert.ok(deepWithDeepCache.reasons.includes('ANALYSIS_CACHE_HIT'));
});

test('ordinary fresh verified news routes to cheap structured AI only', () => {
  const result = routeMarketIntelAi({
    event: baseEvent({
      sourceId: 'news-1', sourceType: 'NEWS', sourceTier: 'TIER_3_VERIFIED_NEWS',
      sourceUrl: 'https://example.com/article/1', sourceName: 'Verified News',
      eventType: 'PRODUCT_LAUNCH', importanceScore: 45, confidenceScore: 82,
    }),
    nowMs: NOW,
    freshnessPolicyMs: FRESHNESS,
  });
  assert.equal(result.status, 'READY');
  assert.equal(result.freshness.state, 'FRESH');
  assert.equal(result.ai.level, 1);
  assert.equal(result.ai.mode, 'CHEAP_AI');
  assert.equal(result.ai.modelTier, 'CHEAP');
});

test('critical official filing escalates to deep AI but never gains trading authority', () => {
  const result = routeMarketIntelAi({
    event: baseEvent({ eventType: 'CAPITAL_RAISE', headline: '유상증자 결정' }),
    nowMs: NOW,
    freshnessPolicyMs: FRESHNESS,
  });
  assert.equal(result.ai.level, 2);
  assert.equal(result.ai.mode, 'DEEP_AI');
  assert.ok(result.reasons.includes('CRITICAL_EVENT_TYPE'));
  assert.deepEqual(result.safety, {
    executionAuthority: 'NONE',
    orderAllowed: false,
    candidateDeletionAllowed: false,
    sentimentIsPriceDirection: false,
    fabricatedEvidenceAllowed: false,
  });
});

test('portfolio, scanner, abnormal move contexts escalate important analysis without changing event facts', () => {
  const result = routeMarketIntelAi({
    event: baseEvent({ eventType: 'CONTRACT' }),
    nowMs: NOW,
    freshnessPolicyMs: FRESHNESS,
    context: { portfolioHolding: true, scannerCandidate: true, abnormalPriceMove: true },
  });
  assert.equal(result.ai.level, 2);
  assert.ok(result.reasons.includes('PORTFOLIO_HOLDING'));
  assert.ok(result.reasons.includes('SCANNER_CANDIDATE'));
  assert.ok(result.reasons.includes('ABNORMAL_PRICE_MOVE'));
  assert.equal(result.evidence.facts[0], '공급계약 체결 사실이 공식 공시에 존재');
});

test('unverified source and future timestamp fail closed before AI analysis', () => {
  const unverified = routeMarketIntelAi({
    event: baseEvent({ sourceType: 'NEWS', sourceTier: 'TIER_5_UNVERIFIED', sourceUrl: 'https://rumor.example/x' }),
    nowMs: NOW,
    freshnessPolicyMs: FRESHNESS,
  });
  assert.equal(unverified.status, 'NO_EVIDENCE');
  assert.equal(unverified.ai.level, 0);
  assert.ok(unverified.reasons.includes('AI_BLOCKED_BY_EVIDENCE'));

  const future = routeMarketIntelAi({
    event: baseEvent({ publishedAt: '2026-08-27T01:10:00.000Z' }),
    nowMs: NOW,
    freshnessPolicyMs: FRESHNESS,
  });
  assert.equal(future.status, 'INVALID_EVIDENCE');
  assert.equal(future.freshness.state, 'UNKNOWN');
  assert.equal(future.ai.level, 0);
  assert.ok(future.reasons.includes('FUTURE_PUBLICATION_TIME'));
});

test('missing freshness policy stays explicit UNKNOWN instead of pretending event is fresh', () => {
  const result = routeMarketIntelAi({ event: baseEvent(), nowMs: NOW });
  assert.equal(result.freshness.state, 'UNKNOWN');
  assert.equal(result.freshness.reason, 'FRESHNESS_EVIDENCE_MISSING');
  assert.equal(result.ai.level, 1);
});

test('expired event is batch-only and not promoted as a fresh catalyst', () => {
  const result = routeMarketIntelAi({
    event: baseEvent({ publishedAt: '2026-08-20T00:00:00.000Z' }),
    nowMs: NOW,
    freshnessPolicyMs: FRESHNESS,
  });
  assert.equal(result.freshness.state, 'EXPIRED');
  assert.equal(result.ai.level, 0);
  assert.equal(result.ai.realtimeClass, 'BATCH');
  assert.equal(result.ai.batchEligible, true);
  assert.ok(result.reasons.includes('EXPIRED_EVENT_BATCH_ONLY'));
});

test('conflicting independent evidence routes to multi-evidence fusion and preserves conflict', () => {
  const result = routeMarketIntelAi({
    event: baseEvent({ direction: 'POSITIVE', sourceId: 'official-1' }),
    clusterEvents: [
      baseEvent({ sourceId: 'news-2', sourceType: 'NEWS', sourceTier: 'TIER_3_VERIFIED_NEWS', sourceUrl: 'https://news.example/2', direction: 'NEGATIVE' }),
      baseEvent({ sourceId: 'issuer-3', sourceTier: 'TIER_2_ISSUER', sourceUrl: 'https://issuer.example/3', direction: 'NEUTRAL' }),
    ],
    nowMs: NOW,
    freshnessPolicyMs: FRESHNESS,
  });
  assert.equal(result.status, 'CONFLICTING_EVIDENCE');
  assert.equal(result.conflict.conflictDetected, true);
  assert.equal(result.ai.level, 3);
  assert.equal(result.ai.mode, 'MULTI_EVIDENCE');
  assert.ok(result.reasons.includes('CONFLICTING_EVIDENCE'));
});

test('event cluster removes only exact duplicates and exposes deterministic cluster identity', () => {
  const first = baseEvent({ sourceId: 'a' });
  const duplicate = { ...first };
  const second = baseEvent({ sourceId: 'b', sourceUrl: 'https://dart.fss.or.kr/example?id=2' });
  const one = clusterMarketIntelEvents([first, duplicate, second]);
  const two = clusterMarketIntelEvents([first, duplicate, second]);
  assert.equal(one.events.length, 2);
  assert.equal(one.exactDuplicateCount, 1);
  assert.equal(one.clusterHash, two.clusterHash);
  assert.equal(one.safety.executionAuthority, 'NONE');
  assert.equal(one.safety.orderAllowed, false);
});

test('facts, inferences and uncertainty remain separate and deduplicated', () => {
  const event = canonicalizeMarketIntelEvent(baseEvent({
    evidence: {
      facts: ['사실 A', '사실 A'],
      inferences: ['추론 B'],
      uncertainty: ['미확인 C'],
    },
  }));
  assert.deepEqual(event.evidence.facts, ['사실 A']);
  assert.deepEqual(event.evidence.inferences, ['추론 B']);
  assert.deepEqual(event.evidence.uncertainty, ['미확인 C']);
});
