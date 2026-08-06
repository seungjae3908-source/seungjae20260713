import test from 'node:test';
import assert from 'node:assert/strict';
import { AiChatError, answerAiChat } from './ai-chat.service';

const environmentKeys = [
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

function geminiResponse(text: string): Response {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text }] } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function waitingFetch(): typeof fetch {
  return async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      reject(new Error('expected abort signal'));
      return;
    }
    const abort = () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

test('AI chat never reuses trading-review credentials as an automatic paid fallback', async () => {
  const previous = snapshotEnvironment();
  clearEnvironment();
  process.env.TRADING_REVIEW_PROVIDER = 'openai-compatible';
  process.env.TRADING_REVIEW_API_KEY = 'trading-review-only-key';
  process.env.TRADING_REVIEW_MODEL = 'paid-review-model';
  let calls = 0;
  try {
    await assert.rejects(
      answerAiChat({ message: 'PER의 의미를 설명해줘' }, async () => {
        calls += 1;
        throw new Error('provider must not be called');
      }),
      (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_CHAT_NOT_CONFIGURED',
    );
    assert.equal(calls, 0);
  } finally {
    restoreEnvironment(previous);
  }
});

test('AI chat rejects a symbol that does not match the selected market before outbound work', async () => {
  let calls = 0;
  await assert.rejects(
    answerAiChat({
      message: '이 종목을 설명해줘',
      context: { market: 'KR', symbol: 'AAPL', displayName: '잘못된 선택' },
    }, async () => {
      calls += 1;
      throw new Error('provider must not be called');
    }),
    (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_CHAT_INVALID_CONTEXT',
  );
  assert.equal(calls, 0);
});

test('AI chat reports missing current data without inventing a real-time answer', async () => {
  let calls = 0;
  const result = await answerAiChat({ message: '오늘 현재가와 최근 뉴스를 알려줘' }, async () => {
    calls += 1;
    throw new Error('provider must not be called');
  });
  assert.equal(calls, 0);
  assert.equal(result.model, null);
  assert.equal(result.data.status, 'unavailable');
  assert.match(result.answer, /종목.*선택/);
});

test('AI chat returns explicit data disclosure for general educational answers', async () => {
  const previous = snapshotEnvironment();
  clearEnvironment();
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  try {
    const result = await answerAiChat(
      { message: 'PER의 의미를 설명해줘' },
      async () => geminiResponse('PER은 주가를 주당순이익으로 나눈 공개 재무지표입니다.'),
    );
    assert.equal(result.data.status, 'not_requested');
    assert.equal(result.data.asOf, null);
    assert.deepEqual(result.data.sources, []);
    assert.deepEqual(result.data.missing, []);
  } finally {
    restoreEnvironment(previous);
  }
});

test('AI chat maps malformed provider JSON to the response-format contract', async () => {
  const previous = snapshotEnvironment();
  clearEnvironment();
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  try {
    await assert.rejects(
      answerAiChat(
        { message: 'PER의 의미를 설명해줘' },
        async () => new Response('{not-json', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
      (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_CHAT_INVALID_RESPONSE' && cause.statusCode === 502,
    );
  } finally {
    restoreEnvironment(previous);
  }
});

test('AI chat maps a structurally empty model response to the response-format contract', async () => {
  const previous = snapshotEnvironment();
  clearEnvironment();
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  try {
    await assert.rejects(
      answerAiChat(
        { message: 'PER의 의미를 설명해줘' },
        async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{}] } }] }), { status: 200 }),
      ),
      (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_CHAT_INVALID_RESPONSE',
    );
  } finally {
    restoreEnvironment(previous);
  }
});

test('AI chat blocks direct trading instructions returned by the model', async () => {
  const previous = snapshotEnvironment();
  clearEnvironment();
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  try {
    await assert.rejects(
      answerAiChat(
        { message: '일반적인 투자 위험을 설명해줘' },
        async () => geminiResponse('지금 전액 매수하세요. 수익이 날 것입니다.'),
      ),
      (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_CHAT_UNSAFE_RESPONSE',
    );
  } finally {
    restoreEnvironment(previous);
  }
});

test('AI chat distinguishes the server timeout from user cancellation', async () => {
  const previous = snapshotEnvironment();
  clearEnvironment();
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  try {
    await assert.rejects(
      answerAiChat({ message: 'PER을 설명해줘' }, waitingFetch(), undefined, 5),
      (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_CHAT_TIMEOUT' && cause.statusCode === 504,
    );

    const external = new AbortController();
    const request = answerAiChat({ message: 'PBR을 설명해줘' }, waitingFetch(), external.signal, 1_000);
    setTimeout(() => external.abort(), 5);
    await assert.rejects(
      request,
      (cause: unknown) => cause instanceof AiChatError && cause.code === 'AI_CHAT_CANCELLED' && cause.statusCode === 499,
    );
  } finally {
    restoreEnvironment(previous);
  }
});
