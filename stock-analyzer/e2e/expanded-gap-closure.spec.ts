import { expect, test, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { answerAiChat } from '../../api-server/src/services/ai-chat.service';
import { MarketInformationService } from '../../api-server/src/services/market-information.service';
import type {
  MarketInformationAssetRow,
  MarketInformationMeta,
  MarketInformationResponse,
  MarketInformationRoomId,
} from '../../api-server/src/services/market-information.contract';

const NOW = '2026-08-11T03:30:00.000Z';

function analyzerRoot(): string {
  return path.basename(process.cwd()) === 'stock-analyzer'
    ? process.cwd()
    : path.resolve(process.cwd(), 'stock-analyzer');
}

function fulfill(route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    headers,
    body: JSON.stringify(body),
  });
}

test('scanner manual polling visibility and unchanged-condition consumers share one same-key upstream owner', async ({ page }) => {
  const source = await readFile(path.resolve(analyzerRoot(), 'src/pages/signal-scanner.tsx'), 'utf8');
  expect(source).toMatch(/window\.setInterval\(\(\) => \{\s*if \(document\.visibilityState === 'visible'\) setRefreshToken\(\(value\) => value \+ 1\);\s*\}, 30_000\);/);
  expect(source).toContain("document.addEventListener('visibilitychange', refreshWhenVisible)");
  expect(source).toContain('onClick={() => setRefreshToken((value) => value + 1)}');
  expect(source).toContain('fetchSignalScanner(request, controller.signal)');

  await page.goto('/');
  const result = await page.evaluate(async () => {
    const scanner = await import('/src/lib/signal-scanner.ts');
    const originalFetch = window.fetch;
    let upstreamCalls = 0;
    let releaseUpstream: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { releaseUpstream = resolve; });
    const request = {
      assetClass: 'stock' as const,
      market: 'KR' as const,
      strategy: 'swing' as const,
      timeframe: '1D' as const,
      conditions: [],
      condition: 'trend' as const,
      cursor: 901,
      batchSize: 10,
      minimumScore: 60,
      maximumRiskScore: 70,
    };
    const payload = {
      ok: true,
      provider: 'fixture',
      searchRunId: 'same-key:1',
      requestId: 'same-key:1',
      assetClass: 'stock',
      timeframe: '1D',
      market: 'KR',
      supportedIndicators: [],
      rows: [],
      cards: [{ signalId: 'same-key-card', warnings: [], dataState: 'complete' }],
      results: [],
      alerts: [],
      failures: [],
      execution: { requestedCount: 1, startedCount: 1, completedCount: 1, excludedCount: 0, providerErrorCount: 0, timeoutCount: 0, partial: false, timedOut: false, cancelled: false, duplicate: false, elapsedMs: 1, deadlineMs: 12_000, itemTimeoutMs: 3_500, maxConcurrency: 1 },
      universe: { totalCount: 1, cursor: 901, nextCursor: null, source: 'fixture', partial: false, stale: false, listingStatusCoverage: 'listed-or-unknown' },
      dataState: 'complete',
      message: 'same-key fixture',
      generatedAt: '2026-08-11T03:30:00.000Z',
      orderSubmitted: false,
      exchangeRequestSent: false,
    };

    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes('/api/market/scan')) return originalFetch(input, init);
      upstreamCalls += 1;
      await gate;
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    try {
      const consumers = [
        new AbortController(), // manual refresh
        new AbortController(), // polling tick
        new AbortController(), // visibility resume
        new AbortController(), // unchanged-condition polling tick
      ];
      const promises = consumers.map((controller) => scanner.fetchSignalScanner(request, controller.signal));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const whileInFlight = upstreamCalls;
      releaseUpstream?.();
      const responses = await Promise.all(promises);
      return {
        whileInFlight,
        finalCalls: upstreamCalls,
        ids: responses.map((item) => item.requestId),
      };
    } finally {
      window.fetch = originalFetch;
    }
  });

  expect(result.whileInFlight).toBe(1);
  expect(result.finalCalls).toBe(1);
  expect(result.ids).toEqual(['same-key:1', 'same-key:1', 'same-key:1', 'same-key:1']);
});

test('scanner 409 429 and 502 preserve last-good data and Retry-After blocks an immediate upstream retry', async ({ page }) => {
  const failedRequests: string[] = [];
  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText ?? '';
    if (!reason.includes('ERR_ABORTED')) failedRequests.push(`${request.method()} ${new URL(request.url()).pathname} ${reason}`);
  });

  await page.goto('/');
  const result = await page.evaluate(async () => {
    const scanner = await import('/src/lib/signal-scanner.ts');
    const originalFetch = window.fetch;
    const callsByCursor = new Map<number, number>();
    const errorByCursor = new Map<number, { status: number; code: string; retryAfter?: number }>([
      [911, { status: 409, code: 'SCAN_DUPLICATE_REQUEST' }],
      [912, { status: 429, code: 'SCAN_RATE_LIMITED', retryAfter: 5 }],
      [913, { status: 502, code: 'PROVIDER_UNAVAILABLE' }],
    ]);

    const request = (cursor: number) => ({
      assetClass: 'stock' as const,
      market: 'KR' as const,
      strategy: 'swing' as const,
      timeframe: '1D' as const,
      conditions: [],
      condition: 'trend' as const,
      cursor,
      batchSize: 10,
      minimumScore: 60,
      maximumRiskScore: 70,
    });
    const successPayload = (cursor: number) => ({
      ok: true,
      provider: 'fixture',
      searchRunId: `last-good:${cursor}`,
      requestId: `last-good:${cursor}`,
      assetClass: 'stock', timeframe: '1D', market: 'KR', supportedIndicators: [], rows: [],
      cards: [{ signalId: `card:${cursor}`, warnings: [], dataState: 'complete' }],
      results: [], alerts: [], failures: [],
      execution: { requestedCount: 1, startedCount: 1, completedCount: 1, excludedCount: 0, providerErrorCount: 0, timeoutCount: 0, partial: false, timedOut: false, cancelled: false, duplicate: false, elapsedMs: 1, deadlineMs: 12_000, itemTimeoutMs: 3_500, maxConcurrency: 1 },
      universe: { totalCount: 1, cursor, nextCursor: null, source: 'fixture', partial: false, stale: false, listingStatusCoverage: 'listed-or-unknown' },
      dataState: 'complete', message: `last-good ${cursor}`, generatedAt: '2026-08-11T03:30:00.000Z', orderSubmitted: false, exchangeRequestSent: false,
    });

    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes('/api/market/scan')) return originalFetch(input, init);
      const cursor = Number(new URL(url, window.location.origin).searchParams.get('cursor'));
      const calls = (callsByCursor.get(cursor) ?? 0) + 1;
      callsByCursor.set(cursor, calls);
      if (calls === 1) {
        return new Response(JSON.stringify(successPayload(cursor)), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const error = errorByCursor.get(cursor)!;
      return new Response(JSON.stringify({ ok: false, error: error.code, retryAfterSeconds: error.retryAfter ?? null }), {
        status: error.status,
        headers: {
          'content-type': 'application/json',
          ...(error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}),
        },
      });
    };

    try {
      const run = async (cursor: number) => {
        const first = await scanner.fetchSignalScanner(request(cursor), new AbortController().signal);
        const second = await scanner.fetchSignalScanner(request(cursor), new AbortController().signal);
        return { first, second, calls: callsByCursor.get(cursor) ?? 0 };
      };
      const duplicate = await run(911);
      const rate = await run(912);
      const provider = await run(913);
      const callsBeforeBackoffRetry = callsByCursor.get(912) ?? 0;
      const rateBackoff = await scanner.fetchSignalScanner(request(912), new AbortController().signal);
      const callsAfterBackoffRetry = callsByCursor.get(912) ?? 0;
      return {
        duplicate: { calls: duplicate.calls, issue: duplicate.second.refreshIssue, state: duplicate.second.dataState, card: duplicate.second.cards[0] },
        rate: { calls: rate.calls, issue: rate.second.refreshIssue, state: rate.second.dataState, card: rate.second.cards[0] },
        provider: { calls: provider.calls, issue: provider.second.refreshIssue, state: provider.second.dataState, card: provider.second.cards[0] },
        rateBackoff: { issue: rateBackoff.refreshIssue, state: rateBackoff.dataState, card: rateBackoff.cards[0], callsBeforeBackoffRetry, callsAfterBackoffRetry },
      };
    } finally {
      window.fetch = originalFetch;
    }
  });

  expect(result.duplicate.calls).toBe(2);
  expect(result.duplicate.issue).toMatchObject({ status: 409, code: 'SCAN_DUPLICATE_REQUEST' });
  expect(result.duplicate.state).toBe('stale');
  expect(result.duplicate.card.signalId).toBe('card:911');
  expect(result.duplicate.card.dataState).toBe('stale');

  expect(result.rate.calls).toBe(2);
  expect(result.rate.issue).toMatchObject({ status: 429, code: 'SCAN_RATE_LIMITED', retryAfterSeconds: 5 });
  expect(result.rate.state).toBe('stale');
  expect(result.rate.card.signalId).toBe('card:912');
  expect(result.rateBackoff.callsBeforeBackoffRetry).toBe(2);
  expect(result.rateBackoff.callsAfterBackoffRetry).toBe(2);
  expect(result.rateBackoff.issue).toMatchObject({ status: 429, code: 'SCAN_RATE_LIMIT_BACKOFF' });
  expect(result.rateBackoff.card.signalId).toBe('card:912');

  expect(result.provider.calls).toBe(2);
  expect(result.provider.issue).toMatchObject({ status: 502, code: 'PROVIDER_UNAVAILABLE' });
  expect(result.provider.state).toBe('stale');
  expect(result.provider.card.signalId).toBe('card:913');
  expect(failedRequests).toEqual([]);
});

type SearchFixture = {
  id: string;
  assetType: 'stock' | 'coin';
  market: string;
  instrumentType: 'stock' | 'spot' | 'futures';
  exchange: string;
  ticker?: string;
  symbol?: string;
  productCode: string;
  displayName: string;
  koreanName: string;
  englishName: string;
  baseSymbol: string;
  quoteCurrency: string;
  matchType: string;
  active: boolean;
  provider: string;
  dataAsOf: string;
};

const SEARCH_FIXTURES: SearchFixture[] = [
  { id: 'stock:KR:KOSPI:005930', assetType: 'stock', market: 'KR', instrumentType: 'stock', exchange: 'KOSPI', ticker: '005930', productCode: '005930', displayName: '삼성전자', koreanName: '삼성전자', englishName: 'Samsung Electronics', baseSymbol: '005930', quoteCurrency: 'KRW', matchType: 'code_exact', active: true, provider: 'KRX', dataAsOf: NOW },
  { id: 'stock:US:NASDAQ:AAPL', assetType: 'stock', market: 'US', instrumentType: 'stock', exchange: 'NASDAQ', ticker: 'AAPL', productCode: 'AAPL', displayName: '애플', koreanName: '애플', englishName: 'Apple', baseSymbol: 'AAPL', quoteCurrency: 'USD', matchType: 'code_exact', active: true, provider: 'FINNHUB', dataAsOf: NOW },
  { id: 'coin:spot:UPBIT:KRW-BTC', assetType: 'coin', market: 'spot', instrumentType: 'spot', exchange: 'UPBIT', symbol: 'BTC', productCode: 'KRW-BTC', displayName: '비트코인', koreanName: '비트코인', englishName: 'Bitcoin', baseSymbol: 'BTC', quoteCurrency: 'KRW', matchType: 'code_exact', active: true, provider: 'UPBIT', dataAsOf: NOW },
  { id: 'coin:futures:BITGET:BTCUSDT', assetType: 'coin', market: 'futures', instrumentType: 'futures', exchange: 'BITGET', symbol: 'BTCUSDT', productCode: 'BTCUSDT', displayName: '비트코인', koreanName: '비트코인', englishName: 'Bitcoin', baseSymbol: 'BTC', quoteCurrency: 'USDT', matchType: 'code_exact', active: true, provider: 'BITGET', dataAsOf: NOW },
];

async function mockUnifiedSearch(page: Page) {
  await page.route('**/api/search/suggest**', async (route) => {
    const q = (new URL(route.request().url()).searchParams.get('q') ?? '').toUpperCase().replace(/[\s/.-]/g, '');
    const results = SEARCH_FIXTURES.filter((item) => [item.ticker, item.symbol, item.productCode, item.displayName, item.englishName]
      .filter(Boolean)
      .some((value) => String(value).toUpperCase().replace(/[\s/.-]/g, '').includes(q)));
    await fulfill(route, { ok: true, q, asset: 'all', market: null, results, count: results.length, dataAsOf: NOW, stale: false, partial: false, providers: [], hiddenMatches: [] });
  });
}

test('005930 AAPL KRW-BTC and BTCUSDT resolve to exact canonical semantic identities', async ({ page }) => {
  await mockUnifiedSearch(page);
  const cases = [
    { query: '005930', option: /삼성전자.*005930/, expected: { asset: 'stock', market: 'KR', ticker: '005930', coinMarket: null, symbol: null } },
    { query: 'AAPL', option: /애플.*AAPL/, expected: { asset: 'stock', market: 'US', ticker: 'AAPL', coinMarket: null, symbol: null } },
    { query: 'KRW-BTC', option: /비트코인.*UPBIT.*BTC\/KRW/, expected: { asset: 'coin', market: null, ticker: null, coinMarket: 'spot', symbol: 'BTC' } },
    { query: 'BTCUSDT', option: /비트코인.*BITGET.*BTCUSDT/, expected: { asset: 'coin', market: null, ticker: null, coinMarket: 'futures', symbol: 'BTCUSDT' } },
  ];

  for (const item of cases) {
    await page.goto('/__phase11-unified-search-e2e');
    const input = page.getByRole('combobox', { name: '통합 자산 검색' });
    await input.fill(item.query);
    await page.getByRole('option', { name: item.option }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/stock-info');
    const url = new URL(page.url());
    expect(url.searchParams.get('asset')).toBe(item.expected.asset);
    expect(url.searchParams.get('market')).toBe(item.expected.market);
    expect(url.searchParams.get('ticker')).toBe(item.expected.ticker);
    expect(url.searchParams.get('coinMarket')).toBe(item.expected.coinMarket);
    expect(url.searchParams.get('symbol')).toBe(item.expected.symbol);
  }

  const upbit = SEARCH_FIXTURES.find((item) => item.productCode === 'KRW-BTC')!;
  expect(upbit.exchange).toBe('UPBIT');
  expect(upbit.instrumentType).toBe('spot');
  expect(upbit.productCode).toBe('KRW-BTC');
  expect(upbit.symbol).toBe('BTC');
});

async function installApprovedLegacyRuntime(page: Page) {
  const userId = '78787878-7878-4787-8787-787878787878';
  const storageKey = 'sb-127-auth-token';
  await page.addInitScript(({ key, id, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: id, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(key, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'expanded-legacy-route-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: { id, aud: 'authenticated', role: 'authenticated', email: 'expanded-route@accounts.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: 'Expanded Route Admin' }, identities: [], created_at: now },
    }));
  }, { key: storageKey, id: userId, now: NOW });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, { id: userId, login_name: 'expanded-route-admin', display_name: 'Expanded Route Admin', role: 'admin', status: 'approved', membership_level: 'admin', is_active: true, permissions_updated_at: NOW, updated_at: NOW });
    }
    if (pathname.endsWith('/auth/v1/user')) {
      return fulfill(route, { id: userId, aud: 'authenticated', role: 'authenticated', email: 'expanded-route@accounts.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: 'Expanded Route Admin' }, identities: [], created_at: NOW });
    }
    return fulfill(route, { ok: true });
  });
}

test('legacy /stock/005930 finishes at the KR stock-info canonical identity', async ({ page }) => {
  await installApprovedLegacyRuntime(page);
  await page.goto('/stock/005930');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/stock-info');
  const url = new URL(page.url());
  expect(url.searchParams.get('asset')).toBe('stock');
  expect(url.searchParams.get('market')).toBe('KR');
  expect(url.searchParams.get('ticker')).toBe('005930');
});

function cryptoAsset(symbol: string, overrides: Partial<MarketInformationAssetRow> = {}): MarketInformationAssetRow {
  return {
    symbol,
    name: symbol,
    exchange: symbol.includes('USDT') ? 'BITGET' : 'UPBIT',
    currency: symbol.includes('USDT') ? 'USDT' : 'KRW',
    price: 100,
    changePercent: 1.2,
    high24h: 105,
    low24h: 95,
    volume24h: 1_000,
    tradingValue24h: 100_000,
    marketCap: null,
    warning: false,
    tradingStatus: 'ACTIVE',
    fundingRatePercent: null,
    nextFundingAt: null,
    openInterest: null,
    rangeVolatility24hPercent: 10.5,
    providerUpdatedAt: NOW,
    ...overrides,
  };
}

function cryptoRoom(room: MarketInformationRoomId, rows: MarketInformationAssetRow[]): MarketInformationResponse {
  const market: MarketInformationResponse['market'] = room === 'coins-spot' ? 'spot' : 'futures';
  const assetType: MarketInformationResponse['assetType'] = room === 'coins-spot' ? 'coin-spot' : 'coin-futures';
  const currency: MarketInformationResponse['currency'] = room === 'coins-spot' ? 'KRW' : 'USDT';
  const meta: MarketInformationMeta = {
    provider: room === 'coins-spot' ? 'Upbit' : 'Bitget',
    source: room === 'coins-spot' ? 'Upbit official public Quotation API' : 'Bitget official public USDT-FUTURES market API',
    market, assetType, currency, providerUpdatedAt: NOW, observedAt: NOW, fetchedAt: NOW,
    marketTimeZone: room === 'coins-spot' ? 'Asia/Seoul' : 'UTC', marketStatus: '24H', isDelayed: false, isStale: false,
    partial: false, unavailableFields: [], errorCode: null, retryable: false,
  };
  return {
    ok: true, room, market, assetType, currency, fetchedAt: NOW, partial: false,
    sections: {
      indices: { status: 'unsupported', data: [], meta, message: null },
      rankings: { status: 'ready', data: rows, meta, message: null },
      sectors: { status: 'unsupported', data: [], meta, message: null },
      news: { status: 'unavailable', data: [], meta, message: null },
      disclosures: { status: 'unsupported', data: [], meta, message: null },
      derivatives: {
        status: room === 'coins-futures' ? 'ready' : 'unsupported',
        data: { referenceSymbol: 'BTCUSDT', longRatio: 0.52, shortRatio: 0.48, longShortRatio: 1.0833, ratioObservedAt: NOW, liquidations: [{ symbol: 'BTCUSDT', side: 'long', price: 99, amount: 10, occurredAt: NOW }] },
        meta, message: null,
      },
    },
    requestPolicy: { publicMarketDataOnly: true, privateExchangeRequests: 0, accountRequests: 0, balanceRequests: 0, positionRequests: 0, orderRequests: 0, cancelRequests: 0, aiRequests: 0 },
  };
}

const AI_ENV_KEYS = ['AI_CHAT_PROVIDER', 'AI_CHAT_API_KEY', 'AI_CHAT_MODEL', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_MODEL', 'TRADING_REVIEW_PROVIDER', 'TRADING_REVIEW_API_KEY', 'TRADING_REVIEW_MODEL'] as const;

function snapshotAiEnv(): Record<string, string | undefined> {
  return Object.fromEntries(AI_ENV_KEYS.map((key) => [key, process.env[key]]));
}
function clearAiEnv() { for (const key of AI_ENV_KEYS) delete process.env[key]; }
function restoreAiEnv(snapshot: Record<string, string | undefined>) {
  for (const key of AI_ENV_KEYS) snapshot[key] === undefined ? delete process.env[key] : process.env[key] = snapshot[key];
}

test('UPBIT and BITGET AI outbound provider payloads carry only selected public crypto context', async () => {
  const previousEnv = snapshotAiEnv();
  const originalGetRoom = MarketInformationService.getRoom;
  clearAiEnv();
  process.env.GEMINI_API_KEY = 'expanded-crypto-evidence-key';
  process.env.TRADING_REVIEW_API_KEY = 'must-never-be-used-paid-key';
  let providerCalls = 0;
  const observed: Array<{ market: string; selectionSymbol: string; cryptoSymbol: string; exchange: string; serialized: string }> = [];
  try {
    MarketInformationService.getRoom = async (room) => room === 'coins-spot'
      ? cryptoRoom('coins-spot', [cryptoAsset('BTC')])
      : cryptoRoom('coins-futures', [cryptoAsset('BTCUSDT', { fundingRatePercent: 0.01, openInterest: 12_345 })]);

    for (const input of [
      { market: 'UPBIT' as const, symbol: 'KRW-BTC', displayName: '비트코인' },
      { market: 'BITGET' as const, symbol: 'BTCUSDT', displayName: 'BTCUSDT' },
    ]) {
      const result = await answerAiChat({ message: `${input.displayName} 현재가와 시장 상황을 요약해줘`, context: input }, async (_url, init) => {
        providerCalls += 1;
        const requestBody = JSON.parse(String(init?.body ?? '{}')) as { contents?: Array<{ parts?: Array<{ text?: string }> }> };
        const prompt = JSON.parse(requestBody.contents?.[0]?.parts?.[0]?.text ?? '{}') as {
          publicContext?: {
            selection?: { market?: string; symbol?: string };
            crypto?: { market?: string; symbol?: string; quote?: { exchange?: string }; derivatives?: { fundingRatePercent?: number | null; openInterest?: number | null } | null };
          };
        };
        const context = prompt.publicContext!;
        const serialized = JSON.stringify(context);
        expect(context.selection?.market).toBe(input.market);
        expect(context.selection?.symbol).toBe(input.symbol);
        expect(context.crypto?.market).toBe(input.market);
        expect(context.crypto?.quote?.exchange).toBe(input.market);
        if (input.market === 'UPBIT') {
          expect(context.crypto?.symbol).toBe('BTC');
          expect(context.crypto?.derivatives).toBeNull();
        } else {
          expect(context.crypto?.symbol).toBe('BTCUSDT');
          expect(context.crypto?.derivatives?.fundingRatePercent).toBe(0.01);
          expect(context.crypto?.derivatives?.openInterest).toBe(12_345);
        }
        expect(serialized).not.toMatch(/(?:account|balance|position|orderHistory|cancelHistory|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token)/i);
        expect(serialized).not.toContain('expanded-crypto-evidence-key');
        expect(serialized).not.toContain('must-never-be-used-paid-key');
        observed.push({ market: input.market, selectionSymbol: input.symbol, cryptoSymbol: context.crypto?.symbol ?? '', exchange: context.crypto?.quote?.exchange ?? '', serialized });
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: `${input.market} 공개 시장 컨텍스트 확인` }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      expect(result.kind).toBe('answer');
      expect(result.data.status).toBe('partial');
    }
    expect(providerCalls).toBe(2);
    expect(observed.map((item) => [item.market, item.selectionSymbol, item.cryptoSymbol, item.exchange])).toEqual([
      ['UPBIT', 'KRW-BTC', 'BTC', 'UPBIT'],
      ['BITGET', 'BTCUSDT', 'BTCUSDT', 'BITGET'],
    ]);
  } finally {
    MarketInformationService.getRoom = originalGetRoom;
    restoreAiEnv(previousEnv);
  }
});