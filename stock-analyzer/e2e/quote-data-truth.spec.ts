import assert from 'node:assert/strict';
import { formatPrice, formatPercent, formatCompact, formatVolume } from '../src/lib/format';
import { quoteRating } from '../src/lib/quote-row-evidence';
import { quoteFreshness } from '../src/lib/market-freshness';
import { expect, test, type Page, type Route } from '@playwright/test';

// Auth and market fixtures stay in the isolated localhost browser only.
const USER_ID = '99999999-9999-4999-8999-999999999991';
const NOW = '2026-08-30T12:00:00.000Z';
const sizes = [[1440, 900], [1024, 768], [320, 740], [360, 800], [390, 844], [412, 915], [430, 932]] as const;
const fulfill = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function installRuntime(page: Page) {
  await page.addInitScript(({ userId, now }) => {
    const encode = (value: Record<string, unknown>) => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const exp = 4102444800;
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp })}.fixture`,
      refresh_token: 'local-fixture-only', expires_at: exp, expires_in: 3600, token_type: 'bearer',
      user: { id: userId, aud: 'authenticated', role: 'authenticated', email: 'quote-fixture@accounts.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [], created_at: now },
    }));
  }, { userId: USER_ID, now: NOW });
  const unexpected: string[] = [];
  await page.route('**/__e2e-supabase/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/rest/v1/profiles')) return fulfill(route, { id: USER_ID, login_name: 'quote-fixture', display_name: '검증 사용자', role: 'admin', status: 'approved', membership_level: 'admin', is_active: true, permissions_updated_at: NOW, updated_at: NOW });
    if (path.endsWith('/auth/v1/user')) return fulfill(route, { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'quote-fixture@accounts.invalid', app_metadata: { provider: 'email' }, user_metadata: {}, identities: [], created_at: NOW });
    unexpected.push(path);
    return fulfill(route, { error: 'UNEXPECTED_FIXTURE_AUTH_REQUEST' }, 400);
  });
  const rows = [
    { ticker: 'FIXTURE', name: '숫자와 평가 근거가 없는 테스트 종목', market: 'US', currency: 'USD', price: null, changePercent: null, volume: null, tradingValue: null, marketCap: 200000000000, rating: null, ratingStatus: 'MISSING_EVIDENCE' },
    { ticker: 'LARGE', name: '매우 긴 이름과 큰 숫자를 가진 표시 검증 종목', market: 'US', currency: 'USD', price: 1234567890123.45, changePercent: -5.12, volume: 0, tradingValue: 0, marketCap: 100000000000, rating: null, ratingStatus: 'MISSING_EVIDENCE', source: 'fixture-only', updatedAt: '2020-01-01T00:00:00Z', tradingValueSource: 'LAST_PRICE_X_VOLUME_ESTIMATE' },
    { ticker: 'FUTURE', name: '미래 시각 검증 종목', market: 'US', currency: 'USD', price: 100, changePercent: 0, volume: 0, marketCap: 10000, rating: null, updatedAt: '2099-01-01T00:00:00Z' },
  ];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/market/movers') return fulfill(route, { market: 'US', dataStatus: 'complete', popular: rows, volume: rows, gainers: [], losers: [], recommended: [], recommendationStatus: 'MISSING_EVIDENCE' });
    if (path === '/api/quotes') return fulfill(route, { quotes: [], dataStatus: 'partial' });
    if (path === '/api/watchlist') return fulfill(route, { ok: true, items: [] });
    if (path === '/api/backup/latest' && route.request().method() === 'GET') return fulfill(route, { ok: true, exists: false });
    unexpected.push(`${route.request().method()} ${path}`);
    return fulfill(route, { error: 'UNEXPECTED_FIXTURE_API_REQUEST' }, 400);
  });
  return unexpected;
}

for (const [width, height] of sizes) {
  test(`quote data truth remains visible at ${width}x${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    const errors: string[] = [];
    const unhandled: string[] = [];
    await page.exposeFunction('reportUnhandledQuoteFixture', (reason: string) => { unhandled.push(reason); });
    await page.addInitScript(() => {
      addEventListener('unhandledrejection', (event) => {
        const reporter = (window as unknown as { reportUnhandledQuoteFixture: (reason: string) => Promise<void> }).reportUnhandledQuoteFixture;
        void reporter(String(event.reason));
      });
    });
    const failedHttp: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', (response) => { if (response.status() >= 400) failedHttp.push(`${response.status()} ${new URL(response.url()).pathname}`); });
    const unexpected = await installRuntime(page);
    const started = performance.now();
    await page.goto('/search?market=US&rank=marketCap');
    await page.getByRole('button', { name: '시장 순위', exact: true }).click();
    await expect(page.getByRole('button', { name: '시총', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '해외주식', exact: true }).click();
    await page.getByRole('button', { name: '시총', exact: true }).click();
    await expect(page.getByText('티커 FIXTURE', { exact: true })).toBeVisible();
    const card = page.getByRole('button').filter({ has: page.getByText('티커 FIXTURE', { exact: true }) });
    await expect(card.getByText('평가 근거 부족', { exact: true })).toBeVisible();
    await expect(card).not.toContainText('보통주');
    await expect(card).not.toContainText('$0.00');
    await expect(card).not.toContainText('+0.00%');
    await expect(card.getByText('—', { exact: true }).first()).toBeVisible();
    await expect(card).toContainText('시세 시각 확인 불가');
    const stale = page.getByRole('button').filter({ has: page.getByText('티커 LARGE', { exact: true }) });
    await expect(stale).toContainText('5분 이상 지난 시세');
    await expect(stale).toContainText('거래대금 추정');
    const future = page.getByRole('button').filter({ has: page.getByText('티커 FUTURE', { exact: true }) });
    await expect(future).toContainText('시세 시각 오류');
    await expect(future).not.toContainText('방금');
    const layout = await page.evaluate(() => ({ width: innerWidth, body: document.body.scrollWidth, root: document.documentElement.scrollWidth }));
    expect(layout.body).toBeLessThanOrEqual(width);
    expect(layout.root).toBeLessThanOrEqual(width);
    const loadMs = performance.now() - started;
    await page.getByRole('button', { name: '규칙 평가', exact: true }).click();
    await expect(page.getByText('검증된 평가 근거가 부족합니다.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: '다시 조회', exact: true })).toBeVisible();
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
    expect(failedHttp).toEqual([]);
    expect(unhandled).toEqual([]);
    await testInfo.attach('runtime-proof.json', { body: JSON.stringify({ viewport: { width, height }, fixture: true, routeLoadAndInteractionMs: loadMs, layout, consolePageErrors: errors.length, unhandledRejections: unhandled.length, unexpectedHttpErrors: failedHttp.length, unexpectedRequests: unexpected.length }), contentType: 'application/json' });
  });
}

test('financial display preserves real zero and quote currency while rejecting absent numbers', () => {
  for (const value of [null, undefined, NaN, Infinity]) {
    assert.equal(formatPrice(value, 'KRW'), '—');
    assert.equal(formatPrice(value, 'USD'), '—');
    assert.equal(formatPercent(value), '—');
    assert.equal(formatCompact(value, 'KRW'), '—');
    assert.equal(formatVolume(value), '—');
  }
  assert.equal(formatPrice(0, 'KRW'), '0원');
  assert.equal(formatPercent(0), '+0.00%');
  assert.equal(formatPrice(1, 'USD'), '$1.00');
  assert.equal(formatPrice(1, 'USDT'), '1 USDT');
  assert.equal(formatPrice(0.00000001, 'BTC'), '0.00000001 BTC');
  assert.equal(formatPrice(1, ''), '—');
  const row = { ticker: 'AAPL', name: 'Fixture', market: 'US' as const, currency: 'USD' as const, price: 100, changePercent: 0, rating: null };
  assert.equal(quoteRating(row), null);
  assert.equal(quoteRating({ ...row, rating: { rating: 'HOLD', confidence: 50, score: NaN } }), null);
  assert.equal(quoteRating({ ...row, ratingStatus: 'MISSING_EVIDENCE', rating: { rating: 'HOLD', confidence: 50, score: 50 } }), null);
  const now = Date.parse('2026-08-30T15:00:00Z');
  for (const updatedAt of ['2026-02-30T00:00:00Z', '2026-08-30T15:00:00', '2026-08-30T16:00:00Z', '2026-08-30T00:00:00+15:00']) {
    assert.equal(quoteFreshness({ updatedAt }, now).label, '시세 시각 오류');
  }
  assert.equal(quoteFreshness({}, now).timestamp, null);
  assert.equal(quoteFreshness({ updatedAt: '2026-08-28T15:30:00+09:00' }, now).timestamp, '2026-08-28T06:30:00.000Z');
});
