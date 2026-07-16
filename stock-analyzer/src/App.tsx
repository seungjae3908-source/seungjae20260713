import { lazy, Suspense, useEffect } from 'react';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SettingsProvider } from '@/lib/settings';
import { ensureWatchlistSync } from '@/lib/watchlist-sync';
import { AuthProvider, useAuth } from '@/lib/auth';
import { AppBackground } from '@/components/app-background';
import { AssetModeProvider } from '@/lib/asset-mode';
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
const StocksPage = lazy(() => import('@/pages/stocks'));
const ThemesPage = lazy(() => import('@/pages/themes'));
const LearnPage = lazy(() => import('@/pages/learn'));
const MorePage = lazy(() => import('@/pages/more'));
const PortfolioPage = lazy(() => import('@/pages/portfolio'));
const AccountPage = lazy(() => import('@/pages/account'));
const AdminPage = lazy(() => import('@/pages/admin'));
const InstallPage = lazy(() => import('@/pages/install'));
const NotFound = lazy(() => import('@/pages/not-found'));

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
        <Route path="/assets" component={PortfolioPage} />
        <Route path="/settings" component={MorePage} />

        {/* 기존 주소는 즐겨찾기와 이전 설치본 호환을 위해 유지합니다. */}
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
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function RootRouter() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Switch>
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
