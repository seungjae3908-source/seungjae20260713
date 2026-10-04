import { useLocation, useSearch } from 'wouter';

import {
  InstrumentOrderbookDock,
  type OrderbookAssetClass,
  type OrderbookMarket,
} from '@/components/instrument-orderbook-dock';
import { tradeChartPath } from '@/lib/trade-navigation';

type Target = {
  ticker: string;
  market: OrderbookMarket;
  assetClass: OrderbookAssetClass;
  defaultOpen?: boolean;
  tradeSelectable?: boolean;
};

function resolveTarget(location: string, search: string): Target | null {
  const [path, rawQuery = ''] = location.split('?', 2);
  const query = rawQuery || search.replace(/^\?/, '');
  const params = new URLSearchParams(query);

  if (path === '/__phase13-orderbook-e2e') {
    const ticker = String(params.get('ticker') ?? '005930').trim().toUpperCase();
    const market = String(params.get('market') ?? 'KR').trim().toUpperCase() as OrderbookMarket;
    const assetClass = String(params.get('assetClass') ?? 'stock').trim() as OrderbookAssetClass;
    if (!['KR', 'US', 'UPBIT', 'BITGET'].includes(market)) return null;
    if (!['stock', 'crypto_spot', 'crypto_futures'].includes(assetClass)) return null;
    return { ticker, market, assetClass, defaultOpen: true, tradeSelectable: false };
  }

  if (path !== '/stock-info' && path !== '/stock-info/analysis') return null;
  const ticker = String(params.get('ticker') ?? params.get('symbol') ?? '').trim().toUpperCase();
  if (!ticker) return null;

  if (params.get('asset') === 'coin') {
    const futures = params.get('coinMarket') === 'futures';
    if (futures) {
      const normalized = ticker.replace(/-USDT$/, '').replace(/USDT$/, '');
      return { ticker: normalized, market: 'BITGET', assetClass: 'crypto_futures', tradeSelectable: true };
    }
    return { ticker: ticker.replace(/^KRW-/, ''), market: 'UPBIT', assetClass: 'crypto_spot', tradeSelectable: true };
  }

  if (/^\d{6}(?:_(?:NX|AL))?$/.test(ticker)) {
    return { ticker, market: 'KR', assetClass: 'stock', tradeSelectable: true };
  }
  if (/^[A-Z][A-Z0-9.-]{0,23}$/.test(ticker)) {
    return { ticker, market: 'US', assetClass: 'stock', tradeSelectable: true };
  }
  return null;
}

export function OrderbookRouteDock() {
  const [location, navigate] = useLocation();
  const search = useSearch();
  const target = resolveTarget(location, search);
  if (!target) return null;

  const selectLevel = target.tradeSelectable ? ({ side, price }: { side: 'ask' | 'bid'; price: number }) => {
    const futures = target.assetClass === 'crypto_futures';
    const spot = target.assetClass === 'crypto_spot';
    const symbol = futures
      ? `${target.ticker.replace(/USDT$/, '')}USDT`
      : target.ticker;
    const action = futures
      ? side === 'ask' ? 'LONG' : 'SHORT'
      : side === 'ask' ? 'BUY' : 'SELL';
    const focus = futures || action === 'BUY' ? 'entry' : 'exit';
    navigate(tradeChartPath({
      assetType: futures ? 'coin_futures' : spot ? 'coin_spot' : 'stock',
      market: target.market,
      symbol,
      displayName: target.ticker,
      action,
      focus,
      timeframe: futures || spot ? '15m' : '5m',
      limitPrice: price,
      source: 'orderbook',
    }));
  } : undefined;

  return <InstrumentOrderbookDock {...target} onSelectLevel={selectLevel} />;
}
