import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

const NOW = '2026-09-06T08:30:00.000Z';
const E2E_USER_ID = '55555555-5555-4555-8555-555555555555';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

async function installApprovedRuntime(page: Page) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'professional-ui-foundation-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'professional-ui@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '프로 UI 검증 관리자' },
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
        login_name: 'professional-ui-admin',
        display_name: '프로 UI 검증 관리자',
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
        email: 'professional-ui@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '프로 UI 검증 관리자' },
        identities: [],
        created_at: NOW,
      });
    }
    return fulfill(route, { ok: true, items: [], results: [] });
  });

  await page.route('**/api/**', async (route) => fulfill(route, {
    ok: true,
    items: [],
    rows: [],
    results: [],
    alerts: [],
    notifications: [],
  }));
}

test('professional UI stylesheet is bundled after the existing source UI layers', () => {
  const runtime = source('src/app-runtime.tsx');
  const html = source('index.html');
  const css = source('src/professional-ui-foundation.css');

  const base = runtime.indexOf("import './index.css';");
  const chartTouch = runtime.indexOf("import './unified-analysis-chart-touch.css';");
  const professional = runtime.indexOf("import './professional-ui-foundation.css';");

  expect(base).toBeGreaterThan(-1);
  expect(chartTouch).toBeGreaterThan(base);
  expect(professional).toBeGreaterThan(chartTouch);
  expect(html).not.toContain('/professional-ui-foundation.css');
  expect(css).toContain('--pro-ui-font-caption: 0.75rem;');
  expect(css).toContain('@media (min-width: 1024px) and (max-width: 1199px)');
  expect(css).toContain("button[aria-controls='bottom-nav-settings-menu']");
  expect(css).toContain("[data-testid='research-paper-tab'] div[class~='sm:grid-cols-5']");
});

for (const width of [320, 360, 390, 430]) {
  test(`all bottom navigation popovers remain inside the ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await installApprovedRuntime(page);
    await page.goto('/more');

    const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
    await expect(navigation).toBeVisible();

    for (const label of ['종목', '검색기', '자산']) {
      const trigger = navigation.getByRole('button', { name: label, exact: true });
      await expect(trigger).toBeVisible();
      await trigger.click();

      const menu = page.getByRole('menu', { name: `${label} 메뉴` });
      await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      expect(box, `${label}: menu geometry missing at ${width}px`).not.toBeNull();
      expect(box!.x, `${label}: clipped left at ${width}px`).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width, `${label}: clipped right at ${width}px`).toBeLessThanOrEqual(width + 1);

      const overflow = await page.evaluate(() => Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
      ) - window.innerWidth);
      expect(overflow, `${label}: document overflow at ${width}px`).toBeLessThanOrEqual(2);

      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
    }
  });
}

test('1024 through 1199 stays touch-first and the desktop sidebar begins at 1200', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await installApprovedRuntime(page);
  await page.goto('/more');
  const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
  await expect(navigation).toBeVisible();

  for (const width of [1024, 1180]) {
    await page.setViewportSize({ width, height: 820 });
    const geometry = await navigation.evaluate((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        borderRadius: style.borderRadius,
        transform: style.transform,
        boxShadow: style.boxShadow,
      };
    });
    expect(geometry.left, `${width}px touch nav left`).toBeGreaterThanOrEqual(-1);
    expect(geometry.right, `${width}px touch nav right`).toBeLessThanOrEqual(width + 1);
    expect(geometry.width, `${width}px touch nav should span its shell`).toBeGreaterThan(width * 0.9);
    expect(geometry.borderRadius, `${width}px must not use desktop floating radius`).toBe('0px');
    expect(geometry.transform, `${width}px must not use desktop translate`).toBe('none');
    expect(geometry.boxShadow, `${width}px must not use desktop dock shadow`).toBe('none');
  }

  await page.setViewportSize({ width: 1200, height: 820 });
  await expect(navigation).toHaveAttribute('data-testid', 'desktop-sidebar');
  const desktop = await navigation.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, width: rect.width, height: rect.height };
  });
  expect(Math.round(desktop.width), '1200px should use the 216px desktop sidebar').toBe(216);
  expect(desktop.left, '1200px sidebar is anchored to the left edge').toBeLessThanOrEqual(1);
  expect(desktop.height, '1200px sidebar spans the viewport height').toBeGreaterThan(700);
  await expect(page.locator('nav[data-mobile-tab-bar]')).toBeHidden();
});

for (const width of [600, 768, 900, 1024, 1180]) {
  test(`Research Paper authority flags do not collide at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(`
      <section data-testid="research-paper-tab">
        <div>
          <div data-testid="research-safety-flags" class="mt-3 grid grid-cols-1 gap-2 text-[10px] sm:grid-cols-5">
            <span>LIVE_TRADING=false</span>
            <span>AUTO_TRADING=false</span>
            <span>REAL_ORDER_ENABLED=false</span>
            <span>PRIVATE_TRADING_API_ALLOWED=false</span>
            <span>executionAuthority=NONE</span>
          </div>
        </div>
      </section>
    `);
    await page.addStyleTag({ path: path.resolve(process.cwd(), 'src/professional-ui-foundation.css') });

    const result = await page.getByTestId('research-safety-flags').evaluate((grid) => {
      const style = getComputedStyle(grid);
      const gridRect = grid.getBoundingClientRect();
      const children = Array.from(grid.children).map((child) => {
        const element = child as HTMLElement;
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      });
      return {
        columns: style.gridTemplateColumns.split(' ').filter(Boolean).length,
        gridLeft: gridRect.left,
        gridRight: gridRect.right,
        children,
      };
    });

    expect(result.columns).toBe(width < 900 ? 2 : 3);
    for (const child of result.children) {
      expect(child.left).toBeGreaterThanOrEqual(result.gridLeft - 1);
      expect(child.right).toBeLessThanOrEqual(result.gridRight + 1);
      expect(child.scrollWidth).toBeLessThanOrEqual(child.clientWidth + 1);
    }

    for (let index = 0; index < result.children.length; index += 1) {
      for (let other = index + 1; other < result.children.length; other += 1) {
        const a = result.children[index];
        const b = result.children[other];
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        expect(overlapX > 1 && overlapY > 1, `flags ${index}/${other} collide at ${width}px`).toBe(false);
      }
    }
  });
}
