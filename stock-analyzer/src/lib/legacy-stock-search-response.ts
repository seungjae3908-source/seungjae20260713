const FUTURE_SKEW_MS = 5_000;
const MAX_AGE_MS = 2 * 60 * 1000;

export const INVALID_LEGACY_STOCK_SEARCH_RESPONSE = 'INVALID_LEGACY_STOCK_SEARCH_RESPONSE';

export interface LegacyStockSearchRow {
  ticker: string;
  name: string;
  market: 'KR' | 'US';
  currency: 'KRW' | 'USD';
  assetType: string;
  aliases?: string[];
}

export interface LegacyStockSearchResponse {
  q: string;
  results: LegacyStockSearchRow[];
  count: number;
  updatedAt: string;
}

export class LegacyStockSearchResponseError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(INVALID_LEGACY_STOCK_SEARCH_RESPONSE);
    this.name = INVALID_LEGACY_STOCK_SEARCH_RESPONSE;
    this.detail = detail;
  }
}

function fail(detail: string): never {
  throw new LegacyStockSearchResponseError(detail);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function parseTimestamp(value: unknown, label: string, nowMs: number): string {
  const raw = nonEmptyString(value, label);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) fail(`${label} must be a valid timestamp`);
  if (parsed > nowMs + FUTURE_SKEW_MS) fail(`${label} is in the future`);
  if (nowMs - parsed > MAX_AGE_MS) fail(`${label} is stale`);
  return raw;
}

function parseRow(value: unknown, index: number): LegacyStockSearchRow {
  const row = record(value, `results[${index}]`);
  const ticker = nonEmptyString(row.ticker, `results[${index}].ticker`).trim().toUpperCase();
  if (row.ticker !== ticker) fail(`results[${index}].ticker is not canonical`);

  const name = nonEmptyString(row.name, `results[${index}].name`).trim();
  if (row.name !== name) fail(`results[${index}].name is not canonical`);

  if (row.market !== 'KR' && row.market !== 'US') {
    fail(`results[${index}].market is invalid`);
  }
  const market = row.market;
  const expectedCurrency = market === 'KR' ? 'KRW' : 'USD';
  if (row.currency !== expectedCurrency) {
    fail(`results[${index}].currency does not match market`);
  }

  const assetType = nonEmptyString(row.assetType, `results[${index}].assetType`).trim();
  if (row.assetType !== assetType) fail(`results[${index}].assetType is not canonical`);

  let aliases: string[] | undefined;
  if (row.aliases != null) {
    if (!Array.isArray(row.aliases) || row.aliases.some((alias) => typeof alias !== 'string')) {
      fail(`results[${index}].aliases must be a string array`);
    }
    aliases = row.aliases as string[];
  }

  return {
    ticker,
    name,
    market,
    currency: expectedCurrency,
    assetType,
    ...(aliases ? { aliases } : {}),
  };
}

export function isLegacyStockSearchResponsePath(path: string, method: string): boolean {
  return method.toUpperCase() === 'GET' && path === '/api/search';
}

export function requireLegacyStockSearchResponse(
  requestUrl: string,
  payload: unknown,
  nowMs = Date.now(),
): LegacyStockSearchResponse {
  let url: URL;
  try {
    url = new URL(requestUrl, 'https://app.local');
  } catch {
    fail('request URL is invalid');
  }

  if (url.pathname !== '/api/search') fail('request path is not legacy stock search');
  const expectedQuery = (url.searchParams.get('q') ?? '').trim();

  const root = record(payload, 'response');
  if (typeof root.q !== 'string' || root.q !== expectedQuery) {
    fail('response.q does not match request');
  }
  if (!Array.isArray(root.results)) fail('response.results must be an array');
  if (typeof root.count !== 'number' || !Number.isSafeInteger(root.count) || root.count < 0) {
    fail('response.count must be a safe non-negative integer');
  }
  if (root.count !== root.results.length) fail('response.count does not match results length');

  const updatedAt = parseTimestamp(root.updatedAt, 'response.updatedAt', nowMs);
  const seen = new Set<string>();
  const results = root.results.map((value, index) => {
    const row = parseRow(value, index);
    const identity = `${row.market}:${row.ticker}`;
    if (seen.has(identity)) fail(`results[${index}] duplicates market+ticker identity`);
    seen.add(identity);
    return row;
  });

  return {
    q: expectedQuery,
    results,
    count: root.count,
    updatedAt,
  };
}
