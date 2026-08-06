import { InstrumentOrderbookDock } from '@/components/instrument-orderbook-dock';

type AssetClass = 'stock' | 'crypto_spot' | 'crypto_futures';
type Market = 'KR' | 'US' | 'UPBIT' | 'BITGET';

function targetFromQuery(): {
  assetClass: AssetClass;
  market: Market;
  ticker: string;
} {
  const params = new URLSearchParams(window.location.search);
  const assetClassRaw = params.get('assetClass');
  const assetClass: AssetClass = assetClassRaw === 'crypto_spot'
    || assetClassRaw === 'crypto_futures'
    ? assetClassRaw
    : 'stock';
  const marketRaw = params.get('market')?.toUpperCase();
  const market: Market = assetClass === 'crypto_spot'
    ? 'UPBIT'
    : assetClass === 'crypto_futures'
      ? 'BITGET'
      : marketRaw === 'US'
        ? 'US'
        : 'KR';
  const fallback = assetClass === 'stock'
    ? market === 'US' ? 'AAPL' : '005930'
    : assetClass === 'crypto_spot' ? 'BTC' : 'BTCUSDT';
  const ticker = (params.get('ticker') || fallback).trim().toUpperCase();
  return { assetClass, market, ticker };
}

export default function Phase13OrderbookE2EPage() {
  const target = targetFromQuery();

  return (
    <main className="min-h-[100dvh] overflow-y-auto bg-background p-4 pb-28">
      <h1 className="text-lg font-bold">통합 호가창 E2E</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {target.assetClass} · {target.market} · {target.ticker} · 읽기 전용 fixture
      </p>
      <div className="mt-6 rounded-xl border border-border p-4 text-sm">
        실제 상세 화면에서는 우측 하단의 호가창 버튼으로 같은 UI를 엽니다.
      </div>
      <InstrumentOrderbookDock
        ticker={target.ticker}
        market={target.market}
        assetClass={target.assetClass}
        defaultOpen
      />
    </main>
  );
}
