import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Request, type TestInfo } from '@playwright/test';
import {
  installProductionReadOnlyPolicy,
  isIgnorableProductionRequestFailure,
} from './support/production-readonly-policy';

const baseUrl = String(process.env.PRODUCTION_BASE_URL ?? '').replace(/\/$/, '');
const qaLogin = String(process.env.PRODUCTION_QA_LOGIN ?? '');
const qaPassword = String(process.env.PRODUCTION_QA_PASSWORD ?? '');
const productionQaEnabled = Boolean(
  baseUrl
  && qaLogin
  && qaPassword
  && process.env.PRODUCTION_READONLY_E2E === 'true',
);
const productionOrigin = baseUrl ? new URL(baseUrl).origin : 'http://production-qa-disabled.invalid';

const ARTIFACT_DIR = path.resolve('production-comprehensive-artifacts');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

const FULL_ROUTES = [
  '/', '/stocks', '/stocks/kr', '/stocks/us', '/coins/spot', '/coins/futures',
  '/market-overview', '/market-rankings', '/market-browser', '/scanner', '/ai-chart',
  '/ai-chat', '/themes', '/news-information', '/learn', '/watchlist', '/alerts',
  '/portfolio', '/position', '/strategy-promotion', '/recommendations', '/backtests',
  '/paper-trading', '/account', '/more', '/settings',
  '/stock-info/analysis?asset=stock&market=KR&ticker=005930',
  '/stock-info/analysis?asset=stock&market=US&ticker=AAPL',
  '/stock-info?asset=coin&coinMarket=spot&symbol=BTC',
  '/stock-info?asset=coin&coinMarket=futures&symbol=BTCUSDT',
] as const;

const CRITICAL_ROUTES = [
  '/', '/stocks', '/scanner', '/ai-chart', '/paper-trading', '/portfolio', '/account',
  '/stock-info/analysis?asset=stock&market=KR&ticker=005930',
] as const;

const SEARCH_MATRIX: Record<'국내' | '미국' | '코인 현물' | '코인 선물', string[]> = {
  '국내': [
    '005930','000660','035420','035720','051910','006400','068270','005380','000270','105560',
    '055550','003550','012330','207940','028260','066570','096770','034730','017670','030200',
  ],
  '미국': [
    'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','AVGO','JPM','V',
    'MA','LLY','WMT','COST','NFLX','AMD','INTC','ORCL','CRM','QCOM',
  ],
  '코인 현물': [
    'BTC','ETH','XRP','SOL','DOGE','ADA','AVAX','LINK','DOT','BCH',
    'ETC','XLM','SUI','NEAR','APT','ARB','OP','STX','SEI','AAVE',
  ],
  '코인 선물': [
    'BTCUSDT','ETHUSDT','XRPUSDT','SOLUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','BCHUSDT',
    'ETCUSDT','XLMUSDT','SUIUSDT','NEARUSDT','APTUSDT','ARBUSDT','OPUSDT','STXUSDT','SEIUSDT','AAVEUSDT',
  ],
};

const TIMEFRAMES = ['1m','3m','5m','15m','30m','1H','4H','1D'] as const;
const CHART_MARKETS = ['KR','US','UPBIT','BITGET'] as const;

type Diagnostic = { kind: string; path: string; detail: string; status?: number };
type OverlapWarning = { a: string; b: string; ratio: number };
type RouteAudit = {
  route: string;
  finalUrl: string;
  loadMs: number;
  navigationError: string | null;
  fallbackTimedOut: boolean;
  busyAfter5s: number;
  horizontalOverflowPx: number;
  deadScrollContainers: number;
  scrollableContainers: number;
  overlapWarnings: OverlapWarning[];
  navOcclusionWarnings: OverlapWarning[];
  unnamedButtons: number;
  visibleButtons: number;
  visibleTabs: number;
};

type SearchAudit = {
  market: string;
  query: string;
  durationMs: number;
  resultCount: number;
  matched: boolean;
  outcome: string | null;
  sample: string[];
};

type ChartAudit = {
  market: string;
  timeframe: string;
  durationMs: number;
  requestStatuses: number[];
  terminal: 'canvas' | 'empty' | 'error' | 'timeout';
  finalUrl: string;
};

function slug(value: string) {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'root';
}

function writeJson(name: string, value: unknown) {
  fs.writeFileSync(path.join(ARTIFACT_DIR, name), JSON.stringify(value, null, 2), 'utf8');
}

function currentPath(page: Page) {
  try { return new URL(page.url()).pathname; } catch { return 'unknown'; }
}

function requestPath(rawUrl: string) {
  try { return new URL(rawUrl).pathname; } catch { return 'unknown'; }
}

function attachDiagnostics(page: Page, diagnostics: Diagnostic[]) {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    diagnostics.push({ kind: 'console', path: currentPath(page), detail: message.text().slice(0, 600) });
  });
  page.on('pageerror', (error) => {
    diagnostics.push({ kind: 'pageerror', path: currentPath(page), detail: error.message.slice(0, 600) });
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    let url: URL;
    try { url = new URL(response.url()); } catch { return; }
    if (url.origin !== productionOrigin) return;
    if (response.status() === 404 && /\/(?:manifest|favicon)/i.test(url.pathname)) return;
    diagnostics.push({
      kind: 'http',
      path: `${url.pathname}${url.search}`.slice(0, 500),
      status: response.status(),
      detail: `${response.request().method()} ${response.status()} ${response.statusText()}`,
    });
  });
  page.on('requestfailed', (request: Request) => {
    const failure = request.failure()?.errorText ?? 'request failed';
    if (isIgnorableProductionRequestFailure(request.url(), request.method(), failure, productionOrigin)) return;
    diagnostics.push({ kind: 'requestfailed', path: requestPath(request.url()), detail: `${request.method()} ${failure}` });
  });
}

async function installSafety(page: Page, blocked: Diagnostic[]) {
  await installProductionReadOnlyPolicy(page, productionOrigin, (request, reason) => {
    blocked.push({ kind: 'blocked-mutation', path: requestPath(request.url()), detail: `${reason}: ${request.method()}` });
  });
}

async function login(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await expect(page.getByTestId('page-fallback')).toHaveCount(0, { timeout: 10_000 });
  await page.getByLabel('아이디').fill(qaLogin, { timeout: 3_000 });
  await page.getByLabel('비밀번호').fill(qaPassword, { timeout: 3_000 });
  await page.getByRole('button', { name: '로그인', exact: true }).click({ timeout: 3_000 });
  await expect(page.getByTestId('membership-label')).toBeVisible({ timeout: 15_000 });
}

async function auditLayout(page: Page) {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      const style = getComputedStyle(element as HTMLElement);
      return rect.width > 1
        && rect.height > 1
        && style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number(style.opacity || '1') > 0.01;
    };
    const labelFor = (element: HTMLElement) => String(
      element.getAttribute('aria-label')
      || element.textContent
      || element.getAttribute('placeholder')
      || element.tagName,
    ).trim().replace(/\s+/g, ' ').slice(0, 80);
    const interactive = Array.from(
      document.querySelectorAll('button,a[href],input,select,textarea,[role="tab"],[role="button"]'),
    ).filter(visible) as HTMLElement[];
    const rects = interactive.map((el) => ({ el, rect: el.getBoundingClientRect(), label: labelFor(el) }))
      .filter((item) => item.rect.width >= 20 && item.rect.height >= 20);
    const overlap = (a: DOMRect, b: DOMRect) => {
      const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      if (!x || !y) return 0;
      const minArea = Math.min(a.width * a.height, b.width * b.height);
      return minArea > 0 ? (x * y) / minArea : 0;
    };
    const overlaps: OverlapWarning[] = [];
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i]; const b = rects[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const ratio = overlap(a.rect, b.rect);
        if (ratio >= 0.35) overlaps.push({ a: a.label || a.el.tagName, b: b.label || b.el.tagName, ratio: Number(ratio.toFixed(2)) });
      }
    }
    const nav = document.querySelector('nav[aria-label="주요 메뉴"]');
    const navRect = nav instanceof HTMLElement && visible(nav) ? nav.getBoundingClientRect() : null;
    const navOcclusionWarnings = navRect
      ? rects
        .filter(({ el }) => !nav?.contains(el))
        .map(({ rect, label }) => ({ a: '주요 메뉴', b: label, ratio: overlap(navRect, rect) }))
        .filter((item) => item.ratio >= 0.25)
        .map((item) => ({ ...item, ratio: Number(item.ratio.toFixed(2)) }))
        .slice(0, 20)
      : [];
    const scrollables = Array.from(document.querySelectorAll('*')).filter((element) => {
      if (!(element instanceof HTMLElement) || !visible(element)) return false;
      const style = getComputedStyle(element);
      return /(auto|scroll)/.test(style.overflowY)
        && element.scrollHeight > element.clientHeight + 8
        && element.clientHeight > 80;
    }) as HTMLElement[];
    let dead = 0;
    for (const element of scrollables.slice(0, 20)) {
      const before = element.scrollTop;
      element.scrollTop = Math.min(element.scrollHeight - element.clientHeight, Math.max(32, element.scrollHeight));
      if (element.scrollTop <= before) dead += 1;
      element.scrollTop = before;
    }
    const rootOverflow = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0) - window.innerWidth;
    const buttons = interactive.filter((el) => el.tagName === 'BUTTON');
    return {
      horizontalOverflowPx: Math.max(0, Math.round(rootOverflow)),
      deadScrollContainers: dead,
      scrollableContainers: scrollables.length,
      overlapWarnings: overlaps.slice(0, 20),
      navOcclusionWarnings,
      unnamedButtons: buttons.filter((el) => !String(el.getAttribute('aria-label') || el.textContent || '').trim()).length,
      visibleButtons: buttons.length,
      visibleTabs: interactive.filter((el) => el.getAttribute('role') === 'tab').length,
    };
  });
}

async function exerciseVisibleTabs(page: Page) {
  const failures: string[] = [];
  const initialCount = Math.min(await page.getByRole('tab').count(), 8);
  for (let index = 0; index < initialCount; index += 1) {
    const tab = page.getByRole('tab').nth(index);
    const visible = await tab.isVisible({ timeout: 1_000 }).catch(() => false);
    const disabled = await tab.isDisabled({ timeout: 1_000 }).catch(() => true);
    if (!visible || disabled) continue;
    const label = String(
      await tab.getAttribute('aria-label', { timeout: 1_000 }).catch(() => null)
      ?? await tab.textContent({ timeout: 1_000 }).catch(() => null)
      ?? `tab-${index}`,
    ).trim();
    const clicked = await tab.click({ timeout: 2_000 }).then(() => true).catch((error) => {
      failures.push(`${label}: click failed: ${String(error).slice(0, 160)}`);
      return false;
    });
    if (!clicked) continue;
    await page.waitForTimeout(100);
    const selected = await page.getByRole('tab').nth(index)
      .getAttribute('aria-selected', { timeout: 1_500 })
      .catch(() => null);
    if (selected === 'false') failures.push(`${label}: click did not select tab`);
    if (selected == null) failures.push(`${label}: tab disappeared or did not expose selected state after click`);
  }
  return failures;
}

async function auditRoute(page: Page, route: string, testInfo: TestInfo): Promise<RouteAudit> {
  const started = Date.now();
  let navigationError: string | null = null;
  let fallbackTimedOut = false;
  await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch((error) => {
    navigationError = String(error).slice(0, 240);
  });
  if (!page.isClosed()) {
    try {
      await expect(page.getByTestId('page-fallback')).toHaveCount(0, { timeout: 5_000 });
    } catch {
      fallbackTimedOut = true;
    }
  }
  const busy = page.locator('[aria-busy="true"]:visible');
  if (!page.isClosed() && await busy.count()) {
    await expect(busy).toHaveCount(0, { timeout: 5_000 }).catch(() => undefined);
  }
  const busyAfter5s = page.isClosed() ? -1 : await busy.count().catch(() => -1);
  const layout = page.isClosed() ? {
    horizontalOverflowPx: -1,
    deadScrollContainers: -1,
    scrollableContainers: 0,
    overlapWarnings: [] as OverlapWarning[],
    navOcclusionWarnings: [] as OverlapWarning[],
    unnamedButtons: 0,
    visibleButtons: 0,
    visibleTabs: 0,
  } : await auditLayout(page);
  const routePath = baseUrl ? new URL(route, baseUrl).pathname : route;
  const screenshotTargets = ['/stocks','/scanner','/ai-chart','/paper-trading','/portfolio','/account','/stock-info/analysis'];
  if (!page.isClosed() && screenshotTargets.includes(routePath)) {
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, `${slug(testInfo.project.name)}-${slug(routePath)}.png`),
      fullPage: false,
      timeout: 4_000,
    }).catch(() => undefined);
  }
  return {
    route,
    finalUrl: page.isClosed() ? '[PAGE_CLOSED]' : page.url(),
    loadMs: Date.now() - started,
    navigationError,
    fallbackTimedOut,
    busyAfter5s,
    ...layout,
  };
}

async function ensureSearchPage(page: Page) {
  await page.goto('/stocks', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await expect(page.getByTestId('unified-asset-search-page')).toBeVisible({ timeout: 10_000 });
}

async function searchMatrix(
  page: Page,
  labels: Array<keyof typeof SEARCH_MATRIX>,
  perMarket: number,
  onProgress: (audits: SearchAudit[]) => void,
): Promise<SearchAudit[]> {
  await ensureSearchPage(page);
  const results: SearchAudit[] = [];
  for (const label of labels) {
    let marketButton = page.getByRole('button', { name: label, exact: true });
    if (!(await marketButton.isVisible({ timeout: 1_500 }).catch(() => false))) {
      results.push({ market: label, query: '[MARKET_TAB_MISSING]', durationMs: 0, resultCount: 0, matched: false, outcome: 'MARKET_TAB_MISSING', sample: [] });
      onProgress(results);
      continue;
    }
    await marketButton.click({ timeout: 2_000 }).catch(() => undefined);
    await expect(marketButton).toHaveAttribute('aria-pressed', 'true', { timeout: 2_000 }).catch(() => undefined);
    for (const query of SEARCH_MATRIX[label].slice(0, perMarket)) {
      const started = Date.now();
      let outcome: string | null = null;
      let optionTexts: string[] = [];
      try {
        let input = page.getByRole('combobox', { name: '통합 자산 검색' });
        await input.fill(query, { timeout: 2_000 });
        await page.waitForTimeout(220);
        await expect.poll(async () => {
          const loading = await page.getByTestId('unified-search-skeleton').isVisible({ timeout: 250 }).catch(() => false)
            || await page.getByTestId('unified-search-refreshing').isVisible({ timeout: 250 }).catch(() => false);
          if (loading) return 'loading';
          if (await page.getByRole('option').count()) return 'terminal';
          if (await page.getByTestId('unified-search-outcome').isVisible({ timeout: 250 }).catch(() => false)) return 'terminal';
          return 'pending';
        }, { timeout: 5_000, intervals: [100, 200, 400, 800] }).toBe('terminal');
        optionTexts = (await page.getByRole('option').allTextContents().catch(() => []))
          .map((item) => item.replace(/\s+/g, ' ').trim());
        outcome = (await page.getByTestId('unified-search-outcome').textContent({ timeout: 500 }).catch(() => null))?.trim() ?? null;
        await input.fill('', { timeout: 1_500 }).catch(() => undefined);
      } catch (error) {
        outcome = `QA_QUERY_TIMEOUT_OR_UI_ERROR: ${String(error).split('\n')[0].slice(0, 220)}`;
        if (!page.isClosed()) {
          await ensureSearchPage(page).catch(() => undefined);
          marketButton = page.getByRole('button', { name: label, exact: true });
          await marketButton.click({ timeout: 1_500 }).catch(() => undefined);
        }
      }
      const needle = query.replace(/[^A-Z0-9]/gi, '').toUpperCase();
      const matched = optionTexts.some((item) => item.replace(/[^A-Z0-9]/gi, '').toUpperCase().includes(needle));
      results.push({
        market: label,
        query,
        durationMs: Date.now() - started,
        resultCount: optionTexts.length,
        matched,
        outcome,
        sample: optionTexts.slice(0, 3),
      });
      onProgress(results);
      await page.waitForTimeout(80).catch(() => undefined);
    }
  }
  return results;
}

function responseMatchesChart(rawUrl: string, market: string, timeframe: string) {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  if (market === 'KR' || market === 'US') {
    return /\/api\/stocks\/[^/]+\/(?:chart|candles)$/.test(url.pathname) && url.searchParams.get('tf') === timeframe;
  }
  if (market === 'BITGET') {
    return url.pathname === '/api/crypto/futures/candles' && url.searchParams.get('granularity') === timeframe;
  }
  if (url.pathname !== '/api/crypto/spot/candles') return false;
  if (timeframe === '1D') return url.searchParams.get('tf') === '1D';
  const units: Record<string,string> = { '1m':'1','3m':'3','5m':'5','15m':'15','30m':'30','1H':'60','4H':'240' };
  return url.searchParams.get('unit') === units[timeframe];
}

async function chartMatrix(page: Page, onProgress: (audits: ChartAudit[]) => void): Promise<ChartAudit[]> {
  await page.goto('/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m', {
    waitUntil: 'domcontentloaded',
    timeout: 15_000,
  });
  await expect(page.getByTestId('unified-chart-wrapper')).toBeVisible({ timeout: 12_000 });
  const audits: ChartAudit[] = [];
  for (const market of CHART_MARKETS) {
    await page.getByTestId(`market-${market}`).click({ timeout: 2_500 }).catch(() => undefined);
    await expect(page).toHaveURL(new RegExp(`market=${market}`), { timeout: 4_000 }).catch(() => undefined);
    for (const timeframe of TIMEFRAMES) {
      const statuses: number[] = [];
      const listener = (response: { url(): string; status(): number }) => {
        if (responseMatchesChart(response.url(), market, timeframe)) statuses.push(response.status());
      };
      page.on('response', listener);
      const started = Date.now();
      let terminal: ChartAudit['terminal'] = 'timeout';
      try {
        await page.getByTestId(`timeframe-${timeframe}`).click({ timeout: 2_500 });
        await expect(page).toHaveURL(new RegExp(`timeframe=${timeframe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), { timeout: 3_000 }).catch(() => undefined);
        terminal = await expect.poll(async () => {
          if (await page.getByTestId('unified-chart-canvas').isVisible({ timeout: 200 }).catch(() => false)) return 'canvas';
          if (await page.getByTestId('chart-empty-state').isVisible({ timeout: 200 }).catch(() => false)) return 'empty';
          if (await page.getByTestId('chart-error-state').isVisible({ timeout: 200 }).catch(() => false)) return 'error';
          return 'timeout';
        }, { timeout: 8_500, intervals: [100, 250, 500, 1_000] }).not.toBe('timeout').then(async () => {
          if (await page.getByTestId('unified-chart-canvas').isVisible({ timeout: 200 }).catch(() => false)) return 'canvas' as const;
          if (await page.getByTestId('chart-empty-state').isVisible({ timeout: 200 }).catch(() => false)) return 'empty' as const;
          if (await page.getByTestId('chart-error-state').isVisible({ timeout: 200 }).catch(() => false)) return 'error' as const;
          return 'timeout' as const;
        }).catch(() => 'timeout' as const);
      } finally {
        page.off('response', listener);
      }
      audits.push({ market, timeframe, durationMs: Date.now() - started, requestStatuses: statuses, terminal, finalUrl: page.url() });
      onProgress(audits);
      await page.waitForTimeout(100);
    }
  }
  return audits;
}

test.describe('Production comprehensive read-only QA', () => {
  test.skip(!productionQaEnabled, 'Dedicated Production QA credentials and read-only flag are required');

  test('Production route, layout, overlap, scroll, and safe-tab audit', async ({ page }, testInfo) => {
    const full = testInfo.project.name === 'prod-desktop-1440' || testInfo.project.name === 'prod-mobile-390';
    test.setTimeout(full ? 7 * 60_000 : 4 * 60_000);
    const diagnostics: Diagnostic[] = [];
    const blocked: Diagnostic[] = [];
    attachDiagnostics(page, diagnostics);
    await installSafety(page, blocked);
    await login(page);
    const routes = full ? FULL_ROUTES : CRITICAL_ROUTES;
    const audits: RouteAudit[] = [];
    const tabFailures: Array<{ route: string; failures: string[] }> = [];
    for (const route of routes) {
      const audit = await auditRoute(page, route, testInfo);
      audits.push(audit);
      writeJson(`${slug(testInfo.project.name)}-routes.json`, { project: testInfo.project.name, audits, tabFailures, diagnostics, blocked, complete: false });
      if (!page.isClosed() && CRITICAL_ROUTES.some((critical) => new URL(critical, baseUrl).pathname === new URL(route, baseUrl).pathname)) {
        const failures = await exerciseVisibleTabs(page);
        if (failures.length) tabFailures.push({ route, failures });
      }
    }
    writeJson(`${slug(testInfo.project.name)}-routes.json`, { project: testInfo.project.name, audits, tabFailures, diagnostics, blocked, complete: true });
    expect(blocked, 'Production QA attempted a blocked mutation').toEqual([]);
    expect(audits.filter((item) => item.navigationError), 'route navigation failed').toEqual([]);
    expect(audits.filter((item) => item.fallbackTimedOut), 'route fallback exceeded 5s').toEqual([]);
    expect(audits.filter((item) => item.busyAfter5s > 0), 'visible aria-busy remained after 5s').toEqual([]);
    expect(audits.filter((item) => item.horizontalOverflowPx > 2), 'horizontal overflow detected').toEqual([]);
    expect(audits.filter((item) => item.deadScrollContainers > 0), 'scroll container could not move').toEqual([]);
    expect(audits.filter((item) => item.navOcclusionWarnings.length > 0), 'fixed navigation occludes interactive content').toEqual([]);
    expect(tabFailures, 'safe role=tab click failed').toEqual([]);
    expect(diagnostics.filter((item) => item.kind === 'pageerror' || item.kind === 'requestfailed'), 'browser/runtime failures detected').toEqual([]);
  });

  test('Production market search matrix uses real UI and dozens of symbols', async ({ page }, testInfo) => {
    test.skip(!['prod-desktop-1440','prod-mobile-390'].includes(testInfo.project.name));
    test.setTimeout(testInfo.project.name === 'prod-desktop-1440' ? 10 * 60_000 : 4 * 60_000);
    const diagnostics: Diagnostic[] = [];
    const blocked: Diagnostic[] = [];
    attachDiagnostics(page, diagnostics);
    await installSafety(page, blocked);
    await login(page);
    const perMarket = testInfo.project.name === 'prod-desktop-1440' ? 20 : 5;
    const filename = `${slug(testInfo.project.name)}-search.json`;
    const audits = await searchMatrix(page, ['국내','미국','코인 현물','코인 선물'], perMarket, (progress) => {
      writeJson(filename, { project: testInfo.project.name, audits: progress, diagnostics, blocked, complete: false });
    });
    writeJson(filename, { project: testInfo.project.name, audits, diagnostics, blocked, complete: true });
    expect(blocked, 'search QA attempted a blocked mutation').toEqual([]);
    expect(audits.filter((item) => !item.matched), 'search query did not return the requested market symbol').toEqual([]);
    expect(audits.filter((item) => item.durationMs > 5_500), 'search exceeded user-visible budget').toEqual([]);
    expect(diagnostics.filter((item) => item.kind === 'pageerror' || item.kind === 'requestfailed'), 'search browser failures detected').toEqual([]);
  });

  test('Production chart matrix checks 4 markets x 8 timeframes and chart controls', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'prod-desktop-1440');
    test.setTimeout(7 * 60_000);
    const diagnostics: Diagnostic[] = [];
    const blocked: Diagnostic[] = [];
    attachDiagnostics(page, diagnostics);
    await installSafety(page, blocked);
    await login(page);
    const filename = `${slug(testInfo.project.name)}-charts.json`;
    const audits = await chartMatrix(page, (progress) => {
      writeJson(filename, { project: testInfo.project.name, audits: progress, diagnostics, blocked, complete: false });
    });
    await page.getByTestId('chart-fit-content').click({ timeout: 1_500 }).catch(() => undefined);
    await page.getByTestId('chart-latest-candle').click({ timeout: 1_500 }).catch(() => undefined);
    await page.getByRole('button', { name: /지표 설정/ }).click({ timeout: 1_500 }).catch(() => undefined);
    await page.getByTestId('overlay-sma20').click({ timeout: 1_500 }).catch(() => undefined);
    writeJson(filename, { project: testInfo.project.name, audits, diagnostics, blocked, complete: true });
    expect(blocked, 'chart QA attempted a blocked mutation').toEqual([]);
    expect(audits.filter((item) => item.terminal !== 'canvas'), 'chart did not render valid candles').toEqual([]);
    expect(audits.filter((item) => item.durationMs > 9_500), 'chart exceeded bounded transport/UI deadline').toEqual([]);
    expect(audits.filter((item) => item.requestStatuses.length === 0), 'chart changed without observable market-data request').toEqual([]);
    expect(diagnostics.filter((item) => item.kind === 'pageerror' || item.kind === 'requestfailed'), 'chart browser failures detected').toEqual([]);
  });
});
