import { expect, test, type Page, type Route } from '@playwright/test';

const NOW = '2026-08-19T04:30:00.000Z';
const E2E_USER_ID = '22222222-2222-4222-8222-222222222222';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';

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
      refresh_token: 'e2e-home-touch-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'home-touch@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '홈 터치 검증 관리자' },
        identities: [],
        created_at: now,
      },
    }));
  }, { storageKey: E2E_AUTH_STORAGE_KEY, userId: E2E_USER_ID, now: NOW });

  const diagnostics = {
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
    unexpectedHttp: [] as string[],
  };
  page.on('console', (message) => { if (message.type() === 'error') diagnostics.consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) diagnostics.unexpectedHttp.push(`${response.status()} ${response.url()}`);
  });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: E2E_USER_ID,
        login_name: 'home-touch-admin',
        display_name: '홈 터치 검증 관리자',
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
        email: 'home-touch@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '홈 터치 검증 관리자' },
        identities: [],
        created_at: NOW,
      });
    }
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/crypto/spot/tickers') {
      return fulfill(route, { ok: true, tickers: [] });
    }
    return fulfill(route, {
      ok: true,
      items: [],
      rows: [],
      results: [],
      quotes: [],
      cards: [],
      alerts: [],
      markets: [],
      tickers: [],
      dataState: 'ready',
    });
  });

  return () => {
    expect(diagnostics.consoleErrors, diagnostics.consoleErrors.join('\n')).toEqual([]);
    expect(diagnostics.pageErrors, diagnostics.pageErrors.join('\n')).toEqual([]);
    expect(diagnostics.unexpectedHttp, diagnostics.unexpectedHttp.join('\n')).toEqual([]);
  };
}

async function expectTouchTarget(page: Page, label: string, width: number) {
  const button = page.getByRole('button', { name: label, exact: true });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box?.height ?? 0, `${width}px ${label}`).toBeGreaterThanOrEqual(44);
  expect(box?.width ?? 0, `${width}px ${label}`).toBeGreaterThanOrEqual(28);
}

for (const width of [390, 1440]) {
  test(`home summary text actions keep 44px touch targets at ${width}px`, async ({ page }) => {
    const assertClean = await installApprovedRuntime(page);
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    await page.goto('/home');

    if (width < 1024) {
      const tabs = page.getByTestId('home-mobile-tabs');
      await expect(tabs).toBeVisible();
      for (const label of ['시장', '신호', '관심', '자산']) {
        await expectTouchTarget(page, label, width);
      }

      await expect(page.getByTestId('home-market-summary')).toBeVisible();
      await expectTouchTarget(page, '시황', width);

      await page.getByRole('tab', { name: '신호', exact: true }).click();
      await expect(page.getByTestId('home-signal-summary')).toBeVisible();
      await expectTouchTarget(page, '검색기', width);

      await page.getByRole('tab', { name: '관심', exact: true }).click();
      await expect(page.getByTestId('home-watchlist-summary')).toBeVisible();
      await expectTouchTarget(page, '전체', width);
    } else {
      await expect(page.getByTestId('home-mobile-tabs')).toHaveCount(0);
      await expect(page.getByTestId('home-market-summary')).toBeVisible();
      await expect(page.getByTestId('home-signal-summary')).toBeVisible();
      await expect(page.getByTestId('home-watchlist-summary')).toBeVisible();
      await expectTouchTarget(page, '시황', width);
      await expectTouchTarget(page, '검색기', width);
      await expectTouchTarget(page, '전체', width);
    }

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    assertClean();
  });
}