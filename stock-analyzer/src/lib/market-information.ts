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

const SECTION_STATUSES: readonly MarketInformationStatus[] = [
  'ready', 'empty', 'partial', 'stale', 'unsupported', 'unavailable', 'error',
];
const MARKET_STATUSES: readonly MarketInformationMeta['marketStatus'][] = ['OPEN', 'CLOSED', '24H', 'UNKNOWN'];
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

export class MarketInformationContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MarketInformationContractError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validNullableNumber(value: unknown): boolean {
  return value === null || isFiniteNumber(value);
}

function validNullableNonNegativeNumber(value: unknown): boolean {
  return value === null || (isFiniteNumber(value) && value >= 0);
}

function validNullablePositiveNumber(value: unknown): boolean {
  return value === null || (isFiniteNumber(value) && value > 0);
}

function validNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function validNullableNonEmptyString(value: unknown): boolean {
  return value === null || isNonEmptyString(value);
}

function requireIso(value: unknown, field: string, options: { rejectFuture?: boolean } = {}): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new MarketInformationContractError('INVALID_TIMESTAMP', `${field} 시간이 올바르지 않습니다.`);
  }
  if (options.rejectFuture === true && Date.parse(value) > Date.now() + MAX_FUTURE_SKEW_MS) {
    throw new MarketInformationContractError('FUTURE_TIMESTAMP', `${field} 시간이 현재보다 지나치게 미래입니다.`);
  }
}

function requireNullableIso(value: unknown, field: string, options: { rejectFuture?: boolean } = {}): void {
  if (value === null) return;
  requireIso(value, field, options);
}

function expectedAssetType(route: MarketInformationRoute): MarketInformationResponse['assetType'] {
  if (route.asset === 'stock') return 'stock';
  return route.market === 'spot' ? 'coin-spot' : 'coin-futures';
}

function expectedTimeZone(route: MarketInformationRoute): string {
  if (route.market === 'KR' || route.market === 'spot') return 'Asia/Seoul';
  if (route.market === 'US') return 'America/New_York';
  return 'UTC';
}

function requireMeta(value: unknown, route: MarketInformationRoute): asserts value is MarketInformationMeta {
  if (!isObject(value)) throw new MarketInformationContractError('META_REQUIRED', '시장정보 메타데이터가 없습니다.');
  if (value.market !== route.market || value.currency !== route.currency || value.assetType !== expectedAssetType(route)) {
    throw new MarketInformationContractError('MARKET_CURRENCY_MISMATCH', '시장·자산유형 또는 통화 메타데이터가 요청과 일치하지 않습니다.');
  }
  if (!validNullableNonEmptyString(value.provider) || !validNullableNonEmptyString(value.source)) {
    throw new MarketInformationContractError('INVALID_PROVIDER_META', 'provider 또는 source 형식이 올바르지 않습니다.');
  }
  requireNullableIso(value.providerUpdatedAt, 'providerUpdatedAt', { rejectFuture: true });
  requireNullableIso(value.observedAt, 'observedAt', { rejectFuture: true });
  requireIso(value.fetchedAt, 'section.fetchedAt', { rejectFuture: true });
  if (value.marketTimeZone !== expectedTimeZone(route) || !MARKET_STATUSES.includes(value.marketStatus as MarketInformationMeta['marketStatus'])) {
    throw new MarketInformationContractError('INVALID_MARKET_CLOCK_META', '시장 시간대 또는 장 상태 메타데이터가 올바르지 않습니다.');
  }
  if (typeof value.isDelayed !== 'boolean' || typeof value.isStale !== 'boolean'
    || typeof value.partial !== 'boolean' || typeof value.retryable !== 'boolean') {
    throw new MarketInformationContractError('INVALID_META_FIELDS', '시장정보 상태 메타데이터가 올바르지 않습니다.');
  }
  if (!Array.isArray(value.unavailableFields) || !value.unavailableFields.every(isNonEmptyString)) {
    throw new MarketInformationContractError('INVALID_UNAVAILABLE_FIELDS', '누락 필드 메타데이터가 올바르지 않습니다.');
  }
  if (!validNullableNonEmptyString(value.errorCode)) {
    throw new MarketInformationContractError('INVALID_ERROR_CODE', '시장정보 오류 코드 형식이 올바르지 않습니다.');
  }
}

function requireSection(
  value: unknown,
  route: MarketInformationRoute,
  dataKind: 'array' | 'object',
  name: string,
): asserts value is MarketInformationSection<unknown> {
  if (!isObject(value)) throw new MarketInformationContractError('SECTION_REQUIRED', `${name} section이 없습니다.`);
  if (!SECTION_STATUSES.includes(value.status as MarketInformationStatus)) {
    throw new MarketInformationContractError('INVALID_SECTION_STATUS', `${name} section 상태가 올바르지 않습니다.`);
  }
  if (dataKind === 'array' ? !Array.isArray(value.data) : !isObject(value.data)) {
    throw new MarketInformationContractError('INVALID_SECTION_DATA', `${name} section 데이터 형식이 올바르지 않습니다.`);
  }
  requireMeta(value.meta, route);
  if (!validNullableString(value.message)) {
    throw new MarketInformationContractError('INVALID_SECTION_MESSAGE', `${name} section 메시지 형식이 올바르지 않습니다.`);
  }

  const status = value.status as MarketInformationStatus;
  if (dataKind === 'array') {
    const rows = value.data as unknown[];
    if (status === 'ready' && rows.length === 0) {
      throw new MarketInformationContractError('READY_SECTION_EMPTY', `${name} ready section에 근거 행이 없습니다.`);
    }
    if (status === 'empty' && rows.length !== 0) {
      throw new MarketInformationContractError('EMPTY_SECTION_HAS_DATA', `${name} empty section에 데이터가 포함되어 있습니다.`);
    }
  }
  if (status === 'stale' && (value.meta as MarketInformationMeta).isStale !== true) {
    throw new MarketInformationContractError('STALE_STATUS_MISMATCH', `${name} stale 상태에 stale 근거가 없습니다.`);
  }
  if (status === 'partial' && (value.meta as MarketInformationMeta).partial !== true) {
    throw new MarketInformationContractError('PARTIAL_STATUS_MISMATCH', `${name} partial 상태에 partial 근거가 없습니다.`);
  }
  if ((status === 'unsupported' || status === 'unavailable' || status === 'error')
    && !isNonEmptyString((value.meta as MarketInformationMeta).errorCode)) {
    throw new MarketInformationContractError('ERROR_STATUS_WITHOUT_CODE', `${name} 가용성 상태에 오류 코드가 없습니다.`);
  }
}

function requireIndices(value: unknown): asserts value is MarketInformationIndexRow[] {
  if (!Array.isArray(value)) throw new MarketInformationContractError('INDEX_ARRAY_REQUIRED', '지수 배열이 없습니다.');
  for (const item of value) {
    if (!isObject(item) || !isNonEmptyString(item.key) || !isNonEmptyString(item.label)
      || !isFiniteNumber(item.value) || item.value <= 0 || !validNullableNumber(item.changePercent)) {
      throw new MarketInformationContractError('INVALID_INDEX_ROW', '지수 근거 행이 올바르지 않습니다.');
    }
  }
}

function requireAssets(value: unknown, route: MarketInformationRoute): asserts value is MarketInformationAssetRow[] {
  if (!Array.isArray(value)) throw new MarketInformationContractError('ASSET_ARRAY_REQUIRED', '종목 배열이 없습니다.');
  for (const item of value) {
    if (!isObject(item) || !isNonEmptyString(item.symbol) || !isNonEmptyString(item.name) || !isNonEmptyString(item.exchange)) {
      throw new MarketInformationContractError('INVALID_ASSET_IDENTITY', '종목 식별 정보가 올바르지 않습니다.');
    }
    if (item.currency !== route.currency) {
      throw new MarketInformationContractError('ASSET_CURRENCY_MISMATCH', '종목 통화가 정보방 통화와 일치하지 않습니다.');
    }
    if (!isFiniteNumber(item.price) || item.price <= 0 || !validNullableNumber(item.changePercent)
      || !validNullablePositiveNumber(item.high24h) || !validNullablePositiveNumber(item.low24h)
      || !validNullableNonNegativeNumber(item.volume24h) || !validNullableNonNegativeNumber(item.tradingValue24h)
      || !validNullableNonNegativeNumber(item.marketCap) || !validNullableNumber(item.fundingRatePercent)
      || !validNullableNonNegativeNumber(item.openInterest) || !validNullableNonNegativeNumber(item.rangeVolatility24hPercent)) {
      throw new MarketInformationContractError('INVALID_ASSET_NUMBER', '종목 수치 근거가 올바르지 않습니다.');
    }
    if (typeof item.warning !== 'boolean' || !validNullableNonEmptyString(item.tradingStatus)
      || !validNullableString(item.nextFundingAt) || !validNullableString(item.providerUpdatedAt)) {
      throw new MarketInformationContractError('INVALID_ASSET_META', '종목 상태 정보가 올바르지 않습니다.');
    }
    if (item.nextFundingAt != null) requireIso(item.nextFundingAt, 'nextFundingAt');
    if (item.providerUpdatedAt != null) requireIso(item.providerUpdatedAt, 'asset.providerUpdatedAt', { rejectFuture: true });
  }
}

function requireSectors(value: unknown): asserts value is MarketInformationSectorRow[] {
  if (!Array.isArray(value)) throw new MarketInformationContractError('SECTOR_ARRAY_REQUIRED', '섹터 배열이 없습니다.');
  for (const item of value) {
    if (!isObject(item) || !isNonEmptyString(item.key) || !isNonEmptyString(item.label)
      || !validNullableNonNegativeNumber(item.tradingValue)
      || !isFiniteNumber(item.constituentCount) || !Number.isInteger(item.constituentCount) || item.constituentCount < 0
      || !validNullableNumber(item.changePercent)) {
      throw new MarketInformationContractError('INVALID_SECTOR_ROW', '섹터 근거 행이 올바르지 않습니다.');
    }
  }
}

function requireHttpUrl(value: unknown): void {
  if (!isNonEmptyString(value)) throw new MarketInformationContractError('INVALID_NEWS_URL', '뉴스·공시 URL이 없습니다.');
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol');
  } catch {
    throw new MarketInformationContractError('INVALID_NEWS_URL', '뉴스·공시 URL 형식이 올바르지 않습니다.');
  }
}

function requireNewsRows(value: unknown, expectedKind: MarketInformationNewsRow['kind']): asserts value is MarketInformationNewsRow[] {
  if (!Array.isArray(value)) throw new MarketInformationContractError('NEWS_ARRAY_REQUIRED', '뉴스·공시 배열이 없습니다.');
  for (const item of value) {
    if (!isObject(item) || !isNonEmptyString(item.id) || item.kind !== expectedKind
      || !isNonEmptyString(item.symbol) || !isNonEmptyString(item.title)
      || !validNullableString(item.summary) || !isNonEmptyString(item.provider) || !isNonEmptyString(item.source)) {
      throw new MarketInformationContractError('INVALID_NEWS_ROW', '뉴스·공시 근거 행이 올바르지 않습니다.');
    }
    requireHttpUrl(item.url);
    requireIso(item.publishedAt, `${expectedKind}.publishedAt`, { rejectFuture: true });
  }
}

function requireDerivatives(value: unknown): asserts value is MarketInformationDerivativesData {
  if (!isObject(value) || !isNonEmptyString(value.referenceSymbol)
    || !validNullableNonNegativeNumber(value.longRatio)
    || !validNullableNonNegativeNumber(value.shortRatio)
    || !validNullableNonNegativeNumber(value.longShortRatio)
    || !validNullableString(value.ratioObservedAt)
    || !Array.isArray(value.liquidations)) {
    throw new MarketInformationContractError('INVALID_DERIVATIVES', '선물 파생지표 근거가 올바르지 않습니다.');
  }
  if (value.ratioObservedAt != null) requireIso(value.ratioObservedAt, 'ratioObservedAt', { rejectFuture: true });
  for (const item of value.liquidations) {
    if (!isObject(item) || !isNonEmptyString(item.symbol)
      || (item.side !== 'long' && item.side !== 'short' && item.side !== 'unknown')
      || !validNullablePositiveNumber(item.price) || !validNullableNonNegativeNumber(item.amount)
      || !validNullableString(item.occurredAt)) {
      throw new MarketInformationContractError('INVALID_LIQUIDATION_ROW', '청산 근거 행이 올바르지 않습니다.');
    }
    if (item.occurredAt != null) requireIso(item.occurredAt, 'liquidation.occurredAt', { rejectFuture: true });
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
  if (payload.ok !== true || payload.room !== route.id || payload.market !== route.market
    || payload.assetType !== expectedAssetType(route) || payload.currency !== route.currency) {
    throw new MarketInformationContractError('ROOM_CONTRACT_MISMATCH', '시장정보 응답이 요청한 정보방과 일치하지 않습니다.');
  }
  requireIso(payload.fetchedAt, 'fetchedAt', { rejectFuture: true });
  if (typeof payload.partial !== 'boolean' || !isObject(payload.sections)) {
    throw new MarketInformationContractError('INVALID_RESPONSE_META', '시장정보 응답 상태가 올바르지 않습니다.');
  }

  const sections = payload.sections;
  requireSection(sections.indices, route, 'array', 'indices');
  requireSection(sections.rankings, route, 'array', 'rankings');
  requireSection(sections.sectors, route, 'array', 'sectors');
  requireSection(sections.news, route, 'array', 'news');
  requireSection(sections.disclosures, route, 'array', 'disclosures');
  requireSection(sections.derivatives, route, 'object', 'derivatives');

  requireIndices((sections.indices as Record<string, unknown>).data);
  requireAssets((sections.rankings as Record<string, unknown>).data, route);
  requireSectors((sections.sectors as Record<string, unknown>).data);
  requireNewsRows((sections.news as Record<string, unknown>).data, 'news');
  requireNewsRows((sections.disclosures as Record<string, unknown>).data, 'disclosure');
  requireDerivatives((sections.derivatives as Record<string, unknown>).data);
  requireZeroOutboundPolicy(payload.requestPolicy);

  const derivedPartial = Object.values(sections).some((item) => isObject(item) && (
    item.status === 'partial' || item.status === 'stale' || item.status === 'unavailable' || item.status === 'error'
  ));
  if (payload.partial !== derivedPartial) {
    throw new MarketInformationContractError('PARTIAL_RESPONSE_MISMATCH', '전체 partial 상태가 section 근거와 일치하지 않습니다.');
  }

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
