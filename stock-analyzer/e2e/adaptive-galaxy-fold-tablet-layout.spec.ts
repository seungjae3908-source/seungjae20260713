import { expect, test, type Page, type Route } from '@playwright/test';

const E2E_USER_ID = '44444444-4444-4444-8444-444444444444';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';
const NOW = '2026-08-24T10:30:00.000Z';

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
        email: 'adaptive-ui@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '반응형 UI 관리자' },
        identities: [],
        created_at: now,
      },
    }));
  }, { storageKey: E2E_AUTH_STORAGE_KEY, userId: E2E_USER_ID, now: NOW });
}

async function installMocks(page: Page) {
  await installSession(page);
  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: E2E_USER_ID,
        login_name: 'adaptive-ui',
        display_name: '반응형 UI 관리자',
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
        email: 'adaptive-ui@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '반응형 UI 관리자' },
        identities: [],
        created_at: NOW,
      });
    }
    return fulfill(route, { ok: true, items: [], results: [] });
  });
  await page.route('**/api/**', async (route) => fulfill(route, {
    ok: true,
    items: [],
    results: [],
    alerts: [],
    notifications: [],
  }));
}

const GEOMETRIES = [
  { width: 320, height: 740, viewport: 'compact', builder: 'mobile' },
  { width: 344, height: 882, viewport: 'compact', builder: 'mobile' },
  { width: 360, height: 800, viewport: 'phone', builder: 'mobile' },
  { width: 390, height: 844, viewport: 'phone', builder: 'mobile' },
  { width: 412, height: 915, viewport: 'phone', builder: 'mobile' },
  { width: 430, height: 932, viewport: 'phone', builder: 'mobile' },
  { width: 600, height: 960, viewport: 'medium', builder: 'mobile' },
  { width: 720, height: 1080, viewport: 'medium', builder: 'mobile' },
  { width: 768, height: 1024, viewport: 'medium', builder: 'mobile' },
  { width: 800, height: 1280, viewport: 'medium', builder: 'mobile' },
  { width: 900, height: 1280, viewport: 'tablet', builder: 'mobile' },
  { width: 1024, height: 768, viewport: 'tablet', builder: 'mobile' },
  { width: 1180, height: 820, viewport: 'tablet', builder: 'mobile' },
  { width: 1200, height: 800, viewport: 'desktop', builder: 'desktop' },
  { width: 1440, height: 900, viewport: 'desktop', builder: 'desktop' },
] as const;

const LANDSCAPES = [
  { width: 740, height: 320, viewport: 'medium' },
  { width: 844, height: 390, viewport: 'medium' },
  { width: 915, height: 412, viewport: 'tablet' },
  { width: 960, height: 540, viewport: 'tablet' },
  { width: 1024, height: 600, viewport: 'tablet' },
] as const;

test('layout adapts across phone, fold-open, tablet and desktop widths without reload or overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMocks(page);
  await page.goto('/more');

  const runtime = page.getByTestId('ui-builder-runtime-settings');
  const nav = page.getByRole('navigation', { name: '주요 메뉴' });
  await expect(runtime).toBeVisible();
  await expect(nav).toBeVisible();

  for (const geometry of GEOMETRIES) {
    await page.setViewportSize({ width: geometry.width, height: geometry.height });
    await expect(runtime).toHaveAttribute('data-adaptive-viewport', geometry.viewport);
    await expect(runtime).toHaveAttribute('data-builder-device', geometry.builder);

    const audit = await page.evaluate(() => {
      const viewportWidth = window.innerWidth;
      const navElement = document.querySelector('nav[aria-label="주요 메뉴"]');
      const buttons = navElement ? Array.from(navElement.querySelectorAll('button')) : [];
      const visibleButtons = buttons.filter((button) => {
        const style = getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      });
      return {
        viewportWidth,
        rootWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        navRect: navElement?.getBoundingClientRect().toJSON() ?? null,
        buttons: visibleButtons.map((button) => button.getBoundingClientRect().toJSON()),
      };
    });

    expect(audit.rootWidth, `${geometry.width}px root overflow`).toBeLessThanOrEqual(audit.viewportWidth + 2);
    expect(audit.bodyWidth, `${geometry.width}px body overflow`).toBeLessThanOrEqual(audit.viewportWidth + 2);
    expect(audit.navRect, `${geometry.width}px nav missing`).not.toBeNull();
    expect(audit.navRect!.left).toBeGreaterThanOrEqual(-1);
    expect(audit.navRect!.right).toBeLessThanOrEqual(audit.viewportWidth + 1);
    expect(audit.buttons.length).toBeGreaterThan(0);
    for (const rect of audit.buttons) {
      expect(rect.left, `${geometry.width}px button clips left`).toBeGreaterThanOrEqual(-1);
      expect(rect.right, `${geometry.width}px button clips right`).toBeLessThanOrEqual(audit.viewportWidth + 1);
      expect(rect.height, `${geometry.width}px touch target too short`).toBeGreaterThanOrEqual(43);
    }
  }
});

test('bottom navigation menu remains inside every required short landscape viewport without reload', async ({ page }) => {
  await page.setViewportSize({ width: 740, height: 320 });
  await installMocks(page);
  await page.goto('/more');

  const runtime = page.getByTestId('ui-builder-runtime-settings');
  const nav = page.getByRole('navigation', { name: '주요 메뉴' });
  await expect(nav).toBeVisible();
  const technical = nav.getByRole('button', { name: '기술' });

  for (const geometry of LANDSCAPES) {
    await page.setViewportSize({ width: geometry.width, height: geometry.height });
    await expect(runtime).toHaveAttribute('data-adaptive-viewport', geometry.viewport);
    await expect(runtime).toHaveAttribute('data-builder-device', 'mobile');

    if (await page.getByRole('menu', { name: '기술 메뉴' }).isVisible().catch(() => false)) {
      await page.keyboard.press('Escape');
    }
    await technical.click();
    const menu = page.getByRole('menu', { name: '기술 메뉴' });
    await expect(menu).toBeVisible();

    const rect = await menu.boundingBox();
    expect(rect, `${geometry.width}x${geometry.height} menu missing`).not.toBeNull();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(geometry.width);
    expect(rect!.y).toBeGreaterThanOrEqual(0);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(geometry.height);
    await page.keyboard.press('Escape');
  }
});

test('home keeps the touch tab composition through 1199px and switches at 1200px without reload', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await installMocks(page);
  await page.goto('/');

  const tabs = page.getByTestId('home-mobile-tabs');
  await expect(tabs).toBeVisible();
  await expect(tabs).toHaveCSS('display', 'flex');

  await page.setViewportSize({ width: 1180, height: 820 });
  await expect(tabs).toBeVisible();
  await expect(tabs).toHaveCSS('display', 'flex');

  await page.setViewportSize({ width: 1200, height: 800 });
  await expect(page.getByTestId('home-mobile-tabs')).toHaveCount(0);
  await expect(page.getByTestId('home-market-summary')).toBeVisible();
  await expect(page.getByTestId('home-signal-summary')).toBeVisible();
});
