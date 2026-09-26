import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, BarChart3, BriefcaseBusiness, Radar, Star } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { CenteredPageHeader } from '@/components/centered-page-header';
import { ResponsiveTabs } from '@/components/responsive-tabs';
import { UnifiedAssetSearch } from '@/components/unified-asset-search';
import { ADAPTIVE_VIEWPORT_BREAKPOINTS } from '@/lib/adaptive-layout';
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
type HomeLayoutMode = 'mobile' | 'tablet' | 'desktop';

const MOBILE_HOME_TABS = [
  { value: 'market', label: '시장' },
  { value: 'signal', label: '신호' },
  { value: 'watchlist', label: '관심' },
  { value: 'portfolio', label: '자산' },
] as const;

function finite(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/,/g, '').replace(/%$/u, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
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

function useHomeLayoutMode(): HomeLayoutMode {
  const desktopQuery = `(min-width: ${ADAPTIVE_VIEWPORT_BREAKPOINTS.desktopMin}px)`;
  const tabletQuery = '(min-width: 600px)';
  const read = (): HomeLayoutMode => {
    if (typeof window === 'undefined') return 'mobile';
    if (window.matchMedia(desktopQuery).matches) return 'desktop';
    if (window.matchMedia(tabletQuery).matches) return 'tablet';
    return 'mobile';
  };
  const [mode, setMode] = useState<HomeLayoutMode>(read);

  useEffect(() => {
    const desktopMedia = window.matchMedia(desktopQuery);
    const tabletMedia = window.matchMedia(tabletQuery);
    const update = () => setMode(read());
    update();
    desktopMedia.addEventListener('change', update);
    tabletMedia.addEventListener('change', update);
    return () => {
      desktopMedia.removeEventListener('change', update);
      tabletMedia.removeEventListener('change', update);
    };
  }, [desktopQuery]);

  return mode;
}

export default function HomePage() {
  const [, navigate] = useLocation();
  const assetMode = useAssetMode();
  const { selection } = useAnalysisSelection();
  const layoutMode = useHomeLayoutMode();
  const desktop = layoutMode === 'desktop';
  const tablet = layoutMode === 'tablet';
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
  const btcPrice = btc ? finite(btc.price ?? btc.tradePrice) : null;
  const btcChangePercent = btc ? finite(btc.changePercent ?? btc.changePercent24h) : null;
  const signalIsCurrent = isTodaySeoul(selection?.selectedAt);
  const currentSignal = Boolean(selection && signalIsCurrent && selection.signalScore != null);
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
  const marketEvidenceAvailable = indices.length > 0 || btcPrice != null;
  const dashboardMarketState = market.isLoading || bitcoin.isLoading
    ? '확인 중'
    : warnings.length > 0
      ? '확인 필요'
      : marketEvidenceAvailable
        ? '시세 확인됨'
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

  const professionalOverview = (
    <section
      data-testid="home-professional-overview"
      className="rounded-2xl border border-card-border bg-card p-4 shadow-sm sm:p-5"
      aria-labelledby="home-professional-overview-title"
    >
      <div className="flex flex-col gap-1 text-center min-[1200px]:text-left">
        <p className="text-xs font-semibold tracking-[0.12em] text-primary">MARKET DESK</p>
        <h2 id="home-professional-overview-title" className="text-lg font-bold tracking-[-0.015em] sm:text-xl">오늘의 투자 상태</h2>
        <p className="text-xs font-medium text-muted-foreground">시장 · 신호 · 관심종목 · 자산을 한 화면에서 확인합니다.</p>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 min-[600px]:grid-cols-4">
        <DashboardStatusCard
          icon={<BarChart3 className="h-5 w-5" />}
          label="시세"
          value={dashboardMarketState}
          detail="주식·코인 공개 시세"
          onClick={() => navigate('/market-overview')}
        />
        <DashboardStatusCard
          icon={<Radar className="h-5 w-5" />}
          label="AI 신호"
          value={currentSignal && selection ? `${actionLabel(selection.action)} · ${selection.signalScore}점` : '오늘 신호 없음'}
          detail={currentSignal && selection ? selection.displayName ?? selection.ticker : '선택된 최신 신호 없음'}
          onClick={() => navigate('/scanner')}
        />
        <DashboardStatusCard
          icon={<Star className="h-5 w-5" />}
          label="관심종목"
          value={`${watchlist.length}개`}
          detail={watchlist.length ? '관심 목록 확인' : '등록된 관심종목 없음'}
          onClick={() => navigate('/watchlist')}
        />
        <DashboardStatusCard
          icon={<BriefcaseBusiness className="h-5 w-5" />}
          label="자산"
          value="자산 보기"
          detail="보유·손익·위험 확인"
          onClick={() => navigate('/portfolio')}
        />
      </div>
    </section>
  );

  const marketSection = (
    <section className="rounded-2xl border border-card-border bg-card p-4 shadow-sm" data-testid="home-market-summary">
      <HomeSectionHeader title="시장" actionLabel="시황" onAction={() => navigate('/market-overview')} />
      <div className="mt-3 grid grid-cols-2 gap-2 min-[600px]:grid-cols-3 min-[900px]:grid-cols-5">
        {indices.length === 0
          ? <DashboardPlaceholder label={marketState} />
          : indices.map((item) => <MetricCard key={item.key} label={item.label} value={item.price.toLocaleString('ko-KR', { maximumFractionDigits: 2 })} sub={formatAppPercent(item.changePercent)} />)}
        <MetricCard
          label="비트코인 · 업비트"
          value={btc ? btcPrice == null ? '가격 미확인' : formatAppPrice(btcPrice, 'KRW') : bitcoin.isLoading ? '확인 중' : '미확인'}
          sub={btc ? btcChangePercent == null ? '등락 미확인' : formatAppPercent(btcChangePercent) : bitcoin.isError ? '확인 필요' : '현물 시세'}
        />
      </div>
    </section>
  );

  const signalSection = (
    <section className="rounded-2xl border border-card-border bg-card p-4 shadow-sm" data-testid="home-signal-summary">
      <HomeSectionHeader icon={<Radar className="h-4 w-4" />} title="최근 신호" actionLabel="검색기" onAction={() => navigate('/scanner')} />
      {selection && signalIsCurrent && selection.signalScore != null ? (
        <button type="button" onClick={() => navigate('/scanner')} className="mt-3 flex min-h-16 w-full min-w-0 items-center justify-between gap-3 rounded-2xl border border-card-border bg-background p-3 text-left">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold">{selection.displayName}</p>
            <p className="mt-1 truncate text-xs font-medium text-muted-foreground">{selection.ticker} · {selection.market} · {selection.timeframe}</p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-sm font-bold">{actionLabel(selection.action)}</p>
            <p className="text-xs font-medium text-muted-foreground">점수 {selection.signalScore}</p>
          </div>
        </button>
      ) : <p className="mt-3 rounded-2xl bg-background p-4 text-center text-xs font-medium text-muted-foreground">오늘 선택한 신호 없음</p>}
    </section>
  );

  const watchlistSection = (
    <section className="rounded-2xl border border-card-border bg-card p-4 shadow-sm" data-testid="home-watchlist-summary">
      <HomeSectionHeader icon={<Star className="h-4 w-4" />} title="관심종목" actionLabel="전체" onAction={() => navigate('/watchlist')} />
      <div className="mt-3 space-y-2">
        {watchlist.length
          ? watchlist.slice(0, 5).map((item) => {
            const watchlistPrice = finite(item.price);
            const watchlistChangePercent = finite(item.changePercent);
            const watchlistCurrency = typeof item.currency === 'string' && item.currency.trim()
              ? item.currency.trim().toUpperCase()
              : null;
            return (
              <div key={item.ticker} className="flex min-h-14 items-center justify-between gap-3 rounded-2xl bg-background px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold">{item.name || item.ticker}</p>
                  <p className="truncate text-xs font-medium text-muted-foreground">{item.ticker} · {item.market ?? '시장 미확인'}</p>
                </div>
                <div className="shrink-0 text-right text-xs font-semibold">
                  <p>{watchlistPrice == null ? '가격 미확인' : watchlistCurrency == null ? '통화 미확인' : formatAppPrice(watchlistPrice, watchlistCurrency)}</p>
                  <p className="text-xs font-medium text-muted-foreground">{watchlistChangePercent == null ? '등락 미확인' : formatAppPercent(watchlistChangePercent)}</p>
                </div>
              </div>
            );
          })
          : <p className="rounded-2xl bg-background p-4 text-center text-xs font-medium text-muted-foreground">관심종목 없음</p>}
      </div>
    </section>
  );

  const portfolioSection = (
    <section className="rounded-2xl border border-card-border bg-card p-4 shadow-sm" data-testid="home-portfolio-summary">
      <HomeSectionHeader icon={<BriefcaseBusiness className="h-4 w-4" />} title="포트폴리오" />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => navigate('/portfolio')} className="flex min-h-12 min-w-0 items-center justify-center gap-2 rounded-xl border border-card-border bg-background px-3 text-sm font-semibold transition hover:border-primary/40">
          <span className="truncate">자산·손익·위험</span><ArrowRight className="h-4 w-4 shrink-0" />
        </button>
        <button type="button" onClick={() => navigate('/account')} className="flex min-h-12 min-w-0 items-center justify-center gap-2 rounded-xl border border-card-border bg-background px-3 text-sm font-semibold transition hover:border-primary/40">
          <span className="truncate">계좌 연결</span><ArrowRight className="h-4 w-4 shrink-0" />
        </button>
      </div>
    </section>
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <CenteredPageHeader title="홈" />
      {layoutMode === 'mobile' ? (
        <div className="shrink-0 border-b border-card-border bg-background px-2 py-2">
          <ResponsiveTabs value={mobileTab} options={MOBILE_HOME_TABS} onChange={setMobileTab} ariaLabel="홈 보기" testId="home-mobile-tabs" compact />
        </div>
      ) : null}
      <main data-testid="home-page-scroll" className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain pb-4 sm:pb-5 min-[1200px]:pb-6">
        <div className="mx-auto w-full max-w-[90rem] space-y-4 px-3 py-4 sm:px-5 min-[1200px]:px-6 min-[1200px]:py-5">
          <section className="rounded-2xl border border-card-border bg-card p-3 sm:p-4" data-testid="home-single-search">
            <UnifiedAssetSearch placeholder="종목·코인 검색" onSelect={openAsset} />
          </section>

          {professionalOverview}

          {warnings.length > 0 && (
            <details role="alert" className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-3 py-2">
              <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 text-xs font-semibold text-amber-500 [&::-webkit-details-marker]:hidden">
                <AlertTriangle className="h-4 w-4 shrink-0" />데이터 확인 필요
              </summary>
              <ul className="border-t border-amber-500/20 pt-2 text-xs font-medium leading-5 text-muted-foreground">{warnings.map((warning) => <li key={warning}>• {warning}</li>)}</ul>
            </details>
          )}

          {desktop ? (
            <>
              <div className="grid grid-cols-12 gap-4" data-testid="home-desktop-workspace">
                <div className="col-span-8 min-w-0 space-y-4">
                  {marketSection}
                  {signalSection}
                </div>
                <aside className="col-span-4 min-w-0 space-y-4">
                  {watchlistSection}
                  {portfolioSection}
                </aside>
              </div>
              <section className="grid grid-cols-4 gap-2" aria-label="빠른 이동">
                <QuickLink label="국내" onClick={() => navigate('/stocks/kr')} />
                <QuickLink label="미국" onClick={() => navigate('/stocks/us')} />
                <QuickLink label="코인 현물" onClick={() => navigate('/coins/spot')} />
                <QuickLink label="코인 선물" onClick={() => navigate('/coins/futures')} />
              </section>
            </>
          ) : tablet ? (
            <>
              <div className="grid grid-cols-2 gap-4" data-testid="home-tablet-workspace">
                <div className="col-span-2 min-w-0">{marketSection}</div>
                <div className="min-w-0">{signalSection}</div>
                <div className="min-w-0">{portfolioSection}</div>
                <div className="col-span-2 min-w-0">{watchlistSection}</div>
              </div>
              <section className="grid grid-cols-4 gap-2" aria-label="빠른 이동">
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

function HomeSectionHeader({ icon, title, actionLabel, onAction }: {
  icon?: ReactNode;
  title: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2 min-[1200px]:grid-cols-[minmax(0,1fr)_auto]">
      <span className="flex h-11 w-11 items-center justify-center text-primary min-[1200px]:hidden" aria-hidden="true">{icon}</span>
      <h2 className="text-center text-base font-bold tracking-[-0.01em] min-[1200px]:text-left">{title}</h2>
      {actionLabel && onAction ? (
        <button type="button" onClick={onAction} className="flex h-11 w-11 items-center justify-center text-xs font-semibold text-primary">{actionLabel}</button>
      ) : <span aria-hidden="true" className="h-11 w-11" />}
    </div>
  );
}

function DashboardStatusCard({ icon, label, value, detail, onClick }: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-24 min-w-0 flex-col items-center justify-center rounded-2xl border border-card-border bg-background p-3 text-center transition hover:border-primary/40 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <span className="text-primary" aria-hidden="true">{icon}</span>
      <span className="mt-2 text-xs font-semibold text-muted-foreground">{label}</span>
      <strong className="mt-1 max-w-full truncate text-sm font-bold">{value}</strong>
      <span className="mt-1 max-w-full truncate text-xs font-medium text-muted-foreground">{detail}</span>
    </button>
  );
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return <div className="min-w-0 rounded-2xl bg-background p-3 text-center"><p className="truncate text-xs font-medium text-muted-foreground">{label}</p><p className="mt-1 truncate text-sm font-bold">{value}</p><p className="mt-1 truncate text-xs font-medium text-muted-foreground">{sub}</p></div>;
}

function DashboardPlaceholder({ label }: { label: string }) {
  return <div className="col-span-2 flex min-h-20 items-center justify-center rounded-2xl bg-background px-3 text-center text-xs font-medium text-muted-foreground md:col-span-4">{label}</div>;
}

function QuickLink({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="flex min-h-12 min-w-0 items-center justify-center gap-2 rounded-2xl border border-card-border bg-card px-2 text-sm font-semibold"><BarChart3 className="h-4 w-4 shrink-0 text-primary" /><span className="break-keep">{label}</span></button>;
}
