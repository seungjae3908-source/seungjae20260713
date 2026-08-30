import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, BarChart3, ExternalLink, Newspaper, RefreshCw } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { CenteredPageHeader } from '@/components/centered-page-header';
import { ResponsiveTabs } from '@/components/responsive-tabs';
import { apiGet } from '@/lib/api';
import { useAnalysisSelection, type AnalysisSelection } from '@/lib/analysis-selection';
import { displayStockName } from '@/lib/stock-display';
import { formatPrice } from '@/lib/format';
import { quoteFreshness } from '@/lib/market-freshness';
import { UNIFIED_CHART_TIMEFRAMES } from '@/lib/unified-chart-data';

const AiChartPage = lazy(() => import('@/pages/ai-chart'));
const StockDetailAnalysisPanel = lazy(() => import('@/components/stock-detail-analysis-panel'));

type AnyObj = Record<string, any>;
type DetailTab = 'summary' | 'chart' | 'news' | 'analysis';

const DETAIL_TABS = [
  { value: 'summary', label: '요약' },
  { value: 'chart', label: 'AI 차트' },
  { value: 'news', label: '뉴스' },
  { value: 'analysis', label: '상세분석' },
] as const;
const CHART_TIMEFRAMES = new Set(UNIFIED_CHART_TIMEFRAMES.map((item) => item.key));

function queryState() {
  const params = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const ticker = String(params.get('ticker') ?? params.get('symbol') ?? '').trim().toUpperCase();
  const market = params.get('market') === 'US' ? 'US' : 'KR';
  const requested = params.get('tab');
  const tab: DetailTab = requested === 'chart' || requested === 'news' || requested === 'analysis' ? requested : 'summary';
  return { params, ticker, market, tab } as const;
}

function validStockContext(ticker: string, market: 'KR' | 'US'): boolean {
  if (market === 'KR') return /^\d{6}$/.test(ticker);
  return /^[A-Z0-9^][A-Z0-9.^-]{0,29}$/.test(ticker);
}

function pageTimeframe(params: URLSearchParams): string {
  const requested = String(params.get('timeframe') ?? '').trim();
  return CHART_TIMEFRAMES.has(requested as never) ? requested : '5m';
}

function samePageChartContext(selection: AnalysisSelection | null, expected: AnalysisSelection): boolean {
  return Boolean(
    selection
    && selection.assetType === expected.assetType
    && selection.market === expected.market
    && selection.ticker === expected.ticker
    && selection.symbol === expected.symbol
    && selection.timeframe === expected.timeframe,
  );
}

function finite(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value.trim()))) continue;
    const number = typeof value === 'string' ? Number(value.replace(/,/g, '')) : value;
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function text(...values: unknown[]) {
  for (const value of values) {
    const result = String(value ?? '').trim();
    if (result) return result;
  }
  return null;
}

function compactNumber(value: unknown, suffix = '') {
  const number = finite(value);
  if (number == null) return '-';
  return `${new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 2 }).format(number)}${suffix}`;
}

function LoadingStatus({ label = '확인 중' }: { label?: string }) {
  return (
    <div
      role="status"
      data-testid="stock-detail-loading-status"
      className="mx-auto flex min-h-16 w-full max-w-5xl items-center justify-center rounded-2xl border border-card-border bg-card px-4 text-xs font-black text-muted-foreground"
    >
      {label}
    </div>
  );
}

export default function DetailPage() {
  const [location, navigate] = useLocation();
  const analysisSelection = useAnalysisSelection();
  const initial = useMemo(queryState, [location]);
  const [tab, setTabState] = useState<DetailTab>(initial.tab);
  const ticker = initial.ticker;
  const market = initial.market;

  useEffect(() => {
    setTabState(queryState().tab);
  }, [location]);

  const quote = useQuery({
    queryKey: ['clean-stock-detail-quote', market, ticker],
    queryFn: () => apiGet<AnyObj>(`/stocks/${encodeURIComponent(ticker)}/quote`),
    enabled: Boolean(ticker) && tab === 'summary',
    staleTime: 30_000,
    gcTime: 10 * 60_000,
  });
  const profile = useQuery({
    queryKey: ['clean-stock-detail-profile', market, ticker],
    queryFn: () => apiGet<AnyObj>(`/stocks/${encodeURIComponent(ticker)}/profile`),
    enabled: Boolean(ticker) && tab === 'summary',
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });
  const news = useQuery({
    queryKey: ['clean-stock-detail-news', market, ticker],
    queryFn: () => apiGet<AnyObj>(`/stocks/${encodeURIComponent(ticker)}/news?all=1`),
    enabled: Boolean(ticker) && tab === 'news',
    staleTime: 60_000,
    gcTime: 15 * 60_000,
  });

  const setTab = (next: DetailTab) => {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', next);
    navigate(`${url.pathname}${url.search}`, { replace: true });
    setTabState(next);
  };

  const leaveDetail = () => {
    const back = initial.params.get('back')?.trim() || '/stocks';
    navigate(back.startsWith('/') && !back.startsWith('//') ? back : '/stocks');
  };

  const expectedCurrency = market === 'KR' ? 'KRW' : 'USD';
  const sameIdentity = (row: Record<string, unknown>) => String(row.ticker ?? row.symbol ?? '').toUpperCase() === ticker
    && (row.currency == null || row.currency === expectedCurrency)
    && (row.market == null || row.market === market);
  const identityError = Boolean(quote.data && !sameIdentity(quote.data));
  const quoteData = quote.data && sameIdentity(quote.data) ? quote.data : {};
  const profileData = profile.data && sameIdentity(profile.data) ? profile.data : {};
  const routeName = text(initial.params.get('name'));
  const name = displayStockName(ticker, text(quoteData.name, profileData.name, profileData.companyName, routeName, ticker) ?? ticker, market);
  const currency = text(quoteData.currency) ?? (market === 'KR' ? 'KRW' : 'USD');
  const priceValue = finite(quoteData.price, quoteData.currentPrice, quoteData.close, quoteData.last);
  const price = priceValue !== null && priceValue > 0 ? priceValue : null;
  const changePercent = finite(quoteData.changePercent, quoteData.change_rate, quoteData.percentChange, quoteData.changePct);
  const exchange = text(quoteData.exchange, profileData.exchange, market === 'KR' ? 'KR 시장' : '미국 시장') ?? '-';
  const sector = text(profileData.sector, profileData.industry, profileData.category) ?? '-';
  const marketCap = compactNumber(profileData.marketCap ?? quoteData.marketCap, currency === 'KRW' ? '원' : ` ${currency}`);
  const newsRows = ((news.data?.news ?? news.data?.items ?? []) as AnyObj[]).slice(0, 40);
  const summaryLoading = (quote.isLoading || profile.isLoading) && !quote.data && !profile.data;
  // The legacy stock route also uses updatedAt for retrieval time. Only an
  // explicit source-time evidence payload can describe quote freshness here.
  const freshness = quoteFreshness(quoteData.freshness ? quoteData : {});
  const routeContextValid = validStockContext(ticker, market);
  const canonicalChartSelection = useMemo<AnalysisSelection>(() => ({
    assetType: 'stock',
    market,
    symbol: ticker,
    ticker,
    displayName: name || ticker,
    timeframe: pageTimeframe(initial.params),
    selectedAt: new Date().toISOString(),
  }), [initial.params, market, name, ticker]);
  const chartContextReady = routeContextValid && samePageChartContext(analysisSelection.selection, canonicalChartSelection);

  useEffect(() => {
    if (!routeContextValid || samePageChartContext(analysisSelection.selection, canonicalChartSelection)) return;
    analysisSelection.select(canonicalChartSelection);
  }, [analysisSelection.select, analysisSelection.selection, canonicalChartSelection, routeContextValid]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background" data-testid="canonical-stock-analysis" data-ticker={ticker}>
      <CenteredPageHeader
        title={name || ticker || '종목 상세'}
        eyebrow={market === 'KR' ? '국내주식' : '미국주식'}
        leading={(
          <button type="button" onClick={leaveDetail} aria-label="종목 목록으로 돌아가기" className="flex h-11 w-11 items-center justify-center rounded-xl border border-card-border bg-card">
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}
      />
      <div className="shrink-0 border-b border-card-border bg-background px-2 py-2 sm:px-3">
        <ResponsiveTabs value={tab} options={DETAIL_TABS} onChange={setTab} ariaLabel="종목 상세 탭" testId="stock-detail-tabs" compact />
      </div>

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-28 pt-4 sm:px-4">
        {tab === 'summary' ? (
          <div className="mx-auto w-full max-w-5xl space-y-3 sm:space-y-4" data-testid="stock-detail-summary">
            {quote.isError ? (
              <section className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm" role="alert">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <p className="font-black text-destructive">현재가 확인 실패</p>
                  <button type="button" onClick={() => void quote.refetch()} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border border-destructive/30 px-3 font-black"><RefreshCw className="h-4 w-4" />재시도</button>
                </div>
              </section>
            ) : null}
            {identityError ? <p role="alert" className="text-sm text-destructive">응답의 종목·시장·통화가 현재 선택과 일치하지 않아 시세를 표시하지 않습니다.</p> : null}

            <section className="rounded-3xl border border-card-border bg-card p-4 sm:p-5">
              <div className="text-center">
                <p className="text-sm font-bold text-muted-foreground">{ticker}</p>
                <p className="mt-2 break-all text-3xl font-black tabular-nums">
                  {price == null ? (summaryLoading ? '확인 중' : '미확인') : formatPrice(price, currency)}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">{freshness.label}</p>
                <p className={`mt-2 text-sm font-black ${changePercent == null ? 'text-muted-foreground' : changePercent >= 0 ? 'text-emerald-500' : 'text-destructive'}`}>
                  {changePercent == null ? (summaryLoading ? '등락 확인 중' : '등락 미확인') : `${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%`}
                </p>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2 sm:mt-5 sm:grid-cols-4">
                <div className="min-w-0 rounded-2xl bg-background p-3"><p className="text-[11px] font-bold text-muted-foreground">시장</p><p className="mt-1 truncate text-sm font-black">{exchange}</p></div>
                <div className="min-w-0 rounded-2xl bg-background p-3"><p className="text-[11px] font-bold text-muted-foreground">업종</p><p className="mt-1 truncate text-sm font-black">{profile.isLoading && sector === '-' ? '확인 중' : sector}</p></div>
                <div className="min-w-0 rounded-2xl bg-background p-3"><p className="text-[11px] font-bold text-muted-foreground">시가총액</p><p className="mt-1 truncate text-sm font-black">{profile.isLoading && marketCap === '-' ? '확인 중' : marketCap}</p></div>
                <div className="min-w-0 rounded-2xl bg-background p-3"><p className="text-[11px] font-bold text-muted-foreground">상태</p><p className="mt-1 text-sm font-black">{quote.isError || identityError ? '오류' : summaryLoading ? '확인 중' : price == null ? '부분' : '시세 있음'}</p></div>
              </div>
            </section>

            <section className="grid grid-cols-3 gap-2" aria-label="종목 상세 빠른 실행">
              <button type="button" onClick={() => setTab('chart')} className="flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-2xl bg-primary px-2 text-xs font-black text-primary-foreground"><BarChart3 className="h-5 w-5" /><span className="truncate">AI 차트</span></button>
              <button type="button" onClick={() => setTab('news')} className="flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-2xl border border-card-border bg-card px-2 text-xs font-black"><Newspaper className="h-5 w-5 text-primary" /><span className="truncate">뉴스</span></button>
              <button type="button" onClick={() => setTab('analysis')} className="flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-2xl border border-card-border bg-card px-2 text-xs font-black"><ExternalLink className="h-5 w-5 text-primary" /><span className="truncate">상세분석</span></button>
            </section>
          </div>
        ) : null}

        {tab === 'chart' ? (
          <div className="mx-auto h-full min-h-[520px] w-full max-w-7xl overflow-hidden rounded-3xl border border-card-border bg-card sm:min-h-[560px]" data-testid="canonical-rich-detail-chart" data-context-ticker={ticker} data-context-market={market}>
            {!routeContextValid ? (
              <div role="alert" data-testid="ai-chart-context-missing" className="flex min-h-[240px] items-center justify-center p-6 text-center text-sm font-black text-destructive">현재 종목 정보가 올바르지 않아 차트를 표시하지 않습니다.</div>
            ) : !chartContextReady ? (
              <div role="status" data-testid="ai-chart-context-syncing" className="flex min-h-[240px] items-center justify-center p-6 text-center text-sm font-black text-muted-foreground">현재 종목과 차트 정보를 다시 동기화하고 있습니다.</div>
            ) : (
              <Suspense fallback={<LoadingStatus label="차트 준비 중" />}><AiChartPage embedded /></Suspense>
            )}
          </div>
        ) : null}

        {tab === 'news' ? (
          <div className="mx-auto w-full max-w-4xl space-y-3" data-testid="stock-detail-news">
            {news.isLoading ? <LoadingStatus label="뉴스 확인 중" /> : null}
            {news.isError ? (
              <section className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm" role="alert">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <p className="font-black text-destructive">뉴스 확인 실패</p>
                  <button type="button" onClick={() => void news.refetch()} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border border-destructive/30 px-3 font-black"><RefreshCw className="h-4 w-4" />재시도</button>
                </div>
              </section>
            ) : null}
            {!news.isLoading && !news.isError && newsRows.length === 0 ? <section className="rounded-2xl border border-card-border bg-card p-6 text-center text-sm font-bold text-muted-foreground">최신 뉴스 없음</section> : null}
            {newsRows.map((item, index) => {
              const title = text(item.title, item.headline) ?? '제목 미확인';
              const summary = text(item.summary, item.description, item.content);
              const source = text(item.source, item.publisher) ?? '출처 미확인';
              const published = text(item.publishedAt, item.published_at, item.date, item.datetime);
              const candidateUrl = text(item.url, item.link);
              const url = candidateUrl && /^https?:\/\//i.test(candidateUrl) ? candidateUrl : null;
              const content = (
                <>
                  <h2 className="break-keep text-sm font-black leading-6">{title}</h2>
                  {summary ? <p className="mt-2 line-clamp-2 break-keep text-xs leading-5 text-muted-foreground">{summary}</p> : null}
                  <p className="mt-2 truncate text-[11px] font-bold text-muted-foreground">{source}{published ? ` · ${published}` : ''}</p>
                </>
              );
              return url ? <a key={`${url}:${index}`} href={url} target="_blank" rel="noreferrer" className="block rounded-2xl border border-card-border bg-card p-4 transition hover:border-primary/40">{content}</a> : <article key={`${title}:${index}`} className="rounded-2xl border border-card-border bg-card p-4">{content}</article>;
            })}
          </div>
        ) : null}

        {tab === 'analysis' ? (
          <div className="mx-auto min-h-full w-full max-w-7xl" data-testid="rich-detail-shell" data-ticker={ticker}>
            <Suspense fallback={<LoadingStatus label="상세 준비 중" />}>
              <StockDetailAnalysisPanel ticker={ticker} market={market} />
            </Suspense>
          </div>
        ) : null}
      </main>
      <BottomNav />
    </div>
  );
}
