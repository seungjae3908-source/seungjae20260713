import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

const NOW = '2026-08-26T03:20:00.000Z';
const E2E_USER_ID = '22222222-2222-4222-8222-222222222229';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';

const technicalSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/pages/technical-workspace.tsx'),
  'utf8',
);
const recommendationsSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/pages/recommendations.tsx'),
  'utf8',
);

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

function recommendationRow(index: number) {
  return {
    ticker: `00${String(5930 + index).padStart(4, '0')}`,
    name: `검증 종목 ${index + 1}`,
    market: 'KR',
    currency: 'KRW',
    category: 'undervalued',
    categoryLabel: '저평가',
    price: 75_000 + index,
    changePercent: 0.5,
    reasons: ['실데이터 기반 검증 fixture'],
    usedData: ['public-fixture'],
    missingData: [],
    risks: [],
    overheated: false,
    financialStability: '확인',
    newsRisk: '낮음',
    riskLevel: 'LOW',
    shortTermOutlook: '중립',
    midTermOutlook: '중립',
    opinion: '관망',
    targetPrice: null,
    targetBasis: '검증 fixture',
    stopLoss: null,
    stopBasis: '검증 fixture',
    score: 60,
    generatedAt: NOW,
    dataUpdatedAt: NOW,
    providers: ['fixture'],
    dataQuality: 'sufficient',
  };
}

function zeroScannerResponse() {
  return {
    ok: true,
    requestId: 'mobile-layout-zero',
    assetClass: 'stock',
    market: 'KR',
    timeframe: '1D',
    cards: [],
    alerts: [],
    failures: [],
    execution: {
      requestedCount: 0,
      startedCount: 0,
      completedCount: 0,
      excludedCount: 0,
      providerErrorCount: 0,
      timeoutCount: 0,
      partial: false,
      timedOut: false,
      cancelled: false,
      duplicate: false,
      elapsedMs: 1,
      deadlineMs: 12_000,
      itemTimeoutMs: 3_500,
      maxConcurrency: 2,
      providerAcceptedCount: 0,
      dataSuccessCount: 0,
      insufficientDataCount: 0,
      filteredByStrategyCount: 0,
      hardFilterRejectedCount: 0,
      finalDisplayedCount: 0,
    },
    universe: {
      totalCount: 0,
      cursor: 0,
      nextCursor: null,
      source: 'fixture-public',
      partial: false,
      stale: false,
      listingStatusCoverage: 'listed-or-unknown',
    },
    dataState: 'complete',
    outcome: 'VALID_ZERO_SIGNAL',
    message: '현재 조건을 충족하는 신호가 없습니다.',
    generatedAt: NOW,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

async function installApprovedRuntime(page: Page, recommendationCount = 0) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'e2e-mobile-layout-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'mobile-layout@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '모바일 레이아웃 검증 관리자' },
        identities: [],
        created_at: now,
      },
    }));
  }, { storageKey: E2E_AUTH_STORAGE_KEY, userId: E2E_USER_ID, now: NOW });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: E2E_USER_ID,
        login_name: 'mobile-layout-admin',
        display_name: '모바일 레이아웃 검증 관리자',
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
        email: 'mobile-layout@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '모바일 레이아웃 검증 관리자' },
        identities: [],
        created_at: NOW,
      });
    }
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/market/recommendations') {
      return fulfill(route, {
        ok: true,
        provider: 'fixture',
        analysisMode: 'rules',
        aiConfigured: false,
        analysisDescription: '레이아웃 검증 fixture',
        market: 'KR',
        generatedAt: NOW,
        rows: Array.from({ length: recommendationCount }, (_, index) => recommendationRow(index)),
        excludedCount: 0,
        excludedBreakdown: {},
        dataQualityNote: '검증 fixture',
      });
    }
    if (url.pathname === '/api/market/scan') return fulfill(route, zeroScannerResponse());
    if (url.pathname.includes('/chart')) {
      return fulfill(route, { ticker: '005930', timeframe: '1D', provider: 'fixture', fetchedAt: NOW, candles: [] });
    }
    return fulfill(route, {
      ok: true,
      items: [],
      rows: [],
      results: [],
      cards: [],
      alerts: [],
      markets: [],
      tickers: [],
      dataState: 'ready',
    });
  });
}

async function navGeometry(page: Page) {
  const nav = page.getByRole('navigation', { name: '주요 메뉴' });
  await expect(nav).toBeVisible();
  const box = await nav.boundingBox();
  expect(box).not.toBeNull();
  const innerHeight = await page.evaluate(() => window.innerHeight);
  return { nav, box: box!, innerHeight };
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    body: document.body.scrollWidth,
    root: document.documentElement.scrollWidth,
  }));
  expect(overflow.body).toBeLessThanOrEqual(overflow.viewport);
  expect(overflow.root).toBeLessThanOrEqual(overflow.viewport);
}

test('mobile Technical workspace avoids the duplicated visual page title while preserving accessible title and help', () => {
  expect(technicalSource).toContain('className="sr-only sm:hidden" data-testid="technical-mobile-accessible-title"');
  expect(technicalSource).toContain('className="hidden sm:block" data-testid="technical-desktop-header"');
  expect(technicalSource).toContain('data-testid="technical-mobile-help"');
  expect(technicalSource).toContain('aria-label="기술 기능 안내 보기"');
  expect(technicalSource).toContain("{ value: 'signal', label: 'AI 검색기' }");
  expect(technicalSource).toContain("testId={desktop ? 'technical-desktop-tabs' : 'technical-mobile-tabs'}");
});

test('Technical workspace does not double-reserve BottomNav height', () => {
  expect(technicalSource).toContain('flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background');
  expect(technicalSource).toContain('className="min-h-0 min-w-0 flex-1 overflow-hidden"');
  expect(technicalSource).not.toContain('pb-[calc(5rem+env(safe-area-inset-bottom))]');
  expect(technicalSource).toContain('<BottomNav />');
});

test('AI recommendations keeps short content flexible and anchors BottomNav after the viewport-filling body', () => {
  expect(recommendationsSource).toContain('data-testid="recommendations-shell"');
  expect(recommendationsSource).toContain('flex h-full min-h-0 flex-col overflow-hidden bg-background');
  expect(recommendationsSource).toContain('data-testid="recommendations-scroll-content"');
  expect(recommendationsSource).toContain('min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 pt-4');
  expect(recommendationsSource).not.toContain('pb-28');
  expect(recommendationsSource).toContain('<BottomNav />');
});

test('390x844 Technical workspace keeps the visual title compact and BottomNav at the viewport floor', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApprovedRuntime(page);
  await page.goto('/__phase11-technical-workspace-e2e');

  const accessibleTitle = page.getByTestId('technical-mobile-accessible-title');
  await expect(accessibleTitle).toHaveText('AI 검색기');
  await expect(accessibleTitle).toHaveClass(/sr-only/);
  const titleBox = await accessibleTitle.boundingBox();
  expect(titleBox).not.toBeNull();
  expect(titleBox!.width).toBeLessThanOrEqual(1.1);
  expect(titleBox!.height).toBeLessThanOrEqual(1.1);

  const activeTab = page.getByRole('tab', { name: 'AI 검색기', exact: true });
  await expect(activeTab).toBeVisible();
  await expect(activeTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('technical-mobile-help')).toBeVisible();

  const panel = page.getByTestId('technical-mobile-panel-signal');
  await expect(panel).toBeVisible();
  const panelBox = await panel.boundingBox();
  const { box: navBox, innerHeight } = await navGeometry(page);
  expect(panelBox).not.toBeNull();
  expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(navBox.y + 1);
  expect(Math.abs(navBox.y + navBox.height - innerHeight)).toBeLessThanOrEqual(1);
  await expectNoHorizontalOverflow(page);
});

test('390x844 short AI recommendations keeps BottomNav on the viewport floor', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApprovedRuntime(page, 0);
  await page.goto('/recommendations');

  await expect(page.getByRole('heading', { name: 'AI 추천', level: 1 })).toBeVisible();
  const content = page.getByTestId('recommendations-scroll-content');
  await expect(content).toBeVisible();
  const contentBox = await content.boundingBox();
  const { box: navBox, innerHeight } = await navGeometry(page);
  expect(contentBox).not.toBeNull();
  expect(contentBox!.y + contentBox!.height).toBeLessThanOrEqual(navBox.y + 1);
  expect(Math.abs(navBox.y + navBox.height - innerHeight)).toBeLessThanOrEqual(1);
  expect(await content.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  await expectNoHorizontalOverflow(page);
});

test('390x844 long AI recommendations scrolls content without moving or overlapping BottomNav', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApprovedRuntime(page, 24);
  await page.goto('/recommendations');

  const content = page.getByTestId('recommendations-scroll-content');
  await expect(content).toBeVisible();
  expect(await content.evaluate((node) => node.scrollHeight > node.clientHeight + 1)).toBe(true);
  const before = await navGeometry(page);
  await content.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  const after = await navGeometry(page);
  expect(Math.abs(before.box.y + before.box.height - before.innerHeight)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.box.y + after.box.height - after.innerHeight)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.box.y - before.box.y)).toBeLessThanOrEqual(1);
  const contentBox = await content.boundingBox();
  expect(contentBox).not.toBeNull();
  expect(contentBox!.y + contentBox!.height).toBeLessThanOrEqual(after.box.y + 1);
  await expectNoHorizontalOverflow(page);
});

test('desktop Technical workspace keeps its normal visible page header', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await installApprovedRuntime(page);
  await page.goto('/__phase11-technical-workspace-e2e');

  await expect(page.getByTestId('technical-desktop-header')).toBeVisible();
  await expect(page.getByTestId('technical-mobile-accessible-title')).toBeHidden();
  await expect(page.getByTestId('technical-mobile-help')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'AI 검색기', level: 1 })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
