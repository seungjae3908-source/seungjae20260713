import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpUserTelegramTransport } from '../features/user-broker-telegram/user-broker-telegram.transport';
import {
  buildMemberHoldingTelegramDispatch,
  deliverMemberHoldingTelegramAlert,
} from './member-holdings-telegram-alert.service';
import { defaultTelegramAlertPolicy } from './telegram-alert-policy.service';
import { telegramDestinationChatId } from './telegram-intelligence-worker.service';
import {
  clearTelegramAlertState,
  sendTelegramAlert,
  type TelegramAlertInput,
} from './telegram-notification.service';

function okTelegramResponse(): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('public and member Telegram transports always request protected content', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalChat = process.env.TELEGRAM_CHAT_ID;
  const payloads: Array<Record<string, unknown> | FormData> = [];
  try {
    process.env.TELEGRAM_BOT_TOKEN = 'ci-protected-bot';
    process.env.TELEGRAM_CHAT_ID = 'default-ci-chat';
    clearTelegramAlertState();
    globalThis.fetch = async (_input, init) => {
      if (init?.body instanceof FormData) payloads.push(init.body);
      else payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return okTelegramResponse();
    };

    assert.deepEqual(await sendTelegramAlert({
      type: 'strong_buy',
      symbol: '005930',
      destinationChatId: 'stock-room',
      dedupeKey: 'protected-text',
      duplicateWindowMs: 0,
      cooldownMs: 0,
    }), { ok: true, attempts: 1 });

    assert.deepEqual(await sendTelegramAlert({
      type: 'intelligence_report',
      symbol: 'AAPL',
      destinationChatId: 'stock-room',
      photo: { bytes: new Uint8Array([137, 80, 78, 71]), filename: 'evidence.png' },
      dedupeKey: 'protected-photo',
      duplicateWindowMs: 0,
      cooldownMs: 0,
    }), { ok: true, attempts: 1 });

    const directTransport = new HttpUserTelegramTransport('ci-member-bot');
    assert.deepEqual(await directTransport.send('member-chat', 'member-only'), { ok: true });

    const textPayload = payloads[0] as Record<string, unknown>;
    assert.equal(textPayload.chat_id, 'stock-room');
    assert.equal(textPayload.protect_content, true);

    const photoPayload = payloads[1] as FormData;
    assert.equal(photoPayload.get('chat_id'), 'stock-room');
    assert.equal(photoPayload.get('protect_content'), 'true');

    const memberPayload = payloads[2] as Record<string, unknown>;
    assert.equal(memberPayload.chat_id, 'member-chat');
    assert.equal(memberPayload.protect_content, true);
  } finally {
    globalThis.fetch = originalFetch;
    clearTelegramAlertState();
    if (originalToken == null) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    if (originalChat == null) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originalChat;
  }
});

test('new stock and crypto routing never falls back to the legacy default room', () => {
  const originalDefault = process.env.TELEGRAM_CHAT_ID;
  const originalStock = process.env.TELEGRAM_STOCK_CHAT_ID;
  const originalCrypto = process.env.TELEGRAM_CRYPTO_CHAT_ID;
  const originalPersonal = process.env.TELEGRAM_PERSONAL_CHAT_ID;
  try {
    process.env.TELEGRAM_CHAT_ID = 'legacy-stock-ai-signal-room';
    delete process.env.TELEGRAM_STOCK_CHAT_ID;
    delete process.env.TELEGRAM_CRYPTO_CHAT_ID;
    delete process.env.TELEGRAM_PERSONAL_CHAT_ID;
    assert.equal(telegramDestinationChatId('STOCK_ROOM'), null);
    assert.equal(telegramDestinationChatId('CRYPTO_ROOM'), null);
    assert.equal(telegramDestinationChatId('PERSONAL'), null);

    process.env.TELEGRAM_STOCK_CHAT_ID = 'seungjae-stock-room';
    process.env.TELEGRAM_CRYPTO_CHAT_ID = 'seungjae-crypto-room';
    process.env.TELEGRAM_PERSONAL_CHAT_ID = 'admin-personal-room';
    assert.equal(telegramDestinationChatId('STOCK_ROOM'), 'seungjae-stock-room');
    assert.equal(telegramDestinationChatId('CRYPTO_ROOM'), 'seungjae-crypto-room');
    assert.equal(telegramDestinationChatId('PERSONAL'), 'admin-personal-room');
  } finally {
    if (originalDefault == null) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originalDefault;
    if (originalStock == null) delete process.env.TELEGRAM_STOCK_CHAT_ID;
    else process.env.TELEGRAM_STOCK_CHAT_ID = originalStock;
    if (originalCrypto == null) delete process.env.TELEGRAM_CRYPTO_CHAT_ID;
    else process.env.TELEGRAM_CRYPTO_CHAT_ID = originalCrypto;
    if (originalPersonal == null) delete process.env.TELEGRAM_PERSONAL_CHAT_ID;
    else process.env.TELEGRAM_PERSONAL_CHAT_ID = originalPersonal;
  }
});

test('member holdings messages separate stock and crypto without exposing user identity', () => {
  const stock = buildMemberHoldingTelegramDispatch({
    userId: 'user-a-secret-id',
    eventId: 'stock-event-1',
    assetClass: 'stock',
    market: 'KR',
    symbol: '005930',
    name: '삼성전자',
    occurredAt: '2026-08-23T03:30:00.000Z',
    currentPrice: 82000,
    averageEntryPrice: 78000,
    changePercent: 3.25,
    aiAnalysis: '검증된 입력 범위 안의 분석',
    tradePlan: {
      entryPrices: [81000, 80000, 79000],
      targetPrices: [84000, 86000, 88000],
      stopLoss: 77000,
    },
    news: [{
      kind: 'DISCLOSURE',
      title: '테스트 공시',
      source: 'DART',
      url: 'https://example.com/disclosure',
    }],
  });
  assert.equal(stock.event.market, 'KR');
  assert.equal(stock.event.userId, 'user-a-secret-id');
  assert.match(stock.alert.details ?? '', /📈 보유종목\(주식\)/u);
  assert.match(stock.alert.details ?? '', /1차 81,000/u);
  assert.match(stock.alert.details ?? '', /공시/u);
  assert.equal((stock.alert.details ?? '').includes('user-a-secret-id'), false);
  assert.equal(stock.alert.destinationChatId, undefined);

  const crypto = buildMemberHoldingTelegramDispatch({
    userId: 'user-b-secret-id',
    eventId: 'crypto-event-1',
    assetClass: 'coin_futures',
    market: 'BITGET_FUTURES',
    symbol: 'BTCUSDT',
    occurredAt: '2026-08-23T03:31:00.000Z',
    currentPrice: 65000,
    changePercent: -8.5,
    tradePlan: { targetPrices: [67000, 69000], stopLoss: 63000 },
  });
  assert.equal(crypto.event.market, 'CRYPTO_FUTURES');
  assert.equal(crypto.event.priority, 'CRITICAL');
  assert.match(crypto.alert.details ?? '', /₿ 보유종목\(코인\)/u);
  assert.match(crypto.alert.details ?? '', /AI 분석: N\/A/u);
  assert.equal((crypto.alert.details ?? '').includes('user-b-secret-id'), false);
});

test('member AI advisor renders only supplied provenance-backed analysis and factual position P/L', () => {
  const dispatch = buildMemberHoldingTelegramDispatch({
    userId: 'member-private-id',
    eventId: 'advisor-evidence-1',
    assetClass: 'stock',
    market: 'KR',
    symbol: '005930',
    name: '삼성전자',
    occurredAt: '2026-08-24T11:00:00.000Z',
    currentPrice: 82000,
    averageEntryPrice: 78000,
    changePercent: 1.4,
    analysisProfileLabel: '스윙 · 균형형',
    triggerReasons: ['거래량 급증', '검증된 공시 발생'],
    ai: {
      verdict: 'HOLD',
      summary: '상승 추세는 유지되지만 목표 구간 접근 여부를 함께 확인합니다.',
      reasons: ['거래량 증가가 확인됨', '단기 저항 구간에 접근 중'],
      confidencePercent: 82.4,
      confidenceSource: 'validated-ai-evidence-v1',
      generatedAt: '2026-08-24T10:59:00.000Z',
    },
    risk: {
      level: 'CRITICAL',
      reasons: ['공시 이후 변동성 확대 증거가 입력됨'],
    },
    performance: {
      state: 'READY',
      sampleSize: 42,
      winRatePercent: 64.29,
      averageReturnPercent: 3.7,
      maxDrawdownPercent: 6.2,
      source: 'forward-observer:strategy-v7',
      observedAt: '2026-08-24T10:58:00.000Z',
    },
    tradePlan: {
      entryPrices: [81000, 80000],
      targetPrices: [84000, 86000],
      stopLoss: 77000,
      entryRationale: '검증된 지지 구간 evidence',
      targetRationale: '검증된 저항 구간 evidence',
      stopRationale: '검증된 무효화 가격 evidence',
    },
    news: [{
      kind: 'DISCLOSURE',
      title: '테스트 공시',
      source: 'DART',
      url: 'https://example.com/disclosure',
      publishedAt: '2026-08-24T10:50:00.000Z',
      impact: 'MIXED',
      impactReason: '단기 변동성 확대 가능성과 중기 실적 개선 근거가 함께 존재',
    }],
    detailUrl: 'https://user:pass@example.com/app/analysis?symbol=005930',
  });

  const details = dispatch.alert.details ?? '';
  assert.equal(dispatch.event.priority, 'CRITICAL');
  assert.match(details, /평단 기준 손익률: \+5\.13%/u);
  assert.match(details, /개인 분석 기준: 스윙 · 균형형/u);
  assert.match(details, /AI 판단: 보유 유지/u);
  assert.match(details, /AI 신뢰도: 82\.4% · validated-ai-evidence-v1/u);
  assert.match(details, /\[알림 발생 이유\]/u);
  assert.match(details, /거래량 급증/u);
  assert.match(details, /\[AI 판단 근거\]/u);
  assert.match(details, /목표가 근거: 검증된 저항 구간 evidence/u);
  assert.match(details, /손절가 근거: 검증된 무효화 가격 evidence/u);
  assert.match(details, /\[위험 판단\] CRITICAL/u);
  assert.match(details, /\[과거 유사조건 성과\] 검증됨/u);
  assert.match(details, /표본: N=42/u);
  assert.match(details, /승률: 64\.29%/u);
  assert.match(details, /평균 수익률: \+3\.70%/u);
  assert.match(details, /최대 낙폭: 6\.20%/u);
  assert.match(details, /영향 혼재/u);
  assert.equal(details.includes('member-private-id'), false);

  const appButton = dispatch.alert.buttons?.[0]?.[0];
  assert.equal(appButton?.text, '📲 앱에서 상세 분석');
  assert.equal(appButton?.url, 'https://example.com/app/analysis?symbol=005930');
});

test('member AI advisor fails closed when confidence, performance, prices, or links are not evidenced', () => {
  const dispatch = buildMemberHoldingTelegramDispatch({
    userId: 'member-private-id',
    eventId: 'advisor-missing-evidence-1',
    assetClass: 'coin_spot',
    market: 'UPBIT',
    symbol: 'BTC',
    occurredAt: '2026-08-24T11:05:00.000Z',
    currentPrice: 100,
    averageEntryPrice: 0,
    ai: {
      verdict: 'HOLD',
      summary: '요약은 공급됐지만 confidence provenance는 없음',
      confidencePercent: 99,
    },
    performance: {
      state: 'READY',
      sampleSize: 0,
      winRatePercent: 99,
      averageReturnPercent: 50,
      maxDrawdownPercent: 1,
      source: 'invalid-empty-sample',
    },
    tradePlan: {},
    detailUrl: 'javascript:alert(1)',
  });

  const details = dispatch.alert.details ?? '';
  assert.match(details, /평단 기준 손익률: N\/A/u);
  assert.match(details, /AI 신뢰도: N\/A/u);
  assert.match(details, /분할 매수\/진입: N\/A/u);
  assert.match(details, /분할 매도\/목표: N\/A/u);
  assert.match(details, /손절가: N\/A/u);
  assert.match(details, /진입 근거: N\/A/u);
  assert.match(details, /목표가 근거: N\/A/u);
  assert.match(details, /손절가 근거: N\/A/u);
  assert.match(details, /\[과거 유사조건 성과\] 근거 없음/u);
  assert.match(details, /승률\/평균수익\/낙폭: N\/A/u);
  assert.equal(dispatch.alert.buttons?.some((row) => row.some((button) => button.url.startsWith('javascript:'))), false);
});

test('member holdings delivery resolves only the linked member chat server-side', async () => {
  const delivered: TelegramAlertInput[] = [];
  const policy = {
    ...defaultTelegramAlertPolicy('user-a'),
    enabled: true,
    cooldownMs: 0,
    sameEventDedupeMs: 0,
    sameSymbolWindowMs: 0,
    sameSymbolRepeatLimit: 100,
  };
  const result = await deliverMemberHoldingTelegramAlert({
    userId: 'user-a',
    eventId: 'member-only-event-20260823',
    assetClass: 'stock',
    market: 'US',
    symbol: 'AAPL',
    occurredAt: '2026-08-23T03:32:00.000Z',
    currentPrice: 225,
    averageEntryPrice: 210,
    news: [{ kind: 'NEWS', title: '테스트 뉴스', source: 'provider' }],
  }, {
    connectionRepository: {
      getTelegramConnection: async (userId) => userId === 'user-a'
        ? {
            userId: 'user-a',
            telegramChatId: 'member-chat-a',
            telegramUserId: 'tg-a',
            status: 'ACTIVE',
            connectedAt: '2026-08-01T00:00:00.000Z',
            revokedAt: null,
            updatedAt: '2026-08-01T00:00:00.000Z',
          }
        : null,
    },
    policyRepository: {
      getPolicy: async () => ({ policy, source: 'STORED' }),
    },
    sender: async (input) => {
      delivered.push(input);
      return { ok: true, attempts: 1 };
    },
  });

  assert.equal(result.status, 'POLICY');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].destinationChatId, 'member-chat-a');
  assert.notEqual(delivered[0].destinationChatId, 'member-chat-b');
  assert.equal((delivered[0].details ?? '').includes('user-a'), false);
});
