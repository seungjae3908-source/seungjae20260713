import { lazy, Suspense, useEffect } from 'react';
import { Redirect, Route, Switch, Router as WouterRouter, useLocation, useRoute } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SettingsProvider } from '@/lib/settings';
import { ensureWatchlistSync } from '@/lib/watchlist-sync';
import { AuthProvider, useAuth } from '@/lib/auth';
import { AppBackground } from '@/components/app-background';
import { AssetModeProvider, useAssetMode } from '@/lib/asset-mode';
import {
  AnalysisSelectionProvider,
  normalizeAnalysisSelection,
  selectionFromSearch,
} from '@/lib/analysis-selection';
import { AssetRouteNotResolved, resolveAssetDetailPath, resolveLegacyCryptoDetailChoices, resolveLegacyCryptoDetailPath } from '@/lib/asset-navigation';
import { OfflineBanner } from '@/components/offline-banner';
import { ScannerReadinessStatus } from '@/components/scanner-readiness-status';
import { OrderbookRouteDock } from '@/components/orderbook-route-dock';
import { ProfessionalCommandBar } from '@/components/professional-command-bar';
import { AppSidebar, useDesktopShell } from '@/components/app-sidebar';
import { DesktopSidebarMountedContext } from '@/lib/desktop-shell-context';
import { ErrorState, PageFallback } from '@/components/data-state';
import { AppErrorBoundary, RouteErrorBoundary } from '@/components/app-error-boundary';
import { AutoBackupSync } from '@/lib/backup-sync';
import { CapabilityGate } from '@/components/capability-gate';
import { UiBuilderRuntimeBoundary } from '@/components/ui-builder-runtime-boundary';
import { withActiveQuerySignal } from '@/lib/query-abort-signal';
import { fetchUnifiedChartData, UNIFIED_CHART_TIMEFRAMES, UnifiedChartDataError } from '@/lib/unified-chart-data';
import type { UiBuilderPageId } from '@/lib/ui-builder-full-layout';
import type { MemberCapability } from '../../packages/member-access/src/index.js';
import HomePage from '@/pages/home';
import RecommendationsPage from '@/pages/recommendations';

const loadWatchlistPage = () => import('@/pages/watchlist');
const WatchlistPage = lazy(loadWatchlistPage);
const loadAlertsPage = () => import('@/pages/alerts');
const AlertsPage = lazy(loadAlertsPage);
const loadScannerPage = () => import('@/pages/scanner');
const ScannerPage = lazy(loadScannerPage);
const loadSignalScannerPage = () => import('@/pages/signal-scanner');
const SignalScannerPage = lazy(loadSignalScannerPage);
const TelegramSignalOrderPage = lazy(() => import('@/pages/telegram-signal-order'));
const loadStockInfoPage = () => import('@/pages/stock-info');
const StockInfoPage = lazy(loadStockInfoPage);
const loadDetailPage = () => import('@/pages/detail');
const DetailPage = lazy(loadDetailPage);
const MarketOverviewPage = lazy(() => import('@/pages/market-overview'));
const UnifiedAssetSearchPage = lazy(() => import('@/pages/unified-asset-search'));
const loadMorePage = () => import('@/pages/more');
const MorePage = lazy(loadMorePage);
const loadPortfolioPage = () => import('@/pages/portfolio');
const PortfolioPage = lazy(loadPortfolioPage);
const PortfolioV2Page = lazy(() => import('@/pages/portfolio-v2'));
const loadStrategyPromotionPage = () => import('@/pages/strategy-promotion');
const StrategyPromotionPage = lazy(loadStrategyPromotionPage);
const ResearchCenterPage = lazy(() => import('@/pages/research-center-workspace'));
const loadAccountPage = () => import('@/pages/account');
const directLoginColdRoute = typeof window !== 'undefined' && window.location.pathname.endsWith('/login');
if (directLoginColdRoute) {
  void loadAccountPage();
}
const AccountPage = lazy(loadAccountPage);
const AdminPage = lazy(() => import('@/pages/admin'));
const AgentHubControlPage = lazy(() => import('@/pages/agent-hub-control'));
const InstallPage = lazy(() => import('@/pages/install'));
const loadBacktestsPage = () => import('@/pages/backtests');
const BacktestsPage = lazy(loadBacktestsPage);
const loadPaperTradingPage = () => import('@/pages/paper-trading');
const PaperTradingPage = lazy(loadPaperTradingPage);
const AutoTradingPage = lazy(() => import('@/pages/auto-trading'));
const AutoRehearsalPreviewPage = lazy(() => import('@/pages/auto-rehearsal-preview'));
const UiBuilderLayoutControlPage = lazy(() => import('@/pages/ui-builder-layout-control'));
const NotFound = lazy(() => import('@/pages/not-found'));
const Phase4RiskE2EPage = lazy(() => import('@/pages/phase4-risk-e2e'));
const Phase5BacktestE2EPage = lazy(() => import('@/pages/phase5-backtest-e2e'));
const Phase6PaperTradingE2EPage = lazy(() => import('@/pages/phase6-paper-trading-e2e'));
const Phase7JournalSyncE2EPage = lazy(() => import('@/pages/phase7-journal-sync-e2e'));
const Phase8ReleaseCandidateE2EPage = lazy(() => import('@/pages/phase8-release-candidate-e2e'));
const Phase9AiReviewE2EPage = lazy(() => import('@/pages/phase9-ai-review-e2e'));
const directAiChartColdRoute = typeof window !== 'undefined' && window.location.pathname.endsWith('/ai-chart');
const directAiChartDesktopPrewarm = directAiChartColdRoute
  && window.matchMedia('(min-width: 1024px)').matches;
const directAiChartPrewarmSelection = (() => {
  if (!directAiChartDesktopPrewarm) return null;
  try {
    const routeSelection = selectionFromSearch(window.location.search);
    const storedSelection = normalizeAnalysisSelection(
      JSON.parse(window.localStorage.getItem('sa-analysis-selection-v1') ?? 'null'),
    );
    const prewarmSelection = routeSelection ?? storedSelection;
    if (!prewarmSelection) return null;
    const timeframe = UNIFIED_CHART_TIMEFRAMES.find((item) => item.key === prewarmSelection.timeframe)?.key;
    if (!timeframe) return null;
    return {
      market: prewarmSelection.market,
      ticker: prewarmSelection.ticker,
      timeframe,
    };
  } catch {
    return null;
  }
})();
const loadAiChartPage = () => import('@/pages/ai-chart');
if (directAiChartColdRoute) {
  void loadAiChartPage();
}
const AiChartPage = lazy(loadAiChartPage);
const loadAiChatPage = () => import('@/pages/ai-chat');
const AiChatPage = lazy(loadAiChatPage);
const loadTechnicalWorkspacePage = () => import('@/pages/technical-workspace');
const TechnicalWorkspacePage = lazy(loadTechnicalWorkspacePage);
const Phase12TradeAutomationE2EPage = lazy(() => import('@/pages/phase12-trade-automation-e2e'));

const phase4E2EEnabled = import.meta.env.VITE_PHASE4_E2E === 'true';
const phase5E2EEnabled = import.meta.env.VITE_PHASE5_E2E === 'true';
const phase6E2EEnabled = import.meta.env.VITE_PHASE6_E2E === 'true';
const phase7E2EEnabled = import.meta.env.VITE_PHASE7_E2E === 'true';
const phase8E2EEnabled = import.meta.env.VITE_PHASE8_E2E === 'true';
const phase9E2EEnabled = import.meta.env.VITE_PHASE9_E2E === 'true';
const phase11E2EEnabled = import.meta.env.VITE_PHASE11_E2E === 'true';
const phase12E2EEnabled = import.meta.env.VITE_PHASE12_E2E === 'true';
const prRehearsalPreviewEnabled = import.meta.env.VITE_PR_REHEARSAL_PREVIEW === 'true';
const DIRECT_AI_CHART_PREWARM_STALE_MS = 8_000;
const DIRECT_AI_CHART_PREWARM_DEFAULT_RESET_MS = 15_000;

function retryUnifiedChartBootstrap(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false;
  if (error instanceof UnifiedChartDataError) return error.retryable && error.kind !== 'aborted';
  return true;
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true, refetchOnReconnect: true, staleTime: 0, gcTime: 30 * 60 * 1000, retry: 2 } },
});

function DirectAiChartDataPrewarm() {
  const auth = useAuth();
  useEffect(() => {
    if (
      !directAiChartPrewarmSelection
      || auth.loading
      || !auth.isApproved
      || !auth.can('canAccessAiChart')
    ) return;

    const { market, ticker, timeframe } = directAiChartPrewarmSelection;
    const queryKey = ['unified-chart-data', market, ticker, timeframe] as const;
    const resetDefaults = () => {
      queryClient.setQueryDefaults(queryKey, {
        staleTime: 0,
        retryOnMount: true,
      });
    };
    queryClient.setQueryDefaults(queryKey, {
      staleTime: DIRECT_AI_CHART_PREWARM_STALE_MS,
      retryOnMount: false,
    });
    void queryClient.prefetchQuery({
      queryKey,
      queryFn: ({ signal }) => fetchUnifiedChartData({ market, symbol: ticker, timeframe, signal }),
      retry: retryUnifiedChartBootstrap,
    });
    const resetTimer = window.setTimeout(
      resetDefaults,
      DIRECT_AI_CHART_PREWARM_DEFAULT_RESET_MS,
    );
    return () => {
      window.clearTimeout(resetTimer);
      resetDefaults();
    };
  }, [auth.loading, auth.isApproved, auth.membershipLevel]);
  return null;
}

function installScannerAbortBridge(client: QueryClient) {
  const originalDefaultQueryOptions = client.defaultQueryOptions.bind(client);
  const wrappedFunctions = new WeakSet<object>();
  client.defaultQueryOptions = ((options) => {
    const resolved = originalDefaultQueryOptions(options);
    const queryFn = resolved.queryFn;
    if (
      resolved.queryKey?.[0] !== 'scan'
      || typeof queryFn !== 'function'
      || wrappedFunctions.has(queryFn)
    ) {
      return resolved;
    }
    const wrapped = ((context: Parameters<typeof queryFn>[0]) =>
      withActiveQuerySignal(context.signal, () => queryFn(context))) as typeof queryFn;
    wrappedFunctions.add(wrapped);
    return { ...resolved, queryFn: wrapped };
  }) as typeof client.defaultQueryOptions;
}

installScannerAbortBridge(queryClient);

function useCryptoRedirect(target: (symbol?: string) => string, symbol?: string) {
  const mode = useAssetMode();
  const [, navigate] = useLocation();
  useEffect(() => {
    mode.setAsset('coin'); navigate(target(symbol), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function CryptoHomeRedirect() { useCryptoRedirect(() => '/home'); return <PageFallback />; }
function CryptoSearchRedirect() { useCryptoRedirect(() => '/stocks'); return <PageFallback />; }
function CryptoDetailRedirect() {
  const mode = useAssetMode();
  const [location, navigate] = useLocation();
  const [, params] = useRoute('/crypto/:symbol') as [boolean, { symbol?: string } | null];
  const symbol = String(params?.symbol ?? '').trim().toUpperCase();
  const query = location.includes('?') ? location.slice(location.indexOf('?') + 1) : window.location.search.slice(1);
  const backPath = new URLSearchParams(query).get('back')?.trim() || '/stocks';
  let target: string | null = null;
  try {
    target = resolveLegacyCryptoDetailPath(symbol, backPath);
  } catch (error) {
    if (!(error instanceof AssetRouteNotResolved)) throw error;
  }
  useEffect(() => {
    if (!target) return;
    mode.setAsset('coin');
    navigate(target, { replace: true });
  }, [mode, navigate, target]);
  if (target) return <PageFallback />;
  const choices = resolveLegacyCryptoDetailChoices(symbol, backPath);
  if (!choices) return <NotFound />;
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center gap-3 p-6 text-center" data-testid="crypto-symbol-chooser">
      <h1 className="text-lg font-black">{choices.base} 어느 시장을 볼까요?</h1>
      <p className="text-xs font-bold text-muted-foreground">같은 이름의 코인이 현물과 선물에 모두 있어서 자동으로 고르지 않습니다.</p>
      <button type="button" className="min-h-11 rounded-xl bg-primary px-4 text-sm font-black text-primary-foreground" onClick={() => { mode.setAsset('coin'); navigate(choices.spotPath, { replace: true }); }}>현물 (업비트 KRW-{choices.base})</button>
      <button type="button" className="min-h-11 rounded-xl border border-card-border bg-card px-4 text-sm font-black" onClick={() => { mode.setAsset('coin'); navigate(choices.futuresPath, { replace: true }); }}>선물 (비트겟 {choices.base}USDT)</button>
    </main>
  );
}

function LegacyStockDetailRedirect() {
  const [location, navigate] = useLocation();
  const [, params] = useRoute('/stock/:ticker') as [boolean, { ticker?: string } | null];
  const ticker = String(params?.ticker ?? '').trim().toUpperCase();
  const query = location.includes('?') ? location.slice(location.indexOf('?') + 1) : '';
  const backPath = new URLSearchParams(query).get('back')?.trim() || '/stocks';
  let target: string | null = null;
  if (/^\d{6}$/.test(ticker)) {
    target = resolveAssetDetailPath({ assetClass: 'KR_STOCK', market: 'KR', symbol: ticker, canonicalSymbol: ticker, backPath });
  } else if (/^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker)) {
    target = resolveAssetDetailPath({ assetClass: 'US_STOCK', market: 'US', symbol: ticker, canonicalSymbol: ticker, backPath });
  }
  useEffect(() => {
    if (target) navigate(target, { replace: true });
  }, [navigate, target]);
  return target ? <PageFallback /> : <NotFound />;
}

// Removed screens (2026-10-18 product scope: 13 features). Old bookmarks land on home instead of 404.
const REMOVED_FEATURE_PATHS = [
  '/stocks/kr',
  '/stocks/us',
  '/coins/spot',
  '/coins/futures',
  '/market-rankings',
  '/market-browser',
  '/themes',
  '/news-information',
  '/learn',
] as const;

const SIDEBAR_EXCLUDED_PATHS = new Set(['/install']);

function AppShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const auth = useAuth();
  const desktop = useDesktopShell();
  const path = location.split('?')[0] || '/';
  const legacyScannerE2E = phase11E2EEnabled && location.startsWith('/__phase11-ai-workspace-e2e');
  const scannerRoute = location.startsWith('/scanner') || legacyScannerE2E;
  const wide = scannerRoute || location.startsWith('/ai-chart') || location.startsWith('/__phase11-technical-workspace-e2e');
  const showSidebar = desktop
    && auth.isApproved
    && !auth.loading
    && !path.startsWith('/__')
    && !SIDEBAR_EXCLUDED_PATHS.has(path);
  return <div data-testid="app-shell" className="relative h-[100dvh] w-full overflow-hidden text-foreground"><AppBackground /><div data-testid={scannerRoute ? 'scanner-root' : undefined} data-app-sidebar={showSidebar ? 'true' : undefined} className={`relative z-10 mx-auto flex h-[100dvh] min-h-0 w-full overflow-hidden bg-background ${showSidebar ? 'max-w-screen-xl min-[1200px]:max-w-none' : wide ? 'max-w-screen-2xl' : 'max-w-screen-xl'}`}>{showSidebar ? <div data-testid="desktop-sidebar-slot" className="flex h-full shrink-0"><AppSidebar /></div> : null}<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"><OfflineBanner /><ProfessionalCommandBar />{scannerRoute ? <ScannerReadinessStatus /> : null}<div className="min-h-0 flex-1 overflow-hidden"><DesktopSidebarMountedContext.Provider value={showSidebar}>{children}</DesktopSidebarMountedContext.Provider></div></div></div><OrderbookRouteDock /></div>;
}

function gated(capability: MemberCapability, child: React.ReactNode) {
  return <CapabilityGate capability={capability}>{child}</CapabilityGate>;
}

function builder(pageId: UiBuilderPageId, child: React.ReactNode) {
  return <UiBuilderRuntimeBoundary pageId={pageId}>{child}</UiBuilderRuntimeBoundary>;
}

function HomeAccess() { return builder('HOME', <HomePage />); }
function ScannerAccess() {
  return gated('canAccessBasicInfo', <TechnicalWorkspacePage />);
}
function TelegramSignalOrderAccess() {
  return gated('canAccessBasicInfo', <TelegramSignalOrderPage />);
}
function AiChartAccess() { return gated('canAccessAiChart', builder('AI_CHART', <AiChartPage />)); }
function AiChatAccess() { return gated('canAccessBasicInfo', builder('AI_CHAT', <AiChatPage />)); }
function PortfolioAccess() { return gated('canAccessPaperTrading', builder('PORTFOLIO', <PortfolioV2Page />)); }
function PositionAccess() { return gated('canAccessPaperTrading', builder('POSITION', <PortfolioPage />)); }
function RecommendationsAccess() { return gated('canAccessRiskPreview', <RecommendationsPage />); }
function StrategyPromotionAccess() { return gated('canAccessBacktests', <StrategyPromotionPage />); }
function ResearchCenterAccess() { return gated('canAccessBasicInfo', <ResearchCenterPage />); }
function BacktestsAccess() { return gated('canAccessBacktests', <BacktestsPage />); }
function PaperTradingRouteFallback() {
  return (
    <main
      aria-busy="true"
      aria-label="모의매매 화면 준비 중"
      className="h-full overflow-y-auto overscroll-contain pb-28"
      data-testid="paper-trading-route-skeleton"
    >
      <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-5 sm:px-5">
        <header className="rounded-2xl border border-border bg-card p-4">
          <h1 className="text-lg font-bold">모의매매</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            계좌와 거래일지를 안전하게 준비하고 있습니다.
          </p>
        </header>
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-hidden="true">
          {Array.from({ length: 4 }, (_, index) => (
            <div className="h-20 animate-pulse rounded-2xl bg-muted/40" key={index} />
          ))}
        </section>
        <section className="h-48 animate-pulse rounded-2xl bg-muted/40" aria-hidden="true" />
      </div>
    </main>
  );
}
function PaperTradingAccess() {
  return gated(
    'canAccessPaperTrading',
    <Suspense fallback={<PaperTradingRouteFallback />}>
      <PaperTradingPage />
    </Suspense>,
  );
}
function AutoTradingAccess() { return gated('canAccessAutoTrading', builder('AUTO_TRADING', <AutoTradingPage />)); }
function AdminAccess() { return gated('canManageMembers', <AdminPage />); }
function AgentHubControlAccess() { return gated('canManageMembers', <AgentHubControlPage />); }
function UiBuilderAdminAccess() { return gated('canManageMembers', <UiBuilderLayoutControlPage />); }
function UnifiedAssetSearchAccess() { return gated('canAccessBasicInfo', builder('ASSET_SEARCH', <UnifiedAssetSearchPage />)); }
function SettingsAccess() { return builder('SETTINGS', <MorePage />); }
function AccountConnectionAccess() { return builder('ACCOUNT_CONNECTION', <AccountPage />); }
function StockInfoAccess() {
  const [location] = useLocation();
  const query = location.includes('?') ? location.slice(location.indexOf('?') + 1) : window.location.search.slice(1);
  const params = new URLSearchParams(query);
  const ticker = String(params.get('ticker') ?? params.get('symbol') ?? '').trim().toUpperCase();
  const content = ticker
    ? builder(
        'ASSET_DETAIL',
        location.split('?')[0] === '/stock-info/analysis' && params.get('asset') === 'stock'
          ? <DetailPage />
          : <StockInfoPage />,
      )
    : builder('ASSET_SEARCH', <UnifiedAssetSearchPage />);
  if (params.get('asset') === 'coin') {
    return gated(params.get('coinMarket') === 'futures' ? 'canAccessFutures' : 'canAccessSpot', content);
  }
  return gated('canAccessBasicInfo', content);
}

function Phase13OrderbookE2EPage() {
  return <main data-testid="phase13-orderbook-e2e" className="h-full bg-background" aria-label="Orderbook E2E surface" />;
}

function ApprovedRouter() {
  return <Suspense fallback={<PageFallback />}><Switch>
    <Route path="/" component={HomeAccess} />
    <Route path="/home" component={HomeAccess} />
    {REMOVED_FEATURE_PATHS.map((path) => <Route key={path} path={path}><Redirect to="/" replace /></Route>)}
    <Route path="/stocks" component={UnifiedAssetSearchAccess} />
    <Route path="/auto-trading" component={AutoTradingAccess} />
    <Route path="/stock-info/analysis" component={StockInfoAccess} />
    <Route path="/stock-info" component={StockInfoAccess} />
    <Route path="/market-overview" component={MarketOverviewPage} />
    <Route path="/assets" component={PortfolioAccess} />
    <Route path="/settings" component={SettingsAccess} />
    <Route path="/search" component={UnifiedAssetSearchAccess} />
    <Route path="/scanner" component={ScannerAccess} />
    <Route path="/telegram-order" component={TelegramSignalOrderAccess} />
    <Route path="/ai-chart" component={AiChartAccess} />
    <Route path="/ai-chat" component={AiChatAccess} />
    <Route path="/research-center" component={ResearchCenterAccess} />
    <Route path="/watchlist" component={WatchlistPage} />
    <Route path="/alerts" component={AlertsPage} />
    <Route path="/portfolio" component={PortfolioAccess} />
    <Route path="/position" component={PositionAccess} />
    <Route path="/strategy-promotion" component={StrategyPromotionAccess} />
    <Route path="/account" component={AccountConnectionAccess} />
    <Route path="/admin/agent-hub" component={AgentHubControlAccess} />
    <Route path="/admin/ui-layouts" component={UiBuilderAdminAccess} />
    <Route path="/admin" component={AdminAccess} />
    <Route path="/more" component={SettingsAccess} />
    <Route path="/stock/:ticker" component={LegacyStockDetailRedirect} />
    <Route path="/recommendations" component={RecommendationsAccess} />
    <Route path="/backtests" component={BacktestsAccess} />
    <Route path="/paper-trading" component={PaperTradingAccess} />
    <Route path="/crypto" component={CryptoHomeRedirect} />
    <Route path="/crypto/search" component={CryptoSearchRedirect} />
    <Route path="/crypto/:symbol" component={CryptoDetailRedirect} />
    <Route component={NotFound} />
  </Switch></Suspense>;
}

function RootRouter() {
  return <Suspense fallback={<PageFallback />}><Switch>
    {phase4E2EEnabled ? <Route path="/__phase4-risk-e2e" component={Phase4RiskE2EPage} /> : null}
    {phase5E2EEnabled ? <Route path="/__phase5-backtest-e2e" component={Phase5BacktestE2EPage} /> : null}
    {phase6E2EEnabled ? <Route path="/__phase6-paper-trading-e2e" component={Phase6PaperTradingE2EPage} /> : null}
    {phase7E2EEnabled ? <Route path="/__phase7-journal-sync-e2e" component={Phase7JournalSyncE2EPage} /> : null}
    {phase8E2EEnabled ? <Route path="/__phase8-release-candidate-e2e" component={Phase8ReleaseCandidateE2EPage} /> : null}
    {phase9E2EEnabled ? <Route path="/__phase9-ai-review-e2e" component={Phase9AiReviewE2EPage} /> : null}
    {phase11E2EEnabled ? <Route path="/__phase11-unified-search-e2e" component={UnifiedAssetSearchPage} /> : null}
    {phase11E2EEnabled ? <Route path="/__phase11-ai-workspace-e2e" component={ScannerRoute} /> : null}
    {phase11E2EEnabled ? <Route path="/__phase11-ai-chat-e2e" component={AiChatPage} /> : null}
    {phase11E2EEnabled ? <Route path="/__phase11-technical-workspace-e2e" component={TechnicalWorkspacePage} /> : null}
    {phase11E2EEnabled ? <Route path="/auto-trading" component={Phase11AutoTradingRoute} /> : null}
    {phase12E2EEnabled ? <Route path="/__phase12-trade-automation-e2e" component={Phase12TradeAutomationE2EPage} /> : null}
    {phase12E2EEnabled ? <Route path="/__phase13-orderbook-e2e" component={Phase13OrderbookE2EPage} /> : null}
    {phase11E2EEnabled ? <Route path="/ai-chart" component={AiChartRoute} /> : null}
    {prRehearsalPreviewEnabled ? <Route path="/auto-rehearsal-preview" component={AutoRehearsalPreviewPage} /> : null}
    <Route path="/login" component={AccountPage} />
    <Route path="/install" component={InstallPage} />
    <Route component={AuthenticatedApp} />
  </Switch></Suspense>;
}

function ScannerRoute() {
  return <ScannerPage />;
}

function AiChartRoute() {
  return <AiChartPage />;
}

function Phase11AutoTradingRoute() {
  return <AutoTradingPage />;
}

function AuthenticatedApp() {
  const auth = useAuth();
  useEffect(() => { if (auth.isApproved) ensureWatchlistSync(); }, [auth.isApproved]);
  useEffect(() => {
    if (!auth.isApproved || directAiChartColdRoute) return;
    void Promise.allSettled([
      loadWatchlistPage(),
      loadScannerPage(),
      loadPortfolioPage(),
      loadBacktestsPage(),
      loadStrategyPromotionPage(),
      loadMorePage(),
      loadStockInfoPage(),
      loadDetailPage(),
      loadTechnicalWorkspacePage(),
      loadSignalScannerPage(),
      loadAiChartPage(),
      loadAiChatPage(),
      loadAlertsPage(),
    ]).catch(() => undefined);
  }, [auth.isApproved, auth.membershipLevel]);
  useEffect(() => {
    if (auth.isApproved && auth.can('canAccessPaperTrading')) {
      void loadPaperTradingPage();
    }
  }, [auth.isApproved, auth.membershipLevel]);
  if (auth.loading) return <PageFallback />;
  if (auth.bootstrapError) return <Suspense fallback={<PageFallback />}><AccountPage /></Suspense>;
  if (!auth.configured || !auth.isApproved) return <Suspense fallback={<PageFallback />}><AccountPage /></Suspense>;
  return <><AutoBackupSync /><ApprovedRouter /></>;
}

function App() {
  return <AppErrorBoundary><QueryClientProvider client={queryClient}><AuthProvider><DirectAiChartDataPrewarm /><SettingsProvider><AssetModeProvider><AnalysisSelectionProvider><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><AppShell><RouteErrorBoundary><RootRouter /></RouteErrorBoundary></AppShell></WouterRouter><Toaster /></TooltipProvider></AnalysisSelectionProvider></AssetModeProvider></SettingsProvider></AuthProvider></QueryClientProvider></AppErrorBoundary>;
}

export default App;
