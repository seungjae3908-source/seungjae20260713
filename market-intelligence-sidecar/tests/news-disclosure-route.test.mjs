import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { server } from '../src/server.mjs';

async function withServer(run) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('SIDECAR_TEST_ADDRESS_UNAVAILABLE');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function filingEvent(overrides = {}) {
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
    evidence: { facts: ['DART 원문 링크 확인'], inferences: [], uncertainty: [] },
    ...overrides,
  };
}

const routingEnvelope = {
  nowMs: Date.parse('2026-08-27T02:00:00.000Z'),
  freshnessPolicyMs: {
    futureToleranceMs: 60_000,
    freshMs: 6 * 60 * 60_000,
    agingMs: 24 * 60 * 60_000,
    staleMs: 72 * 60 * 60_000,
  },
  promptVersion: 'market-intel-v1',
  analysisScope: 'CORE',
};

test('loopback route exposes the canonical AI decision without granting trade authority', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/news-disclosure/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...routingEnvelope, event: filingEvent() }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.result.contract, 'MarketIntelAiRouteV1');
    assert.equal(payload.result.ai.mode, 'DEEP_AI');
    assert.match(payload.result.ai.analysisKey, /^[a-f0-9]{64}$/);
    assert.equal(payload.result.safety.executionAuthority, 'NONE');
    assert.equal(payload.result.safety.orderAllowed, false);
    assert.equal(payload.safety.privateTradingApiAllowed, false);
    assert.equal(payload.safety.realOrderAllowed, false);
  });
});

test('unverified public content is routed to NO_AI instead of fabricated analysis', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/news-disclosure/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...routingEnvelope,
        event: filingEvent({
          sourceType: 'NEWS',
          sourceTier: 'TIER_5_UNVERIFIED',
          sourceName: 'unknown-community',
          sourceUrl: 'https://example.invalid/story',
          eventType: 'UNKNOWN',
        }),
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.result.status, 'NO_EVIDENCE');
    assert.equal(payload.result.ai.mode, 'NO_AI');
    assert.ok(payload.result.reasons.includes('SOURCE_UNVERIFIED'));
  });
});

test('contracts advertise news/disclosure route as loopback routing only', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/contracts`);
    const payload = await response.json();
    assert.equal(payload.newsDisclosure.endpoint, '/v1/news-disclosure/route');
    assert.equal(payload.newsDisclosure.networkMode, 'LOOPBACK_ROUTING_ONLY');
    assert.equal(payload.newsDisclosure.generatedFactsAllowed, false);
    assert.equal(payload.newsDisclosure.orderAllowed, false);
  });
});
