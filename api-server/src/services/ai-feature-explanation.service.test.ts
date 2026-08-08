import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AiChatError } from './ai-chat.service';
import {
  generateStructuredFeatureExplanation,
  validateFeatureExplanationRequest,
} from './ai-feature-explanation.service';

const environmentKeys = [
  'AI_CHAT_PROVIDER',
  'AI_CHAT_API_KEY',
  'AI_CHAT_MODEL',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_MODEL',
] as const;

function snapshotEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
}

function clearEnvironment(): void {
  for (const key of environmentKeys) delete process.env[key];
}

function restoreEnvironment(snapshot: Record<string, string | undefined>): void {
  for (const key of environmentKeys) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function chartRequest() {
  return {
    task: 'chart_analysis_explanation' as const,
    taskVersion: '1' as const,
    sourceVersion: 'analysis:chart-v2:abc123',
    payload: {
      analysisId: 'analysis:abc123',
      engineVersion: 'chart-analysis-v2',
      market: 'KR' as const,
      symbol: '005930',
      displayName: '삼성전자',
      timeframe: '1D',
      dataAsOf: '2026-08-04T10:00:00.000Z',
      dataStatus: 'fresh',
      status: 'confirmed' as const,
      bias: 'bullish' as const,
      confidence: 78,
      title: '상승 구조 확인',
      summary: '완료된 봉 기준으로 상승 구조가 확인됐습니다.',
      reasons: ['추세가 상승 방향입니다.', '거래량 비율이 기준보다 높습니다.'],
      confirmationConditions: ['저항 돌파 후 완료봉 유지'],
      invalidationConditions: ['지지선 아래 완료봉 마감'],
      indicators: { rsi: 61.2, macd: 2.4, isClosedCandle: true },
    },
  };
}

function scannerRequest() {
  return {
    task: 'scanner_signal_explanation' as const,
    taskVersion: '1' as const,
    sourceVersion: 'signal-revision-7',
    payload: {
      signalId: 'signal-005930-1d',
      signalRevision: '7',
      market: 'KR' as const,
      symbol: '005930',
      displayName: '삼성전자',
      timeframe: '1D',
      state: 'READY_FOR_APPROVAL' as const,
      reasonCode: 'SIGNAL_READY',
      score: 84,
      confidence: 79,
      riskReward: 1.7,
      coreConditionsMaintained: true,
      reasons: ['거래량 증가', '추세 조건 유지'],
      warnings: [],
      dataTimestamp: '2026-08-04T10:00:00.000Z',
      expiresAt: '2026-08-04T10:10:00.000Z',
      matchedConditions: ['거래량 증가', '이동평균 돌파'],
    },
  };
}

function tradeRequest() {
  return {
    task: 'trade_plan_risk_explanation' as const,
    taskVersion: '1' as const,
    sourceVersion: 'plan-revision-3',
    payload: {
      planId: 'plan-paper-1',
      planRevision: '3',
      market: 'KR',
      symbol: '005930',
      side: 'buy' as const,
      accountMode: 'paper' as const,
      planState: 'APPROVAL_PENDING',
      signalState: 'READY_FOR_APPROVAL',
      approvalEnabled: false,
      approvalReasonCode: 'RISK_BUDGET_EXCEEDED',
      optimizationAllowed: false,
      blockCodes: ['RISK_BUDGET_EXCEEDED'],
      warnings: ['제안 노출 비율이 정책 상한을 초과합니다.'],
      expectedValueR: 0.21,
      stopDistancePercent: 3.2,
      riskBudgetPercent: 0.25,
      proposedExposurePercent: 42,
      entryZoneStatus: 'inside',
      pilotStage: 'approval-20',
    },
  };
}

function geminiResponse(content: unknown, status = 200): Response {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify(content) }] } }],
  }), { status, headers: { 'content-type': 'application/json' } });
}

test('structured chart explanation uses mock Gemini JSON and keeps the key out of the payload', async () => {
  const previous = snapshotEnvironment();
  clearEnvironment();
  process.env.GEMINI_API_KEY = 'structured-test-key';
  let calls = 0;
  let requestBody: any = null;
  let requestHeaders = new Headers();
  try {
    const result = await generateStructuredFeatureExplanation(chartRequest(), {
      fetchImpl: async (url, init) => {
        calls += 1;
        assert.match(String(url), /gemini-3\.1-flash-lite:generateContent$/);
        requestBody = JSON.parse(String(init?.body));
        requestHeaders = new Headers(init?.headers);
        return geminiResponse({
          plainSummary: '결정론적 차트 엔진의 상승 구조를 쉬운 말로 설명합니다.',
          bullishFactors: ['추세와 거래량 조건이 함께 유지되고 있습니다.'],
          bearishFactors: ['지지선 이탈 시 현재 구조가 약해질 수 있습니다.'],
          confirmationWatch: ['기존 확인 조건의 완료봉 충족 여부를 확인합니다.'],
          invalidationWatch: ['기존 무효 조건의 완료봉 발생 여부를 확인합니다.'],
          limitations: ['AI 설명은 차트 상태를 변경하지 않습니다.'],
          advisoryOnly: true,
        });
      },
    });

    assert.equal(calls, 1);
    assert.equal(requestHeaders.get('x-goog-api-key'), 'structured-test-key');
    assert.equal(requestHeaders.get('authorization'), null);
    assert.equal(requestBody.generationConfig.responseMimeType, 'application/json');
    assert.equal(requestBody.generationConfig.thinkingConfig.thinkingLevel, 'low');
    assert.match(requestBody.systemInstruction.parts[0].text, /read-only Korean financial explanation service/);
    assert.equal(requestBody.contents[0].role, 'user');
    assert.doesNotMatch(JSON.stringify(requestBody), /structured-test-key/);
    assert.doesNotMatch(JSON.stringify(requestBody), /approvalToken|idempotencyKey|accountBalance|orderAction/);
    assert.equal(result.task, 'chart_analysis_explanation');
    assert.equal(result.sourceVersion, 'analysis:chart-v2:abc123');
    assert.equal(result.model, 'gemini-3.1-flash-lite');
    assert.equal(result.advisoryOnly, true);
    assert.equal(result.content.advisoryOnly, true);
  } finally {
    restoreEnvironment(previous);
  }
});

test('structured input rejects browser-forged execution fields before any provider call', async () => {
  const previous = snapshotEnvironment();
  clearEnvironment();
  process.env.GEMINI_API_KEY = 'structured-test-key';
  let calls = 0;
  const forged = chartRequest() as any;
  forged.payload = { ...forged.payload, approvalToken: 'approval-secret-value' };
  try {
    assert.throws(
      () => validateFeatureExplanationRequest(forged),
      (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_FEATURE_INVALID_INPUT',
    );
    await assert.rejects(
      generateStructuredFeatureExplanation(forged, {
        fetchImpl: async () => { calls += 1; throw new Error('must not call'); },
      }),
      (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_FEATURE_INVALID_INPUT',
    );
    assert.equal(calls, 0);
  } finally {
    restoreEnvironment(previous);
  }
});

test('structured output rejects unknown state-changing fields and advisoryOnly false', async () => {
  const previous = snapshotEnvironment();
  clearEnvironment();
  process.env.GEMINI_API_KEY = 'structured-test-key';
  try {
    await assert.rejects(
      generateStructuredFeatureExplanation(scannerRequest(), {
        fetchImpl: async () => geminiResponse({
          plainSummary: '신호 상태를 설명합니다.',
          supportingFactors: [],
          riskFactors: [],
          whyApprovalIsEnabledOrBlocked: '서버 판정을 설명합니다.',
          nextDeterministicChecks: [],
          limitations: [],
          advisoryOnly: false,
          state: 'READY_FOR_APPROVAL',
        }),
      }),
      (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_FEATURE_INVALID_RESPONSE',
    );
  } finally {
    restoreEnvironment(previous);
  }
});

test('structured output blocks direct order and safety-bypass language', async () => {
  const previous = snapshotEnvironment();
  clearEnvironment();
  process.env.GEMINI_API_KEY = 'structured-test-key';
  try {
    await assert.rejects(
      generateStructuredFeatureExplanation(tradeRequest(), {
        fetchImpl: async () => geminiResponse({
          plainSummary: '차단은 무시하고 지금 매수하세요.',
          blockingReasonsExplained: [],
          riskNotes: [],
          planChecklist: [],
          dataLimitations: [],
          advisoryOnly: true,
        }),
      }),
      (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_FEATURE_UNSAFE_RESPONSE',
    );
  } finally {
    restoreEnvironment(previous);
  }
});

test('structured Gemini maps quota and provider failures without fallback', async () => {
  const previous = snapshotEnvironment();
  clearEnvironment();
  process.env.GEMINI_API_KEY = 'structured-test-key';
  try {
    await assert.rejects(
      generateStructuredFeatureExplanation(scannerRequest(), {
        fetchImpl: async () => new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }), { status: 429 }),
      }),
      (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_FEATURE_RATE_LIMITED' && cause.statusCode === 429,
    );
    await assert.rejects(
      generateStructuredFeatureExplanation(tradeRequest(), {
        fetchImpl: async () => new Response('provider unavailable', { status: 503 }),
      }),
      (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_FEATURE_PROVIDER_ERROR' && cause.statusCode === 502,
    );
  } finally {
    restoreEnvironment(previous);
  }
});

test('structured Gemini timeout aborts the mock request and returns no substitute explanation', async () => {
  const previous = snapshotEnvironment();
  clearEnvironment();
  process.env.GEMINI_API_KEY = 'structured-test-key';
  let aborted = 0;
  try {
    await assert.rejects(
      generateStructuredFeatureExplanation(chartRequest(), {
        timeoutMs: 5,
        fetchImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted += 1;
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        }),
      }),
      (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_FEATURE_TIMEOUT' && cause.statusCode === 504,
    );
    assert.equal(aborted, 1);
  } finally {
    restoreEnvironment(previous);
  }
});

test('structured explanation service has no feature UI, repository, adapter, queue, or route imports', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'api-server/src/services/ai-feature-explanation.service.ts'),
    'utf8',
  );
  const imports = source.match(/^import .*$/gm)?.join('\n') ?? '';
  assert.match(imports, /ai-chat\.service/);
  assert.doesNotMatch(imports, /stock-analyzer|routes|trade-automation|chart-analysis|scanner|repository|adapter|broker|exchange|queue/);
  assert.doesNotMatch(source, /app\.(?:use|post|get)|router\.(?:use|post|get)|createOrder|submitOrder|executeOrder|enqueueOrder|approvePlan/);
});
