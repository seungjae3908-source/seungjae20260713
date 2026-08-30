import { expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validatePortfolioHoldingRows } from '../src/lib/portfolio-holding-truth';

const VALID_ROW = {
  id: 'holding-1',
  ticker: '005930',
  market: 'KR',
  currency: 'KRW',
  quantity: 10,
  average_price: 78000,
} as const;
const E2E_USER_ID = '22222222-2222-4222-8222-222222222222';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';
const E2E_NOW = '2026-08-30T10:30:00.000Z';

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

async function installApprovedSessionWithInvalidHolding(page: Page) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'portfolio-truth-e2e-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'portfolio-truth@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Portfolio Truth Admin' },
        identities: [],
        created_at: now,
      },
    }));
  }, { storageKey: E2E_AUTH_STORAGE_KEY, userId: E2E_USER_ID, now: E2E_NOW });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: E2E_USER_ID,
        login_name: 'portfolio-truth-admin',
        display_name: 'Portfolio Truth Admin',
        role: 'admin',
        status: 'approved',
        membership_level: 'admin',
        is_active: true,
        permissions_updated_at: E2E_NOW,
        updated_at: E2E_NOW,
      });
    }
    if (url.pathname.endsWith('/auth/v1/user')) {
      return fulfill(route, {
        id: E2E_USER_ID,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'portfolio-truth@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Portfolio Truth Admin' },
        identities: [],
        created_at: E2E_NOW,
      });
    }
    if (url.pathname.endsWith('/rest/v1/portfolio_holdings')) {
      return fulfill(route, [{
        id: 'broken-holding',
        user_id: E2E_USER_ID,
        ticker: '005930',
        name: '삼성전자',
        market: 'KR',
        currency: 'KRW',
        average_price: 78000,
        created_at: E2E_NOW,
      }]);
    }
    return fulfill(route, { ok: true });
  });
}

test('portfolio holding truth accepts explicit finite positive numeric facts', () => {
  expect(validatePortfolioHoldingRows([VALID_ROW])).toEqual({ ok: true });
  expect(validatePortfolioHoldingRows([{
    ...VALID_ROW,
    id: 'holding-us',
    ticker: 'AAPL',
    market: 'US',
    currency: 'USD',
    quantity: '2.5',
    average_price: '240.10',
  }])).toEqual({ ok: true });
});

test('portfolio holding truth never converts missing or invalid quantity to zero', () => {
  expect(validatePortfolioHoldingRows([{ ...VALID_ROW, quantity: undefined }])).toEqual({
    ok: false,
    code: 'INVALID_QUANTITY',
    rowIndex: 0,
  });
  expect(validatePortfolioHoldingRows([{ ...VALID_ROW, quantity: 'not-a-number' }])).toEqual({
    ok: false,
    code: 'INVALID_QUANTITY',
    rowIndex: 0,
  });
  expect(validatePortfolioHoldingRows([{ ...VALID_ROW, quantity: 0 }])).toEqual({
    ok: false,
    code: 'INVALID_QUANTITY',
    rowIndex: 0,
  });
});

test('portfolio holding truth rejects missing or impossible average price', () => {
  expect(validatePortfolioHoldingRows([{ ...VALID_ROW, average_price: null }])).toEqual({
    ok: false,
    code: 'INVALID_AVERAGE_PRICE',
    rowIndex: 0,
  });
  expect(validatePortfolioHoldingRows([{ ...VALID_ROW, average_price: -1 }])).toEqual({
    ok: false,
    code: 'INVALID_AVERAGE_PRICE',
    rowIndex: 0,
  });
});

test('portfolio holding truth rejects guessed market or currency identity', () => {
  expect(validatePortfolioHoldingRows([{ ...VALID_ROW, market: undefined }])).toEqual({
    ok: false,
    code: 'INVALID_MARKET',
    rowIndex: 0,
  });
  expect(validatePortfolioHoldingRows([{ ...VALID_ROW, market: 'US', currency: 'KRW' }])).toEqual({
    ok: false,
    code: 'INVALID_CURRENCY',
    rowIndex: 0,
  });
});

test('Supabase boundary validates only canonical full-row portfolio reads', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/lib/supabase.ts'), 'utf8');
  expect(source).toContain("requestMethod(input, init) !== 'GET'");
  expect(source).toContain("pathname.endsWith('/rest/v1/portfolio_holdings')");
  expect(source).toContain("parsed?.searchParams.get('select') === '*'");
  expect(source).toContain('validatePortfolioHoldingRows(payload)');
  expect(source).toContain('PORTFOLIO_HOLDING_DATA_INVALID');
  expect(source).toContain('status: 422');
});

test('partial portfolio selects remain outside the full-row truth guard', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/lib/supabase.ts'), 'utf8');
  expect(source).toContain("pathname.endsWith('/rest/v1/portfolio_holdings')");
  expect(source).toContain("return parsed?.searchParams.get('select') === '*';");
  expect(source).not.toContain("return pathname.endsWith('/rest/v1/portfolio_holdings');");
});

test('portfolio holdings UI never presents load failure as zero-valued portfolio facts', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/pages/portfolio.tsx'), 'utf8');
  expect(source).toContain('data-testid="portfolio-holdings-summary"');
  expect(source).toContain('!loading &&');
  expect(source).toContain('initialized &&');
  expect(source).toContain('!error &&');
  expect(source).toContain('disabled={loading || Boolean(error)}');
});

test('malformed holding fails closed on the real portfolio holdings route without zero summary or private calls', async ({ page }) => {
  await installApprovedSessionWithInvalidHolding(page);

  const consoleErrors: string[] = [];
  const quoteRequests: string[] = [];
  const forbiddenRequests: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/quotes') quoteRequests.push(request.url());
    if (/\/(orders?|cancel|withdraw|transfer)(?:\/|$)/i.test(url.pathname)
      || /\/api\/crypto\/(?:spot\/accounts|futures\/(?:account|positions))(?:\/|$)/i.test(url.pathname)) {
      forbiddenRequests.push(`${request.method()} ${url.pathname}`);
    }
  });

  await page.goto('/portfolio?tab=holdings');

  await expect(page.getByText(/포트폴리오 원본 데이터의 시장·통화·수량·평단/)).toBeVisible();
  await expect(page.getByTestId('portfolio-holdings-summary')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '보유 종목 추가' })).toBeDisabled();
  expect(quoteRequests).toEqual([]);
  expect(forbiddenRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
