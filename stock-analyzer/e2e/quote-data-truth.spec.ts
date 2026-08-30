import assert from 'node:assert/strict';
import { formatPrice, formatPercent, formatCompact, formatVolume } from '../src/lib/format';
import { quoteRating } from '../src/lib/quote-row-evidence';
import { quoteFreshness } from '../src/lib/market-freshness';
import { financialDisplayEvidence } from '../src/lib/financial-display-evidence';
import { classifyStock } from '../src/lib/stock-classifier';
import { assessAutoTradeCandidate, estimateAutoTradeProbability } from '../src/lib/auto-trade-research-rules';
import { expect, test, type Page, type Route } from '@playwright/test';

// Auth and market fixtures stay in the isolated localhost browser only.
const USER_ID = '99999999-9999-4999-8999-999999999991';
const NOW = '2026-08-30T12:00:00.000Z';
const sizes = [[1440, 900], [1024, 768], [320, 740], [360, 800], [390, 844], [412, 915], [430, 932]] as const;
const fulfill = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

function scannerSourceFixture() {
  return {
    ok: true, requestId: 'source-missing', assetClass: 'stock', market: 'KR', timeframe: '5m',
    cards: [{
      signalId: 'source-missing', assetClass: 'stock', market: 'KR', exchange: 'KRX', symbol: '005930', name: '시각 누락 검증 종목',
      currency: 'KRW', assetType: 'STOCK', listingStatus: 'LISTED', price: 1000, changePercent: null,
      direction: 'LONG', action: 'BUY', signalState: 'INVALIDATED', score: 59, confidence: 59, dataCompleteness: 70,
      riskScore: null, riskLevel: 'UNAVAILABLE', liquidity: null, volume: null, tradingValue: null, spreadPercent: null, volatilityPercent: null,
      matched: [], notMatched: [], unverified: ['시세 시각'], evidence: [],
      pricePlan: { entryZone: null, invalidation: null, stopLoss: null, targets: [], riskReward: null },
      dataState: 'untrusted', dataSources: ['fixture-only'], observedAt: null, expiresAt: null, strongSignalEligible: false,
      warnings: ['SOURCE_TIME_UNVERIFIED'], dataQuality: { state: 'DATA_UNTRUSTED', score: 0, strongSignalAllowed: false, issues: [] },
    }],
    alerts: [], failures: [], execution: {
      requestedCount: 1, startedCount: 1, completedCount: 1, excludedCount: 0, providerErrorCount: 0, timeoutCount: 0,
      partial: true, timedOut: false, cancelled: false, duplicate: false, elapsedMs: 1, deadlineMs: 8500, itemTimeoutMs: 4000,
      maxConcurrency: 1, providerAcceptedCount: 1, dataSuccessCount: 1, insufficientDataCount: 1, filteredByStrategyCount: 0, finalDisplayedCount: 1,
    },
    universe: { totalCount: 1, cursor: 0, nextCursor: null, source: 'fixture-only', partial: false, stale: false, listingStatusCoverage: 'listed-or-unknown' },
    dataState: 'untrusted', outcome: 'DATA_QUALITY_REJECT', message: '원본 시세 시각 근거 부족',
    generatedAt: NOW, orderSubmitted: false, exchangeRequestSent: false,
  };
}

test('local research rules never synthesize a probability or authorize an order', () => {
  const complete = { score: 90, matchedCount: 2, selectedCount: 2, changePercent: 1, price: 100,
    volume: 100, tradingValue: 10000, marketCap: 100000, confidence: 80, newsScore: 70, disclosureScore: 70, financialScore: 70, riskLevel: 'LOW' };
  const result = assessAutoTradeCandidate(complete);
  expect(result.probability).toBeNull();
  expect(result.ruleScore).not.toBeNull();
  expect(estimateAutoTradeProbability({ ...complete, breakoutProbability: 99 })).toBeNull();
  expect(assessAutoTradeCandidate({ score: 90, matchedCount: 1, selectedCount: 1 }).ruleScore).toBeNull();
  expect(assessAutoTradeCandidate({ ...complete, riskLevel: 'UNAVAILABLE' }).riskScore).toBeNull();
});

async function installRuntime(page: Page, financialScenario?: 'legacy' | 'current' | 'provider-shape' | 'summary-missing' | 'summary-wrong' | 'scanner-missing') {
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
  const profileRole = financialScenario === 'scanner-missing' ? 'associate' : 'admin';
  await page.route('**/__e2e-supabase/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/rest/v1/profiles')) return fulfill(route, { id: USER_ID, login_name: 'quote-fixture', display_name: '검증 사용자', role: profileRole, status: 'approved', membership_level: profileRole, is_active: true, permissions_updated_at: NOW, updated_at: NOW });
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
    if (financialScenario === 'scanner-missing' && path === '/api/market/scan') return fulfill(route, scannerSourceFixture());
    if (financialScenario) {
      if (path === '/api/stocks/AAPL/quote' && financialScenario === 'summary-missing') return fulfill(route, { ticker: 'AAPL', currency: 'USD', price: null, changePercent: null, updatedAt: NOW });
      if (path === '/api/stocks/AAPL/quote' && financialScenario === 'summary-wrong') return fulfill(route, { ticker: 'MSFT', currency: 'KRW', price: 123, changePercent: 9, updatedAt: NOW });
      if (path === '/api/stocks/AAPL/quote') return fulfill(route, { ticker: 'AAPL', name: 'Apple fixture', price: 100, changePercent: 0, currency: 'USD', updatedAt: NOW });
      if (path === '/api/stocks/AAPL/profile') return fulfill(route, { ticker: 'AAPL', name: 'Apple fixture', currency: 'USD', marketCap: 1000 });
      // The default AI subtab mounts before the user selects financials. These
      // isolated legacy-contract fixtures exercise navigation only, not AI proof.
      if (path === '/api/stocks/AAPL/overview') return fulfill(route, { quote: { price: 100 }, profile: { name: 'Apple fixture', currency: 'USD' } });
      if (path === '/api/stocks/AAPL/analysis') return fulfill(route, { opinion: 'HOLD', confidence: 0, targetPrice: 106, stopLossPrice: 94, buyReasons: [], sellReasons: [], shortTerm: 'fixture', midTerm: 'fixture', longTerm: 'fixture', conclusion: 'fixture' });
      if (path === '/api/stocks/AAPL/financials' && financialScenario === 'provider-shape') return fulfill(route, {
        source: 'SEC_COMPANYFACTS', annual: [{ period: '2025', revenue: 1000, operatingIncome: -20, netIncome: -10, cash: 50, liabilities: 100, equity: 200 }], quarterly: [], ratios: { debtRatio: 50 }, updatedAt: NOW,
      });
      if (path === '/api/stocks/AAPL/financials') return fulfill(route, {
        source: 'live', annual: [], quarterly: [], ratios: { eps: 0, per: 0, pbr: 0, roe: 0, debtRatio: 0 }, growth: { revenue: [], profit: [] },
        cashBurn: { cashBalance: 0, quarterlyBurn: financialScenario === 'legacy' ? 1000 : null, survivalQuarters: null, status: 'MISSING_EVIDENCE' },
        health: financialScenario === 'legacy' ? { level: 'STRONG', confidence: 95 } : { level: 'AVERAGE', confidence: null, score: 65, method: 'FINANCIAL_RULES_V1' },
      });
    }
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

for (const [width, height] of sizes) {
  test(`financial evidence cannot turn missing cash flow into profit/runway at ${width}x${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', (response) => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
    const scenario = width === 1440 ? 'legacy' : width === 1024 ? 'provider-shape' : 'current';
    const unexpected = await installRuntime(page, scenario);
    await page.goto('/stock-info/analysis?asset=stock&market=US&ticker=AAPL&tab=analysis');
    await page.getByRole('tab', { name: '재무제표', exact: true }).click();
    const panel = page.getByTestId('stock-detail-analysis-financials');
    await expect(panel.getByText('현금 소진 분석', { exact: true })).toBeVisible();
    await expect(panel).toContainText('검증된 현금흐름표가 없습니다.');
    await expect(panel).toContainText('산정 불가');
    await expect(panel).not.toContainText('흑자 지속');
    await expect(panel).not.toContainText('신뢰도 95%');
    if (scenario !== 'provider-shape') await expect(panel).toContainText('EPS는 $0.00입니다.');
    if (scenario !== 'current') await expect(panel).toContainText('재무 평가 근거 부족');
    else await expect(panel).toContainText('규칙 점수 65/100');
    if (scenario !== 'provider-shape') await expect(panel.getByText('0%', { exact: true })).toHaveCount(2);
    else await expect(panel).toContainText('성장률 근거 부족');
    const layout = await page.evaluate(() => ({ width: innerWidth, body: document.body.scrollWidth, root: document.documentElement.scrollWidth }));
    expect(layout.body).toBeLessThanOrEqual(width);
    expect(layout.root).toBeLessThanOrEqual(width);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
    await testInfo.attach('financial-runtime-proof.json', { body: JSON.stringify({ viewport: { width, height }, scenario, fixture: true, layout, errors: errors.length, unexpectedRequests: unexpected.length }), contentType: 'application/json' });
  });
}

test('financial display never reuses legacy confidence or net income as cash-flow evidence', () => {
  assert.deepEqual(financialDisplayEvidence({ cashBurn: { cashBalance: 0, quarterlyBurn: 100, survivalQuarters: null }, health: { level: 'STRONG', confidence: 95 } }), { cashBalance: 0, healthScore: null, healthLevel: null, sample: false });
  assert.equal(financialDisplayEvidence({ source: 'sample' }).sample, true);
  assert.equal(financialDisplayEvidence({ health: { method: 'FINANCIAL_RULES_V1', score: NaN, level: 'STRONG' } }).healthLevel, null);
});

test('classification needs actual inputs and large companies are not exempt from serious risk', () => {
  for (const ticker of ['AAPL', '005930', 'UNKNOWN']) {
    const result = classifyStock({ ticker });
    assert.equal(result.label, '평가 근거 부족');
    assert.equal(result.score, null);
    assert.equal(result.marketCapGrade, '시총확인필요');
  }
  const complete = { ticker: 'AAPL', currency: 'USD', score: 70, changePercent: 0, marketCap: 300_000_000_000, per: 20, pbr: 2, roe: 10, debtRatio: 50, operatingIncome: 10, netIncome: 10, equity: 100 };
  assert.equal(classifyStock(complete).marketCapGrade, '초대형');
  assert.equal(classifyStock({ ...complete, marketCap: 1_000_000 }).marketCapGrade, '초소형');
  assert.equal(classifyStock({ ...complete, score: undefined, aiScore: 99 }).label, '평가 근거 부족');
  assert.equal(classifyStock({ ...complete, score: 101 }).label, '평가 근거 부족');
  assert.equal(classifyStock({ ...complete, currency: undefined }).label, '평가 근거 부족');
  const risk = classifyStock({ ...complete, risks: ['상장폐지 결정'] });
  assert.equal(risk.label, '잡주');
  assert.equal(risk.delistingWarning, true);
  assert.ok(risk.score !== null && risk.score <= 44);
});

for (const [width, height] of sizes) {
  test(`stock summary does not relabel missing or wrong-identity data at ${width}x${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', (response) => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}`); });
    const scenario = width === 1440 ? 'summary-wrong' : 'summary-missing';
    const unexpected = await installRuntime(page, scenario);
    await page.goto('/stock-info/analysis?asset=stock&market=US&ticker=AAPL&tab=summary');
    const summary = page.getByTestId('stock-detail-summary');
    await expect(summary.getByText('미확인', { exact: true })).toBeVisible();
    await expect(summary).toContainText('등락 미확인');
    await expect(summary).toContainText('시세 시각 확인 불가');
    await expect(summary).not.toContainText('$0.00');
    await expect(summary).not.toContainText('+0.00%');
    await expect(summary).not.toContainText('정상');
    if (scenario === 'summary-wrong') await expect(summary.getByRole('alert')).toContainText('일치하지 않아');
    const layout = await page.evaluate(() => ({ width: innerWidth, body: document.body.scrollWidth, root: document.documentElement.scrollWidth }));
    expect(layout.body).toBeLessThanOrEqual(width);
    expect(layout.root).toBeLessThanOrEqual(width);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
    await testInfo.attach('summary-runtime-proof.json', { body: JSON.stringify({ viewport: { width, height }, scenario, fixture: true, layout, errors: errors.length, unexpectedRequests: unexpected.length }), contentType: 'application/json' });
  });
}
for (const [width, height] of sizes) {
  test(`actual scanner missing source time stays non-actionable at ${width}x${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    const errors: string[] = [];
    const forbidden: string[] = [];
    await page.exposeFunction('reportScannerUnhandled', (reason: string) => errors.push(reason));
    await page.addInitScript(() => addEventListener('unhandledrejection', (event) => {
      void (window as unknown as { reportScannerUnhandled: (reason: string) => Promise<void> }).reportScannerUnhandled(String(event.reason));
    }));
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', (response) => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
    page.on('request', (request) => { if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/')) forbidden.push(request.url()); });
    const unexpected = await installRuntime(page, 'scanner-missing');
    const started = performance.now();
    await page.goto('/scanner');
    await page.getByRole('button', { name: '시각 누락 검증 종목 005930 · KR · STOCK', exact: true }).click();
    const detail = page.locator('[data-testid="signal-detail"]:visible');
    await expect(detail).toHaveCount(1);
    await expect(detail.getByTestId('scanner-source-time')).toContainText('시세 시각 확인 불가');
    await expect(detail.getByTestId('scanner-ttl-badge')).toHaveText('TTL 미확인');
    await expect(detail.getByTestId('scanner-signal-state')).toContainText('INVALIDATED');
    await expect(detail).not.toContainText('1970');
    await expect(detail).not.toContainText('Invalid Date');
    const layout = await page.evaluate(() => ({ body: document.body.scrollWidth, root: document.documentElement.scrollWidth, width: innerWidth }));
    expect(layout.body).toBeLessThanOrEqual(width);
    expect(layout.root).toBeLessThanOrEqual(width);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
    expect(forbidden).toEqual([]);
    await testInfo.attach('scanner-source-runtime-proof.json', { body: JSON.stringify({ viewport: { width, height }, fixture: true, route: '/scanner', elapsedMs: performance.now() - started, layout, errors, forbidden, unexpected }), contentType: 'application/json' });
  });
}
