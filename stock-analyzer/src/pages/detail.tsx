import { lazy, Suspense, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, BarChart3, ExternalLink, Newspaper, RefreshCw } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { CenteredPageHeader } from '@/components/centered-page-header';
import { ResponsiveTabs } from '@/components/responsive-tabs';
import { apiGet } from '@/lib/api';
import { displayStockName, formatAppPrice } from '@/lib/stock-display';

const AiChartPage = lazy(() => import('@/pages/ai-chart'));
const LegacyDetailPage = lazy(() => import('@/pages/detail-legacy'));

type AnyObj = Record<string, any>;
type DetailTab = 'summary' | 'chart' | 'news' | 'analysis';

const DETAIL_TABS = [
  { value: 'summary', label: '요약' },
  { value: 'chart', label: 'AI 차트' },
  { value: 'news', label: '뉴스' },
  { value: 'analysis', label: '상세분석' },
] as const;

function queryState() {
  const params = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const ticker = String(params.get('ticker') ?? params.get('symbol') ?? '').trim().toUpperCase();
  const market = params.get('market') === 'US' ? 'US' : 'KR';
  const requested = params.get('tab');
  const tab: DetailTab = requested === 'chart' || requested === 'news' || requested === 'analysis' ? requested : 'summary';
  return { params, ticker, market, tab } as const;
}

function finite(...values: unknown[]) {
  for (const value of values) {
    const number = Number(value);
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

function LoadingSurface() {
  return <div aria-busy="true" className="mx-auto h-56 w-full max-w-5xl animate-pulse rounded-3xl border border-card-border bg-card/60" />;
}

export default function DetailPage() {
  const [location, navigate] = useLocation();
  const initial = useMemo(queryState, [location]);
  const [tab, setTabState] = useState<DetailTab>(initial.tab);
  const ticker = initial.ticker;
  const market = initial.market;

  useEffect(() => {
    setTabState(queryState().tab);
  }, [location]);

  const quote = useQuery({
    queryKey: ['clean-stock-detail-quote', ticker],
    queryFn: () => apiGet<AnyObj>(`/stocks/${encodeURIComponent(ticker)}/quote`),
    enabled: Boolean(ticker) && tab === 'summary',
    staleTime: 30_000,
    gcTime: 10 * 60_000,
  });
  const profile = useQuery({
    queryKey: ['clean-stock-detail-profile', ticker],
    queryFn: () => apiGet<AnyObj>(`/stocks/${encodeURIComponent(ticker)}/profile`),
    enabled: Boolean(ticker) && tab === 'summary',
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });
  const news = useQuery({
    queryKey: ['clean-stock-detail-news', ticker],
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
    navigate(back);
  };

  function openCanonicalChart(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement | null;
    const button = target?.closest('button');
    if (!button || button.textContent?.trim() !== '차트') return;
    event.preventDefault();
    event.stopPropagation();
    setTab('chart');
  }

  if (tab === 'analysis') {
    return (
      <div className="h-full min-h-0" onClickCapture={openCanonicalChart} data-testid="rich-detail-shell" data-ticker={ticker}>
        <Suspense fallback={<LoadingSurface />}><LegacyDetailPage /></Suspense>
      </div>
    );
  }

  const quoteData = quote.data ?? {};
  const profileData = profile.data ?? {};
  const name = displayStockName(ticker, text(quoteData.name, profileData.name, profileData.companyName, ticker) ?? ticker, market);
  const currency = text(quoteData.currency) ?? (market === 'KR' ? 'KRW' : 'USD');
  const price = finite(quoteData.price, quoteData.currentPrice, quoteData.close, quoteData.last);
  const changePercent = finite(quoteData.changePercent, quoteData.change_rate, quoteData.percentChange, quoteData.changePct);
  const exchange = text(quoteData.exchange, profileData.exchange, market === 'KR' ? 'KR 시장' : '미국 시장') ?? '-';
  const sector = text(profileData.sector, profileData.industry, profileData.category) ?? '-';
  const marketCap = compactNumber(profileData.marketCap ?? quoteData.marketCap, currency === 'KRW' ? '원' : ` ${currency}`);
  const newsRows = ((news.data?.news ?? news.data?.items ?? []) as AnyObj[]).slice(0, 40);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background" data-testid="canonical-stock-analysis" data-ticker={ticker}>
      <CenteredPageHeader
        title={name || ticker || '종목 상세'}
        eyebrow={market === 'KR' ? '국내주식' : '미국주식'}
        leading={(
          <button type="button" onClick={leaveDetail} aria-label="종목 목록으로 돌아가기" className="flex h-11 w-11 items-center justify-center rounded-xl border border-card-border bg-card">
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}
        infoTitle="종목 상세 안내"
        infoItems={[
          '요약 데이터부터 먼저 불러오고 AI 차트·뉴스·상세분석은 선택한 탭에서만 불러옵니다.',
          '값이 확인되지 않은 항목은 0으로 만들지 않고 미확인으로 표시합니다.',
        ]}
      />
      <div className="shrink-0 border-b border-card-border bg-background px-2 py-2 sm:px-3">
        <ResponsiveTabs value={tab} options={DETAIL_TABS} onChange={setTab} ariaLabel="종목 상세 탭" testId="stock-detail-tabs" compact />
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-28 pt-4 sm:px-4">
        {tab === 'summary' ? (
          <div className="mx-auto w-full max-w-5xl space-y-4" data-testid="stock-detail-summary">
            {quote.isLoading || profile.isLoading ? <LoadingSurface /> : null}
            {quote.isError ? (
              <section className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm" role="alert">
                <p className="font-black text-destructive">현재가 정보를 불러오지 못했습니다.</p>
                <button type="button" onClick={() => void quote.refetch()} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border border-destructive/30 px-3 font-black"><RefreshCw className="h-4 w-4" />다시 시도</button>
              </section>
            ) : null}
            {!quote.isLoading ? (
              <section className="rounded-3xl border border-card-border bg-card p-5">
                <div className="text-center">
                  <p className="text-sm font-bold text-muted-foreground">{ticker}</p>
                  <p className="mt-2 text-3xl font-black tabular-nums">{price == null ? '미확인' : formatAppPrice(price, currency)}</p>
                  <p className={`mt-2 text-sm font-black ${changePercent == null ? 'text-muted-foreground' : changePercent >= 0 ? 'text-emerald-500' : 'text-destructive'}`}>
                    {changePercent == null ? '등락률 미확인' : `${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%`}
                  </p>
                </div>
                <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div className="rounded-2xl bg-background p-3"><p className="text-[11px] font-bold text-muted-foreground">시장</p><p className="mt-1 truncate text-sm font-black">{exchange}</p></div>
                  <div className="rounded-2xl bg-background p-3"><p className="text-[11px] font-bold text-muted-foreground">업종</p><p className="mt-1 truncate text-sm font-black">{sector}</p></div>
                  <div className="rounded-2xl bg-background p-3"><p className="text-[11px] font-bold text-muted-foreground">시가총액</p><p className="mt-1 truncate text-sm font-black">{marketCap}</p></div>
                  <div className="rounded-2xl bg-background p-3"><p className="text-[11px] font-bold text-muted-foreground">데이터 상태</p><p className="mt-1 text-sm font-black">{quote.isError ? '오류' : price == null ? '부분' : '정상'}</p></div>
                </div>
              </section>
            ) : null}

            <section className="grid grid-cols-3 gap-2" aria-label="종목 상세 빠른 실행">
              <button type="button" onClick={() => setTab('chart')} className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-2xl bg-primary px-2 text-xs font-black text-primary-foreground"><BarChart3 className="h-5 w-5" />AI 차트</button>
              <button type="button" onClick={() => setTab('news')} className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-2xl border border-card-border bg-card px-2 text-xs font-black"><Newspaper className="h-5 w-5 text-primary" />뉴스</button>
              <button type="button" onClick={() => setTab('analysis')} className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-2xl border border-card-border bg-card px-2 text-xs font-black"><ExternalLink className="h-5 w-5 text-primary" />상세분석</button>
            </section>
          </div>
        ) : null}

        {tab === 'chart' ? (
          <div className="mx-auto h-full min-h-[560px] w-full max-w-7xl overflow-hidden rounded-3xl border border-card-border bg-card" data-testid="canonical-rich-detail-chart">
            <Suspense fallback={<LoadingSurface />}><AiChartPage embedded /></Suspense>
          </div>
        ) : null}

        {tab === 'news' ? (
          <div className="mx-auto w-full max-w-4xl space-y-3" data-testid="stock-detail-news">
            {news.isLoading ? <LoadingSurface /> : null}
            {news.isError ? (
              <section className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm" role="alert">
                <p className="font-black text-destructive">뉴스를 불러오지 못했습니다.</p>
                <button type="button" onClick={() => void news.refetch()} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border border-destructive/30 px-3 font-black"><RefreshCw className="h-4 w-4" />다시 시도</button>
              </section>
            ) : null}
            {!news.isLoading && !news.isError && newsRows.length === 0 ? <section className="rounded-2xl border border-card-border bg-card p-8 text-center text-sm font-bold text-muted-foreground">확인된 최신 뉴스가 없습니다.</section> : null}
            {newsRows.map((item, index) => {
              const title = text(item.title, item.headline) ?? '제목 미확인';
              const summary = text(item.summary, item.description, item.content);
              const source = text(item.source, item.publisher) ?? '출처 미확인';
              const published = text(item.publishedAt, item.published_at, item.date, item.datetime);
              const url = text(item.url, item.link);
              const content = (
                <>
                  <h2 className="break-keep text-sm font-black leading-6">{title}</h2>
                  {summary ? <p className="mt-2 line-clamp-3 break-keep text-xs leading-5 text-muted-foreground">{summary}</p> : null}
                  <p className="mt-2 text-[11px] font-bold text-muted-foreground">{source}{published ? ` · ${published}` : ''}</p>
                </>
              );
              return url ? <a key={`${url}:${index}`} href={url} target="_blank" rel="noreferrer" className="block rounded-2xl border border-card-border bg-card p-4 transition hover:border-primary/40">{content}</a> : <article key={`${title}:${index}`} className="rounded-2xl border border-card-border bg-card p-4">{content}</article>;
            })}
          </div>
        ) : null}
      </main>
      <BottomNav />
    </div>
  );
}
