import { getUserSupabase } from '../lib/supabase.ts';
import { MarketDataService } from './market-data.service.ts';
import { loadFreePublicFxQuotes } from './public-fx.service.ts';
import { marketNumber, quoteTimeEvidence } from '../providers/market-evidence';
import { runBoundedWorkPool } from '../lib/bounded-work-pool';
import {
  aggregatePortfolioProviderSnapshots,
  calculateAlignedCorrelation,
  calculateAllocation,
  comparePortfolioAllocation,
  normalizeMoneyToKRW,
  type FxQuote,
  type PortfolioAllocationProfile,
  type PortfolioAssetBucket,
  type PortfolioCurrency,
  type PortfolioProviderSnapshot,
  type ReturnPoint,
} from '../modules/portfolio/index.ts';

type HoldingRow = {
  id: string;
  ticker: string;
  name: string;
  market: string;
  currency: string;
  quantity: number;
  average_price: number;
  purchase_date?: string | null;
  created_at?: string | null;
};

type KnownHolding = {
  id: string;
  sourceHoldingIds: string[];
  ticker: string;
  name: string;
  market: 'KR' | 'US';
  currency: 'KRW' | 'USD';
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  nativeValue: number;
  nativeCost: number;
  changePercent: number | null;
  asOf: string;
  source: string;
};

function finiteNonNegative(value: unknown): number | null {
  const number = marketNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function cleanHolding(value: unknown): HoldingRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const ticker = typeof row.ticker === 'string' ? row.ticker.trim().toUpperCase() : '';
  const name = String(row.name ?? ticker).trim();
  const market = String(row.market ?? '').trim().toUpperCase();
  const currency = typeof row.currency === 'string' ? row.currency : '';
  const quantity = finiteNonNegative(row.quantity);
  const averagePrice = finiteNonNegative(row.average_price);
  if (typeof row.id !== 'string' || !row.id.trim() || !ticker || !name || !['KR', 'US'].includes(market)
    || !(market === 'KR' ? /^\d{6}$/.test(ticker) : /^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker))
    || currency !== (market === 'US' ? 'USD' : 'KRW') || quantity == null || quantity <= 0
    || averagePrice == null || averagePrice <= 0 || !Number.isFinite(quantity * averagePrice)) return null;
  return {
    id: row.id, ticker, name, market, currency, quantity, average_price: averagePrice,
    purchase_date: row.purchase_date == null ? null : String(row.purchase_date),
    created_at: row.created_at == null ? null : String(row.created_at),
  };
}

/** Lots remain auditable, but position risk and averages are per market/currency/asset. */
function aggregateHoldingLots(rows: HoldingRow[]): Array<HoldingRow & { sourceHoldingIds: string[] }> {
  const groups = new Map<string, HoldingRow[]>();
  for (const row of rows) {
    const key = `${row.market}:${row.currency}:${row.ticker}`;
    const lots = groups.get(key) ?? [];
    lots.push(row);
    groups.set(key, lots);
  }
  return Array.from(groups, ([key, lots]) => {
    const quantity = lots.reduce((sum, row) => sum + row.quantity, 0);
    const cost = lots.reduce((sum, row) => sum + row.quantity * row.average_price, 0);
    if (!Number.isFinite(quantity) || !Number.isFinite(cost) || quantity <= 0 || cost <= 0) {
      throw new Error('PORTFOLIO_HOLDINGS_READ_FAILED:AGGREGATE_OVERFLOW');
    }
    return { ...lots[0], id: lots.length === 1 ? lots[0].id : `asset:${key}`,
      sourceHoldingIds: lots.map((row) => row.id).sort(), quantity, average_price: cost / quantity };
  });
}

function bucketFor(market: KnownHolding['market']): PortfolioAssetBucket {
  return market === 'US' ? 'US_STOCKS' : 'KR_STOCKS';
}

function currencyFor(value: string): PortfolioCurrency {
  return value === 'USD' ? 'USD' : 'KRW';
}

function closeReturns(candles: Array<{ time: string | number; close: number }>, now: number): ReturnPoint[] {
  const values = candles.map((item) => ({ close: item.close,
    timestamp: quoteTimeEvidence(item.time, typeof item.time === 'number' ? 'unix-seconds' : 'iso', now).updatedAt,
  }));
  if (values.some((item) => !item.timestamp || !Number.isFinite(item.close) || item.close <= 0)
    || new Set(values.map((item) => item.timestamp)).size !== values.length) return [];
  const sorted = values.map((item) => ({ ...item, timestamp: item.timestamp! }))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const result: ReturnPoint[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (!(previous.close > 0)) continue;
    const value = (current.close / previous.close) - 1;
    if (!Number.isFinite(value)) return [];
    result.push({ timestamp: current.timestamp, startTimestamp: previous.timestamp, value });
  }
  return result;
}

function profileOrDefault(value: unknown): PortfolioAllocationProfile {
  const profile = String(value ?? 'BALANCED').trim().toUpperCase();
  return profile === 'STABLE' || profile === 'GROWTH' ? profile : 'BALANCED';
}

export async function buildPortfolioIntelligence(input: {
  accessToken: string;
  profile?: unknown;
  fetchImpl?: typeof fetch;
  now?: Date;
  loadHoldings?: () => Promise<unknown>;
  loadQuote?: typeof MarketDataService.getQuoteRow;
  loadCandles?: typeof MarketDataService.getCandles;
}) {
  let now = input.now ?? new Date();
  const readHoldings = async () => {
    const client = getUserSupabase(input.accessToken);
    const holdingsResult = await client
    .from('portfolio_holdings')
    .select('id,ticker,name,market,currency,quantity,average_price,purchase_date,created_at')
    .order('created_at', { ascending: false });

    if (holdingsResult.error) throw new Error(`PORTFOLIO_HOLDINGS_READ_FAILED:${holdingsResult.error.code ?? 'UNKNOWN'}`);
    return holdingsResult.data;
  };

  const rawRows = await (input.loadHoldings ?? readHoldings)();
  if (!Array.isArray(rawRows)) throw new Error('PORTFOLIO_HOLDINGS_READ_FAILED:INVALID_SHAPE');
  const parsedRows = rawRows.map(cleanHolding);
  const identityCounts = new Map<string, number>();
  for (const row of parsedRows) if (row) identityCounts.set(row.id, (identityCounts.get(row.id) ?? 0) + 1);
  const validRows = parsedRows.filter((row): row is HoldingRow => row !== null
    && identityCounts.get(row.id) === 1);
  const invalidRowCount = rawRows.length - validRows.length;
  const holdings = aggregateHoldingLots(validRows);
  const [quoteBatch, fx] = await Promise.all([
    runBoundedWorkPool(holdings, (holding) => (input.loadQuote ?? MarketDataService.getQuoteRow.bind(MarketDataService))(holding.ticker),
      { concurrency: 4, deadlineMs: 4_000, itemTimeoutMs: 3_500 }),
    loadFreePublicFxQuotes(input.fetchImpl ?? fetch, now),
  ]);
  const quoteResults = new Map(quoteBatch.outcomes.map((outcome) => [outcome.index, outcome]));
  now = input.now ?? new Date();
  const knownHoldings: KnownHolding[] = [];
  const missingSources: string[] = [];

  holdings.forEach((holding, index) => {
    const result = quoteResults.get(index);
    if (!result || result.status !== 'fulfilled' || !result.value) {
      missingSources.push(`QUOTE:${holding.ticker}:UNAVAILABLE`);
      return;
    }
    const price = finiteNonNegative(result.value.price);
    const time = quoteTimeEvidence(result.value.updatedAt, 'iso', now.getTime());
    if (price == null || price <= 0 || !Number.isFinite(price * holding.quantity)) {
      missingSources.push(`QUOTE:${holding.ticker}:INVALID_PRICE`);
      return;
    }
    if (result.value.ticker !== holding.ticker || result.value.market !== holding.market || result.value.currency !== holding.currency
      || typeof result.value.source !== 'string' || !result.value.source.trim()) {
      missingSources.push(`QUOTE:${holding.ticker}:INVALID_IDENTITY`);
      return;
    }
    if (time.freshness.status !== 'FRESH' || !time.updatedAt || (result.value.freshness && !['FRESH', 'LIVE'].includes(result.value.freshness.status))) {
      missingSources.push(`QUOTE:${holding.ticker}:${time.freshness.status === 'FRESH' ? result.value.freshness?.status : time.freshness.status}`);
      return;
    }
    knownHoldings.push({
      id: holding.id,
      sourceHoldingIds: holding.sourceHoldingIds,
      ticker: holding.ticker,
      name: holding.name,
      market: holding.market as 'KR' | 'US',
      currency: holding.currency as 'KRW' | 'USD',
      quantity: holding.quantity,
      averagePrice: holding.average_price,
      currentPrice: price,
      nativeValue: price * holding.quantity,
      nativeCost: holding.average_price * holding.quantity,
      changePercent: Number.isFinite(result.value.changePercent) ? result.value.changePercent : null,
      asOf: time.updatedAt,
      source: result.value.source,
    });
  });

  if (invalidRowCount > 0) missingSources.push(`PORTFOLIO_HOLDINGS:INVALID_ROWS:${invalidRowCount}`);

  const { quotes: fxQuotes, missing: fxMissing } = fx;
  missingSources.push(...fxMissing);

  const snapshots: PortfolioProviderSnapshot[] = [];
  for (const [market, bucket, currency] of [
    ['KR', 'KR_STOCKS', 'KRW'],
    ['US', 'US_STOCKS', 'USD'],
  ] as const) {
    const marketRows = knownHoldings.filter((row) => row.market === market);
    const missingMarketQuotes = invalidRowCount > 0 || holdings.some((row) => row.market === market && !knownHoldings.some((known) => known.id === row.id));
    snapshots.push({
      provider: `portfolio-holdings-${market.toLowerCase()}`,
      source: 'portfolio_holdings + public quote provider',
      asOf: marketRows.length ? marketRows.map((row) => row.asOf).sort()[0] : now.toISOString(),
      quality: missingMarketQuotes ? 'PARTIAL' : 'DELAYED',
      status: missingMarketQuotes ? 'PARTIAL' : 'READY',
      errorCode: missingMarketQuotes ? 'QUOTE_PARTIAL' : null,
      assets: missingMarketQuotes && !marketRows.length ? [] : [{ bucket, amount: marketRows.reduce((sum, row) => sum + row.nativeValue, 0), currency }],
    });
  }

  snapshots.push(
    { provider: 'cash-account', source: 'not-connected-readonly-source', asOf: now.toISOString(), quality: 'UNAVAILABLE', status: 'UNAVAILABLE', assets: [], errorCode: 'READONLY_CASH_SOURCE_UNAVAILABLE' },
    { provider: 'crypto-spot-account', source: 'private-exchange-boundary', asOf: now.toISOString(), quality: 'UNAVAILABLE', status: 'UNAVAILABLE', assets: [], errorCode: 'PRIVATE_PROVIDER_NOT_CALLED' },
    { provider: 'crypto-futures-equity', source: 'private-exchange-boundary', asOf: now.toISOString(), quality: 'UNAVAILABLE', status: 'UNAVAILABLE', assets: [], errorCode: 'PRIVATE_PROVIDER_NOT_CALLED' },
  );

  const aggregate = aggregatePortfolioProviderSnapshots(snapshots, fxQuotes, { now });
  const normalizedHoldings = knownHoldings.map((holding) => {
    const normalized = normalizeMoneyToKRW({
      amount: holding.nativeValue,
      currency: currencyFor(holding.currency),
      source: `quote:${holding.ticker}`,
      asOf: holding.asOf,
      quality: 'DELAYED',
    }, fxQuotes, { now });
    const normalizedCost = normalizeMoneyToKRW({
      amount: holding.nativeCost,
      currency: currencyFor(holding.currency),
      source: `cost:${holding.ticker}`,
      asOf: holding.asOf,
      quality: 'DELAYED',
    }, fxQuotes, { now });
    return { ...holding, normalizedKRW: normalized.normalizedKRWAmount, normalizedCostKRW: normalizedCost.normalizedKRWAmount, fxSource: normalized.fxSource };
  });

  const holdingAllocation = calculateAllocation(normalizedHoldings.map((holding) => ({ key: holding.ticker, normalizedKRWAmount: holding.normalizedKRW })));
  const bucketValues = new Map<string, number | null>();
  for (const bucket of ['KR_STOCKS', 'US_STOCKS'] as const) {
    const values = normalizedHoldings.filter((holding) => bucketFor(holding.market) === bucket).map((holding) => holding.normalizedKRW);
    const incomplete = invalidRowCount > 0 || holdings.some((row) => bucketFor(row.market as KnownHolding['market']) === bucket && !knownHoldings.some((known) => known.id === row.id));
    const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    bucketValues.set(bucket, incomplete || values.some((value) => value == null) || !Number.isFinite(total) ? null : total);
  }
  bucketValues.set('CASH', null);
  bucketValues.set('CRYPTO', null);
  const bucketSubtotal = [...bucketValues.values()].reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const knownBucketTotal = [...bucketValues.values()].some((value) => value !== null) && Number.isFinite(bucketSubtotal) ? bucketSubtotal : null;
  const bucketPercent = (key: string) => {
    const value = bucketValues.get(key);
    return value == null || knownBucketTotal == null || knownBucketTotal <= 0 ? null : (value / knownBucketTotal) * 100;
  };
  const allocationPolicy = comparePortfolioAllocation(profileOrDefault(input.profile), {
    CASH: null,
    KR_STOCKS: bucketPercent('KR_STOCKS'),
    US_STOCKS: bucketPercent('US_STOCKS'),
    CRYPTO: null,
  });

  const topHoldings = normalizedHoldings
    .filter((holding) => holding.normalizedKRW != null)
    .sort((a, b) => (b.normalizedKRW ?? 0) - (a.normalizedKRW ?? 0))
    .slice(0, 10);

  let correlation: { status: string; sampleSize: number; correlation: number | null; pair: string[] } = {
    status: 'INSUFFICIENT_SAMPLE', sampleSize: 0, correlation: null, pair: [],
  };
  if (topHoldings.length >= 2) {
    const pair = topHoldings.slice(0, 2);
    const batch = await runBoundedWorkPool(pair, (holding) => (input.loadCandles ?? MarketDataService.getCandles.bind(MarketDataService))(holding.ticker, '1D'),
      { concurrency: 2, deadlineMs: 4_000, itemTimeoutMs: 3_500 });
    const histories = new Map(batch.outcomes.map((outcome) => [outcome.index, outcome]));
    const leftResult = histories.get(0);
    const rightResult = histories.get(1);
    if (leftResult?.status === 'fulfilled' && rightResult?.status === 'fulfilled'
      && Array.isArray(leftResult.value) && Array.isArray(rightResult.value)) {
      const left = closeReturns(leftResult.value, now.getTime());
      const right = closeReturns(rightResult.value, now.getTime());
      const value = calculateAlignedCorrelation(left, right, 30, now.getTime());
      correlation = { ...value, pair: pair.map((holding) => holding.ticker) };
    } else {
      correlation = { status: 'PARTIAL_MARKET_DATA', sampleSize: 0, correlation: null, pair: pair.map((holding) => holding.ticker) };
      missingSources.push('CORRELATION:HISTORY_UNAVAILABLE');
    }
  }

  const knownCost = normalizedHoldings.reduce((sum, holding) => sum + (holding.normalizedCostKRW ?? 0), 0);
  const costComplete = Number.isFinite(knownCost) && invalidRowCount === 0 && normalizedHoldings.every((holding) => holding.normalizedCostKRW != null) && holdings.length === knownHoldings.length;
  const knownValue = normalizedHoldings.reduce((sum, holding) => sum + (holding.normalizedKRW ?? 0), 0);
  const valueComplete = Number.isFinite(knownValue) && invalidRowCount === 0 && normalizedHoldings.every((holding) => holding.normalizedKRW != null) && holdings.length === knownHoldings.length;
  const pnl = costComplete && valueComplete ? knownValue - knownCost : null;
  const rawReturnPercent = pnl != null && knownCost > 0 ? (pnl / knownCost) * 100 : null;
  const returnPercent = rawReturnPercent != null && Number.isFinite(rawReturnPercent) ? rawReturnPercent : null;
  if (![knownCost, knownValue, bucketSubtotal].every(Number.isFinite)) missingSources.push('PORTFOLIO_AGGREGATE_OVERFLOW');
  if (rawReturnPercent != null && returnPercent == null) missingSources.push('PORTFOLIO_RETURN_OVERFLOW');
  const noValuationEvidence = !Number.isFinite(knownValue) || (rawRows.length > 0 && !normalizedHoldings.some((holding) => holding.normalizedKRW != null));
  const nativeBalance = (currency: 'KRW' | 'USD') => {
    const rows = knownHoldings.filter((row) => row.currency === currency);
    const missing = invalidRowCount > 0 || holdings.some((row) => row.currency === currency && !knownHoldings.some((known) => known.id === row.id));
    const amount = rows.reduce((sum, row) => sum + row.nativeValue, 0);
    return { amount: missing || !Number.isFinite(amount) ? null : amount, status: missing || !Number.isFinite(amount) ? 'UNAVAILABLE' : 'READY', source: 'known-stock-valuation-only' };
  };

  return {
    status: aggregate.status,
    asOf: now.toISOString(),
    totalAssets: {
      status: aggregate.status,
      normalizedKRW: aggregate.assets.totalNormalizedKRWAmount,
      knownNormalizedKRW: noValuationEvidence ? null : aggregate.assets.knownNormalizedKRWAmount,
    },
    investmentPrincipal: { status: costComplete ? 'READY' : 'PARTIAL', normalizedKRW: costComplete ? knownCost : null, knownNormalizedKRW: noValuationEvidence || !Number.isFinite(knownCost) ? null : knownCost },
    valuationPnl: {
      status: costComplete && valueComplete && (rawReturnPercent == null || returnPercent != null) ? 'READY' : 'PARTIAL',
      normalizedKRW: pnl,
      returnPercent,
    },
    nativeBalances: {
      KRW: nativeBalance('KRW'),
      USD: nativeBalance('USD'),
      USDT: { amount: null, status: 'UNAVAILABLE', source: 'private-provider-not-called' },
    },
    normalizedKRW: { ...aggregate.assets, knownNormalizedKRWAmount: noValuationEvidence ? null : aggregate.assets.knownNormalizedKRWAmount },
    fx: {
      quotes: fxQuotes.map((quote: FxQuote) => ({ rate: quote.krwRate, pair: `${quote.currency}/KRW`, source: quote.source, asOf: quote.asOf, quality: quote.quality })),
      status: fxMissing.length ? 'PARTIAL' : 'READY',
    },
    cash: { status: 'UNAVAILABLE', totalKRW: null },
    minimumCashBuffer: { status: 'UNAVAILABLE', normalizedKRW: null },
    investableCash: { status: 'UNAVAILABLE', normalizedKRW: null },
    assets: {
      krStocks: bucketValues.get('KR_STOCKS') ?? null,
      usStocks: bucketValues.get('US_STOCKS') ?? null,
      cryptoSpot: null,
      cryptoFuturesEquity: null,
      cash: null,
    },
    allocation: {
      status: 'PARTIAL',
      knownTotalKRW: noValuationEvidence ? null : knownBucketTotal,
      buckets: {
        KR_STOCKS: bucketPercent('KR_STOCKS'),
        US_STOCKS: bucketPercent('US_STOCKS'),
        CRYPTO_SPOT: null,
        CRYPTO_FUTURES_EQUITY: null,
        CASH: null,
      },
    },
    holdings: normalizedHoldings,
    topHoldings,
    top5Concentration: { status: holdingAllocation.status, percent: holdingAllocation.top5ConcentrationPercent },
    correlation,
    riskClassification: { status: 'PARTIAL', level: null, reason: 'CASH_AND_CRYPTO_EXPOSURE_UNAVAILABLE' },
    allocationPolicy,
    dataQuality: {
      status: aggregate.status,
      providerCount: aggregate.provenance.providerCount,
      includedProviderCount: aggregate.provenance.includedProviderCount,
      invalidHoldingRows: invalidRowCount,
      requestedHoldingCount: invalidRowCount > 0 ? null : validRows.length,
      knownHoldingCount: knownHoldings.reduce((sum, row) => sum + row.sourceHoldingIds.length, 0),
      aggregatedAssetCount: knownHoldings.length,
      quoteWork: { requestedAssets: holdings.length, startedAssets: quoteBatch.startedCount, maxConcurrency: quoteBatch.maxConcurrency,
        deadlineReached: quoteBatch.deadlineReached, timedOutAssets: quoteBatch.timedOutCount },
    },
    missingSources: [...new Set([...aggregate.missing, ...missingSources])],
    safety: {
      liveTrading: false,
      orderAuthority: 'none',
      realOrderCount: 0,
      realCancelCount: 0,
      realAmendCount: 0,
      privateTradingApiCount: 0,
    },
  };
}
