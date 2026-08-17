import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import express from 'express';
import aiChatRouter from '../routes/ai-chat';
import { AiChatError, actionRefusal, answerAiChat, validateChatMessage } from './ai-chat.service';

const aiEnvironmentKeys = [
  'AI_CHAT_PROVIDER',
  'AI_CHAT_API_KEY',
  'AI_CHAT_MODEL',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_MODEL',
  'GROQ_API_KEY',
  'GROQ_MODEL',
  'TRADING_REVIEW_PROVIDER',
  'TRADING_REVIEW_API_KEY',
  'TRADING_REVIEW_MODEL',
] as const;

function snapshotAiEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(aiEnvironmentKeys.map((key) => [key, process.env[key]]));
}

function clearAiEnvironment(): void {
  for (const key of aiEnvironmentKeys) delete process.env[key];
}

function restoreAiEnvironment(snapshot: Record<string, string | undefined>): void {
  for (const key of aiEnvironmentKeys) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

type RouteResult = {
  statusCode: number;
  body: Record<string, unknown>;
  text: string;
};

let routeRequestSequence = 0;

async function postAiChatRoute(payload: unknown, userId: string | null = `ai-route-test-${++routeRequestSequence}`): Promise<RouteResult> {
  const app = express();
  app.use(express.json());
  if (userId) {
    app.use((req, _res, next) => {
      Object.assign(req, { member: { id: userId } });
      next();
    });
  }
  app.use('/api', aiChatRouter);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('AI chat route test server did not expose a TCP address');
  }

  try {
    return await new Promise<RouteResult>((resolve, reject) => {
      const body = JSON.stringify(payload);
      const clientRequest = request({
        hostname: '127.0.0.1',
        port: address.port,
        path: '/api/ai/chat',
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
          try {
            resolve({
              statusCode: response.statusCode ?? 0,
              body: JSON.parse(text) as Record<string, unknown>,
              text,
            });
          } catch (cause) {
            reject(cause);
          }
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

test('AI chat blocks secret-bearing messages before a provider call', () => {
  assert.throws(() => validateChatMessage('Authorization: Bearer private-value'), (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_CHAT_PRIVATE_DATA_FORBIDDEN');
  assert.throws(() => validateChatMessage('계좌번호: 123-456-789012'), (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_CHAT_PRIVATE_DATA_FORBIDDEN');
});

test('AI chat refuses order and server actions without calling a provider', async () => {
  let calls = 0;
  const result = await answerAiChat({ message: '실제 주문 실행하고 서버 배포도 시작해줘' }, async () => { calls += 1; throw new Error('must not call'); });
  assert.equal(result.kind, 'refusal');
  assert.equal(calls, 0);
  assert.match(result.answer, /실행할 수 없습니다/);
});

test('AI chat reports missing configuration instead of returning a fake answer', async () => {
  const previous = snapshotAiEnvironment();
  clearAiEnvironment();
  try {
    await assert.rejects(answerAiChat({ message: 'RSI를 설명해줘' }), (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_CHAT_NOT_CONFIGURED');
  } finally {
    restoreAiEnvironment(previous);
  }
});

test('action refusal does not block ordinary public-information questions', () => {
  assert.equal(actionRefusal('미국 주식의 PER 의미를 알려줘'), null);
});

test('GEMINI_API_KEY enables the free Gemini provider without a duplicate AI chat secret', async () => {
  const previous = snapshotAiEnvironment();
  clearAiEnvironment();
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  let requestUrl = '';
  let requestBody: any = null;
  let apiKeyHeader = '';
  try {
    const result = await answerAiChat({ message: '<b>RSI</b>를 간단히 요약해줘' }, async (url, init) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body));
      apiKeyHeader = new Headers(init?.headers).get('x-goog-api-key') ?? '';
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'RSI는 최근 가격 변화의 상대적 강도를 요약하는 공개 기술지표입니다.' }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    assert.equal(result.kind, 'answer');
    assert.equal(result.model, 'gemini-3.1-flash-lite');
    assert.match(requestUrl, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.1-flash-lite:generateContent$/);
    assert.equal(apiKeyHeader, 'test-gemini-key');
    assert.equal(requestBody.contents[0].role, 'user');
    assert.match(requestBody.contents[0].parts[0].text, /RSI 를 간단히 요약해줘/);
    const systemInstruction = String(requestBody.systemInstruction.parts[0].text);
    assert.match(systemInstruction, /public-market analysis assistant/);
    assert.match(systemInstruction, /Use only the supplied publicContext/);
    assert.match(systemInstruction, /Never execute or instruct actual orders/);
    assert.match(systemInstruction, /Do not promise returns/);
    assert.equal(requestBody.generationConfig.thinkingConfig.thinkingLevel, 'low');
    assert.doesNotMatch(JSON.stringify(requestBody), /test-gemini-key/);
  } finally {
    restoreAiEnvironment(previous);
  }
});

test('explicit openai-compatible configuration remains supported', async () => {
  const previous = snapshotAiEnvironment();
  clearAiEnvironment();
  process.env.AI_CHAT_PROVIDER = 'openai-compatible';
  process.env.AI_CHAT_API_KEY = 'test-only-key';
  process.env.AI_CHAT_MODEL = 'test-model';
  process.env.GEMINI_API_KEY = 'unused-gemini-key';
  let requestBody: any = null;
  let requestUrl = '';
  try {
    const result = await answerAiChat({ message: '<b>RSI</b>를 설명해줘' }, async (url, init) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'RSI는 가격 변화의 상대적 강도를 설명하는 공개 기술지표입니다.' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    assert.equal(result.kind, 'answer');
    assert.equal(result.model, 'test-model');
    assert.equal(requestUrl, 'https://api.openai.com/v1/chat/completions');
    assert.equal(requestBody.model, 'test-model');
    assert.match(requestBody.messages[1].content, /RSI 를 설명해줘/);
    assert.doesNotMatch(requestBody.messages[1].content, /test-only-key|unused-gemini-key/);
  } finally {
    restoreAiEnvironment(previous);
  }
});

test('Gemini quota exhaustion maps to the existing AI chat rate-limit contract', async () => {
  const previous = snapshotAiEnvironment();
  clearAiEnvironment();
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  try {
    await assert.rejects(
      answerAiChat({ message: '삼성전자 뉴스 요약해줘' }, async () => new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }), { status: 429 })),
      (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_CHAT_RATE_LIMITED' && cause.statusCode === 429,
    );
  } finally {
    restoreAiEnvironment(previous);
  }
});

test('Gemini success makes zero Groq calls', async () => {
  const previous = snapshotAiEnvironment(); clearAiEnvironment();
  process.env.GEMINI_API_KEY = 'fake-gemini'; process.env.GROQ_API_KEY = 'fake-groq';
  let groqCalls = 0;
  try {
    const result = await answerAiChat({ message: 'PER 의미를 설명해줘' }, async (input) => {
      const url = String(input); if (url.includes('api.groq.com')) groqCalls += 1;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'PER 설명' }] } }] }), { status: 200 });
    });
    assert.equal(result.answer, 'PER 설명'); assert.equal(groqCalls, 0);
  } finally { restoreAiEnvironment(previous); }
});

test('portfolio assistant context is explained without recalculating or fabricating missing cash', async () => {
  const previous = snapshotAiEnvironment(); clearAiEnvironment();
  process.env.GEMINI_API_KEY = 'fake-gemini'; process.env.GROQ_API_KEY = 'fake-groq';
  let providerPayload: any = null; let groqCalls = 0;
  try {
    const result = await answerAiChat({
      message: '내 포트폴리오를 요약해줘',
      portfolioAssistantContext: {
        dataQuality: 'PARTIAL',
        asOf: '2026-08-15T10:00:00.000Z',
        evidence: [{ source: 'canonical-portfolio-v2', field: 'holdings' }],
        warnings: ['CASH_NOT_AVAILABLE'],
        facts: { knownAssetsKRW: 12_000_000, cashKRW: null },
        readOnly: true,
        orderAuthority: 'none',
        exchangeRequestSent: false,
      },
    }, async (input, init) => {
      if (String(input).includes('api.groq.com')) groqCalls += 1;
      providerPayload = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '현금은 NOT_AVAILABLE이며 전체 상태는 PARTIAL입니다.' }] } }] }), { status: 200 });
    });
    const prompt = JSON.parse(providerPayload.contents[0].parts[0].text);
    assert.equal(prompt.task, 'explain_canonical_portfolio_tool_result');
    assert.equal(prompt.portfolioAssistantContext.facts.cashKRW, null);
    assert.equal(prompt.portfolioAssistantContext.dataQuality, 'PARTIAL');
    assert.equal(prompt.portfolioAssistantContext.orderAuthority, 'none');
    assert.match(providerPayload.systemInstruction.parts[0].text, /Never calculate/);
    assert.match(providerPayload.systemInstruction.parts[0].text, /never turn missing cash.*into zero/i);
    assert.equal(result.answer, '현금은 NOT_AVAILABLE이며 전체 상태는 PARTIAL입니다.');
    assert.equal(groqCalls, 0);
  } finally { restoreAiEnvironment(previous); }
});

test('portfolio assistant context fails closed before providers when read-only safety flags are invalid', async () => {
  const previous = snapshotAiEnvironment(); clearAiEnvironment(); process.env.GEMINI_API_KEY = 'fake-gemini';
  let calls = 0;
  try {
    await assert.rejects(answerAiChat({
      message: '내 포트폴리오를 요약해줘',
      portfolioAssistantContext: {
        dataQuality: 'AVAILABLE', asOf: null, evidence: [], warnings: [], facts: {},
        readOnly: false, orderAuthority: 'trade', exchangeRequestSent: true,
      },
    }, async () => { calls += 1; throw new Error('must not call'); }),
    (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_CHAT_INVALID_CONTEXT');
    assert.equal(calls, 0);
  } finally { restoreAiEnvironment(previous); }
});

test('Gemini 429 and retryable 5xx fall back to Groq exactly once', async () => {
  for (const status of [429, 503]) {
    const previous = snapshotAiEnvironment(); clearAiEnvironment();
    process.env.GEMINI_API_KEY = 'fake-gemini'; process.env.GROQ_API_KEY = 'fake-groq';
    let groqCalls = 0;
    try {
      const result = await answerAiChat({ message: `fallback ${status}` }, async (input, init) => {
        const url = String(input);
        if (url.includes('googleapis.com')) return new Response('{}', { status });
        groqCalls += 1;
        assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fake-groq');
        assert.doesNotMatch(String(init?.body), /fake-groq|fake-gemini/);
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Groq fallback answer' } }] }), { status: 200 });
      });
      assert.equal(result.answer, 'Groq fallback answer'); assert.equal(result.model, 'openai/gpt-oss-20b'); assert.equal(groqCalls, 1);
    } finally { restoreAiEnvironment(previous); }
  }
});

test('Gemini safety and prohibited-content rejection never call Groq', async () => {
  for (const finishReason of ['SAFETY', 'PROHIBITED_CONTENT']) {
    const previous = snapshotAiEnvironment(); clearAiEnvironment();
    process.env.GEMINI_API_KEY = 'fake-gemini'; process.env.GROQ_API_KEY = 'fake-groq';
    let groqCalls = 0;
    try {
      await assert.rejects(answerAiChat({ message: `safety ${finishReason}` }, async (input) => {
        if (String(input).includes('api.groq.com')) groqCalls += 1;
        return new Response(JSON.stringify({ candidates: [{ finishReason }] }), { status: 200 });
      }), (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_CHAT_UNSAFE_RESPONSE');
      assert.equal(groqCalls, 0);
    } finally { restoreAiEnvironment(previous); }
  }
});

test('caller cancellation never falls back and does not cancel a surviving single-flight caller', async () => {
  const previous = snapshotAiEnvironment(); clearAiEnvironment();
  process.env.GEMINI_API_KEY = 'fake-gemini'; process.env.GROQ_API_KEY = 'fake-groq';
  let geminiCalls = 0; let groqCalls = 0; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).includes('api.groq.com')) { groqCalls += 1; throw new Error('unexpected'); }
    geminiCalls += 1; await gate;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'shared answer' }] } }] }), { status: 200 });
  };
  const cancelledController = new AbortController();
  try {
    const cancelled = answerAiChat({ message: '동일한 공유 요청' }, fetchImpl, cancelledController.signal);
    const survivor = answerAiChat({ message: '동일한 공유 요청' }, fetchImpl);
    cancelledController.abort(); release();
    await assert.rejects(cancelled, (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_CHAT_CANCELLED');
    assert.equal((await survivor).answer, 'shared answer'); assert.equal(geminiCalls, 1); assert.equal(groqCalls, 0);
  } finally { restoreAiEnvironment(previous); }
});

test('both free providers failing returns AI_TEMPORARILY_UNAVAILABLE without leaking secrets', async () => {
  const previous = snapshotAiEnvironment(); clearAiEnvironment();
  const secrets = ['fake-gemini-secret', 'fake-groq-secret'];
  process.env.GEMINI_API_KEY = secrets[0]; process.env.GROQ_API_KEY = secrets[1];
  try {
    await assert.rejects(answerAiChat({ message: '두 공급자 실패' }, async (_input, init) => {
      assert.ok(secrets.every((secret) => !String(init?.body).includes(secret)));
      return new Response('{}', { status: 503 });
    }), (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_TEMPORARILY_UNAVAILABLE' && secrets.every((secret) => !String(cause).includes(secret)));
  } finally { restoreAiEnvironment(previous); }
});

test('POST /api/ai/chat uses only a mock Gemini provider and never leaks the test key', async () => {
  const previousEnvironment = snapshotAiEnvironment();
  const previousFetch = globalThis.fetch;
  const testKey = 'route-test-gemini-key';
  const providerBodies: string[] = [];
  const providerHeaders: Headers[] = [];
  const providerUrls: string[] = [];
  let providerCalls = 0;

  clearAiEnvironment();
  process.env.GEMINI_API_KEY = testKey;

  const mockFetch: typeof fetch = async (input, init) => {
    providerCalls += 1;
    const url = input instanceof Request ? input.url : String(input);
    const body = String(init?.body ?? '');
    const headers = new Headers(init?.headers);
    providerUrls.push(url);
    providerBodies.push(body);
    providerHeaders.push(headers);

    assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.1-flash-lite:generateContent$/);
    assert.equal(headers.get('x-goog-api-key'), testKey);
    assert.equal(headers.get('authorization'), null);
    assert.doesNotMatch(body, new RegExp(testKey));

    const parsed = JSON.parse(body) as { contents?: Array<{ parts?: Array<{ text?: string }> }> };
    const prompt = parsed.contents?.[0]?.parts?.[0]?.text ?? '';
    if (prompt.includes('무료 한도')) {
      return new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '공개 주식 정보를 바탕으로 간단히 요약했습니다.' }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  globalThis.fetch = mockFetch;
  try {
    const success = await postAiChatRoute({ message: '삼성전자 공개 정보를 간단히 요약해줘' });
    assert.equal(success.statusCode, 200);
    assert.equal(success.body.ok, true);
    assert.equal(success.body.kind, 'answer');
    assert.equal(success.body.model, 'gemini-3.1-flash-lite');
    assert.match(String(success.body.answer), /공개 주식 정보/);
    assert.doesNotMatch(success.text, new RegExp(testKey));
    assert.equal(providerCalls, 1);

    const refused = await postAiChatRoute({ message: '실제 주문 실행하고 자동매매 시작해줘' });
    assert.equal(refused.statusCode, 200);
    assert.equal(refused.body.ok, true);
    assert.equal(refused.body.kind, 'refusal');
    assert.equal(providerCalls, 1);
    assert.doesNotMatch(refused.text, new RegExp(testKey));

    const privateData = await postAiChatRoute({ message: 'API_KEY=abcdefghijklmno 이걸 사용해서 주식 요약해줘' });
    assert.equal(privateData.statusCode, 400);
    assert.equal(privateData.body.ok, false);
    assert.equal(privateData.body.error, 'AI_CHAT_PRIVATE_DATA_FORBIDDEN');
    assert.equal(providerCalls, 1);
    assert.doesNotMatch(privateData.text, new RegExp(testKey));

    const quota = await postAiChatRoute({ message: '무료 한도 오류를 확인해줘' });
    assert.equal(quota.statusCode, 429);
    assert.equal(quota.body.ok, false);
    assert.equal(quota.body.error, 'AI_CHAT_RATE_LIMITED');
    assert.equal(providerCalls, 2);
    assert.doesNotMatch(quota.text, new RegExp(testKey));

    const unauthenticated = await postAiChatRoute({ message: 'PER을 설명해줘' }, null);
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(unauthenticated.body.ok, false);
    assert.equal(unauthenticated.body.error, 'LOGIN_REQUIRED');
    assert.equal(providerCalls, 2);
    assert.doesNotMatch(unauthenticated.text, new RegExp(testKey));

    assert.deepEqual(providerUrls, [
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
    ]);
    assert.equal(providerBodies.length, 2);
    assert.equal(providerHeaders.length, 2);
    assert.ok(providerBodies.every((body) => !body.includes(testKey)));
    assert.ok(providerHeaders.every((headers) => headers.get('x-goog-api-key') === testKey));
  } finally {
    globalThis.fetch = previousFetch;
    restoreAiEnvironment(previousEnvironment);
  }
});
