import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BarChart3, ChevronRight, RefreshCw, Search } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { authorizedFetch } from '@/lib/auth-fetch';
import { useAssetMode } from '@/lib/asset-mode';
import {
  MARKET_INFORMATION_ROUTES,
  marketInformationDetailPath,
  marketInformationRoute,
  type MarketInformationRoute,
} from '@/lib/market-information';
import {
  displayCoinName,
  displayStockName,
  formatAppPercent,
  formatAppPrice,
} from '@/lib/stock-display';
import { cn } from '@/lib/utils';

type StockRow = {
  ticker: string;
  name?: string | null;
  market?: string | null;
  currency?: string | null;
  price?: number | null;
  changePercent?: number | null;
  volume?: number | null;
  tradingValue?: number | null;
  marketCap?: number | null;
};

type MoversResponse = {
  market?: string;
  provider?: string;
  popular?: StockRow[];
  volume?: StockRow[];
  gainers?: StockRow[];
  losers?: StockRow[];
  updatedAt?: string;
  error?: string;
};

type SearchResponse = {
  results?: StockRow[];
  count?: number;
  updatedAt?: string;
  error?: string;
};

type MarketIndex = {
  key?: string;
  label?: string;
  price?: number | null;
  value?: number | null;
  changePercent?: number | null;
  provider?: string;
  updatedAt?: string;
};

type MarketHomeResponse = {
  ok?: boolean;
  indices?: MarketIndex[];
  updatedAt?: string;
  message?: string;
};

type SectorRow = {
  sector?: string;
  name?: string;
  label?: string;
  tradingValue?: number | null;
  changePercent?: number | null;
  rows?: StockRow[];
  stocks?: StockRow[];
};

type SectorResponse = {
  sectors?: SectorRow[];
  updatedAt?: string;
  error?: string;
};

type FeedItem = {
  id?: string;
  kind?: 'news' | 'disclosure' | 'signal';
  title?: string;
  summary?: string;
  source?: string;
  sourceAt?: string | null;
  detectedAt?: string | null;
  ticker?: string;
  name?: string;
  market?: string;
  url?: string | null;
};

type FeedResponse = {
  ok?: boolean;
  items?: FeedItem[];
  count?: number;
  updatedAt?: string;
  message?: string;
};

type SpotMarket = {
  market?: string;
  symbol?: string;
  koreanName?: string;
  englishName?: string;
  warning?: boolean;
};

type SpotTicker = {
  market?: string;
  symbol?: string;
  price?: number | null;
  changePercent?: number | null;
  high24h?: number | null;
  low24h?: number | null;
  volume24h?: number | null;
  tradingValue24h?: number | null;
  timestamp?: number | null;
};

type SpotMarketsResponse = {
  exchange?: string;
  markets?: SpotMarket[];
  count?: number;
  updatedAt?: string;
};

type SpotTickersResponse = {
  exchange?: string;
  tickers?: SpotTicker[];
  count?: number;
  updatedAt?: string;
};

type FuturesTicker = {
  symbol?: string;
  price?: number | null;
  markPrice?: number | null;
  indexPrice?: number | null;
  changePercent?: number | null;
  changePercent24h?: number | null;
  high24h?: number | null;
  low24h?: number | null;
  volume24h?: number | null;
  tradingValue24h?: number | null;
  fundingRatePercent?: number | null;
  openInterest?: number | null;
  timestamp?: number | null;
};

type FuturesTickersResponse = {
  ok?: boolean;
  exchange?: string;
  provider?: string;
  tickers?: FuturesTicker[];
  count?: number;
  updatedAt?: string;
  message?: string;
};

type CoinRow = {
  symbol: string;
  name: string;
  price: number | null;
  changePercent: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24h: number | null;
  tradingValue24h: number | null;
  fundingRatePercent: number | null;
  openInterest: number | null;
  warning: boolean;
};

type RankingKey = 'marketCap' | 'tradingValue' | 'volume' | 'gainers' | 'losers';

class InformationRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await authorizedFetch(path, { cache: 'no-store', signal });
  const payload = await response.json().catch(() => null) as (T & { error?: string; message?: string }) | null;
  if (!response.ok) {
    throw new InformationRequestError(
      response.status,
      payload?.error ?? `HTTP_${response.status}`,
      payload?.message ?? `HTTP ${response.status}`,
    );
  }
  if (!payload) throw new InformationRequestError(502, 'INVALID_JSON', '응답 형식이 올바르지 않습니다.');
  return payload;
}

function normalizeSearch(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s._/\-]+/g, '');
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

function queryErrorLabel(error: unknown): string {
  if (error instanceof InformationRequestError) {
    if (error.status === 401) return '인증이 만료되었습니다. 다시 로그인해 주세요.';
    if (error.status === 403) return '이 시장 정보를 볼 권한이 없습니다.';
    if (error.status === 404) return '요청한 정보가 없습니다.';
    if (error.status === 429) return '요청이 많습니다. 잠시 후 다시 시도해 주세요.';
    if (error.status >= 500) return '데이터 공급자 오류입니다.';
  }
  if (/abort/i.test(String((error as Error | undefined)?.message ?? ''))) return '요청이 취소되었습니다.';
  return '정보를 불러오지 못했습니다.';
}

function freshnessLabel(value: unknown): string {
  const timestamp = Date.parse(String(value ?? ''));
  if (!Number.isFinite(timestamp)) return '기준시각 없음';
  const ageMs = Math.max(0, Date.now() - timestamp);
  if (ageMs <= 2 * 60_000) return '최신';
  if (ageMs <= 15 * 60_000) return '데이터 지연';
  return '오래된 데이터';
}

function formatNumber(value: unknown): string {
  const parsed = finite(value);
  return parsed == null ? '데이터 없음' : parsed.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
}

function marketTitle(route: MarketInformationRoute): string {
  if (route.id === 'stocks-kr') return '국내주식 정보';
  if (route.id === 'stocks-us') return '미국주식 정보';
  if (route.id === 'coins-spot') return '코인 현물 정보';
  return '코인 선물 정보';
}

export default function MarketInformationPage() {
  const [location, navigate] = useLocation();
  const mode = useAssetMode();
  const route = marketInformationRoute(location);
  const [searchText, setSearchText] = useState('');
  const [ranking, setRanking] = useState<RankingKey>('tradingValue');
  const debouncedSearch = useDebouncedValue(searchText.trim(), 200);

  useEffect(() => {
    if (!route) return;
    mode.setAsset(route.asset);
    if (route.asset === 'stock') mode.setStockMarket(route.market as 'KR' | 'US');
    else mode.setCoinMarket(route.market as 'spot' | 'futures');
    setSearchText('');
    setRanking('tradingValue');
    // route identity is the authority; mode setters only synchronize legacy consumers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route?.id]);

  const stockRoute = route?.asset === 'stock';
  const spotRoute = route?.id === 'coins-spot';
  const futuresRoute = route?.id === 'coins-futures';
  const stockMarket = stockRoute ? route.market : null;

  const marketHome = useQuery({
    queryKey: ['market-information', route?.id, 'market-home'],
    queryFn: ({ signal }) => getJson<MarketHomeResponse>('/api/market/home', signal),
    enabled: Boolean(stockRoute),
    staleTime: 30_000,
  });

  const movers = useQuery({
    queryKey: ['market-information', route?.id, 'movers'],
    queryFn: ({ signal }) => getJson<MoversResponse>(`/api/market/movers?market=${stockMarket}`, signal),
    enabled: Boolean(stockRoute && stockMarket),
    refetchInterval: 30_000,
  });

  const sectors = useQuery({
    queryKey: ['market-information', route?.id, 'sectors'],
    queryFn: ({ signal }) => getJson<SectorResponse>(`/api/market/sector-popular?market=${stockMarket}`, signal),
    enabled: Boolean(stockRoute && stockMarket),
    staleTime: 60_000,
  });

  const stockSearch = useQuery({
    queryKey: ['market-information', route?.id, 'search', debouncedSearch],
    queryFn: ({ signal }) => getJson<SearchResponse>(`/api/search?q=${encodeURIComponent(debouncedSearch)}`, signal),
    enabled: Boolean(stockRoute && debouncedSearch),
    staleTime: 30_000,
  });

  const feed = useQuery({
    queryKey: ['market-information', route?.id, 'feed'],
    queryFn: ({ signal }) => getJson<FeedResponse>(
      `/api/stocks/special-feed?asset=${route?.asset}&market=${route?.market}&limit=100`,
      signal,
    ),
    enabled: Boolean(route),
    refetchInterval: 60_000,
  });

  const spotMarkets = useQuery({
    queryKey: ['market-information', route?.id, 'spot-markets'],
    queryFn: ({ signal }) => getJson<SpotMarketsResponse>('/api/crypto/spot/markets', signal),
    enabled: spotRoute,
    staleTime: 10 * 60_000,
  });

  const spotTickers = useQuery({
    queryKey: ['market-information', route?.id, 'spot-tickers'],
    queryFn: ({ signal }) => getJson<SpotTickersResponse>('/api/crypto/spot/tickers', signal),
    enabled: spotRoute,
    refetchInterval: 15_000,
  });

  const futuresTickers = useQuery({
    queryKey: ['market-information', route?.id, 'futures-tickers'],
    queryFn: ({ signal }) => getJson<FuturesTickersResponse>('/api/crypto/futures/tickers', signal),
    enabled: futuresRoute,
    refetchInterval: 10_000,
  });

  const spotNameMap = useMemo(() => new Map(
    (spotMarkets.data?.markets ?? []).map((item) => [String(item.symbol ?? '').toUpperCase(), item]),
  ), [spotMarkets.data?.markets]);

  const coinRows = useMemo<CoinRow[]>(() => {
    if (spotRoute) {
      return (spotTickers.data?.tickers ?? []).flatMap((ticker) => {
        const symbol = String(ticker.symbol ?? '').toUpperCase();
        if (!symbol) return [];
        const master = spotNameMap.get(symbol);
        return [{
          symbol,
          name: displayCoinName(symbol, master?.koreanName, master?.englishName),
          price: finite(ticker.price),
          changePercent: finite(ticker.changePercent),
          high24h: finite(ticker.high24h),
          low24h: finite(ticker.low24h),
          volume24h: finite(ticker.volume24h),
          tradingValue24h: finite(ticker.tradingValue24h),
          fundingRatePercent: null,
          openInterest: null,
          warning: master?.warning === true,
        }];
      });
    }
    if (futuresRoute) {
      return (futuresTickers.data?.tickers ?? []).flatMap((ticker) => {
        const symbol = String(ticker.symbol ?? '').toUpperCase();
        if (!symbol) return [];
        return [{
          symbol,
          name: symbol,
          price: finite(ticker.price),
          changePercent: finite(ticker.changePercent24h ?? ticker.changePercent),
          high24h: finite(ticker.high24h),
          low24h: finite(ticker.low24h),
          volume24h: finite(ticker.volume24h),
          tradingValue24h: finite(ticker.tradingValue24h),
          fundingRatePercent: finite(ticker.fundingRatePercent),
          openInterest: finite(ticker.openInterest),
          warning: false,
        }];
      });
    }
    return [];
  }, [futuresRoute, futuresTickers.data?.tickers, spotNameMap, spotRoute, spotTickers.data?.tickers]);

  const stockSearchRows = useMemo(() => (stockSearch.data?.results ?? [])
    .filter((item) => item.market === stockMarket)
    .filter((item, index, rows) => rows.findIndex((candidate) => candidate.market === item.market && candidate.ticker === item.ticker) === index)
    .slice(0, 50), [stockMarket, stockSearch.data?.results]);

  const coinSearchRows = useMemo(() => {
    if (!debouncedSearch) return [];
    const needle = normalizeSearch(debouncedSearch);
    return coinRows.filter((row) => [row.symbol, row.name].some((value) => normalizeSearch(value).includes(needle))).slice(0, 50);
  }, [coinRows, debouncedSearch]);

  const stockRankingRows = useMemo(() => {
    const source = ranking === 'volume'
      ? movers.data?.volume
      : ranking === 'gainers'
        ? movers.data?.gainers
        : ranking === 'losers'
          ? movers.data?.losers
          : movers.data?.popular;
    const rows = [...(source ?? [])];
    if (ranking === 'marketCap') {
      return rows
        .filter((item) => finite(item.marketCap) != null)
        .sort((a, b) => Number(b.marketCap) - Number(a.marketCap));
    }
    return rows;
  }, [movers.data, ranking]);

  const coinRankingRows = useMemo(() => {
    const rows = [...coinRows];
    if (ranking === 'volume') rows.sort((a, b) => Number(b.volume24h ?? -1) - Number(a.volume24h ?? -1));
    else if (ranking === 'gainers') rows.sort((a, b) => Number(b.changePercent ?? -Infinity) - Number(a.changePercent ?? -Infinity));
    else if (ranking === 'losers') rows.sort((a, b) => Number(a.changePercent ?? Infinity) - Number(b.changePercent ?? Infinity));
    else rows.sort((a, b) => Number(b.tradingValue24h ?? -1) - Number(a.tradingValue24h ?? -1));
    return rows.slice(0, 100);
  }, [coinRows, ranking]);

  if (!route) {
    return <StateCard tone="error">지원하지 않는 정보 화면입니다.</StateCard>;
  }

  const searchLoading = stockRoute ? stockSearch.isLoading : spotRoute ? spotTickers.isLoading || spotMarkets.isLoading : futuresTickers.isLoading;
  const searchError = stockRoute ? stockSearch.error : spotRoute ? spotTickers.error ?? spotMarkets.error : futuresTickers.error;
  const rankingLoading = stockRoute ? movers.isLoading : spotRoute ? spotTickers.isLoading : futuresTickers.isLoading;
  const rankingError = stockRoute ? movers.error : spotRoute ? spotTickers.error : futuresTickers.error;
  const updatedAt = stockRoute
    ? movers.data?.updatedAt
    : spotRoute
      ? spotTickers.data?.updatedAt
      : futuresTickers.data?.updatedAt;

  const openSymbol = (symbol: string) => navigate(marketInformationDetailPath(route, symbol));

  return (
    <div data-testid="market-information-root" data-market-information={route.id} className="h-full overflow-y-auto overscroll-contain bg-background">
      <header className="border-b border-card-border px-4 pb-4 pt-4">
        <h1 className="text-center text-xl font-black">{marketTitle(route)}</h1>
        <p className="mt-1 text-center text-xs font-bold text-muted-foreground">
          {route.exchange} · {route.currency} · {freshnessLabel(updatedAt)}
        </p>
        <label className="mt-4 flex min-h-11 items-center gap-2 rounded-2xl border border-card-border bg-card px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder={stockRoute ? '종목명·티커·종목코드 검색' : '코인명·심볼 검색'}
            aria-label={`${marketTitle(route)} 검색`}
            className="min-w-0 flex-1 bg-transparent text-sm font-bold outline-none"
          />
        </label>
      </header>

      <main className="space-y-4 px-4 pb-28 pt-4">
        {debouncedSearch ? (
          <InformationSection title="검색 결과" subtitle={stockRoute ? '현재 시장 결과만 표시' : `${route.exchange} 지원 상품만 표시`}>
            {searchLoading && <StateCard>불러오는 중</StateCard>}
            {searchError && <StateCard tone="error">{queryErrorLabel(searchError)}</StateCard>}
            {!searchLoading && !searchError && stockRoute && stockSearchRows.length === 0 && <StateCard>검색 결과가 없습니다.</StateCard>}
            {!searchLoading && !searchError && !stockRoute && coinSearchRows.length === 0 && <StateCard>검색 결과가 없습니다.</StateCard>}
            <div className="space-y-2">
              {stockRoute && stockSearchRows.map((row) => (
                <StockInformationRow key={`${row.market}:${row.ticker}`} row={row} route={route} onOpen={() => openSymbol(row.ticker)} />
              ))}
              {!stockRoute && coinSearchRows.map((row) => (
                <CoinInformationRow key={row.symbol} row={row} route={route} onOpen={() => openSymbol(row.symbol)} />
              ))}
            </div>
            {stockRoute && <p className="mt-3 text-[10px] font-bold text-muted-foreground">초성·별칭·ETF 통합 인덱스 고도화는 PR #58 검색 계약을 재사용하며 이 화면에서 중복 구현하지 않습니다.</p>}
          </InformationSection>
        ) : null}

        {stockRoute ? (
          <InformationSection title="시장 상태·지수" subtitle="공개 시장 데이터">
            {marketHome.isLoading && <StateCard>지수 정보를 불러오는 중입니다.</StateCard>}
            {marketHome.isError && <RetryState error={marketHome.error} onRetry={() => { void marketHome.refetch(); }} />}
            {!marketHome.isLoading && !marketHome.isError && (marketHome.data?.indices ?? []).filter((index) => {
              const key = String(index.key ?? '').toUpperCase();
              return route.market === 'KR' ? key === 'KOSPI' || key === 'KOSDAQ' : key === 'NASDAQ';
            }).length === 0 && <StateCard>일부 데이터만 제공되거나 해당 지수 데이터가 없습니다.</StateCard>}
            <div className="grid grid-cols-2 gap-2">
              {(marketHome.data?.indices ?? []).filter((index) => {
                const key = String(index.key ?? '').toUpperCase();
                return route.market === 'KR' ? key === 'KOSPI' || key === 'KOSDAQ' : key === 'NASDAQ';
              }).map((index) => (
                <MetricCard
                  key={String(index.key)}
                  label={String(index.label ?? index.key ?? '지수')}
                  value={formatNumber(index.price ?? index.value)}
                  subvalue={finite(index.changePercent) == null ? '등락률 없음' : formatAppPercent(Number(index.changePercent))}
                />
              ))}
            </div>
          </InformationSection>
        ) : null}

        <InformationSection title="시장 순위" subtitle={updatedAt ? `기준 ${new Date(updatedAt).toLocaleString('ko-KR')}` : '기준시각 없음'}>
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {(stockRoute
              ? [
                  ['marketCap', '시가총액'],
                  ['tradingValue', '거래대금'],
                  ['volume', '거래량'],
                  ['gainers', '급등'],
                  ['losers', '급락'],
                ]
              : [
                  ['tradingValue', '거래대금'],
                  ['volume', '거래량'],
                  ['gainers', '상승'],
                  ['losers', '하락'],
                ]).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setRanking(key as RankingKey)}
                className={cn(
                  'min-h-11 rounded-xl border px-2 text-xs font-black',
                  ranking === key ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-background text-muted-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {rankingLoading && <StateCard>순위 데이터를 불러오는 중입니다.</StateCard>}
          {rankingError && <RetryState error={rankingError} onRetry={() => { if (stockRoute) void movers.refetch(); else if (spotRoute) void spotTickers.refetch(); else void futuresTickers.refetch(); }} />}
          {!rankingLoading && !rankingError && stockRoute && stockRankingRows.length === 0 && <StateCard>{ranking === 'marketCap' ? '시가총액은 현재 제공기관에서 지원하지 않거나 일부 데이터만 제공합니다.' : '순위 데이터가 없습니다.'}</StateCard>}
          {!rankingLoading && !rankingError && !stockRoute && coinRankingRows.length === 0 && <StateCard>순위 데이터가 없습니다.</StateCard>}
          <div className="space-y-2">
            {stockRoute && stockRankingRows.slice(0, 30).map((row) => (
              <StockInformationRow key={`${ranking}:${row.market}:${row.ticker}`} row={row} route={route} onOpen={() => openSymbol(row.ticker)} />
            ))}
            {!stockRoute && coinRankingRows.slice(0, 30).map((row) => (
              <CoinInformationRow key={`${ranking}:${row.symbol}`} row={row} route={route} onOpen={() => openSymbol(row.symbol)} />
            ))}
          </div>
        </InformationSection>

        {stockRoute ? (
          <InformationSection title="업종·섹터" subtitle="거래대금 기반 공개 데이터">
            {sectors.isLoading && <StateCard>업종 데이터를 불러오는 중입니다.</StateCard>}
            {sectors.isError && <RetryState error={sectors.error} onRetry={() => { void sectors.refetch(); }} />}
            {!sectors.isLoading && !sectors.isError && (sectors.data?.sectors ?? []).length === 0 && <StateCard>업종 데이터가 없습니다.</StateCard>}
            <div className="grid grid-cols-2 gap-2">
              {(sectors.data?.sectors ?? []).slice(0, 12).map((sector, index) => (
                <MetricCard
                  key={`${sector.sector ?? sector.name ?? index}`}
                  label={String(sector.label ?? sector.name ?? sector.sector ?? '업종')}
                  value={finite(sector.tradingValue) == null ? '일부 데이터만 제공' : formatNumber(sector.tradingValue)}
                  subvalue={finite(sector.changePercent) == null ? '등락률 없음' : formatAppPercent(Number(sector.changePercent))}
                />
              ))}
            </div>
          </InformationSection>
        ) : null}

        {futuresRoute ? (
          <InformationSection title="선물 공개 시장정보" subtitle="계좌·주문·포지션 private API 미사용">
            <div className="grid grid-cols-2 gap-2">
              <MetricCard label="펀딩비" value="종목별 순위에서 제공" />
              <MetricCard label="미결제약정(OI)" value="종목별 순위에서 제공" />
              <MetricCard label="롱·숏 비율" value="제공기관 미지원" />
              <MetricCard label="청산 공개정보" value="제공기관 미지원" />
            </div>
          </InformationSection>
        ) : null}

        <InformationSection title={stockRoute ? '뉴스·공시' : '시장 뉴스·정보'} subtitle={feed.data?.updatedAt ? `기준 ${new Date(feed.data.updatedAt).toLocaleString('ko-KR')}` : '기준시각 없음'}>
          {feed.isLoading && <StateCard>정보를 불러오는 중입니다.</StateCard>}
          {feed.isError && <RetryState error={feed.error} onRetry={() => { void feed.refetch(); }} />}
          {!feed.isLoading && !feed.isError && (feed.data?.items ?? []).length === 0 && (
            <StateCard>{feed.data?.message ?? (stockRoute ? '뉴스·공시 데이터가 없습니다.' : '코인 뉴스·정보 제공기관이 아직 연결되지 않았습니다.')}</StateCard>
          )}
          <div className="space-y-2">
            {(feed.data?.items ?? []).filter((item) => item.kind === 'news' || item.kind === 'disclosure').slice(0, 20).map((item, index) => (
              <article key={item.id ?? `${item.title}:${index}`} className="rounded-2xl border border-card-border bg-background p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded-full bg-secondary px-2 py-1 text-[10px] font-black">{item.kind === 'disclosure' ? '공시' : '뉴스'}</span>
                  <span className="text-[10px] font-bold text-muted-foreground">{item.source ?? '출처 없음'} · {item.sourceAt ? new Date(item.sourceAt).toLocaleString('ko-KR') : '발행시각 없음'}</span>
                </div>
                <p className="mt-2 break-words text-sm font-black">{item.title ?? '제목 없음'}</p>
                {item.summary ? <p className="mt-1 break-words text-xs font-medium text-muted-foreground">{item.summary}</p> : null}
              </article>
            ))}
          </div>
        </InformationSection>
      </main>
      <BottomNav />
    </div>
  );
}

function InformationSection({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-black">{title}</h2>
          {subtitle ? <p className="mt-1 text-[10px] font-bold text-muted-foreground">{subtitle}</p> : null}
        </div>
        <BarChart3 className="h-4 w-4 shrink-0 text-primary" />
      </div>
      {children}
    </section>
  );
}

function StateCard({ children, tone }: { children: ReactNode; tone?: 'error' }) {
  return (
    <div className={cn(
      'rounded-2xl bg-secondary p-4 text-center text-xs font-bold text-muted-foreground',
      tone === 'error' && 'bg-destructive/10 text-destructive',
    )}>
      {children}
    </div>
  );
}

function RetryState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="space-y-2">
      <StateCard tone="error"><AlertTriangle className="mx-auto mb-2 h-4 w-4" />{queryErrorLabel(error)}</StateCard>
      <button type="button" onClick={onRetry} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-card-border bg-background px-4 text-xs font-black">
        <RefreshCw className="h-4 w-4" /> 다시 불러오기
      </button>
    </div>
  );
}

function MetricCard({ label, value, subvalue }: { label: string; value: string; subvalue?: string }) {
  return (
    <div className="rounded-2xl bg-secondary p-3 text-center">
      <p className="text-[10px] font-black text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-sm font-black">{value}</p>
      {subvalue ? <p className="mt-1 text-[10px] font-bold text-muted-foreground">{subvalue}</p> : null}
    </div>
  );
}

function StockInformationRow({ row, route, onOpen }: { row: StockRow; route: MarketInformationRoute; onOpen: () => void }) {
  const price = finite(row.price);
  const change = finite(row.changePercent);
  const metric = route.asset === 'stock' && finite(row.marketCap) != null
    ? `시총 ${formatAppPrice(Number(row.marketCap), route.currency)}`
    : finite(row.tradingValue) != null
      ? `거래대금 ${formatAppPrice(Number(row.tradingValue), route.currency)}`
      : finite(row.volume) != null
        ? `거래량 ${formatNumber(row.volume)}`
        : '일부 데이터만 제공';
  return (
    <button type="button" onClick={onOpen} className="flex min-h-14 w-full items-center gap-3 rounded-2xl border border-card-border bg-background p-3 text-left">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-black">{displayStockName(row.ticker, row.name ?? row.ticker, route.market)}</p>
          <span className="rounded-full bg-secondary px-2 py-0.5 text-[9px] font-black text-muted-foreground">{route.exchange}</span>
        </div>
        <p className="mt-1 text-[10px] font-bold text-muted-foreground">{row.ticker} · {metric}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-black">{price == null ? '데이터 없음' : formatAppPrice(price, route.currency)}</p>
        <p className={cn('mt-1 text-[10px] font-black', change == null ? 'text-muted-foreground' : change >= 0 ? 'text-positive' : 'text-destructive')}>{change == null ? '등락률 없음' : formatAppPercent(change)}</p>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function CoinInformationRow({ row, route, onOpen }: { row: CoinRow; route: MarketInformationRoute; onOpen: () => void }) {
  const rangePercent = row.high24h != null && row.low24h != null && row.low24h > 0
    ? ((row.high24h - row.low24h) / row.low24h) * 100
    : null;
  return (
    <button type="button" onClick={onOpen} className="w-full rounded-2xl border border-card-border bg-background p-3 text-left">
      <div className="flex min-h-11 items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-black">{row.name}</p>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[9px] font-black text-muted-foreground">{route.exchange}</span>
            {row.warning ? <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[9px] font-black text-warning">주의</span> : null}
          </div>
          <p className="mt-1 text-[10px] font-bold text-muted-foreground">{row.symbol} · 거래대금 {row.tradingValue24h == null ? '데이터 없음' : formatAppPrice(row.tradingValue24h, route.currency)}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-black">{row.price == null ? '데이터 없음' : formatAppPrice(row.price, route.currency)}</p>
          <p className={cn('mt-1 text-[10px] font-black', row.changePercent == null ? 'text-muted-foreground' : row.changePercent >= 0 ? 'text-positive' : 'text-destructive')}>{row.changePercent == null ? '등락률 없음' : formatAppPercent(row.changePercent)}</p>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>
      {route.id === 'coins-futures' ? (
        <div className="mt-2 grid grid-cols-3 gap-2 border-t border-card-border pt-2 text-center text-[10px] font-bold text-muted-foreground">
          <span>펀딩 {row.fundingRatePercent == null ? '미지원' : `${formatNumber(row.fundingRatePercent)}%`}</span>
          <span>OI {formatNumber(row.openInterest)}</span>
          <span>변동성 {rangePercent == null ? '데이터 없음' : `${rangePercent.toFixed(2)}%`}</span>
        </div>
      ) : null}
    </button>
  );
}

export { MARKET_INFORMATION_ROUTES };
