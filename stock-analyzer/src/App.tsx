import { lazy, Suspense, useEffect } from 'react';
import { Route, Switch, Router as WouterRouter, useLocation, useRoute } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SettingsProvider } from '@/lib/settings';
import { ensureWatchlistSync } from '@/lib/watchlist-sync';
import { AuthProvider, useAuth } from '@/lib/auth';
import { AppBackground } from '@/components/app-background';
import { AssetModeProvider, useAssetMode } from '@/lib/asset-mode';
import { AnalysisSelectionProvider } from '@/lib/analysis-selection';
import { OfflineBanner } from '@/components/offline-banner';
import { PageFallback } from '@/components/data-state';
import { AutoBackupSync } from '@/lib/backup-sync';
import { CapabilityGate } from '@/components/capability-gate';
import type { MemberCapability } from '../../packages/member-access/src/index.js';
import HomePage from '@/pages/home';
import SearchPage from '@/pages/search';

const DetailPage = lazy(() => import('@/pages/detail'));
const WatchlistPage = lazy(() => import('@/pages/watchlist'));
const AlertsPage = lazy(() => import('@/pages/alerts'));
const ScannerPage = lazy(() => import('@/pages/scanner'));
const StockInfoPage = lazy(() => import('@/pages/stock-info'));
const MarketOverviewPage = lazy(() => import('@/pages/market-overview'));
const StocksPage = lazy(() => import('@/pages/stocks'));
const ThemesPage = lazy(() => import('@/pages/themes'));
const LearnPage = lazy(() => import('@/pages/learn'));
const MorePage = lazy(() => import('@/pages/more'));
const PortfolioPage = lazy(() => import('@/pages/portfolio'));
const AccountPage = lazy(() => import('@/pages/account'));
const AdminPage = lazy(() => import('@/pages/admin'));
const InstallPage = lazy(() => import('@/pages/install'));
const RecommendationsPage = lazy(() => import('@/pages/recommendations'));
const BacktestsPage = lazy(() => import('@/pages/backtests'));
const PaperTradingPage = lazy(() => import('@/pages/paper-trading'));
const NotFound = lazy(() => import('@/pages/not-found'));
const Phase4RiskE2EPage = lazy(() => import('@/pages/phase4-risk-e2e'));
const Phase5BacktestE2EPage = lazy(() => import('@/pages/phase5-backtest-e2e'));
const Phase6PaperTradingE2EPage = lazy(() => import('@/pages/phase6-paper-trading-e2e'));
const Phase7JournalSyncE2EPage = lazy(() => import('@/pages/phase7-journal-sync-e2e'));
const Phase8ReleaseCandidateE2EPage = lazy(() => import('@/pages/phase8-release-candidate-e2e'));
const Phase9AiReviewE2EPage = lazy(() => import('@/pages/phase9-ai-review-e2e'));
const AiChartPage = lazy(() => import('@/pages/ai-chart'));
const AiChatPage = lazy(() => import('@/pages/ai-chat'));
const TechnicalWorkspacePage = lazy(() => import('@/pages/technical-workspace'));
const Phase12TradeAutomationE2EPage = lazy(() => import('@/pages/phase12-trade-automation-e2e'));

const phase4E2EEnabled = import.meta.env.VITE_PHASE4_E2E === 'true';
const phase5E2EEnabled = import.meta.env.VITE_PHASE5_E2E === 'true';
const phase6E2EEnabled = import.meta.env.VITE_PHASE6_E2E === 'true';
const phase7E2EEnabled = import.meta.env.VITE_PHASE7_E2E === 'true';
const phase8E2EEnabled = import.meta.env.VITE_PHASE8_E2E === 'true';
const phase9E2EEnabled = import.meta.env.VITE_PHASE9_E2E === 'true';
const phase11E2EEnabled = import.meta.env.VITE_PHASE11_E2E === 'true';
const phase12E2EEnabled = import.meta.env.VITE_PHASE12_E2E === 'true';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true, refetchOnReconnect: true, staleTime: 0, gcTime: 30 * 60 * 1000, retry: 2 } },
});

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
  const [, params] = useRoute('/crypto/:symbol') as [boolean, { symbol?: string } | null];
  useCryptoRedirect((symbol) => `/stock-info?asset=coin&coinMarket=spot&symbol=${encodeURIComponent(String(symbol ?? 'BTC').toUpperCase())}`, params?.symbol);
  return <PageFallback />;
}

function AppShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const wide = location.startsWith('/scanner') || location.startsWith('/ai-chart') || location.startsWith('/__phase11-technical-workspace-e2e');
  return <div className="relative h-[100dvh] w-full overflow-hidden text-foreground"><AppBackground /><div className={`relative z-10 mx-auto flex h-[100dvh] min-h-0 flex-col overflow-hidden bg-background ${wide ? 'max-w-screen-2xl' : 'max-w-md'}`}><OfflineBanner /><div className="min-h-0 flex-1 overflow-hidden">{children}</div></div></div>;
}

function gated(capability: MemberCapability, child: React.ReactNode) {
  return <CapabilityGate capability={capability}>{child}</CapabilityGate>;
}

function ScannerAccess() { return gated('canAccessRiskPreview', <TechnicalWorkspacePage />); }
function AiChartAccess() { return gated('canAccessRiskPreview', <AiChartPage />); }
function AiChatAccess() { return gated('canAccessBasicInfo', <AiChatPage />); }
function RecommendationsAccess() { return gated('canAccessRiskPreview', <RecommendationsPage />); }
function PortfolioAccess() { return gated('canAccessPaperTrading', <PortfolioPage />); }
function BacktestsAccess() { return gated('canAccessBacktests', <BacktestsPage />); }
function PaperTradingAccess() { return gated('canAccessPaperTrading', <PaperTradingPage />); }
function AdminAccess() { return gated('canManageMembers', <AdminPage />); }
function StockInfoAccess() {
  const [location] = useLocation();
  const query = location.includes('?') ? location.slice(location.indexOf('?') + 1) : window.location.search.slice(1);
  const params = new URLSearchParams(query);
  if (params.get('asset') === 'coin') {
    return gated(params.get('coinMarket') === 'futures' ? 'canAccessFutures' : 'canAccessSpot', <StockInfoPage />);
  }
  return gated('canAccessBasicInfo', <StockInfoPage />);
}

function ApprovedRouter() {
  return <Suspense fallback={<PageFallback />}><Switch>
    <Route path="/" component={HomePage} />
    <Route path="/home" component={HomePage} />
    <Route path="/stocks" component={StocksPage} />
    <Route path="/auto-trading" component={ScannerAccess} />
    <Route path="/stock-info" component={StockInfoAccess} />
    <Route path="/market-overview" component={MarketOverviewPage} />
    <Route path="/assets" component={PortfolioAccess} />
    <Route path="/settings" component={MorePage} />
    <Route path="/search" component={SearchPage} />
    <Route path="/scanner" component={ScannerAccess} />
    <Route path="/ai-chart" component={AiChartAccess} />
    <Route path="/ai-chat" component={AiChatAccess} />
    <Route path="/themes" component={ThemesPage} />
    <Route path="/learn" component={LearnPage} />
    <Route path="/watchlist" component={WatchlistPage} />
    <Route path="/alerts" component={AlertsPage} />
    <Route path="/portfolio" component={PortfolioAccess} />
    <Route path="/account" component={AccountPage} />
    <Route path="/admin" component={AdminAccess} />
    <Route path="/more" component={MorePage} />
    <Route path="/stock/:ticker" component={DetailPage} />
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
    {phase11E2EEnabled ? <Route path="/__phase11-ai-workspace-e2e" component={ScannerRoute} /> : null}
    {phase11E2EEnabled ? <Route path="/__phase11-ai-chat-e2e" component={AiChatPage} /> : null}
    {phase11E2EEnabled ? <Route path="/__phase11-technical-workspace-e2e" component={TechnicalWorkspacePage} /> : null}
    {phase12E2EEnabled ? <Route path="/__phase12-trade-automation-e2e" component={Phase12TradeAutomationE2EPage} /> : null}
    {phase11E2EEnabled ? <Route path="/ai-chart" component={AiChartRoute} /> : null}
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

function AuthenticatedApp() {
  const auth = useAuth();
  useEffect(() => { if (auth.isApproved) ensureWatchlistSync(); }, [auth.isApproved]);
  if (auth.loading) return <PageFallback />;
  if (!auth.configured || !auth.isApproved) return <Suspense fallback={<PageFallback />}><AccountPage /></Suspense>;
  return <><AutoBackupSync /><ApprovedRouter /></>;
}

function App() {
  return <QueryClientProvider client={queryClient}><AuthProvider><SettingsProvider><AssetModeProvider><AnalysisSelectionProvider><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><AppShell><RootRouter /></AppShell></WouterRouter><Toaster /></TooltipProvider></AnalysisSelectionProvider></AssetModeProvider></SettingsProvider></AuthProvider></QueryClientProvider>;
}

export default App;
