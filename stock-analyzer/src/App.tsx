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
import { OfflineBanner } from '@/components/offline-banner';
import { PageFallback } from '@/components/data-state';
import { AutoBackupSync } from '@/lib/backup-sync';
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
const NotFound = lazy(() => import('@/pages/not-found'));
const Phase4RiskE2EPage = lazy(() => import('@/pages/phase4-risk-e2e'));
const Phase5BacktestE2EPage = lazy(() => import('@/pages/phase5-backtest-e2e'));

const phase4E2EEnabled = import.meta.env.VITE_PHASE4_E2E === 'true';
const phase5E2EEnabled = import.meta.env.VITE_PHASE5_E2E === 'true';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      staleTime: 0,
      gcTime: 30 * 60 * 1000,
      retry: 2,
    },
  },
});

function useCryptoRedirect(target: (symbol?: string) => string, symbol?: string) {
  const mode = useAssetMode();
  const [, navigate] = useLocation();
  useEffect(() => {
    mode.setAsset('coin');
    navigate(target(symbol), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function CryptoHomeRedirect() {
  useCryptoRedirect(() => '/home');
  return <PageFallback />;
}

function CryptoSearchRedirect() {
  useCryptoRedirect(() => '/stocks');
  return <PageFallback />;
}

function CryptoDetailRedirect() {
  const [, params] = useRoute('/crypto/:symbol') as [boolean, { symbol?: string } | null];
  useCryptoRedirect(
    (symbol) => `/stock-info?asset=coin&coinMarket=spot&symbol=${encodeURIComponent(String(symbol ?? 'BTC').toUpperCase())}`,
    params?.symbol,
  );
  return <PageFallback />;
}

function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative h-[100dvh] w-full overflow-hidden text-foreground">
      <AppBackground />
      <div className="relative z-10 mx-auto flex h-[100dvh] min-h-0 max-w-md flex-col overflow-hidden bg-background">
        <OfflineBanner />
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

function ApprovedRouter() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Switch>
        <Route path="/" component={HomePage} />
        <Route path="/home" component={HomePage} />
        <Route path="/stocks" component={StocksPage} />
        <Route path="/auto-trading" component={ScannerPage} />
        <Route path="/stock-info" component={StockInfoPage} />
        <Route path="/market-overview" component={MarketOverviewPage} />
        <Route path="/assets" component={PortfolioPage} />
        <Route path="/settings" component={MorePage} />

        <Route path="/search" component={SearchPage} />
        <Route path="/scanner" component={ScannerPage} />
        <Route path="/themes" component={ThemesPage} />
        <Route path="/learn" component={LearnPage} />
        <Route path="/watchlist" component={WatchlistPage} />
        <Route path="/alerts" component={AlertsPage} />
        <Route path="/portfolio" component={PortfolioPage} />
        <Route path="/account" component={AccountPage} />
        <Route path="/admin" component={AdminPage} />
        <Route path="/more" component={MorePage} />
        <Route path="/stock/:ticker" component={DetailPage} />
        <Route path="/recommendations" component={RecommendationsPage} />
        <Route path="/backtests" component={BacktestsPage} />
        <Route path="/crypto" component={CryptoHomeRedirect} />
        <Route path="/crypto/search" component={CryptoSearchRedirect} />
        <Route path="/crypto/:symbol" component={CryptoDetailRedirect} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function RootRouter() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Switch>
        {phase4E2EEnabled ? <Route path="/__phase4-risk-e2e" component={Phase4RiskE2EPage} /> : null}
        {phase5E2EEnabled ? <Route path="/__phase5-backtest-e2e" component={Phase5BacktestE2EPage} /> : null}
        <Route path="/install" component={InstallPage} />
        <Route component={AuthenticatedApp} />
      </Switch>
    </Suspense>
  );
}

function AuthenticatedApp() {
  const auth = useAuth();

  useEffect(() => {
    if (auth.isApproved) ensureWatchlistSync();
  }, [auth.isApproved]);

  if (auth.loading) return <PageFallback />;

  if (!auth.configured || !auth.isApproved) {
    return (
      <Suspense fallback={<PageFallback />}>
        <AccountPage />
      </Suspense>
    );
  }

  return <>
    <AutoBackupSync />
    <ApprovedRouter />
  </>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <SettingsProvider>
          <AssetModeProvider>
            <TooltipProvider>
              <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
                <AppShell>
                  <RootRouter />
                </AppShell>
              </WouterRouter>
              <Toaster />
            </TooltipProvider>
          </AssetModeProvider>
        </SettingsProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
