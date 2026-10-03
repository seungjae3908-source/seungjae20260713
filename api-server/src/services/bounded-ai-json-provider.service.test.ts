import test from 'node:test';
import assert from 'node:assert/strict';
import { AiChatError } from './ai-chat.service';
import { answerBoundedAiJson } from './bounded-ai-json-provider.service';

const geminiEnv: NodeJS.ProcessEnv = {
  AI_CHAT_PROVIDER: 'gemini',
  AI_CHAT_API_KEY: 'test-gemini-key',
  AI_CHAT_MODEL: 'gemini-test-model',
};

test('bounded JSON provider uses classifier-only Gemini system instructions without exposing secrets', async () => {
  let body: any = null;
  let keyHeader = '';
  const result = await answerBoundedAiJson(
    { message: '{"task":"classify","evidence":"public"}' },
    async (_url, init) => {
      body = JSON.parse(String(init?.body));
      keyHeader = new Headers(init?.headers).get('x-goog-api-key') ?? '';
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"decision":"PASS","reasons":["coherent"]}' }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    undefined,
    5_000,
    geminiEnv,
  );
  assert.equal(result.provider, 'google-gemini');
  assert.equal(result.model, 'gemini-test-model');
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.answer, '{"decision":"PASS","reasons":["coherent"]}');
  assert.equal(keyHeader, 'test-gemini-key');
  const system = String(body.systemInstruction.parts[0].text);
  assert.match(system, /bounded public-evidence classifier/);
  assert.match(system, /Return only the exact JSON shape/);
  assert.match(system, /Never override deterministic risk/);
  assert.doesNotMatch(JSON.stringify(body), /test-gemini-key/);
});

test('bounded JSON provider falls back from retryable Gemini failure to Groq once', async () => {
  const env: NodeJS.ProcessEnv = {
    GEMINI_API_KEY: 'gemini-key',
    GROQ_API_KEY: 'groq-key',
  };
  let groqCalls = 0;
  let groqBody: any = null;
  const result = await answerBoundedAiJson(
    { message: '{"task":"classify"}' },
    async (input, init) => {
      if (String(input).includes('googleapis.com')) return new Response('{}', { status: 503 });
      groqCalls += 1;
      groqBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"status":"PASS","counterEvidence":[],"missingData":[],"risks":[],"explanation":"ok"}' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    undefined,
    5_000,
    env,
  );
  assert.equal(groqCalls, 1);
  assert.equal(result.provider, 'groq');
  assert.equal(result.fallbackUsed, true);
  assert.match(String(groqBody.messages[0].content), /bounded public-evidence classifier/);
  assert.doesNotMatch(String(groqBody), /gemini-key|groq-key/);
});

test('bounded JSON provider fails closed on missing configuration and secret-bearing prompt', async () => {
  await assert.rejects(
    answerBoundedAiJson({ message: '{"task":"classify"}' }, fetch, undefined, 100, {}),
    (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_CHAT_NOT_CONFIGURED',
  );
  await assert.rejects(
    answerBoundedAiJson({ message: 'api_key=1234567890abcdef' }, fetch, undefined, 100, geminiEnv),
    (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_CHAT_PRIVATE_DATA_FORBIDDEN',
  );
});

test('bounded JSON provider never falls back after a non-retryable sensitive response', async () => {
  const env: NodeJS.ProcessEnv = {
    GEMINI_API_KEY: 'gemini-key',
    GROQ_API_KEY: 'groq-key',
  };
  let groqCalls = 0;
  await assert.rejects(
    answerBoundedAiJson(
      { message: '{"task":"classify"}' },
      async (input) => {
        if (String(input).includes('api.groq.com')) {
          groqCalls += 1;
          return new Response('{}', { status: 200 });
        }
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'authorization: Bearer stolen-value' }] } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      undefined,
      5_000,
      env,
    ),
    (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_CHAT_UNSAFE_RESPONSE',
  );
  assert.equal(groqCalls, 0);
});
