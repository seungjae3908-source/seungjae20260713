import { test, expect, type Page } from '@playwright/test';

const NOW = new Date().toISOString();
const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const WATCHLIST_KEY = 'seungjae_watchlist_v1';
const LONG_KR = '매우 긴 이름의 국내외 공통 종목 테스트 주식회사';

function fulfill(route: any, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

async function mockApi(page: Page, options: { quote429?: number; invalid?: string; delayKr?: number } = {}) {
  let limited = options.quote429 ?? 0;
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const market = url.searchParams.get('market') === 'US' ? 'US' : 'KR';
    const match = path.match(/^\/api\/stocks\/([^/]+)\/(.+)$/);
    const ticker = decodeURIComponent(match?.[1] ?? '').toUpperCase();
    const action = match?.[2] ?? '';
    if (path === '/api/search') {
      const bad = String(url.searchParams.get('q') ?? url.searchParams.get('query') ?? '').toUpperCase().includes('BAD');
      return fulfill(route, { results: bad ? [{ ticker: 'BAD', name: '잘못된 종목', market: 'KR', currency: 'KRW' }] : [
        { ticker: 'SAME', name: LONG_KR, market: 'KR', currency: 'KRW' },
        { ticker: 'SAME', name: 'Very Long Shared Symbol Corporation', market: 'US', currency: 'USD' },
      ] });
    }
    if (path === '/api/stocks/special-feed') return fulfill(route, { ok: true, asset: url.searchParams.get('asset') ?? 'stock', market: url.searchParams.get('market') ?? 'KR', catalogSize: 3, count: 3, updatedAt: NOW, items: [
      { id: 'good', asset: 'stock', kind: 'news', tone: 'positive', ticker: 'SAME', name: LONG_KR, market, currency: market === 'US' ? 'USD' : 'KRW', title: '장기 성장 계약 체결 호재', summary: '매출 반영 여부 확인', source: '테스트뉴스', sourceAt: NOW, detectedAt: NOW, archiveAt: FUTURE },
      { id: 'bad', asset: 'stock', kind: 'news', tone: 'negative', ticker: 'SAME', name: LONG_KR, market, currency: market === 'US' ? 'USD' : 'KRW', title: '개발 일정 지연과 비용 증가 가능성을 포함한 매우 긴 악재 뉴스 제목', summary: '일정 지연', source: '테스트뉴스', sourceAt: NOW, detectedAt: NOW, archiveAt: FUTURE },
      { id: 'filing', asset: 'stock', kind: 'disclosure', tone: 'neutral', ticker: 'SAME', name: LONG_KR, market, currency: market === 'US' ? 'USD' : 'KRW', title: '중요 공시', summary: '공식 자료', source: market === 'US' ? 'SEC' : 'DART', sourceAt: NOW, detectedAt: NOW, archiveAt: FUTURE },
    ] });
    if (path === '/api/quotes') return fulfill(route, { quotes: [
      { ticker: 'SAME', name: LONG_KR, market: 'KR', currency: 'KRW', price: 1000, changePercent: 1.25, updatedAt: NOW },
      { ticker: 'SAME', name: 'Very Long Shared Symbol Corporation', market: 'US', currency: 'USD', price: 20, changePercent: -2.5, updatedAt: NOW },
    ] });
    if (match) {
      if (ticker === options.invalid && action.startsWith('quote')) return fulfill(route, { error: 'not found' }, 404);
      if (action.startsWith('quote')) {
        if (limited > 0) { limited -= 1; return fulfill(route, { error: 'limited' }, 429); }
        if (market === 'KR' && options.delayKr) await new Promise((resolve) => setTimeout(resolve, options.delayKr));
        return fulfill(route, { ticker, name: market === 'US' ? 'Very Long Shared Symbol Corporation' : LONG_KR, market, currency: market === 'US' ? 'USD' : 'KRW', price: market === 'US' ? 20 : 1000, changeAmount: market === 'US' ? -0.5 : 15, changePercent: market === 'US' ? -2.5 : 1.25, volume: 1234567, tradingValue: 9876543210, open: 985, high: 1020, low: 970, marketCap: 100000000000, marketStatus: 'OPEN', source: market === 'US' ? 'US_PROVIDER' : 'KR_PROVIDER', updatedAt: NOW });
      }
      if (action.startsWith('profile') || action.startsWith('company')) return fulfill(route, { name: market === 'US' ? 'Very Long Shared Symbol Corporation' : LONG_KR, market, industry: '테스트 업종', sector: '기술' });
      if (action.startsWith('financials')) return fulfill(route, { source: market === 'US' ? 'SEC_XBRL' : 'DART_XBRL', updatedAt: NOW, financials: { quarterly: [{ period: '2026-Q2', revenue: 120000000, operatingIncome: 10000000, netIncome: 7000000, assets: 500000000, liabilities: 120000000, equity: 380000000, operatingCashFlow: 9000000 }], annual: [{ period: '2025', revenue: 400000000 }] }, ratios: { per: 15, pbr: 2, roe: 12 } });
      if (action.startsWith('market-flow')) return fulfill(route, { available: true, totals: { individual: -100, institution: 40, foreign: 60 } });
      if (action.startsWith('short-selling')) return fulfill(route, { available: true, latest: { shortVolume: 1000, ratio: 2.3, balance: 5000 } });
      if (action.startsWith('news')) return fulfill(route, { news: [{ title: '실제 사용 기준의 매우 긴 뉴스 제목', source: '테스트뉴스', date: NOW }] });
      if (action.startsWith('disclosures') || action.startsWith('filings')) return fulfill(route, { disclosures: [{ report: '사업 진행 상황 공시', date: NOW }] });
      if (action.startsWith('candles')) return fulfill(route, { candles: Array.from({ length: 25 }, (_, i) => ({ date: `2026-07-${String(i + 1).padStart(2, '0')}`, open: 10 + i, high: 11 + i, low: 9 + i, close: 10.5 + i, volume: 1000 + i })) });
      if (action.startsWith('risk') || action.startsWith('analysis')) return fulfill(route, { risk: { summary: '테스트 위험 분석' } });
    }
    if (path === '/api/notifications/price-alerts') return fulfill(route, { alerts: [] });
    if (path === '/api/crypto/status') return fulfill(route, { upbit: { ok: true }, bitget: { ok: true } });
    if (path === '/api/crypto/spot/markets') return fulfill(route, { markets: [{ symbol: 'KRW-BTC', koreanName: '비트코인', englishName: 'Bitcoin' }] });
    if (path === '/api/crypto/spot/tickers') return fulfill(route, { updatedAt: NOW, tickers: [{ symbol: 'KRW-BTC', price: 100000000, changePercent: 1.2, high24h: 101000000, low24h: 98000000, volume24h: 123, tradingValue24h: 12300000000 }] });
    if (path === '/api/crypto/spot/orderbook') return fulfill(route, { totalAskSize: 10, totalBidSize: 11, units: [{ askPrice: 100100000, askSize: 1, bidSize: 2, bidPrice: 99900000 }] });
    if (path === '/api/crypto/spot/candles') return fulfill(route, { candles: [{ close: 100000000 }] });
    if (path === '/api/crypto/futures/tickers') return fulfill(route, { updatedAt: NOW, tickers: [{ symbol: 'BTCUSDT', price: 70000, changePercent24h: -0.5, high24h: 71000, low24h: 69000, volume24h: 12345, tradingValue24h: 900000000, markPrice: 70010, indexPrice: 69990, fundingRate: 0.0001, openInterest: 555000, bidPrice: 70000, askPrice: 70001 }] });
    if (path === '/api/crypto/futures/candles') return fulfill(route, { candles: [{ close: 70000 }] });
    return fulfill(route, { ok: true });
  });
}

function diagnostics(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console:${message.text()}`); });
  page.on('pageerror', (error) => errors.push(`page:${error.message}`));
  page.on('requestfailed', (request) => { const reason = request.failure()?.errorText ?? ''; if (!reason.includes('ERR_ABORTED')) errors.push(`request:${reason}`); });
  return () => expect(errors, errors.join('\n')).toEqual([]);
}

async function choose(page: Page, market: 'KR' | 'US') {
  const placeholder = market === 'KR' ? /국내 종목명/ : /해외 종목명/;
  const input = page.getByPlaceholder(placeholder);
  await input.fill('');
  await input.fill('SAME');
  const resultName = market === 'KR' ? `${LONG_KR} SAME` : 'Very Long Shared Symbol SAME';
  await page.getByRole('button', { name: resultName, exact: true }).click();
}

test('desktop information flow exposes quote, provenance, sections, detail and restored filter', async ({ page }) => {
  const clean = diagnostics(page); await mockApi(page); await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/stock-info?asset=stock&market=KR'); await choose(page, 'KR');
  await expect(page.getByText('1,000원', { exact: true })).toBeVisible(); await expect(page.getByText(/출처 KR_PROVIDER/)).toBeVisible();
  await page.getByRole('button', { name: /기본정보/ }).click(); await expect(page.getByText('거래량', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /재무요약/ }).click(); await expect(page.getByText(/2026-Q2/)).toBeVisible();
  await page.getByRole('button', { name: /최신 뉴스/ }).click(); await expect(page.getByText(/실제 사용 기준/)).toBeVisible();
  await page.getByRole('button', { name: /최신 공시/ }).click(); await expect(page.getByText(/사업 진행 상황/)).toBeVisible();
  await page.getByRole('button', { name: '악재', exact: true }).click(); await page.getByRole('button', { name: /상세 분석/ }).click();
  await expect(page).toHaveURL(/market=KR/); await page.getByRole('button', { name: '뒤로가기' }).click();
  await expect(page.getByRole('button', { name: '악재', exact: true })).toHaveClass(/bg-primary/); clean();
});

test('rapid KR to US switch never lets an old same-symbol response overwrite the market', async ({ page }) => {
  const clean = diagnostics(page); await mockApi(page, { delayKr: 700 }); await page.goto('/stock-info?asset=stock&market=KR');
  await choose(page, 'KR'); await page.getByRole('button', { name: '해외' }).click(); await choose(page, 'US');
  await expect(page.getByText('$20', { exact: true })).toBeVisible(); await page.waitForTimeout(900); await expect(page.getByText('$20', { exact: true })).toBeVisible(); clean();
});

test('429 retry and invalid ticker states are explicit', async ({ page }) => {
  await mockApi(page, { quote429: 3, invalid: 'BAD' }); await page.goto('/stock-info?asset=stock&market=KR'); await choose(page, 'KR');
  await expect(page.locator('#stock-info-selected').getByText(/요청이 많습니다/).first()).toBeVisible({ timeout: 15000 }); await page.getByRole('button', { name: '시세 다시 불러오기' }).click();
  await expect(page.getByText('1,000원', { exact: true })).toBeVisible(); await page.getByPlaceholder(/국내 종목명/).fill('BAD'); await page.getByRole('button', { name: '잘못된 종목 BAD', exact: true }).click();
  await expect(page.locator('#stock-info-selected').getByText(/종목 코드 또는 시장/).first()).toBeVisible({ timeout: 15000 });
});

test('watchlist keeps the same ticker separately for KR and US', async ({ page }) => {
  const clean = diagnostics(page); await mockApi(page); await page.goto('/stock-info?asset=stock&market=KR'); await choose(page, 'KR'); await page.getByRole('button', { name: '관심종목' }).click();
  await page.getByRole('button', { name: '해외' }).click(); await choose(page, 'US'); await page.getByRole('button', { name: '관심종목' }).click();
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '[]'), WATCHLIST_KEY); expect(stored.map((row: any) => row.market).sort()).toEqual(['KR', 'US']);
  await page.goto('/watchlist'); await expect(page.getByText(/공통 종목/).first()).toBeVisible(); await expect(page.getByText(/Shared Symbol/).first()).toBeVisible(); clean();
});

test('mobile long content and stock event popup do not overflow', async ({ page }) => {
  const clean = diagnostics(page); await mockApi(page); await page.setViewportSize({ width: 360, height: 740 }); await page.goto('/stock-info?asset=stock&market=KR');
  await expect(page.getByText(/개발 일정 지연과 비용 증가/)).toBeVisible(); await page.getByRole('button', { name: '악재', exact: true }).click();
  await expect(page.getByText(/매우 긴 악재 뉴스 제목/)).toBeVisible(); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); clean();
});

test('coin information moves from Upbit spot to Bitget futures', async ({ page }) => {
  const clean = diagnostics(page); await mockApi(page); await page.goto('/stock-info?asset=coin&coinMarket=spot');
  await page.getByPlaceholder(/코인명/).fill('BTC'); await page.getByRole('button', { name: /비트코인/ }).click(); await page.getByRole('button', { name: /현물 기본정보/ }).click(); await expect(page.getByText('24시간 거래량')).toBeVisible();
  await page.getByRole('button', { name: /선물 · 비트겟/ }).click(); await page.getByPlaceholder(/선물 심볼/).fill('BTC'); await page.getByRole('button', { name: /BTCUSDT/ }).click(); await page.getByRole('button', { name: /선물 기본정보/ }).click(); await expect(page.getByText('펀딩비')).toBeVisible(); await expect(page.getByText('미결제약정')).toBeVisible(); clean();
});

test('direct refresh routes for stock information, market, themes, list, watchlist, and portfolio render without blank pages', async ({ page }) => {
  const clean = diagnostics(page); await mockApi(page);
  for (const route of ['/stock-info?asset=stock&market=US&ticker=SAME', '/market-overview', '/themes', '/stocks', '/watchlist', '/portfolio']) {
    await page.goto(route); await page.reload(); await expect(page.locator('body')).not.toBeEmpty(); await expect(page.locator('body')).not.toContainText(/페이지를 찾을 수 없습니다|page not found/i);
  }
  clean();
});