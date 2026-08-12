import type { BrokerMarket, BrokerProviderId } from './broker-provider-adapter';

type JsonRecord = Record<string, unknown>;

export type NormalizedBrokerHolding = {
  provider: BrokerProviderId;
  sourceProvider: BrokerProviderId;
  accountId: string;
  market: BrokerMarket;
  assetClass: 'STOCK' | 'CRYPTO_SPOT';
  symbol: string;
  name: string | null;
  currency: string;
  quantity: number;
  averagePrice: number | null;
  currentPrice: number | null;
  marketValue: number | null;
  profitLoss: number | null;
  profitRate: number | null;
  valuationState: 'VALUED' | 'UNPRICED';
};

export type NormalizedBrokerPosition = {
  provider: 'bitget';
  sourceProvider: 'bitget';
  accountId: string;
  market: 'CRYPTO_FUTURES';
  symbol: string;
  side: string;
  quantity: number;
  leverage: number | null;
  averageOpenPrice: number | null;
  markPrice: number | null;
  notionalValue: number | null;
  unrealizedPnl: number | null;
  liquidationPrice: number | null;
  currency: string;
};

export type NormalizedBrokerBalance = {
  provider: BrokerProviderId;
  sourceProvider: BrokerProviderId;
  accountId: string;
  currency: string;
  available: number | null;
  locked: number | null;
  equity: number | null;
};

export type BrokerCurrencyTotal = {
  currency: string;
  totalAssets: number;
  cashAvailable: number;
  holdingsMarketValue: number;
  profitLoss: number;
  derivativesNotional: number;
  holdingAllocationPercent: number | null;
  providers: BrokerProviderId[];
  pricingComplete: boolean;
};

export type BrokerProviderPortfolio = {
  provider: BrokerProviderId;
  configured: boolean;
  connected: boolean;
  connectionState: string;
  errorCode: string | null;
  sourceProvider: BrokerProviderId;
  currencies: BrokerCurrencyTotal[];
};

export type NormalizedBrokerPortfolio = {
  asOf: string;
  baseCurrency: null;
  conversionApplied: false;
  totalsByCurrency: BrokerCurrencyTotal[];
  providers: BrokerProviderPortfolio[];
  holdings: NormalizedBrokerHolding[];
  positions: NormalizedBrokerPosition[];
  balances: NormalizedBrokerBalance[];
  incompleteProviders: BrokerProviderId[];
};

type WorkingTotal = Omit<BrokerCurrencyTotal, 'providers'> & { providers: Set<BrokerProviderId> };

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function rows(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function text(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function number(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'string' ? Number(value.replace(/[,+%₩$]/g, '').trim()) : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function totalKey(provider: BrokerProviderId, currency: string) {
  return `${provider}:${currency}`;
}

function ensureTotal(
  totals: Map<string, WorkingTotal>,
  provider: BrokerProviderId,
  currencyValue: unknown,
) {
  const currency = text(currencyValue, provider === 'bitget' ? 'USDT' : 'UNKNOWN').toUpperCase();
  const key = totalKey(provider, currency);
  const current = totals.get(key);
  if (current) return current;
  const created: WorkingTotal = {
    currency,
    totalAssets: 0,
    cashAvailable: 0,
    holdingsMarketValue: 0,
    profitLoss: 0,
    derivativesNotional: 0,
    holdingAllocationPercent: null,
    providers: new Set([provider]),
    pricingComplete: true,
  };
  totals.set(key, created);
  return created;
}

function finiteAdd(target: WorkingTotal, field: 'totalAssets' | 'cashAvailable' | 'holdingsMarketValue' | 'profitLoss' | 'derivativesNotional', value: unknown) {
  const parsed = number(value);
  if (parsed != null) target[field] += parsed;
}

function holdingFromRow(
  provider: 'toss' | 'kiwoom',
  row: JsonRecord,
  market: 'KR_STOCK' | 'US_STOCK',
  fallbackAccountId: string,
): NormalizedBrokerHolding | null {
  const symbol = text(row.symbol);
  const quantity = number(row.quantity);
  if (!symbol || quantity == null) return null;
  const currency = text(row.currency, market === 'KR_STOCK' ? 'KRW' : 'USD').toUpperCase();
  const marketValue = number(row.evaluationAmount ?? row.marketValue);
  return {
    provider,
    sourceProvider: provider,
    accountId: text(row.accountId, fallbackAccountId),
    market,
    assetClass: 'STOCK',
    symbol,
    name: text(row.name) || null,
    currency,
    quantity,
    averagePrice: number(row.averagePrice),
    currentPrice: number(row.currentPrice),
    marketValue,
    profitLoss: number(row.profitLoss),
    profitRate: number(row.profitRate),
    valuationState: marketValue == null ? 'UNPRICED' : 'VALUED',
  };
}

function finalizeTotal(total: WorkingTotal): BrokerCurrencyTotal {
  return {
    ...total,
    holdingAllocationPercent: total.totalAssets > 0
      ? Number(((total.holdingsMarketValue / total.totalAssets) * 100).toFixed(4))
      : null,
    providers: [...total.providers].sort(),
  };
}

export function normalizeBrokerPortfolioSnapshot(snapshotValue: unknown): NormalizedBrokerPortfolio {
  const snapshot = record(snapshotValue);
  const providersInput = record(snapshot.providers);
  const providerTotals = new Map<string, WorkingTotal>();
  const holdings: NormalizedBrokerHolding[] = [];
  const positions: NormalizedBrokerPosition[] = [];
  const balances: NormalizedBrokerBalance[] = [];
  const providers: BrokerProviderPortfolio[] = [];
  const incomplete = new Set<BrokerProviderId>();
  const providerIds: BrokerProviderId[] = ['toss', 'kiwoom', 'upbit', 'bitget'];

  for (const provider of providerIds) {
    const value = record(providersInput[provider]);
    const configured = value.configured === true;
    const connected = value.connected === true;
    const errorCode = text(value.error) || null;
    if (!connected) incomplete.add(provider);

    if (provider === 'toss' && connected) {
      for (const row of rows(value.holdings)) {
        const market = text(row.market) === 'US_STOCK' ? 'US_STOCK' : 'KR_STOCK';
        const holding = holdingFromRow('toss', row, market, 'toss');
        if (!holding) continue;
        holdings.push(holding);
        const total = ensureTotal(providerTotals, provider, holding.currency);
        finiteAdd(total, 'holdingsMarketValue', holding.marketValue);
        finiteAdd(total, 'profitLoss', holding.profitLoss);
        if (holding.marketValue == null) total.pricingComplete = false;
      }
      for (const row of rows(value.balances)) {
        const currency = text(row.currency).toUpperCase();
        if (!currency) continue;
        const balance: NormalizedBrokerBalance = {
          provider, sourceProvider: provider, accountId: text(row.accountId, 'toss'), currency,
          available: number(row.available), locked: number(row.locked), equity: number(row.equity),
        };
        balances.push(balance);
        const total = ensureTotal(providerTotals, provider, currency);
        finiteAdd(total, 'cashAvailable', balance.available);
      }
      for (const total of providerTotals.values()) {
        if (total.providers.has(provider)) total.totalAssets = total.cashAvailable + total.holdingsMarketValue;
      }
    }

    if (provider === 'kiwoom' && connected) {
      const accountId = text(value.accountMasked, 'kiwoom');
      for (const [region, market, fallbackCurrency] of [
        ['kr', 'KR_STOCK', 'KRW'], ['us', 'US_STOCK', 'USD'],
      ] as const) {
        const regionValue = record(value[region]);
        for (const row of rows(regionValue.holdings)) {
          const holding = holdingFromRow('kiwoom', row, market, accountId);
          if (!holding) continue;
          if (holding.currency === 'UNKNOWN') holding.currency = fallbackCurrency;
          holdings.push(holding);
          const total = ensureTotal(providerTotals, provider, holding.currency);
          finiteAdd(total, 'holdingsMarketValue', holding.marketValue);
          finiteAdd(total, 'profitLoss', holding.profitLoss);
          if (holding.marketValue == null) total.pricingComplete = false;
        }
        const currency = fallbackCurrency;
        const total = ensureTotal(providerTotals, provider, currency);
        if (region === 'kr') {
          const equity = number(regionValue.estimatedAssets);
          const evaluation = number(regionValue.totalEvaluationAmount);
          const cash = equity != null && evaluation != null ? Math.max(equity - evaluation, 0) : null;
          if (equity != null) total.totalAssets = equity;
          else total.totalAssets = total.holdingsMarketValue;
          finiteAdd(total, 'cashAvailable', cash);
          const reportedPnl = number(regionValue.totalProfitLoss);
          if (reportedPnl != null) total.profitLoss = reportedPnl;
          balances.push({
            provider, sourceProvider: provider, accountId, currency,
            available: cash, locked: null, equity,
          });
        } else {
          total.totalAssets = total.holdingsMarketValue;
        }
      }
    }

    if (provider === 'upbit' && connected) {
      for (const row of rows(value.assets)) {
        const symbol = text(row.currency).toUpperCase();
        if (!symbol) continue;
        const balance = number(row.balance) ?? 0;
        const locked = number(row.locked) ?? 0;
        const valuationCurrency = text(row.unitCurrency, 'KRW').toUpperCase();
        if (symbol === valuationCurrency) {
          const total = ensureTotal(providerTotals, provider, valuationCurrency);
          const equity = balance + locked;
          total.totalAssets += equity;
          total.cashAvailable += balance;
          balances.push({
            provider, sourceProvider: provider, accountId: 'upbit', currency: valuationCurrency,
            available: balance, locked, equity,
          });
        } else {
          holdings.push({
            provider, sourceProvider: provider, accountId: 'upbit', market: 'CRYPTO_SPOT', assetClass: 'CRYPTO_SPOT',
            symbol, name: symbol, currency: valuationCurrency, quantity: balance + locked,
            averagePrice: number(row.averageBuyPrice), currentPrice: null, marketValue: null,
            profitLoss: null, profitRate: null, valuationState: 'UNPRICED',
          });
          ensureTotal(providerTotals, provider, valuationCurrency).pricingComplete = false;
        }
      }
    }

    if (provider === 'bitget' && connected) {
      for (const row of rows(value.accounts)) {
        const currency = text(row.marginCoin, 'USDT').toUpperCase();
        const balance: NormalizedBrokerBalance = {
          provider, sourceProvider: provider, accountId: 'USDT-FUTURES', currency,
          available: number(row.available), locked: number(row.locked), equity: number(row.accountEquity),
        };
        balances.push(balance);
        const total = ensureTotal(providerTotals, provider, currency);
        finiteAdd(total, 'cashAvailable', balance.available);
        finiteAdd(total, 'totalAssets', balance.equity);
        finiteAdd(total, 'profitLoss', row.unrealizedPL);
      }
      for (const row of rows(value.positions)) {
        const quantity = number(row.total);
        if (quantity == null || quantity === 0) continue;
        const currency = text(row.marginCoin, 'USDT').toUpperCase();
        const markPrice = number(row.markPrice);
        const notionalValue = markPrice == null ? null : Math.abs(quantity * markPrice);
        positions.push({
          provider, sourceProvider: provider, accountId: 'USDT-FUTURES', market: 'CRYPTO_FUTURES',
          symbol: text(row.symbol), side: text(row.side), quantity,
          leverage: number(row.leverage), averageOpenPrice: number(row.averageOpenPrice), markPrice,
          notionalValue, unrealizedPnl: number(row.unrealizedPL), liquidationPrice: number(row.liquidationPrice), currency,
        });
        const total = ensureTotal(providerTotals, provider, currency);
        finiteAdd(total, 'derivativesNotional', notionalValue);
      }
    }

    const currencies = [...providerTotals.entries()]
      .filter(([key]) => key.startsWith(`${provider}:`))
      .map(([, total]) => finalizeTotal(total))
      .sort((left, right) => left.currency.localeCompare(right.currency));
    providers.push({
      provider, configured, connected,
      connectionState: text(value.connectionState, connected ? 'CONNECTED_READ_ONLY' : configured ? 'CONFIGURED' : 'UNCONFIGURED'),
      errorCode,
      sourceProvider: provider,
      currencies,
    });
  }

  const aggregated = new Map<string, WorkingTotal>();
  for (const total of providerTotals.values()) {
    const aggregate = aggregated.get(total.currency) ?? {
      currency: total.currency, totalAssets: 0, cashAvailable: 0, holdingsMarketValue: 0,
      profitLoss: 0, derivativesNotional: 0, holdingAllocationPercent: null,
      providers: new Set<BrokerProviderId>(), pricingComplete: true,
    };
    aggregate.totalAssets += total.totalAssets;
    aggregate.cashAvailable += total.cashAvailable;
    aggregate.holdingsMarketValue += total.holdingsMarketValue;
    aggregate.profitLoss += total.profitLoss;
    aggregate.derivativesNotional += total.derivativesNotional;
    aggregate.pricingComplete = aggregate.pricingComplete && total.pricingComplete;
    for (const source of total.providers) aggregate.providers.add(source);
    aggregated.set(total.currency, aggregate);
  }

  return {
    asOf: text(snapshot.checkedAt, new Date(0).toISOString()),
    baseCurrency: null,
    conversionApplied: false,
    totalsByCurrency: [...aggregated.values()].map(finalizeTotal).sort((left, right) => left.currency.localeCompare(right.currency)),
    providers,
    holdings,
    positions,
    balances,
    incompleteProviders: [...incomplete],
  };
}
