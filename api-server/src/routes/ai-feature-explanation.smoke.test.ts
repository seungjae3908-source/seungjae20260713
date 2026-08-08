import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import aiChatRouter from './ai-chat';
import {
  setAiFeatureAuthorityRepositoryFactoryForTests,
} from '../services/ai-feature-authority.service';
import type { TradingRepository } from '../services/trade-automation.repository';
import {
  DEFAULT_TRADING_POLICY,
  type TradingPlan,
  type TradingPolicy,
} from '../services/trade-automation.types';

const environmentKeys = [
  'AI_CHAT_PROVIDER',
  'AI_CHAT_API_KEY',
  'AI_CHAT_MODEL',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_MODEL',
  'TRADING_EMERGENCY_STOP',
  'ORDER_EXECUTION_ENABLED',
  'LIVE_TRADING_ACTIVATION_APPROVED',
  'BITGET_LIVE_ORDER_ENABLED',
  'UPBIT_LIVE_ORDER_ENABLED',
  'KIWOOM_LIVE_ORDER_ENABLED',
] as const;

type MemberTier = 'associate' | 'regular' | null;
type RouteResult = {
  statusCode: number;
  body: Record<string, unknown>;
  text: string;
};
type MutationCounts = Record<string, number>;

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

function tradeIdentifier(planId = 'plan-authoritative-test') {
  return { taskVersion: '1', planId };
}

function authoritativePlan(
  userId: string,
  overrides: Partial<TradingPlan> = {},
): TradingPlan {
  const now = Date.now();
  const updatedAt = new Date(now - 1_000).toISOString();
  return {
    exchange: 'kiwoom',
    accountMode: 'paper',
    strategyId: 'strategy-authoritative-test',
    signalId: 'signal-authoritative-test',
    symbol: '005930',
    market: 'KR',
    side: 'buy',
    orderType: 'limit',
    quantity: 1,
    quoteAmount: null,
    limitPrice: 100_000,
    estimatedKrw: 100_000,
    stopPrice: 95_000,
    targetPrices: [110_000],
    splitRatios: [100],
    leverage: null,
    marginMode: null,
    reduceOnly: false,
    invalidateAction: 'hold',
    signalReasons: ['서버 저장 계획 테스트'],
    marketSnapshot: {
      observedAt: new Date(now).toISOString(),
      dataDelayMs: 0,
      oneMinuteMovePercent: 0.5,
      spreadPercent: 0.1,
      orderbookGapPercent: 0.2,
      halted: false,
      availableBalance: 1_000_000,
      accountValueKrw: 1_000_000,
      dailyPnlPercent: 0,
      assetExposurePercent: 5,
      openPositionCount: 0,
      dailyOrderCount: 0,
      consecutiveLosses: 0,
      existingPositionSide: null,
      liquidationDistancePercent: null,
    },
    id: 'plan-authoritative-test',
    userId,
    idempotencyKey: 'server-private-idempotency-value',
    state: 'APPROVAL_PENDING',
    approvalExpiresAt: new Date(now + 10 * 60_000).toISOString(),
    approvedAt: null,
    createdAt: new Date(now - 60_000).toISOString(),
    updatedAt,
    ...overrides,
  };
}

function authoritativePolicy(): TradingPolicy {
  return {
    ...DEFAULT_TRADING_POLICY,
    mode: 'approval',
    automaticEnabled: false,
    emergencyStopped: false,
    exchangeEnabled: { ...DEFAULT_TRADING_POLICY.exchangeEnabled },
    enabledAssets: {
      bitget: [...DEFAULT_TRADING_POLICY.enabledAssets.bitget],
      upbit: [...DEFAULT_TRADING_POLICY.enabledAssets.upbit],
      kiwoom: [...DEFAULT_TRADING_POLICY.enabledAssets.kiwoom],
    },
    enabledStrategies: [...DEFAULT_TRADING_POLICY.enabledStrategies],
  };
}

function readOnlyRepository(
  ownerUserId: string,
  plan: TradingPlan | null,
  mutationCounts: MutationCounts,
): TradingRepository {
  const mutation = (name: string): never => {
    mutationCounts[name] = (mutationCounts[name] ?? 0) + 1;
    throw new Error(`unexpected mutation: ${name}`);
  };
  const policy = authoritativePolicy();
  return {
    async getGlobalEmergencyStop() { return false; },
    async setGlobalEmergencyStop() { return mutation('setGlobalEmergencyStop'); },
    async getPolicy(userId) {
      assert.equal(userId, ownerUserId);
      return policy;
    },
    async savePolicy() { return mutation('savePolicy'); },
    async getConnections() { return []; },
    async getConnection() { return null; },
    async saveConnection() { return mutation('saveConnection'); },
    async findPlanByIdempotency() { return null; },
    async getPlan(userId, id) {
      if (userId !== ownerUserId || !plan || id !== plan.id || plan.userId !== userId) return null;
      return structuredClone(plan);
    },
    async listPlans(userId) {
      if (userId !== ownerUserId || !plan || plan.userId !== userId) return [];
      return [structuredClone(plan)];
    },
    async insertPlan() { return mutation('insertPlan'); },
    async compareAndSetPlan() { return mutation('compareAndSetPlan'); },
    async savePlan() { return mutation('savePlan'); },
    async getOrder() { return null; },
    async findOrderByPlan() { return null; },
    async createOrderAtomic() { return mutation('createOrderAtomic'); },
    async transitionOrderAtomic() { return mutation('transitionOrderAtomic'); },
    async claimOrderExecution() { return mutation('claimOrderExecution'); },
    async saveOrder() { return mutation('saveOrder'); },
    async listOrders() { return []; },
    async appendEvent() { return mutation('appendEvent'); },
    async listEvents() { return []; },
  };
}

function providerContent(): Record<string, unknown> {
  return {
    plainSummary: '서버가 불러온 주문계획 위험 상태를 읽기 전용으로 설명합니다.',
    blockingReasonsExplained: [],
    riskNotes: ['기존 정책과 위험 재검사 결과를 변경하지 않습니다.'],
    planChecklist: ['서버가 표시한 승인 가능 여부를 확인합니다.'],
    dataLimitations: ['AI 설명은 승인이나 주문을 실행하지 않습니다.'],
    advisoryOnly: true,
  };
}

async function postRoute(
  routePath: string,
  payload: unknown,
  tier: MemberTier = 'regular',
  userId = 'authority-owner-user',
): Promise<RouteResult> {
  const app = express();
  app.use(express.json());
  if (tier) {
    app.use((req, _res, next) => {
      Object.assign(req, {
        member: {
          id: userId,
          login_name: userId,
          display_name: userId,
          role: tier,
          status: 'approved',
          membership_level: tier,
          is_active: true,
        },
        accessToken: 'test-access-token',
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
          resolve({ statusCode: response.statusCode ?? 0, body: parsedBody, text });
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

test('trade-plan explanation loads the user-scoped server record and sends only sanitized authority data', async () => {
  const previousEnvironment = snapshotEnvironment();
  const previousFetch = globalThis.fetch;
  const testKey = 'route-authority-test-key';
  const ownerUserId = 'authority-owner-user-1';
  const plan = authoritativePlan(ownerUserId);
  const mutationCounts: MutationCounts = {};
  const repository = readOnlyRepository(ownerUserId, plan, mutationCounts);
  let providerCalls = 0;
  let providerRequest: any = null;

  clearEnvironment();
  process.env.GEMINI_API_KEY = testKey;
  setAiFeatureAuthorityRepositoryFactoryForTests(() => repository);
  globalThis.fetch = async (_input, init) => {
    providerCalls += 1;
    const headers = new Headers(init?.headers);
    const providerBody = JSON.parse(String(init?.body ?? '{}')) as {
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    };
    providerRequest = JSON.parse(providerBody.contents?.[0]?.parts?.[0]?.text ?? '{}');
    assert.equal(headers.get('x-goog-api-key'), testKey);
    assert.equal(headers.get('authorization'), null);
    assert.doesNotMatch(String(init?.body ?? ''), new RegExp(testKey));
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(providerContent()) }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await postRoute(
      '/ai/features/trade-plan/explanation',
      tradeIdentifier(plan.id),
      'regular',
      ownerUserId,
    );

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.advisoryOnly, true);
    assert.equal(result.body.inputAuthority, 'server-authoritative');
    assert.equal(result.body.authoritativeStateUsed, true);
    assert.equal(result.body.mutationPerformed, false);
    assert.equal(result.body.orderRequestSent, false);
    assert.equal(providerCalls, 1);
    assert.equal(providerRequest.task, 'trade_plan_risk_explanation');
    assert.equal(providerRequest.sourceVersion, `trade-plan:${plan.id}:${plan.updatedAt}`);
    assert.equal(providerRequest.payload.planId, plan.id);
    assert.equal(providerRequest.payload.planRevision, plan.updatedAt);
    assert.equal(providerRequest.payload.symbol, plan.symbol);
    assert.equal(providerRequest.payload.approvalEnabled, true);
    assert.equal(providerRequest.payload.approvalReasonCode, null);
    assert.equal(providerRequest.payload.optimizationAllowed, false);
    assert.equal(providerRequest.payload.stopDistancePercent, 5);
    assert.equal(providerRequest.payload.riskBudgetPercent, 30);
    assert.equal(providerRequest.payload.proposedExposurePercent, 15);
    const serialized = JSON.stringify(providerRequest);
    assert.doesNotMatch(serialized, /server-private-idempotency-value|idempotencyKey|userId|availableBalance|accountValueKrw/);
    assert.doesNotMatch(result.text, new RegExp(testKey));
    assert.deepEqual(mutationCounts, {});
  } finally {
    setAiFeatureAuthorityRepositoryFactoryForTests(null);
    globalThis.fetch = previousFetch;
    restoreEnvironment(previousEnvironment);
  }
});

test('chart and scanner routes fail closed until their server authority records are integrated', async () => {
  const previousEnvironment = snapshotEnvironment();
  const previousFetch = globalThis.fetch;
  let providerCalls = 0;

  clearEnvironment();
  process.env.GEMINI_API_KEY = 'route-authority-test-key';
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error('provider must not be called');
  };

  try {
    const chart = await postRoute(
      '/ai/features/chart/explanation',
      { taskVersion: '1', analysisId: 'analysis-authority-test' },
      'associate',
      'authority-chart-user',
    );
    const scanner = await postRoute(
      '/ai/features/scanner/explanation',
      { taskVersion: '1', signalId: 'signal-authority-test' },
      'associate',
      'authority-scanner-user',
    );

    for (const result of [chart, scanner]) {
      assert.equal(result.statusCode, 503);
      assert.equal(result.body.error, 'AI_FEATURE_AUTHORITY_NOT_AVAILABLE');
      assert.equal(result.body.inputAuthority, 'server-authoritative-required');
      assert.equal(result.body.authoritativeStateUsed, false);
      assert.equal(result.body.mutationPerformed, false);
      assert.equal(result.body.orderRequestSent, false);
    }
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment(previousEnvironment);
  }
});

test('authority routes reject client snapshots, ownership bypasses, and execution paths before provider calls', async () => {
  const previousEnvironment = snapshotEnvironment();
  const previousFetch = globalThis.fetch;
  const ownerUserId = 'authority-owner-user-2';
  const plan = authoritativePlan(ownerUserId);
  const mutationCounts: MutationCounts = {};
  const repository = readOnlyRepository(ownerUserId, plan, mutationCounts);
  let providerCalls = 0;

  clearEnvironment();
  process.env.GEMINI_API_KEY = 'route-authority-test-key';
  setAiFeatureAuthorityRepositoryFactoryForTests(() => repository);
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error('provider must not be called');
  };

  try {
    const forged = await postRoute('/ai/features/trade-plan/explanation', {
      ...tradeIdentifier(plan.id),
      task: 'chart_analysis_explanation',
      payload: { approvalEnabled: true, blockCodes: [] },
    }, 'regular', ownerUserId);
    assert.equal(forged.statusCode, 400);
    assert.equal(forged.body.error, 'AI_FEATURE_INVALID_INPUT');

    const legacySnapshot = await postRoute('/ai/features/chart/explanation', {
      taskVersion: '1',
      sourceVersion: 'browser-version',
      payload: { status: 'confirmed', confidence: 100 },
    }, 'associate', 'authority-legacy-user');
    assert.equal(legacySnapshot.statusCode, 400);
    assert.equal(legacySnapshot.body.error, 'AI_FEATURE_INVALID_INPUT');

    const missing = await postRoute(
      '/ai/features/trade-plan/explanation',
      tradeIdentifier('missing-plan'),
      'regular',
      ownerUserId,
    );
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.body.error, 'AI_FEATURE_SOURCE_NOT_FOUND');

    const crossUser = await postRoute(
      '/ai/features/trade-plan/explanation',
      tradeIdentifier(plan.id),
      'regular',
      'different-user',
    );
    assert.equal(crossUser.statusCode, 404);
    assert.equal(crossUser.body.error, 'AI_FEATURE_SOURCE_NOT_FOUND');

    const insufficient = await postRoute(
      '/ai/features/trade-plan/explanation',
      tradeIdentifier(plan.id),
      'associate',
      ownerUserId,
    );
    assert.equal(insufficient.statusCode, 403);
    assert.equal(insufficient.body.error, 'CAPABILITY_REQUIRED');

    const unauthenticated = await postRoute(
      '/ai/features/chart/explanation',
      { taskVersion: '1', analysisId: 'analysis-authority-test' },
      null,
    );
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(unauthenticated.body.error, 'LOGIN_REQUIRED');

    const nonexistentExecution = await postRoute(
      '/ai/features/trade-plan/execute',
      tradeIdentifier(plan.id),
      'regular',
      ownerUserId,
    );
    assert.equal(nonexistentExecution.statusCode, 404);
    assert.equal(providerCalls, 0);
    assert.deepEqual(mutationCounts, {});
  } finally {
    setAiFeatureAuthorityRepositoryFactoryForTests(null);
    globalThis.fetch = previousFetch;
    restoreEnvironment(previousEnvironment);
  }
});

test('authoritative trade-plan route maps free-tier quota exhaustion without fallback or mutations', async () => {
  const previousEnvironment = snapshotEnvironment();
  const previousFetch = globalThis.fetch;
  const ownerUserId = 'authority-owner-user-3';
  const plan = authoritativePlan(ownerUserId);
  const mutationCounts: MutationCounts = {};
  const repository = readOnlyRepository(ownerUserId, plan, mutationCounts);
  let providerCalls = 0;

  clearEnvironment();
  process.env.GEMINI_API_KEY = 'route-authority-test-key';
  setAiFeatureAuthorityRepositoryFactoryForTests(() => repository);
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }), { status: 429 });
  };

  try {
    const result = await postRoute(
      '/ai/features/trade-plan/explanation',
      tradeIdentifier(plan.id),
      'regular',
      ownerUserId,
    );
    assert.equal(result.statusCode, 429);
    assert.equal(result.body.error, 'AI_FEATURE_RATE_LIMITED');
    assert.equal(result.body.inputAuthority, 'server-authoritative-required');
    assert.equal(result.body.authoritativeStateUsed, false);
    assert.equal(result.body.mutationPerformed, false);
    assert.equal(result.body.orderRequestSent, false);
    assert.equal(providerCalls, 1);
    assert.deepEqual(mutationCounts, {});
  } finally {
    setAiFeatureAuthorityRepositoryFactoryForTests(null);
    globalThis.fetch = previousFetch;
    restoreEnvironment(previousEnvironment);
  }
});

test('mock plans fail before provider use instead of being relabeled as paper plans', async () => {
  const previousEnvironment = snapshotEnvironment();
  const previousFetch = globalThis.fetch;
  const ownerUserId = 'authority-owner-user-4';
  const plan = authoritativePlan(ownerUserId, { accountMode: 'mock' });
  const mutationCounts: MutationCounts = {};
  const repository = readOnlyRepository(ownerUserId, plan, mutationCounts);
  let providerCalls = 0;

  clearEnvironment();
  process.env.GEMINI_API_KEY = 'route-authority-test-key';
  setAiFeatureAuthorityRepositoryFactoryForTests(() => repository);
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error('provider must not be called');
  };

  try {
    const result = await postRoute(
      '/ai/features/trade-plan/explanation',
      tradeIdentifier(plan.id),
      'regular',
      ownerUserId,
    );
    assert.equal(result.statusCode, 409);
    assert.equal(result.body.error, 'AI_FEATURE_ACCOUNT_MODE_UNSUPPORTED');
    assert.equal(providerCalls, 0);
    assert.deepEqual(mutationCounts, {});
  } finally {
    setAiFeatureAuthorityRepositoryFactoryForTests(null);
    globalThis.fetch = previousFetch;
    restoreEnvironment(previousEnvironment);
  }
});

test('server-authority integration imports only read paths and exposes no order authority', () => {
  const routeSource = readFileSync(
    path.join(process.cwd(), 'api-server/src/routes/ai-chat.ts'),
    'utf8',
  );
  const authoritySource = readFileSync(
    path.join(process.cwd(), 'api-server/src/services/ai-feature-authority.service.ts'),
    'utf8',
  );

  assert.doesNotMatch(routeSource, /trade-automation\.repository|trade-automation\.service|broker|exchangeAdapter/);
  assert.doesNotMatch(routeSource, /createOrder|submitOrder|executeOrder|enqueueOrder|approvePlan|cancelOrder|closePosition/);
  assert.match(authoritySource, /createSupabaseTradingRepository/);
  assert.match(authoritySource, /repository\.getPlan/);
  assert.match(authoritySource, /repository\.getPolicy/);
  assert.match(authoritySource, /repository\.getGlobalEmergencyStop/);
  assert.doesNotMatch(authoritySource, /repository\.(?:savePlan|savePolicy|saveOrder|saveConnection|setGlobalEmergencyStop|appendEvent)/);
  assert.doesNotMatch(authoritySource, /createOrder|submitOrder|executeOrder|enqueueOrder|approvePlan|cancelOrder|closePosition/);
  assert.doesNotMatch(authoritySource, /\/accounts|\/positions|\/orders/);
  assert.doesNotMatch(`${routeSource}\n${authoritySource}`, /AIza[0-9A-Za-z_-]{20,}|sk-[0-9A-Za-z_-]{12,}/);
});
