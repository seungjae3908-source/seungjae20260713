import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  clearTelegramAlertState,
  editTelegramMessage,
  escapeTelegramHtml,
  renderTelegramAlert,
  sendTelegramAlert,
  sendTelegramAlertWithReceipt,
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
  FileTelegramIntelligenceStateStore,
  MemoryTelegramIntelligenceStateStore,
  TelegramIntelligenceWorker,
  readTelegramIntelligenceWorkerHealth,
  safeTelegramBriefFailureCode,
} from './telegram-intelligence-worker.service';
import {
  buildSignalIntelligenceTelegramInput,
  SignalIntelligenceTelegramDeliveryState,
} from './signal-intelligence-telegram-subscriber.service';
import {
  addTelegramSignalFreshness,
  deliverScannerTelegramAlerts,
  scannerInAppNotificationInput,
  scannerTelegramInput,
  scannerTelegramRoomChatId,
  scannerTelegramRoomFor,
  type ScannerTelegramRoom,
} from './scanner-telegram-delivery.service';
import type { ScannerAlertCandidate } from './scanner-signal.types';
import { deliverMemberWatchlistTelegramForSignal } from './member-watchlist-telegram-producer.service';
import { TELEGRAM_POLICY_SAFETY } from './telegram-alert-policy.service';
import './signal-intelligence-telegram-subscriber.service.test';

const originalFetch = globalThis.fetch;
const originalEnv = {
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  stockChatId: process.env.TELEGRAM_STOCK_CHAT_ID,
  cryptoChatId: process.env.TELEGRAM_CRYPTO_CHAT_ID,
  krStockChatId: process.env.TELEGRAM_KR_STOCK_CHAT_ID,
  usStockChatId: process.env.TELEGRAM_US_STOCK_CHAT_ID,
  cryptoSpotChatId: process.env.TELEGRAM_CRYPTO_SPOT_CHAT_ID,
  cryptoFuturesChatId: process.env.TELEGRAM_CRYPTO_FUTURES_CHAT_ID,
  personalChatId: process.env.TELEGRAM_PERSONAL_CHAT_ID,
};

function setFakeConfig(): void {
  process.env.TELEGRAM_BOT_TOKEN = 'ci-bot-token-sentinel';
  process.env.TELEGRAM_CHAT_ID = 'ci-chat-id-sentinel';
}

function testRoom(room: ScannerTelegramRoom): string {
  switch (room) {
    case 'KR_STOCK_ROOM': return 'kr-stock-room';
    case 'US_STOCK_ROOM': return 'us-stock-room';
    case 'CRYPTO_SPOT_ROOM': return 'crypto-spot-room';
    case 'CRYPTO_FUTURES_ROOM': return 'crypto-futures-room';
  }
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
  if (originalEnv.stockChatId == null) delete process.env.TELEGRAM_STOCK_CHAT_ID;
  else process.env.TELEGRAM_STOCK_CHAT_ID = originalEnv.stockChatId;
  if (originalEnv.cryptoChatId == null) delete process.env.TELEGRAM_CRYPTO_CHAT_ID;
  else process.env.TELEGRAM_CRYPTO_CHAT_ID = originalEnv.cryptoChatId;
  if (originalEnv.krStockChatId == null) delete process.env.TELEGRAM_KR_STOCK_CHAT_ID;
  else process.env.TELEGRAM_KR_STOCK_CHAT_ID = originalEnv.krStockChatId;
  if (originalEnv.usStockChatId == null) delete process.env.TELEGRAM_US_STOCK_CHAT_ID;
  else process.env.TELEGRAM_US_STOCK_CHAT_ID = originalEnv.usStockChatId;
  if (originalEnv.cryptoSpotChatId == null) delete process.env.TELEGRAM_CRYPTO_SPOT_CHAT_ID;
  else process.env.TELEGRAM_CRYPTO_SPOT_CHAT_ID = originalEnv.cryptoSpotChatId;
  if (originalEnv.cryptoFuturesChatId == null) delete process.env.TELEGRAM_CRYPTO_FUTURES_CHAT_ID;
  else process.env.TELEGRAM_CRYPTO_FUTURES_CHAT_ID = originalEnv.cryptoFuturesChatId;
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
  assert.match(rendered, /매수 신호/);
  assert.match(rendered, /&lt;005930&gt;/);
  assert.match(rendered, /KR&amp;NXT/);
  assert.doesNotMatch(rendered, /실주문 실행 기능은 포함되지 않습니다/);
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

test('tracked Telegram delivery captures message id and lifecycle updates edit the same message', async () => {
  setFakeConfig();
  const endpoints: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    endpoints.push(url);
    if (url.endsWith('/sendMessage')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    assert.match(url, /\/editMessageText$/);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.chat_id, 'ci-chat-id-sentinel');
    assert.equal(body.message_id, 77);
    assert.match(String(body.text), /TP1 도달/);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const tracked = await sendTelegramAlertWithReceipt({
    type: 'strong_buy',
    symbol: '005930',
    market: 'KR',
    details: '진입가능',
    cooldownMs: 0,
    duplicateWindowMs: 0,
  });
  assert.equal(tracked.ok, true);
  if (!tracked.ok) return;
  assert.deepEqual(tracked.receipt, {
    messageId: 77,
    messageKind: 'TEXT',
    renderedText: tracked.receipt.renderedText,
  });
  assert.match(tracked.receipt.renderedText, /매수 신호/);

  assert.deepEqual(await editTelegramMessage({
    destinationChatId: 'ci-chat-id-sentinel',
    messageId: tracked.receipt.messageId!,
    messageKind: tracked.receipt.messageKind,
    text: tracked.receipt.renderedText + '\nTP1 도달',
  }), { ok: true, attempts: 1 });
  assert.equal(endpoints.length, 2);
});

test('editing a Telegram signal explicitly clears a stale order keyboard', async () => {
  setFakeConfig();
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return okResponse();
  };
  const result = await editTelegramMessage({
    destinationChatId: 'ci-chat-id-sentinel',
    messageId: 77,
    messageKind: 'TEXT',
    text: '기존 신호 무효',
    buttons: [],
  });
  assert.deepEqual(result, { ok: true, attempts: 1 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].reply_markup, { inline_keyboard: [] });
});

test('ambiguous Telegram edit never replays an obsolete order keyboard', async () => {
  setFakeConfig();
  const input = {
    destinationChatId: 'ci-chat-id-sentinel',
    messageId: 77, messageKind: 'TEXT' as const, text: '이전 주문 버튼 상태',
    buttons: [[{ text: '오래된 주문 링크', url: 'https://example.org/old-order' }]],
  };
  const uncertain = { ok: false, attempts: 1, skipped: 'OUTCOME_UNCONFIRMED',
    errorCode: 'TELEGRAM_SEND_OUTCOME_UNCONFIRMED' };
  for (const behavior of ['http_502', 'network_error', 'malformed_200'] as const) {
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      assert.match(String(init?.body), /old-order/u);
      if (behavior === 'http_502') return new Response('upstream failed', { status: 502 });
      if (behavior === 'network_error') throw new Error('connection reset after remote edit');
      return new Response('{not json', { status: 200 });
    };
    assert.deepEqual(await editTelegramMessage(input), uncertain);
    assert.equal(calls, 1, `ambiguous ${behavior} must never replay the old button`);
  }
});

test('Telegram edit retries an explicit HTTP 429 once but no other rejected request', async () => {
  setFakeConfig();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? new Response('retry later', { status: 429, headers: { 'retry-after': '0' } })
      : okResponse();
  };
  assert.deepEqual(await editTelegramMessage({
    destinationChatId: 'ci-chat-id-sentinel',
    messageId: 77, messageKind: 'TEXT', text: '안전한 재시도',
  }), { ok: true, attempts: 2 });
  assert.equal(calls, 2);
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
  };
  assert.deepEqual(await editTelegramMessage({
    destinationChatId: 'ci-chat-id-sentinel',
    messageId: 77, messageKind: 'TEXT', text: '과도한 요청',
  }), { ok: false, attempts: 2, skipped: 'DELIVERY_FAILED' });
  assert.equal(calls, 2);
});

test('long signal updates preserve Telegram HTML tags, entities, and stale-button revocation', async () => {
  setFakeConfig();
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return okResponse();
  };

  const cases: Array<{ kind: 'PHOTO' | 'TEXT'; limit: number; prefix: number }> = [
    { kind: 'PHOTO', limit: 1_024, prefix: 1_005 },
    { kind: 'TEXT', limit: 4_096, prefix: 4_080 },
  ];
  for (const [index, item] of cases.entries()) {
    const text = '<b>' + '가'.repeat(item.prefix) + '&amp;' + '나'.repeat(80) + '</b>';
    const answer = await editTelegramMessage({
      destinationChatId: 'ci-chat-id-sentinel',
      messageId: 201 + index,
      messageKind: item.kind,
      text,
      buttons: [],
    });
    assert.deepEqual(answer, { ok: true, attempts: 1 });
    const body = calls.at(-1)!;
    const rendered = String(item.kind === 'PHOTO' ? body.caption : body.text);
    assert.ok(rendered.length <= item.limit);
    assert.match(rendered, /^<b>.+…<\/b>$/u);
    assert.equal(rendered.includes('&am…'), false);
    assert.equal((rendered.match(/<b>/gu) ?? []).length, (rendered.match(/<\/b>/gu) ?? []).length);
    assert.deepEqual(body.reply_markup, { inline_keyboard: [] });
    assert.equal(body.parse_mode, 'HTML');
  }
  assert.equal(calls.length, 2);
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

test('Telegram transport failure is unconfirmed and cannot retry an ambiguously accepted POST', async () => {
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
    attempts: 1,
    skipped: 'OUTCOME_UNCONFIRMED',
    errorCode: 'TELEGRAM_SEND_OUTCOME_UNCONFIRMED',
  });
  assert.equal(calls, 1);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('ci-bot-token-sentinel'), false);
  assert.equal(serialized.includes('ci-chat-id-sentinel'), false);
});


test('Telegram 429 rejection may be retried once but 500 and invalid acknowledgments cannot', async () => {
  setFakeConfig();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? new Response(JSON.stringify({ ok: false }), { status: 429 })
      : okResponse();
  };
  const accepted = await sendTelegramAlert({ type: 'system_critical', details: 'safe retry only' });
  assert.deepEqual(accepted, { ok: true, attempts: 2 });
  assert.equal(calls, 2);

  clearTelegramAlertState();
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('upstream could have accepted POST', { status: 502 });
  };
  const uncertain = await sendTelegramAlert({ type: 'system_critical', details: 'ambiguous server response' });
  assert.deepEqual(uncertain, {
    ok: false, attempts: 1, skipped: 'OUTCOME_UNCONFIRMED',
    errorCode: 'TELEGRAM_SEND_OUTCOME_UNCONFIRMED',
  });
  assert.equal(calls, 1, 'never retry 5xx when Telegram might already have the message');
  const repeated = await sendTelegramAlert({ type: 'system_critical', details: 'ambiguous server response' });
  assert.deepEqual(repeated, { ok: false, attempts: 0, skipped: 'OUTCOME_UNCONFIRMED',
    errorCode: 'TELEGRAM_SEND_OUTCOME_UNCONFIRMED' });
  assert.equal(calls, 1, 'unknown delivery must not be retried in a later tick');

  clearTelegramAlertState();
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const missingReceipt = await sendTelegramAlertWithReceipt({
    type: 'system_critical', details: '200 without Telegram message_id',
  });
  assert.equal(missingReceipt.ok, false);
  if (!missingReceipt.ok) assert.equal(missingReceipt.errorCode, 'TELEGRAM_SEND_OUTCOME_UNCONFIRMED');
  assert.equal(calls, 1);
});

test('Telegram HTTP 403 is classified safely and is not retried', async () => {
  setFakeConfig();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: false, description: 'sensitive provider detail' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await sendTelegramAlert({
    type: 'intelligence_report',
    details: 'connection check',
    cooldownMs: 0,
    duplicateWindowMs: 0,
  });
  assert.deepEqual(result, {
    ok: false,
    attempts: 1,
    skipped: 'DELIVERY_FAILED',
    errorCode: 'TELEGRAM_HTTP_403',
  });
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(result).includes('sensitive provider detail'), false);
});

test('supports all requested alert templates', () => {
  for (const type of [
    'strong_buy',
    'strong_sell',
    'crypto_spot_buy',
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
  assert.match(renderTelegramAlert({ type: 'crypto_spot_buy', symbol: 'BTC' }), /매수 신호/);
});

test('signal intelligence Telegram turns internal state codes into a concise Korean user message', () => {
  process.env.TELEGRAM_CRYPTO_CHAT_ID = 'legacy-shared-crypto-room';
  process.env.TELEGRAM_CRYPTO_SPOT_CHAT_ID = 'crypto-spot-room';
  const input = buildSignalIntelligenceTelegramInput({
    type: 'STATE_CHANGED',
    id: 'ada-position-1d',
    market: 'CRYPTO_SPOT',
    symbol: 'ADA',
    strategy: 'POSITION',
    timeframe: '1D',
    direction: 'BUY',
    previousState: 'BLOCKED_DATA',
    state: 'NO_TRADE',
    validationTier: 'RESEARCH_CANDIDATE',
    reasons: [
      'QUANT_NOT_ELIGIBLE',
      'PROFIT_GATE_REJECTED',
      'RISK_NOT_READY',
      'UTILITY_EVIDENCE_INCOMPLETE:INCOMPLETE_EXPECTED_EDGE',
    ],
  }, 'a'.repeat(40), new Date('2026-09-28T02:46:13.197Z'));

  assert.ok(input);
  assert.equal(input!.destinationChatId, 'crypto-spot-room');
  const rendered = renderTelegramAlert(input!);
  assert.match(rendered, /📊 ADA · 코인현물/);
  assert.match(rendered, /🟡 현재 판단: 관망/);
  assert.match(rendered, /중장기 · 1일봉/);
  assert.match(rendered, /검증: 연구 후보 · 실전수익 미검증/);
  assert.match(rendered, /정량 조건 미충족/);
  assert.match(rendered, /수익성 검증 기준 미충족/);
  assert.match(rendered, /리스크 조건 미충족/);
  assert.match(rendered, /예상 수익 우위 근거 부족/);
  assert.match(rendered, /조건 충족 시 다시 분석합니다/);
  assert.match(rendered, /9월 28일 11:46/);

  for (const internalCode of [
    'CRYPTO_SPOT',
    'POSITION/1D',
    'BUY',
    'BLOCKED_DATA',
    'NO_TRADE',
    'QUANT_NOT_ELIGIBLE',
    'PROFIT_GATE_REJECTED',
    'RISK_NOT_READY',
    'UTILITY_EVIDENCE_INCOMPLETE',
    'INCOMPLETE_EXPECTED_EDGE',
  ]) {
    assert.equal(rendered.includes(internalCode), false, internalCode);
  }
});

test('scanner signal room routing splits domestic, overseas, spot, and futures rooms', () => {
  process.env.TELEGRAM_CHAT_ID = 'default-room';
  delete process.env.TELEGRAM_STOCK_CHAT_ID;
  delete process.env.TELEGRAM_CRYPTO_CHAT_ID;
  delete process.env.TELEGRAM_KR_STOCK_CHAT_ID;
  delete process.env.TELEGRAM_US_STOCK_CHAT_ID;
  delete process.env.TELEGRAM_CRYPTO_SPOT_CHAT_ID;
  delete process.env.TELEGRAM_CRYPTO_FUTURES_CHAT_ID;

  assert.equal(scannerTelegramRoomFor(scannerAlert()), 'KR_STOCK_ROOM');
  assert.equal(scannerTelegramRoomFor(scannerAlert({ market: 'US' })), 'US_STOCK_ROOM');
  assert.equal(scannerTelegramRoomFor(scannerAlert({ assetClass: 'coin_spot', market: 'UPBIT' })), 'CRYPTO_SPOT_ROOM');
  assert.equal(scannerTelegramRoomFor(scannerAlert({ assetClass: 'coin_futures', market: 'BITGET' })), 'CRYPTO_FUTURES_ROOM');
  assert.equal(scannerTelegramRoomChatId('KR_STOCK_ROOM'), null);
  assert.equal(scannerTelegramRoomChatId('US_STOCK_ROOM'), null);
  assert.equal(scannerTelegramRoomChatId('CRYPTO_SPOT_ROOM'), null);
  assert.equal(scannerTelegramRoomChatId('CRYPTO_FUTURES_ROOM'), null);

  process.env.TELEGRAM_KR_STOCK_CHAT_ID = 'kr-stock-room';
  process.env.TELEGRAM_US_STOCK_CHAT_ID = 'us-stock-room';
  process.env.TELEGRAM_CRYPTO_SPOT_CHAT_ID = 'crypto-spot-room';
  process.env.TELEGRAM_CRYPTO_FUTURES_CHAT_ID = 'crypto-futures-room';
  assert.equal(scannerTelegramRoomChatId('KR_STOCK_ROOM'), 'kr-stock-room');
  assert.equal(scannerTelegramRoomChatId('US_STOCK_ROOM'), 'us-stock-room');
  assert.equal(scannerTelegramRoomChatId('CRYPTO_SPOT_ROOM'), 'crypto-spot-room');
  assert.equal(scannerTelegramRoomChatId('CRYPTO_FUTURES_ROOM'), 'crypto-futures-room');
});

test('US exchange names cannot route to Korea; unknown market is never guessed', () => {
  process.env.TELEGRAM_KR_STOCK_CHAT_ID = 'kr-venue-room';
  process.env.TELEGRAM_US_STOCK_CHAT_ID = 'us-venue-room';
  delete process.env.TELEGRAM_CRYPTO_SPOT_CHAT_ID;
  delete process.env.TELEGRAM_CRYPTO_FUTURES_CHAT_ID;
  for (const market of ['US', 'USA', 'NASDAQ', 'NYSE', 'AMEX', 'NYSE-ARCA']) {
    const example = scannerAlert({ market });
    assert.equal(scannerTelegramRoomFor(example), 'US_STOCK_ROOM', market);
    assert.equal(scannerTelegramInput(example)?.destinationChatId, 'us-venue-room', market);
    assert.match(scannerInAppNotificationInput(example, { memberId: 'test-member' })?.body ?? '', /미국주식/, market);
  }
  for (const market of ['KR', 'KOSPI', 'KOSDAQ', 'KRX']) {
    assert.equal(scannerTelegramRoomFor(scannerAlert({ market })), 'KR_STOCK_ROOM', market);
  }
  for (const market of ['AUS', 'UNKNOWN', '', 'US-MISLABELLED']) {
    const example = scannerAlert({ market });
    assert.equal(scannerTelegramRoomFor(example), null, market);
    assert.equal(scannerTelegramInput(example), null, market);
    assert.equal(scannerInAppNotificationInput(example, { memberId: 'test-member' }), null, market);
  }
});

test('duplicate dedicated room destinations fail closed, including whitespace collisions', () => {
  process.env.TELEGRAM_KR_STOCK_CHAT_ID = '-100111111';
  process.env.TELEGRAM_US_STOCK_CHAT_ID = ' -100111111 ';
  process.env.TELEGRAM_CRYPTO_SPOT_CHAT_ID = '-100222222';
  process.env.TELEGRAM_CRYPTO_FUTURES_CHAT_ID = '-100333333';
  assert.equal(scannerTelegramRoomChatId('KR_STOCK_ROOM'), null);
  assert.equal(scannerTelegramRoomChatId('US_STOCK_ROOM'), null);
  assert.equal(scannerTelegramRoomChatId('CRYPTO_SPOT_ROOM'), null);
  assert.equal(scannerTelegramInput(scannerAlert({ market: 'US' })), null);
  process.env.TELEGRAM_US_STOCK_CHAT_ID = '-100444444';
  assert.equal(scannerTelegramRoomChatId('US_STOCK_ROOM'), '-100444444');
});

test('maps stock/spot BUY only and futures LONG/SHORT to their dedicated Telegram rooms', () => {
  const stock = scannerTelegramInput(scannerAlert(), testRoom);
  assert.equal(stock?.type, 'strong_buy');
  assert.equal(stock?.destinationChatId, 'kr-stock-room');

  const spot = scannerTelegramInput(scannerAlert({
    assetClass: 'coin_spot',
    market: 'spot',
    symbol: 'BTC',
    direction: 'LONG',
  }), testRoom);
  assert.equal(spot?.type, 'crypto_spot_buy');
  assert.equal(spot?.destinationChatId, 'crypto-spot-room');

  const futuresLong = scannerTelegramInput(scannerAlert({
    assetClass: 'coin_futures',
    market: 'futures',
    symbol: 'BTCUSDT',
    direction: 'LONG',
  }), testRoom);
  assert.equal(futuresLong?.type, 'crypto_futures_long');
  assert.equal(futuresLong?.destinationChatId, 'crypto-futures-room');

  const futuresShort = scannerTelegramInput(scannerAlert({
    assetClass: 'coin_futures',
    market: 'futures',
    symbol: 'BTCUSDT',
    direction: 'SHORT',
  }), testRoom);
  assert.equal(futuresShort?.type, 'crypto_futures_short');
  assert.equal(futuresShort?.destinationChatId, 'crypto-futures-room');

  assert.equal(scannerTelegramInput(scannerAlert({ direction: 'SHORT' }), testRoom), null);
  assert.equal(scannerTelegramInput(scannerAlert({ assetClass: 'coin_spot', direction: 'SHORT' }), testRoom), null);
});


test('scanner in-app history is member-scoped, push-off, and keeps missing member identity fail-closed', () => {
  const alert = scannerAlert({
    assetClass: 'coin_futures',
    market: 'futures',
    symbol: 'BTCUSDT',
    direction: 'SHORT',
  });
  assert.equal(scannerInAppNotificationInput(alert), null);

  const input = scannerInAppNotificationInput(alert, {
    memberId: 'member-1',
    timeframe: '15m',
    generatedAt: '2026-09-18T00:00:00.000Z',
  });
  assert.ok(input);
  assert.equal(input.memberId, 'member-1');
  assert.equal(input.type, 'ai_sell_signal');
  assert.equal(input.app, true);
  assert.equal(input.push, false);
  assert.equal(input.url, '/scanner');
  assert.equal(input.metadata?.signalId, 'signal:test');
  assert.equal(input.metadata?.direction, 'SHORT');
});

test('scanner central in-app history does not depend on a configured Telegram room', async () => {
  const stored: Array<Parameters<typeof scannerInAppNotificationInput>[0] | unknown> = [];
  let telegramCalls = 0;
  await deliverScannerTelegramAlerts(
    [scannerAlert({ assetClass: 'coin_futures', market: 'futures', symbol: 'BTCUSDT', direction: 'SHORT' })],
    async () => {
      telegramCalls += 1;
      return { ok: true, attempts: 1 };
    },
    () => null,
    { memberId: 'member-1', timeframe: '15m', generatedAt: '2026-09-18T00:00:00.000Z' },
    async () => ({ status: 'DISABLED', matchedCount: 0, policyCount: 0, skippedCount: 0, errorCount: 0 }),
    async (input) => {
      stored.push(input);
      return { appStored: true, pushSent: 0 };
    },
  );
  assert.equal(telegramCalls, 0);
  assert.equal(stored.length, 1);
  const storedInput = stored[0] as { memberId: string; push: boolean; metadata?: Record<string, unknown> };
  assert.equal(storedInput.memberId, 'member-1');
  assert.equal(storedInput.push, false);
  assert.equal(storedInput.metadata?.symbol, 'BTCUSDT');
});

test('scanner Telegram delivery is fail-open and uses the lifecycle idempotency key', async () => {
  const delivered: TelegramAlertInput[] = [];
  await deliverScannerTelegramAlerts(
    [scannerAlert()],
    async (input) => {
      delivered.push(input);
      throw new Error('telegram unavailable');
    },
    testRoom,
  );
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].dedupeKey, 'scanner-alert:test');
  assert.equal(delivered[0].type, 'strong_buy');
  assert.equal(delivered[0].destinationChatId, 'kr-stock-room');
});

test('expired or partial Scanner evidence revokes Telegram order review while preserving chart/news links', () => {
  const entry = scannerAlert({ expiresAt: '2026-08-10T14:00:00.000Z' });
  const initial: TelegramAlertInput = {
    type: 'strong_buy',
    details: 'initial signal',
    buttons: [
      [{ text: '주문하기', url: 'https://ci.example.test/telegram-order?symbol=005930' },
       { text: 'AI차트', url: 'https://ci.example.test/ai-chart?symbol=005930' }],
      [{ text: '뉴스', url: 'https://ci.example.test/stock-info?symbol=005930' }],
    ],
  };
  const partial = addTelegramSignalFreshness(initial, entry, {
    generatedAt: '2026-08-10T11:59:00.000Z',
  }, null, Date.parse('2026-08-10T12:00:00.000Z'));
  const expired = addTelegramSignalFreshness(initial, entry, {
    generatedAt: '2026-08-10T11:59:00.000Z',
  }, null, Date.parse('2026-08-10T14:00:01.000Z'));
  for (const result of [partial, expired]) {
    const links = JSON.stringify(result.buttons);
    assert.ok(!links.includes('/telegram-order'));
    assert.ok(links.includes('/ai-chart'));
    assert.ok(links.includes('/stock-info'));
  }
  assert.match(partial.details ?? '', /일부 Evidence/);
  assert.match(expired.details ?? '', /재검증 전 실시간 신호로 사용 금지/);
});

test('Telegram intelligence audience follows membership and portfolio priority', () => {
  assert.deepEqual(telegramReportDestinations({ membership: 'pending' }), []);
  assert.deepEqual(
    telegramReportDestinations({ membership: 'associate' }),
    ['KR_STOCK_ROOM', 'US_STOCK_ROOM'],
  );
  assert.deepEqual(
    telegramReportDestinations({ membership: 'regular', portfolioRelevant: true, watchlistRelevant: true }),
    ['KR_STOCK_ROOM', 'US_STOCK_ROOM', 'CRYPTO_SPOT_ROOM', 'CRYPTO_FUTURES_ROOM'],
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
  assert.deepEqual(inside[0].destinations, ['KR_STOCK_ROOM']);

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

test('corrupted market briefing ledger fails closed; no replay, overwrite or Telegram send', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'telegram-brief-dedupe-'));
  const file = path.join(directory, 'delivery.json');
  try {
    const corrupt = '{BROKEN_LEGACY_STATE';
    await writeFile(file, corrupt, 'utf8');
    let sends = 0;
    const worker = new TelegramIntelligenceWorker(
      new FileTelegramIntelligenceStateStore(file),
      async () => { sends += 1; return { ok: true as const, attempts: 1 }; },
      (destination) => destination === 'KR_STOCK_ROOM' ? 'mock-kr-room' : null,
      async () => { throw new Error('NO_REAL_MARKET_FETCH'); },
    );
    const time = new Date('2026-08-14T07:00:00.000Z');
    await assert.rejects(worker.runOnce(time), /TELEGRAM_INTELLIGENCE_LEDGER_UNREADABLE/);
    await assert.rejects(worker.runOnce(time), /TELEGRAM_INTELLIGENCE_LEDGER_UNREADABLE/);
    assert.equal(sends, 0);
    assert.equal(await readFile(file, 'utf8'), corrupt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('market brief send followed by disk-commit failure blocks subsequent sends and preserves ledger', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'telegram-brief-durable-'));
  try {
    const stateDirectory = path.join(directory, 'state');
    const archivedDirectory = path.join(directory, 'archived');
    await mkdir(stateDirectory);
    const file = path.join(stateDirectory, 'delivery.json');
    const original = '{"version":1,"delivered":{}}';
    await writeFile(file, original, 'utf8');
    const store = new FileTelegramIntelligenceStateStore(file);
    assert.equal(await store.has('telegram-intelligence:warmup'), false);

    // Move the already-opened state directory aside, then make its former
    // path a regular file. mkdir(stateDirectory) must fail with ENOTDIR.
    await rename(stateDirectory, archivedDirectory);
    await writeFile(stateDirectory, 'SIMULATED_DISK_FAILURE', 'utf8');

    let sends = 0;
    const worker = new TelegramIntelligenceWorker(
      store,
      async () => { sends += 1; return { ok: true as const, attempts: 1 }; },
      destination => destination === 'KR_STOCK_ROOM' ? 'mock-room' : null,
    );
    const when = new Date('2026-08-14T07:00:00.000Z');
    await assert.rejects(worker.runOnce(when), /TELEGRAM_INTELLIGENCE_LEDGER_UNREADABLE/);
    assert.equal(sends, 1, 'the first mocked Bot API acceptance occurred');
    await assert.rejects(worker.runOnce(when), /TELEGRAM_INTELLIGENCE_LEDGER_UNREADABLE/);
    assert.equal(sends, 1, 'no second Telegram send after undurable receipt');
    assert.equal(await readFile(path.join(archivedDirectory, 'delivery.json'), 'utf8'), original);
    assert.equal(await readFile(stateDirectory, 'utf8'), 'SIMULATED_DISK_FAILURE');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Telegram scheduled worker exposes safe idle readiness without any send evidence', () => {
  const status = readTelegramIntelligenceWorkerHealth();
  assert.equal(typeof status.enabled, 'boolean');
  assert.ok(['NOT_STARTED', 'RUNNING', 'DISABLED', 'STOPPED'].includes(status.state));
  assert.ok(['NOT_OBSERVED','BOT_API_ACCEPTED','DEDUPED_ONLY','NOT_CONFIGURED',
    'DELIVERY_FAILED','NO_ATTEMPTS','LEDGER_UNREADABLE','TICK_FAILED'].includes(status.lastDueCode));
  assert.equal(Object.keys(status).some(key => /token|chat|account|user|order|secret/i.test(key)), false);
});

test('ambiguous scheduled Telegram POST is persisted as unconfirmed and never automatically replayed after restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'telegram-uncertain-brief-'));
  const ledger = path.join(directory, 'brief-state.json');
  const now = new Date('2026-10-12T07:00:00.000Z');
  let sends = 0;
  try {
    const worker = new TelegramIntelligenceWorker(
      new FileTelegramIntelligenceStateStore(ledger),
      async () => {
        sends++;
        return { ok: false as const, attempts: 1, skipped: 'OUTCOME_UNCONFIRMED' as const,
          errorCode: 'TELEGRAM_SEND_OUTCOME_UNCONFIRMED' };
      },
      destination => destination === 'KR_STOCK_ROOM' ? 'mock-only-kr-room' : null,
    );
    const first = await worker.runOnce(now);
    assert.equal(first.duePlans, 1);
    assert.equal(first.attempted, 1);
    assert.equal(first.delivered, 0);
    assert.equal(first.deduped, 0);
    assert.equal(first.failed, 1);
    assert.equal(sends, 1);
    const persisted = JSON.parse(await readFile(ledger, 'utf8'));
    assert.equal(persisted.version, 1);
    assert.equal(Object.keys(persisted.delivered).length, 0, 'uncertain is never recorded as SENT');
    assert.equal(Object.keys(persisted.unconfirmed).length, 1);

    const reopened = new TelegramIntelligenceWorker(
      new FileTelegramIntelligenceStateStore(ledger),
      async () => {
        sends++;
        throw new Error('UNCERTAIN_MESSAGE_MUST_NOT_BE_REPLAYED');
      },
      destination => destination === 'KR_STOCK_ROOM' ? 'mock-only-kr-room' : null,
    );
    const again = await reopened.runOnce(now);
    assert.equal(again.attempted, 0);
    assert.equal(again.delivered, 0);
    assert.equal(again.deduped, 0);
    assert.equal(again.failed, 1, 'unconfirmed message remains explicitly unresolved');
    assert.equal(sends, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent Telegram ledger readers await initial persistence before dedupe and uncertain checks', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'telegram-concurrent-load-'));
  try {
    const at = new Date('2026-10-11T10:00:00.000Z');
    const prefix = 'signal-intelligence-v3:' + 'a'.repeat(40);
    const v3Sent = prefix + ':candidate:confirmed';
    const v3Unknown = prefix + ':candidate:uncertain';
    const v3Path = path.join(dir, 'v3.json');
    const v3Writer = new SignalIntelligenceTelegramDeliveryState(v3Path);
    await v3Writer.mark(v3Sent, at);
    await v3Writer.markUnconfirmed(v3Unknown, at);
    const v3Reader = new SignalIntelligenceTelegramDeliveryState(v3Path);
    const [confirmed, unknown] = await Promise.all([
      v3Reader.has(v3Sent, at), v3Reader.hasUnconfirmed(v3Unknown, at),
    ]);
    assert.equal(confirmed, true, 'parallel V3 reader must not skip pending file load');
    assert.equal(unknown, true, 'parallel V3 reader must not forget uncertain outcome');

    const marketSent = 'telegram-intelligence:MORNING:2026-10-11:KR_STOCK_ROOM:mock-one';
    const marketUnknown = 'telegram-intelligence:MORNING:2026-10-11:US_STOCK_ROOM:mock-two';
    const marketPath = path.join(dir, 'market.json');
    const marketWriter = new FileTelegramIntelligenceStateStore(marketPath);
    await marketWriter.markDelivered(marketSent, at);
    await marketWriter.markUnconfirmed(marketUnknown, at);
    const marketReader = new FileTelegramIntelligenceStateStore(marketPath);
    const [briefConfirmed, briefUnknown] = await Promise.all([
      marketReader.has(marketSent), marketReader.hasUnconfirmed(marketUnknown),
    ]);
    assert.equal(briefConfirmed, true, 'parallel brief reader must wait for ledger load');
    assert.equal(briefUnknown, true, 'parallel brief reader must preserve unknown send');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
    destination === 'KR_STOCK_ROOM' ? 'kr-stock-room' : null
  ));
  const now = new Date('2026-08-14T07:00:00.000Z');

  const first = await worker.runOnce(now);
  assert.equal(first.duePlans, 1);
  assert.equal(first.attempted, 1);
  assert.equal(first.delivered, 1);
  assert.equal(first.orderSubmitted, false);
  assert.equal(first.privateTradingApiCount, 0);
  assert.equal(first.liveTradingAuthority, false);
  assert.deepEqual(
    delivered.map((item) => item.type),
    ['intelligence_report'],
  );
  assert.equal(
    delivered.every((item) => item.details?.includes('한국장 마감 브리핑')),
    true,
  );

  const second = await worker.runOnce(now);
  assert.equal(second.attempted, 0);
  assert.equal(second.delivered, 0);
  assert.equal(second.deduped, 1);
  assert.equal(delivered.length, 1);
});

test('Telegram intelligence worker collapses four market destinations sharing one chat per report', async () => {
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

  const result = await worker.runOnce(new Date('2026-08-16T23:00:00.000Z'));
  assert.equal(result.duePlans, 2);
  assert.equal(result.attempted, 2);
  assert.equal(result.delivered, 2);
  assert.equal(calls, 2);
});


test('readable six-room Telegram alert has paragraph spacing and safe HTML', () => {
  const text=renderTelegramAlert({
    type:'strong_buy',title:'국내주식 <005930>',
    details:'진입: 100\\n목표가: 110\n[AI 판단]\n• 거래량 <증가> & 뉴스'
  });
  assert.match(text,/<b>국내주식 &lt;005930&gt;<\/b>\n\n/u);
  assert.match(text,/진입: 100\n목표가: 110\n\n<b>\[AI 판단\]<\/b>/u);
  assert.match(text,/거래량 &lt;증가&gt; &amp; 뉴스/u);
});

test('long rich signal never clips to photo caption: sends complete text', async () => {
  setFakeConfig();
  let endpoint='';
  let payload:Record<string,unknown>={};
  globalThis.fetch=async (url,init)=>{
    endpoint=String(url);
    payload=JSON.parse(String(init?.body)) as Record<string,unknown>;
    return new Response(JSON.stringify({ok:true,result:{message_id:88}}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const details='[AI 분석]\n'+Array.from({length:35},(_,i)=>'• 근거 '+i+': '+'시황자료 '.repeat(7)).join('\n');
  const delivered=await sendTelegramAlertWithReceipt({
    type:'strong_buy',symbol:'AAPL',market:'US',details,
    photo:{bytes:new Uint8Array([137,80,78,71,0,1])},
    cooldownMs:0,duplicateWindowMs:0,
  });
  assert.equal(delivered.ok,true);
  if(!delivered.ok)return;
  assert.equal(delivered.receipt.messageKind,'TEXT');
  assert.ok(delivered.receipt.renderedText.length>1024);
  assert.ok(delivered.receipt.renderedText.length<=4096);
  assert.match(endpoint,/\/sendMessage$/u);
  assert.match(String(payload.text),/<b>\[AI 분석\]<\/b>/u);
});

test('max-length escaping never truncates inside Telegram HTML tag/entity',()=>{
  const output=renderTelegramAlert({type:'intelligence_report',details:'[뉴스]\n'+('<tag> & '.repeat(1600))});
  assert.ok(output.length<=4096);
  assert.equal((output.match(/<b>/gu)||[]).length,(output.match(/<\/b>/gu)||[]).length);
  assert.doesNotMatch(output,/&(?:a|am|amp|l|lt|g|gt|quo|quot|#|#3|#39)$/u);
});

test('weekend exchange close/premarket Telegram plans never fire as regular session reports', () => {
  const audience={membership:'admin' as const};
  for(const now of [
    '2026-10-11T07:00:00.000Z', // Sunday 16:00 Seoul (TODAY)
    '2026-10-10T07:00:00.000Z', // Saturday 16:00 Seoul
  ]){
    const kinds=dueTelegramIntelligenceReports(new Date(now),audience).map(x=>x.kind);
    assert.ok(!kinds.includes('KR_CLOSING'),now);
  }
  for(const now of [
    '2026-10-11T12:00:00.000Z', // Sunday 08:00 New York EDT
    '2026-10-10T12:00:00.000Z', // Saturday 08:00 New York EDT
    '2026-01-11T13:00:00.000Z', // Sunday 08:00 New York EST
  ]){
    const kinds=dueTelegramIntelligenceReports(new Date(now),audience).map(x=>x.kind);
    assert.ok(!kinds.includes('US_PREMARKET'),now);
  }
  // Daily market-condition briefing is still permitted on weekends,
  // but it can only use data-available/N/A, not synthetic weekend trades.
  const sundayMorning=dueTelegramIntelligenceReports(
    new Date('2026-10-10T23:00:00.000Z'),audience);
  assert.deepEqual(sundayMorning.map(x=>x.kind),['MORNING']);
  assert.ok(sundayMorning.every(x=>x.orderSubmitted===false &&
    x.liveTradingAuthority===false));
});

test('scheduled Telegram market-brief ledger refuses linked files and preserves the original', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'telegram-brief-linked-'));
  try {
    const original = path.join(dir, 'real.json');
    const linked = path.join(dir, 'linked.json');
    const content = JSON.stringify({ version: 1, delivered: {
      'telegram-intelligence:MORNING:2026-10-11:KR_STOCK_ROOM:mock':
        '2026-10-11T00:00:00.000Z',
    } });
    await writeFile(original, content, 'utf8');
    await symlink(original, linked);
    const store = new FileTelegramIntelligenceStateStore(linked);
    await assert.rejects(store.has('telegram-intelligence:test'),
      /TELEGRAM_INTELLIGENCE_LEDGER_UNREADABLE/);
    await assert.rejects(store.has('telegram-intelligence:test'),
      /TELEGRAM_INTELLIGENCE_LEDGER_UNREADABLE/);
    assert.equal(await readFile(original, 'utf8'), content);
    // Same fail-closed behavior on a genuine corrupt file is covered above.
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scheduled Telegram report never overwrites a separate file through a temporary symlink', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'telegram-brief-trap-'));
  try {
    const ledger=path.join(dir,'market.json');
    const unrelated=path.join(dir,'private-note.txt');
    const trap=`${ledger}.${process.pid}.tmp`;
    const original='DO_NOT_WRITE_PRIVATE_MATERIAL';
    await writeFile(unrelated,original,'utf8');
    await symlink(unrelated,trap);
    const store=new FileTelegramIntelligenceStateStore(ledger);
    await assert.rejects(store.markDelivered(
      'telegram-intelligence:MORNING:2026-10-11:KR_STOCK_ROOM:mock',
      new Date('2026-10-11T00:00:00.000Z')),
      /TELEGRAM_INTELLIGENCE_LEDGER_UNREADABLE/);
    assert.equal(await readFile(unrelated,'utf8'),original);
    await assert.rejects(store.has('telegram-intelligence:anything'),
      /TELEGRAM_INTELLIGENCE_LEDGER_UNREADABLE/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('scheduled market brief errors keep sensitive provider messages out of sanitized log classification', async () => {
  const sensitive=Error('TELEGRAM_BOT_TOKEN=PRIVATE_SECRET https://private.example/key');
  const code=safeTelegramBriefFailureCode(sensitive);
  assert.equal(code,'TELEGRAM_BRIEF_SOURCE_UNAVAILABLE');
  assert.equal(JSON.stringify({code}).includes('PRIVATE_SECRET'),false);
  const timedOut=Error('CONFIDENTIAL_DETAILS');
  timedOut.name='AbortError';
  assert.equal(safeTelegramBriefFailureCode(timedOut),'TELEGRAM_BRIEF_TIMEOUT');
  const before=process.env.TELEGRAM_DAILY_BRIEF_RICH_ENABLED;
  let sent=0,fetches=0;
  try{
    process.env.TELEGRAM_DAILY_BRIEF_RICH_ENABLED='true';
    const worker=new TelegramIntelligenceWorker(
      new MemoryTelegramIntelligenceStateStore(),
      async()=>{sent+=1;return {ok:true as const,attempts:1};},
      room=>room==='KR_STOCK_ROOM'?'mock-kr-room':null,
      async()=>{fetches+=1;throw sensitive;},
    );
    const result=await worker.runOnce(new Date('2026-10-12T07:00:00.000Z'));
    assert.equal(fetches,1);
    assert.equal(result.delivered,1);
    assert.equal(sent,1);
    assert.equal(result.liveTradingAuthority,false);
    assert.equal(result.orderSubmitted,false);
  }finally{
    if(before===undefined)delete process.env.TELEGRAM_DAILY_BRIEF_RICH_ENABLED;
    else process.env.TELEGRAM_DAILY_BRIEF_RICH_ENABLED=before;
  }
});

test('member watchlist BATCHED personal digest is counted as durable queue, never delivered or skipped', async () => {
  const event = {
    type:'NEW_CANDIDATE' as const,
    id:'US_STOCK|AAPL|SWING|60m|BUY',
    serviceSha:'a'.repeat(40),
    market:'US_STOCK' as const,
    symbol:'AAPL',
    strategy:'SWING',
    timeframe:'60m',
    direction:'BUY' as const,
    validationTier:'RESEARCH_CANDIDATE' as const,
    occurredAt:'2026-10-11T06:00:00.000Z',
  };
  const accepted=await deliverMemberWatchlistTelegramForSignal(event, {
    findSubscribers:async()=>[{userId:'mock-user'}],
    deliver:async()=>({
      status:'POLICY' as const,reason:null,
      policy:{
        decision:{
          action:'BATCHED' as const,reason:'DIGEST_BATCHED' as const,
          userId:'mock-user',prioritySemantics:'DELIVERY_URGENCY_ONLY' as const,
          digestKey:'mock-user:US:IMPORTANT',digestWindowMs:1800000,
          safety:TELEGRAM_POLICY_SAFETY,
        },
        transport:null,safety:TELEGRAM_POLICY_SAFETY,
      },
      deliveryQueued:true,deliveryId:'mock-outbox-id',
    }),
  },{MEMBER_WATCHLIST_TELEGRAM_PRODUCER_ENABLED:'true'});
  assert.equal(accepted.eligible,true);
  assert.equal(accepted.attempted,1);
  assert.equal(accepted.queued,1,'a saved digest is a real queued alert');
  assert.equal(accepted.delivered,0,'a saved digest is NOT Telegram Bot API acceptance');
  assert.equal(accepted.skipped,0,'queued digest must not be reported as suppressed');
  assert.equal(accepted.failed,0);
  assert.equal(accepted.reason,'COMPLETE');

  const refused=await deliverMemberWatchlistTelegramForSignal(event, {
    findSubscribers:async()=>[{userId:'mock-user'}],
    deliver:async()=>({
      status:'POLICY' as const,reason:null,
      policy:{
        decision:{
          action:'BATCHED' as const,reason:'DIGEST_BATCHED' as const,
          userId:'mock-user',prioritySemantics:'DELIVERY_URGENCY_ONLY' as const,
          digestKey:'mock-user:US:IMPORTANT',digestWindowMs:1800000,
          safety:TELEGRAM_POLICY_SAFETY,
        },
        transport:null,safety:TELEGRAM_POLICY_SAFETY,
      },
      deliveryQueued:false,deliveryId:null,
    }),
  },{MEMBER_WATCHLIST_TELEGRAM_PRODUCER_ENABLED:'true'});
  assert.equal(refused.queued,0);
  assert.equal(refused.delivered,0);
  assert.equal(refused.skipped,1,'a rejected digest entry is not a queued success');
});
