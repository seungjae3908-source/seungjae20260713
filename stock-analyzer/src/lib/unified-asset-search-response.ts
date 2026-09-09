import type {
  UnifiedAssetFilter,
  UnifiedAssetSuggestResponse,
  UnifiedAssetSuggestion,
  UnifiedMarketFilter,
  UnifiedSearchProviderStatus,
  UnifiedSearchState,
} from './unified-asset-search';

const FUTURE_SKEW_MS = 30_000;
const FRESH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const USER_SAFE_MESSAGE = '검색 응답을 검증하지 못했습니다. 다시 시도해 주세요.';
const STATES = new Set<UnifiedSearchState>(['FULL', 'PARTIAL', 'DEGRADED', 'EMPTY', 'ERROR']);
const ASSETS = new Set<UnifiedAssetFilter>(['all', 'stock', 'coin']);
const MARKETS = new Set<UnifiedMarketFilter>(['KR', 'US', 'spot', 'futures']);
const PROVIDER_STATES = new Set<UnifiedSearchProviderStatus['status']>(['ok', 'stale', 'error']);

export class UnifiedSearchResponseContractError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(USER_SAFE_MESSAGE);
    this.name = 'UNIFIED_SEARCH_RESPONSE_INVALID';
    this.detail = detail;
  }
}

function fail(detail: string): never {
  throw new UnifiedSearchResponseContractError(detail);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  return value;
}

function safeCount(value: unknown, label: string, allowZero = true): number {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) fail(`${label} must be a safe non-negative integer`);
  return Number(value);
}

function timestamp(value: unknown, label: string, nowMs: number): string {
  const raw = nonEmptyString(value, label);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) fail(`${label} must be a valid timestamp`);
  if (parsed > nowMs + FUTURE_SKEW_MS) fail(`${label} is in the future`);
  return raw;
}

function expectedState(count: number, partial: boolean, stale: boolean): Exclude<UnifiedSearchState, 'ERROR'> {
  if (count > 0) {
    if (partial) return 'PARTIAL';
    if (stale) return 'DEGRADED';
    return 'FULL';
  }
  if (partial || stale) return 'DEGRADED';
  return 'EMPTY';
}

function parseProvider(value: unknown, index: number, nowMs: number): UnifiedSearchProviderStatus {
  const item = record(value, `providers[${index}]`);
  const provider = nonEmptyString(item.provider, `providers[${index}].provider`);
  if (typeof item.status !== 'string' || !PROVIDER_STATES.has(item.status as UnifiedSearchProviderStatus['status'])) {
    fail(`providers[${index}].status is invalid`);
  }
  const status = item.status as UnifiedSearchProviderStatus['status'];
  const count = safeCount(item.count, `providers[${index}].count`);
  let dataAsOf: string | null = null;
  if (item.dataAsOf != null) dataAsOf = timestamp(item.dataAsOf, `providers[${index}].dataAsOf`, nowMs);
  if (status === 'ok' && dataAsOf == null) fail(`providers[${index}] ok status requires dataAsOf`);
  if (item.message != null && typeof item.message !== 'string') fail(`providers[${index}].message must be a string`);
  return { provider, status, count, dataAsOf, ...(typeof item.message === 'string' ? { message: item.message } : {}) };
}

function parseResult(
  value: unknown,
  index: number,
  expectedAsset: UnifiedAssetFilter,
  expectedMarket: UnifiedMarketFilter | null,
  nowMs: number,
): UnifiedAssetSuggestion {
  const item = record(value, `results[${index}]`);
  if (item.assetType !== 'stock' && item.assetType !== 'coin') fail(`results[${index}].assetType is invalid`);
  const assetType = item.assetType;
  if (typeof item.market !== 'string' || !MARKETS.has(item.market as UnifiedMarketFilter)) fail(`results[${index}].market is invalid`);
  const market = item.market as UnifiedMarketFilter;
  if (item.instrumentType !== 'stock' && item.instrumentType !== 'spot' && item.instrumentType !== 'futures') {
    fail(`results[${index}].instrumentType is invalid`);
  }
  const instrumentType = item.instrumentType;
  if (expectedAsset !== 'all' && assetType !== expectedAsset) fail(`results[${index}] violates requested asset filter`);
  if (expectedMarket && market !== expectedMarket) fail(`results[${index}] violates requested market filter`);
  if (assetType === 'stock') {
    if ((market !== 'KR' && market !== 'US') || instrumentType !== 'stock') fail(`results[${index}] stock identity is inconsistent`);
    nonEmptyString(item.ticker, `results[${index}].ticker`);
  } else {
    if ((market !== 'spot' && market !== 'futures') || instrumentType !== market) fail(`results[${index}] coin identity is inconsistent`);
    nonEmptyString(item.symbol, `results[${index}].symbol`);
  }

  nonEmptyString(item.id, `results[${index}].id`);
  nonEmptyString(item.exchange, `results[${index}].exchange`);
  nonEmptyString(item.productCode, `results[${index}].productCode`);
  stringValue(item.koreanName, `results[${index}].koreanName`);
  stringValue(item.englishName, `results[${index}].englishName`);
  nonEmptyString(item.displayName, `results[${index}].displayName`);
  nonEmptyString(item.baseSymbol, `results[${index}].baseSymbol`);
  nonEmptyString(item.quoteCurrency, `results[${index}].quoteCurrency`);
  nonEmptyString(item.matchType, `results[${index}].matchType`);
  if (typeof item.active !== 'boolean') fail(`results[${index}].active must be boolean`);
  nonEmptyString(item.provider, `results[${index}].provider`);
  timestamp(item.dataAsOf, `results[${index}].dataAsOf`, nowMs);

  return item as unknown as UnifiedAssetSuggestion;
}

export function parseUnifiedAssetSuggestResponse(
  payload: unknown,
  expected: { q: string; asset: UnifiedAssetFilter; market: UnifiedMarketFilter | null },
  nowMs = Date.now(),
): UnifiedAssetSuggestResponse {
  const root = record(payload, 'response');
  if (root.ok !== true) fail('HTTP 200 response must have ok=true');
  if (typeof root.state !== 'string' || !STATES.has(root.state as UnifiedSearchState) || root.state === 'ERROR') fail('response.state is invalid');
  const state = root.state as Exclude<UnifiedSearchState, 'ERROR'>;
  const expectedQuery = expected.q.normalize('NFKC').trim();
  if (nonEmptyString(root.q, 'response.q') !== expectedQuery) fail('response.q does not match request');
  if (typeof root.asset !== 'string' || !ASSETS.has(root.asset as UnifiedAssetFilter) || root.asset !== expected.asset) fail('response.asset does not match request');
  if (root.market !== null && (typeof root.market !== 'string' || !MARKETS.has(root.market as UnifiedMarketFilter))) fail('response.market is invalid');
  if (root.market !== expected.market) fail('response.market does not match request');
  if (!Array.isArray(root.results)) fail('response.results must be an array');
  if (!Array.isArray(root.providers) || root.providers.length === 0) fail('response.providers must be a non-empty array');
  if (!Array.isArray(root.hiddenMatches)) fail('response.hiddenMatches must be an array');
  if (typeof root.stale !== 'boolean' || typeof root.partial !== 'boolean') fail('response stale/partial flags are invalid');

  const count = safeCount(root.count, 'response.count');
  if (count !== root.results.length) fail('response.count does not match results length');
  const stale = root.stale;
  const partial = root.partial;
  if (state !== expectedState(count, partial, stale)) fail('response.state is inconsistent with count/partial/stale');

  const providers = root.providers.map((item, index) => parseProvider(item, index, nowMs));
  const computedPartial = providers.some((provider) => provider.status !== 'ok');
  if (partial !== computedPartial) fail('response.partial is inconsistent with provider states');
  if (!stale && providers.some((provider) => provider.status === 'stale')) fail('response.stale is inconsistent with provider states');

  let dataAsOf: string | null = null;
  if (root.dataAsOf != null) {
    dataAsOf = timestamp(root.dataAsOf, 'response.dataAsOf', nowMs);
    if (!stale && nowMs - Date.parse(dataAsOf) > FRESH_MAX_AGE_MS) fail('response.dataAsOf is stale while stale=false');
  } else if (!stale && !partial) {
    fail('fresh complete response requires dataAsOf');
  }

  const seenIds = new Set<string>();
  const seenProductCodes = new Set<string>();
  const results = root.results.map((item, index) => {
    const parsed = parseResult(item, index, expected.asset, expected.market, nowMs);
    if (seenIds.has(parsed.id)) fail(`results[${index}].id is duplicated`);
    seenIds.add(parsed.id);
    const productIdentity = `${parsed.market}:${parsed.productCode}`;
    if (seenProductCodes.has(productIdentity)) fail(`results[${index}].productCode is duplicated for market`);
    seenProductCodes.add(productIdentity);
    return parsed;
  });

  const hiddenSeen = new Set<UnifiedMarketFilter>();
  const hiddenMatches = root.hiddenMatches.map((value, index) => {
    const item = record(value, `hiddenMatches[${index}]`);
    if (typeof item.market !== 'string' || !MARKETS.has(item.market as UnifiedMarketFilter)) fail(`hiddenMatches[${index}].market is invalid`);
    const market = item.market as UnifiedMarketFilter;
    const hiddenCount = safeCount(item.count, `hiddenMatches[${index}].count`, false);
    if (expected.market == null) fail('hiddenMatches must be empty without a market filter');
    if (market === expected.market) fail(`hiddenMatches[${index}] repeats selected market`);
    if (hiddenSeen.has(market)) fail(`hiddenMatches[${index}].market is duplicated`);
    hiddenSeen.add(market);
    return { market, count: hiddenCount };
  });

  return {
    ok: true,
    state,
    q: expectedQuery,
    asset: expected.asset,
    market: expected.market,
    results,
    count,
    dataAsOf,
    stale,
    partial,
    providers,
    hiddenMatches,
  };
}
