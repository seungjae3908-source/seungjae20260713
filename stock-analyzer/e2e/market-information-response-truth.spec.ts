import { expect, test } from '@playwright/test';
import {
  MARKET_INFORMATION_ROUTES,
  MarketInformationContractError,
  parseMarketInformationResponse,
} from '../src/lib/market-information';

const route = MARKET_INFORMATION_ROUTES.find((item) => item.id === 'stocks-kr')!;

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
