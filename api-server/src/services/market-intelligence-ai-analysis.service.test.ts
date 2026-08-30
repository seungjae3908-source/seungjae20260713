import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MarketIntelligenceAiAnalyzer,
  type MarketIntelligencePublicEvidenceInput,
} from './market-intelligence-ai-analysis.service';
import type { AiChatResult } from './ai-chat.service';

const KEY = 'a'.repeat(64);

function input(overrides: Partial<MarketIntelligencePublicEvidenceInput> = {}): MarketIntelligencePublicEvidenceInput {
  return {
    analysisKey: KEY,
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
    headline: '공급계약 체결 공시',
    sourceText: '공식 공시에서 공급계약 체결 사실을 확인했다.',
    evidenceFacts: ['공급계약 체결 사실', '계약 금액은 원문 확인 필요'],
    conflictDetected: false,
    ...overrides,
  };
}

function analysisAnswer(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 'MarketIntelAiAnalysisV1',
    summaryShort: '공급계약 관련 공식 공시이며 추가 실적 영향 검증이 필요하다.',
    sentiment: 'NEUTRAL',
    importanceScore: 72,
    confidenceScore: 88,
    impactHorizon: 'SWING',
    factEvidenceRefs: [0],
    inferences: ['실적 기여도는 계약 조건 검증 후 판단해야 한다.'],
    uncertainty: ['마진과 실제 이행률은 현재 Evidence에 없다.'],
    riskFlags: [],
    catalystFlags: ['CONTRACT'],
    ...overrides,
  });
}

function aiResult(answer: string, model = 'gemini-test'): AiChatResult {
  return {
    answer,
    kind: 'answer',
    model,
    generatedAt: '2026-08-27T01:00:00.000Z',
    data: { status: 'not_requested', asOf: null, basis: 'server_collection_time', sources: [], missing: [] },
  };
}

test('NO_AI and invalid evidence routes make zero provider calls', async () => {
  let calls = 0;
  const analyzer = new MarketIntelligenceAiAnalyzer({
    answerAiChatImpl: async () => { calls += 1; return aiResult(analysisAnswer()); },
  });
  const noAi = await analyzer.analyze(input({ aiMode: 'NO_AI' }));
  const noEvidence = await analyzer.analyze(input({ analysisKey: 'b'.repeat(64), evidenceStatus: 'NO_EVIDENCE' }));
  assert.equal(noAi.status, 'SKIPPED');
  assert.equal(noAi.reason, 'AI_ROUTE_NO_AI');
  assert.equal(noEvidence.status, 'SKIPPED');
  assert.equal(noEvidence.reason, 'AI_BLOCKED_BY_EVIDENCE_STATUS');
  assert.equal(calls, 0);
  assert.equal(noAi.safety.executionAuthority, 'NONE');
  assert.equal(noAi.safety.orderAllowed, false);
});

test('secret-bearing public evidence is blocked before the existing AI provider chain', async () => {
  let calls = 0;
  const analyzer = new MarketIntelligenceAiAnalyzer({
    answerAiChatImpl: async () => { calls += 1; return aiResult(analysisAnswer()); },
  });
  const result = await analyzer.analyze(input({ evidenceFacts: ['api_key=super-secret-value'] }));
  assert.equal(result.status, 'AI_ANALYSIS_UNAVAILABLE');
  assert.equal(result.reason, 'PRIVATE_OR_SECRET_DATA_BLOCKED');
  assert.equal(calls, 0);
});

test('verified structured AI output can only reference caller-supplied fact indexes', async () => {
  let prompt = '';
  const analyzer = new MarketIntelligenceAiAnalyzer({
    answerAiChatImpl: async ({ message }) => {
      prompt = String(message);
      return aiResult(analysisAnswer({ factEvidenceRefs: [0, 1] }));
    },
  });
  const result = await analyzer.analyze(input());
  assert.equal(result.status, 'ANALYZED');
  assert.equal(result.model, 'gemini-test');
  assert.deepEqual(result.analysis?.factEvidenceRefs, [0, 1]);
  assert.equal(result.safety.generatedFactsAllowed, false);
  assert.equal(result.safety.sentimentIsPriceDirection, false);
  assert.match(prompt, /factEvidenceRefs/);
  assert.match(prompt, /새 사실\/숫자를 만들지 말고/);
  assert.match(prompt, /매수·매도·롱·숏 지시를 하지 않는다/);
  assert.ok(prompt.length <= 1_950);
});

test('AI free text rejects invented URLs and unsupported numeric factual claims', async () => {
  const inventedUrl = new MarketIntelligenceAiAnalyzer({
    answerAiChatImpl: async () => aiResult(analysisAnswer({ summaryShort: '공식 공시는 https://fake.example 에서 확인된다.' })),
  });
  const inventedUrlResult = await inventedUrl.analyze(input({ analysisKey: 'e'.repeat(64) }));
  assert.equal(inventedUrlResult.status, 'AI_ANALYSIS_UNAVAILABLE');
  assert.equal(inventedUrlResult.reason, 'AI_STRUCTURED_RESPONSE_INVALID');

  const inventedAmount = new MarketIntelligenceAiAnalyzer({
    answerAiChatImpl: async () => aiResult(analysisAnswer({ summaryShort: '계약 금액은 999억원이다.' })),
  });
  const inventedAmountResult = await inventedAmount.analyze(input({ analysisKey: 'f'.repeat(64) }));
  assert.equal(inventedAmountResult.status, 'AI_ANALYSIS_UNAVAILABLE');
  assert.equal(inventedAmountResult.reason, 'AI_STRUCTURED_RESPONSE_INVALID');
});

test('numeric fact copied from public evidence remains allowed without becoming scanner authority', async () => {
  const analyzer = new MarketIntelligenceAiAnalyzer({
    answerAiChatImpl: async () => aiResult(analysisAnswer({ summaryShort: '공식 공시의 계약 금액은 120억원이며 추가 검증이 필요하다.', factEvidenceRefs: [1] })),
  });
  const result = await analyzer.analyze(input({
    analysisKey: '1'.repeat(64),
    sourceText: '공식 공시의 계약 금액은 120억원이다.',
    evidenceFacts: ['공급계약 체결 사실', '계약 금액은 120억원'],
  }));
  assert.equal(result.status, 'ANALYZED');
  assert.equal(result.analysis?.summaryShort, '공식 공시의 계약 금액은 120억원이며 추가 검증이 필요하다.');
  assert.deepEqual(result.analysis?.factEvidenceRefs, [1]);
  assert.equal(result.safety.executionAuthority, 'NONE');
  assert.equal(result.safety.generatedFactsAllowed, false);
});

test('numeric grounding rejects substrings of larger facts and publication timestamps', async () => {
  for (const summaryShort of ['확인된 수치는 75이다.', '확인된 수치는 26이다.']) {
    const analyzer = new MarketIntelligenceAiAnalyzer({
      answerAiChatImpl: async () => aiResult(analysisAnswer({ summaryShort })),
    });
    const result = await analyzer.analyze(input({
      sourceText: '확인된 수치는 750이다.',
      evidenceFacts: ['확인된 수치는 750이다.'],
    }));
    assert.equal(result.status, 'AI_ANALYSIS_UNAVAILABLE', summaryShort);
    assert.equal(result.reason, 'AI_STRUCTURED_RESPONSE_INVALID');
    assert.equal(result.analysis, null);
    assert.equal(result.safety.orderAllowed, false);
  }
});

test('numeric factual claims require a supporting cited fact, not an uncited corpus match', async () => {
  for (const factEvidenceRefs of [[], [0]]) {
    const analyzer = new MarketIntelligenceAiAnalyzer({
      answerAiChatImpl: async () => aiResult(analysisAnswer({
        summaryShort: '계약 금액은 120억원이다.', factEvidenceRefs,
      })),
    });
    const result = await analyzer.analyze(input({
      sourceText: '계약 금액은 120억원이다.',
      evidenceFacts: ['공급계약 체결 사실', '계약 금액은 120억원이다.'],
    }));
    assert.equal(result.status, 'AI_ANALYSIS_UNAVAILABLE');
    assert.equal(result.reason, 'AI_STRUCTURED_RESPONSE_INVALID');
    assert.equal(result.analysis, null);
  }
});

test('numeric grounding preserves exact values, currency and scale with harmless grouping differences', async () => {
  const analyzer = new MarketIntelligenceAiAnalyzer({
    answerAiChatImpl: async () => aiResult(analysisAnswer({
      summaryShort: '공시 금액은 $1200.50이다.', factEvidenceRefs: [0],
    })),
  });
  const result = await analyzer.analyze(input({ evidenceFacts: ['공시 금액은 $1,200.50이다.'] }));
  assert.equal(result.status, 'ANALYZED');
  assert.equal(result.safety.executionAuthority, 'NONE');

  for (const summaryShort of ['공시 금액은 $1,200이다.', '공시 금액은 1200.50원이다.', '공시 금액은 1200.50억원이다.']) {
    const invalid = new MarketIntelligenceAiAnalyzer({
      answerAiChatImpl: async () => aiResult(analysisAnswer({ summaryShort, factEvidenceRefs: [0] })),
    });
    const rejected = await invalid.analyze(input({ evidenceFacts: ['공시 금액은 $1,200.50이다.'] }));
    assert.equal(rejected.status, 'AI_ANALYSIS_UNAVAILABLE', summaryShort);
    assert.equal(rejected.analysis, null);
  }
});

test('malformed or out-of-range structured responses fail closed', async () => {
  const malformed = new MarketIntelligenceAiAnalyzer({ answerAiChatImpl: async () => aiResult('not-json') });
  const malformedResult = await malformed.analyze(input());
  assert.equal(malformedResult.status, 'AI_ANALYSIS_UNAVAILABLE');
  assert.equal(malformedResult.reason, 'AI_STRUCTURED_RESPONSE_INVALID');

  const outOfRange = new MarketIntelligenceAiAnalyzer({
    answerAiChatImpl: async () => aiResult(analysisAnswer({ factEvidenceRefs: [99] })),
  });
  const outOfRangeResult = await outOfRange.analyze(input({ analysisKey: 'c'.repeat(64) }));
  assert.equal(outOfRangeResult.status, 'AI_ANALYSIS_UNAVAILABLE');
  assert.equal(outOfRangeResult.reason, 'AI_STRUCTURED_RESPONSE_INVALID');
});

test('unsafe trade instruction in model output is rejected instead of becoming intelligence', async () => {
  const analyzer = new MarketIntelligenceAiAnalyzer({
    answerAiChatImpl: async () => aiResult(analysisAnswer({ summaryShort: '지금 즉시 매수하세요.' })),
  });
  const result = await analyzer.analyze(input());
  assert.equal(result.status, 'AI_ANALYSIS_UNAVAILABLE');
  assert.equal(result.reason, 'AI_STRUCTURED_RESPONSE_INVALID');
  assert.equal(result.safety.orderAllowed, false);
});

test('same analysisKey reuses completed cache and makes one provider call', async () => {
  let calls = 0;
  let now = 1_000;
  const analyzer = new MarketIntelligenceAiAnalyzer({
    now: () => now,
    cacheTtlMs: 60_000,
    answerAiChatImpl: async () => { calls += 1; return aiResult(analysisAnswer()); },
  });
  const first = await analyzer.analyze(input());
  const second = await analyzer.analyze(input());
  assert.equal(first.cache, 'MISS');
  assert.equal(second.cache, 'HIT');
  assert.equal(calls, 1);
  assert.equal(analyzer.stats.cacheHits, 1);
  now += 61_000;
  const third = await analyzer.analyze(input());
  assert.equal(third.cache, 'MISS');
  assert.equal(calls, 2);
});

test('concurrent same analysisKey uses a single provider request', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const analyzer = new MarketIntelligenceAiAnalyzer({
    answerAiChatImpl: async () => {
      calls += 1;
      await gate;
      return aiResult(analysisAnswer());
    },
  });
  const first = analyzer.analyze(input());
  const second = analyzer.analyze(input());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 'ANALYZED');
  assert.equal(b.status, 'ANALYZED');
  assert.equal(b.cache, 'IN_FLIGHT_REUSE');
  assert.equal(analyzer.stats.inFlightHits, 1);
});

test('provider errors become explicit AI_ANALYSIS_UNAVAILABLE with zero execution authority', async () => {
  const error = Object.assign(new Error('quota'), { code: 'AI_CHAT_RATE_LIMITED' });
  const analyzer = new MarketIntelligenceAiAnalyzer({ answerAiChatImpl: async () => { throw error; } });
  const result = await analyzer.analyze(input());
  assert.equal(result.status, 'AI_ANALYSIS_UNAVAILABLE');
  assert.equal(result.reason, 'AI_CHAT_RATE_LIMITED');
  assert.equal(result.analysis, null);
  assert.equal(result.safety.executionAuthority, 'NONE');
  assert.equal(result.safety.orderAllowed, false);
  assert.equal(analyzer.stats.unavailable, 1);
});

test('invalid analysis key and missing public evidence fail before provider invocation', async () => {
  let calls = 0;
  const analyzer = new MarketIntelligenceAiAnalyzer({
    answerAiChatImpl: async () => { calls += 1; return aiResult(analysisAnswer()); },
  });
  const badKey = await analyzer.analyze(input({ analysisKey: 'not-a-key' }));
  const missing = await analyzer.analyze(input({ analysisKey: 'd'.repeat(64), headline: null, sourceText: null, evidenceFacts: [] }));
  assert.equal(badKey.reason, 'ANALYSIS_KEY_INVALID');
  assert.equal(missing.reason, 'PUBLIC_EVIDENCE_MISSING');
  assert.equal(calls, 0);
});
