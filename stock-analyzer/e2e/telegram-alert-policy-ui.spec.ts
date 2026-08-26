import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

const panel = source('src/components/user-broker-telegram-panel.tsx');
const route = source('../api-server/src/routes/user-broker-telegram.ts');

test('Telegram settings center exposes the existing user-bound alert policy instead of inventing a second policy engine', () => {
  expect(panel).toContain("'/api/user-integrations/telegram-policy'");
  expect(panel).toContain("method: 'PATCH'");
  expect(panel).toContain('Telegram 투자 알림센터');
  expect(panel).toContain('투자 알림 전체');
  expect(panel).toContain('alertPolicyStorageAvailable');
  expect(panel).toContain('Telegram 개인 알림 저장소를 사용할 수 없어 설정 변경을 차단했습니다.');
});

test('Telegram settings center covers all canonical markets and scanner-facing signal classes', () => {
  for (const label of ['국내주식', '미국주식', '코인 현물', '코인 선물']) {
    expect(panel).toContain(label);
  }
  for (const signal of [
    "BUY: 'BUY'",
    "LONG: '선물 LONG'",
    "SHORT: '선물 SHORT'",
    "NO_TRADE: 'NO TRADE'",
    "PRICE_TARGET: '목표가'",
    "STRATEGY_HEALTH: '전략 상태'",
    "CHAMPION: 'Champion'",
    "RESEARCH: 'Research'",
    "SETTLEMENT: '정산 결과'",
    "PROVIDER_SERVER_ERROR: '데이터·서버 오류'",
  ]) {
    expect(panel).toContain(signal);
  }
});

test('Telegram settings center exposes urgency, quiet hours, digest and bounded duplicate controls', () => {
  for (const label of [
    '긴급', '중요', '일반',
    '지정 시간에는 일반 알림 끄기',
    '긴급은 허용',
    '즉시 받기',
    '모아서 받기',
    '모아보기 간격(분)',
    '같은 대상 쿨다운(분)',
    '같은 이벤트 차단(분)',
    '같은 종목 창(분)',
    '같은 종목 최대 횟수',
  ]) {
    expect(panel).toContain(label);
  }
  expect(panel).toContain("<option value=\"Asia/Seoul\">서울</option>");
  expect(panel).toContain("<option value=\"America/New_York\">뉴욕</option>");
  expect(panel).toContain("deliveryMode === 'BATCHED'");
  expect(panel).toContain('sameSymbolRepeatLimit');
});

test('personal Telegram runtime health is sanitized and visible without trading authority', () => {
  expect(route).toContain('function telegramRuntimeState()');
  expect(route).toContain('deliveryReady');
  expect(route).toContain('linkingReady');
  expect(route).toContain('stockRoomReady');
  expect(route).toContain('cryptoRoomReady');
  expect(route).toContain("orderAuthority: 'NONE' as const");
  expect(route).toContain('privateTradingApiAllowed: false as const');
  expect(route).toContain('realOrderAllowed: false as const');
  expect(route).not.toContain('TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN');
  expect(route).not.toContain('TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET');

  expect(panel).toContain('Telegram 서비스 상태');
  expect(panel).toContain('개인 전송');
  expect(panel).toContain('주식방');
  expect(panel).toContain('코인방');
  expect(panel).toContain('Rich 차트');
  expect(panel).toContain('AI 설명');
  expect(panel).toContain('신호 후속');
  expect(panel).toContain('보유종목 개인알림');
  expect(panel).toContain('상태에는 Secret·chat ID를 표시하지 않습니다.');
});

test('personal Telegram test endpoint sends explicit test-only content to the already linked member chat', () => {
  expect(route).toContain("userBrokerTelegramRouter.post('/telegram/test'");
  expect(route).toContain("connection.status !== 'ACTIVE'");
  expect(route).toContain("error: 'TELEGRAM_NOT_CONNECTED'");
  expect(route).toContain("details: '[TEST] Telegram 연결 확인 메시지입니다. 투자 신호가 아니며 실제 주문/체결이 아닙니다.'");
  expect(route).toContain('destinationChatId: connection.telegramChatId');
  expect(route).toContain('duplicateWindowMs: 0');
  expect(route).toContain('cooldownMs: 0');
  expect(route).toContain('investmentSignal: false');
  expect(route).toContain("orderAuthority: 'NONE'");
  expect(route).not.toContain('ordersSubmitted: 1');

  expect(panel).toContain("'/api/user-integrations/telegram/test'");
  expect(panel).toContain('테스트 메시지 보내기');
  expect(panel).toContain('테스트 전송 중…');
  expect(panel).toContain('테스트 메시지는 투자 신호나 주문이 아닙니다.');
});

test('Telegram settings remain responsive and do not add Telegram-side trade execution controls', () => {
  expect(panel).toContain('grid grid-cols-2 gap-2 sm:grid-cols-4');
  expect(panel).toContain('min-h-11');
  expect(panel).toContain('이 설정은 거래 판단이나 주문 권한을 바꾸지 않습니다.');
  expect(panel).not.toContain('callback_data');
  expect(panel).not.toContain('Telegram에서 매수');
  expect(panel).not.toContain('Telegram에서 매도');
  expect(panel).not.toContain('Telegram에서 LONG 진입');
  expect(panel).not.toContain('Telegram에서 SHORT 진입');
});
