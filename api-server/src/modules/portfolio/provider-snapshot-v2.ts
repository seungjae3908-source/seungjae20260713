import {
  buildPortfolioAssetSummary,
  type FxQuote,
  type PortfolioAssetBucket,
  type PortfolioAssetInput,
  type PortfolioAssetSummary,
  type PortfolioCurrency,
  type PortfolioDataQuality,
} from './intelligence-v2.ts';

export type PortfolioProviderSnapshotAsset = {
  bucket: PortfolioAssetBucket;
  amount: number;
  currency: PortfolioCurrency;
  source?: string;
  asOf?: string;
  quality?: PortfolioDataQuality;
};

export type PortfolioProviderSnapshot = {
  provider: string;
  source: string;
  asOf: string;
  quality: PortfolioDataQuality;
  status: 'READY' | 'PARTIAL' | 'UNAVAILABLE';
  assets: readonly PortfolioProviderSnapshotAsset[];
  errorCode?: string | null;
};

export type PortfolioProviderSummary = {
  provider: string;
  source: string;
  asOf: string;
  quality: PortfolioDataQuality;
  status: 'READY' | 'PARTIAL' | 'UNAVAILABLE';
  suppliedAssets: number;
  includedAssets: number;
  errorCode: string | null;
};

export type PortfolioProviderAggregationV2 = {
  status: 'READY' | 'PARTIAL' | 'UNAVAILABLE';
  generatedAt: string;
  providers: PortfolioProviderSummary[];
  assets: PortfolioAssetSummary;
  missing: string[];
  provenance: {
    providerCount: number;
    includedProviderCount: number;
    fxQuotes: Array<{
      currency: FxQuote['currency'];
      krwRate: number;
      source: string;
      asOf: string;
      quality: PortfolioDataQuality;
    }>;
  };
};

function safeProviderId(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 80 ? trimmed : null;
}

function safeSource(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 160 ? trimmed : null;
}

function degradedQuality(quality: PortfolioDataQuality): boolean {
  return quality === 'STALE' || quality === 'PARTIAL' || quality === 'UNAVAILABLE';
}

function toAssetInput(
  snapshot: PortfolioProviderSnapshot,
  asset: PortfolioProviderSnapshotAsset,
): PortfolioAssetInput {
  return {
    bucket: asset.bucket,
    amount: asset.amount,
    currency: asset.currency,
    source: asset.source?.trim() || snapshot.source,
    asOf: asset.asOf ?? snapshot.asOf,
    quality: asset.quality ?? snapshot.quality,
  };
}

export function aggregatePortfolioProviderSnapshots(
  snapshots: readonly PortfolioProviderSnapshot[],
  fxQuotes: readonly FxQuote[],
  options: { now?: Date; maxFxAgeMs?: number } = {},
): PortfolioProviderAggregationV2 {
  const now = options.now ?? new Date();
  const providerMissing: string[] = [];
  const assets: PortfolioAssetInput[] = [];
  let degradedProvider = false;
  let includedProviderCount = 0;

  const providers = snapshots.map((snapshot): PortfolioProviderSummary => {
    const provider = safeProviderId(snapshot.provider);
    const source = safeSource(snapshot.source);
    const timestampValid = Number.isFinite(Date.parse(snapshot.asOf));
    const identityValid = provider != null && source != null && timestampValid;
    const unavailable = snapshot.status === 'UNAVAILABLE' || snapshot.quality === 'UNAVAILABLE' || !identityValid;

    if (unavailable) {
      degradedProvider = true;
      providerMissing.push(`PROVIDER:${provider ?? 'INVALID'}:${snapshot.errorCode ?? (identityValid ? 'UNAVAILABLE' : 'INVALID_PROVENANCE')}`);
      return {
        provider: provider ?? 'INVALID',
        source: source ?? 'INVALID',
        asOf: snapshot.asOf,
        quality: snapshot.quality,
        status: 'UNAVAILABLE',
        suppliedAssets: snapshot.assets.length,
        includedAssets: 0,
        errorCode: snapshot.errorCode ?? (identityValid ? 'UNAVAILABLE' : 'INVALID_PROVENANCE'),
      };
    }

    const normalizedAssets = snapshot.assets.map((asset) => toAssetInput(snapshot, asset));
    assets.push(...normalizedAssets);
    includedProviderCount += 1;

    if (snapshot.status !== 'READY' || degradedQuality(snapshot.quality)) {
      degradedProvider = true;
      providerMissing.push(`PROVIDER:${provider}:${snapshot.errorCode ?? snapshot.status}`);
    }

    return {
      provider,
      source,
      asOf: snapshot.asOf,
      quality: snapshot.quality,
      status: snapshot.status,
      suppliedAssets: snapshot.assets.length,
      includedAssets: normalizedAssets.length,
      errorCode: snapshot.errorCode ?? null,
    };
  });

  const assetSummary = buildPortfolioAssetSummary(assets, fxQuotes, options);
  const missing = [...new Set([...providerMissing, ...assetSummary.missing])];
  const noUsableAssets = assets.length === 0;
  const status: PortfolioProviderAggregationV2['status'] = noUsableAssets
    ? 'UNAVAILABLE'
    : degradedProvider || assetSummary.status === 'PARTIAL'
      ? 'PARTIAL'
      : 'READY';

  return {
    status,
    generatedAt: now.toISOString(),
    providers,
    assets: noUsableAssets
      ? {
          ...assetSummary,
          status: 'PARTIAL',
          totalNormalizedKRWAmount: null,
        }
      : assetSummary,
    missing: noUsableAssets && missing.length === 0 ? ['NO_PROVIDER_ASSETS'] : missing,
    provenance: {
      providerCount: snapshots.length,
      includedProviderCount,
      fxQuotes: fxQuotes.map((quote) => ({
        currency: quote.currency,
        krwRate: quote.krwRate,
        source: quote.source,
        asOf: quote.asOf,
        quality: quote.quality,
      })),
    },
  };
}
