import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type AppAsset = 'stock' | 'coin';
export type StockMarketMode = 'KR' | 'US';
export type CoinMarketMode = 'spot' | 'futures';

interface AssetModeState {
  asset: AppAsset;
  stockMarket: StockMarketMode;
  coinMarket: CoinMarketMode;
}

interface AssetModeValue extends AssetModeState {
  setAsset: (value: AppAsset) => void;
  setStockMarket: (value: StockMarketMode) => void;
  setCoinMarket: (value: CoinMarketMode) => void;
}

const DEFAULT_MODE: AssetModeState = {
  asset: 'stock',
  stockMarket: 'KR',
  coinMarket: 'spot',
};

const AssetModeContext = createContext<AssetModeValue | null>(null);

export function AssetModeProvider({
  children,
}: {
  children: ReactNode;
}) {
  /*
   * 화면 이동용 탭은 마지막 선택을 저장하지 않는다.
   *
   * 앱을 새로 열면:
   * 주식 → 국내
   *
   * 주식 버튼을 누르면:
   * 주식 → 국내
   *
   * 코인 버튼을 누르면:
   * 코인 → 현물·업비트
   *
   * 실제 자동매매 설정값·알림값·투자금 등은
   * 각 기능 파일에서 기존 방식대로 별도 저장된다.
   */
  const [mode, setMode] = useState<AssetModeState>(DEFAULT_MODE);

  const value = useMemo<AssetModeValue>(
    () => ({
      asset: mode.asset,
      stockMarket: mode.stockMarket,
      coinMarket: mode.coinMarket,

      setAsset: (asset) => {
        setMode((current) => {
          if (asset === 'stock') {
            return {
              ...current,
              asset: 'stock',
              stockMarket: 'KR',
            };
          }

          return {
            ...current,
            asset: 'coin',
            coinMarket: 'spot',
          };
        });
      },

      setStockMarket: (stockMarket) => {
        setMode((current) => ({
          ...current,
          stockMarket,
        }));
      },

      setCoinMarket: (coinMarket) => {
        setMode((current) => ({
          ...current,
          coinMarket,
        }));
      },
    }),
    [mode],
  );

  return (
    <AssetModeContext.Provider value={value}>
      {children}
    </AssetModeContext.Provider>
  );
}

export function useAssetMode() {
  const context = useContext(AssetModeContext);

  if (!context) {
    throw new Error(
      'useAssetMode must be used inside AssetModeProvider',
    );
  }

  return context;
}
