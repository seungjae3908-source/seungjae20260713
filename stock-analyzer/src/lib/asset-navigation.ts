export type CanonicalAssetClass =
  | 'KR_STOCK'
  | 'KR_ETF'
  | 'KR_ETN'
  | 'US_STOCK'
  | 'US_ETF'
  | 'CRYPTO_SPOT'
  | 'CRYPTO_FUTURES'
  | 'INDEX';

export type CanonicalAssetMarket = 'KR' | 'US' | 'UPBIT' | 'BITGET' | 'INDEX';

export interface CanonicalAssetIdentity {
  assetClass: CanonicalAssetClass;
  market: CanonicalAssetMarket;
  symbol: string;
  canonicalSymbol: string;
  backPath?: string;
}

export class AssetRouteNotResolved extends Error {
  constructor(readonly asset: CanonicalAssetIdentity, message = 'AssetRouteNotResolved') {
    super(message);
    this.name = 'AssetRouteNotResolved';
  }
}

function clean(value: string): string {
  return value.trim().toUpperCase();
}

function stockTicker(asset: CanonicalAssetIdentity): string | null {
  const ticker = clean(asset.canonicalSymbol || asset.symbol);
  if (asset.market === 'KR' && /^\d{6}$/.test(ticker)) return ticker;
  if (asset.market === 'US' && /^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker)) return ticker;
  return null;
}

function spotBaseSymbol(asset: CanonicalAssetIdentity): string | null {
  const canonical = clean(asset.canonicalSymbol);
  if (/^[A-Z0-9]{2,15}$/.test(canonical) && !canonical.includes('-')) return canonical;
  const raw = clean(asset.symbol);
  const match = raw.match(/^(?:KRW|BTC|USDT)-([A-Z0-9]{2,15})$/);
  return match?.[1] ?? (/^[A-Z0-9]{2,15}$/.test(raw) ? raw : null);
}

function futuresSymbol(asset: CanonicalAssetIdentity): string | null {
  const symbol = clean(asset.canonicalSymbol || asset.symbol).replace(/[-_/]/g, '');
  return /^[A-Z0-9]{2,20}(?:USDT|USDC|USD)$/.test(symbol) ? symbol : null;
}

export function resolveAssetDetailPath(asset: CanonicalAssetIdentity): string {
  const back = asset.backPath?.trim() || '/search';
  const params = new URLSearchParams({ back });

  if (asset.assetClass === 'KR_STOCK' || asset.assetClass === 'KR_ETF' || asset.assetClass === 'KR_ETN') {
    if (asset.market !== 'KR') throw new AssetRouteNotResolved(asset, 'KR asset market mismatch');
    const ticker = stockTicker(asset);
    if (!ticker) throw new AssetRouteNotResolved(asset, 'KR ticker is invalid');
    params.set('asset', 'stock');
    params.set('market', 'KR');
    params.set('ticker', ticker);
    return `/stock-info?${params.toString()}`;
  }

  if (asset.assetClass === 'US_STOCK' || asset.assetClass === 'US_ETF') {
    if (asset.market !== 'US') throw new AssetRouteNotResolved(asset, 'US asset market mismatch');
    const ticker = stockTicker(asset);
    if (!ticker) throw new AssetRouteNotResolved(asset, 'US ticker is invalid');
    params.set('asset', 'stock');
    params.set('market', 'US');
    params.set('ticker', ticker);
    return `/stock-info?${params.toString()}`;
  }

  if (asset.assetClass === 'CRYPTO_SPOT') {
    if (asset.market !== 'UPBIT') throw new AssetRouteNotResolved(asset, 'spot market mismatch');
    const symbol = spotBaseSymbol(asset);
    if (!symbol) throw new AssetRouteNotResolved(asset, 'spot symbol is invalid');
    params.set('asset', 'coin');
    params.set('coinMarket', 'spot');
    params.set('symbol', symbol);
    return `/stock-info?${params.toString()}`;
  }

  if (asset.assetClass === 'CRYPTO_FUTURES') {
    if (asset.market !== 'BITGET') throw new AssetRouteNotResolved(asset, 'futures market mismatch');
    const symbol = futuresSymbol(asset);
    if (!symbol) throw new AssetRouteNotResolved(asset, 'futures symbol is invalid');
    params.set('asset', 'coin');
    params.set('coinMarket', 'futures');
    params.set('symbol', symbol);
    return `/stock-info?${params.toString()}`;
  }

  throw new AssetRouteNotResolved(asset, 'No verified detail route exists for this asset class');
}
