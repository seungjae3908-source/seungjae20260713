import type { Page, Route } from '@playwright/test';

const USER_ID = '00000000-0000-4000-8000-000000000911';
const NOW = '2026-09-05T10:00:00.000Z';
const NOW_SECONDS = Math.floor(Date.parse(NOW) / 1000);

const USER = {
  id: USER_ID,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'full-product-e2e@accounts.seungjae-stock.com',
  email_confirmed_at: NOW,
  phone: '',
  confirmed_at: NOW,
  last_sign_in_at: NOW,
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { display_name: 'Full Product E2E', login_name: 'full-product-e2e' },
  identities: [],
  created_at: NOW,
  updated_at: NOW,
  is_anonymous: false,
};

const PROFILE = {
  id: USER_ID,
  login_name: 'full-product-e2e',
  display_name: 'Full Product E2E',
  role: 'admin',
  status: 'approved',
  membership_level: 'admin',
  is_active: true,
  permissions_updated_at: NOW,
  updated_at: NOW,
};

const SESSION = {
  access_token: 'FULL_PRODUCT_E2E_ACCESS_TOKEN',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: NOW_SECONDS + 3600,
  refresh_token: 'FULL_PRODUCT_E2E_REFRESH_TOKEN',
  user: USER,
};

function json(route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers,
    body: JSON.stringify(body),
  });
}

function emptyAccount(provider: 'toss' | 'upbit' | 'bitget') {
  return {
    provider,
    readOnly: true,
    connected: true,
    status: 'CONNECTED',
    accounts: provider === 'toss'
      ? [{ market: 'KR', accountRef: '12****78', currency: 'KRW', buyingPower: null }]
      : provider === 'upbit'
        ? [{ market: 'UPBIT', accountRef: null, currency: 'KRW', buyingPower: null }]
        : [{ market: 'BITGET', accountRef: null, currency: 'USDT', buyingPower: null }],
    balances: provider === 'upbit'
      ? [{ currency: 'KRW', available: 1000000, locked: 0, total: 1000000, estimatedKrwValue: 1000000 }]
      : [],
    positions: provider === 'toss'
      ? [{ market: 'KR', symbol: '005930', quantity: 3, availableQuantity: 3, averageEntryPrice: 70000, currentPrice: 71000, marketValue: 213000, unrealizedPnl: 3000, unrealizedPnlPercent: 1.42, leverage: null, liquidationPrice: null, marginMode: null, side: null }]
      : provider === 'bitget'
        ? [{ market: 'BITGET', symbol: 'BTCUSDT', quantity: 0.01, availableQuantity: 0.01, averageEntryPrice: 60000, currentPrice: 61000, marketValue: 610, unrealizedPnl: 10, unrealizedPnlPercent: 1.67, leverage: 2, liquidationPrice: null, marginMode: 'isolated', side: 'LONG' }]
        : [],
    openOrders: [],
    checkedAt: NOW,
    lastGoodAt: NOW,
    stale: false,
    errorCode: null,
    orderRequests: 0,
    cancelRequests: 0,
    amendRequests: 0,
    transferRequests: 0,
    withdrawalRequests: 0,
    credentialsReturned: false,
    liveTradingEnabled: false,
    autoTradingEnabled: false,
  };
}

function candles(count = 120) {
  const base = 1_775_000_000;
  return Array.from({ length: count }, (_, index) => ({
    time: base + index * 300,
    open: 70000 + index * 10,
    high: 70080 + index * 10,
    low: 69940 + index * 10,
    close: 70040 + index * 10,
    volume: 1000 + index * 25,
    isClosed: index < count - 1,
  }));
}

function portfolioFixture() {
  const holding = {
    id: 'holding-005930', ticker: '005930', name: '삼성전자', market: 'KR', currency: 'KRW',
    quantity: 3, averagePrice: 70000, currentPrice: 71000, nativeValue: 213000, normalizedKRW: 213000,
  };
  return {
    ok: true,
    portfolio: {
      status: 'PARTIAL', asOf: NOW,
      totalAssets: { status: 'PARTIAL', normalizedKRW: null, knownNormalizedKRW: 1213000 },
      investmentPrincipal: { status: 'KNOWN', normalizedKRW: 210000, knownNormalizedKRW: 210000 },
      valuationPnl: { status: 'KNOWN', normalizedKRW: 3000, returnPercent: 1.42 },
      cash: { status: 'KNOWN', totalKRW: 1000000 },
      minimumCashBuffer: { status: 'KNOWN', normalizedKRW: 200000 },
      investableCash: { status: 'KNOWN', normalizedKRW: 800000 },
      assets: { krStocks: 213000, usStocks: 0, cryptoSpot: 0, cryptoFuturesEquity: 0, cash: 1000000 },
      allocation: { status: 'KNOWN_BASIS', knownTotalKRW: 1213000, buckets: { KR_STOCK: 17.56, CASH: 82.44 } },
      holdings: [holding], topHoldings: [holding],
      top5Concentration: { status: 'KNOWN', percent: 17.56 },
      correlation: { status: 'INSUFFICIENT_DATA', sampleSize: 0, correlation: null, pair: [] },
      riskClassification: { status: 'PARTIAL', level: null, reason: 'E2E fixture keeps unavailable evidence explicit.' },
      allocationPolicy: { profile: 'BALANCED', status: 'PARTIAL', comparison: [
        { assetClass: 'KR_STOCK', currentPercent: 17.56, minPercent: 0, maxPercent: 100, state: 'IN_RANGE' },
      ] },
      fx: { status: 'NOT_REQUIRED', quotes: [] },
      dataQuality: { status: 'PARTIAL', providerCount: 3, includedProviderCount: 2, invalidHoldingRows: 0 },
      missingSources: ['READONLY_CASH_SOURCE_UNAVAILABLE'],
    },
  };
}

function researchFixture() {
  return {
    schemaVersion: 'research-dashboard-overview-v1', generatedAt: Date.parse(NOW),
    state: { present: true, latestCycleAt: Date.parse(NOW) },
    safety: { readOnlyDashboard: true, liveTrading: false, privateApi: false, orderAuthority: false, authorityEvidenceComplete: true, forbiddenAuthorityObserved: false },
    research: { status: 'RUNNING', failedTasks: 0, blockedDataTasks: 1, cycles: [] },
    paper: {
      runtime: { present: true, status: 'ACCUMULATING', cycleId: 'e2e-cycle', scheduleActive: false, allProvidersReady: false, publicForwardEvidenceAccumulating: true, paperTradeOutcomeAccumulating: true, privateRequestCount: 0, financialMutationCount: 0, orderCount: 0, liveTrading: false, orderAuthority: false, safetyEvidenceComplete: true, lanes: [] },
      ledger: { present: true, cycleCount: 1, sampleCount: 1, positionCount: 0, settlementCount: 0 },
    },
    shadow: { groups: [], records: { present: true, totalRecords: 0, settledRecords: 0, pendingRecords: 0 } },
    profitability: { proven: false, status: 'UNPROVEN', note: 'E2E fixture does not claim profitability.' },
  };
}

function promotionsFixture() {
  return {
    ok: true, generatedAt: NOW, sourceSha: 'e2e-fixture', policyVersion: 'e2e-readonly', items: [],
    counts: { RESEARCH: 0, BLOCKED_DATA: 0, RESEARCH_HOLD: 0, PAPER_CANDIDATE: 0, PAPER_VALIDATED: 0, SHADOW_CANDIDATE: 0, SHADOW_VALIDATED: 0, PROMOTION_CANDIDATE: 0, SUSPENDED: 0, KILLED: 0 },
    evidenceSources: [], promotionCandidates: 0, executionAuthority: 'NONE', liveTradingAuthority: false, privateTradingApiCount: 0,
  };
}

export type FullProductFixtureController = {
  expireSession(): void;
};

export async function installFullProductFixtures(page: Page): Promise<FullProductFixtureController> {
  let sessionExpired = false;

  await page.route('**/__e2e-supabase/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path.endsWith('/auth/v1/token')) {
      const grantType = url.searchParams.get('grant_type');
      if (grantType === 'refresh_token' && sessionExpired) {
        return json(route, { error: 'invalid_grant', error_description: 'Refresh token expired' }, 401);
      }
      return json(route, SESSION);
    }
    if (path.endsWith('/auth/v1/user')) {
      return sessionExpired
        ? json(route, { message: 'JWT expired' }, 401)
        : json(route, { user: USER });
    }
    if (path.endsWith('/rest/v1/profiles')) {
      return json(route, PROFILE, 200, { 'content-range': '0-0/1' });
    }
    return json(route, {});
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === '/api/search/suggest') {
      return json(route, {
        ok: true, state: 'FULL', q: url.searchParams.get('q') ?? '', asset: 'all', market: null,
        results: [{ id: 'KR:005930', assetType: 'stock', market: 'KR', instrumentType: 'stock', exchange: 'KRX', ticker: '005930', productCode: '005930', koreanName: '삼성전자', englishName: 'Samsung Electronics', displayName: '삼성전자', baseSymbol: '005930', quoteCurrency: 'KRW', matchType: 'name', active: true, provider: 'e2e-fixture', dataAsOf: NOW }],
        count: 1, dataAsOf: NOW, stale: false, partial: false,
        providers: [{ provider: 'e2e-fixture', status: 'ok', count: 1, dataAsOf: NOW }], hiddenMatches: [],
      });
    }
    if (/^\/api\/stocks\/005930\/candles$/u.test(path)) {
      return json(route, { ticker: '005930', timeframe: url.searchParams.get('timeframe') ?? '5m', provider: 'e2e-fixture', fetchedAt: NOW, updatedAt: NOW, candles: candles() });
    }
    if (path === '/api/accounts/read-only/toss') return json(route, emptyAccount('toss'));
    if (path === '/api/accounts/read-only/upbit') return json(route, emptyAccount('upbit'));
    if (path === '/api/accounts/read-only/bitget') return json(route, emptyAccount('bitget'));
    if (path === '/api/portfolio/intelligence') return json(route, portfolioFixture());
    if (path === '/api/admin/research/overview') return json(route, researchFixture());
    if (path === '/api/strategy-promotion') return json(route, promotionsFixture());

    return json(route, {});
  });

  return {
    expireSession() {
      sessionExpired = true;
    },
  };
}

export async function ageBrowserSession(page: Page) {
  await page.evaluate(() => {
    const expiredAt = Math.floor(Date.now() / 1000) - 60;
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith('sb-') || !key.endsWith('-auth-token')) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const stored = JSON.parse(raw) as Record<string, unknown> & {
          expires_at?: number;
          currentSession?: Record<string, unknown>;
          session?: Record<string, unknown>;
        };
        stored.expires_at = expiredAt;
        if (stored.currentSession) stored.currentSession.expires_at = expiredAt;
        if (stored.session) stored.session.expires_at = expiredAt;
        localStorage.setItem(key, JSON.stringify(stored));
      } catch {
        // Ignore unrelated localStorage values.
      }
    }
  });
}
