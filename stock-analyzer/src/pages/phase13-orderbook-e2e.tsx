import { useState } from 'react';
import { InstrumentOrderbookDock } from '@/components/instrument-orderbook-dock';

type AssetClass = 'stock' | 'crypto_spot' | 'crypto_futures';
type Market = 'KR' | 'US' | 'UPBIT' | 'BITGET';
type Target = { assetClass: AssetClass; market: Market; ticker: string };

function targetFromQuery(): Target {
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

const targets: Array<{ label: string; testId: string; value: Target }> = [
  {
    label: '국내주식 전환',
    testId: 'orderbook-target-stock',
    value: { assetClass: 'stock', market: 'KR', ticker: '005930' },
  },
  {
    label: '미국주식 전환',
    testId: 'orderbook-target-us',
    value: { assetClass: 'stock', market: 'US', ticker: 'AAPL' },
  },
  {
    label: '코인 현물 전환',
    testId: 'orderbook-target-spot',
    value: { assetClass: 'crypto_spot', market: 'UPBIT', ticker: 'BTC' },
  },
  {
    label: '코인 선물 전환',
    testId: 'orderbook-target-futures',
    value: { assetClass: 'crypto_futures', market: 'BITGET', ticker: 'BTCUSDT' },
  },
];

export default function Phase13OrderbookE2EPage() {
  const [target, setTarget] = useState<Target>(targetFromQuery);
  const [mounted, setMounted] = useState(true);

  return (
    <main className="min-h-[100dvh] overflow-y-auto bg-background p-4 pb-28">
      <h1 className="text-lg font-bold">통합 호가창 E2E</h1>
      <p className="mt-2 text-sm text-muted-foreground" data-testid="orderbook-e2e-target">
        {target.assetClass} · {target.market} · {target.ticker} · 읽기 전용 fixture
      </p>
      <div className="mt-4 flex flex-wrap gap-2" aria-label="E2E 호가 대상 전환">
        {targets.map((item) => (
          <button
            key={item.testId}
            type="button"
            data-testid={item.testId}
            onClick={() => { setMounted(true); setTarget(item.value); }}
            className="min-h-11 rounded-lg border border-border px-3 text-sm"
          >
            {item.label}
          </button>
        ))}
        <button
          type="button"
          data-testid="orderbook-unmount"
          onClick={() => setMounted(false)}
          className="min-h-11 rounded-lg border border-border px-3 text-sm"
        >
          호가창 제거
        </button>
      </div>
      <div className="mt-6 rounded-xl border border-border p-4 text-sm">
        실제 상세 화면에서는 우측 하단의 호가창 버튼으로 같은 UI를 엽니다.
      </div>
      {mounted ? (
        <InstrumentOrderbookDock
          ticker={target.ticker}
          market={target.market}
          assetClass={target.assetClass}
          defaultOpen
        />
      ) : null}
    </main>
  );
}
