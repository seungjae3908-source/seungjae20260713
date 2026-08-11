import { expect, test, type Page, type Route } from '@playwright/test';
import { normalizeAnalysisSelection } from '@/lib/analysis-selection';
import { MarketDataService } from '../../api-server/src/services/market-data.service';
import { NewsService } from '../../api-server/src/services/news.service';
import { FinancialService } from '../../api-server/src/services/financial.service';
import { AiChatError, answerAiChat } from '../../api-server/src/services/ai-chat.service';
import type { CompanyProfile, Financials, NewsData, Quote } from '../../api-server/src/sample/types';

const NOW = '2026-08-11T02:30:00.000Z';
const E2E_USER_ID = '22222222-2222-4222-8222-222222222222';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';
const PRICE_PLAN = {
  entryZone: { from: 74_000, to: 75_000 },
  invalidation: 70_000,
  stopLoss: 70_000,
  targets: [82_000, 86_000],
  riskReward: 1.6,
};

const candles = Array.from({ length: 40 }, (_, index) => ({
  time: new Date(Date.UTC(2026, 7, 11, 0, index * 5)).toISOString(),
  open: 70_000 + index * 10,
  high: 70_100 + index * 10,
  low: 69_900 + index * 10,
  close: 70_050 + index * 10,
  volume: 1_000 + index * 20,
  isClosed: index < 39,
}));

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

function scannerCard() {
  return {
    ticker: '000660',
    symbol: '000660',
    name: 'SK하이닉스',
    assetClass: 'stock',
    market: 'KR',
    exchange: 'KRX',
    currency: 'KRW',
    assetType: 'STOCK',
    listingStatus: 'LISTED',
    price: 75_000,
    changePercent: 1.2,
    score: 88,
    confidence: 82,
    dataCompleteness: 94,
    matched: ['거래량 증가', '5일선 돌파', 'AI 점수 상위'],
    notMatched: [],
    unverified: [],
    missing: [],
    breakoutProbability: 75,
    expectedPeriod: '단기',
    entry: ['74000', '75000'],
    stop: ['70000'],
    matchCount: 3,
    selectedCount: 3,
    riskLevel: 'LOW',
    riskScore: 10,
    liquidity: 1_000_000_000,
    volume: 1_000_000,
    tradingValue: 75_000_000_000,
    spreadPercent: 0.05,
    volatilityPercent: 1.2,
    dataState: 'complete',
    analyzedAt: NOW,
    observedAt: NOW,
    expiresAt: '2026-08-12T02:30:00.000Z',
    signalId: 'signal:expanded-price-plan',
    direction: 'LONG',
    signalState: 'WATCHING',
    strongSignalEligible: true,
    warnings: [],
    dataSources: ['market-quote', 'market-candles'],
    evidence: [{
      key: 'trend',
      label: '추세 일치',
      status: 'matched',
      source: 'public-candles',
      observedAt: NOW,
      reasons: ['결정적 공개 캔들 fixture로 추세를 확인했습니다.'],
    }],
    pricePlan: PRICE_PLAN,
    scoreBreakdown: { trend: { score: 88, status: 'ok', reasons: ['상승 구조'] } },
  };
}

function scannerPayload() {
  const card = scannerCard();
  return {
    ok: true,
    provider: 'fixture',
    searchRunId: 'scan:expanded:1D:1',
    requestId: 'scan:expanded:1D:1',
    assetClass: 'stock',
    timeframe: '1D',
    market: 'KR',
    supportedIndicators: ['거래량 증가', '5일선 돌파', 'AI 점수 상위'],
    rows: [card],
    cards: [card],
    results: [card],
    alerts: [],
    failures: [],
    execution: {
      requestedCount: 1,
      startedCount: 1,
      completedCount: 1,
      excludedCount: 0,
      providerErrorCount: 0,
      timeoutCount: 0,
      partial: false,
      timedOut: false,
      cancelled: false,
      duplicate: false,
      elapsedMs: 10,
      deadlineMs: 12_000,
      itemTimeoutMs: 3_500,
      maxConcurrency: 1,
    },
    universe: {
      totalCount: 1,
      cursor: 0,
      nextCursor: null,
      source: 'krx-symbol-master',
      partial: false,
      stale: false,
      listingStatusCoverage: 'listed-or-unknown',
    },
    dataState: 'complete',
    message: '1종목 공개 데이터 분석을 완료했습니다.',
    generatedAt: NOW,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

async function installTechnicalWorkspaceMocks(page: Page) {
  await page.route('**/api/**', (route) => fulfill(route, { ok: true, items: [], rows: [], results: [], quotes: [] }));
  await page.route('**/api/market/scan**', (route) => fulfill(route, scannerPayload()));
  await page.route('**/api/stocks/*/chart**', (route) => fulfill(route, {
    ticker: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) ?? '000660'),
    timeframe: '1D',
    provider: 'expanded-fixture',
    fetchedAt: NOW,
    candles,
  }));
  await page.route('**/api/quotes**', (route) => fulfill(route, { quotes: [{ ticker: '^KS11', changePercent: 0.4 }] }));
}

test('PricePlan preserves non-integer internal precision before display formatting', () => {
  const normalized = normalizeAnalysisSelection({
    assetType: 'coin_futures',
    market: 'BITGET',
    symbol: 'BTCUSDT',
    ticker: 'BTCUSDT',
    displayName: 'BTCUSDT',
    timeframe: '5m',
    pricePlan: {
      entryZone: { from: 123.4567, to: 124.5678 },
      invalidation: 120.12345678,
      stopLoss: 121.23456789,
      targets: [130.34567891, 140.45678912],
      riskReward: 1.23456789,
    },
    selectedAt: NOW,
  });
  expect(normalized).not.toBeNull();
  expect(normalized?.pricePlan?.entryZone).toEqual({ from: 123.4567, to: 124.5678 });
  expect(normalized?.pricePlan?.invalidation).toBe(120.12345678);
  expect(normalized?.pricePlan?.stopLoss).toBe(121.23456789);
  expect(normalized?.pricePlan?.targets).toEqual([130.34567891, 140.45678912]);
  expect(normalized?.pricePlan?.riskReward).toBe(1.23456789);
});

test('Scanner PricePlan reaches the AI Chart consumer unchanged and is cleared on context change', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installTechnicalWorkspaceMocks(page);
  await page.goto('/__phase11-technical-workspace-e2e');

  const scanner = page.locator('aside').first();
  await expect(scanner.getByText('SK하이닉스', { exact: true })).toBeVisible();
  expect(scannerPayload().cards[0].pricePlan).toEqual(PRICE_PLAN);
  await scanner.getByRole('button', { name: 'AI 차트 분석기에서 보기', exact: true }).click();

  const consumer = page.getByTestId('scanner-price-plan-chart');
  await expect(consumer).toContainText('74,000원 ~ 75,000원');
  await expect(consumer).toContainText('70,000원');
  await expect(consumer).toContainText('82,000원');
  await expect(consumer).toContainText('86,000원');
  await expect(consumer).toContainText('1.60');

  await page.getByTestId('market-US').click();
  await expect(consumer).toContainText('Scanner에서 전달된 Price Plan이 없습니다.');
  await expect(consumer).not.toContainText('74,000원 ~ 75,000원');
  await expect(consumer).not.toContainText('82,000원');
});

type StockMarket = 'KR' | 'US';
type StockFixture = {
  market: StockMarket;
  symbol: string;
  displayName: string;
  currency: 'KRW' | 'USD';
  price: number;
};
type GeminiRequestBody = { contents?: Array<{ parts?: Array<{ text?: string }> }> };
type PublicContextPrompt = {
  task?: string;
  publicContext?: {
    selection?: { market?: string; symbol?: string; displayName?: string };
    quote?: Record<string, unknown>;
    company?: Record<string, unknown> | null;
    news?: { items?: Array<Record<string, unknown>> } | null;
    financials?: Record<string, unknown> | null;
    data?: { status?: string; missing?: string[] };
  };
};

const environmentKeys = [
  'AI_CHAT_PROVIDER', 'AI_CHAT_API_KEY', 'AI_CHAT_MODEL', 'GEMINI_API_KEY',
  'GOOGLE_API_KEY', 'GEMINI_MODEL', 'TRADING_REVIEW_PROVIDER',
  'TRADING_REVIEW_API_KEY', 'TRADING_REVIEW_MODEL',
] as const;

function snapshotEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
}
function clearEnvironment() { for (const key of environmentKeys) delete process.env[key]; }
function restoreEnvironment(snapshot: Record<string, string | undefined>) {
  for (const key of environmentKeys) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
function quoteFixture(price: number): Quote {
  return { price, changeAmount: 1.25, changePercent: 1.1, volume: 1_234_567, marketCap: 2_000_000_000, week52High: price * 1.2, week52Low: price * 0.7 };
}
function companyFixture(fixture: StockFixture): CompanyProfile {
  return {
    ticker: fixture.symbol, name: fixture.displayName, market: fixture.market, currency: fixture.currency,
    description: `${fixture.displayName} public company profile`, industry: 'Technology',
    sector: 'Information Technology', country: fixture.market, mainBusiness: 'Public market fixture business', competitors: [],
  };
}
function newsFixture(fixture: StockFixture): NewsData {
  return {
    positive: [{ title: `${fixture.displayName} public market update`, source: 'fixture-news', sourceDomain: 'news.example.invalid', date: '2026-08-11', url: 'https://news.example.invalid/public-market-update', tone: 'positive', summary: 'Deterministic public-news fixture.' }],
    negative: [], sentimentScore: 100,
  };
}
function financialFixture(): Financials {
  return {
    source: 'live', quarterly: [], annual: [],
    ratios: { eps: 12.34, per: 18.2, pbr: 2.1, roe: 14.8, debtRatio: 42.5 },
    growth: { revenue: [], profit: [] },
    cashBurn: { cashBalance: 1_000_000, quarterlyBurn: 100_000, survivalQuarters: null },
    health: { level: 'STRONG', confidence: 82 },
  };
}
function installPublicStockMocks(fixture: StockFixture) {
  const originalQuote = MarketDataService.getQuote;
  const originalCompany = MarketDataService.getCompanyProfile;
  const originalNews = NewsService.getNews;
  const originalFinancials = FinancialService.getFinancials;
  const calls = { quote: 0, company: 0, news: 0, financials: 0 };
  MarketDataService.getQuote = async (ticker: string) => { calls.quote += 1; expect(ticker).toBe(fixture.symbol); return quoteFixture(fixture.price); };
  MarketDataService.getCompanyProfile = async (ticker: string) => { calls.company += 1; expect(ticker).toBe(fixture.symbol); return companyFixture(fixture); };
  NewsService.getNews = async (ticker: string) => { calls.news += 1; expect(ticker).toBe(fixture.symbol); return newsFixture(fixture); };
  FinancialService.getFinancials = async (ticker: string) => { calls.financials += 1; expect(ticker).toBe(fixture.symbol); return financialFixture(); };
  return {
    calls,
    restore() {
      MarketDataService.getQuote = originalQuote;
      MarketDataService.getCompanyProfile = originalCompany;
      NewsService.getNews = originalNews;
      FinancialService.getFinancials = originalFinancials;
    },
  };
}
function providerPrompt(init: RequestInit | undefined): PublicContextPrompt {
  const body = JSON.parse(String(init?.body ?? '{}')) as GeminiRequestBody;
  const text = body.contents?.[0]?.parts?.[0]?.text ?? '';
  expect(text).not.toBe('');
  return JSON.parse(text) as PublicContextPrompt;
}

for (const fixture of [
  { market: 'KR', symbol: '005930', displayName: '삼성전자', currency: 'KRW', price: 75_123 },
  { market: 'US', symbol: 'AAPL', displayName: 'Apple', currency: 'USD', price: 231.45 },
] satisfies StockFixture[]) {
  test(`AI ${fixture.market} provider payload contains only public ${fixture.symbol} market context`, async () => {
    const previous = snapshotEnvironment();
    const mocks = installPublicStockMocks(fixture);
    clearEnvironment();
    process.env.GEMINI_API_KEY = 'expanded-evidence-gemini-key';
    let providerCalls = 0;
    try {
      const result = await answerAiChat({
        message: `${fixture.displayName} 현재 시장 데이터와 최근 뉴스를 요약해줘`,
        context: { market: fixture.market, symbol: fixture.symbol, displayName: fixture.displayName },
      }, async (_url, init) => {
        providerCalls += 1;
        const prompt = providerPrompt(init);
        const context = prompt.publicContext;
        expect(prompt.task).toBe('answer_or_summarize_public_financial_information');
        expect(context?.selection).toEqual({ market: fixture.market, symbol: fixture.symbol, displayName: fixture.displayName });
        expect(context?.quote?.price).toBe(fixture.price);
        expect(context?.company?.market).toBe(fixture.market);
        expect(context?.news?.items?.[0]?.source).toBe('fixture-news');
        expect(context?.financials?.source).toBe('live');
        expect(context?.data?.status).toBe('complete');
        expect(context?.data?.missing).toEqual([]);
        const serialized = JSON.stringify(context);
        expect(serialized).not.toMatch(/(?:account|balance|position|credential|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|orderPayload|orderId)/i);
        expect(serialized).not.toContain('expanded-evidence-gemini-key');
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: `${fixture.symbol} 공개 시장 컨텍스트를 확인했습니다.` }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      expect(result.kind).toBe('answer');
      expect(result.data.status).toBe('complete');
      expect(providerCalls).toBe(1);
      expect(mocks.calls).toEqual({ quote: 1, company: 1, news: 1, financials: 1 });
    } finally {
      mocks.restore();
      restoreEnvironment(previous);
    }
  });
}

test('AI provider failure is single-attempt with no paid fallback', async () => {
  const fixture: StockFixture = { market: 'US', symbol: 'AAPL', displayName: 'Apple', currency: 'USD', price: 231.45 };
  const previous = snapshotEnvironment();
  const mocks = installPublicStockMocks(fixture);
  clearEnvironment();
  process.env.GEMINI_API_KEY = 'expanded-evidence-gemini-key';
  process.env.TRADING_REVIEW_PROVIDER = 'openai-compatible';
  process.env.TRADING_REVIEW_API_KEY = 'must-not-be-used-paid-key';
  process.env.TRADING_REVIEW_MODEL = 'must-not-be-used-paid-model';
  let providerCalls = 0;
  try {
    await expect(answerAiChat({
      message: 'Apple 현재 시장 데이터를 요약해줘',
      context: { market: 'US', symbol: 'AAPL', displayName: 'Apple' },
    }, async (_url, init) => {
      providerCalls += 1;
      const prompt = providerPrompt(init);
      expect(prompt.publicContext?.selection?.market).toBe('US');
      expect(prompt.publicContext?.selection?.symbol).toBe('AAPL');
      expect(JSON.stringify(prompt)).not.toContain('must-not-be-used-paid-key');
      return new Response(JSON.stringify({ error: { status: 'UNAVAILABLE' } }), { status: 503, headers: { 'content-type': 'application/json' } });
    })).rejects.toMatchObject({ code: 'AI_CHAT_PROVIDER_ERROR', statusCode: 502 } satisfies Partial<AiChatError>);
    expect(providerCalls).toBe(1);
    expect(mocks.calls).toEqual({ quote: 1, company: 1, news: 1, financials: 1 });
  } finally {
    mocks.restore();
    restoreEnvironment(previous);
  }
});

async function installApprovedSession(page: Page) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken, refresh_token: 'expanded-evidence-refresh', expires_in: 3600, expires_at: expiresAt, token_type: 'bearer',
      user: { id: userId, aud: 'authenticated', role: 'authenticated', email: 'expanded@accounts.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: 'Expanded Evidence Admin' }, identities: [], created_at: now },
    }));
  }, { storageKey: E2E_AUTH_STORAGE_KEY, userId: E2E_USER_ID, now: NOW });

  await page.route('**/__e2e-supabase/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/rest/v1/profiles')) return fulfill(route, { id: E2E_USER_ID, login_name: 'expanded-admin', display_name: 'Expanded Evidence Admin', role: 'admin', status: 'approved', membership_level: 'admin', is_active: true, permissions_updated_at: NOW, updated_at: NOW });
    if (path.endsWith('/auth/v1/user')) return fulfill(route, { id: E2E_USER_ID, aud: 'authenticated', role: 'authenticated', email: 'expanded@accounts.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: 'Expanded Evidence Admin' }, identities: [], created_at: NOW });
    return fulfill(route, { ok: true });
  });
}

type StockInfoMode = 'normal' | 'slow-news' | 'slow-financial' | 'news-failure';

async function installStockInfoMocks(page: Page, mode: StockInfoMode) {
  let releaseNews: (() => void) | null = null;
  let releaseFinancial: (() => void) | null = null;
  const newsGate = new Promise<void>((resolve) => { releaseNews = resolve; });
  const financialGate = new Promise<void>((resolve) => { releaseFinancial = resolve; });
  let newsCalls = 0;
  let financialCalls = 0;

  await page.route('**/api/**', async (route) => {
    const requestUrl = new URL(route.request().url());
    const path = requestUrl.pathname;
    if (path === '/api/stocks/special-feed') return fulfill(route, { ok: true, asset: 'stock', market: 'US', items: [], count: 0, catalogSize: 1, updatedAt: NOW });
    if (path === '/api/stocks/AAPL/quote') return fulfill(route, { ticker: 'AAPL', name: 'Apple', market: 'US', currency: 'USD', price: 231.45, changeAmount: 1.25, changePercent: 0.54, volume: 1_000_000, open: 229.5, high: 232.1, low: 228.9, tradingValue: 231_450_000, marketCap: 3_000_000_000_000, updatedAt: NOW, marketStatus: 'OPEN' });
    if (path === '/api/stocks/AAPL/profile') return fulfill(route, { ticker: 'AAPL', name: 'Apple', market: 'US', currency: 'USD', industry: 'Technology', sector: 'Information Technology', country: 'US' });
    if (path === '/api/stocks/AAPL/financials') {
      financialCalls += 1;
      if (mode === 'slow-financial') await financialGate;
      return fulfill(route, { financials: { source: 'live', quarterly: [{ period: '2026-Q2', periodLabel: '2026 Q2', revenue: 100_000_000, operatingIncome: 25_000_000, netIncome: 20_000_000, assets: 500_000_000, liabilities: 150_000_000, equity: 350_000_000, operatingCashFlow: 30_000_000 }], annual: [], ratios: { per: 18.2, pbr: 2.1, roe: 14.8, debtRatio: 42.5 } } });
    }
    if (path === '/api/stocks/AAPL/news') {
      newsCalls += 1;
      if (mode === 'slow-news') await newsGate;
      if (mode === 'news-failure') return fulfill(route, { ok: false, error: 'NEWS_PROVIDER_UNAVAILABLE', message: 'deterministic optional news failure' }, 502);
      return fulfill(route, { news: [{ title: 'Apple deterministic public news', source: 'fixture-news', date: '2026-08-11', url: 'https://news.example.invalid/apple' }] });
    }
    if (path === '/api/stocks/AAPL/disclosures') return fulfill(route, { disclosures: [] });
    if (path === '/api/stocks/AAPL/market-flow') return fulfill(route, { available: true, totals: { individual: 10, institution: 20, foreigner: 30 } });
    if (path === '/api/stocks/AAPL/short-selling') return fulfill(route, { available: true, latest: { balance: 100 } });
    if (path.startsWith('/api/price-alert')) return fulfill(route, { ok: true, items: [], alerts: [] });
    return fulfill(route, { ok: true, items: [], rows: [], results: [], quotes: [], cards: [], alerts: [], markets: [], tickers: [] });
  });

  return {
    releaseNews: () => releaseNews?.(),
    releaseFinancial: () => releaseFinancial?.(),
    newsCalls: () => newsCalls,
    financialCalls: () => financialCalls,
  };
}

async function expectPrimaryStockInfoUsable(page: Page) {
  await expect(page.getByRole('heading', { name: '정보', level: 1 })).toBeVisible();
  const selected = page.locator('#stock-info-selected');
  await expect(selected).toBeVisible();
  await expect(selected).toContainText('AAPL');
  await expect(selected).toContainText('$231.45');
  const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
  await expect(navigation).toBeVisible();
  await navigation.getByRole('button', { name: '기술', exact: true }).click();
  await expect(page.getByRole('menu', { name: '기술 메뉴' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'AI 차트', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
}

test('slow News stays secondary while stock-info primary quote and navigation remain usable', async ({ page }) => {
  await installApprovedSession(page);
  const runtime = await installStockInfoMocks(page, 'slow-news');
  await page.goto('/stock-info?asset=stock&market=US&ticker=AAPL');
  await expect.poll(runtime.newsCalls).toBeGreaterThanOrEqual(1);
  await expectPrimaryStockInfoUsable(page);
  await expect(page.getByRole('button', { name: /최신 뉴스.*불러오는 중/ })).toBeVisible();
  runtime.releaseNews();
  await expect(page.getByRole('button', { name: /최신 뉴스.*최신 고유 1건/ })).toBeVisible();
});

test('slow Financial stays secondary while stock-info primary quote and navigation remain usable', async ({ page }) => {
  await installApprovedSession(page);
  const runtime = await installStockInfoMocks(page, 'slow-financial');
  await page.goto('/stock-info?asset=stock&market=US&ticker=AAPL');
  await expect.poll(runtime.financialCalls).toBeGreaterThanOrEqual(1);
  await expectPrimaryStockInfoUsable(page);
  await expect(page.getByText('재무요약', { exact: true })).toBeVisible();
  await expect(page.getByText('데이터를 불러오는 중입니다.', { exact: true })).toBeVisible();
  runtime.releaseFinancial();
  await expect(page.getByText('18.2배', { exact: true })).toBeVisible();
});

test('optional News provider failure degrades locally without blocking stock-info primary data', async ({ page }) => {
  await installApprovedSession(page);
  const runtime = await installStockInfoMocks(page, 'news-failure');
  await page.goto('/stock-info?asset=stock&market=US&ticker=AAPL');
  await expectPrimaryStockInfoUsable(page);
  await expect.poll(runtime.newsCalls).toBeGreaterThanOrEqual(1);
  await expect(page.getByRole('button', { name: /최신 뉴스.*불러오기 실패/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#stock-info-selected')).toContainText('$231.45');
  await expect(page.locator('body')).not.toContainText(/페이지를 찾을 수 없습니다|page not found/i);
});

test('AI provider failure exits busy state, keeps the UI reusable, and does not create private or order requests', async ({ page }) => {
  const forbidden: string[] = [];
  await installTechnicalWorkspaceMocks(page);
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/api\/(?:accounts?|balances?|positions?|orders?|cancel|trade-automation)(?:\/|$)/i.test(path)) forbidden.push(`${request.method()} ${path}`);
  });
  await page.route('**/api/ai/chat', (route) => fulfill(route, { ok: false, error: 'AI_CHAT_PROVIDER_ERROR', message: 'AI provider unavailable' }, 502));

  await page.goto('/__phase11-ai-chat-e2e');
  const input = page.getByPlaceholder(/질문 입력/);
  await input.fill('AAPL 공개 정보를 요약해줘');
  await input.press('Enter');
  await expect(page.getByRole('alert')).toContainText('AI provider unavailable');
  await expect(page.getByText('답변을 준비하고 있습니다.')).toHaveCount(0);
  await expect(input).toBeEnabled();
  await input.fill('다시 질문할 수 있습니다');
  await expect(page.getByRole('button', { name: '메시지 전송' })).toBeEnabled();

  await page.goto('/__phase11-technical-workspace-e2e');
  await expect(page.getByRole('heading', { name: 'AI 신호검색기' })).toBeVisible();
  expect(forbidden).toEqual([]);
});
