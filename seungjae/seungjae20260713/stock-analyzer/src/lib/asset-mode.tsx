import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

export type AppAsset = 'stock' | 'coin';
export type StockMarketMode = 'KR' | 'US';
export type CoinMarketMode = 'spot' | 'futures';

interface AssetModeValue {
  asset: AppAsset;
  stockMarket: StockMarketMode;
  coinMarket: CoinMarketMode;
  setAsset: (value: AppAsset) => void;
  setStockMarket: (value: StockMarketMode) => void;
  setCoinMarket: (value: CoinMarketMode) => void;
}

const STORAGE_KEY = 'knowledge-info-asset-mode-v1';
const AssetModeContext = createContext<AssetModeValue | null>(null);

function readStored() {
  if (typeof window === 'undefined') return { asset: 'stock' as AppAsset, stockMarket: 'KR' as StockMarketMode, coinMarket: 'spot' as CoinMarketMode };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    return {
      asset: parsed.asset === 'coin' ? 'coin' as AppAsset : 'stock' as AppAsset,
      stockMarket: parsed.stockMarket === 'US' ? 'US' as StockMarketMode : 'KR' as StockMarketMode,
      coinMarket: parsed.coinMarket === 'futures' ? 'futures' as CoinMarketMode : 'spot' as CoinMarketMode,
    };
  } catch {
    return { asset: 'stock' as AppAsset, stockMarket: 'KR' as StockMarketMode, coinMarket: 'spot' as CoinMarketMode };
  }
}

export function AssetModeProvider({ children }: { children: ReactNode }) {
  const initial = useMemo(readStored, []);
  const [asset, setAssetState] = useState<AppAsset>(initial.asset);
  const [stockMarket, setStockMarketState] = useState<StockMarketMode>(initial.stockMarket);
  const [coinMarket, setCoinMarketState] = useState<CoinMarketMode>(initial.coinMarket);

  const persist = (next: Partial<{ asset: AppAsset; stockMarket: StockMarketMode; coinMarket: CoinMarketMode }>) => {
    const value = {
      asset: next.asset ?? asset,
      stockMarket: next.stockMarket ?? stockMarket,
      coinMarket: next.coinMarket ?? coinMarket,
    };
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  };

  const value = useMemo<AssetModeValue>(() => ({
    asset,
    stockMarket,
    coinMarket,
    setAsset: (next) => { persist({ asset: next }); setAssetState(next); },
    setStockMarket: (next) => { persist({ stockMarket: next }); setStockMarketState(next); },
    setCoinMarket: (next) => { persist({ coinMarket: next }); setCoinMarketState(next); },
  // persist intentionally closes over the current three primitive values.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [asset, stockMarket, coinMarket]);

  return <AssetModeContext.Provider value={value}>{children}</AssetModeContext.Provider>;
}

export function useAssetMode() {
  const context = useContext(AssetModeContext);
  if (!context) throw new Error('useAssetMode must be used inside AssetModeProvider');
  return context;
}
