import type { CanonicalAccountSnapshot, CanonicalPosition } from './account-readonly.contract';
import type { PortfolioAccountReadResult } from './account-readonly.portfolio-source';
import type {
  PortfolioCurrency,
  PortfolioDataQuality,
  PortfolioProviderSnapshot,
  PortfolioProviderSnapshotAsset,
} from '../../modules/portfolio/index';

export type LinkedAccountPosition = {
  provider: CanonicalAccountSnapshot['provider'];
  market: string;
  symbol: string;
  quantity: number;
  averageEntryPrice: number | null;
  currentPrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPercent: number | null;
  currency: PortfolioCurrency | null;
  stale: boolean;
  asOf: string;
};

export type AccountPortfolioEvidence = {
  providerSnapshots: PortfolioProviderSnapshot[];
  linkedPositions: LinkedAccountPosition[];
  missing: string[];
  coverage: {
    cash: boolean;
    cryptoSpot: boolean;
    cryptoFuturesEquity: boolean;
  };
};

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function positionCurrency(position: CanonicalPosition): PortfolioCurrency | null {
  if (position.market === 'KR') return 'KRW';
  if (position.market === 'US') return 'USD';
  if (position.market === 'BITGET') return 'USDT';
  return null;
}

function snapshotQuality(snapshot: CanonicalAccountSnapshot): PortfolioDataQuality {
  if (!snapshot.connected) return 'UNAVAILABLE';
  if (snapshot.stale || snapshot.status === 'STALE') return 'STALE';
  return 'LIVE';
}

function asset(
  bucket: PortfolioProviderSnapshotAsset['bucket'],
  amount: number,
  currency: PortfolioCurrency,
  source: string,
  asOf: string,
  quality: PortfolioDataQuality,
): PortfolioProviderSnapshotAsset {
  return { bucket, amount, currency, source, asOf, quality };
}

export function accountSourcesToPortfolioEvidence(
  results: readonly PortfolioAccountReadResult[],
): AccountPortfolioEvidence {
  const providerSnapshots: PortfolioProviderSnapshot[] = [];
  const linkedPositions: LinkedAccountPosition[] = [];
  const missing: string[] = [];
  let cash = false;
  let cryptoSpot = false;
  let cryptoFuturesEquity = false;

  for (const result of results) {
    if (result.configured === false) continue;
    if (result.configured == null || !result.snapshot) {
      missing.push(`ACCOUNT:${result.provider}:${result.errorCode ?? 'METADATA_UNAVAILABLE'}`);
      continue;
    }

    const snapshot = result.snapshot;
    const quality = snapshotQuality(snapshot);
    if (!snapshot.connected) {
      providerSnapshots.push({
        provider: `account-readonly-${snapshot.provider}`,
        source: 'canonical account read-only snapshot',
        asOf: snapshot.checkedAt,
        quality: 'UNAVAILABLE',
        status: 'UNAVAILABLE',
        assets: [],
        errorCode: snapshot.errorCode ?? snapshot.status,
      });
      continue;
    }

    for (const position of snapshot.positions ?? []) {
      if (!finiteNonNegative(position.quantity) || position.quantity === 0 || !position.symbol) continue;
      linkedPositions.push({
        provider: snapshot.provider,
        market: position.market,
        symbol: position.symbol,
        quantity: position.quantity,
        averageEntryPrice: finiteNonNegative(position.averageEntryPrice) ? position.averageEntryPrice : null,
        currentPrice: finiteNonNegative(position.currentPrice) ? position.currentPrice : null,
        marketValue: finiteNonNegative(position.marketValue) ? position.marketValue : null,
        unrealizedPnl: typeof position.unrealizedPnl === 'number' && Number.isFinite(position.unrealizedPnl) ? position.unrealizedPnl : null,
        unrealizedPnlPercent: typeof position.unrealizedPnlPercent === 'number' && Number.isFinite(position.unrealizedPnlPercent) ? position.unrealizedPnlPercent : null,
        currency: positionCurrency(position),
        stale: snapshot.stale,
        asOf: snapshot.lastGoodAt ?? snapshot.checkedAt,
      });
    }

    const assets: PortfolioProviderSnapshotAsset[] = [];
    let providerPartial = snapshot.stale;

    if (snapshot.provider === 'kiwoom' || snapshot.provider === 'toss') {
      const balances = snapshot.balances;
      if (Array.isArray(balances)) {
        for (const balance of balances) {
          const currency = balance.currency === 'KRW' || balance.currency === 'USD' ? balance.currency : null;
          if (!currency || !finiteNonNegative(balance.total)) continue;
          cash = true;
          assets.push(asset('CASH', balance.total, currency, `${snapshot.provider}:balance:${currency}`, snapshot.lastGoodAt ?? snapshot.checkedAt, quality));
        }
      } else if ((snapshot.positions ?? []).some((position) => position.market === 'KR' || position.market === 'US')) {
        providerPartial = true;
        missing.push(`ACCOUNT:${snapshot.provider}:CASH_UNAVAILABLE`);
      }
      if ((snapshot.positions ?? []).some((position) => finiteNonNegative(position.quantity) && position.quantity > 0 && (position.market === 'KR' || position.market === 'US'))) {
        providerPartial = true;
        missing.push(`ACCOUNT:${snapshot.provider}:STOCK_POSITIONS_EXCLUDED_FROM_TOTAL_TO_AVOID_DOUBLE_COUNT`);
      }
    }

    if (snapshot.provider === 'upbit') {
      cryptoSpot = Array.isArray(snapshot.balances);
      for (const balance of snapshot.balances ?? []) {
        if (balance.currency === 'KRW' && finiteNonNegative(balance.total)) {
          cash = true;
          assets.push(asset('CASH', balance.total, 'KRW', 'upbit:krw-balance', snapshot.lastGoodAt ?? snapshot.checkedAt, quality));
          continue;
        }
        if (!finiteNonNegative(balance.total) || balance.total === 0) continue;
        if (finiteNonNegative(balance.estimatedKrwValue)) {
          assets.push(asset('CRYPTO_SPOT', balance.estimatedKrwValue, 'KRW', `upbit:${balance.currency}:estimated-krw`, snapshot.lastGoodAt ?? snapshot.checkedAt, quality));
        } else {
          providerPartial = true;
          missing.push(`ACCOUNT:upbit:${balance.currency}:VALUATION_UNAVAILABLE`);
        }
      }
    }

    if (snapshot.provider === 'bitget') {
      cryptoFuturesEquity = Array.isArray(snapshot.balances);
      for (const balance of snapshot.balances ?? []) {
        if (balance.currency !== 'USDT' || !finiteNonNegative(balance.total)) continue;
        assets.push(asset('CRYPTO_FUTURES_EQUITY', balance.total, 'USDT', 'bitget:account-equity', snapshot.lastGoodAt ?? snapshot.checkedAt, quality));
      }
    }

    providerSnapshots.push({
      provider: `account-readonly-${snapshot.provider}`,
      source: 'canonical account read-only snapshot',
      asOf: snapshot.lastGoodAt ?? snapshot.checkedAt,
      quality: providerPartial ? 'PARTIAL' : quality,
      status: providerPartial ? 'PARTIAL' : 'READY',
      assets,
      errorCode: providerPartial ? 'PORTFOLIO_ACCOUNT_EVIDENCE_PARTIAL' : snapshot.errorCode,
    });
  }

  return {
    providerSnapshots,
    linkedPositions,
    missing: [...new Set(missing)],
    coverage: { cash, cryptoSpot, cryptoFuturesEquity },
  };
}
