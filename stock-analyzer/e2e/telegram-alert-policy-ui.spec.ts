import { expect, test, type Page, type Route } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

const panel = source('src/components/user-broker-telegram-panel.tsx');
const route = source('../api-server/src/routes/user-broker-telegram.ts');
const testMessageService = source('../api-server/src/services/telegram-test-message.service.ts');

const E2E_USER_ID = '73737373-7373-4737-8737-737373737373';
const E2E_NOW = '2026-08-30T00:00:00.000Z';
const AUTH_STORAGE_KEY = 'sb-127-auth-token';

function fulfill(routeHandler: Route, body: unknown, status = 200) {
  return routeHandler.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

async function installTelegramButtonRuntime(page: Page) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'telegram-button-e2e-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'telegram-buttons@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Telegram Button Member' },
        identities: [],
        created_at: now,
      },
    }));
  }, { storageKey: AUTH_STORAGE_KEY, userId: E2E_USER_ID, now: E2E_NOW });

  let connected = false;
  let linkRequests = 0;
  let testRequests = 0;
  let integrationReads = 0;
  const unexpectedMutations: string[] = [];

  await page.route('**/__e2e-supabase/**', async (routeHandler) => {
    const request = routeHandler.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(routeHandler, {
        id: E2E_USER_ID,
        login_name: 'telegram-button-member',
        display_name: 'Telegram Button Member',
        role: 'full',
        status: 'approved',
        membership_level: 'regular',
        is_active: true,
        permissions_updated_at: E2E_NOW,
        updated_at: E2E_NOW,
      });
    }
    if (pathname.endsWith('/auth/v1/user')) {
      return fulfill(routeHandler, {
        id: E2E_USER_ID,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'telegram-buttons@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Telegram Button Member' },
        identities: [],
        created_at: E2E_NOW,
      });
    }
    return fulfill(routeHandler, { ok: true });
  });

  await page.route('**/api/**', async (routeHandler) => {
    const request = routeHandler.request();
    const url = new URL(request.url());
    const requestPath = url.pathname;
    const method = request.method();

    if (requestPath === '/api/user-integrations' && method === 'GET') {
      integrationReads += 1;
      return fulfill(routeHandler, {
        ok: true,
        brokerConnections: [],
        telegram: {
          connected,
          status: connected ? 'ACTIVE' : 'DISCONNECTED',
          connectedAt: connected ? E2E_NOW : null,
        },
        preferences: {},
        alertPolicy: { userId: E2E_USER_ID, enabled: false },
        alertPolicySource: 'DEFAULT_MISSING',
        alertPolicyStorageAvailable: true,
        telegramRuntime: {
          deliveryReady: true,
          linkingReady: true,
          webhookConfigured: true,
          botUsernameConfigured: true,
          stockRoomReady: false,
          cryptoRoomReady: false,
          richSignalEnabled: false,
          aiExplanationEnabled: false,
          signalFollowupEnabled: false,
          memberHoldingsEnabled: false,
          orderAuthority: 'NONE',
          privateTradingApiAllowed: false,
          realOrderAllowed: false,
        },
        privateApiRequests: 0,
        ordersSubmitted: 0,
        ordersCancelled: 0,
      });
    }

    if (requestPath === '/api/user-integrations/telegram/link' && method === 'POST') {
      linkRequests += 1;
      return fulfill(routeHandler, {
        ok: true,
        deepLink: 'https://t.me/InvestmentTestBot?start=safe-e2e-token',
        expiresAt: '2026-08-30T00:10:00.000Z',
      }, 201);
    }

    if (requestPath === '/api/user-integrations/telegram/test' && method === 'POST') {
      testRequests += 1;
      return fulfill(routeHandler, {
        ok: true,
        status: 'SENT',
        attempts: 1,
        investmentSignal: false,
        orderAuthority: 'NONE',
        privateApiRequests: 0,
        ordersSubmitted: 0,
        ordersCancelled: 0,
      });
    }

    if (method !== 'GET') unexpectedMutations.push(`${method} ${requestPath}`);
    return fulfill(routeHandler, { ok: true, items: [] });
  });

  return {
    connect() { connected = true; },
    counters() { return { linkRequests, testRequests, integrationReads }; },
    unexpectedMutations,
  };
}

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

test('personal Telegram link webhook accepts only the users private chat', () => {
  expect(route).toContain("const chatType = typeof chat?.type === 'string' ? chat.type : '';");
  expect(route).toContain("chatType !== 'private'");
  expect(route).toContain('chatId !== telegramUserId');
  expect(route).toContain('if (!payload)');
  expect(route).toContain('res.status(204).end()');
});

test('personal Telegram test endpoint preserves the route transport boundary and sends only explicit test content', () => {
  expect(route).toContain("userBrokerTelegramRouter.post('/telegram/test'");
  expect(route).toContain('sendPersonalTelegramTestMessage(userId)');
  expect(route).not.toContain('sendTelegramAlert(');

  expect(testMessageService).toContain("connection.status !== 'ACTIVE'");
  expect(testMessageService).toContain("error: 'TELEGRAM_NOT_CONNECTED'");
  expect(testMessageService).toContain("const TEST_MESSAGE = '[TEST] Telegram 연결 확인 메시지입니다. 투자 신호가 아니며 실제 주문/체결이 아닙니다.'");
  expect(testMessageService).toContain('destinationChatId: connection.telegramChatId');
  expect(testMessageService).toContain('duplicateWindowMs: 0');
  expect(testMessageService).toContain('cooldownMs: 0');
  expect(testMessageService).toContain('investmentSignal: false');
  expect(testMessageService).toContain("orderAuthority: 'NONE'");
  expect(testMessageService).toContain('privateApiRequests: 0');
  expect(testMessageService).toContain('ordersSubmitted: 0');
  expect(testMessageService).toContain('ordersCancelled: 0');
  expect(testMessageService).not.toContain('ordersSubmitted: 1');

  expect(panel).toContain("'/api/user-integrations/telegram/test'");
  expect(panel).toContain('테스트 메시지 보내기');
  expect(panel).toContain('테스트 전송 중…');
  expect(panel).toContain('테스트 메시지는 투자 신호나 주문이 아닙니다.');
  expect(panel).toContain('disabled={!state.telegram.connected || !state.telegramRuntime.deliveryReady || testSending}');
  expect(panel).toContain('if (!state?.telegram.connected || !state.telegramRuntime.deliveryReady || testSending) return;');
});

test('actual Account UI clicks Telegram link on mobile and test-message on desktop through the exact safe endpoints', async ({ page }) => {
  const runtime = await installTelegramButtonRuntime(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/account');
  const integrationPanel = page.getByTestId('user-broker-telegram-panel');
  await expect(integrationPanel).toHaveAttribute('data-user-integrations-request-state', 'success');
  await expect(integrationPanel).toContainText('연결 안 됨');

  await page.getByRole('button', { name: 'Telegram 연결', exact: true }).click();
  await expect.poll(() => runtime.counters().linkRequests).toBe(1);
  await expect(page.getByRole('link', { name: 'Telegram에서 연결 완료' }))
    .toHaveAttribute('href', 'https://t.me/InvestmentTestBot?start=safe-e2e-token');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);

  runtime.connect();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: '연결 상태 새로고침' }).click();
  await expect(integrationPanel).toContainText('연결됨 · ACTIVE');
  const testButton = page.getByRole('button', { name: '테스트 메시지 보내기' });
  await expect(testButton).toBeEnabled();
  await testButton.click();
  await expect.poll(() => runtime.counters().testRequests).toBe(1);
  await expect(integrationPanel.getByRole('status')).toContainText('Telegram 테스트 메시지 전송 완료 · 1회 시도');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1441);

  expect(runtime.counters().integrationReads).toBeGreaterThanOrEqual(2);
  expect(runtime.unexpectedMutations).toEqual([]);
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
