import { test, expect, type Page, type Route } from '@playwright/test';

const NOW = '2026-08-09T00:00:00.000Z';
const USER_ID = '77777777-7777-4777-8777-777777777777';
const AUTH_STORAGE_KEY = 'sb-127-auth-token';

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

function roomResponse(room: string) {
  const market = room === 'stocks-kr' ? 'KR' : room === 'stocks-us' ? 'US' : room === 'coins-spot' ? 'spot' : 'futures';
  const assetType = room.startsWith('stocks') ? 'stock' : room === 'coins-spot' ? 'coin-spot' : 'coin-futures';
  const provider = room === 'stocks-kr' ? 'KRX' : room === 'stocks-us' ? 'US' : room === 'coins-spot' ? 'UPBIT' : 'BITGET';
  const meta = { provider, source: `${provider} fixture`, market, assetType, currency: market === 'KR' || market === 'spot' ? 'KRW' : market === 'US' ? 'USD' : 'USDT', providerUpdatedAt: NOW, observedAt: NOW, fetchedAt: NOW, marketTimeZone: 'UTC', marketStatus: '24H', isDelayed: false, isStale: false, partial: false, unavailableFields: [], errorCode: null, retryable: false };
  const empty = { status: 'empty', data: [], meta, message: 'acceptance fixture' };
  return { ok: true, room, market, assetType, currency: meta.currency, fetchedAt: NOW, partial: false, sections: { indices: empty, rankings: empty, sectors: empty, news: empty, disclosures: empty, derivatives: { status: 'empty', data: { referenceSymbol: 'BTCUSDT', longRatio: null, shortRatio: null, longShortRatio: null, ratioObservedAt: null, liquidations: [] }, meta, message: 'acceptance fixture' } }, requestPolicy: { publicMarketDataOnly: true, privateExchangeRequests: 0, accountRequests: 0, balanceRequests: 0, positionRequests: 0, orderRequests: 0, cancelRequests: 0, aiRequests: 0 } };
}

async function installAdminRuntime(page: Page) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({ access_token: accessToken, refresh_token: 'final-acceptance-refresh', expires_in: 3600, expires_at: expiresAt, token_type: 'bearer', user: { id: userId, aud: 'authenticated', role: 'authenticated', email: 'acceptance@accounts.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: '최종 검증 관리자' }, identities: [], created_at: now } }));
  }, { storageKey: AUTH_STORAGE_KEY, userId: USER_ID, now: NOW });

  const diagnostics = { consoleErrors: [] as string[], pageErrors: [] as string[], forbiddenMutations: [] as string[] };
  page.on('console', (message) => { if (message.type() === 'error') diagnostics.consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/api\/(?:crypto|stocks|account-connections).*\/(?:order|orders|cancel|transfer|withdraw|deposit)/i.test(path) && request.method() !== 'GET') {
      diagnostics.forbiddenMutations.push(`${request.method()} ${path}`);
    }
  });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) return fulfill(route, { id: USER_ID, login_name: 'acceptance-admin', display_name: '최종 검증 관리자', role: 'admin', status: 'approved', membership_level: 'admin', is_active: true, permissions_updated_at: NOW, updated_at: NOW });
    if (pathname.endsWith('/auth/v1/user')) return fulfill(route, { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'acceptance@accounts.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: '최종 검증 관리자' }, identities: [], created_at: NOW });
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const room = path.match(/^\/api\/market-information\/(stocks-kr|stocks-us|coins-spot|coins-futures)$/)?.[1];
    if (room) return fulfill(route, roomResponse(room));
    if (path === '/api/account-connections/snapshot') return fulfill(route, {
      ok: true, readOnly: true, mutationsAllowed: false, checkedAt: NOW,
      providers: {
        kiwoom: { configured: true, connected: true, accountMasked: '12******34', kr: { ok: true, estimatedAssets: 1234567, totalEvaluationAmount: 1100000, totalProfitLoss: 54321, totalProfitRate: 5.2, holdingCount: 1, holdings: [{ symbol: '005930', name: '삼성전자', quantity: 10, averagePrice: 70000, currentPrice: 75000, evaluationAmount: 750000, profitLoss: 50000, profitRate: 7.14, currency: 'KRW' }] }, us: { ok: true, holdingCount: 1, holdings: [{ symbol: 'AAPL', name: 'Apple', quantity: 2, currentPrice: 220, currency: 'USD' }] } },
        upbit: { configured: true, connected: true, assetCount: 2, assets: [{ currency: 'KRW', balance: 1000000, locked: 0, averageBuyPrice: 0, unitCurrency: 'KRW' }, { currency: 'BTC', balance: 0.01, locked: 0, averageBuyPrice: 120000000, unitCurrency: 'KRW' }] },
        bitget: { configured: true, connected: true, accounts: [{ marginCoin: 'USDT', available: 1000, locked: 0, accountEquity: 1005, unrealizedPL: 5 }], positions: [{ symbol: 'BTCUSDT', side: 'long', total: 0.01, leverage: 2, averageOpenPrice: 115000, markPrice: 116000, unrealizedPL: 10, liquidationPrice: 60000 }] },
      },
    });
    if (path === '/api/account-connections/status') return fulfill(route, { ok: true, readOnly: true, mutationsAllowed: false, providers: { kiwoom: { configured: true }, upbit: { configured: true }, bitget: { configured: true } }, checkedAt: NOW });
    if (path === '/api/trade-automation/status') return fulfill(route, { policy: { mode: 'approval', automaticEnabled: false, emergencyStopped: false, exchangeEnabled: { bitget: false, upbit: false, kiwoom: false }, enabledAssets: { bitget: [], upbit: [], kiwoom: [] }, enabledStrategies: [], totalCapitalKrw: 1000000, maxOrderKrw: 100000, dailyLossLimitPercent: 5, maxAssetPercent: 30, maxOpenPositions: 5, maxDailyOrders: 10, maxConsecutiveLosses: 3, bitgetLeverage: 2 }, connections: [], emergencyStopped: false, credentialVault: { encryptionConfigured: false, keyValueExposed: false }, lastOrder: null });
    if (path === '/api/config') return fulfill(route, { providers: { finnhub: false, alphavantage: false, dart: false, secEdgar: false }, mode: 'sample' });
    if (path === '/api/market/summary') return fulfill(route, { items: [] });
    if (path === '/api/market/briefing') return fulfill(route, { asOf: NOW, mood: 'neutral', headline: '검증', lines: [], strongSectors: [], weakSectors: [], positiveNews: [], negativeNews: [], disclosureRisks: [], gainers: [], losers: [], picks: [] });
    if (/\/api\/stocks\/[^/]+\/overview$/.test(path)) return fulfill(route, { profile: { ticker: '005930', name: '삼성전자', market: 'KR', currency: 'KRW', description: '', industry: '', sector: '', country: 'KR', mainBusiness: '', competitors: [] }, quote: { price: 75000, changeAmount: 0, changePercent: 0, volume: 0, marketCap: 0, week52High: 0, week52Low: 0 }, rating: { rating: 'HOLD', confidence: 50, score: 50 }, buyReasons: [], riskFactors: [], summary: '' });
    if (/\/api\/stocks\/[^/]+\/chart$/.test(path)) return fulfill(route, { timeframe: '1D', candles: [], indicators: { ma20: [], ma60: [], ma120: [], ma240: [], rsi: [], macd: { macd: [], signal: [], hist: [] } }, signals: [], rating: { rating: 'HOLD', confidence: 50, score: 50 } });
    if (/\/api\/stocks\/[^/]+\/financials$/.test(path)) return fulfill(route, { annual: [], quarterly: [], rows: [], ratios: { eps: 0, per: 0, pbr: 0, roe: 0, debtRatio: 0 }, growth: { revenue: [], profit: [] }, cashBurn: { cashBalance: 0, quarterlyBurn: 0, survivalQuarters: null }, health: { level: 'AVERAGE', confidence: 0 } });
    if (/\/api\/stocks\/[^/]+\/news$/.test(path)) return fulfill(route, { positive: [], negative: [], news: [], sentimentScore: 0 });
    if (/\/api\/stocks\/[^/]+\/disclosures$/.test(path)) return fulfill(route, { market: 'KR', filings: [], disclosures: [] });
    if (/\/api\/stocks\/[^/]+\/risk$/.test(path)) return fulfill(route, { market: 'KR', items: [], events: [], overallScore: 0, overallLevel: 'LOW', explanation: '', filings: [], disclosures: [] });
    if (/\/api\/stocks\/[^/]+\/signals$/.test(path)) return fulfill(route, { asOf: NOW, accumulation: { score: 0, stars: 0, label: '', confidence: 0, breakoutProbability: 0, expectedPeriod: '', passed: [], failed: [], strategy: { entry: [], take: [], stop: [], caution: [] }, dataQuality: 'insufficient' }, signals: [] });
    if (/\/api\/stocks\/[^/]+\/analysis$/.test(path)) return fulfill(route, { opinion: 'HOLD', opinionReason: '', confidence: 50, buyReasons: [], sellReasons: [], shortTerm: '', midTerm: '', longTerm: '', targetPrice: 80000, stopLossPrice: 70000, conclusion: '' });
    return fulfill(route, { ok: true, items: [], rows: [], results: [], quotes: [], cards: [], alerts: [], markets: [], tickers: [], popular: [], gainers: [], risky: [], recommended: [], themes: [], sectors: [], positive: [], negative: [] });
  });

  return () => {
    expect(diagnostics.consoleErrors, diagnostics.consoleErrors.join('\n')).toEqual([]);
    expect(diagnostics.pageErrors, diagnostics.pageErrors.join('\n')).toEqual([]);
    expect(diagnostics.forbiddenMutations, diagnostics.forbiddenMutations.join('\n')).toEqual([]);
  };
}

async function assertNoHorizontalOverflow(page: Page, label: string) {
  const result = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(result.documentWidth, `${label}: document horizontal overflow`).toBeLessThanOrEqual(result.viewportWidth + 1);
  expect(result.bodyWidth, `${label}: body horizontal overflow`).toBeLessThanOrEqual(result.viewportWidth + 1);
}

const ROUTES = [
  '/home', '/stocks/kr', '/stocks/us', '/coins/spot', '/coins/futures', '/stocks',
  '/stock-info?asset=stock&market=KR&symbol=005930', '/market-overview', '/assets', '/settings',
  '/search', '/market-rankings', '/market-browser', '/scanner', '/ai-chart', '/ai-chat', '/themes',
  '/learn', '/watchlist', '/alerts', '/portfolio', '/account', '/admin', '/more', '/stock/005930',
  '/recommendations', '/backtests', '/paper-trading', '/auto-trading',
] as const;

for (const width of [360, 390, 430, 1023, 1024, 1440]) {
  test(`all primary routes stay inside viewport at ${width}px`, async ({ page }) => {
    const assertClean = await installAdminRuntime(page);
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    for (const route of ROUTES) {
      await page.goto(route);
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(40);
      await assertNoHorizontalOverflow(page, `${width}px ${route}`);
    }
    assertClean();
  });
}

test('admin account panel shows all four market account surfaces and remains read-only', async ({ page }) => {
  const assertClean = await installAdminRuntime(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/account');
  const panel = page.getByTestId('brokerage-account-connections');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('connection-kiwoom')).toContainText('Kiwoom');
  await expect(page.getByTestId('connection-upbit')).toContainText('Upbit');
  await expect(page.getByTestId('connection-bitget')).toContainText('Bitget');
  await expect(panel).toContainText('READ-ONLY');
  await expect(panel).toContainText('주문/취소/이체 mutation 0건');
  await assertNoHorizontalOverflow(page, 'account panel mobile');
  await page.setViewportSize({ width: 1440, height: 900 });
  await assertNoHorizontalOverflow(page, 'account panel desktop');
  assertClean();
});
