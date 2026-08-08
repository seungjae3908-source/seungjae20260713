import type { MemberCapability } from '../../../packages/member-access/src/index.js';

export type MarketInformationId = 'stocks-kr' | 'stocks-us' | 'coins-spot' | 'coins-futures';
export type MarketInformationAsset = 'stock' | 'coin';
export type MarketInformationGroup = '주식' | '코인';
export type MarketInformationStatus = 'ready' | 'empty' | 'partial' | 'stale' | 'unsupported' | 'unavailable' | 'error';
export type MarketInformationCurrency = 'KRW' | 'USD' | 'USDT';

export type MarketInformationRoute = {
  id: MarketInformationId;
  href: string;
  group: MarketInformationGroup;
  label: string;
  shortLabel: string;
  asset: MarketInformationAsset;
  market: 'KR' | 'US' | 'spot' | 'futures';
  exchange: 'KRX' | 'US' | 'UPBIT' | 'BITGET';
  currency: MarketInformationCurrency;
  capability: MemberCapability;
};

export type MarketInformationMeta = {
  provider: string | null;
  source: string | null;
  market: 'KR' | 'US' | 'spot' | 'futures';
  assetType: 'stock' | 'coin-spot' | 'coin-futures';
  currency: MarketInformationCurrency;
  providerUpdatedAt: string | null;
  observedAt: string | null;
  fetchedAt: string;
  marketTimeZone: string;
  marketStatus: 'OPEN' | 'CLOSED' | '24H' | 'UNKNOWN';
  isDelayed: boolean;
  isStale: boolean;
  partial: boolean;
  unavailableFields: string[];
  errorCode: string | null;
  retryable: boolean;
};

export type MarketInformationSection<T> = {
  status: MarketInformationStatus;
  data: T;
  meta: MarketInformationMeta;
  message: string | null;
};

export type MarketInformationAssetRow = {
  symbol: string;
  name: string;
  exchange: string;
  currency: MarketInformationCurrency;
  price: number | null;
  changePercent: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24h: number | null;
  tradingValue24h: number | null;
  marketCap: number | null;
  warning: boolean;
  tradingStatus: string | null;
  fundingRatePercent: number | null;
  nextFundingAt: string | null;
  openInterest: number | null;
  rangeVolatility24hPercent: number | null;
  providerUpdatedAt: string | null;
};

export type MarketInformationIndexRow = {
  key: string;
  label: string;
  value: number | null;
  changePercent: number | null;
};

export type MarketInformationSectorRow = {
  key: string;
  label: string;
  tradingValue: number | null;
  constituentCount: number;
  changePercent: number | null;
};

export type MarketInformationNewsRow = {
  id: string;
  kind: 'news' | 'disclosure';
  symbol: string;
  title: string;
  summary: string | null;
  provider: string;
  source: string;
  url: string;
  publishedAt: string;
};

export type MarketInformationDerivativesData = {
  referenceSymbol: string;
  longRatio: number | null;
  shortRatio: number | null;
  longShortRatio: number | null;
  ratioObservedAt: string | null;
  liquidations: Array<{
    symbol: string;
    side: 'long' | 'short' | 'unknown';
    price: number | null;
    amount: number | null;
    occurredAt: string | null;
  }>;
};

export type MarketInformationResponse = {
  ok: true;
  room: MarketInformationId;
  market: MarketInformationRoute['market'];
  assetType: 'stock' | 'coin-spot' | 'coin-futures';
  currency: MarketInformationCurrency;
  fetchedAt: string;
  partial: boolean;
  sections: {
    indices: MarketInformationSection<MarketInformationIndexRow[]>;
    rankings: MarketInformationSection<MarketInformationAssetRow[]>;
    sectors: MarketInformationSection<MarketInformationSectorRow[]>;
    news: MarketInformationSection<MarketInformationNewsRow[]>;
    disclosures: MarketInformationSection<MarketInformationNewsRow[]>;
    derivatives: MarketInformationSection<MarketInformationDerivativesData>;
  };
  requestPolicy: {
    publicMarketDataOnly: true;
    privateExchangeRequests: 0;
    accountRequests: 0;
    balanceRequests: 0;
    positionRequests: 0;
    orderRequests: 0;
    cancelRequests: 0;
    aiRequests: 0;
  };
};

export const MARKET_INFORMATION_ROUTES: readonly MarketInformationRoute[] = [
  {
    id: 'stocks-kr', href: '/stocks/kr', group: '주식', label: '국내주식 정보', shortLabel: '국내',
    asset: 'stock', market: 'KR', exchange: 'KRX', currency: 'KRW', capability: 'canAccessBasicInfo',
  },
  {
    id: 'stocks-us', href: '/stocks/us', group: '주식', label: '미국주식 정보', shortLabel: '해외',
    asset: 'stock', market: 'US', exchange: 'US', currency: 'USD', capability: 'canAccessBasicInfo',
  },
  {
    id: 'coins-spot', href: '/coins/spot', group: '코인', label: '코인 현물 정보', shortLabel: '현물',
    asset: 'coin', market: 'spot', exchange: 'UPBIT', currency: 'KRW', capability: 'canAccessSpot',
  },
  {
    id: 'coins-futures', href: '/coins/futures', group: '코인', label: '코인 선물 정보', shortLabel: '선물',
    asset: 'coin', market: 'futures', exchange: 'BITGET', currency: 'USDT', capability: 'canAccessFutures',
  },
] as const;

export class MarketInformationContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MarketInformationContractError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validNullableNumber(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function validNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function requireIso(value: unknown, field: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new MarketInformationContractError('INVALID_TIMESTAMP', `${field} 시간이 올바르지 않습니다.`);
  }
}

function requireMeta(value: unknown, route: MarketInformationRoute): asserts value is MarketInformationMeta {
  if (!isObject(value)) throw new MarketInformationContractError('META_REQUIRED', '시장정보 메타데이터가 없습니다.');
  if (value.market !== route.market || value.currency !== route.currency) {
    throw new MarketInformationContractError('MARKET_CURRENCY_MISMATCH', '시장 또는 통화 메타데이터가 요청과 일치하지 않습니다.');
  }
  if (!validNullableString(value.provider) || !validNullableString(value.source)) {
    throw new MarketInformationContractError('INVALID_PROVIDER_META', 'provider 또는 source 형식이 올바르지 않습니다.');
  }
  if (!validNullableString(value.providerUpdatedAt) || !validNullableString(value.observedAt)) {
    throw new MarketInformationContractError('INVALID_PROVIDER_TIME', 'provider 기준시각 형식이 올바르지 않습니다.');
  }
  if (value.providerUpdatedAt != null) requireIso(value.providerUpdatedAt, 'providerUpdatedAt');
  if (value.observedAt != null) requireIso(value.observedAt, 'observedAt');
  requireIso(value.fetchedAt, 'fetchedAt');
  if (typeof value.marketTimeZone !== 'string' || typeof value.isDelayed !== 'boolean'
    || typeof value.isStale !== 'boolean' || typeof value.partial !== 'boolean'
    || typeof value.retryable !== 'boolean' || !Array.isArray(value.unavailableFields)) {
    throw new MarketInformationContractError('INVALID_META_FIELDS', '시장정보 상태 메타데이터가 올바르지 않습니다.');
  }
}

function requireSection(value: unknown, route: MarketInformationRoute, dataKind: 'array' | 'object'): asserts value is MarketInformationSection<unknown> {
  if (!isObject(value)) throw new MarketInformationContractError('SECTION_REQUIRED', '시장정보 section이 없습니다.');
  if (!['ready', 'empty', 'partial', 'stale', 'unsupported', 'unavailable', 'error'].includes(String(value.status))) {
    throw new MarketInformationContractError('INVALID_SECTION_STATUS', '시장정보 section 상태가 올바르지 않습니다.');
  }
  if (dataKind === 'array' ? !Array.isArray(value.data) : !isObject(value.data)) {
    throw new MarketInformationContractError('INVALID_SECTION_DATA', '시장정보 section 데이터 형식이 올바르지 않습니다.');
  }
  requireMeta(value.meta, route);
  if (!validNullableString(value.message)) {
    throw new MarketInformationContractError('INVALID_SECTION_MESSAGE', '시장정보 section 메시지 형식이 올바르지 않습니다.');
  }
}

function requireAssets(value: unknown, route: MarketInformationRoute): asserts value is MarketInformationAssetRow[] {
  if (!Array.isArray(value)) throw new MarketInformationContractError('ASSET_ARRAY_REQUIRED', '종목 배열이 없습니다.');
  for (const item of value) {
    if (!isObject(item) || typeof item.symbol !== 'string' || !item.symbol.trim()
      || typeof item.name !== 'string' || typeof item.exchange !== 'string') {
      throw new MarketInformationContractError('INVALID_ASSET_IDENTITY', '종목 식별 정보가 올바르지 않습니다.');
    }
    if (item.currency !== route.currency) {
      throw new MarketInformationContractError('ASSET_CURRENCY_MISMATCH', '종목 통화가 정보방 통화와 일치하지 않습니다.');
    }
    for (const field of ['price', 'changePercent', 'high24h', 'low24h', 'volume24h', 'tradingValue24h', 'marketCap', 'fundingRatePercent', 'openInterest', 'rangeVolatility24hPercent']) {
      if (!validNullableNumber(item[field])) {
        throw new MarketInformationContractError('INVALID_ASSET_NUMBER', `${field} 값이 올바르지 않습니다.`);
      }
    }
    if (typeof item.warning !== 'boolean' || !validNullableString(item.tradingStatus)
      || !validNullableString(item.nextFundingAt) || !validNullableString(item.providerUpdatedAt)) {
      throw new MarketInformationContractError('INVALID_ASSET_META', '종목 상태 정보가 올바르지 않습니다.');
    }
  }
}

function requireZeroOutboundPolicy(value: unknown): asserts value is MarketInformationResponse['requestPolicy'] {
  if (!isObject(value) || value.publicMarketDataOnly !== true) {
    throw new MarketInformationContractError('PUBLIC_POLICY_REQUIRED', '공개 시장정보 전용 정책이 없습니다.');
  }
  for (const field of ['privateExchangeRequests', 'accountRequests', 'balanceRequests', 'positionRequests', 'orderRequests', 'cancelRequests', 'aiRequests']) {
    if (value[field] !== 0) {
      throw new MarketInformationContractError('OUTBOUND_POLICY_VIOLATION', `${field}가 0이 아닙니다.`);
    }
  }
}

export function parseMarketInformationResponse(payload: unknown, route: MarketInformationRoute): MarketInformationResponse {
  if (!isObject(payload) || Object.keys(payload).length === 0) {
    throw new MarketInformationContractError('EMPTY_RESPONSE_OBJECT', '시장정보 응답 객체가 비어 있습니다.');
  }
  if (payload.ok !== true || payload.room !== route.id || payload.market !== route.market || payload.currency !== route.currency) {
    throw new MarketInformationContractError('ROOM_CONTRACT_MISMATCH', '시장정보 응답이 요청한 정보방과 일치하지 않습니다.');
  }
  requireIso(payload.fetchedAt, 'fetchedAt');
  if (typeof payload.partial !== 'boolean' || !isObject(payload.sections)) {
    throw new MarketInformationContractError('INVALID_RESPONSE_META', '시장정보 응답 상태가 올바르지 않습니다.');
  }
  const sections = payload.sections;
  requireSection(sections.indices, route, 'array');
  requireSection(sections.rankings, route, 'array');
  requireSection(sections.sectors, route, 'array');
  requireSection(sections.news, route, 'array');
  requireSection(sections.disclosures, route, 'array');
  requireSection(sections.derivatives, route, 'object');
  requireAssets((sections.rankings as Record<string, unknown>).data, route);
  requireZeroOutboundPolicy(payload.requestPolicy);
  return payload as MarketInformationResponse;
}

export function parseMarketInformationText(text: string, route: MarketInformationRoute): MarketInformationResponse {
  if (!text.trim()) throw new MarketInformationContractError('EMPTY_RESPONSE_BODY', '시장정보 응답 본문이 비어 있습니다.');
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new MarketInformationContractError('INVALID_RESPONSE_JSON', '시장정보 JSON 응답을 해석할 수 없습니다.');
  }
  return parseMarketInformationResponse(payload, route);
}

export function marketInformationRoute(pathname: string): MarketInformationRoute | null {
  const cleanPath = pathname.split('?')[0] || '/';
  return MARKET_INFORMATION_ROUTES.find((route) => cleanPath === route.href) ?? null;
}

export function marketInformationDetailPath(route: MarketInformationRoute, symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (route.asset === 'stock') {
    const params = new URLSearchParams({ asset: 'stock', market: route.market, ticker: normalized });
    return `/stock-info?${params.toString()}`;
  }
  const params = new URLSearchParams({ asset: 'coin', coinMarket: route.market, symbol: normalized });
  return `/stock-info?${params.toString()}`;
}
