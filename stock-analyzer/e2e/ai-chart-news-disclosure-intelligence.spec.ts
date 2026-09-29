import { expect, test, type Page, type Route } from '@playwright/test';

const E2E_USER_ID = '44444444-4444-4444-8444-444444444444';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';
const NOW = '2026-08-27T02:00:00.000Z';

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

async function installSession(page: Page) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'e2e-refresh-token',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'market-intelligence@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Market Intelligence E2E' },
        identities: [],
        created_at: now,
      },
    }));
  }, { storageKey: E2E_AUTH_STORAGE_KEY, userId: E2E_USER_ID, now: NOW });
}

function intelligencePayload() {
  return {
    ok: true,
    available: true,
    cache: 'MISS',
    chartPolicy: {
      evidenceOnly: true,
      scoreImpact: 0,
      probabilityImpact: 0,
      sentimentIsPriceDirection: false,
      executionAuthority: 'NONE',
      orderAllowed: false,
      maxAiEvents: 1,
      serverCacheTtlMs: 60_000,
    },
    result: {
      contract: 'StockNewsDisclosureIntelligenceV1',
      status: 'READY',
      ticker: '005930',
      market: 'KR',
      collectedAt: NOW,
      sourceStatus: { news: 'READY', filings: 'READY' },
      budget: {
        maxEvents: 5,
        maxAiEvents: 1,
        routedEvents: 1,
        aiEligibleEvents: 1,
        aiAttemptedEvents: 1,
        aiDeferredEvents: 0,
      },
      warnings: [],
      safety: {
        publicEvidenceOnly: true,
        generatedFactsAllowed: false,
        executionAuthority: 'NONE',
        orderAllowed: false,
      },
      events: [{
        kind: 'DISCLOSURE',
        headline: '단일판매 공급계약 체결',
        sourceName: 'DART',
        sourceUrl: 'https://dart.example.invalid/disclosure/1',
        publishedAt: NOW,
        state: 'ANALYZED',
        reason: null,
        route: {
          status: 'READY',
          freshness: { state: 'FRESH', ageMs: 1_000, reason: null },
          event: {
            eventType: 'CONTRACT',
            evidence: {
              facts: ['DART 공시 확인'],
              uncertainty: ['시장 가격 영향은 아직 검증되지 않음'],
            },
          },
          safety: {
            executionAuthority: 'NONE',
            orderAllowed: false,
            sentimentIsPriceDirection: false,
            fabricatedEvidenceAllowed: false,
          },
        },
        ai: {
          status: 'ANALYZED',
          reason: null,
          model: 'mock-public-ai',
          analysis: {
            summaryShort: '공급계약 체결 사실이 공식 공시에서 확인됐습니다.',
            sentiment: 'NEUTRAL',
            importanceScore: 80,
            confidenceScore: 85,
            impactHorizon: 'SWING',
            inferences: [],
            uncertainty: ['실제 매출 인식 시점은 추가 확인 필요'],
            riskFlags: ['계약 이행 리스크'],
            catalystFlags: ['계약 매출 가능성'],
          },
        },
      }],
    },
  };
}

async function installMocks(page: Page, onIntelligenceRequest: () => void) {
  await installSession(page);
  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: E2E_USER_ID,
        login_name: 'market-intelligence',
        display_name: 'Market Intelligence E2E',
        role: 'admin',
        status: 'approved',
        membership_level: 'admin',
        is_active: true,
        permissions_updated_at: NOW,
        updated_at: NOW,
      });
    }
    if (pathname.endsWith('/auth/v1/user')) {
      return fulfill(route, {
        id: E2E_USER_ID,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'market-intelligence@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Market Intelligence E2E' },
        identities: [],
        created_at: NOW,
      });
    }
    return fulfill(route, { ok: true, items: [], results: [] });
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/market-intelligence/news-disclosure') {
      onIntelligenceRequest();
      return fulfill(route, intelligencePayload());
    }
    return fulfill(route, {
      ok: true,
      items: [],
      results: [],
      candles: [],
      normalization: { candles: [], warnings: [] },
    });
  });
}

test('KR AI Chart shows verified news/disclosure evidence without re-requesting it on timeframe change', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let intelligenceRequests = 0;
  await installMocks(page, () => { intelligenceRequests += 1; });

  await page.goto('/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m');
  await expect(page.getByRole('heading', { name: 'AI 차트' })).toBeVisible();

  const panel = page.getByTestId('ai-chart-market-intelligence-evidence');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('ai-chart-market-intelligence-state')).toHaveText('READY');
  await expect(panel).toContainText('DART');
  await expect(panel).toContainText('단일판매 공급계약 체결');
  await expect(panel).toContainText('중요도 80/100');
  await expect(panel).toContainText('AI 신뢰 85/100');
  await expect(panel).toContainText('계약 이행 리스크');
  await expect(panel).toContainText('계약 매출 가능성');
  await expect(panel).toContainText('점수 영향 0');
  await expect(panel).toContainText('확률 영향 0');
  await expect(panel).toContainText('실행권한 NONE');
  expect(intelligenceRequests).toBe(1);

  await page.getByTestId('timeframe-1H').click();
  await expect(page.locator('header')).toContainText('1H');
  await expect(panel.getByTestId('ai-chart-market-intelligence-state')).toHaveText('READY');
  expect(intelligenceRequests).toBe(1);
});

test('crypto AI Chart remains explicitly not connected and makes zero news/disclosure intelligence requests', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let intelligenceRequests = 0;
  await installMocks(page, () => { intelligenceRequests += 1; });

  await page.goto('/ai-chart?assetType=coin_futures&market=BITGET&symbol=BTCUSDT&ticker=BTCUSDT&name=BTCUSDT&timeframe=5m');
  await expect(page.getByRole('heading', { name: 'AI 차트' })).toBeVisible();
  const panel = page.getByTestId('ai-chart-market-intelligence-evidence');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('ai-chart-market-intelligence-state')).toHaveText('NOT CONNECTED');
  await expect(panel).toContainText('아직 이 패널에 연결되지 않았습니다');
  expect(intelligenceRequests).toBe(0);
});
