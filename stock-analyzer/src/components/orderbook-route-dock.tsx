import { useLocation } from 'wouter';

import {
  InstrumentOrderbookDock,
  type OrderbookAssetClass,
  type OrderbookMarket,
} from '@/components/instrument-orderbook-dock';

type Target = {
  ticker: string;
  market: OrderbookMarket;
  assetClass: OrderbookAssetClass;
  defaultOpen?: boolean;
};

function resolveTarget(location: string): Target | null {
  const [path, rawQuery = ''] = location.split('?', 2);
  const params = new URLSearchParams(rawQuery || window.location.search.slice(1));

  if (path === '/__phase13-orderbook-e2e') {
    const ticker = String(params.get('ticker') ?? '005930').trim().toUpperCase();
    const market = String(params.get('market') ?? 'KR').trim().toUpperCase() as OrderbookMarket;
    const assetClass = String(params.get('assetClass') ?? 'stock').trim() as OrderbookAssetClass;
    if (!['KR', 'US', 'UPBIT', 'BITGET'].includes(market)) return null;
    if (!['stock', 'crypto_spot', 'crypto_futures'].includes(assetClass)) return null;
    return { ticker, market, assetClass, defaultOpen: true };
  }

  if (path !== '/stock-info' && path !== '/stock-info/analysis') return null;
  const ticker = String(params.get('ticker') ?? params.get('symbol') ?? '').trim().toUpperCase();
  if (!ticker) return null;

  if (params.get('asset') === 'coin') {
    const futures = params.get('coinMarket') === 'futures';
    if (futures) {
      const normalized = ticker.replace(/-USDT$/, '').replace(/USDT$/, '');
      return { ticker: normalized, market: 'BITGET', assetClass: 'crypto_futures' };
    }
    return { ticker: ticker.replace(/^KRW-/, ''), market: 'UPBIT', assetClass: 'crypto_spot' };
  }

  if (/^\d{6}(?:_(?:NX|AL))?$/.test(ticker)) {
    return { ticker, market: 'KR', assetClass: 'stock' };
  }
  if (/^[A-Z][A-Z0-9.-]{0,23}$/.test(ticker)) {
    return { ticker, market: 'US', assetClass: 'stock' };
  }
  return null;
}

export function OrderbookRouteDock() {
  const [location] = useLocation();
  const target = resolveTarget(location);
  if (!target) return null;
  return <InstrumentOrderbookDock {...target} />;
}
