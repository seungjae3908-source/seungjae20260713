import { expect, test, type Page, type Route } from '@playwright/test';

const NOW = '2026-08-21T03:00:00.000Z';
const E2E_USER_ID = '22222222-2222-4222-8222-222222222222';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';

type Market = 'KR' | 'US' | 'spot' | 'futures';
type Asset = 'stock' | 'coin';
type Sample = { symbol: string; name: string; englishName: string };
type MarketCase = {
  path: string;
  room: 'stocks-kr' | 'stocks-us' | 'coins-spot' | 'coins-futures';
  market: Market;
  asset: Asset;
  currency: 'KRW' | 'USD' | 'USDT';
  exchange: 'KRX' | 'US' | 'UPBIT' | 'BITGET';
  title: string;
  samples: Sample[];
};

const KR: Sample[] = [
  ['005930', '삼성전자', 'Samsung Electronics'], ['000660', 'SK하이닉스', 'SK Hynix'],
  ['005380', '현대차', 'Hyundai Motor'], ['000270', '기아', 'Kia'],
  ['005490', 'POSCO홀딩스', 'POSCO Holdings'], ['035420', 'NAVER', 'NAVER'],
  ['035720', '카카오', 'Kakao'], ['373220', 'LG에너지솔루션', 'LG Energy Solution'],
  ['068270', '셀트리온', 'Celltrion'], ['207940', '삼성바이오로직스', 'Samsung Biologics'],
  ['051910', 'LG화학', 'LG Chem'], ['006400', '삼성SDI', 'Samsung SDI'],
  ['028260', '삼성물산', 'Samsung C&T'], ['012330', '현대모비스', 'Hyundai Mobis'],
  ['066570', 'LG전자', 'LG Electronics'], ['003670', '포스코퓨처엠', 'POSCO Future M'],
  ['096770', 'SK이노베이션', 'SK Innovation'], ['034730', 'SK', 'SK Inc'],
  ['015760', '한국전력', 'Korea Electric Power'], ['032830', '삼성생명', 'Samsung Life'],
  ['086790', '하나금융지주', 'Hana Financial'], ['105560', 'KB금융', 'KB Financial'],
  ['055550', '신한지주', 'Shinhan Financial'], ['316140', '우리금융지주', 'Woori Financial'],
  ['024110', '기업은행', 'Industrial Bank of Korea'],
].map(([symbol, name, englishName]) => ({ symbol, name, englishName }));

const US: Sample[] = [
  ['AAPL', 'Apple', 'Apple'], ['MSFT', 'Microsoft', 'Microsoft'], ['GOOGL', 'Alphabet', 'Alphabet'],
  ['AMZN', 'Amazon', 'Amazon'], ['META', 'Meta Platforms', 'Meta Platforms'], ['NVDA', 'NVIDIA', 'NVIDIA'],
  ['TSLA', 'Tesla', 'Tesla'], ['PLTR', 'Palantir Technologies', 'Palantir Technologies'],
  ['RGTI', 'Rigetti Computing', 'Rigetti Computing'], ['ORCL', 'Oracle', 'Oracle'], ['ADBE', 'Adobe', 'Adobe'],
  ['CRM', 'Salesforce', 'Salesforce'], ['INTC', 'Intel', 'Intel'], ['AMD', 'Advanced Micro Devices', 'Advanced Micro Devices'],
  ['QCOM', 'Qualcomm', 'Qualcomm'], ['TXN', 'Texas Instruments', 'Texas Instruments'], ['IBM', 'IBM', 'IBM'],
  ['CSCO', 'Cisco Systems', 'Cisco Systems'], ['NOW', 'ServiceNow', 'ServiceNow'], ['INTU', 'Intuit', 'Intuit'],
  ['PANW', 'Palo Alto Networks', 'Palo Alto Networks'], ['SNOW', 'Snowflake', 'Snowflake'],
  ['AVGO', 'Broadcom', 'Broadcom'], ['MU', 'Micron Technology', 'Micron Technology'], ['F', 'Ford Motor', 'Ford Motor'],
].map(([symbol, name, englishName]) => ({ symbol, name, englishName }));

const COINS: Sample[] = [
  ['BTC', '비트코인', 'Bitcoin'], ['ETH', '이더리움', 'Ethereum'], ['XRP', '리플', 'XRP'], ['SOL', '솔라나', 'Solana'],
  ['DOGE', '도지코인', 'Dogecoin'], ['ADA', '에이다', 'Cardano'], ['AVAX', '아발란체', 'Avalanche'], ['LINK', '체인링크', 'Chainlink'],
  ['DOT', '폴카닷', 'Polkadot'], ['TRX', '트론', 'TRON'], ['BCH', '비트코인캐시', 'Bitcoin Cash'], ['ETC', '이더리움클래식', 'Ethereum Classic'],
  ['XLM', '스텔라루멘', 'Stellar'], ['HBAR', '헤데라', 'Hedera'], ['SUI', '수이', 'Sui'], ['APT', '앱토스', 'Aptos'],
  ['NEAR', '니어프로토콜', 'NEAR Protocol'], ['UNI', '유니스왑', 'Uniswap'], ['AAVE', '에이브', 'Aave'], ['ARB', '아비트럼', 'Arbitrum'],
  ['OP', '옵티미즘', 'Optimism'], ['SHIB', '시바이누', 'Shiba Inu'], ['STX', '스택스', 'Stacks'], ['ATOM', '코스모스', 'Cosmos'], ['LTC', '라이트코인', 'Litecoin'],
].map(([symbol, name, englishName]) => ({ symbol, name, englishName }));

const CASES: MarketCase[] = [
  { path: '/stocks/kr', room: 'stocks-kr', market: 'KR', asset: 'stock', currency: 'KRW', exchange: 'KRX', title: '국내주식 정보', samples: KR },
  { path: '/stocks/us', room: 'stocks-us', market: 'US', asset: 'stock', currency: 'USD', exchange: 'US', title: '미국주식 정보', samples: US },
  { path: '/coins/spot', room: 'coins-spot', market: 'spot', asset: 'coin', currency: 'KRW', exchange: 'UPBIT', title: '코인 현물 정보', samples: COINS },
  { path: '/coins/futures', room: 'coins-futures', market: 'futures', asset: 'coin', currency: 'USDT', exchange: 'BITGET', title: '코인 선물 정보', samples: COINS },
];

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

async function installApprovedSession(page: Page) {
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
        id: userId, aud: 'authenticated', role: 'authenticated', email: 'market-search-p0@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '시장검색 P0 관리자' }, identities: [], created_at: now,
      },
    }));
    window.localStorage.removeItem('unified-asset-search-recent-v1');
  }, { storageKey: E2E_AUTH_STORAGE_KEY, userId: E2E_USER_ID, now: NOW });
}

function roomMeta(config: MarketCase) {
  return {
    provider: config.exchange,
    source: `${config.exchange} 공개 QA`,
    market: config.market,
    assetType: config.asset === 'stock' ? 'stock' : config.market === 'spot' ? 'coin-spot' : 'coin-futures',
    currency: config.currency,
    providerUpdatedAt: NOW,
    observedAt: NOW,
    fetchedAt: NOW,
    marketTimeZone: config.market === 'KR' ? 'Asia/Seoul' : config.market === 'US' ? 'America/New_York' : config.market === 'spot' ? 'Asia/Seoul' : 'UTC',
    marketStatus: config.asset === 'stock' ? 'CLOSED' : '24H',
    isDelayed: false,
    isStale: false,
    partial: false,
    unavailableFields: [],
    errorCode: null,
    retryable: false,
  };
}

function roomResponse(config: MarketCase) {
  const meta = roomMeta(config);
  const empty = (message: string) => ({ status: 'empty', data: [], meta, message });
  return {
    ok: true,
    room: config.room,
    market: config.market,
    assetType: config.asset === 'stock' ? 'stock' : config.market === 'spot' ? 'coin-spot' : 'coin-futures',
    currency: config.currency,
    fetchedAt: NOW,
    partial: false,
    sections: {
      indices: empty('QA empty'), rankings: empty('QA empty'), sectors: empty('QA empty'),
      news: empty('QA empty'), disclosures: empty('QA empty'),
      derivatives: {
        status: 'unsupported',
        data: { referenceSymbol: 'BTCUSDT', longRatio: null, shortRatio: null, longShortRatio: null, ratioObservedAt: null, liquidations: [] },
        meta,
        message: 'QA unsupported',
      },
    },
    requestPolicy: {
      publicMarketDataOnly: true,
      privateExchangeRequests: 0,
      accountRequests: 0,
      balanceRequests: 0,
      positionRequests: 0,
      orderRequests: 0,
      cancelRequests: 0,
      aiRequests: 0,
    },
  };
}

function suggestion(config: MarketCase, sample: Sample) {
  const futures = config.market === 'futures';
  const spot = config.market === 'spot';
  const productCode = config.asset === 'stock' ? sample.symbol : futures ? `${sample.symbol}USDT` : `KRW-${sample.symbol}`;
  return {
    id: `qa:${config.market}:${sample.symbol}`,
    assetType: config.asset,
    market: config.market,
    instrumentType: config.asset === 'stock' ? 'stock' : futures ? 'futures' : 'spot',
    exchange: config.exchange,
    ...(config.asset === 'stock' ? { ticker: sample.symbol } : { symbol: productCode }),
    productCode,
    koreanName: sample.name,
    englishName: sample.englishName,
    displayName: sample.name,
    baseSymbol: sample.symbol,
    quoteCurrency: config.currency,
    matchType: 'exact',
    active: true,
    provider: 'P0_PUBLIC_UNIVERSE_FIXTURE',
    dataAsOf: NOW,
  };
}

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

async function installMocks(page: Page) {
  await installApprovedSession(page);
  const badFilters: string[] = [];
  const forbidden: string[] = [];
  const searchDurations: Record<Market, number[]> = { KR: [], US: [], spot: [], futures: [] };

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: E2E_USER_ID,
        login_name: 'market-search-p0',
        display_name: '시장검색 P0 관리자',
        role: 'admin', status: 'approved', membership_level: 'admin', is_active: true,
        permissions_updated_at: NOW, updated_at: NOW,
      });
    }
    if (pathname.endsWith('/auth/v1/user')) {
      return fulfill(route, {
        id: E2E_USER_ID, aud: 'authenticated', role: 'authenticated', email: 'market-search-p0@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: '시장검색 P0 관리자' }, identities: [], created_at: NOW,
      });
    }
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (/\/(accounts?|balances?|positions?|orders?|cancel|trade-automation)(\/|$)|\/crypto\/futures\/auto/i.test(path)) {
      forbidden.push(`${route.request().method()} ${path}`);
      return fulfill(route, { ok: false, error: 'FORBIDDEN_TEST_REQUEST' }, 500);
    }
    if (path === '/api/search/suggest') {
      const started = performance.now();
      const market = url.searchParams.get('market') as Market;
      const asset = url.searchParams.get('asset') as Asset;
      const q = (url.searchParams.get('q') ?? '').trim();
      const config = CASES.find((item) => item.market === market);
      if (!config || config.asset !== asset) badFilters.push(`${asset}:${market}:${q}`);
      const target = config?.samples.find((item) =>
        item.symbol.toLowerCase() === q.toLowerCase()
        || item.name.toLowerCase() === q.toLowerCase()
        || item.englishName.toLowerCase() === q.toLowerCase());
      const results = config && target ? [suggestion(config, target)] : [];
      const body = {
        ok: true,
        state: results.length ? 'FULL' : 'EMPTY',
        q,
        asset,
        market,
        results,
        count: results.length,
        dataAsOf: NOW,
        stale: false,
        partial: false,
        providers: [{ provider: 'P0_PUBLIC_UNIVERSE_FIXTURE', status: 'ok', count: results.length, dataAsOf: NOW }],
        hiddenMatches: [],
      };
      const result = await fulfill(route, body);
      searchDurations[market]?.push(performance.now() - started);
      return result;
    }
    const room = CASES.find((item) => path === `/api/market-information/${item.room}`);
    if (room) return fulfill(route, roomResponse(room));
    if (path === '/api/notifications/price-alerts') return fulfill(route, { alerts: [] });
    if (path === '/api/watchlist/sync') return fulfill(route, { ok: true, items: [] });
    return fulfill(route, { ok: true });
  });

  return { badFilters, forbidden, searchDurations };
}

async function runSearch(page: Page, config: MarketCase, query: string, expected: Sample) {
  const input = page.getByRole('combobox', { name: '통합 자산 검색' });
  const started = Date.now();
  const responsePromise = page.waitForResponse((candidate) => {
    const url = new URL(candidate.url());
    return url.pathname === '/api/search/suggest'
      && url.searchParams.get('market') === config.market
      && (url.searchParams.get('q') ?? '').trim().toLowerCase() === query.trim().toLowerCase();
  });
  await input.fill(query);
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const option = page.getByRole('option').filter({ hasText: expected.symbol }).first();
  await expect(option).toBeVisible();
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(1_000);
  return elapsed;
}

test('market-room canonical search stays independent of rankings and supports ticker, name, English name, negative state, and detail navigation', async ({ page }) => {
  const diagnostics = await installMocks(page);
  for (const config of CASES) {
    await page.goto(config.path);
    await expect(page.getByRole('heading', { name: config.title })).toBeVisible();
    await expect(page.getByRole('combobox', { name: '통합 자산 검색' })).toBeEditable();
    const representative = config.samples[0];
    for (const query of [representative.symbol, representative.name, representative.englishName]) {
      await runSearch(page, config, query, representative);
    }
    const input = page.getByRole('combobox', { name: '통합 자산 검색' });
    await input.fill(`NOT-A-REAL-${config.market}-SYMBOL`);
    await expect(page.getByText('NO_MATCH · 일치하는 자산 없음')).toBeVisible();
    await input.fill(representative.symbol);
    const option = page.getByRole('option').filter({ hasText: representative.symbol }).first();
    await expect(option).toBeVisible();
    await option.click();
    await expect(page).toHaveURL(/\/stock-info(?:\/analysis)?\?/);
  }
  expect(diagnostics.badFilters).toEqual([]);
  expect(diagnostics.forbidden).toEqual([]);
});

test('desktop performs 400 scoped searches with zero wrong-market results and records p50/p95/max', async ({ page }) => {
  test.setTimeout(180_000);
  const diagnostics = await installMocks(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const report: Record<string, { count: number; average: number; p50: number; p95: number; max: number }> = {};

  for (const config of CASES) {
    await page.goto(config.path);
    const durations: number[] = [];
    for (let cycle = 0; cycle < 4; cycle += 1) {
      for (const sample of config.samples) {
        durations.push(await runSearch(page, config, sample.symbol, sample));
      }
    }
    report[config.market] = {
      count: durations.length,
      average: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      max: Math.max(...durations),
    };
  }

  expect(Object.values(report).reduce((sum, item) => sum + item.count, 0)).toBe(400);
  expect(diagnostics.badFilters).toEqual([]);
  expect(diagnostics.forbidden).toEqual([]);
  console.log(`MARKET_ROOM_SEARCH_DESKTOP_QA=${JSON.stringify(report)}`);
});

test('mobile performs 100 scoped searches and all required viewports preserve search geometry', async ({ page }) => {
  test.setTimeout(120_000);
  const diagnostics = await installMocks(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const report: Record<string, { count: number; average: number; p50: number; p95: number; max: number }> = {};

  for (const config of CASES) {
    await page.goto(config.path);
    const durations: number[] = [];
    for (const sample of config.samples) durations.push(await runSearch(page, config, sample.symbol, sample));
    report[config.market] = {
      count: durations.length,
      average: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      max: Math.max(...durations),
    };
  }

  const viewports = [320, 360, 390, 412, 430, 768, 1023, 1024, 1440];
  for (const width of viewports) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 });
    for (const config of CASES) {
      await page.goto(config.path);
      const input = page.getByRole('combobox', { name: '통합 자산 검색' });
      await expect(input).toBeEditable();
      await input.fill(config.samples[0].symbol);
      await expect(page.getByRole('option').filter({ hasText: config.samples[0].symbol }).first()).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      const box = await input.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    }
  }

  expect(Object.values(report).reduce((sum, item) => sum + item.count, 0)).toBe(100);
  expect(diagnostics.badFilters).toEqual([]);
  expect(diagnostics.forbidden).toEqual([]);
  console.log(`MARKET_ROOM_SEARCH_MOBILE_QA=${JSON.stringify(report)}`);
});
