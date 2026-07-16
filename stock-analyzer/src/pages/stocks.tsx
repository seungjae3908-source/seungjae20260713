import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { Filter, Layers3, Search, Star, TrendingUp } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { AssetSwitch } from '@/components/asset-switch';
import { ErrorState, LoadingState } from '@/components/data-state';
import { api, apiGet, type UndervaluedCard } from '@/lib/api';
import { useAssetMode } from '@/lib/asset-mode';
import { displayCoinName, displayStockName, formatAppPercent, formatAppPrice } from '@/lib/stock-display';
import { cn } from '@/lib/utils';

type AnyObj = Record<string, any>;

export default function StocksPage() {
  const [, navigate] = useLocation();
  const mode = useAssetMode();
  const [query, setQuery] = useState('');
  const trimmed = query.trim();

  const stockRows = useQuery({
    queryKey: ['stocks-directory', mode.stockMarket, trimmed],
    queryFn: () => api.searchRows(trimmed),
    enabled: mode.asset === 'stock',
    staleTime: 30_000,
  });
  const undervalued = useQuery({
    queryKey: ['stocks-undervalued-recovery', mode.stockMarket],
    queryFn: () => api.undervalued(mode.stockMarket === 'KR' ? 'KRX' : 'NASDAQ'),
    enabled: mode.asset === 'stock',
    staleTime: 60_000,
  });
  const spotMarkets = useQuery({
    queryKey: ['stocks-crypto-spot-markets'],
    queryFn: () => apiGet<AnyObj>('/crypto/spot/markets'),
    enabled: mode.asset === 'coin' && mode.coinMarket === 'spot',
    staleTime: 10 * 60_000,
  });
  const spotTickers = useQuery({
    queryKey: ['stocks-crypto-spot-tickers'],
    queryFn: () => apiGet<AnyObj>('/crypto/spot/tickers'),
    enabled: mode.asset === 'coin' && mode.coinMarket === 'spot',
    refetchInterval: 15_000,
  });
  const futuresTickers = useQuery({
    queryKey: ['stocks-crypto-futures-tickers'],
    queryFn: () => apiGet<AnyObj>('/crypto/futures/tickers'),
    enabled: mode.asset === 'coin' && mode.coinMarket === 'futures',
    refetchInterval: 10_000,
  });

  const visibleStocks = useMemo(
    () => (stockRows.data?.results ?? [])
      .filter((row) => row.market === mode.stockMarket)
      .slice(0, 100),
    [mode.stockMarket, stockRows.data],
  );
  const spotNames = useMemo(
    () => new Map<string, AnyObj>(((spotMarkets.data?.markets ?? []) as AnyObj[]).map((row) => [String(row.symbol), row])),
    [spotMarkets.data],
  );
  const cryptoRows = useMemo(() => {
    const source = mode.coinMarket === 'spot'
      ? ((spotTickers.data?.tickers ?? []) as AnyObj[]).map((row) => ({ ...row, ...(spotNames.get(String(row.symbol)) ?? {}) }))
      : ((futuresTickers.data?.tickers ?? []) as AnyObj[]);
    const needle = trimmed.toLowerCase();
    return source
      .filter((row) => !needle || [row.symbol, row.koreanName, row.englishName].some((value) => String(value ?? '').toLowerCase().includes(needle)))
      .sort((a, b) => Number(b.tradingValue24h ?? 0) - Number(a.tradingValue24h ?? 0))
      .slice(0, 100);
  }, [futuresTickers.data, mode.coinMarket, spotNames, spotTickers.data, trimmed]);

  const activeLoading = mode.asset === 'stock'
    ? stockRows.isLoading
    : mode.coinMarket === 'spot' ? spotTickers.isLoading : futuresTickers.isLoading;
  const activeError = mode.asset === 'stock'
    ? stockRows.isError
    : mode.coinMarket === 'spot' ? spotTickers.isError : futuresTickers.isError;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="border-b border-card-border bg-background/95 px-4 pb-3 pt-4 backdrop-blur">
        <h1 className="text-xl font-black">종목</h1>
        <p className="mt-1 text-xs text-muted-foreground">현재 선택 자산에 맞는 검색·추천·조건검색을 표시합니다.</p>
        <AssetSwitch className="mt-3" />
        <label className="mt-3 flex h-11 items-center gap-2 rounded-2xl border border-card-border bg-card px-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={mode.asset === 'stock' ? '종목명·코드·영문명 검색' : '코인명·심볼 검색'}
            className="min-w-0 flex-1 bg-transparent text-sm font-bold outline-none"
          />
        </label>
        {mode.asset === 'stock' && (
          <div className="mt-3 grid grid-cols-3 gap-2">
            <QuickButton icon={Filter} label="조건검색" onClick={() => navigate('/scanner')} />
            <QuickButton icon={Layers3} label="테마종목" onClick={() => navigate(`/themes?market=${mode.stockMarket}`)} />
            <QuickButton icon={TrendingUp} label="상세검색" onClick={() => navigate(`/search?market=${mode.stockMarket}`)} />
          </div>
        )}
      </header>

      <main className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-28 pt-4">
        {mode.asset === 'stock' && (
          <section className="rounded-3xl border border-primary/20 bg-primary/5 p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-black">저평가 회복</h2>
                <p className="mt-1 text-[10px] font-bold text-muted-foreground">실제 재무·가격 데이터가 충분한 종목만 독립 추천합니다.</p>
              </div>
              <span className="text-[10px] font-black text-primary">{undervalued.data?.cards?.length ?? 0}개</span>
            </div>
            {undervalued.isLoading && <div className="mt-3"><LoadingState label="저평가 회복 후보를 계산하는 중입니다." /></div>}
            {undervalued.isError && <p className="mt-3 rounded-2xl bg-card p-3 text-xs font-bold text-muted-foreground">실제 데이터가 부족하거나 제공기관이 지연되고 있습니다.</p>}
            <div className="mt-3 space-y-2">
              {(undervalued.data?.cards ?? []).slice(0, 5).map((card: UndervaluedCard) => (
                <button key={card.ticker} type="button" onClick={() => navigate(`/stock/${encodeURIComponent(card.ticker)}`)} className="w-full rounded-2xl border border-card-border bg-card p-3 text-left">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0"><p className="truncate text-sm font-black">{displayStockName(card.ticker, card.name, card.market)}</p><p className="mt-1 truncate text-[10px] font-bold text-muted-foreground">{card.reasons.join(' · ') || '실제 데이터 근거 확인 필요'}</p></div>
                    <div className="shrink-0 text-right"><p className="text-sm font-black text-primary">{card.score}점</p><p className="text-[9px] font-bold text-muted-foreground">모델점수</p></div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-black">{mode.asset === 'stock' ? '종목보기' : `${mode.coinMarket === 'spot' ? '업비트 현물' : '비트겟 선물'} 보기`}</h2>
            <span className="text-[11px] font-bold text-muted-foreground">
              {mode.asset === 'stock'
                ? (stockRows.data ? `${visibleStocks.length}개 표시` : '조회 중')
                : `${cryptoRows.length}개 표시`}
            </span>
          </div>
          {activeLoading && <LoadingState label="실제 목록을 불러오는 중입니다." />}
          {activeError && <ErrorState onRetry={() => { void (mode.asset === 'stock' ? stockRows.refetch() : mode.coinMarket === 'spot' ? spotTickers.refetch() : futuresTickers.refetch()); }} />}
          {!activeLoading && !activeError && (mode.asset === 'stock' ? visibleStocks.length : cryptoRows.length) === 0 && (
            <div className="rounded-3xl border border-card-border bg-card p-6 text-center text-sm font-bold text-muted-foreground">조건에 맞는 실제 데이터가 없습니다.</div>
          )}
          <div className="space-y-2">
            {mode.asset === 'stock' ? visibleStocks.map((stock) => (
              <button key={`${stock.market}:${stock.ticker}`} type="button" onClick={() => navigate(`/stock/${encodeURIComponent(stock.ticker)}`)} className="flex w-full items-center gap-3 rounded-2xl border border-card-border bg-card p-3 text-left shadow-sm">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10"><Star className="h-4 w-4 text-primary" /></div>
                <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="truncate text-sm font-black">{displayStockName(stock.ticker, stock.name, stock.market)}</p><span className="rounded-full bg-secondary px-2 py-0.5 text-[9px] font-black text-muted-foreground">{stock.market}</span></div><p className="mt-0.5 text-[11px] font-bold text-muted-foreground">{stock.ticker}</p></div>
                <div className="text-right"><p className="text-sm font-black">{formatAppPrice(stock.price, stock.currency)}</p><p className={cn('mt-0.5 text-[11px] font-black', stock.changePercent > 0 ? 'text-positive' : stock.changePercent < 0 ? 'text-destructive' : 'text-muted-foreground')}>{formatAppPercent(stock.changePercent)}</p></div>
              </button>
            )) : cryptoRows.map((row) => {
              const change = Number(row.changePercent ?? row.changePercent24h);
              const currency = mode.coinMarket === 'spot' ? 'KRW' : 'USDT';
              return (
                <button key={String(row.symbol)} type="button" onClick={() => navigate(`/stock-info?asset=coin&coinMarket=${mode.coinMarket}&symbol=${encodeURIComponent(String(row.symbol))}`)} className="flex w-full items-center gap-3 rounded-2xl border border-card-border bg-card p-3 text-left shadow-sm">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10"><Star className="h-4 w-4 text-primary" /></div>
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-black">{displayCoinName(String(row.symbol), row.koreanName, row.englishName)}</p><p className="mt-0.5 text-[11px] font-bold text-muted-foreground">{row.symbol} · {mode.coinMarket === 'spot' ? 'UPBIT' : 'BITGET'}</p></div>
                  <div className="text-right"><p className="text-sm font-black">{formatAppPrice(Number(row.price), currency)}</p><p className={cn('mt-0.5 text-[11px] font-black', change > 0 ? 'text-positive' : change < 0 ? 'text-destructive' : 'text-muted-foreground')}>{Number.isFinite(change) ? formatAppPercent(change) : '데이터 없음'}</p></div>
                </button>
              );
            })}
          </div>
        </section>
      </main>
      <BottomNav />
    </div>
  );
}

function QuickButton({ icon: Icon, label, onClick }: { icon: typeof Search; label: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="flex items-center justify-center gap-1.5 rounded-xl border border-card-border bg-card px-2 py-2 text-[11px] font-black"><Icon className="h-3.5 w-3.5 text-primary" />{label}</button>;
}
