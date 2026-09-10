import { expect, test, type Page, type Route } from '@playwright/test';
import {
  MARKET_INFORMATION_ROUTES,
  MarketInformationContractError,
  parseMarketInformationResponse,
} from '../src/lib/market-information';

const route = MARKET_INFORMATION_ROUTES.find((item) => item.id === 'stocks-kr')!;
const E2E_USER_ID = '11111111-1111-4111-8111-111111111111';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function meta(overrides: Record<string, unknown> = {}) {
  const now = iso();
  return {
    provider: 'KRX/Naver/Yahoo',
    source: '기존 공개 시세·상장종목 provider',
    market: 'KR',
    assetType: 'stock',
    currency: 'KRW',
    providerUpdatedAt: now,
    observedAt: now,
    fetchedAt: now,
    marketTimeZone: 'Asia/Seoul',
    marketStatus: 'OPEN',
    isDelayed: false,
    isStale: false,
    partial: false,
    unavailableFields: [],
    errorCode: null,
    retryable: false,
    ...overrides,
  };
}

function canonicalResponse() {
  const now = iso();
  return {
    ok: true,
    room: 'stocks-kr',
    market: 'KR',
    assetType: 'stock',
    currency: 'KRW',
    fetchedAt: now,
    partial: false,
    sections: {
      indices: {
        status: 'ready',
        data: [{ key: 'KOSPI', label: '코스피', value: 3123.45, changePercent: 0.8 }],
        meta: meta(),
        message: null,
      },
      rankings: {
        status: 'ready',
        data: [{
          symbol: '005930',
          name: '삼성전자',
          exchange: 'KRX',
          currency: 'KRW',
          price: 78000,
          changePercent: 0.7,
          high24h: 79000,
          low24h: 77000,
          volume24h: 700000,
          tradingValue24h: 54000000000,
          marketCap: null,
          warning: false,
          tradingStatus: null,
          fundingRatePercent: null,
          nextFundingAt: null,
          openInterest: null,
          rangeVolatility24hPercent: null,
          providerUpdatedAt: now,
        }],
        meta: meta(),
        message: null,
      },
      sectors: {
        status: 'ready',
        data: [{ key: 'semiconductor', label: '반도체', tradingValue: 123000000, constituentCount: 1, changePercent: null }],
        meta: meta(),
        message: null,
      },
      news: {
        status: 'ready',
        data: [{
          id: 'news-1',
          kind: 'news',
          symbol: '005930',
          title: '삼성전자 공개 뉴스',
          summary: '공개 정보',
          provider: 'example.com',
          source: '테스트 뉴스',
          url: 'https://example.com/news/1',
          publishedAt: now,
        }],
        meta: meta(),
        message: null,
      },
      disclosures: {
        status: 'ready',
        data: [{
          id: 'filing-1',
          kind: 'disclosure',
          symbol: '005930',
          title: '공식 공시',
          summary: '공식 공시 정보',
          provider: 'OpenDART',
          source: '금융감독원 전자공시',
          url: 'https://example.com/filing/1',
          publishedAt: now,
        }],
        meta: meta(),
        message: null,
      },
      derivatives: {
        status: 'unsupported',
        data: {
          referenceSymbol: 'BTCUSDT',
          longRatio: null,
          shortRatio: null,
          longShortRatio: null,
          ratioObservedAt: null,
          liquidations: [],
        },
        meta: meta({
          provider: null,
          source: null,
          unavailableFields: ['fundingRate', 'openInterest', 'longShortRatio', 'liquidations'],
          errorCode: 'PROVIDER_UNSUPPORTED',
        }),
        message: '주식 정보방에는 선물 파생지표를 표시하지 않습니다.',
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

function expectContractError(payload: unknown, code?: string): void {
  try {
    parseMarketInformationResponse(payload, route);
    throw new Error('expected MarketInformationContractError');
  } catch (error) {
    expect(error).toBeInstanceOf(MarketInformationContractError);
    if (code) expect((error as MarketInformationContractError).code).toBe(code);
  }
}

function fulfill(route: Route, body: unknown): Promise<void> {
  return route.fulfill({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

async function installApprovedSession(page: Page): Promise<void> {
  await page.addInitScript(({ storageKey, userId }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'e2e-refresh-token',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'market-information-truth@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '시장정보 응답 검증' },
        identities: [],
        created_at: new Date().toISOString(),
      },
    }));
  }, { storageKey: E2E_AUTH_STORAGE_KEY, userId: E2E_USER_ID });
}

test('canonical market information success envelope is accepted', () => {
  const response = canonicalResponse();
  expect(parseMarketInformationResponse(response, route)).toEqual(response);
});

test('malformed HTTP 200 section evidence fails closed instead of reaching normal room UI', () => {
  const cases = [
    { mutate: (value: ReturnType<typeof canonicalResponse>) => { value.sections.indices.data = [{} as never]; }, code: 'INVALID_INDEX_ROW' },
    { mutate: (value: ReturnType<typeof canonicalResponse>) => { value.sections.rankings.data[0].price = null; }, code: 'INVALID_ASSET_NUMBER' },
    { mutate: (value: ReturnType<typeof canonicalResponse>) => { value.sections.sectors.data[0].constituentCount = '1' as never; }, code: 'INVALID_SECTOR_ROW' },
    { mutate: (value: ReturnType<typeof canonicalResponse>) => { value.sections.news.data[0].kind = 'disclosure' as never; }, code: 'INVALID_NEWS_ROW' },
    { mutate: (value: ReturnType<typeof canonicalResponse>) => { value.sections.disclosures.data[0].url = 'javascript:alert(1)'; }, code: 'INVALID_NEWS_URL' },
    { mutate: (value: ReturnType<typeof canonicalResponse>) => { value.sections.derivatives.data.longRatio = '0.5' as never; }, code: 'INVALID_DERIVATIVES' },
  ];

  for (const item of cases) {
    const value = canonicalResponse();
    item.mutate(value);
    expectContractError(value, item.code);
  }
});

test('actual room UI fails closed on malformed HTTP 200 without retrying or rendering evidence', async ({ page }) => {
  await installApprovedSession(page);
  const malformed = canonicalResponse();
  malformed.sections.indices.data = [{} as never];
  let marketRequests = 0;
  const forbiddenRequests: string[] = [];

  await page.route('**/__e2e-supabase/**', async (requestRoute) => {
    const pathname = new URL(requestRoute.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(requestRoute, {
        id: E2E_USER_ID,
        login_name: 'market-information-truth',
        display_name: '시장정보 응답 검증',
        role: 'admin',
        status: 'approved',
        membership_level: 'admin',
        is_active: true,
        permissions_updated_at: iso(),
        updated_at: iso(),
      });
    }
    if (pathname.endsWith('/auth/v1/user')) {
      return fulfill(requestRoute, {
        id: E2E_USER_ID,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'market-information-truth@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '시장정보 응답 검증' },
        identities: [],
        created_at: iso(),
      });
    }
    return fulfill(requestRoute, { ok: true });
  });

  await page.route('**/api/**', async (requestRoute) => {
    const pathname = new URL(requestRoute.request().url()).pathname;
    if (/\/(accounts?|balances?|positions?|orders?|cancel|trade-automation)(\/|$)|\/crypto\/futures\/auto/i.test(pathname)) {
      forbiddenRequests.push(`${requestRoute.request().method()} ${pathname}`);
    }
    if (pathname === '/api/market-information/stocks-kr') {
      marketRequests += 1;
      return fulfill(requestRoute, malformed);
    }
    if (pathname === '/api/notifications/price-alerts') return fulfill(requestRoute, { alerts: [] });
    if (pathname === '/api/watchlist/sync') return fulfill(requestRoute, { ok: true, items: [] });
    return fulfill(requestRoute, { ok: true });
  });

  await page.goto('/stocks/kr');
  await expect(page.getByRole('heading', { name: '시장정보 확인 실패' })).toBeVisible();
  await expect(page.getByLabel('시장정보 오류')).toContainText('지수 근거 행이 올바르지 않습니다.');
  await expect(page.getByTestId('market-room-overview')).toHaveCount(0);
  await expect(page.getByText('삼성전자', { exact: true })).toHaveCount(0);
  expect(marketRequests).toBe(1);
  expect(forbiddenRequests).toEqual([]);
});

test('future-dated successful evidence is rejected rather than displayed as current', () => {
  const future = iso(6 * 60_000);
  const cases = [
    (value: ReturnType<typeof canonicalResponse>) => { value.fetchedAt = future; },
    (value: ReturnType<typeof canonicalResponse>) => { value.sections.rankings.meta.fetchedAt = future; },
    (value: ReturnType<typeof canonicalResponse>) => { value.sections.rankings.data[0].providerUpdatedAt = future; },
    (value: ReturnType<typeof canonicalResponse>) => { value.sections.news.data[0].publishedAt = future; },
  ];

  for (const mutate of cases) {
    const value = canonicalResponse();
    mutate(value);
    expectContractError(value, 'FUTURE_TIMESTAMP');
  }
});

test('identity and status contradictions in HTTP 200 fail closed', () => {
  const wrongAsset = canonicalResponse();
  wrongAsset.assetType = 'coin-spot' as never;
  expectContractError(wrongAsset, 'ROOM_CONTRACT_MISMATCH');

  const readyEmpty = canonicalResponse();
  readyEmpty.sections.indices.data = [];
  expectContractError(readyEmpty, 'READY_SECTION_EMPTY');

  const staleWithoutEvidence = canonicalResponse();
  staleWithoutEvidence.sections.rankings.status = 'stale' as never;
  expectContractError(staleWithoutEvidence, 'STALE_STATUS_MISMATCH');

  const partialMismatch = canonicalResponse();
  partialMismatch.partial = true;
  expectContractError(partialMismatch, 'PARTIAL_RESPONSE_MISMATCH');
});
