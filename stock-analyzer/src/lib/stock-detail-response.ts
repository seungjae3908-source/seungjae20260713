export type StockDetailObject = Record<string, unknown>;

const MARKETS = new Set(['KR', 'US']);

export class StockDetailContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StockDetailContractError';
  }
}

function isRecord(value: unknown): value is StockDetailObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new StockDetailContractError(`invalid ${field}`);
  return text;
}

function requiredFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new StockDetailContractError(`invalid ${field}`);
  }
  return value;
}

function assertIdentity(
  value: StockDetailObject,
  expectedTicker: string,
  expectedMarket: 'KR' | 'US',
  options: { requireMarketCurrency: boolean },
): void {
  const ticker = requiredText(value.ticker, 'ticker').toUpperCase();
  if (ticker !== expectedTicker.toUpperCase()) {
    throw new StockDetailContractError('ticker mismatch');
  }

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
  assertIdentity(value, expectedTicker, expectedMarket, { requireMarketCurrency: false });
  requiredText(value.name ?? value.companyName, 'name');
  if (value.competitors != null && (!Array.isArray(value.competitors) || value.competitors.some((item) => typeof item !== 'string'))) {
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
