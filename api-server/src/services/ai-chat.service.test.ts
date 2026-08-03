import test from 'node:test';
import assert from 'node:assert/strict';
import { AiChatError, actionRefusal, answerAiChat, validateChatMessage } from './ai-chat.service';

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
  const previous = { provider: process.env.AI_CHAT_PROVIDER, key: process.env.AI_CHAT_API_KEY, model: process.env.AI_CHAT_MODEL, reviewProvider: process.env.TRADING_REVIEW_PROVIDER, reviewKey: process.env.TRADING_REVIEW_API_KEY, reviewModel: process.env.TRADING_REVIEW_MODEL };
  delete process.env.AI_CHAT_PROVIDER; delete process.env.AI_CHAT_API_KEY; delete process.env.AI_CHAT_MODEL;
  delete process.env.TRADING_REVIEW_PROVIDER; delete process.env.TRADING_REVIEW_API_KEY; delete process.env.TRADING_REVIEW_MODEL;
  try {
    await assert.rejects(answerAiChat({ message: 'RSI를 설명해줘' }), (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_CHAT_NOT_CONFIGURED');
  } finally {
    Object.entries({ AI_CHAT_PROVIDER: previous.provider, AI_CHAT_API_KEY: previous.key, AI_CHAT_MODEL: previous.model, TRADING_REVIEW_PROVIDER: previous.reviewProvider, TRADING_REVIEW_API_KEY: previous.reviewKey, TRADING_REVIEW_MODEL: previous.reviewModel }).forEach(([key, value]) => value === undefined ? delete process.env[key] : process.env[key] = value);
  }
});

test('action refusal does not block ordinary public-information questions', () => {
  assert.equal(actionRefusal('미국 주식의 PER 의미를 알려줘'), null);
});

test('configured AI chat sends only the normalized public question contract', async () => {
  const previous = { provider: process.env.AI_CHAT_PROVIDER, key: process.env.AI_CHAT_API_KEY, model: process.env.AI_CHAT_MODEL };
  process.env.AI_CHAT_PROVIDER = 'openai-compatible'; process.env.AI_CHAT_API_KEY = 'test-only-key'; process.env.AI_CHAT_MODEL = 'test-model';
  let requestBody: any = null;
  try {
    const result = await answerAiChat({ message: '<b>RSI</b>를 설명해줘' }, async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'RSI는 가격 변화의 상대적 강도를 설명하는 공개 기술지표입니다.' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    assert.equal(result.kind, 'answer');
    assert.equal(requestBody.model, 'test-model');
    assert.match(requestBody.messages[1].content, /RSI 를 설명해줘/);
    assert.doesNotMatch(requestBody.messages[1].content, /test-only-key/);
  } finally {
    Object.entries({ AI_CHAT_PROVIDER: previous.provider, AI_CHAT_API_KEY: previous.key, AI_CHAT_MODEL: previous.model }).forEach(([key, value]) => value === undefined ? delete process.env[key] : process.env[key] = value);
  }
});
