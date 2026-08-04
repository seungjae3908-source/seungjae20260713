import test from 'node:test';
import assert from 'node:assert/strict';
import { AiChatError, actionRefusal, answerAiChat, validateChatMessage } from './ai-chat.service';

const aiEnvironmentKeys = [
  'AI_CHAT_PROVIDER',
  'AI_CHAT_API_KEY',
  'AI_CHAT_MODEL',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_MODEL',
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
    assert.match(requestBody.systemInstruction.parts[0].text, /public-information assistant/);
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
