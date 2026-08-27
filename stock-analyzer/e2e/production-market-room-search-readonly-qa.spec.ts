import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { installProductionReadOnlyPolicy } from './support/production-readonly-policy';

const baseUrl = String(process.env.PRODUCTION_BASE_URL ?? '').replace(/\/$/, '');
const qaLogin = String(process.env.PRODUCTION_QA_LOGIN ?? '');
const qaPassword = String(process.env.PRODUCTION_QA_PASSWORD ?? '');
const productionOrigin = baseUrl ? new URL(baseUrl).origin : 'http://production-qa-disabled.invalid';
const enabled = Boolean(baseUrl && qaLogin && qaPassword && process.env.PRODUCTION_READONLY_E2E === 'true');
const ARTIFACT_DIR = path.resolve('production-comprehensive-artifacts');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

type Market = 'KR' | 'US' | 'spot' | 'futures';
type MarketCase = { path: string; market: Market; asset: 'stock' | 'coin'; symbols: string[] };
type SearchRow = {
  market: Market;
  query: string;
  matched: boolean;
  resultCount: number;
  firstResult: string | null;
  durationMs: number;
  timeout: boolean;
  providerState: string;
  stale: boolean;
  partial: boolean;
  wrongMarket: boolean;
};

const CASES: MarketCase[] = [
  {
    path: '/stocks/kr', market: 'KR', asset: 'stock',
    symbols: ['005930','000660','005380','000270','005490','035420','035720','373220','068270','207940','051910','006400','028260','012330','066570','003670','096770','034730','015760','032830','086790','105560','055550','316140','024110'],
  },
  {
    path: '/stocks/us', market: 'US', asset: 'stock',
    symbols: ['AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','PLTR','RGTI','ORCL','ADBE','CRM','INTC','AMD','QCOM','TXN','IBM','CSCO','NOW','INTU','PANW','SNOW','AVGO','MU','F'],
  },
  {
    path: '/coins/spot', market: 'spot', asset: 'coin',
    symbols: ['BTC','ETH','XRP','SOL','DOGE','ADA','AVAX','LINK','DOT','TRX','BCH','ETC','XLM','HBAR','SUI','APT','NEAR','UNI','AAVE','ARB','OP','SHIB','STX','ATOM','LTC'],
  },
  {
    path: '/coins/futures', market: 'futures', asset: 'coin',
    symbols: ['BTCUSDT','ETHUSDT','XRPUSDT','SOLUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','TRXUSDT','BCHUSDT','ETCUSDT','XLMUSDT','HBARUSDT','SUIUSDT','APTUSDT','NEARUSDT','UNIUSDT','AAVEUSDT','ARBUSDT','OPUSDT','SHIBUSDT','STXUSDT','ATOMUSDT','LTCUSDT'],
  },
];

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

async function login(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await page.getByLabel('아이디').fill(qaLogin, { timeout: 3_000 });
  await page.getByLabel('비밀번호').fill(qaPassword, { timeout: 3_000 });
  await page.getByRole('button', { name: '로그인', exact: true }).click({ timeout: 3_000 });
  await expect(page.getByTestId('membership-label')).toBeVisible({ timeout: 15_000 });
}

async function runSearch(page: Page, config: MarketCase, query: string): Promise<SearchRow> {
  const input = page.getByRole('combobox', { name: '통합 자산 검색' });
  const started = Date.now();
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.origin === productionOrigin
      && url.pathname === '/api/search/suggest'
      && url.searchParams.get('market') === config.market
      && url.searchParams.get('asset') === config.asset
      && (url.searchParams.get('q') ?? '').trim().toUpperCase() === query.trim().toUpperCase();
  }, { timeout: 3_000 }).catch(() => null);

  await input.fill(query);
  const response = await responsePromise;
  const durationMs = Date.now() - started;
  if (!response) {
    return {
      market: config.market, query, matched: false, resultCount: 0, firstResult: null,
      durationMs, timeout: true, providerState: 'TIMEOUT', stale: false, partial: false, wrongMarket: false,
    };
  }

  const payload = await response.json().catch(() => ({})) as {
    state?: string;
    results?: Array<{ market?: string; ticker?: string; symbol?: string; productCode?: string; baseSymbol?: string }>;
    stale?: boolean;
    partial?: boolean;
  };
  const results = Array.isArray(payload.results) ? payload.results : [];
  const normalizedQuery = query.toUpperCase();
  const matched = results.some((item) => [item.ticker, item.symbol, item.productCode, item.baseSymbol]
    .filter(Boolean).some((value) => String(value).toUpperCase() === normalizedQuery
      || String(value).toUpperCase().replace(/^(?:KRW-)/, '') === normalizedQuery
      || `${String(value).toUpperCase()}USDT` === normalizedQuery));
  const wrongMarket = results.some((item) => item.market !== config.market);
  const first = results[0];
  const firstResult = first ? String(first.ticker ?? first.symbol ?? first.productCode ?? first.baseSymbol ?? '') : null;
  return {
    market: config.market,
    query,
    matched,
    resultCount: results.length,
    firstResult,
    durationMs,
    timeout: false,
    providerState: String(payload.state ?? response.status()),
    stale: payload.stale === true,
    partial: payload.partial === true,
    wrongMarket,
  };
}

async function prepare(page: Page, blocked: string[]) {
  await installProductionReadOnlyPolicy(page, productionOrigin, (request, reason) => {
    blocked.push(`${reason}: ${request.method()} ${request.url()}`);
  });
  await login(page);
}

test.describe('production four-market room search read-only P0', () => {
  test.skip(!enabled, 'Production read-only QA credentials are required.');

  test('actual market-room search matrix and performance evidence', async ({ page }, testInfo) => {
    const width = testInfo.project.use.viewport?.width ?? 0;
    const isDesktopSample = width === 1440;
    const isMobileSample = width === 390;
    test.skip(!isDesktopSample && !isMobileSample, 'Bulk search sample runs only at 1440 and 390 widths.');

    const blocked: string[] = [];
    await prepare(page, blocked);
    const rows: SearchRow[] = [];
    const cycles = isDesktopSample ? 4 : 1;

    for (const config of CASES) {
      await page.goto(config.path, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      const input = page.getByRole('combobox', { name: '통합 자산 검색' });
      await expect(input).toBeEditable({ timeout: 5_000 });
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        for (const symbol of config.symbols) {
          const row = await runSearch(page, config, symbol);
          rows.push(row);
          await page.waitForTimeout(450);
        }
      }
      const negative = await runSearch(page, config, `ZZZ-NOT-REAL-${config.market}`);
      expect(negative.timeout).toBe(false);
      expect(negative.wrongMarket).toBe(false);
      await page.waitForTimeout(450);
    }

    const expectedCount = isDesktopSample ? 400 : 100;
    expect(rows).toHaveLength(expectedCount);
    expect(rows.filter((row) => !row.matched), JSON.stringify(rows.filter((row) => !row.matched).slice(0, 20), null, 2)).toEqual([]);
    expect(rows.filter((row) => row.wrongMarket), JSON.stringify(rows.filter((row) => row.wrongMarket).slice(0, 20), null, 2)).toEqual([]);
    expect(rows.filter((row) => row.timeout), JSON.stringify(rows.filter((row) => row.timeout).slice(0, 20), null, 2)).toEqual([]);
    expect(rows.filter((row) => row.durationMs >= 3_000), JSON.stringify(rows.filter((row) => row.durationMs >= 3_000).slice(0, 20), null, 2)).toEqual([]);
    expect(blocked).toEqual([]);

    const summary = Object.fromEntries(CASES.map((config) => {
      const durations = rows.filter((row) => row.market === config.market).map((row) => row.durationMs);
      return [config.market, {
        count: durations.length,
        average: Math.round(durations.reduce((sum, value) => sum + value, 0) / Math.max(1, durations.length)),
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
        max: Math.max(...durations),
      }];
    }));
    const suffix = isDesktopSample ? 'desktop-400' : 'mobile-100';
    fs.writeFileSync(path.join(ARTIFACT_DIR, `market-room-search-${suffix}.json`), JSON.stringify({ rows, summary }, null, 2), 'utf8');
    console.log(`PRODUCTION_MARKET_ROOM_SEARCH_QA=${JSON.stringify({ sample: suffix, summary })}`);
  });

  test('all required widths keep search usable without horizontal overflow or bottom-nav occlusion', async ({ page }) => {
    const blocked: string[] = [];
    await prepare(page, blocked);
    for (const config of CASES) {
      await page.goto(config.path, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      const input = page.getByRole('combobox', { name: '통합 자산 검색' });
      await expect(input).toBeEditable({ timeout: 5_000 });
      await input.fill(config.symbols[0]);
      await expect(page.getByRole('listbox', { name: '통합 자산 자동완성 결과' })).toBeVisible({ timeout: 3_000 });
      const geometry = await page.evaluate(() => {
        const search = document.querySelector('[aria-label="통합 자산 검색"]') as HTMLElement | null;
        const listbox = document.querySelector('[aria-label="통합 자산 자동완성 결과"]') as HTMLElement | null;
        const nav = document.querySelector('nav[aria-label="하단 내비게이션"], nav.fixed, nav[class*="fixed"]') as HTMLElement | null;
        const inputRect = search?.getBoundingClientRect();
        const listRect = listbox?.getBoundingClientRect();
        const navRect = nav?.getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          inputInside: Boolean(inputRect && inputRect.left >= -1 && inputRect.right <= window.innerWidth + 1),
          listInside: Boolean(listRect && listRect.left >= -1 && listRect.right <= window.innerWidth + 1),
          navOverlap: Boolean(listRect && navRect && listRect.bottom > navRect.top && listRect.top < navRect.bottom),
        };
      });
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      expect(geometry.inputInside).toBe(true);
      expect(geometry.listInside).toBe(true);
      expect(geometry.navOverlap).toBe(false);
    }
    expect(blocked).toEqual([]);
  });
});
