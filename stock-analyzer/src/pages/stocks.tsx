import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { Search, Star } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { AssetSwitch } from '@/components/asset-switch';
import { ErrorState, LoadingState } from '@/components/data-state';
import { api, apiGet } from '@/lib/api';
import { useAssetMode } from '@/lib/asset-mode';
import { displayCoinName, displayStockName, formatAppPercent, formatAppPrice } from '@/lib/stock-display';
import { cn } from '@/lib/utils';

type AnyObj = Record<string, any>;

type CategoryKey = 'ai' | 'theme' | 'tradingValue' | 'volume' | 'gainers' | 'losers';

const CATEGORIES: { key: CategoryKey; label: string }[] = [
  { key: 'ai', label: 'AI추천' },
  { key: 'theme', label: '테마종목' },
  { key: 'tradingValue', label: '거래대금' },
  { key: 'volume', label: '거래량' },
  { key: 'gainers', label: '급상승' },
  { key: 'losers', label: '급하락' },
];

// AI 추천 응답 행 (recommendations 화면과 동일 스키마)
interface RecoRow {
  ticker: string;
  name: string;
  market: 'KR' | 'US';
  currency: 'KRW' | 'USD';
  category: 'undervalued' | 'breakout';
  categoryLabel: string;
  price: number;
  changePercent: number;
  reasons: string[];
  score: number;
}
interface RecoResponse {
  ok?: boolean;
  analysisMode?: string;
  analysisDescription?: string;
  market: 'KR' | 'US';
  rows: RecoRow[];
  error?: string;
}

export default function StocksPage() {
  const [, navigate] = useLocation();
  const mode = useAssetMode();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryKey>('ai');
  const trimmed = query.trim();
  const searching = trimmed.length > 0;

  // ── 검색용 데이터 (기존 체계 유지) ──────────────────────────────
  const stockRows = useQuery({
    queryKey: ['stocks-directory', mode.stockMarket, trimmed],
    queryFn: () => api.searchRows(trimmed),
    enabled: mode.asset === 'stock' && searching,
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

  // ── 분류 데이터 (기존 API) ──────────────────────────────────────
  const isStock = mode.asset === 'stock';
  const coinCategorySupported = category === 'tradingValue' || category === 'volume' || category === 'gainers' || category === 'losers';
  const useMovers = isStock && (category === 'tradingValue' || category === 'volume' || category === 'gainers' || category === 'losers');

  const recommendations = useQuery({
    queryKey: ['stocks-cat-reco', mode.stockMarket],
    queryFn: () => apiGet<RecoResponse>(`/market/recommendations?market=${mode.stockMarket}`),
    enabled: isStock && category === 'ai' && !searching,
    staleTime: 60_000,
  });
  const themes = useQuery({
    queryKey: ['stocks-cat-themes', mode.stockMarket],
    queryFn: () => api.themes(mode.stockMarket),
    enabled: isStock && category === 'theme' && !searching,
    staleTime: 60_000,
  });
  const movers = useQuery({
    queryKey: ['stocks-cat-movers', mode.stockMarket],
    queryFn: () => apiGet<Awaited<ReturnType<typeof api.movers>>>(`/market/movers?market=${mode.stockMarket === 'US' ? 'US' : 'KR'}`),
    enabled: useMovers && !searching,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  // ── 코인 티커 정렬 (실제 데이터) ────────────────────────────────
  const spotNames = useMemo(
    () => new Map<string, AnyObj>(((spotMarkets.data?.markets ?? []) as AnyObj[]).map((row) => [String(row.symbol), row])),
    [spotMarkets.data],
  );
  const coinSource = useMemo<AnyObj[]>(() => {
    if (mode.asset !== 'coin') return [];
    return mode.coinMarket === 'spot'
      ? ((spotTickers.data?.tickers ?? []) as AnyObj[]).map((row) => ({ ...row, ...(spotNames.get(String(row.symbol)) ?? {}) }))
      : ((futuresTickers.data?.tickers ?? []) as AnyObj[]);
  }, [futuresTickers.data, mode.asset, mode.coinMarket, spotNames, spotTickers.data]);

  const coinChange = (row: AnyObj) => Number(row.changePercent ?? row.changePercent24h);
  const sortedCoins = useMemo(() => {
    if (mode.asset !== 'coin' || !coinCategorySupported) return [] as AnyObj[];
    const rows = [...coinSource];
    if (category === 'tradingValue') rows.sort((a, b) => Number(b.tradingValue24h ?? 0) - Number(a.tradingValue24h ?? 0));
    if (category === 'volume') rows.sort((a, b) => Number(b.volume24h ?? 0) - Number(a.volume24h ?? 0));
    if (category === 'gainers') rows.sort((a, b) => (Number(coinChange(b)) || -Infinity) - (Number(coinChange(a)) || -Infinity));
    if (category === 'losers') rows.sort((a, b) => (Number(coinChange(a)) || Infinity) - (Number(coinChange(b)) || Infinity));
    return rows.slice(0, 100);
  }, [category, coinCategorySupported, coinSource, mode.asset]);

  // ── 검색 결과 (현재 선택 자산·시장 우선) ────────────────────────
  const searchStocks = useMemo(() => {
    if (mode.asset !== 'stock' || !searching) return [] as AnyObj[];
    const rows = (stockRows.data?.results ?? []) as AnyObj[];
    return [...rows]
      .sort((a, b) => (a.market === mode.stockMarket ? -1 : 0) - (b.market === mode.stockMarket ? -1 : 0))
      .slice(0, 100);
  }, [mode.asset, mode.stockMarket, searching, stockRows.data]);
  const searchCoins = useMemo(() => {
    if (mode.asset !== 'coin' || !searching) return [] as AnyObj[];
    const needle = trimmed.toLowerCase();
    return coinSource
      .filter((row) => [row.symbol, row.koreanName, row.englishName, displayCoinName(String(row.symbol), row.koreanName, row.englishName)]
        .some((value) => String(value ?? '').toLowerCase().includes(needle)))
      .sort((a, b) => Number(b.tradingValue24h ?? 0) - Number(a.tradingValue24h ?? 0))
      .slice(0, 100);
  }, [coinSource, mode.asset, searching, trimmed]);

  // ── 코인 검색 로딩·오류 상태 ────────────────────────────────────
  const coinTickerQuery = mode.coinMarket === 'spot' ? spotTickers : futuresTickers;

  const openStock = (ticker: string) => navigate(`/stock/${encodeURIComponent(ticker)}`);
  const openCoin = (symbol: string) => navigate(`/stock-info?asset=coin&coinMarket=${mode.coinMarket}&symbol=${encodeURIComponent(symbol)}`);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="border-b border-card-border bg-background/95 px-4 pb-3 pt-4 backdrop-blur">
        <h1 className="text-xl font-black text-center">종목</h1>

        {/* 1) 종목 검색창 — 제목 바로 아래에 붙여 하나의 상단 영역처럼 보이게(작은 간격). 입력 텍스트 왼쪽 정렬 유지 */}
        <label className="mt-1.5 flex h-11 items-center gap-2 rounded-2xl border border-card-border bg-card px-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={mode.asset === 'stock' ? '종목명·코드·영문명 검색' : '코인명·심볼 검색'}
            className="min-w-0 flex-1 bg-transparent text-sm font-bold outline-none"
          />
        </label>

        {/* 2) [주식][코인]  3) [국내][해외] / [현물][선물] */}
        <AssetSwitch className="mt-3" />

        {/* 4) 분류 버튼 6개 */}
        <div className="mt-3 grid grid-cols-3 gap-2">
          {CATEGORIES.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setCategory(item.key)}
              className={cn(
                'inline-flex items-center justify-center text-center break-keep leading-tight rounded-xl border px-2 py-2 text-[11px] font-black',
                category === item.key ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-card text-muted-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      <main className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-28 pt-4">
        {/* 검색 중이면 검색 결과가 분류 목록 위 */}
        {searching && (
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-black">검색 결과</h2>
              <span className="text-[11px] font-bold text-muted-foreground">
                {mode.asset === 'stock'
                  ? (stockRows.data ? `${searchStocks.length}개` : '조회 중')
                  : `${searchCoins.length}개`}
              </span>
            </div>
            {mode.asset === 'stock' ? (
              <>
                {stockRows.isLoading && <LoadingState label="실제 종목을 검색하는 중입니다." />}
                {stockRows.isError && <ErrorState onRetry={() => { void stockRows.refetch(); }} />}
                {!stockRows.isLoading && !stockRows.isError && searchStocks.length === 0 && (
                  <EmptyBox>검색어와 일치하는 실제 종목 데이터가 없습니다.</EmptyBox>
                )}
                <div className="space-y-2">
                  {searchStocks.map((stock) => (
                    <StockRow key={`${stock.market}:${stock.ticker}`} stock={stock} onClick={() => openStock(String(stock.ticker))} />
                  ))}
                </div>
              </>
            ) : (
              <>
                {coinTickerQuery.isLoading && <LoadingState label="실제 코인 시세를 불러오는 중입니다." />}
                {coinTickerQuery.isError && <ErrorState onRetry={() => { void coinTickerQuery.refetch(); }} />}
                {!coinTickerQuery.isLoading && !coinTickerQuery.isError && searchCoins.length === 0 && (
                  <EmptyBox>검색어와 일치하는 실제 코인 데이터가 없습니다.</EmptyBox>
                )}
                <div className="space-y-2">
                  {searchCoins.map((row) => (
                    <CoinRow key={String(row.symbol)} row={row} coinMarket={mode.coinMarket} onClick={() => openCoin(String(row.symbol))} />
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {/* 5) 선택한 분류의 실제 결과 목록 */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-black">{CATEGORIES.find((c) => c.key === category)?.label}</h2>
          </div>

          {isStock ? (
            <StockCategoryResults
              category={category}
              recommendations={recommendations}
              themes={themes}
              movers={movers}
              stockMarket={mode.stockMarket}
              onOpenStock={openStock}
            />
          ) : (
            <CoinCategoryResults
              category={category}
              coinCategorySupported={coinCategorySupported}
              coinTickerQuery={coinTickerQuery}
              sortedCoins={sortedCoins}
              coinMarket={mode.coinMarket}
              onOpenCoin={openCoin}
            />
          )}
        </section>
      </main>
      <BottomNav />
    </div>
  );
}

function EmptyBox({ children }: { children: React.ReactNode }) {
  return <div className="rounded-3xl border border-card-border bg-card p-6 text-center text-sm font-bold text-muted-foreground">{children}</div>;
}

// ── 공통 행 디자인 (기존 행 클래스 재사용) ──────────────────────────
function StockRow({ stock, onClick }: { stock: AnyObj; onClick: () => void }) {
  const change = Number(stock.changePercent);
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl border border-card-border bg-card p-3 text-left shadow-sm">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10"><Star className="h-4 w-4 text-primary" /></div>
      <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="truncate text-sm font-black">{displayStockName(String(stock.ticker), String(stock.name ?? ''), String(stock.market))}</p><span className="rounded-full bg-secondary px-2 py-0.5 text-[9px] font-black text-muted-foreground">{stock.market}</span></div><p className="mt-0.5 text-[11px] font-bold text-muted-foreground">{stock.ticker}</p></div>
      <div className="text-right"><p className="text-sm font-black">{formatAppPrice(stock.price, String(stock.currency))}</p><p className={cn('mt-0.5 text-[11px] font-black', change > 0 ? 'text-positive' : change < 0 ? 'text-destructive' : 'text-muted-foreground')}>{Number.isFinite(change) ? formatAppPercent(change) : '데이터 없음'}</p></div>
    </button>
  );
}

function CoinRow({ row, coinMarket, onClick }: { row: AnyObj; coinMarket: 'spot' | 'futures'; onClick: () => void }) {
  const change = Number(row.changePercent ?? row.changePercent24h);
  const currency = coinMarket === 'spot' ? 'KRW' : 'USDT';
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl border border-card-border bg-card p-3 text-left shadow-sm">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10"><Star className="h-4 w-4 text-primary" /></div>
      <div className="min-w-0 flex-1"><p className="truncate text-sm font-black">{displayCoinName(String(row.symbol), row.koreanName, row.englishName)}</p><p className="mt-0.5 text-[11px] font-bold text-muted-foreground">{row.symbol} · {coinMarket === 'spot' ? 'UPBIT' : 'BITGET'}</p></div>
      <div className="text-right"><p className="text-sm font-black">{formatAppPrice(Number(row.price), currency)}</p><p className={cn('mt-0.5 text-[11px] font-black', change > 0 ? 'text-positive' : change < 0 ? 'text-destructive' : 'text-muted-foreground')}>{Number.isFinite(change) ? formatAppPercent(change) : '데이터 없음'}</p></div>
    </button>
  );
}

// ── 주식 분류 결과 ──────────────────────────────────────────────
function StockCategoryResults({
  category,
  recommendations,
  themes,
  movers,
  stockMarket,
  onOpenStock,
}: {
  category: CategoryKey;
  recommendations: ReturnType<typeof useQuery<RecoResponse>>;
  themes: ReturnType<typeof useQuery<Awaited<ReturnType<typeof api.themes>>>>;
  movers: ReturnType<typeof useQuery<Awaited<ReturnType<typeof api.movers>>>>;
  stockMarket: 'KR' | 'US';
  onOpenStock: (ticker: string) => void;
}) {
  if (category === 'ai') {
    if (recommendations.isLoading) return <LoadingState label="규칙 기반 분석으로 추천을 계산하는 중입니다." />;
    if (recommendations.isError) return <ErrorState onRetry={() => { void recommendations.refetch(); }} />;
    const rows = recommendations.data?.rows ?? [];
    const undervalued = rows.filter((row) => row.category === 'undervalued');
    const breakout = rows.filter((row) => row.category === 'breakout');
    if (rows.length === 0) return <EmptyBox>현재 조건을 충족하는 실제 추천 종목이 없습니다. (조건 미달 종목으로 채우지 않습니다)</EmptyBox>;
    return (
      <div className="space-y-4">
        <p className="text-center text-[11px] font-bold text-muted-foreground">규칙 기반 분석 · AI(LLM) 미연결</p>
        <RecoGroup title="저평가 회복" rows={undervalued} onOpenStock={onOpenStock} />
        <RecoGroup title="초기 추세돌파" rows={breakout} onOpenStock={onOpenStock} />
      </div>
    );
  }

  if (category === 'theme') {
    if (themes.isLoading) return <LoadingState label="실제 테마 데이터를 불러오는 중입니다." />;
    if (themes.isError) return <ErrorState onRetry={() => { void themes.refetch(); }} />;
    const groups = themes.data?.themes ?? [];
    if (groups.length === 0) return <EmptyBox>현재 표시할 실제 테마 데이터가 없습니다.</EmptyBox>;
    return (
      <div className="space-y-4">
        {groups.map((group) => (
          <div key={group.key} className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <h3 className="text-sm font-black">{group.label}</h3>
              <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-black text-muted-foreground">{group.count}</span>
            </div>
            <div className="space-y-2">
              {group.stocks.map((stock) => (
                <StockRow key={`${group.key}:${stock.ticker}`} stock={stock as unknown as AnyObj} onClick={() => onOpenStock(stock.ticker)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // tradingValue / volume / gainers / losers
  if (movers.isLoading) return <LoadingState label="실제 순위 데이터를 불러오는 중입니다." />;
  if (movers.isError) return <ErrorState onRetry={() => { void movers.refetch(); }} />;
  const data = movers.data as unknown as AnyObj | undefined;
  const list = category === 'tradingValue'
    ? data?.popular
    : category === 'volume'
      ? data?.volume
      : category === 'gainers'
        ? data?.gainers
        : data?.losers;
  const rows = (list ?? []) as AnyObj[];
  if (rows.length === 0) return <EmptyBox>현재 표시할 실제 종목 데이터가 없습니다.</EmptyBox>;
  return (
    <div className="space-y-2">
      {rows
        .filter((row) => row.market === stockMarket)
        .map((stock, index) => (
          <StockRankRow key={`${stock.market}:${stock.ticker}`} rank={index + 1} stock={stock} onClick={() => onOpenStock(String(stock.ticker))} />
        ))}
    </div>
  );
}

function StockRankRow({ rank, stock, onClick }: { rank: number; stock: AnyObj; onClick: () => void }) {
  const change = Number(stock.changePercent);
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl border border-card-border bg-card p-3 text-left shadow-sm">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-sm font-black text-primary">{rank}</div>
      <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="truncate text-sm font-black">{displayStockName(String(stock.ticker), String(stock.name ?? ''), String(stock.market))}</p><span className="rounded-full bg-secondary px-2 py-0.5 text-[9px] font-black text-muted-foreground">{stock.market}</span></div><p className="mt-0.5 text-[11px] font-bold text-muted-foreground">{stock.ticker}</p></div>
      <div className="text-right"><p className="text-sm font-black">{formatAppPrice(stock.price, String(stock.currency))}</p><p className={cn('mt-0.5 text-[11px] font-black', change > 0 ? 'text-positive' : change < 0 ? 'text-destructive' : 'text-muted-foreground')}>{Number.isFinite(change) ? formatAppPercent(change) : '데이터 없음'}</p></div>
    </button>
  );
}

function RecoGroup({ title, rows, onOpenStock }: { title: string; rows: RecoRow[]; onOpenStock: (ticker: string) => void }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="px-1 text-sm font-black">{title}</h3>
      <div className="space-y-2">
        {rows.map((row) => (
          <button key={`${row.market}:${row.ticker}`} type="button" onClick={() => onOpenStock(row.ticker)} className="w-full rounded-2xl border border-card-border bg-card p-3 text-left shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2"><p className="truncate text-sm font-black">{displayStockName(row.ticker, row.name, row.market)}</p><span className="rounded-full bg-secondary px-2 py-0.5 text-[9px] font-black text-muted-foreground">{row.market}</span></div>
                <p className="mt-0.5 text-[11px] font-bold text-muted-foreground">{row.ticker} · 상승 가능성 {row.score}점</p>
              </div>
              <div className="shrink-0 text-right"><p className="text-sm font-black">{formatAppPrice(row.price, row.currency)}</p><p className={cn('mt-0.5 text-[11px] font-black', row.changePercent > 0 ? 'text-positive' : row.changePercent < 0 ? 'text-destructive' : 'text-muted-foreground')}>{formatAppPercent(row.changePercent)}</p></div>
            </div>
            {row.reasons.length > 0 && (
              <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] font-bold text-foreground/90">
                {row.reasons.slice(0, 3).map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── 코인 분류 결과 ──────────────────────────────────────────────
function CoinCategoryResults({
  category,
  coinCategorySupported,
  coinTickerQuery,
  sortedCoins,
  coinMarket,
  onOpenCoin,
}: {
  category: CategoryKey;
  coinCategorySupported: boolean;
  coinTickerQuery: ReturnType<typeof useQuery<AnyObj>>;
  sortedCoins: AnyObj[];
  coinMarket: 'spot' | 'futures';
  onOpenCoin: (symbol: string) => void;
}) {
  if (!coinCategorySupported) {
    // AI추천·테마종목은 코인 공급자가 없음
    return <EmptyBox>코인에는 해당 분류를 제공하지 않습니다 — 추천 엔진·테마 데이터가 주식 전용입니다.</EmptyBox>;
  }
  if (coinTickerQuery.isLoading) return <LoadingState label="실제 코인 시세를 불러오는 중입니다." />;
  if (coinTickerQuery.isError) return <ErrorState onRetry={() => { void coinTickerQuery.refetch(); }} />;
  if (sortedCoins.length === 0) return <EmptyBox>현재 표시할 실제 코인 데이터가 없습니다.</EmptyBox>;
  return (
    <div className="space-y-2">
      {sortedCoins.map((row, index) => (
        <CoinRankRow key={String(row.symbol)} rank={index + 1} row={row} coinMarket={coinMarket} onClick={() => onOpenCoin(String(row.symbol))} />
      ))}
    </div>
  );
}

function CoinRankRow({ rank, row, coinMarket, onClick }: { rank: number; row: AnyObj; coinMarket: 'spot' | 'futures'; onClick: () => void }) {
  const change = Number(row.changePercent ?? row.changePercent24h);
  const currency = coinMarket === 'spot' ? 'KRW' : 'USDT';
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl border border-card-border bg-card p-3 text-left shadow-sm">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-sm font-black text-primary">{rank}</div>
      <div className="min-w-0 flex-1"><p className="truncate text-sm font-black">{displayCoinName(String(row.symbol), row.koreanName, row.englishName)}</p><p className="mt-0.5 text-[11px] font-bold text-muted-foreground">{row.symbol} · {coinMarket === 'spot' ? 'UPBIT' : 'BITGET'}</p></div>
      <div className="text-right"><p className="text-sm font-black">{formatAppPrice(Number(row.price), currency)}</p><p className={cn('mt-0.5 text-[11px] font-black', change > 0 ? 'text-positive' : change < 0 ? 'text-destructive' : 'text-muted-foreground')}>{Number.isFinite(change) ? formatAppPercent(change) : '데이터 없음'}</p></div>
    </button>
  );
}
