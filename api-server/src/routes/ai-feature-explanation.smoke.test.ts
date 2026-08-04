import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import aiChatRouter from './ai-chat';

const environmentKeys = [
  'AI_CHAT_PROVIDER',
  'AI_CHAT_API_KEY',
  'AI_CHAT_MODEL',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_MODEL',
] as const;

type MemberTier = 'associate' | 'regular' | null;
type RouteResult = {
  statusCode: number;
  body: Record<string, unknown>;
  text: string;
};

let requestSequence = 0;

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

function chartBody() {
  return {
    taskVersion: '1',
    sourceVersion: 'analysis:chart-v2:route-test',
    payload: {
      analysisId: 'analysis:route-test',
      engineVersion: 'chart-analysis-v2',
      market: 'KR',
      symbol: '005930',
      displayName: '삼성전자',
      timeframe: '1D',
      dataAsOf: '2026-08-04T10:00:00.000Z',
      dataStatus: 'fresh',
      status: 'confirmed',
      bias: 'bullish',
      confidence: 78,
      title: '상승 구조 확인',
      summary: '완료된 봉 기준으로 상승 구조가 확인됐습니다.',
      reasons: ['추세가 상승 방향입니다.'],
      confirmationConditions: ['저항 돌파 후 완료봉 유지'],
      invalidationConditions: ['지지선 아래 완료봉 마감'],
      indicators: { rsi: 61.2, macd: 2.4, isClosedCandle: true },
    },
  };
}

function scannerBody() {
  return {
    taskVersion: '1',
    sourceVersion: 'signal-revision-route-test',
    payload: {
      signalId: 'signal-route-test',
      signalRevision: '7',
      market: 'KR',
      symbol: '005930',
      displayName: '삼성전자',
      timeframe: '1D',
      state: 'READY_FOR_APPROVAL',
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

function tradeBody() {
  return {
    taskVersion: '1',
    sourceVersion: 'plan-revision-route-test',
    payload: {
      planId: 'plan-paper-route-test',
      planRevision: '3',
      market: 'KR',
      symbol: '005930',
      side: 'buy',
      accountMode: 'paper',
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

function providerContent(task: string): Record<string, unknown> {
  if (task === 'chart_analysis_explanation') {
    return {
      plainSummary: '결정론적 차트 상태를 읽기 전용으로 설명합니다.',
      bullishFactors: ['추세 조건이 유지되고 있습니다.'],
      bearishFactors: ['무효 조건을 계속 확인해야 합니다.'],
      confirmationWatch: ['기존 확인 조건만 확인합니다.'],
      invalidationWatch: ['기존 무효 조건만 확인합니다.'],
      limitations: ['AI 설명은 차트 상태를 변경하지 않습니다.'],
      advisoryOnly: true,
    };
  }
  if (task === 'scanner_signal_explanation') {
    return {
      plainSummary: '결정론적 신호 상태를 읽기 전용으로 설명합니다.',
      supportingFactors: ['서버가 제공한 조건 유지 상태를 설명합니다.'],
      riskFactors: ['만료와 무효 조건을 확인해야 합니다.'],
      whyApprovalIsEnabledOrBlocked: '승인 가능 여부는 기존 서버 판정만 따릅니다.',
      nextDeterministicChecks: ['다음 서버 재검증 결과를 확인합니다.'],
      limitations: ['AI 설명은 신호 상태를 변경하지 않습니다.'],
      advisoryOnly: true,
    };
  }
  return {
    plainSummary: '결정론적 주문계획 위험 상태를 읽기 전용으로 설명합니다.',
    blockingReasonsExplained: ['위험 예산 차단 사유를 설명합니다.'],
    riskNotes: ['기존 정책 상한을 변경하지 않습니다.'],
    planChecklist: ['서버 위험 판정 결과를 확인합니다.'],
    dataLimitations: ['AI 설명은 승인이나 주문을 실행하지 않습니다.'],
    advisoryOnly: true,
  };
}

async function postRoute(
  routePath: string,
  payload: unknown,
  tier: MemberTier = 'regular',
): Promise<RouteResult> {
  const app = express();
  app.use(express.json());
  if (tier) {
    const memberId = `ai-feature-route-${tier}-${++requestSequence}`;
    app.use((req, _res, next) => {
      Object.assign(req, {
        member: {
          id: memberId,
          login_name: memberId,
          display_name: memberId,
          role: tier,
          status: 'approved',
          membership_level: tier,
          is_active: true,
        },
        membershipLevel: tier,
      });
      next();
    });
  }
  app.use('/api', aiChatRouter);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('AI feature route test server did not expose a TCP address');
  }

  try {
    return await new Promise<RouteResult>((resolve, reject) => {
      const body = JSON.stringify(payload);
      const clientRequest = request({
        hostname: '127.0.0.1',
        port: address.port,
        path: `/api${routePath}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsedBody: Record<string, unknown> = {};
          if (text) {
            try {
              parsedBody = JSON.parse(text) as Record<string, unknown>;
            } catch {
              parsedBody = {};
            }
          }
          resolve({
            statusCode: response.statusCode ?? 0,
            body: parsedBody,
            text,
          });
        });
      });
      clientRequest.once('error', reject);
      clientRequest.end(body);
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((cause) => cause ? reject(cause) : resolve());
    });
  }
}

test('read-only feature routes inject fixed tasks and expose no mutation or order authority', async () => {
  const previousEnvironment = snapshotEnvironment();
  const previousFetch = globalThis.fetch;
  const testKey = 'route-structured-test-key';
  const providerTasks: string[] = [];
  let providerCalls = 0;

  clearEnvironment();
  process.env.GEMINI_API_KEY = testKey;
  globalThis.fetch = async (_input, init) => {
    providerCalls += 1;
    const headers = new Headers(init?.headers);
    const bodyText = String(init?.body ?? '');
    const providerBody = JSON.parse(bodyText) as {
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    };
    const requestPayload = JSON.parse(providerBody.contents?.[0]?.parts?.[0]?.text ?? '{}') as { task?: string };
    const task = requestPayload.task ?? '';
    providerTasks.push(task);
    assert.equal(headers.get('x-goog-api-key'), testKey);
    assert.equal(headers.get('authorization'), null);
    assert.doesNotMatch(bodyText, new RegExp(testKey));
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(providerContent(task)) }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const chart = await postRoute('/ai/features/chart/explanation', chartBody(), 'associate');
    const scanner = await postRoute('/ai/features/scanner/explanation', scannerBody(), 'associate');
    const trade = await postRoute('/ai/features/trade-plan/explanation', tradeBody(), 'regular');

    for (const result of [chart, scanner, trade]) {
      assert.equal(result.statusCode, 200);
      assert.equal(result.body.ok, true);
      assert.equal(result.body.advisoryOnly, true);
      assert.equal(result.body.inputAuthority, 'validated-client-snapshot');
      assert.equal(result.body.authoritativeStateUsed, false);
      assert.equal(result.body.mutationPerformed, false);
      assert.equal(result.body.orderRequestSent, false);
      assert.doesNotMatch(result.text, new RegExp(testKey));
    }

    assert.deepEqual(providerTasks, [
      'chart_analysis_explanation',
      'scanner_signal_explanation',
      'trade_plan_risk_explanation',
    ]);
    assert.equal(providerCalls, 3);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment(previousEnvironment);
  }
});

test('feature routes reject forged task fields and capability bypasses before provider calls', async () => {
  const previousEnvironment = snapshotEnvironment();
  const previousFetch = globalThis.fetch;
  let providerCalls = 0;

  clearEnvironment();
  process.env.GEMINI_API_KEY = 'route-structured-test-key';
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error('provider must not be called');
  };

  try {
    const forged = await postRoute('/ai/features/chart/explanation', {
      ...chartBody(),
      task: 'trade_plan_risk_explanation',
    }, 'associate');
    assert.equal(forged.statusCode, 400);
    assert.equal(forged.body.error, 'AI_FEATURE_INVALID_INPUT');
    assert.equal(forged.body.mutationPerformed, false);
    assert.equal(forged.body.orderRequestSent, false);

    const insufficient = await postRoute('/ai/features/trade-plan/explanation', tradeBody(), 'associate');
    assert.equal(insufficient.statusCode, 403);
    assert.equal(insufficient.body.error, 'CAPABILITY_REQUIRED');

    const unauthenticated = await postRoute('/ai/features/chart/explanation', chartBody(), null);
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(unauthenticated.body.error, 'LOGIN_REQUIRED');

    const nonexistentExecution = await postRoute('/ai/features/trade-plan/execute', tradeBody(), 'regular');
    assert.equal(nonexistentExecution.statusCode, 404);
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment(previousEnvironment);
  }
});

test('feature route maps free-tier quota exhaustion without fallback or order side effects', async () => {
  const previousEnvironment = snapshotEnvironment();
  const previousFetch = globalThis.fetch;
  let providerCalls = 0;

  clearEnvironment();
  process.env.GEMINI_API_KEY = 'route-structured-test-key';
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }), { status: 429 });
  };

  try {
    const result = await postRoute('/ai/features/scanner/explanation', scannerBody(), 'regular');
    assert.equal(result.statusCode, 429);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error, 'AI_FEATURE_RATE_LIMITED');
    assert.equal(result.body.advisoryOnly, true);
    assert.equal(result.body.mutationPerformed, false);
    assert.equal(result.body.orderRequestSent, false);
    assert.equal(providerCalls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment(previousEnvironment);
  }
});

test('read-only feature route source contains no account, queue, adapter, or order execution integration', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'api-server/src/routes/ai-chat.ts'),
    'utf8',
  );
  assert.doesNotMatch(source, /createOrder|submitOrder|executeOrder|enqueueOrder|approvePlan|cancelOrder|closePosition/);
  assert.doesNotMatch(source, /broker|exchangeAdapter|trade-automation\.service|trade-automation\.repository/);
  assert.doesNotMatch(source, /\/accounts|\/positions|\/orders/);
  assert.doesNotMatch(source, /AIza[0-9A-Za-z_-]{20,}|sk-[0-9A-Za-z_-]{12,}/);
});
