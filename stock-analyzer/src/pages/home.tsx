import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, BarChart3, BriefcaseBusiness, Radar, Star } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { CenteredPageHeader } from '@/components/centered-page-header';
import { ResponsiveTabs } from '@/components/responsive-tabs';
import { UnifiedAssetSearch } from '@/components/unified-asset-search';
import { useAnalysisSelection, type AnalysisTradeAction } from '@/lib/analysis-selection';
import { apiGet, type SummaryItem } from '@/lib/api';
import { useAssetMode } from '@/lib/asset-mode';
import {
  getMarketSummary,
  validMarketSummaryItems,
} from '@/lib/market-summary';
import { unifiedAssetDetailPath, type UnifiedAssetSuggestion } from '@/lib/unified-asset-search';
import {
  formatAppPercent,
  formatAppPrice,
  readWatchlistItems,
  WATCHLIST_CHANGE_EVENT,
  type WatchlistItem,
} from '@/lib/stock-display';

interface CryptoTickerRow {
  symbol?: unknown;
  price?: unknown;
  changePercent?: unknown;
  changePercent24h?: unknown;
  tradePrice?: unknown;
}

interface CryptoTickerResponse {
  tickers?: CryptoTickerRow[];
}

type MobileHomeTab = 'market' | 'signal' | 'watchlist' | 'portfolio';

const MOBILE_HOME_TABS = [
  { value: 'market', label: '시장' },
  { value: 'signal', label: '신호' },
  { value: 'watchlist', label: '관심' },
  { value: 'portfolio', label: '자산' },
] as const;

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function marketSummaryRows(items: SummaryItem[]): SummaryItem[] {
  const preferred = ['kospi', 'kosdaq', 'nasdaq', 'sp500', 'dow'];
  const map = new Map(
    validMarketSummaryItems(items).map((item) => [String(item.key ?? '').trim().toLowerCase(), item]),
  );
  return preferred.map((key) => map.get(key)).filter((item): item is SummaryItem => Boolean(item)).slice(0, 4);
}

function baseCoinSymbol(value: unknown): string {
  const raw = String(value ?? '').trim().toUpperCase();
  if (raw.startsWith('KRW-')) return raw.slice(4);
  return raw.replace(/(?:USDT|USDC)$/u, '');
}

function isTodaySeoul(value: string | undefined): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return formatter.format(new Date(parsed)) === formatter.format(new Date());
}

function actionLabel(action: AnalysisTradeAction | undefined): string {
  if (action === 'BUY') return '매수';
  if (action === 'SELL') return '매도';
  if (action === 'LONG') return '상승';
  if (action === 'SHORT') return '하락';
  if (action === 'NO_TRADE' || action === 'NONE') return '거래안함';
  return '관찰';
}

function useDesktopHome(): boolean {
  const query = '(min-width: 1024px)';
  const [desktop, setDesktop] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return desktop;
}

export default function HomePage() {
  const [, navigate] = useLocation();
  const assetMode = useAssetMode();
  const { selection } = useAnalysisSelection();
  const desktop = useDesktopHome();
  const [mobileTab, setMobileTab] = useState<MobileHomeTab>('market');
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>(() => readWatchlistItems().slice(0, 8));

  useEffect(() => {
    const refresh = () => setWatchlist(readWatchlistItems().slice(0, 8));
    window.addEventListener(WATCHLIST_CHANGE_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(WATCHLIST_CHANGE_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const market = useQuery({
    queryKey: ['home-dashboard-market'],
    queryFn: getMarketSummary,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  const bitcoin = useQuery({
    queryKey: ['home-dashboard-btc'],
    queryFn: () => apiGet<CryptoTickerResponse>('/crypto/spot/tickers'),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const indices = useMemo(() => marketSummaryRows(market.data?.items ?? []), [market.data?.items]);
  const btc = useMemo(() => (bitcoin.data?.tickers ?? []).find((row) => baseCoinSymbol(row.symbol) === 'BTC') ?? null, [bitcoin.data?.tickers]);
  const signalIsCurrent = isTodaySeoul(selection?.selectedAt);
  const marketWarning = market.isError
    ? '주식 시장 정보 확인 실패'
    : market.data?.dataState === 'provider_error'
      ? '주식 시장 공급자 확인 필요'
      : market.data?.dataState === 'partial'
        ? '일부 시장 정보 지연'
        : '';
  const warnings = [
    marketWarning,
    bitcoin.isError ? '코인 시세 공급자 확인 필요' : '',
  ].filter(Boolean);
  const marketState = market.isLoading
    ? '확인 중'
    : market.isError || market.data?.dataState === 'provider_error'
      ? '확인 필요'
      : '데이터 없음';

  const openAsset = (item: UnifiedAssetSuggestion) => {
    if (item.assetType === 'stock') {
      assetMode.setAsset('stock');
      assetMode.setStockMarket(item.market === 'US' ? 'US' : 'KR');
    } else {
      assetMode.setAsset('coin');
      assetMode.setCoinMarket(item.market === 'futures' ? 'futures' : 'spot');
    }
    navigate(unifiedAssetDetailPath(item, '/home'));
  };

  const marketSection = (
    <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="home-market-summary">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-black">시장</h2>
        <button type="button" onClick={() => navigate('/market-overview')} className="inline-flex min-h-11 shrink-0 items-center px-2 text-xs font-black text-primary">시황</button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-5">
        {indices.length === 0
          ? <DashboardPlaceholder label={marketState} />
          : indices.map((item) => <MetricCard key={item.key} label={item.label} value={item.price.toLocaleString('ko-KR', { maximumFractionDigits: 2 })} sub={formatAppPercent(item.changePercent)} />)}
        <MetricCard
          label="비트코인 · 업비트"
          value={btc ? formatAppPrice(finite(btc.price ?? btc.tradePrice), 'KRW') : bitcoin.isLoading ? '확인 중' : '미확인'}
          sub={btc ? formatAppPercent(finite(btc.changePercent ?? btc.changePercent24h)) : bitcoin.isError ? '확인 필요' : '현물 시세'}
        />
      </div>
    </section>
  );

  const signalSection = (
    <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="home-signal-summary">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2"><Radar className="h-4 w-4 text-primary" /><h2 className="text-base font-black">최근 신호</h2></div>
        <button type="button" onClick={() => navigate('/scanner')} className="inline-flex min-h-11 shrink-0 items-center px-2 text-xs font-black text-primary">검색기</button>
      </div>
      {selection && signalIsCurrent && selection.signalScore != null ? (
        <button type="button" onClick={() => navigate('/scanner')} className="mt-3 flex min-h-16 w-full min-w-0 items-center justify-between gap-3 rounded-2xl border border-card-border bg-background p-3 text-left">
          <div className="min-w-0">
            <p className="truncate text-sm font-black">{selection.displayName}</p>
            <p className="mt-1 truncate text-[11px] font-bold text-muted-foreground">{selection.ticker} · {selection.market} · {selection.timeframe}</p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-sm font-black">{actionLabel(selection.action)}</p>
            <p className="text-[10px] font-bold text-muted-foreground">점수 {selection.signalScore}</p>
          </div>
        </button>
      ) : <p className="mt-3 rounded-2xl bg-background p-4 text-center text-xs font-bold text-muted-foreground">오늘 선택한 신호 없음</p>}
    </section>
  );

  const watchlistSection = (
    <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="home-watchlist-summary">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2"><Star className="h-4 w-4 text-primary" /><h2 className="text-sm font-black">관심종목</h2></div>
        <button type="button" onClick={() => navigate('/watchlist')} className="inline-flex min-h-11 shrink-0 items-center px-2 text-xs font-black text-primary">전체</button>
      </div>
      <div className="mt-3 space-y-2">
        {watchlist.length
          ? watchlist.slice(0, 5).map((item) => (
            <div key={item.ticker} className="flex min-h-14 items-center justify-between gap-3 rounded-2xl bg-background px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-black">{item.name || item.ticker}</p>
                <p className="truncate text-[10px] font-bold text-muted-foreground">{item.ticker} · {item.market ?? '시장 미확인'}</p>
              </div>
              <div className="shrink-0 text-right text-xs font-black">
                <p>{item.price == null ? '가격 미확인' : formatAppPrice(item.price, item.currency ?? 'KRW')}</p>
                <p className="text-[10px] text-muted-foreground">{item.changePercent == null ? '등락 미확인' : formatAppPercent(item.changePercent)}</p>
              </div>
            </div>
          ))
          : <p className="rounded-2xl bg-background p-4 text-center text-xs font-bold text-muted-foreground">관심종목 없음</p>}
      </div>
    </section>
  );

  const portfolioSection = (
    <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="home-portfolio-summary">
      <div className="flex items-center gap-2"><BriefcaseBusiness className="h-4 w-4 text-primary" /><h2 className="text-sm font-black">포트폴리오</h2></div>
      <button type="button" onClick={() => navigate('/portfolio')} className="mt-3 flex min-h-12 w-full items-center justify-between rounded-2xl border border-card-border bg-background px-4 text-sm font-black">
        <span>자산·손익·위험</span><ArrowRight className="h-4 w-4" />
      </button>
    </section>
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <CenteredPageHeader title="홈" />
      {!desktop ? (
        <div className="shrink-0 border-b border-card-border bg-background px-2 py-2">
          <ResponsiveTabs value={mobileTab} options={MOBILE_HOME_TABS} onChange={setMobileTab} ariaLabel="홈 보기" testId="home-mobile-tabs" compact />
        </div>
      ) : null}
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain pb-[calc(5.5rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-6xl space-y-4 px-3 py-4 sm:px-5 lg:py-6">
          <section className="rounded-2xl border border-card-border bg-card p-3 sm:p-4" data-testid="home-single-search">
            <UnifiedAssetSearch placeholder="종목·코인 검색" onSelect={openAsset} />
          </section>

          {warnings.length > 0 && (
            <details role="alert" className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-3 py-2">
              <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 text-xs font-black text-amber-500 [&::-webkit-details-marker]:hidden">
                <AlertTriangle className="h-4 w-4 shrink-0" />데이터 확인 필요
              </summary>
              <ul className="border-t border-amber-500/20 pt-2 text-xs font-bold leading-5 text-muted-foreground">{warnings.map((warning) => <li key={warning}>• {warning}</li>)}</ul>
            </details>
          )}

          {desktop ? (
            <>
              {marketSection}
              {signalSection}
              <div className="grid gap-4 lg:grid-cols-2">
                {watchlistSection}
                {portfolioSection}
              </div>
              <section className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="빠른 이동">
                <QuickLink label="국내" onClick={() => navigate('/stocks/kr')} />
                <QuickLink label="미국" onClick={() => navigate('/stocks/us')} />
                <QuickLink label="코인 현물" onClick={() => navigate('/coins/spot')} />
                <QuickLink label="코인 선물" onClick={() => navigate('/coins/futures')} />
              </section>
            </>
          ) : (
            <section data-testid={`home-mobile-panel-${mobileTab}`}>
              {mobileTab === 'market' ? marketSection : null}
              {mobileTab === 'signal' ? signalSection : null}
              {mobileTab === 'watchlist' ? watchlistSection : null}
              {mobileTab === 'portfolio' ? portfolioSection : null}
            </section>
          )}
        </div>
      </main>
      <BottomNav />
    </div>
  );
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return <div className="min-w-0 rounded-2xl bg-background p-3"><p className="truncate text-[10px] font-bold text-muted-foreground">{label}</p><p className="mt-1 truncate text-sm font-black">{value}</p><p className="mt-1 truncate text-[10px] font-bold text-muted-foreground">{sub}</p></div>;
}

function DashboardPlaceholder({ label }: { label: string }) {
  return <div className="col-span-2 flex min-h-20 items-center justify-center rounded-2xl bg-background px-3 text-center text-xs font-bold text-muted-foreground md:col-span-4">{label}</div>;
}

function QuickLink({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="flex min-h-12 min-w-0 items-center justify-center gap-2 rounded-2xl border border-card-border bg-card px-2 text-sm font-black"><BarChart3 className="h-4 w-4 shrink-0 text-primary" /><span className="break-keep">{label}</span></button>;
}
