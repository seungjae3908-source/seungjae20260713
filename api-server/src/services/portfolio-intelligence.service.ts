import { getUserSupabase } from '../lib/supabase.ts';
import { accountSourcesToPortfolioEvidence } from '../features/account-readonly/account-readonly.portfolio-adapter.ts';
import type { PortfolioAccountReadResult } from '../features/account-readonly/account-readonly.portfolio-source.ts';
import { MarketDataService } from './market-data.service.ts';
import { loadFreePublicFxQuotes } from './public-fx.service.ts';
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
};

function finiteNonNegative(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function cleanHolding(value: unknown): HoldingRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const ticker = String(row.ticker ?? '').trim().toUpperCase();
  const name = String(row.name ?? ticker).trim();
  const market = String(row.market ?? '').trim().toUpperCase();
  const currency = String(row.currency ?? (market === 'US' ? 'USD' : 'KRW')).trim().toUpperCase();
  const quantity = finiteNonNegative(row.quantity);
  const averagePrice = finiteNonNegative(row.average_price);
  if (!ticker || !name || !['KR', 'US'].includes(market) || !['KRW', 'USD'].includes(currency) || quantity == null || averagePrice == null) return null;
  return {
    id: String(row.id ?? ticker), ticker, name, market, currency, quantity, average_price: averagePrice,
    purchase_date: row.purchase_date == null ? null : String(row.purchase_date),
    created_at: row.created_at == null ? null : String(row.created_at),
  };
}

function bucketFor(market: KnownHolding['market']): PortfolioAssetBucket {
  return market === 'US' ? 'US_STOCKS' : 'KR_STOCKS';
}

function currencyFor(value: string): PortfolioCurrency {
  return value === 'USD' ? 'USD' : 'KRW';
}

function closeReturns(candles: Array<{ time: string | number; close: number }>): ReturnPoint[] {
  const sorted = candles
    .filter((item) => Number.isFinite(item.close) && item.close > 0)
    .map((item) => ({ timestamp: String(item.time), close: item.close }));
  const result: ReturnPoint[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (!(previous.close > 0)) continue;
    result.push({ timestamp: current.timestamp, value: (current.close / previous.close) - 1 });
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
  accountSources?: readonly PortfolioAccountReadResult[];
}) {
  const now = input.now ?? new Date();
  const client = getUserSupabase(input.accessToken);
  const holdingsResult = await client
    .from('portfolio_holdings')
    .select('id,ticker,name,market,currency,quantity,average_price,purchase_date,created_at')
    .order('created_at', { ascending: false });

  if (holdingsResult.error) {
    throw new Error(`PORTFOLIO_HOLDINGS_READ_FAILED:${holdingsResult.error.code ?? 'UNKNOWN'}`);
  }

  const rawRows = Array.isArray(holdingsResult.data) ? holdingsResult.data : [];
  const holdings = rawRows.map(cleanHolding).filter((row): row is HoldingRow => row != null);
  const invalidRowCount = rawRows.length - holdings.length;
  const quoteResults = await Promise.allSettled(holdings.map((holding) => MarketDataService.getQuote(holding.ticker)));
  const knownHoldings: KnownHolding[] = [];
  const missingSources: string[] = [];

  quoteResults.forEach((result, index) => {
    const holding = holdings[index];
    if (result.status === 'rejected') {
      missingSources.push(`QUOTE:${holding.ticker}:UNAVAILABLE`);
      return;
    }
    const price = finiteNonNegative(result.value.price);
    if (price == null || price <= 0) {
      missingSources.push(`QUOTE:${holding.ticker}:INVALID_PRICE`);
      return;
    }
    knownHoldings.push({
      id: holding.id,
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
      asOf: now.toISOString(),
    });
  });

  if (invalidRowCount > 0) missingSources.push(`PORTFOLIO_HOLDINGS:INVALID_ROWS:${invalidRowCount}`);

  const { quotes: fxQuotes, missing: fxMissing } = await loadFreePublicFxQuotes(input.fetchImpl ?? fetch);
  missingSources.push(...fxMissing);

  const snapshots: PortfolioProviderSnapshot[] = [];
  for (const [market, bucket, currency] of [
    ['KR', 'KR_STOCKS', 'KRW'],
    ['US', 'US_STOCKS', 'USD'],
  ] as const) {
    const marketRows = knownHoldings.filter((row) => row.market === market);
    const missingMarketQuotes = holdings.some((row) => row.market === market && !knownHoldings.some((known) => known.id === row.id));
    snapshots.push({
      provider: `portfolio-holdings-${market.toLowerCase()}`,
      source: 'portfolio_holdings + public quote provider',
      asOf: now.toISOString(),
      quality: missingMarketQuotes ? 'PARTIAL' : 'LIVE',
      status: missingMarketQuotes ? 'PARTIAL' : 'READY',
      errorCode: missingMarketQuotes ? 'QUOTE_PARTIAL' : null,
      assets: [{ bucket, amount: marketRows.reduce((sum, row) => sum + row.nativeValue, 0), currency }],
    });
  }

  const accountEvidence = accountSourcesToPortfolioEvidence(input.accountSources ?? []);
  snapshots.push(...accountEvidence.providerSnapshots);
  missingSources.push(...accountEvidence.missing);
  if (!accountEvidence.coverage.cash) {
    snapshots.push({ provider: 'cash-account', source: 'not-connected-readonly-source', asOf: now.toISOString(), quality: 'UNAVAILABLE', status: 'UNAVAILABLE', assets: [], errorCode: 'READONLY_CASH_SOURCE_UNAVAILABLE' });
  }
  if (!accountEvidence.coverage.cryptoSpot) {
    snapshots.push({ provider: 'crypto-spot-account', source: 'private-exchange-boundary', asOf: now.toISOString(), quality: 'UNAVAILABLE', status: 'UNAVAILABLE', assets: [], errorCode: 'PRIVATE_PROVIDER_NOT_CALLED' });
  }
  if (!accountEvidence.coverage.cryptoFuturesEquity) {
    snapshots.push({ provider: 'crypto-futures-equity', source: 'private-exchange-boundary', asOf: now.toISOString(), quality: 'UNAVAILABLE', status: 'UNAVAILABLE', assets: [], errorCode: 'PRIVATE_PROVIDER_NOT_CALLED' });
  }

  const aggregate = aggregatePortfolioProviderSnapshots(snapshots, fxQuotes, { now });
  const normalizedHoldings = knownHoldings.map((holding) => {
    const normalized = normalizeMoneyToKRW({
      amount: holding.nativeValue,
      currency: currencyFor(holding.currency),
      source: `quote:${holding.ticker}`,
      asOf: holding.asOf,
      quality: 'LIVE',
    }, fxQuotes, { now });
    const normalizedCost = normalizeMoneyToKRW({
      amount: holding.nativeCost,
      currency: currencyFor(holding.currency),
      source: `cost:${holding.ticker}`,
      asOf: holding.asOf,
      quality: 'LIVE',
    }, fxQuotes, { now });
    return { ...holding, normalizedKRW: normalized.normalizedKRWAmount, normalizedCostKRW: normalizedCost.normalizedKRWAmount, fxSource: normalized.fxSource };
  });

  const holdingAllocation = calculateAllocation(normalizedHoldings.map((holding) => ({ key: holding.ticker, normalizedKRWAmount: holding.normalizedKRW })));
  const bucketValues = new Map<string, number | null>();
  for (const bucket of ['KR_STOCKS', 'US_STOCKS'] as const) {
    const values = normalizedHoldings.filter((holding) => bucketFor(holding.market) === bucket).map((holding) => holding.normalizedKRW);
    bucketValues.set(bucket, values.some((value) => value == null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0));
  }
  const accountBucketValue = (bucket: 'CASH' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES_EQUITY', proven: boolean) => {
    if (!proven) return null;
    const components = aggregate.assets.components.filter((component) => component.bucket === bucket);
    if (components.some((component) => component.normalizedKRWAmount == null)) return null;
    return components.reduce((sum, component) => sum + (component.normalizedKRWAmount ?? 0), 0);
  };
  bucketValues.set('CASH', accountBucketValue('CASH', accountEvidence.coverage.cash));
  bucketValues.set('CRYPTO_SPOT', accountBucketValue('CRYPTO_SPOT', accountEvidence.coverage.cryptoSpot));
  bucketValues.set('CRYPTO_FUTURES_EQUITY', accountBucketValue('CRYPTO_FUTURES_EQUITY', accountEvidence.coverage.cryptoFuturesEquity));
  const knownBucketTotal = [...bucketValues.values()].reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const bucketPercent = (key: string) => {
    const value = bucketValues.get(key);
    return value == null || knownBucketTotal <= 0 ? null : (value / knownBucketTotal) * 100;
  };
  const cryptoPercent = (() => {
    const spot = bucketValues.get('CRYPTO_SPOT');
    const futures = bucketValues.get('CRYPTO_FUTURES_EQUITY');
    if (spot == null && futures == null) return null;
    const value = (spot ?? 0) + (futures ?? 0);
    return knownBucketTotal > 0 ? (value / knownBucketTotal) * 100 : null;
  })();
  const allocationPolicy = comparePortfolioAllocation(profileOrDefault(input.profile), {
    CASH: bucketPercent('CASH'),
    KR_STOCKS: bucketPercent('KR_STOCKS'),
    US_STOCKS: bucketPercent('US_STOCKS'),
    CRYPTO: cryptoPercent,
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
    const histories = await Promise.allSettled(pair.map((holding) => MarketDataService.getCandles(holding.ticker, '1D')));
    if (histories.every((result) => result.status === 'fulfilled')) {
      const left = histories[0].status === 'fulfilled' ? closeReturns(histories[0].value) : [];
      const right = histories[1].status === 'fulfilled' ? closeReturns(histories[1].value) : [];
      const value = calculateAlignedCorrelation(left, right, 30);
      correlation = { ...value, pair: pair.map((holding) => holding.ticker) };
    } else {
      correlation = { status: 'PARTIAL_MARKET_DATA', sampleSize: 0, correlation: null, pair: pair.map((holding) => holding.ticker) };
      missingSources.push('CORRELATION:HISTORY_UNAVAILABLE');
    }
  }

  const knownCost = normalizedHoldings.reduce((sum, holding) => sum + (holding.normalizedCostKRW ?? 0), 0);
  const costComplete = normalizedHoldings.every((holding) => holding.normalizedCostKRW != null) && holdings.length === knownHoldings.length;
  const knownValue = normalizedHoldings.reduce((sum, holding) => sum + (holding.normalizedKRW ?? 0), 0);
  const valueComplete = normalizedHoldings.every((holding) => holding.normalizedKRW != null) && holdings.length === knownHoldings.length;

  return {
    status: aggregate.status,
    asOf: now.toISOString(),
    totalAssets: {
      status: aggregate.status,
      normalizedKRW: aggregate.assets.totalNormalizedKRWAmount,
      knownNormalizedKRW: aggregate.assets.knownNormalizedKRWAmount,
    },
    investmentPrincipal: { status: costComplete ? 'READY' : 'PARTIAL', normalizedKRW: costComplete ? knownCost : null, knownNormalizedKRW: knownCost },
    valuationPnl: {
      status: costComplete && valueComplete ? 'READY' : 'PARTIAL',
      normalizedKRW: costComplete && valueComplete ? knownValue - knownCost : null,
      returnPercent: costComplete && valueComplete && knownCost > 0 ? ((knownValue - knownCost) / knownCost) * 100 : null,
    },
    nativeBalances: {
      KRW: { amount: knownHoldings.filter((row) => row.currency === 'KRW').reduce((sum, row) => sum + row.nativeValue, 0), status: 'PARTIAL', source: 'known-stock-valuation-only' },
      USD: { amount: knownHoldings.filter((row) => row.currency === 'USD').reduce((sum, row) => sum + row.nativeValue, 0), status: 'PARTIAL', source: 'known-stock-valuation-only' },
      USDT: { amount: null, status: 'UNAVAILABLE', source: 'private-provider-not-called' },
    },
    normalizedKRW: aggregate.assets,
    fx: {
      quotes: fxQuotes.map((quote: FxQuote) => ({ rate: quote.krwRate, pair: `${quote.currency}/KRW`, source: quote.source, asOf: quote.asOf, quality: quote.quality })),
      status: fxMissing.length ? 'PARTIAL' : 'READY',
    },
    cash: {
      status: accountEvidence.coverage.cash ? (bucketValues.get('CASH') == null ? 'PARTIAL' : 'READY') : 'UNAVAILABLE',
      totalKRW: bucketValues.get('CASH') ?? null,
    },
    minimumCashBuffer: { status: 'UNAVAILABLE', normalizedKRW: null },
    investableCash: { status: 'UNAVAILABLE', normalizedKRW: null },
    assets: {
      krStocks: bucketValues.get('KR_STOCKS') ?? null,
      usStocks: bucketValues.get('US_STOCKS') ?? null,
      cryptoSpot: bucketValues.get('CRYPTO_SPOT') ?? null,
      cryptoFuturesEquity: bucketValues.get('CRYPTO_FUTURES_EQUITY') ?? null,
      cash: bucketValues.get('CASH') ?? null,
    },
    allocation: {
      status: 'PARTIAL',
      knownTotalKRW: knownBucketTotal,
      buckets: {
        KR_STOCKS: bucketPercent('KR_STOCKS'),
        US_STOCKS: bucketPercent('US_STOCKS'),
        CRYPTO_SPOT: bucketPercent('CRYPTO_SPOT'),
        CRYPTO_FUTURES_EQUITY: bucketPercent('CRYPTO_FUTURES_EQUITY'),
        CASH: bucketPercent('CASH'),
      },
    },
    holdings: normalizedHoldings,
    linkedAccountPositions: accountEvidence.linkedPositions,
    topHoldings,
    top5Concentration: { status: holdingAllocation.status, percent: holdingAllocation.top5ConcentrationPercent },
    correlation,
    riskClassification: {
      status: 'PARTIAL',
      level: null,
      reason: [
        ...(!accountEvidence.coverage.cash ? ['CASH_EXPOSURE_UNAVAILABLE'] : []),
        ...(!accountEvidence.coverage.cryptoSpot ? ['CRYPTO_SPOT_EXPOSURE_UNAVAILABLE'] : []),
        ...(!accountEvidence.coverage.cryptoFuturesEquity ? ['CRYPTO_FUTURES_EXPOSURE_UNAVAILABLE'] : []),
        'REAL_ACCOUNT_RISK_THRESHOLDS_NOT_BOUND',
      ].join('|'),
    },
    allocationPolicy,
    dataQuality: {
      status: aggregate.status,
      providerCount: aggregate.provenance.providerCount,
      includedProviderCount: aggregate.provenance.includedProviderCount,
      invalidHoldingRows: invalidRowCount,
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
