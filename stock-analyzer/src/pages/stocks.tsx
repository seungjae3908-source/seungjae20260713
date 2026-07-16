import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { Filter, Layers3, Search, SlidersHorizontal, Star } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { AssetSwitch } from '@/components/asset-switch';
import { ErrorState, LoadingState } from '@/components/data-state';
import { api, apiGet, type ScanCard } from '@/lib/api';
import { useAssetMode } from '@/lib/asset-mode';
import { displayCoinName, displayStockName, formatAppPercent, formatAppPrice, isInWatchlist, toggleWatchlistItem } from '@/lib/stock-display';
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
          <div className="mt-3 grid grid-cols-2 gap-2">
            <QuickButton icon={Filter} label="조건검색" onClick={() => navigate('/scanner')} />
            <QuickButton icon={Layers3} label="테마종목" onClick={() => navigate(`/themes?market=${mode.stockMarket}`)} />
          </div>
        )}
      </header>

      <main className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-28 pt-4">
        {mode.asset === 'stock' && <InlineConditionSearch market={mode.stockMarket} onOpenStock={(ticker) => navigate(`/stock/${encodeURIComponent(ticker)}`)} />}

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

// ─── 상세검색(조건 검색) — 실제 /market/scan 결과만 표시 ───────────────────────
const SEARCH_INDICATORS = [
  '거래량 증가', '거래대금 증가', '5일선 돌파', '20일선 회복', '60일선 돌파',
  'MACD 골든크로스', 'RSI 과매도 반등', '돌파 직전', '박스권 하단', '단기 추세 전환',
  '볼린저밴드 상단 돌파', '스토캐스틱 골든크로스', 'OBV 상승', '신고가 근접', '낙폭과대',
  '저평가', 'PER 낮음', 'PBR 낮음', 'ROE 개선', 'AI 점수 상위',
];
const EXCLUDE_OPTIONS = [
  { key: 'down', label: '하락 종목 제외' },
  { key: 'lowConfidence', label: '신뢰도 50 미만 제외' },
] as const;
const SORT_OPTIONS = [
  { key: 'score', label: '모델점수순' },
  { key: 'match', label: '조건일치순' },
  { key: 'change', label: '등락률순' },
] as const;

function InlineConditionSearch({ market, onOpenStock }: { market: 'KR' | 'US'; onOpenStock: (ticker: string) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<(typeof SORT_OPTIONS)[number]['key']>('score');
  const [watchTick, setWatchTick] = useState(0);

  const scan = useQuery({
    queryKey: ['stocks-inline-scan', market, selected.join('|')],
    queryFn: () => api.scan(selected, market),
    enabled: false,
    retry: false,
  });

  const results = useMemo(() => {
    let cards = (scan.data?.cards ?? []) as ScanCard[];
    if (excluded.includes('down')) cards = cards.filter((card) => card.changePercent >= 0);
    if (excluded.includes('lowConfidence')) cards = cards.filter((card) => card.confidence >= 50);
    const sorted = [...cards];
    if (sortKey === 'score') sorted.sort((a, b) => b.score - a.score);
    if (sortKey === 'match') sorted.sort((a, b) => b.matchCount - a.matchCount || b.score - a.score);
    if (sortKey === 'change') sorted.sort((a, b) => b.changePercent - a.changePercent);
    return sorted.slice(0, 30);
  }, [excluded, scan.data, sortKey]);

  const toggle = (list: string[], value: string, set: (next: string[]) => void) => {
    set(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  };

  const updatedAt = scan.dataUpdatedAt ? new Date(scan.dataUpdatedAt).toLocaleTimeString('ko-KR') : null;

  return (
    <section className="rounded-3xl border border-primary/20 bg-primary/5 p-4 text-center shadow-sm">
      <h2 className="inline-flex items-center justify-center gap-1.5 text-sm font-black"><SlidersHorizontal className="h-4 w-4 text-primary" /> 검색 조건</h2>

      <p className="mt-3 text-[11px] font-black text-muted-foreground">지표 선택</p>
      <div className="mt-2 flex flex-wrap justify-center gap-1.5">
        {SEARCH_INDICATORS.map((label) => (
          <button key={label} type="button" onClick={() => toggle(selected, label, setSelected)} className={cn('rounded-full border px-2.5 py-1 text-[10px] font-black', selected.includes(label) ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-card text-muted-foreground')}>{label}</button>
        ))}
      </div>

      <p className="mt-3 text-[11px] font-black text-muted-foreground">제외 조건</p>
      <div className="mt-2 flex flex-wrap justify-center gap-1.5">
        {EXCLUDE_OPTIONS.map((option) => (
          <button key={option.key} type="button" onClick={() => toggle(excluded, option.key, setExcluded)} className={cn('rounded-full border px-2.5 py-1 text-[10px] font-black', excluded.includes(option.key) ? 'border-destructive bg-destructive/10 text-destructive' : 'border-card-border bg-card text-muted-foreground')}>{option.label}</button>
        ))}
      </div>

      <p className="mt-3 text-[11px] font-black text-muted-foreground">정렬 기준</p>
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        {SORT_OPTIONS.map((option) => (
          <button key={option.key} type="button" onClick={() => setSortKey(option.key)} className={cn('rounded-xl border px-2 py-1.5 text-[10px] font-black', sortKey === option.key ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-card text-muted-foreground')}>{option.label}</button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => { if (selected.length > 0) void scan.refetch(); }}
        disabled={selected.length === 0 || scan.isFetching}
        className="mt-3 w-full rounded-2xl bg-primary py-3 text-sm font-black text-primary-foreground disabled:opacity-50"
      >
        {scan.isFetching ? '실제 데이터 검색 중…' : selected.length === 0 ? '지표를 1개 이상 선택하세요' : '검색 실행'}
      </button>

      {scan.isError && (
        <p className="mt-3 rounded-2xl border border-destructive/30 bg-destructive/10 p-3 text-xs font-bold text-destructive">검색 오류 — 데이터 공급자 응답에 실패했습니다. 잠시 후 다시 시도해 주세요. (결과 0건과는 다른 상태입니다)</p>
      )}
      {scan.isSuccess && results.length === 0 && (
        <p className="mt-3 rounded-2xl bg-card p-3 text-xs font-bold text-muted-foreground">조건을 충족한 종목이 0건입니다. (API 오류 아님)</p>
      )}

      {results.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-[10px] font-bold text-muted-foreground">데이터 공급자: 서버 실시간 시세·지표 스캔{updatedAt ? ` · 갱신 ${updatedAt}` : ''} · {results.length}건 표시</p>
          {results.map((card) => {
            const starred = isInWatchlist(card.ticker);
            return (
              <div key={card.ticker} className="rounded-2xl border border-card-border bg-card p-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label={starred ? '관심종목 해제' : '관심종목 추가'}
                    onClick={() => { toggleWatchlistItem({ ticker: card.ticker, name: card.name, market: card.market, currency: card.currency, price: card.price, changePercent: card.changePercent }); setWatchTick(watchTick + 1); }}
                    className="shrink-0 rounded-xl border border-card-border p-2"
                  >
                    <Star className={cn('h-4 w-4', starred ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground')} />
                  </button>
                  <button type="button" onClick={() => onOpenStock(card.ticker)} className="min-w-0 flex-1 text-center">
                    <p className="truncate text-sm font-black">{displayStockName(card.ticker, card.name, card.market)}</p>
                    <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">{card.ticker} · 신뢰도 {card.confidence}</p>
                  </button>
                  <div className="shrink-0 text-center">
                    <p className="text-sm font-black text-primary">{card.score}점</p>
                    <p className={cn('text-[10px] font-black', card.changePercent > 0 ? 'text-positive' : card.changePercent < 0 ? 'text-destructive' : 'text-muted-foreground')}>{formatAppPercent(card.changePercent)}</p>
                  </div>
                </div>
                {card.matched.length > 0 && <p className="mt-2 break-keep text-[10px] font-bold text-muted-foreground">충족: {card.matched.join(' · ')}</p>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
