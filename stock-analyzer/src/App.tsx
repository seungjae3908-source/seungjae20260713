import { lazy, Suspense, useEffect } from 'react';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SettingsProvider } from '@/lib/settings';
import { ensureWatchlistSync } from '@/lib/watchlist-sync';
import { AuthProvider } from '@/lib/auth';
import { AppBackground } from '@/components/app-background';
import { OfflineBanner } from '@/components/offline-banner';
import { PageFallback } from '@/components/data-state';
import HomePage from '@/pages/home';
import SearchPage from '@/pages/search';

const DetailPage = lazy(() => import('@/pages/detail'));
const WatchlistPage = lazy(() => import('@/pages/watchlist'));
const AlertsPage = lazy(() => import('@/pages/alerts'));
const ScannerPage = lazy(() => import('@/pages/scanner'));
const StockInfoPage = lazy(() => import('@/pages/stock-info'));
const ThemesPage = lazy(() => import('@/pages/themes'));
const LearnPage = lazy(() => import('@/pages/learn'));
const MorePage = lazy(() => import('@/pages/more'));
const PortfolioPage = lazy(() => import('@/pages/portfolio'));
const AccountPage = lazy(() => import('@/pages/account'));
const NotFound = lazy(() => import('@/pages/not-found'));

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			refetchOnWindowFocus: false,
			staleTime: 60 * 1000,
			gcTime: 30 * 60 * 1000,
			retry: 2,
		},
	},
});

function AppShell({ children }: { children: React.ReactNode }) {
	return (
		<div className="relative min-h-[100dvh] w-full text-foreground">
			<AppBackground />

			<div className="relative z-10 mx-auto flex min-h-[100dvh] max-w-md flex-col bg-background">
				<OfflineBanner />
				{children}
			</div>
		</div>
	);
}

function Router() {
	return (
		<Suspense fallback={<PageFallback />}>
			<Switch>
				<Route path="/" component={HomePage} />

				{/* 기존 일반 종목 리스트/검색 화면 */}
				<Route path="/search" component={SearchPage} />

				{/* 종목검색기 = 스캐너 기능 */}
				<Route path="/scanner" component={ScannerPage} />

				{/* 주식정보 = 국내/해외 호재·악재 */}
				<Route path="/stock-info" component={StockInfoPage} />

				{/* 테마종목 = 업종/테마별 분류 */}
				<Route path="/themes" component={ThemesPage} />

				{/* 주식공부 = 지표 학습 */}
				<Route path="/learn" component={LearnPage} />

				<Route path="/watchlist" component={WatchlistPage} />
				<Route path="/alerts" component={AlertsPage} />
				<Route path="/portfolio" component={PortfolioPage} />
				<Route path="/account" component={AccountPage} />
				<Route path="/login" component={AccountPage} />
				<Route path="/more" component={MorePage} />
				<Route path="/settings" component={MorePage} />
				<Route path="/stock/:ticker" component={DetailPage} />
				<Route component={NotFound} />
			</Switch>
		</Suspense>
	);
}

function App() {
	useEffect(() => {
		ensureWatchlistSync();
	}, []);

	return (
		<QueryClientProvider client={queryClient}>
			<AuthProvider>
			<SettingsProvider>
				<TooltipProvider>
					<WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
						<AppShell>
							<Router />
						</AppShell>
					</WouterRouter>

					<Toaster />
				</TooltipProvider>
			</SettingsProvider>
			</AuthProvider>
		</QueryClientProvider>
	);
}

export default App;