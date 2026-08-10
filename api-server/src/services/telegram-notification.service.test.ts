import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearTelegramAlertState,
  escapeTelegramHtml,
  renderTelegramAlert,
  sendTelegramAlert,
} from './telegram-notification.service';

const originalFetch = globalThis.fetch;
const originalEnv = {
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
};

function setFakeConfig(): void {
  process.env.TELEGRAM_BOT_TOKEN = 'ci-bot-token-sentinel';
  process.env.TELEGRAM_CHAT_ID = 'ci-chat-id-sentinel';
}

function okResponse(): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  clearTelegramAlertState();
  if (originalEnv.botToken == null) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalEnv.botToken;
  if (originalEnv.chatId == null) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalEnv.chatId;
});

test('escapes Telegram HTML and renders alert-only templates', () => {
  assert.equal(
    escapeTelegramHtml('<script>&"\''),
    '&lt;script&gt;&amp;&quot;&#39;',
  );
  const rendered = renderTelegramAlert({
    type: 'strong_buy',
    symbol: '<005930>',
    market: 'KR&NXT',
    details: 'signal <verified>',
  });
  assert.match(rendered, /강한매수 신호/);
  assert.match(rendered, /&lt;005930&gt;/);
  assert.match(rendered, /KR&amp;NXT/);
  assert.match(rendered, /실주문 실행 기능은 포함되지 않습니다/);
  assert.equal(rendered.includes('<005930>'), false);
});

test('sends a Telegram message with no execution buttons', async () => {
  setFakeConfig();
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    const url = String(input);
    assert.match(url, /^https:\/\/api\.telegram\.org\/bot/);
    assert.equal(url.includes('ci-chat-id-sentinel'), false);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.chat_id, 'ci-chat-id-sentinel');
    assert.equal(body.parse_mode, 'HTML');
    assert.equal(Object.hasOwn(body, 'reply_markup'), false);
    assert.equal(String(body.text).includes('강한매도 신호'), true);
    return okResponse();
  };

  const result = await sendTelegramAlert({
    type: 'strong_sell',
    symbol: 'AAPL',
    market: 'US',
    currentPrice: 225.5,
    timestamp: '2026-08-10T10:00:00Z',
  });
  assert.deepEqual(result, { ok: true, attempts: 1 });
  assert.equal(calls, 1);
});

test('suppresses exact duplicates and applies per-subject cooldown', async () => {
  setFakeConfig();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return okResponse();
  };

  const base = {
    type: 'price_alert' as const,
    symbol: '005930',
    market: 'KR',
    currentPrice: 81000,
    targetPrice: 80000,
  };
  assert.deepEqual(await sendTelegramAlert(base), { ok: true, attempts: 1 });
  assert.deepEqual(await sendTelegramAlert(base), {
    ok: false,
    attempts: 0,
    skipped: 'DUPLICATE',
  });
  assert.deepEqual(await sendTelegramAlert({ ...base, details: 'different payload' }), {
    ok: false,
    attempts: 0,
    skipped: 'COOLDOWN',
  });
  assert.equal(calls, 1);
});

test('Telegram outage fails open after a bounded retry and does not expose secrets', async () => {
  setFakeConfig();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('network unavailable');
  };

  const result = await sendTelegramAlert({
    type: 'provider_outage',
    provider: 'toss',
    details: 'read timeout',
    cooldownMs: 0,
  });
  assert.deepEqual(result, {
    ok: false,
    attempts: 2,
    skipped: 'DELIVERY_FAILED',
  });
  assert.equal(calls, 2);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('ci-bot-token-sentinel'), false);
  assert.equal(serialized.includes('ci-chat-id-sentinel'), false);
});

test('supports all requested alert templates', () => {
  for (const type of [
    'strong_buy',
    'strong_sell',
    'crypto_futures_long',
    'crypto_futures_short',
    'price_alert',
    'provider_outage',
    'system_critical',
  ] as const) {
    const rendered = renderTelegramAlert({ type, symbol: 'TEST' });
    assert.ok(rendered.length > 0);
  }
});
