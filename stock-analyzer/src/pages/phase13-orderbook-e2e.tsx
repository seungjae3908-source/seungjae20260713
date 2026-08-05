import { InstrumentOrderbookDock } from '@/components/instrument-orderbook-dock';

export default function Phase13OrderbookE2EPage() {
  const params = new URLSearchParams(window.location.search);
  const ticker = (params.get('ticker') || '005930').trim().toUpperCase();
  const market = params.get('market') === 'US' ? 'US' : 'KR';

  return (
    <main className="min-h-[100dvh] overflow-y-auto bg-background p-4 pb-28">
      <h1 className="text-lg font-bold">종목 호가창 E2E</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {market} · {ticker} · 읽기 전용 fixture
      </p>
      <div className="mt-6 rounded-xl border border-border p-4 text-sm">
        실제 상세 화면에서는 우측 하단의 호가창 버튼으로 같은 UI를 엽니다.
      </div>
      <InstrumentOrderbookDock
        ticker={ticker}
        market={market}
        defaultOpen
      />
    </main>
  );
}
