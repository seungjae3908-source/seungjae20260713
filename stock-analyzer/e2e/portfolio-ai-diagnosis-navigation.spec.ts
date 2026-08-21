import { test, expect, type Page, type Route } from '@playwright/test';

const NOW = '2026-08-21T05:55:00.000Z';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const AUTH_STORAGE_KEY = 'sb-127-auth-token';

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

async function installApprovedRuntime(page: Page) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'portfolio-ai-e2e-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'portfolio-ai@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '포트폴리오 AI 검증 관리자' },
        identities: [],
        created_at: now,
      },
    }));
  }, { storageKey: AUTH_STORAGE_KEY, userId: USER_ID, now: NOW });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: USER_ID,
        login_name: 'portfolio-ai-admin',
        display_name: '포트폴리오 AI 검증 관리자',
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
        id: USER_ID,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'portfolio-ai@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '포트폴리오 AI 검증 관리자' },
        identities: [],
        created_at: NOW,
      });
    }
    return fulfill(route, { ok: true });
  });
}

const portfolioFixture = {
  ok: true,
  portfolio: {
    status: 'PARTIAL',
    asOf: NOW,
    totalAssets: { status: 'READY', normalizedKRW: 4_820_000, knownNormalizedKRW: 4_820_000 },
    investmentPrincipal: { status: 'READY', normalizedKRW: 4_500_000, knownNormalizedKRW: 4_500_000 },
    valuationPnl: { status: 'READY', normalizedKRW: 320_000, returnPercent: 7.1 },
    cash: { status: 'READY', totalKRW: 820_000 },
    minimumCashBuffer: { status: 'READY', normalizedKRW: 500_000 },
    investableCash: { status: 'READY', normalizedKRW: 320_000 },
    assets: { krStocks: 1_500_000, usStocks: 2_000_000, cryptoSpot: 500_000, cryptoFuturesEquity: null, cash: 820_000 },
    allocation: { status: 'PARTIAL', knownTotalKRW: 4_820_000, buckets: { KR_STOCK: 31.1, US_STOCK: 41.5, CRYPTO_SPOT: 10.4, CASH: 17.0 } },
    holdings: [{ id: 'nvda', ticker: 'NVDA', name: 'NVIDIA', market: 'US', currency: 'USD', quantity: 1, averagePrice: 150, currentPrice: 160, nativeValue: 160, normalizedKRW: 220_000 }],
    topHoldings: [{ id: 'nvda', ticker: 'NVDA', name: 'NVIDIA', market: 'US', currency: 'USD', quantity: 1, averagePrice: 150, currentPrice: 160, nativeValue: 160, normalizedKRW: 220_000 }],
    top5Concentration: { status: 'READY', percent: 45.6 },
    correlation: { status: 'INSUFFICIENT_SAMPLE', sampleSize: 8, correlation: null, pair: ['NVDA', 'BTCUSDT'] },
    riskClassification: { status: 'READY', level: 'MEDIUM', reason: 'fixture' },
    allocationPolicy: { profile: 'BALANCED', status: 'PARTIAL', comparison: [{ assetClass: 'US_STOCK', currentPercent: 41.5, minPercent: 20, maxPercent: 45, state: 'IN_RANGE' }] },
    fx: { status: 'READY', quotes: [{ rate: 1375, pair: 'USD/KRW', source: 'fixture', asOf: NOW, quality: 'FRESH' }] },
    missingSources: ['crypto futures equity'],
  },
};

test('Information Hub 포트폴리오는 본진 AI 진단으로 연결되고 진단은 읽기 전용이다', async ({ page }) => {
  await installApprovedRuntime(page);

  const orderLikeRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (/\/(orders?|cancel|withdraw|transfer)(?:\/|$)/i.test(url.pathname)) {
      orderLikeRequests.push(`${request.method()} ${url.pathname}`);
    }
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/portfolio/intelligence') {
      return fulfill(route, portfolioFixture);
    }
    if (url.pathname === '/api/paper-journal/portfolio-advisor/query') {
      expect(route.request().method()).toBe('POST');
      const body = route.request().postDataJSON() as { message?: string };
      expect(body.message).toBeTruthy();
      return fulfill(route, {
        result: {
          ai: { answer: '서버 canonical facts 기준으로 집중 위험과 누락 데이터를 설명했습니다.' },
          assistantContext: {
            dataQuality: 'PARTIAL',
            asOf: NOW,
            evidence: [{ source: 'portfolio-intelligence-v2' }],
            warnings: ['crypto futures equity unavailable'],
            facts: { totalAssetsKRW: 4_820_000, top5ConcentrationPercent: 45.6 },
          },
          safety: { readOnly: true, orderAuthority: 'none', exchangeRequestSent: false },
        },
      });
    }
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });

  await page.goto('/ai-chat');
  await expect(page.getByRole('heading', { name: 'Information Hub' })).toBeVisible();
  await page.getByRole('button', { name: 'Portfolio' }).click();
  await expect(page.getByTestId('information-portfolio-ai-shortcut')).toContainText('포트폴리오 AI 진단');
  await page.getByRole('button', { name: '내 포트폴리오 분석 열기' }).click();

  await expect(page).toHaveURL(/\/portfolio\?focus=ai$/);
  const diagnosis = page.getByTestId('portfolio-ai-diagnosis');
  await expect(diagnosis).toBeVisible();
  await expect(diagnosis).toContainText('Gemini Free → Groq Free');
  await expect(diagnosis).toContainText('금액·수익률·위험 수치를 새로 만들거나 주문을 실행하지 않습니다.');

  await diagnosis.getByRole('button', { name: 'AI 진단' }).click();
  await expect(page.getByTestId('portfolio-ai-diagnosis-result')).toContainText('canonical facts');
  await expect(page.getByTestId('portfolio-ai-diagnosis-result')).toContainText('PARTIAL');
  await expect(page.getByTestId('portfolio-ai-diagnosis-result')).toContainText('읽기 전용 · 주문 권한 없음');
  expect(orderLikeRequests).toEqual([]);
});
