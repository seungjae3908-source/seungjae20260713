import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { authorizedFetch } from '@/lib/auth-fetch';
import { cn } from '@/lib/utils';

type Bar = { date?: string; time?: string | number; open: number; high: number; low: number; close: number; volume: number };
type DepthLevel = { askPrice: number | null; askSize: number | null; bidPrice: number | null; bidSize: number | null };
type Depth = { available: boolean; provider: string; levels: DepthLevel[]; stale?: boolean; reason?: string };
type Backtest = {
  runs: number; accepted: boolean; decision: string; realOrdersBlocked: true;
  best?: { params: { fast: number; slow: number; stopPct: number; takePct: number }; validation: { trades: number; winRate: number; netReturnPct: number; maxDrawdownPct: number; profitFactor: number } } | null;
};
type PaperOrder = { id: string; side: 'buy' | 'sell'; symbol: string; price: number; quantity: number; createdAt: string; status: 'paper' };

const format = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('ko-KR', { maximumFractionDigits: 8 });

export function PaperTradingWorkbench({ asset, market, symbol, currentPrice, bars }: {
  asset: 'stock' | 'coin'; market: string; symbol: string; currentPrice: number | null; bars: Bar[];
}) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [price, setPrice] = useState(() => currentPrice ? String(currentPrice) : '');
  const [quantity, setQuantity] = useState('1');
  const [orders, setOrders] = useState<PaperOrder[]>([]);
  const [backtest, setBacktest] = useState<Backtest | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => { if (currentPrice && !price) setPrice(String(currentPrice)); }, [currentPrice, price]);
  useEffect(() => {
    try { setOrders(JSON.parse(localStorage.getItem(`paper-orders:${asset}:${market}:${symbol}`) ?? '[]')); } catch { setOrders([]); }
  }, [asset, market, symbol]);

  const depth = useQuery({
    queryKey: ['market-depth', asset, market, symbol],
    queryFn: async () => {
      const response = await authorizedFetch(`/api/market/depth?asset=${asset}&market=${encodeURIComponent(market)}&symbol=${encodeURIComponent(symbol)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('MARKET_DEPTH_UNAVAILABLE');
      return await response.json() as Depth;
    },
    refetchInterval: 3_000,
    staleTime: 2_000,
    retry: 1,
  });

  const validOrder = useMemo(() => Number(price) > 0 && Number(quantity) > 0, [price, quantity]);
  const savePaperOrder = () => {
    if (!validOrder) return;
    const order: PaperOrder = {
      id: crypto.randomUUID(),
      side,
      symbol,
      price: Number(price),
      quantity: Number(quantity),
      createdAt: new Date().toISOString(),
      status: 'paper',
    };
    const next: PaperOrder[] = [order, ...orders].slice(0, 100);
    setOrders(next);
    localStorage.setItem(`paper-orders:${asset}:${market}:${symbol}`, JSON.stringify(next));
    window.dispatchEvent(new Event('sa-paper-orders-updated'));
  };

  const runBacktest = async () => {
    setTesting(true);
    try {
      const response = await authorizedFetch('/api/strategy-lab/backtest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bars, feePct: asset === 'coin' ? 0.05 : 0.015, slippagePct: 0.05, maxRuns: 720 }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error ?? 'BACKTEST_FAILED');
      setBacktest(payload as Backtest);
    } finally { setTesting(false); }
  };

  useEffect(() => {
    if (bars.length < 120) return;
    const last = bars[bars.length - 1];
    const cacheKey = `paper-backtest:${asset}:${market}:${symbol}:${String(last?.time ?? last?.date ?? bars.length)}:${last?.close}`;
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) { setBacktest(JSON.parse(cached) as Backtest); return; }
    } catch { /* 저장소가 막혀도 자동 검증은 계속합니다. */ }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setTesting(true);
      void authorizedFetch('/api/strategy-lab/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bars, feePct: asset === 'coin' ? 0.05 : 0.015, slippagePct: 0.05, maxRuns: 720 }),
        signal: controller.signal,
      }).then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error ?? 'BACKTEST_FAILED');
        setBacktest(payload as Backtest);
        try { localStorage.setItem(cacheKey, JSON.stringify(payload)); } catch { /* noop */ }
      }).catch(() => undefined).finally(() => setTesting(false));
    }, 800);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [asset, market, symbol, bars]);

  return (
    <div className="space-y-3" data-ui-component="stock-info.trading">
      <section className="rounded-2xl border border-card-border bg-card p-3">
        <div className="flex items-center justify-between gap-2 text-center">
          <div><p className="font-black">실시간 호가</p><p className="text-[10px] font-bold text-muted-foreground">{depth.data?.provider ?? '조회 중'}{depth.data?.stale ? ' · 이전 정상값' : ''}</p></div>
          <span className="rounded-full bg-amber-500/15 px-2 py-1 text-[10px] font-black text-amber-500">조회 전용</span>
        </div>
        {depth.isLoading ? <p className="py-8 text-center text-sm font-bold text-muted-foreground">호가를 불러오는 중입니다.</p> : depth.data?.available ? (
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div className="space-y-1">{depth.data.levels.slice().reverse().map((row, i) => <button type="button" key={`a-${i}`} onClick={() => row.askPrice && setPrice(String(row.askPrice))} className="grid w-full grid-cols-2 rounded-lg bg-blue-500/10 px-2 py-1.5 text-blue-500"><span>{format(row.askPrice)}</span><span>{format(row.askSize)}</span></button>)}</div>
            <div className="space-y-1">{depth.data.levels.map((row, i) => <button type="button" key={`b-${i}`} onClick={() => row.bidPrice && setPrice(String(row.bidPrice))} className="grid w-full grid-cols-2 rounded-lg bg-red-500/10 px-2 py-1.5 text-red-500"><span>{format(row.bidPrice)}</span><span>{format(row.bidSize)}</span></button>)}</div>
          </div>
        ) : <p className="py-8 text-center text-sm font-bold text-muted-foreground">이 시장은 현재 호가 제공처가 없습니다. 가짜 호가는 표시하지 않습니다.</p>}
      </section>

      <section className="rounded-2xl border border-primary/30 bg-card p-3">
        <div className="text-center"><p className="font-black">모의 매매</p><p className="text-[10px] font-bold text-destructive">실제 주문 전송 없음 · 앱 내부 모의 기록만 저장</p></div>
        <div className="mt-3 grid grid-cols-2 gap-2">{(['buy','sell'] as const).map(value => <button key={value} type="button" onClick={() => setSide(value)} className={cn('rounded-xl py-2 text-sm font-black', side === value ? value === 'buy' ? 'bg-red-500 text-white' : 'bg-blue-500 text-white' : 'bg-secondary')}>{value === 'buy' ? '모의 매수' : '모의 매도'}</button>)}</div>
        <div className="mt-2 grid grid-cols-2 gap-2"><label className="text-center text-xs font-bold">가격<input inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} className="mt-1 w-full rounded-xl border border-card-border bg-background px-3 py-2 text-center" /></label><label className="text-center text-xs font-bold">수량<input inputMode="decimal" value={quantity} onChange={event => setQuantity(event.target.value)} className="mt-1 w-full rounded-xl border border-card-border bg-background px-3 py-2 text-center" /></label></div>
        <button type="button" disabled={!validOrder} onClick={savePaperOrder} className="mt-3 w-full rounded-xl bg-primary py-3 text-sm font-black text-primary-foreground disabled:opacity-40">모의 주문 기록</button>
        {orders.length > 0 && <p className="mt-2 text-center text-[10px] font-bold text-muted-foreground">이 종목 모의 기록 {orders.length}건 · 최근 {orders[0].side === 'buy' ? '매수' : '매도'} {format(orders[0].price)}</p>}
      </section>

      <section className="rounded-2xl border border-card-border bg-card p-3 text-center">
        <p className="font-black">반복 백테스트 · 자동 전략 선택</p><p className="mt-1 text-[10px] font-bold text-muted-foreground">훈련/검증 구간 분리 · 수수료/슬리피지 반영 · 최대 720개 조합</p>
        <button type="button" disabled={testing || bars.length < 120} onClick={runBacktest} className="mt-3 w-full rounded-xl bg-secondary py-3 text-sm font-black disabled:opacity-40">{testing ? '720개 전략을 검증 중…' : bars.length < 120 ? `봉 데이터 부족 (${bars.length}/120)` : '반복 검증 시작'}</button>
        {backtest && <div className="mt-3 rounded-xl bg-background p-3"><p className={cn('font-black', backtest.accepted ? 'text-positive' : 'text-warning')}>{backtest.accepted ? '모의 전략 채택' : '검증 통과 전략 없음'}</p><p className="mt-1 text-xs font-bold text-muted-foreground">{backtest.runs}회 검증 · 실주문 차단 확인</p>{backtest.best && <p className="mt-2 text-xs font-bold">MA {backtest.best.params.fast}/{backtest.best.params.slow} · 손절 {backtest.best.params.stopPct}% · 익절 {backtest.best.params.takePct}%<br/>검증수익 {backtest.best.validation.netReturnPct.toFixed(2)}% · MDD {backtest.best.validation.maxDrawdownPct.toFixed(2)}%</p>}</div>}
      </section>
    </div>
  );
}
