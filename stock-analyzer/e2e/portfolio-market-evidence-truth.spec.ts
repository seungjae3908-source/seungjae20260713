import { expect, test, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  assertPortfolioMarketEvidence,
  parsePortfolioQuoteSnapshot,
} from '../src/lib/portfolio-market-truth';

const portfolioPath = fileURLToPath(new URL('../src/pages/portfolio.tsx', import.meta.url));
const overlayPath = fileURLToPath(new URL('../src/lib/portfolio-overlay.ts', import.meta.url));
const truthPath = fileURLToPath(new URL('../src/lib/portfolio-market-truth.ts', import.meta.url));
const authFetchPath = fileURLToPath(new URL('../src/lib/auth-fetch.ts', import.meta.url));
const backendPath = fileURLToPath(new URL('../../api-server/src/routes/market.ts', import.meta.url));
const now = Date.parse('2026-09-10T00:00:00.000Z');
const userId = '88888888-8888-4888-8888-888888888888';
const authStorageKey = 'sb-127-auth-token';

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    quotes: [{ ticker: '005930', price: 72_000, changePercent: 1.2 }],
    requested: 1,
    available: 1,
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

function fulfill(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

async function installMalformedPortfolioQuote(page: Page) {
  await page.addInitScript(({ storageKey, authenticatedUserId }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: authenticatedUserId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'portfolio-market-truth-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: authenticatedUserId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'portfolio-market-truth@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Portfolio Market Truth' },
        identities: [],
        created_at: '2026-09-10T00:00:00.000Z',
      },
    }));
  }, { storageKey: authStorageKey, authenticatedUserId: userId });

  await page.route('**/__e2e-supabase/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: userId,
        login_name: 'portfolio-market-truth',
        display_name: 'Portfolio Market Truth',
        role: 'admin',
        status: 'approved',
        membership_level: 'admin',
        is_active: true,
        permissions_updated_at: '2026-09-10T00:00:00.000Z',
        updated_at: '2026-09-10T00:00:00.000Z',
      });
    }
    if (pathname.endsWith('/auth/v1/user')) {
      return fulfill(route, {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'portfolio-market-truth@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Portfolio Market Truth' },
        identities: [],
        created_at: '2026-09-10T00:00:00.000Z',
      });
    }
    if (pathname.endsWith('/rest/v1/portfolio_holdings')) {
      return fulfill(route, [{
        id: 'holding-1',
        user_id: userId,
        ticker: '005930',
        name: '삼성전자',
        market: 'KR',
        currency: 'KRW',
        quantity: 10,
        average_price: 70_000,
        purchase_date: '2026-09-01',
        created_at: '2026-09-01T00:00:00.000Z',
      }]);
    }
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/quotes') return fulfill(route, { connected: true });
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });
}

test('portfolio quote runtime contract rejects malformed stale future and count-drift HTTP 200', () => {
  expect(parsePortfolioQuoteSnapshot(envelope(), ['005930'], now).complete).toBe(true);
  expect(parsePortfolioQuoteSnapshot(
    envelope({ requested: 2, available: 1 }),
    ['005930', '000660'],
    now,
  ).complete).toBe(false);
  expect(() => parsePortfolioQuoteSnapshot({}, ['005930'], now))
    .toThrow('INVALID_PORTFOLIO_QUOTE_RESPONSE');
  expect(() => parsePortfolioQuoteSnapshot(envelope({ requested: 2 }), ['005930'], now))
    .toThrow('INVALID_PORTFOLIO_QUOTE_RESPONSE');
  expect(() => parsePortfolioQuoteSnapshot(envelope({ available: 0 }), ['005930'], now))
    .toThrow('INVALID_PORTFOLIO_QUOTE_RESPONSE');
  expect(() => parsePortfolioQuoteSnapshot(
    envelope({ updatedAt: '2026-09-09T23:57:59.000Z' }),
    ['005930'],
    now,
  )).toThrow('INVALID_PORTFOLIO_QUOTE_RESPONSE');
  expect(() => parsePortfolioQuoteSnapshot(
    envelope({ updatedAt: '2026-09-10T00:00:06.000Z' }),
    ['005930'],
    now,
  )).toThrow('INVALID_PORTFOLIO_QUOTE_RESPONSE');
  expect(() => parsePortfolioQuoteSnapshot(
    envelope({ quotes: [{ ticker: 'AAPL', price: 200, changePercent: 1 }] }),
    ['005930'],
    now,
  )).toThrow('INVALID_PORTFOLIO_QUOTE_RESPONSE');
  expect(() => parsePortfolioQuoteSnapshot(
    envelope({ quotes: [{ ticker: '005930', price: 0, changePercent: 1 }] }),
    ['005930'],
    now,
  )).toThrow('INVALID_PORTFOLIO_QUOTE_RESPONSE');

  expect(() => assertPortfolioMarketEvidence([
    { ticker: '005930', currentPrice: null },
  ])).toThrow('PORTFOLIO_MARKET_EVIDENCE_MISSING');
  expect(() => assertPortfolioMarketEvidence([
    { ticker: '005930', currentPrice: 72_000 },
  ])).not.toThrow();
});

test('portfolio quote truth is enforced at authenticated transport before average-price fallback can render', async () => {
  const [portfolio, overlay, truth, authFetch, backend] = await Promise.all([
    readFile(portfolioPath, 'utf8'),
    readFile(overlayPath, 'utf8'),
    readFile(truthPath, 'utf8'),
    readFile(authFetchPath, 'utf8'),
    readFile(backendPath, 'utf8'),
  ]);

  // The legacy projection is still present, so both transport and overlay seams
  // must fail closed before missing or malformed market evidence can reach it.
  expect(portfolio).toContain('row.currentPrice ??');
  expect(portfolio).toContain('row.average_price;');
  expect(portfolio).toContain('syncPortfolioChartOverlays(enrichedRows);');
  expect(portfolio).toContain('setRows([]);');

  expect(authFetch).toContain("import { parsePortfolioQuoteSnapshot } from '@/lib/portfolio-market-truth';");
  expect(authFetch).toContain("path === '/api/quotes' && method === 'GET'");
  expect(authFetch).toContain('portfolioRequestedTickers(input)');
  expect(authFetch).toContain("throw new Error('INVALID_PORTFOLIO_QUOTE_RESPONSE')");
  expect(backend).toContain("router.get('/quotes'");
  expect(backend).toContain('requested: tickers.length');
  expect(backend).toContain('updatedAt: new Date().toISOString()');

  expect(overlay).toContain("import { assertPortfolioMarketEvidence } from './portfolio-market-truth';");
  expect(overlay).toContain('assertPortfolioMarketEvidence(');
  expect(truth).toContain("PORTFOLIO_MARKET_EVIDENCE_MISSING");
  expect(truth).toContain('!isFiniteNumber(row.currentPrice) || row.currentPrice <= 0');

  const sync = portfolio.indexOf('syncPortfolioChartOverlays(enrichedRows);');
  const setRows = portfolio.indexOf('setRows(enrichedRows);');
  const outerFailClosed = portfolio.indexOf('setRows([]);', sync);
  expect(sync).toBeGreaterThanOrEqual(0);
  expect(setRows).toBeGreaterThan(sync);
  expect(outerFailClosed).toBeGreaterThan(sync);
});

test('malformed quote HTTP 200 never renders a fabricated zero-return portfolio', async ({ page }) => {
  await installMalformedPortfolioQuote(page);

  const financialMutations: string[] = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (/\/(orders?|cancel|amend|withdraw|transfer)(?:\/|$)/i.test(pathname)) {
      financialMutations.push(`${request.method()} ${pathname}`);
    }
  });

  await page.goto('/portfolio?tab=holdings');

  await expect(page.getByText(/PORTFOLIO_MARKET_EVIDENCE_MISSING/)).toBeVisible();
  await expect(page.getByTestId('portfolio-holdings-summary')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '보유 종목 추가' })).toBeDisabled();
  await expect(page.getByText(/^0(?:\.00)?%$/)).toHaveCount(0);
  expect(financialMutations).toEqual([]);
});
