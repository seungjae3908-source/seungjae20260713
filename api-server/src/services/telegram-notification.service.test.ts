import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearTelegramAlertState,
  escapeTelegramHtml,
  renderTelegramAlert,
  sendTelegramAlert,
  type TelegramAlertInput,
  type TelegramAlertResult,
} from './telegram-notification.service';
import {
  dedupeTelegramIntelligencePlans,
  dueTelegramIntelligenceReports,
  telegramPersonalRelevancePriority,
  telegramReportDestinations,
} from './telegram-intelligence-report.service';
import {
  MemoryTelegramIntelligenceStateStore,
  TelegramIntelligenceWorker,
} from './telegram-intelligence-worker.service';
import {
  deliverScannerTelegramAlerts,
  scannerTelegramInput,
} from './scanner-telegram-delivery.service';
import type { ScannerAlertCandidate } from './scanner-signal.types';

const originalFetch = globalThis.fetch;
const originalEnv = {
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  personalChatId: process.env.TELEGRAM_PERSONAL_CHAT_ID,
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

function scannerAlert(
  overrides: Partial<ScannerAlertCandidate> = {},
): ScannerAlertCandidate {
  return {
    idempotencyKey: 'scanner-alert:test',
    signalId: 'signal:test',
    assetClass: 'stock',
    market: 'KR',
    symbol: '005930',
    direction: 'LONG',
    state: 'APPROVAL_PENDING',
    entryZone: { from: 80000, to: 81000 },
    stopLoss: 78000,
    targets: [83000, 85000],
    expiresAt: '2026-08-10T14:00:00Z',
    evidence: ['trend'],
    orderSubmitted: false,
    exchangeRequestSent: false,
    ...overrides,
  };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  clearTelegramAlertState();
  if (originalEnv.botToken == null) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalEnv.botToken;
  if (originalEnv.chatId == null) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalEnv.chatId;
  if (originalEnv.personalChatId == null) delete process.env.TELEGRAM_PERSONAL_CHAT_ID;
  else process.env.TELEGRAM_PERSONAL_CHAT_ID = originalEnv.personalChatId;
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
    'intelligence_report',
  ] as const) {
    const rendered = renderTelegramAlert({ type, symbol: 'TEST' });
    assert.ok(rendered.length > 0);
  }
});

test('maps only existing actionable scanner producers to Telegram delivery types', () => {
  assert.equal(scannerTelegramInput(scannerAlert())?.type, 'strong_buy');
  assert.equal(
    scannerTelegramInput(scannerAlert({
      assetClass: 'coin_futures',
      market: 'futures',
      symbol: 'BTCUSDT',
      direction: 'LONG',
    }))?.type,
    'crypto_futures_long',
  );
  assert.equal(
    scannerTelegramInput(scannerAlert({
      assetClass: 'coin_futures',
      market: 'futures',
      symbol: 'BTCUSDT',
      direction: 'SHORT',
    }))?.type,
    'crypto_futures_short',
  );
  assert.equal(scannerTelegramInput(scannerAlert({ direction: 'SHORT' })), null);
  assert.equal(scannerTelegramInput(scannerAlert({ assetClass: 'coin_spot' })), null);
});

test('scanner Telegram delivery is fail-open and uses the lifecycle idempotency key', async () => {
  const delivered: TelegramAlertInput[] = [];
  await deliverScannerTelegramAlerts(
    [scannerAlert()],
    async (input) => {
      delivered.push(input);
      throw new Error('telegram unavailable');
    },
  );
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].dedupeKey, 'scanner-alert:test');
  assert.equal(delivered[0].type, 'strong_buy');
});

test('Telegram intelligence audience follows membership and portfolio priority', () => {
  assert.deepEqual(telegramReportDestinations({ membership: 'pending' }), []);
  assert.deepEqual(
    telegramReportDestinations({ membership: 'associate' }),
    ['STOCK_ROOM'],
  );
  assert.deepEqual(
    telegramReportDestinations({ membership: 'regular', portfolioRelevant: true, watchlistRelevant: true }),
    ['STOCK_ROOM', 'CRYPTO_ROOM', 'PERSONAL'],
  );
  assert.equal(telegramPersonalRelevancePriority({ portfolioRelevant: true, watchlistRelevant: true }), 'HIGH');
  assert.equal(telegramPersonalRelevancePriority({ portfolioRelevant: false, watchlistRelevant: true }), 'NORMAL');
});

test('Telegram intelligence schedules morning and weekly reports around Monday 08:00 KST', () => {
  const due = dueTelegramIntelligenceReports(
    new Date('2026-08-16T23:00:00.000Z'),
    { membership: 'regular' },
  );
  assert.deepEqual(due.map((item) => item.kind), ['MORNING', 'WEEKLY']);
  for (const plan of due) {
    assert.equal(plan.scheduledTimezone, 'Asia/Seoul');
    assert.equal(plan.localDate, '2026-08-17');
    assert.equal(plan.orderSubmitted, false);
    assert.equal(plan.privateTradingApiCount, 0);
    assert.equal(plan.liveTradingAuthority, false);
  }
});

test('Telegram intelligence schedules KR closing only inside the 15:50-16:10 KST window', () => {
  const inside = dueTelegramIntelligenceReports(
    new Date('2026-08-14T07:00:00.000Z'),
    { membership: 'associate', includeCrypto: false },
  );
  assert.deepEqual(inside.map((item) => item.kind), ['KR_CLOSING']);
  assert.deepEqual(inside[0].destinations, ['STOCK_ROOM']);

  const outside = dueTelegramIntelligenceReports(
    new Date('2026-08-14T07:11:00.000Z'),
    { membership: 'associate' },
  );
  assert.equal(outside.some((item) => item.kind === 'KR_CLOSING'), false);
});

test('US premarket report follows New York wall clock across EST and EDT', () => {
  const winter = dueTelegramIntelligenceReports(
    new Date('2026-01-15T13:00:00.000Z'),
    { membership: 'regular' },
  ).find((item) => item.kind === 'US_PREMARKET');
  const summer = dueTelegramIntelligenceReports(
    new Date('2026-07-15T12:00:00.000Z'),
    { membership: 'regular' },
  ).find((item) => item.kind === 'US_PREMARKET');

  assert.ok(winter);
  assert.ok(summer);
  assert.equal(winter.scheduledTimezone, 'America/New_York');
  assert.equal(summer.scheduledTimezone, 'America/New_York');
  assert.equal(winter.localMinuteOfDay, 8 * 60);
  assert.equal(summer.localMinuteOfDay, 8 * 60);
});

test('Telegram intelligence daily dedupe suppresses an already delivered report key', () => {
  const plans = dueTelegramIntelligenceReports(
    new Date('2026-08-14T07:00:00.000Z'),
    { membership: 'regular', portfolioRelevant: true },
  );
  assert.equal(plans.length, 1);
  const deduped = dedupeTelegramIntelligencePlans(plans, new Set([plans[0].dedupeKey]));
  assert.deepEqual(deduped, []);
});

test('Telegram intelligence worker sends a due KR close report exactly once', async () => {
  delete process.env.TELEGRAM_PERSONAL_CHAT_ID;
  const store = new MemoryTelegramIntelligenceStateStore();
  const delivered: TelegramAlertInput[] = [];
  const deliver = async (input: TelegramAlertInput): Promise<TelegramAlertResult> => {
    delivered.push(input);
    return { ok: true, attempts: 1 };
  };
  const worker = new TelegramIntelligenceWorker(store, deliver, (destination) => (
    destination === 'STOCK_ROOM'
      ? 'stock-room'
      : destination === 'CRYPTO_ROOM'
        ? 'crypto-room'
        : null
  ));
  const now = new Date('2026-08-14T07:00:00.000Z');

  const first = await worker.runOnce(now);
  assert.equal(first.duePlans, 1);
  assert.equal(first.attempted, 2);
  assert.equal(first.delivered, 2);
  assert.equal(first.orderSubmitted, false);
  assert.equal(first.privateTradingApiCount, 0);
  assert.equal(first.liveTradingAuthority, false);
  assert.deepEqual(
    delivered.map((item) => item.type),
    ['intelligence_report', 'intelligence_report'],
  );
  assert.equal(
    delivered.every((item) => item.details?.includes('한국장 마감 브리핑')),
    true,
  );

  const second = await worker.runOnce(now);
  assert.equal(second.attempted, 0);
  assert.equal(second.delivered, 0);
  assert.equal(second.deduped, 2);
  assert.equal(delivered.length, 2);
});

test('Telegram intelligence worker collapses destinations sharing one chat', async () => {
  delete process.env.TELEGRAM_PERSONAL_CHAT_ID;
  const store = new MemoryTelegramIntelligenceStateStore();
  let calls = 0;
  const worker = new TelegramIntelligenceWorker(
    store,
    async () => {
      calls += 1;
      return { ok: true, attempts: 1 };
    },
    () => 'owner-room',
  );

  const result = await worker.runOnce(new Date('2026-08-14T07:00:00.000Z'));
  assert.equal(result.duePlans, 1);
  assert.equal(result.attempted, 1);
  assert.equal(result.delivered, 1);
  assert.equal(calls, 1);
});
