import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { Bell, RefreshCw, Search, ShieldAlert, TrendingUp } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { AssetSwitch } from '@/components/asset-switch';
import { useAssetMode } from '@/lib/asset-mode';
import { api, apiGet, type QuoteRow } from '@/lib/api';
import { displayCoinName, displayStockName, formatAppPercent, formatAppPrice } from '@/lib/stock-display';
import { cn } from '@/lib/utils';

type AnyObj = Record<string, any>;

function formatDateTime(now: Date) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric',
    weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(now);
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export default function HomePage() {
  const [, navigate] = useLocation();
  const mode = useAssetMode();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const summary = useQuery({
    queryKey: ['home-market-summary'],
    queryFn: () => api.summary(),
    enabled: mode.asset === 'stock',
    refetchInterval: 10_000,
  });
  const movers = useQuery({
    queryKey: ['home-market-movers', mode.stockMarket],
    queryFn: () => api.movers(mode.stockMarket === 'KR' ? 'KRX' : 'NASDAQ'),
    enabled: mode.asset === 'stock',
    refetchInterval: 20_000,
  });
  const cryptoStatus = useQuery({
    queryKey: ['home-crypto-status'],
    queryFn: () => apiGet<AnyObj>('/crypto/status'),
    enabled: mode.asset === 'coin',
    refetchInterval: 30_000,
  });
  const spotTickers = useQuery({
    queryKey: ['home-crypto-spot-tickers'],
    queryFn: () => apiGet<AnyObj>('/crypto/spot/tickers'),
    enabled: mode.asset === 'coin' && mode.coinMarket === 'spot',
    refetchInterval: 10_000,
  });
  const futuresTickers = useQuery({
    queryKey: ['home-crypto-futures-tickers'],
    queryFn: () => apiGet<AnyObj>('/crypto/futures/tickers'),
    enabled: mode.asset === 'coin' && mode.coinMarket === 'futures',
    refetchInterval: 8_000,
  });

  const stockRows = useMemo(() => {
    const source = movers.data?.popular ?? [];
    return source.filter((row) => row.market === mode.stockMarket).slice(0, 10);
  }, [mode.stockMarket, movers.data]);
  const cryptoRows = useMemo(() => {
    const source = mode.coinMarket === 'spot'
      ? ((spotTickers.data?.tickers ?? []) as AnyObj[])
      : ((futuresTickers.data?.tickers ?? []) as AnyObj[]);
    return [...source]
      .sort((a, b) => Number(b.tradingValue24h ?? 0) - Number(a.tradingValue24h ?? 0))
      .slice(0, 10);
  }, [futuresTickers.data, mode.coinMarket, spotTickers.data]);

  const refresh = () => {
    if (mode.asset === 'stock') {
      void Promise.all([summary.refetch(), movers.refetch()]);
    } else {
      void Promise.all([cryptoStatus.refetch(), mode.coinMarket === 'spot' ? spotTickers.refetch() : futuresTickers.refetch()]);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="border-b border-card-border bg-background/95 px-4 pb-3 pt-4 backdrop-blur">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-black">지식정보</h1>
            <p className="mt-1 text-[11px] font-bold text-muted-foreground">{formatDateTime(now)}</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => navigate('/alerts')} aria-label="알림" className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card"><Bell className="h-4 w-4" /></button>
            <button type="button" onClick={refresh} aria-label="새로고침" className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card"><RefreshCw className={cn('h-4 w-4', (summary.isFetching || movers.isFetching || spotTickers.isFetching || futuresTickers.isFetching) && 'animate-spin')} /></button>
          </div>
        </div>
        <AssetSwitch className="mt-3" />
        <button type="button" onClick={() => navigate('/stocks')} className="mt-3 flex w-full items-center gap-2 rounded-2xl border border-card-border bg-card px-4 py-3 text-left">
          <Search className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-black text-muted-foreground">{mode.asset === 'stock' ? '종목 검색' : '코인 검색'}</span>
        </button>
      </header>

      <main className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-28 pt-4">
        {mode.asset === 'stock' ? (
          <StockHome mode={mode.stockMarket} summary={summary.data?.items ?? []} rows={stockRows} loading={summary.isLoading || movers.isLoading} error={summary.isError || movers.isError} onNavigate={navigate} />
        ) : (
          <CryptoHome mode={mode.coinMarket} status={cryptoStatus.data} rows={cryptoRows} loading={mode.coinMarket === 'spot' ? spotTickers.isLoading : futuresTickers.isLoading} error={mode.coinMarket === 'spot' ? spotTickers.isError : futuresTickers.isError} onNavigate={navigate} />
        )}
      </main>
      <BottomNav />
    </div>
  );
}

function StockHome({ mode, summary, rows, loading, error, onNavigate }: { mode: 'KR' | 'US'; summary: AnyObj[]; rows: QuoteRow[]; loading: boolean; error: boolean; onNavigate: (to: string) => void }) {
  const wanted = mode === 'KR' ? ['kospi', 'kosdaq'] : ['nasdaq'];
  const indices = summary.filter((item) => wanted.includes(String(item.key).toLowerCase()));
  return (
    <>
      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between"><h2 className="text-sm font-black">시장현황</h2><span className="text-[10px] font-bold text-muted-foreground">실제 제공기관 기준</span></div>
        {loading && <State>시장 데이터를 불러오는 중입니다.</State>}
        {error && <State error>시장 데이터 제공기관이 지연되고 있습니다.</State>}
        <div className="mt-3 grid grid-cols-2 gap-2">
          {indices.map((item) => {
            const change = finite(item.changePercent);
            return <InfoCard key={String(item.key)} label={String(item.label ?? item.key)} value={finite(item.price) == null ? '데이터 없음' : Number(item.price).toLocaleString(undefined, { maximumFractionDigits: 2 })} sub={change == null ? '등락 데이터 없음' : formatAppPercent(change)} tone={change == null ? undefined : change >= 0 ? 'up' : 'down'} />;
          })}
          {!loading && indices.length === 0 && <div className="col-span-2"><State>현재 제공된 지수 데이터가 없습니다.</State></div>}
        </div>
      </section>
      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3"><div><h2 className="text-sm font-black">거래대금 상위</h2><p className="mt-1 text-[10px] font-bold text-muted-foreground">고정 종목이 아닌 실제 조회 결과</p></div><button type="button" onClick={() => onNavigate('/stocks')} className="text-xs font-black text-primary">전체보기</button></div>
        <div className="mt-3 space-y-2">{rows.map((row, index) => <StockRow key={`${row.market}:${row.ticker}`} row={row} rank={index + 1} onClick={() => onNavigate(`/stock/${encodeURIComponent(row.ticker)}`)} />)}</div>
        {!loading && rows.length === 0 && <State>실제 순위 데이터가 없습니다.</State>}
      </section>
      <div className="grid grid-cols-2 gap-3">
        <QuickCard icon={TrendingUp} title="AI 추천 (규칙 기반)" onClick={() => onNavigate('/recommendations')} />
        <QuickCard icon={ShieldAlert} title="자동매매 상태" onClick={() => onNavigate('/auto-trading')} />
      </div>
    </>
  );
}

function CryptoHome({ mode, status, rows, loading, error, onNavigate }: { mode: 'spot' | 'futures'; status?: AnyObj; rows: AnyObj[]; loading: boolean; error: boolean; onNavigate: (to: string) => void }) {
  const exchange = mode === 'spot' ? 'UPBIT' : 'BITGET';
  const ok = mode === 'spot' ? status?.upbit?.ok : status?.bitget?.ok;
  const btc = rows.find((row) => String(row.symbol).startsWith('BTC'));
  const eth = rows.find((row) => String(row.symbol).startsWith('ETH'));
  const xrp = rows.find((row) => String(row.symbol).startsWith('XRP'));
  return (
    <>
      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between"><h2 className="text-sm font-black">{mode === 'spot' ? '코인 현물 시장' : '코인 선물 시장'}</h2><span className={cn('rounded-full px-2 py-1 text-[10px] font-black', ok ? 'bg-positive/10 text-positive' : 'bg-destructive/10 text-destructive')}>{exchange} · {ok ? '정상' : '오류'}</span></div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <CryptoSummary row={btc} label={`비트코인 (${mode === 'spot' ? 'BTC/KRW' : 'BTCUSDT'})`} currency={mode === 'spot' ? 'KRW' : 'USDT'} />
          <CryptoSummary row={eth} label={`이더리움 (${mode === 'spot' ? 'ETH/KRW' : 'ETHUSDT'})`} currency={mode === 'spot' ? 'KRW' : 'USDT'} />
          <CryptoSummary row={xrp} label={`리플 (${mode === 'spot' ? 'XRP/KRW' : 'XRPUSDT'})`} currency={mode === 'spot' ? 'KRW' : 'USDT'} />
        </div>
        <p className="mt-2 text-[10px] font-bold text-muted-foreground">
          {mode === 'spot' ? '업비트 공개 API' : '비트겟 공개 API'} 실시간 시세 기준
        </p>
        {mode === 'futures' && btc && <div className="mt-2 grid grid-cols-2 gap-2"><InfoCard label="BTC 펀딩비" value={finite(btc.fundingRate) == null ? '데이터 없음' : `${(Number(btc.fundingRate) * 100).toFixed(4)}%`} /><InfoCard label="BTC 미결제약정" value={finite(btc.openInterest) == null ? '데이터 없음' : Number(btc.openInterest).toLocaleString()} /></div>}
      </section>
      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between"><div><h2 className="text-sm font-black">거래대금 상위</h2><p className="mt-1 text-[10px] font-bold text-muted-foreground">실제 거래소 공개 시세</p></div><button type="button" onClick={() => onNavigate('/stocks')} className="text-xs font-black text-primary">전체보기</button></div>
        {loading && <State>코인 시세를 불러오는 중입니다.</State>}
        {error && <State error>거래소 시세를 불러오지 못했습니다.</State>}
        <div className="mt-3 space-y-2">{rows.map((row, index) => <CryptoRow key={String(row.symbol)} row={row} rank={index + 1} currency={mode === 'spot' ? 'KRW' : 'USDT'} onClick={() => onNavigate(`/stock-info?asset=coin&coinMarket=${mode}&symbol=${encodeURIComponent(String(row.symbol))}`)} />)}</div>
      </section>
      <div className="grid grid-cols-2 gap-3"><QuickCard icon={TrendingUp} title="코인 종목보기" onClick={() => onNavigate('/stocks')} /><QuickCard icon={ShieldAlert} title="코인 자동매매" onClick={() => onNavigate('/auto-trading')} /></div>
    </>
  );
}

function StockRow({ row, rank, onClick }: { row: QuoteRow; rank: number; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl bg-secondary/60 p-3 text-left"><span className="w-6 text-center text-sm font-black text-primary">{rank}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-black">{displayStockName(row.ticker, row.name, row.market)}</p><p className="mt-0.5 text-[10px] font-bold text-muted-foreground">{row.ticker}</p></div><div className="text-right"><p className="text-xs font-black">{formatAppPrice(row.price, row.currency)}</p><p className={cn('text-[10px] font-black', row.changePercent >= 0 ? 'text-positive' : 'text-destructive')}>{formatAppPercent(row.changePercent)}</p></div></button>;
}

function CryptoRow({ row, rank, currency, onClick }: { row: AnyObj; rank: number; currency: string; onClick: () => void }) {
  const change = finite(row.changePercent ?? row.changePercent24h);
  return <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl bg-secondary/60 p-3 text-left"><span className="w-6 text-center text-sm font-black text-primary">{rank}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-black">{displayCoinName(String(row.symbol), row.koreanName, row.englishName)}</p><p className="mt-0.5 text-[10px] font-bold text-muted-foreground">{row.symbol}</p></div><div className="text-right"><p className="text-xs font-black">{formatAppPrice(Number(row?.price), currency)}</p><p className={cn('text-[10px] font-black', change == null ? 'text-muted-foreground' : change >= 0 ? 'text-positive' : 'text-destructive')}>{change == null ? '데이터 없음' : formatAppPercent(change)}</p></div></button>;
}

function CryptoSummary({ row, label, currency }: { row?: AnyObj; label: string; currency: string }) {
  const change = finite(row?.changePercent ?? row?.changePercent24h);
  return <InfoCard label={label} value={finite(row?.price) == null ? '데이터 없음' : formatAppPrice(Number(row?.price), currency)} sub={change == null ? '등락 데이터 없음' : formatAppPercent(change)} tone={change == null ? undefined : change >= 0 ? 'up' : 'down'} />;
}

function InfoCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'up' | 'down' }) {
  return <div className="rounded-2xl bg-secondary/60 p-3"><p className="text-[10px] font-bold text-muted-foreground">{label}</p><p className="mt-1 text-sm font-black">{value}</p>{sub && <p className={cn('mt-1 text-[10px] font-black', tone === 'up' ? 'text-positive' : tone === 'down' ? 'text-destructive' : 'text-muted-foreground')}>{sub}</p>}</div>;
}

function QuickCard({ icon: Icon, title, onClick }: { icon: typeof TrendingUp; title: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="rounded-3xl border border-card-border bg-card p-4 text-left shadow-sm"><Icon className="h-5 w-5 text-primary" /><p className="mt-3 break-keep text-sm font-black">{title}</p></button>;
}

function State({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return <p className={cn('mt-3 rounded-2xl bg-secondary p-4 text-center text-xs font-bold text-muted-foreground', error && 'bg-destructive/10 text-destructive')}>{children}</p>;
}
