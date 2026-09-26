export type StockDetailObject = Record<string, unknown>;

const MARKETS = new Set(['KR', 'US']);
const MARKET_FLOW_PERIODS = new Set(['daily', 'weekly', 'monthly', 'yearly']);
const SPECIAL_FEED_KINDS = new Set(['news', 'disclosure', 'signal']);
const SPECIAL_FEED_TONES = new Set(['positive', 'negative', 'neutral']);
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_FRESH_RESPONSE_AGE_MS = 10 * 60_000;

export const INVALID_STOCK_INFO_RESPONSE = 'INVALID_STOCK_INFO_RESPONSE';

export class StockDetailContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StockDetailContractError';
  }
}

function isRecord(value: unknown): value is StockDetailObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredRecord(value: unknown, field: string): StockDetailObject {
  if (!isRecord(value)) throw new StockDetailContractError(`invalid ${field}`);
  return value;
}

function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new StockDetailContractError(`invalid ${field}`);
  return value;
}

function requiredText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new StockDetailContractError(`invalid ${field}`);
  return text;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new StockDetailContractError(`invalid ${field}`);
  }
  return value;
}

function requiredFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new StockDetailContractError(`invalid ${field}`);
  }
  return value;
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  const number = requiredFinite(value, field);
  if (!Number.isInteger(number) || number < 0) {
    throw new StockDetailContractError(`invalid ${field}`);
  }
  return number;
}

function requiredIsoTime(
  value: unknown,
  field: string,
  options: { maxAgeMs?: number; allowPast?: boolean } = {},
): number {
  const text = requiredText(value, field);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new StockDetailContractError(`invalid ${field}`);
  const now = Date.now();
  if (timestamp > now + MAX_FUTURE_SKEW_MS) {
    throw new StockDetailContractError(`${field} is in the future`);
  }
  if (!options.allowPast && options.maxAgeMs != null && now - timestamp > options.maxAgeMs) {
    throw new StockDetailContractError(`${field} is stale`);
  }
  return timestamp;
}

function assertTicker(value: StockDetailObject, expectedTicker: string): void {
  const ticker = requiredText(value.ticker, 'ticker').toUpperCase();
  if (ticker !== expectedTicker.toUpperCase()) {
    throw new StockDetailContractError('ticker mismatch');
  }
}

function assertIdentity(
  value: StockDetailObject,
  expectedTicker: string,
  expectedMarket: 'KR' | 'US',
  options: { requireMarketCurrency: boolean },
): void {
  assertTicker(value, expectedTicker);

  if (options.requireMarketCurrency || value.market != null) {
    const market = requiredText(value.market, 'market').toUpperCase();
    if (!MARKETS.has(market) || market !== expectedMarket) {
      throw new StockDetailContractError('market mismatch');
    }
  }

  if (options.requireMarketCurrency || value.currency != null) {
    const currency = requiredText(value.currency, 'currency').toUpperCase();
    const expectedCurrency = expectedMarket === 'KR' ? 'KRW' : 'USD';
    if (currency !== expectedCurrency) {
      throw new StockDetailContractError('currency mismatch');
    }
  }
}

export function parseStockDetailQuote(
  value: unknown,
  expectedTicker: string,
  expectedMarket: 'KR' | 'US',
): StockDetailObject {
  if (!isRecord(value)) throw new StockDetailContractError('quote payload must be an object');
  assertIdentity(value, expectedTicker, expectedMarket, { requireMarketCurrency: true });
  requiredText(value.name, 'name');
  const price = requiredFinite(value.price, 'price');
  if (price <= 0) throw new StockDetailContractError('price must be positive');
  requiredFinite(value.changePercent, 'changePercent');
  return value;
}

export function parseStockDetailProfile(
  value: unknown,
  expectedTicker: string,
  expectedMarket: 'KR' | 'US',
): StockDetailObject {
  if (!isRecord(value)) throw new StockDetailContractError('profile payload must be an object');
  assertIdentity(value, expectedTicker, expectedMarket, { requireMarketCurrency: true });
  requiredText(value.name ?? value.companyName, 'name');
  requiredString(value.description, 'description');
  requiredString(value.industry, 'industry');
  requiredString(value.sector, 'sector');
  requiredString(value.country, 'country');
  requiredString(value.mainBusiness, 'mainBusiness');
  if (!Array.isArray(value.competitors) || value.competitors.some((item) => typeof item !== 'string')) {
    throw new StockDetailContractError('invalid competitors');
  }
  return value;
}

function assertNewsItem(value: unknown): void {
  if (!isRecord(value)) throw new StockDetailContractError('invalid news item');
  requiredText(value.title ?? value.headline, 'news title');
}

export function parseStockDetailNews(
  value: unknown,
  expectedTicker: string,
  expectedMarket: 'KR' | 'US',
): StockDetailObject {
  if (!isRecord(value)) throw new StockDetailContractError('news payload must be an object');
  assertIdentity(value, expectedTicker, expectedMarket, { requireMarketCurrency: false });
  if (!Array.isArray(value.items) || !Array.isArray(value.news)) {
    throw new StockDetailContractError('news arrays are required');
  }
  value.items.forEach(assertNewsItem);
  value.news.forEach(assertNewsItem);
  if (value.items.length !== value.news.length) {
    throw new StockDetailContractError('news arrays disagree');
  }
  if (typeof value.summary !== 'string') {
    throw new StockDetailContractError('news summary is required');
  }
  return value;
}

function parseStockDetailFinancials(value: unknown, expectedTicker: string): StockDetailObject {
  const payload = requiredRecord(value, 'financials payload');
  assertTicker(payload, expectedTicker);
  const financials = requiredRecord(payload.financials, 'financials');
  const annual = requiredArray(financials.annual, 'financials.annual');
  requiredArray(financials.quarterly, 'financials.quarterly');
  requiredRecord(financials.ratios, 'financials.ratios');
  const items = requiredArray(payload.items, 'items');
  if (items.length !== annual.length) throw new StockDetailContractError('financial items disagree');
  requiredArray(payload.annual, 'annual');
  requiredArray(payload.quarterly, 'quarterly');
  requiredRecord(payload.ratios, 'ratios');
  requiredString(payload.summary, 'summary');
  return payload;
}

function assertDisclosureItem(value: unknown): void {
  const item = requiredRecord(value, 'disclosure item');
  requiredText(item.title ?? item.report_nm ?? item.reportName ?? item.form, 'disclosure title');
}

function parseStockDetailDisclosures(value: unknown, expectedTicker: string): StockDetailObject {
  const payload = requiredRecord(value, 'disclosures payload');
  assertTicker(payload, expectedTicker);
  const disclosures = requiredArray(payload.disclosures, 'disclosures');
  const filings = requiredArray(payload.filings, 'filings');
  const items = requiredArray(payload.items, 'items');
  if (disclosures.length !== filings.length || items.length !== disclosures.length) {
    throw new StockDetailContractError('disclosure arrays disagree');
  }
  items.forEach(assertDisclosureItem);
  requiredString(payload.summary, 'summary');
  return payload;
}

function normalizedFlowPeriod(url: URL): string {
  const raw = (url.searchParams.get('period') ?? 'daily').trim().toLowerCase();
  return MARKET_FLOW_PERIODS.has(raw) ? raw : 'daily';
}

function assertFlowTotals(value: unknown): void {
  const totals = requiredRecord(value, 'totals');
  for (const field of ['individual', 'institution', 'foreign', 'program', 'volume', 'value', 'tradeValue']) {
    const item = totals[field];
    if (item !== null && (typeof item !== 'number' || !Number.isFinite(item))) {
      throw new StockDetailContractError(`invalid totals.${field}`);
    }
  }
}

function assertInvestorFlowRow(value: unknown): void {
  const row = requiredRecord(value, 'market flow row');
  requiredText(row.date, 'market flow date');
  requiredFinite(row.individual, 'market flow individual');
  requiredFinite(row.institution, 'market flow institution');
  requiredFinite(row.foreign, 'market flow foreign');
}

function parseMarketFlow(value: unknown, expectedTicker: string, url: URL): StockDetailObject {
  const payload = requiredRecord(value, 'market flow payload');
  assertTicker(payload, expectedTicker);
  const period = requiredText(payload.period, 'period');
  if (period !== normalizedFlowPeriod(url)) throw new StockDetailContractError('market flow period mismatch');
  if (typeof payload.available !== 'boolean') throw new StockDetailContractError('invalid market flow availability');
  const rows = requiredArray(payload.rows, 'rows');
  assertFlowTotals(payload.totals);

  if (!payload.available) {
    if (rows.length !== 0) throw new StockDetailContractError('unavailable market flow contains rows');
    requiredText(payload.message, 'market flow message');
    return payload;
  }

  if (rows.length === 0) throw new StockDetailContractError('available market flow has no rows');
  rows.forEach(assertInvestorFlowRow);
  requiredText(payload.provider, 'market flow provider');
  requiredText(payload.source, 'market flow source');
  requiredText(payload.asOf, 'market flow asOf');
  requiredIsoTime(payload.updatedAt, 'market flow updatedAt', { maxAgeMs: MAX_FRESH_RESPONSE_AGE_MS });
  return payload;
}

function assertShortRow(value: unknown): void {
  const row = requiredRecord(value, 'short-selling row');
  requiredText(row.date, 'short-selling date');
  requiredFinite(row.shortVolume, 'short-selling volume');
  requiredFinite(row.ratio, 'short-selling ratio');
}

function parseShortSelling(value: unknown, expectedTicker: string, url: URL): StockDetailObject {
  const payload = requiredRecord(value, 'short-selling payload');
  assertTicker(payload, expectedTicker);
  if (typeof payload.available !== 'boolean') throw new StockDetailContractError('invalid short-selling availability');
  const rows = requiredArray(payload.rows, 'rows');

  if (!payload.available) {
    if (rows.length !== 0 || payload.latest !== null) {
      throw new StockDetailContractError('unavailable short-selling contains evidence');
    }
    requiredText(payload.message, 'short-selling message');
    return payload;
  }

  const period = requiredText(payload.period, 'period');
  if (period !== normalizedFlowPeriod(url)) throw new StockDetailContractError('short-selling period mismatch');
  if (rows.length === 0) throw new StockDetailContractError('available short-selling has no rows');
  rows.forEach(assertShortRow);
  requiredRecord(payload.latest, 'short-selling latest');
  requiredText(payload.source, 'short-selling source');
  return payload;
}

function assertSpecialFeedItem(value: unknown, market: 'KR' | 'US'): void {
  const item = requiredRecord(value, 'special feed item');
  requiredText(item.id, 'special feed id');
  requiredText(item.ticker, 'special feed ticker');
  requiredText(item.name, 'special feed name');
  requiredText(item.title, 'special feed title');
  requiredString(item.summary, 'special feed summary');
  requiredText(item.source, 'special feed source');
  const kind = requiredText(item.kind, 'special feed kind');
  if (!SPECIAL_FEED_KINDS.has(kind)) throw new StockDetailContractError('invalid special feed kind');
  const tone = requiredText(item.tone, 'special feed tone');
  if (!SPECIAL_FEED_TONES.has(tone)) throw new StockDetailContractError('invalid special feed tone');
  if (requiredText(item.market, 'special feed market') !== market) {
    throw new StockDetailContractError('special feed market mismatch');
  }
  const expectedCurrency = market === 'KR' ? 'KRW' : 'USD';
  if (requiredText(item.currency, 'special feed currency') !== expectedCurrency) {
    throw new StockDetailContractError('special feed currency mismatch');
  }
  requiredIsoTime(item.detectedAt, 'special feed detectedAt', { maxAgeMs: 2 * 60 * 60_000 });
  const expiresAt = requiredIsoTime(item.expiresAt, 'special feed expiresAt', { allowPast: true });
  if (expiresAt <= Date.now() - MAX_FUTURE_SKEW_MS) {
    throw new StockDetailContractError('expired special feed item');
  }
  if (item.sourceAt != null) requiredIsoTime(item.sourceAt, 'special feed sourceAt', { allowPast: true });
}

function parseSpecialFeed(value: unknown, url: URL): StockDetailObject {
  const payload = requiredRecord(value, 'special feed payload');
  if (payload.ok !== true) throw new StockDetailContractError('special feed ok must be true');
  const expectedMarket = (url.searchParams.get('market') ?? 'KR').toUpperCase() === 'US' ? 'US' : 'KR';
  if (requiredText(payload.market, 'market').toUpperCase() !== expectedMarket) {
    throw new StockDetailContractError('special feed market mismatch');
  }
  const items = requiredArray(payload.items, 'items');
  const count = requiredNonNegativeInteger(payload.count, 'count');
  if (count !== items.length) throw new StockDetailContractError('special feed count mismatch');
  requiredNonNegativeInteger(payload.catalogSize, 'catalogSize');
  requiredNonNegativeInteger(payload.scannedNow, 'scannedNow');
  requiredNonNegativeInteger(payload.nextCursor, 'nextCursor');
  if (payload.ttlMinutes !== 60 || payload.refreshSeconds !== 30) {
    throw new StockDetailContractError('special feed policy mismatch');
  }
  requiredString(payload.note, 'note');
  requiredIsoTime(payload.updatedAt, 'special feed updatedAt', { maxAgeMs: MAX_FRESH_RESPONSE_AGE_MS });
  items.forEach((item) => assertSpecialFeedItem(item, expectedMarket));
  return payload;
}

const STOCK_INFO_ENDPOINTS = new Set([
  'quote',
  'profile',
  'financials',
  'market-flow',
  'short-selling',
  'news',
  'disclosures',
]);

export function isStockInfoResponsePath(path: string): boolean {
  if (path === '/api/stocks/special-feed') return true;
  const match = path.match(/^\/api\/stocks\/[^/]+\/([^/]+)$/);
  return Boolean(match && STOCK_INFO_ENDPOINTS.has(match[1]));
}

export function requireStockInfoSuccessResponse(rawUrl: string, value: unknown): StockDetailObject {
  const url = new URL(rawUrl, 'https://stock-info.invalid');
  if (url.pathname === '/api/stocks/special-feed') return parseSpecialFeed(value, url);

  const match = url.pathname.match(/^\/api\/stocks\/([^/]+)\/([^/]+)$/);
  if (!match || !STOCK_INFO_ENDPOINTS.has(match[2])) {
    throw new StockDetailContractError('unsupported stock info path');
  }

  const ticker = decodeURIComponent(match[1]).trim().toUpperCase();
  if (!ticker) throw new StockDetailContractError('missing stock info ticker');
  const market: 'KR' | 'US' = /^\d{6}$/.test(ticker) ? 'KR' : 'US';

  switch (match[2]) {
    case 'quote':
      return parseStockDetailQuote(value, ticker, market);
    case 'profile':
      return parseStockDetailProfile(value, ticker, market);
    case 'financials':
      return parseStockDetailFinancials(value, ticker);
    case 'market-flow':
      return parseMarketFlow(value, ticker, url);
    case 'short-selling':
      return parseShortSelling(value, ticker, url);
    case 'news':
      return parseStockDetailNews(value, ticker, market);
    case 'disclosures':
      return parseStockDetailDisclosures(value, ticker);
    default:
      throw new StockDetailContractError('unsupported stock info path');
  }
}
