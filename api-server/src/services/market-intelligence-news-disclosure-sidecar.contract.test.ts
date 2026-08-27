import test from 'node:test';
import assert from 'node:assert/strict';
// The Market Intelligence sidecar is intentionally plain ESM. Esbuild bundles this
// exact source into the already-required Phase 9 test lane so its contract cannot
// remain green without actually executing the new foundation code.
// @ts-expect-error plain ESM sidecar module has no TypeScript declaration file
import {
  canonicalizeMarketIntelEvent,
  buildAnalysisKey,
  routeMarketIntelAi,
} from '../../../market-intelligence-sidecar/src/news-disclosure-intelligence.mjs';

const NOW = Date.parse('2026-08-27T02:00:00.000Z');
const FRESHNESS = {
  futureToleranceMs: 60_000,
  freshMs: 6 * 60 * 60_000,
  agingMs: 24 * 60 * 60_000,
  staleMs: 72 * 60 * 60_000,
};

function officialFiling(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: 'DART:202608270001',
    sourceType: 'DISCLOSURE',
    sourceTier: 'TIER_1_OFFICIAL',
    sourceUrl: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=202608270001',
    sourceName: 'DART',
    market: 'KR_STOCK',
    symbol: '005930',
    companyName: '삼성전자',
    publishedAt: '2026-08-27T00:30:00.000Z',
    receivedAt: '2026-08-27T00:31:00.000Z',
    headline: '주요사항보고서',
    originalText: '공개 공시 원문에서 확인된 사실만 사용',
    eventType: 'M_AND_A',
    direction: 'UNKNOWN',
    evidence: {
      facts: ['DART 원문 링크 확인', '공개 시각 확인'],
      inferences: [],
      uncertainty: [],
    },
    ...overrides,
  };
}

test('Required Phase 9 executes canonical news/disclosure sidecar routing with zero trading authority', () => {
  const routed = routeMarketIntelAi({
    event: officialFiling(),
    nowMs: NOW,
    freshnessPolicyMs: FRESHNESS,
    promptVersion: 'market-intel-v1',
    analysisScope: 'CORE',
  });

  assert.equal(routed.contract, 'MarketIntelAiRouteV1');
  assert.equal(routed.status, 'READY');
  assert.equal(routed.ai.mode, 'DEEP_AI');
  assert.equal(routed.ai.modelTier, 'DEEP');
  assert.equal(routed.safety.executionAuthority, 'NONE');
  assert.equal(routed.safety.orderAllowed, false);
  assert.equal(routed.safety.candidateDeletionAllowed, false);
  assert.equal(routed.safety.fabricatedEvidenceAllowed, false);
});

test('exact duplicate reuses the canonical hash and makes zero-AI route explicit', () => {
  const event = canonicalizeMarketIntelEvent(officialFiling());
  const firstKey = buildAnalysisKey(event, { promptVersion: 'market-intel-v1', analysisScope: 'CORE' });
  const secondKey = buildAnalysisKey(event, { promptVersion: 'market-intel-v1', analysisScope: 'CORE' });
  assert.equal(firstKey, secondKey);

  const routed = routeMarketIntelAi({
    event,
    nowMs: NOW,
    freshnessPolicyMs: FRESHNESS,
    seenRawHashes: [event.rawHash],
    promptVersion: 'market-intel-v1',
    analysisScope: 'CORE',
  });
  assert.equal(routed.ai.mode, 'NO_AI');
  assert.equal(routed.ai.cacheReuse, true);
  assert.ok(routed.reasons.includes('EXACT_DUPLICATE'));
});

test('prompt version changes the analysis key without changing raw evidence identity', () => {
  const event = canonicalizeMarketIntelEvent(officialFiling());
  const v1 = buildAnalysisKey(event, { promptVersion: 'market-intel-v1', analysisScope: 'CORE' });
  const v2 = buildAnalysisKey(event, { promptVersion: 'market-intel-v2', analysisScope: 'CORE' });
  assert.notEqual(v1, v2);
  assert.match(event.rawHash, /^[a-f0-9]{64}$/);
});

test('future publication and unverified sources fail closed before AI', () => {
  const future = routeMarketIntelAi({
    event: officialFiling({ publishedAt: '2026-08-28T00:00:00.000Z' }),
    nowMs: NOW,
    freshnessPolicyMs: FRESHNESS,
  });
  assert.equal(future.status, 'INVALID_EVIDENCE');
  assert.equal(future.ai.mode, 'NO_AI');
  assert.ok(future.reasons.includes('FUTURE_PUBLICATION_TIME'));

  const unverified = routeMarketIntelAi({
    event: officialFiling({
      sourceType: 'NEWS',
      sourceTier: 'TIER_5_UNVERIFIED',
      sourceName: 'unknown-community',
      sourceUrl: 'https://example.invalid/story',
      eventType: 'UNKNOWN',
    }),
    nowMs: NOW,
    freshnessPolicyMs: FRESHNESS,
  });
  assert.equal(unverified.status, 'NO_EVIDENCE');
  assert.equal(unverified.ai.mode, 'NO_AI');
  assert.ok(unverified.reasons.includes('SOURCE_UNVERIFIED'));
});
