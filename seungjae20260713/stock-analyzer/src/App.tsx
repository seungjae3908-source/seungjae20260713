import { lazy, Suspense, useEffect } from 'react';
import { Route, Switch, Router as WouterRouter, useLocation, useRoute } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SettingsProvider } from '@/lib/settings';
import { ensureWatchlistSync, resetWatchlistSync } from '@/lib/watchlist-sync';
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
const StocksPage = lazy(() => import('@/pages/stocks'));
const ThemesPage = lazy(() => import('@/pages/themes'));
const LearnPage = lazy(() => import('@/pages/learn'));
const MorePage = lazy(() => import('@/pages/more'));
const PortfolioPage = lazy(() => import('@/pages/portfolio'));
const AccountPage = lazy(() => import('@/pages/account'));
const AdminPage = lazy(() => import('@/pages/admin'));
const InstallPage = lazy(() => import('@/pages/install'));
const RecommendationsPage = lazy(() => import('@/pages/recommendations'));
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

// /crypto* 경로: 자산 모드를 코인으로 전환한 뒤 기존 코인 화면으로 이동한다.
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

function NavigationReset() {
  const [location] = useLocation();
  useEffect(() => {
    const reset = () => {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      document.documentElement.scrollLeft = 0;
      document.querySelectorAll<HTMLElement>('.overflow-y-auto, .overflow-auto').forEach((element) => {
        element.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      });
      document.querySelectorAll<HTMLElement>('.overflow-x-auto').forEach((element) => {
        element.scrollLeft = 0;
      });
    };
    const first = window.requestAnimationFrame(() => {
      reset();
      window.requestAnimationFrame(reset);
    });
    return () => window.cancelAnimationFrame(first);
  }, [location]);
  return null;
}

function ApprovedRouter() {
  return (
    <Suspense fallback={<PageFallback />}>
	  <NavigationReset />
      <Switch>
        <Route path="/" component={HomePage} />
        <Route path="/home" component={HomePage} />
        <Route path="/stocks" component={StocksPage} />
        <Route path="/auto-trading">{() => <RoleGate admin><ScannerPage /></RoleGate>}</Route>
        <Route path="/stock-info" component={StockInfoPage} />
        <Route path="/assets" component={PortfolioPage} />
        <Route path="/settings" component={MorePage} />

        {/* 기존 주소는 즐겨찾기와 이전 설치본 호환을 위해 유지합니다. */}
        <Route path="/search" component={SearchPage} />
        <Route path="/scanner">{() => <RoleGate><ScannerPage /></RoleGate>}</Route>
        <Route path="/themes">{() => <RoleGate><ThemesPage /></RoleGate>}</Route>
        <Route path="/learn" component={LearnPage} />
        <Route path="/watchlist" component={WatchlistPage} />
        <Route path="/alerts" component={AlertsPage} />
        <Route path="/portfolio" component={PortfolioPage} />
        <Route path="/account" component={AccountPage} />
        <Route path="/admin">{() => <RoleGate admin><AdminPage /></RoleGate>}</Route>
        <Route path="/more" component={MorePage} />
        <Route path="/stock/:ticker" component={DetailPage} />
        <Route path="/recommendations">{() => <RoleGate><RecommendationsPage /></RoleGate>}</Route>
        {/* 코인 전용 경로 — 기존 코인 화면(자산 모드 코인)으로 연결한다. */}
        <Route path="/crypto" component={CryptoHomeRedirect} />
        <Route path="/crypto/search" component={CryptoSearchRedirect} />
        <Route path="/crypto/:symbol" component={CryptoDetailRedirect} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function RoleGate({ children, admin = false }: { children: React.ReactNode; admin?: boolean }) {
  const auth = useAuth();
  const [, navigate] = useLocation();
  const allowed = admin ? auth.isAdmin : auth.isFullMember;
  if (allowed) return <>{children}</>;
  return <div className="flex h-full items-center justify-center p-6"><div className="w-full rounded-3xl border border-card-border bg-card p-6 text-left"><h1 className="text-lg font-black">접근 권한이 없습니다.</h1><p className="mt-2 break-keep text-sm text-muted-foreground">{admin ? '관리자만 사용할 수 있는 기능입니다.' : '정회원 이상만 사용할 수 있는 기능입니다.'}</p><button type="button" onClick={() => navigate('/')} className="mt-5 rounded-2xl bg-primary px-4 py-3 text-sm font-black text-primary-foreground">홈으로 이동</button></div></div>;
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
    if (auth.isApproved && auth.profile?.id) {
      void ensureWatchlistSync(auth.profile.id).catch((error) => {
        console.error('[watchlist-sync] initial load failed:', error);
      });
    } else {
      resetWatchlistSync();
    }
  }, [auth.isApproved, auth.profile?.id]);

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
