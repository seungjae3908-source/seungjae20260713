import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AUTH_KEY = 'sb-127-auth-token';
const NOW = '2026-09-06T09:40:00.000Z';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

const portfolio = {
  status: 'PARTIAL',
  asOf: NOW,
  totalAssets: { status: 'PARTIAL', normalizedKRW: null, knownNormalizedKRW: 1_250_000 },
  investmentPrincipal: { status: 'READY', normalizedKRW: 1_000_000, knownNormalizedKRW: 1_000_000 },
  valuationPnl: { status: 'READY', normalizedKRW: 250_000, returnPercent: 25 },
  cash: { status: 'UNAVAILABLE', totalKRW: null },
  minimumCashBuffer: { status: 'UNAVAILABLE', normalizedKRW: null },
  investableCash: { status: 'UNAVAILABLE', normalizedKRW: null },
  assets: { krStocks: 1_250_000, usStocks: null, cryptoSpot: null, cryptoFuturesEquity: null, cash: null },
  allocation: { status: 'PARTIAL', knownTotalKRW: 1_250_000, buckets: { KR_STOCK: 100, US_STOCK: null, CRYPTO: null } },
  holdings: [{ id: 'h1', ticker: '005930', name: '삼성전자', market: 'KR', currency: 'KRW', quantity: 10, averagePrice: 100_000, currentPrice: 125_000, nativeValue: 1_250_000, normalizedKRW: 1_250_000 }],
  topHoldings: [{ id: 'h1', ticker: '005930', name: '삼성전자', market: 'KR', currency: 'KRW', quantity: 10, averagePrice: 100_000, currentPrice: 125_000, nativeValue: 1_250_000, normalizedKRW: 1_250_000 }],
  top5Concentration: { status: 'READY', percent: 100 },
  correlation: { status: 'UNAVAILABLE', sampleSize: 0, correlation: null, pair: [] },
  riskClassification: { status: 'PARTIAL', level: null, reason: '일부 계좌 근거가 없어 위험 분류가 제한됩니다.' },
  allocationPolicy: { profile: 'BALANCED', status: 'PARTIAL', comparison: [{ assetClass: 'KR_STOCK', currentPercent: 100, minPercent: 20, maxPercent: 60, state: 'OUTSIDE_RANGE' }] },
  fx: { status: 'UNAVAILABLE', quotes: [] },
  dataQuality: { status: 'PARTIAL', providerCount: 3, includedProviderCount: 1, invalidHoldingRows: 0 },
  missingSources: ['READONLY_CASH_SOURCE_UNAVAILABLE', 'CORRELATION:HISTORY_UNAVAILABLE'],
};

async function installRuntime(page: Page) {
  await page.addInitScript(({ authKey, user, now }) => {
    const encode = (value: Record<string, unknown>) => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    localStorage.setItem(authKey, JSON.stringify({
      access_token: `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: user, role: 'authenticated', exp: expiresAt })}.e2e`,
      refresh_token: 'portfolio-professional-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: { id: user, aud: 'authenticated', role: 'authenticated', email: 'portfolio-professional@accounts.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: '포트폴리오 QA' }, identities: [], created_at: now },
    }));
  }, { authKey: AUTH_KEY, user: USER, now: NOW });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) return fulfill(route, { id: USER, login_name: 'portfolio-professional', display_name: '포트폴리오 QA', role: 'admin', status: 'approved', membership_level: 'admin', is_active: true, permissions_updated_at: NOW, updated_at: NOW });
    if (pathname.endsWith('/auth/v1/user')) return fulfill(route, { id: USER, aud: 'authenticated', role: 'authenticated', email: 'portfolio-professional@accounts.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: '포트폴리오 QA' }, identities: [], created_at: NOW });
    if (pathname.includes('/rest/v1/portfolio_holdings')) return fulfill(route, []);
    if (pathname.includes('/rest/v1/')) return fulfill(route, []);
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/portfolio/intelligence') return fulfill(route, { ok: true, portfolio });
    if (url.pathname === '/api/portfolio/intelligence/monthly-contribution') return fulfill(route, {
      ok: true,
      status: 'READY',
      assumption: 'NO_VALIDATED_RETURN_ASSUMPTION',
      allocationBasis: 'CURRENT_KNOWN_ALLOCATION',
      allocationKnownTotalKRW: 1_250_000,
      profileForPolicyComparison: 'BALANCED',
      profileUsedForAllocation: false,
      unavailableOutputs: [],
      plan: { monthlyAmountKRW: 300_000, months: 12, cumulativeInvestmentKRW: 3_600_000, allocations: [{ key: 'KR_STOCK', weight: 1, cumulativeContributionKRW: 3_600_000 }] },
    });
    if (url.pathname === '/api/portfolio/intelligence/additional-buy') return fulfill(route, {
      ok: true,
      status: 'READY',
      priceBasis: 'NORMALIZED_KRW',
      holding: { ticker: '005930', name: '삼성전자', market: 'KR', nativeCurrency: 'KRW', currentAveragePriceNative: 100_000, currentPriceNative: 125_000, currentPositionValueKRW: 1_250_000 },
      result: { status: 'UNAVAILABLE', additionalQuantity: null, additionalInvestmentKRW: 100_000, newAveragePrice: null, currentWeightPercent: 100, projectedWeightPercent: null, stopLoss: null, targets: [], estimatedMaxLossKRW: null, targetProfitsKRW: [], missing: ['PRICE_PLAN_MISSING'] },
      evidence: { stopLoss: 'UNAVAILABLE', targets: 'UNAVAILABLE', source: null },
    });
    return fulfill(route, { ok: true, items: [], rows: [], results: [], alerts: [], notifications: [], diagnosis: null });
  });
}

test('portfolio source uses user-facing missing labels while retaining raw evidence in details', () => {
  const page = source('src/pages/portfolio-v2.tsx');
  expect(page).toContain("? '미확인'");
  expect(page).toContain('title={value}');
  expect(page).toContain('계산 근거 상세');
  expect(page).toContain('CURRENT_KNOWN_ALLOCATION');
  expect(page).toContain('NO_VALIDATED_RETURN_ASSUMPTION');
  expect(page).toContain('NORMALIZED_KRW');
  expect(page).toContain('미래 수익을 예측하지 않습니다.');
  expect(page).toContain('testId="portfolio-v2-tabs"');
});

for (const width of [320, 390, 768, 1200]) {
  test(`portfolio professional surface remains bounded at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width >= 1200 ? 900 : 844 });
    await installRuntime(page);
    await page.goto('/portfolio');

    await expect(page.getByRole('heading', { name: '포트폴리오', exact: true })).toBeVisible();
    await expect(page.getByTestId('portfolio-v2-tabs')).toBeVisible();
    await expect(page.getByRole('heading', { name: '자산 인텔리전스', exact: true })).toBeVisible();
    await expect(page.getByTestId('portfolio-known-total')).toContainText('1,250,000원');
    await expect(page.getByText('미확인', { exact: true }).first()).toBeVisible();

    const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
  });
}

test('portfolio hides internal calculation contract names until the user opens evidence detail', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installRuntime(page);
  await page.goto('/portfolio');

  await expect(page.getByText('NO_VALIDATED_RETURN_ASSUMPTION', { exact: false })).toBeHidden();
  await expect(page.getByText('CURRENT_KNOWN_ALLOCATION', { exact: false })).toBeHidden();
  await expect(page.getByText('NORMALIZED_KRW', { exact: false })).toBeHidden();
  await expect(page.getByText('미래 수익을 예측하지 않습니다.', { exact: true })).toBeVisible();

  const monthly = page.getByTestId('portfolio-monthly-basis');
  await monthly.getByText('계산 근거 상세', { exact: true }).click();
  await expect(monthly.getByText('CURRENT_KNOWN_ALLOCATION', { exact: false })).toBeVisible();
  await expect(monthly.getByText('NO_VALIDATED_RETURN_ASSUMPTION', { exact: false })).toBeVisible();
});

test('portfolio shared tabs preserve holdings and journal navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installRuntime(page);
  await page.goto('/portfolio');
  await page.getByRole('tab', { name: '보유자산', exact: true }).click();
  await expect(page).toHaveURL(/\/portfolio\?tab=holdings$/);
  await page.getByRole('tab', { name: '매매일지', exact: true }).click();
  await expect(page).toHaveURL(/\/portfolio\?tab=journal$/);
});
