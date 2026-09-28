import assert from 'node:assert/strict';
import test from 'node:test';
import type { Candle } from '../sample/types';
import {
  buildTelegramSignalAppButtons,
  buildTelegramSignalIntelligenceInput,
  type TelegramSignalIntelligenceEvidence,
} from './telegram-investment-intelligence.service';
import { buildTelegramMarketBriefInput } from './telegram-market-brief.service';
import {
  renderTelegramEvidenceChart,
} from './telegram-evidence-chart.service';
import {
  clearTelegramAlertState,
  sendTelegramAlert,
  telegramInlineKeyboard,
} from './telegram-notification.service';
import type { ScannerAlertCandidate } from './scanner-signal.types';

const originalFetch = globalThis.fetch;
const originalToken = process.env.TELEGRAM_BOT_TOKEN;
const originalChat = process.env.TELEGRAM_CHAT_ID;
const originalPublicApp = process.env.PUBLIC_APP_URL;

function candles(now = Date.now()): Candle[] {
  return Array.from({ length: 30 }, (_, index) => {
    const base = 100 + index * 0.4;
    return {
      time: now - (29 - index) * 60_000,
      open: base,
      high: base + 1.2,
      low: base - 0.9,
      close: base + (index % 2 === 0 ? 0.6 : -0.3),
      volume: 10_000 + index * 100,
    };
  });
}

function alert(): ScannerAlertCandidate {
  return {
    idempotencyKey: 'signal:kr:005930:1',
    signalId: 'signal:kr:005930',
    assetClass: 'stock',
    market: 'KR',
    symbol: '005930',
    direction: 'LONG',
    state: 'READY_FOR_APPROVAL',
    entryZone: { from: 109, to: 111 },
    stopLoss: 105,
    targets: [115, 120, 125],
    expiresAt: '2026-08-21T05:00:00.000Z',
    evidence: ['거래량 증가', '추세 확인'],
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  clearTelegramAlertState();
  if (originalToken == null) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  if (originalChat == null) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChat;
  if (originalPublicApp == null) delete process.env.PUBLIC_APP_URL;
  else process.env.PUBLIC_APP_URL = originalPublicApp;
});

test('deterministic chart renders a real PNG only from fresh ordered candle evidence', () => {
  const now = Date.parse('2026-08-21T04:30:00.000Z');
  const data = candles(now);
  const result = renderTelegramEvidenceChart({
    candles: data,
    dataAsOf: new Date(now).toISOString(),
    entryZone: { from: 109, to: 111 },
    stopLoss: 105,
    targets: [115, 120],
    nowMs: now,
    maxAgeMs: 3_600_000,
  });
  assert.equal(result.status, 'READY');
  if (result.status !== 'READY') return;
  assert.equal(Buffer.from(result.png).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(result.png.byteLength > 1_000);
  assert.equal(result.candleCount, 30);

  const stale = renderTelegramEvidenceChart({
    candles: data,
    dataAsOf: '2026-08-20T00:00:00.000Z',
    nowMs: now,
    maxAgeMs: 60_000,
  });
  assert.deepEqual(stale, { status: 'UNAVAILABLE', reason: 'STALE_CHART_EVIDENCE' });
});

test('rich signal card uses evidence, AI explanation, news links and read-only app buttons', () => {
  process.env.PUBLIC_APP_URL = 'https://example.test';
  const chart = renderTelegramEvidenceChart({
    candles: candles(Date.parse('2026-08-21T04:30:00.000Z')),
    dataAsOf: '2026-08-21T04:30:00.000Z',
    nowMs: Date.parse('2026-08-21T04:30:00.000Z'),
    maxAgeMs: 3_600_000,
  });
  const evidence: TelegramSignalIntelligenceEvidence = {
    aiExplanation: '공개 데이터 기준 추세와 거래량 근거가 있으나 손절선 이탈 시 무효입니다.',
    aiModel: 'test-model',
    aiAsOf: '2026-08-21T04:30:00.000Z',
    displayName: '삼성전자',
    theme: '반도체',
    news: [{
      title: '반도체 업황 관련 공개 뉴스',
      source: 'Example News',
      url: 'https://news.example.test/article/1',
      publishedAt: '2026-08-21T03:00:00.000Z',
      tone: 'positive',
    }],
    marketEvents: [
      {
        kind: 'DISCLOSURE',
        title: '신규 공급계약 공시',
        source: 'DART',
        url: 'https://dart.example.test/report/1',
        publishedAt: '2026-08-21T03:30:00.000Z',
        summary: '신규 공급계약 체결 사실을 확인했으며 계약 조건은 원문 확인이 필요합니다.',
        sentiment: 'POSITIVE',
        importanceScore: 91,
        confidenceScore: 95,
        freshness: 'FRESH',
        riskFlags: [],
        catalystFlags: ['CONTRACT'],
      },
      {
        kind: 'NEWS',
        title: '반도체 업황 관련 공개 뉴스',
        source: 'Example News',
        url: 'https://news.example.test/article/1',
        publishedAt: '2026-08-21T03:00:00.000Z',
        summary: '반도체 업황 개선 기대를 다룬 공개 기사입니다.',
        sentiment: 'POSITIVE',
        importanceScore: 72,
        confidenceScore: 80,
        freshness: 'FRESH',
        riskFlags: [],
        catalystFlags: ['SECTOR'],
      },
    ],
    chart,
    warnings: [],
  };
  const result = buildTelegramSignalIntelligenceInput({
    type: 'strong_buy',
    symbol: '005930',
    market: 'KR',
    destinationChatId: 'stock-room',
  }, alert(), evidence, { timeframe: '15m', strategyMode: 'scalping' });

  assert.match(result.details ?? '', /🟢 신호: 매수 · 15m/);
  assert.match(result.details ?? '', /거래량 증가/);
  assert.match(result.title ?? '', /삼성전자\(005930\) \/ 국내주식 · 단타 · 반도체/);
  assert.match(result.details ?? '', /1차 진입 111 · 기본 60%/);
  assert.match(result.details ?? '', /2차 진입 109 · 기본 40%/);
  assert.equal((result.details ?? '').includes('주문하기를 누르면 앱에서 최신 시장데이터로 다시 검증합니다'), false);
  assert.match(result.details ?? '', /AI:/);
  assert.match(result.details ?? '', /신규 공급계약 공시/);
  assert.match(result.details ?? '', /AI 요약/);
  assert.match(result.details ?? '', /반도체 업황 관련 공개 뉴스/);
  assert.equal(result.linkPreview, false);
  assert.ok(result.photo?.bytes instanceof Uint8Array);
  assert.equal(result.buttons?.flat().some((button) => button.text.includes('AI차트')), true);
  assert.equal(result.buttons?.flat().some((button) => button.text.includes('🛒 주문')), true);
  assert.equal(result.buttons?.flat().some((button) => button.text.includes('뉴스·공시')), false);
  assert.equal(result.buttons?.flat().some((button) => button.text.includes('공시') && button.text.includes('원문')), true);
  const orderButton = result.buttons?.flat().find((button) => button.text.includes('🛒 주문'));
  assert.ok(orderButton);
  const orderUrl = new URL(orderButton!.url);
  assert.equal(orderUrl.pathname, '/telegram-order');
  assert.equal(orderUrl.searchParams.get('symbol'), '005930');
  assert.equal(orderUrl.searchParams.get('market'), 'KR');
  assert.equal(orderUrl.searchParams.get('strategyMode'), 'scalping');
  assert.equal(orderUrl.searchParams.get('orderPreparation'), '1');
  assert.equal(orderUrl.searchParams.get('source'), 'telegram');
  const chartButton = result.buttons?.flat().find((button) => button.text.includes('AI차트'));
  assert.ok(chartButton);
  const chartUrl = new URL(chartButton!.url);
  assert.equal(chartUrl.pathname, '/ai-chart');
  assert.equal(chartUrl.searchParams.get('assetType'), 'stock');
  assert.equal(chartUrl.searchParams.get('market'), 'KR');
  assert.equal(chartUrl.searchParams.get('symbol'), '005930');
  assert.equal(chartUrl.searchParams.get('ticker'), '005930');
  assert.equal(chartUrl.searchParams.get('timeframe'), '15m');
  assert.equal(chartUrl.searchParams.get('strategyMode'), 'scalping');
  assert.equal(chartUrl.searchParams.get('name'), '삼성전자');
  for (const forbidden of ['userId', 'memberId', 'chatId', 'accountId', 'signalId']) {
    assert.equal(orderUrl.searchParams.has(forbidden), false);
  }
  assert.equal(JSON.stringify(result).includes('callback_data'), false);
});

test('AI chart deep links preserve exact asset class for spot and futures', () => {
  process.env.PUBLIC_APP_URL = 'https://example.test';

  const spot = buildTelegramSignalAppButtons({
    assetClass: 'coin_spot',
    market: 'UPBIT',
    symbol: 'BTC',
    direction: 'LONG',
  }, { timeframe: '15m', strategyMode: 'scalping' }, { orderEnabled: true });
  const spotChart = spot.flat().find((button) => button.text.includes('AI차트'));
  assert.ok(spotChart);
  const spotUrl = new URL(spotChart!.url);
  assert.equal(spotUrl.pathname, '/ai-chart');
  assert.equal(spotUrl.searchParams.get('assetType'), 'coin_spot');
  assert.equal(spotUrl.searchParams.get('market'), 'UPBIT');
  assert.equal(spotUrl.searchParams.get('symbol'), 'BTC');
  assert.equal(spotUrl.searchParams.get('timeframe'), '15m');

  const futures = buildTelegramSignalAppButtons({
    assetClass: 'coin_futures',
    market: 'BITGET',
    symbol: 'BTCUSDT',
    direction: 'SHORT',
  }, { timeframe: '60m', strategyMode: 'swing' }, { orderEnabled: false });
  const futuresFlat = futures.flat();
  assert.equal(futuresFlat.some((button) => button.text.includes('주문')), false);
  const futuresChart = futuresFlat.find((button) => button.text.includes('AI차트'));
  assert.ok(futuresChart);
  const futuresUrl = new URL(futuresChart!.url);
  assert.equal(futuresUrl.searchParams.get('assetType'), 'coin_futures');
  assert.equal(futuresUrl.searchParams.get('market'), 'BITGET');
  assert.equal(futuresUrl.searchParams.get('symbol'), 'BTCUSDT');
  assert.equal(futuresUrl.searchParams.get('timeframe'), '60m');
});

test('Telegram rich transport uses sendPhoto multipart and accepts URL buttons only', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = 'test-chat';
  const chart = renderTelegramEvidenceChart({
    candles: candles(Date.parse('2026-08-21T04:30:00.000Z')),
    dataAsOf: '2026-08-21T04:30:00.000Z',
    nowMs: Date.parse('2026-08-21T04:30:00.000Z'),
    maxAgeMs: 3_600_000,
  });
  assert.equal(chart.status, 'READY');
  if (chart.status !== 'READY') return;

  const keyboard = telegramInlineKeyboard([
    [{ text: '정상', url: 'https://example.test/detail' }],
    [{ text: '차단', url: 'javascript:alert(1)' }],
  ]);
  assert.deepEqual(keyboard, { inline_keyboard: [[{ text: '정상', url: 'https://example.test/detail' }]] });

  let called = 0;
  globalThis.fetch = async (request, init) => {
    called += 1;
    assert.match(String(request), /\/sendPhoto$/);
    assert.ok(init?.body instanceof FormData);
    const body = init.body as FormData;
    assert.equal(body.get('chat_id'), 'test-chat');
    assert.match(String(body.get('caption')), /매수 신호/);
    assert.ok(body.get('photo') instanceof Blob);
    assert.match(String(body.get('reply_markup')), /https:\/\/example\.test\/detail/);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const delivered = await sendTelegramAlert({
    type: 'strong_buy',
    symbol: '005930',
    market: 'KR',
    details: '근거 기반 신호',
    photo: { bytes: chart.png },
    buttons: [[{ text: '상세', url: 'https://example.test/detail' }]],
    cooldownMs: 0,
  });
  assert.deepEqual(delivered, { ok: true, attempts: 1 });
  assert.equal(called, 1);
});

test('daily brief keeps missing market data explicit and exposes only source links', () => {
  const input = buildTelegramMarketBriefInput({
    kind: 'MORNING',
    localDate: '2026-08-21',
    destination: 'KR_STOCK_ROOM',
    destinationChatId: 'kr-stock-room',
    dedupeKey: 'brief:test',
    now: new Date('2026-08-21T00:00:00.000Z'),
    snapshot: {
      generatedAt: '2026-08-21T00:00:00.000Z',
      rooms: [
        { room: 'stocks-kr', response: null, error: 'PROVIDER_FAILURE' },
        { room: 'stocks-us', response: null, error: 'TIMEOUT' },
        { room: 'coins-spot', response: null, error: 'PROVIDER_FAILURE' },
        { room: 'coins-futures', response: null, error: 'PROVIDER_FAILURE' },
      ],
      krThemes: null,
      usThemes: null,
      warnings: ['KR_THEME_UNAVAILABLE'],
    },
  });
  assert.match(input.details ?? '', /데이터 공급 지연/);
  assert.match(input.details ?? '', /테마: N\/A/);
  assert.match(input.details ?? '', /검증된 최신 뉴스 N\/A/);
  assert.equal(input.buttons?.length, 0);
  assert.equal(JSON.stringify(input).includes('주문'), false);
});

test('daily market briefs strictly separate all four market rooms', () => {
  const snapshot = {
    generatedAt: '2026-08-21T00:00:00.000Z',
    rooms: [
      { room: 'stocks-kr' as const, response: null, error: 'KR_PROVIDER_FAILURE' },
      { room: 'stocks-us' as const, response: null, error: 'US_PROVIDER_FAILURE' },
      { room: 'coins-spot' as const, response: null, error: 'SPOT_PROVIDER_FAILURE' },
      { room: 'coins-futures' as const, response: null, error: 'FUTURES_PROVIDER_FAILURE' },
    ],
    krThemes: null,
    usThemes: null,
    warnings: [
      'stocks-kr:KR_PROVIDER_FAILURE',
      'stocks-us:US_PROVIDER_FAILURE',
      'coins-spot:SPOT_PROVIDER_FAILURE',
      'coins-futures:FUTURES_PROVIDER_FAILURE',
      'KR_THEME_UNAVAILABLE',
      'US_THEME_UNAVAILABLE',
    ],
  };

  const kr = buildTelegramMarketBriefInput({
    kind: 'MORNING',
    localDate: '2026-08-21',
    destination: 'KR_STOCK_ROOM',
    destinationChatId: 'kr-stock-room',
    dedupeKey: 'brief:kr',
    now: new Date('2026-08-21T00:00:00.000Z'),
    snapshot,
  });
  assert.match(kr.details ?? '', /국내주식/);
  assert.match(kr.details ?? '', /국내주식 데이터 일부 확인 지연/);
  assert.doesNotMatch(kr.details ?? '', /KR_PROVIDER_FAILURE|미국주식|US_PROVIDER_FAILURE|코인현물|코인선물/);
  assert.match(kr.details ?? '', /KR 테마: N\/A/);
  assert.doesNotMatch(kr.details ?? '', /US 테마/);

  const us = buildTelegramMarketBriefInput({
    kind: 'MORNING',
    localDate: '2026-08-21',
    destination: 'US_STOCK_ROOM',
    destinationChatId: 'us-stock-room',
    dedupeKey: 'brief:us',
    now: new Date('2026-08-21T00:00:00.000Z'),
    snapshot,
  });
  assert.match(us.details ?? '', /해외주식/);
  assert.match(us.details ?? '', /해외주식 데이터 일부 확인 지연/);
  assert.doesNotMatch(us.details ?? '', /US_PROVIDER_FAILURE|KR_PROVIDER_FAILURE|코인현물|코인선물/);
  assert.match(us.details ?? '', /US 테마: N\/A/);
  assert.doesNotMatch(us.details ?? '', /KR 테마/);

  const spot = buildTelegramMarketBriefInput({
    kind: 'MORNING',
    localDate: '2026-08-21',
    destination: 'CRYPTO_SPOT_ROOM',
    destinationChatId: 'crypto-spot-room',
    dedupeKey: 'brief:spot',
    now: new Date('2026-08-21T00:00:00.000Z'),
    snapshot,
  });
  assert.match(spot.details ?? '', /코인현물/);
  assert.match(spot.details ?? '', /코인현물 데이터 일부 확인 지연/);
  assert.doesNotMatch(spot.details ?? '', /SPOT_PROVIDER_FAILURE|FUTURES_PROVIDER_FAILURE|국내주식|해외주식|오늘의 테마\/주도주/);

  const futures = buildTelegramMarketBriefInput({
    kind: 'MORNING',
    localDate: '2026-08-21',
    destination: 'CRYPTO_FUTURES_ROOM',
    destinationChatId: 'crypto-futures-room',
    dedupeKey: 'brief:futures',
    now: new Date('2026-08-21T00:00:00.000Z'),
    snapshot,
  });
  assert.match(futures.details ?? '', /코인선물/);
  assert.match(futures.details ?? '', /코인선물 데이터 일부 확인 지연/);
  assert.doesNotMatch(futures.details ?? '', /FUTURES_PROVIDER_FAILURE|SPOT_PROVIDER_FAILURE|국내주식|해외주식|오늘의 테마\/주도주/);
});
