import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import {
	Route,
	Switch,
	Router as WouterRouter,
	useLocation,
	useRoute,
} from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SettingsProvider } from '@/lib/settings';
import { ensureWatchlistSync } from '@/lib/watchlist-sync';
import { AuthProvider, useAuth } from '@/lib/auth';
import {
	featureRequiredGradeLabel,
	memberGradeLabel,
	useMemberPermissions,
	type AppFeature,
} from '@/lib/permissions';
import { AppBackground } from '@/components/app-background';
import { AssetModeProvider, useAssetMode } from '@/lib/asset-mode';
import { OfflineBanner } from '@/components/offline-banner';
import { PageFallback } from '@/components/data-state';
import { AutoBackupSync } from '@/lib/backup-sync';
import { ApiError } from '@/lib/api';
import HomePage from '@/pages/home';
import SearchPage from '@/pages/search';
import DetailPage from '@/pages/detail';

const WatchlistPage = lazy(() => import('@/pages/watchlist'));
const AlertsPage = lazy(() => import('@/pages/alerts'));
const ScannerPage = lazy(() => import('@/pages/scanner'));
const TechPage = lazy(() => import('@/pages/tech'));
const SignalScanPage = lazy(() => import('@/pages/signal-scan'));
const AutoTradePage = lazy(() => import('@/pages/auto-trade'));
const ChartRelayPage = lazy(() => import('@/pages/chart-relay'));
const ChartBroadcastPage = lazy(() => import('@/components/chart-broadcast'));
const MarketAnalysisPage = lazy(() => import('@/pages/market-analysis'));
const StockInfoPage = lazy(() => import('@/pages/stock-info'));
const StocksPage = lazy(() => import('@/pages/stocks'));
const LearnPage = lazy(() => import('@/pages/learn'));
const RankingPage = lazy(() => import('@/pages/ranking'));
const MorePage = lazy(() => import('@/pages/more'));
const PortfolioPage = lazy(() => import('@/pages/portfolio'));
const AssetEvaluationPage = lazy(() => import('@/pages/asset-evaluation'));
const WatchlistAssetsPage = lazy(() => import('@/pages/watchlist-assets'));
const PortfolioCashPage = lazy(() => import('@/pages/portfolio-cash'));
const PortfolioSimulatePage = lazy(() => import('@/pages/portfolio-simulate'));
const PortfolioPlanPage = lazy(() => import('@/pages/portfolio-plan'));
const AccountPage = lazy(() => import('@/pages/account'));
const AdminPage = lazy(() => import('@/pages/admin'));
const AdminUiBuilderPage = lazy(() => import('@/pages/admin-ui-builder'));
const InstallPage = lazy(() => import('@/pages/install'));
const RecommendationsPage = lazy(() => import('@/pages/recommendations'));
const NotFound = lazy(() => import('@/pages/not-found'));

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			// 화면 복귀마다 전체 API를 다시 호출하지 않고, 짧은 신선도 구간 동안
			// 직전 데이터를 유지해 로딩 깜빡임과 공급자 요청 폭주를 막습니다.
			refetchOnWindowFocus: false,
			refetchOnReconnect: true,
			staleTime: 30_000,
			gcTime: 30 * 60 * 1000,
			placeholderData: (previousData: unknown) => previousData,
			retry: (failureCount, error) => {
				if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 425 && error.status !== 429) {
					return false;
				}
				return failureCount < 1;
			},
			retryDelay: 1_000,
		},
	},
});

function useCryptoRedirect(
	target: (symbol?: string) => string,
	symbol?: string,
) {
	const mode = useAssetMode();
	const [, navigate] = useLocation();

	useEffect(() => {
		mode.setAsset('coin');
		navigate(target(symbol), { replace: true });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
}

function CryptoHomeRedirect() {
	useCryptoRedirect(() => '/scanner');
	return <PageFallback />;
}

function CryptoSearchRedirect() {
	useCryptoRedirect(() => '/stocks');
	return <PageFallback />;
}

function CryptoDetailRedirect() {
	const [, params] = useRoute('/crypto/:symbol') as [
		boolean,
		{ symbol?: string } | null,
	];

	useCryptoRedirect(
		(symbol) =>
			`/stock-info?asset=coin&coinMarket=spot&symbol=${encodeURIComponent(
				String(symbol ?? 'BTC').toUpperCase(),
			)}`,
		params?.symbol,
	);

	return <PageFallback />;
}

/** 전체 화면 라우트(/stocks/kr 등)를 기존 종목 화면 상태로 연결한다. */
function MarketRouteRedirect({ to }: { to: string }) {
	const [, navigate] = useLocation();

	useEffect(() => {
		navigate(to, { replace: true });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return <PageFallback />;
}

function GlobalBackButton() {
	const [location, navigate] = useLocation();
	const hidden =
		location === '/' ||
		location === '/home' ||
		location.startsWith('/search');

	if (hidden) return null;

	return (
		<button
			type="button"
			aria-label="공통 뒤로가기"
			onClick={() => {
				if (window.history.length > 1) window.history.back();
				else navigate('/home', { replace: true });
			}}
			className="absolute left-3 top-3 z-[90] flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card shadow-sm"
		>
			<ArrowLeft className="h-4 w-4" />
		</button>
	);
}

function AppShell({ children }: { children: ReactNode }) {
	return (
		<div className="relative h-[100dvh] w-full overflow-hidden text-foreground">
			<AppBackground />
			<style>{`.requested-center-text :where(h1,h2,h3,h4,p,span,label,button,input,textarea,select,th,td){text-align:center!important}.requested-center-text input,.requested-center-text textarea{justify-content:center}.requested-center-text [class*="text-left"]{text-align:center!important}`}</style>

			<div className="requested-center-text relative z-10 mx-auto flex h-[100dvh] min-h-0 max-w-md flex-col overflow-hidden bg-background">
				<GlobalBackButton />
				<OfflineBanner />
				<div className="min-h-0 flex-1 overflow-hidden">{children}</div>
			</div>
		</div>
	);
}

function AccessDeniedScreen({ feature }: { feature: AppFeature }) {
	const auth = useAuth();
	const [, navigate] = useLocation();

	return (
		<div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
			<div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-secondary text-3xl">
				🔒
			</div>
			<h1 className="text-xl font-black">이용 권한이 없습니다</h1>
			<p className="text-sm font-bold leading-6 text-muted-foreground">
				이 기능은{' '}
				<span className="text-foreground">
					{featureRequiredGradeLabel(feature)}
				</span>{' '}
				이상만 사용할 수 있습니다.
				<br />
				현재 등급:{' '}
				<span className="text-foreground">{memberGradeLabel(auth.profile)}</span>
			</p>
			<p className="text-xs font-bold text-muted-foreground">
				등급 변경은 관리자에게 문의해 주세요.
			</p>
			<div className="mt-2 grid w-full max-w-xs grid-cols-2 gap-2">
				<button
					type="button"
					onClick={() =>
						window.history.length > 1
							? window.history.back()
							: navigate('/search', { replace: true })
					}
					className="rounded-2xl border border-card-border px-4 py-3 text-sm font-black"
				>
					이전 화면
				</button>
				<button
					type="button"
					onClick={() => navigate('/search', { replace: true })}
					className="rounded-2xl bg-primary px-4 py-3 text-sm font-black text-primary-foreground"
				>
					홈으로
				</button>
			</div>
		</div>
	);
}

function FeatureGate({
	feature,
	children,
}: {
	feature: AppFeature;
	children: ReactNode;
}) {
	const permissions = useMemberPermissions();
	const allowed = permissions.has(feature);

	return allowed ? <>{children}</> : <AccessDeniedScreen feature={feature} />;
}

function RoleHomePage() {
	const permissions = useMemberPermissions();
	return permissions.canUseAdvancedAnalysis ? <HomePage /> : <SearchPage />;
}

function AdvancedStocksPage() {
	return (
		<FeatureGate feature="advancedAnalysis">
			<StocksPage />
		</FeatureGate>
	);
}

function AdvancedStockInfoPage() {
	return (
		<FeatureGate feature="advancedAnalysis">
			<StockInfoPage />
		</FeatureGate>
	);
}

function AdvancedLearnPage() {
	return (
		<FeatureGate feature="advancedAnalysis">
			<LearnPage />
		</FeatureGate>
	);
}

function AdvancedPortfolioPage() {
	return (
		<FeatureGate feature="advancedAnalysis">
			<PortfolioPage />
		</FeatureGate>
	);
}

function AdvancedAssetEvaluationPage() {
	return (
		<FeatureGate feature="advancedAnalysis">
			<AssetEvaluationPage />
		</FeatureGate>
	);
}

function GatedWatchlistAssetsPage() {
	return (
		<FeatureGate feature="watchlist">
			<WatchlistAssetsPage />
		</FeatureGate>
	);
}

function AdvancedPortfolioCashPage() {
	return (
		<FeatureGate feature="advancedAnalysis">
			<PortfolioCashPage />
		</FeatureGate>
	);
}

function AdvancedPortfolioSimulatePage() {
	return (
		<FeatureGate feature="advancedAnalysis">
			<PortfolioSimulatePage />
		</FeatureGate>
	);
}

function AdvancedPortfolioPlanPage() {
	return (
		<FeatureGate feature="advancedAnalysis">
			<PortfolioPlanPage />
		</FeatureGate>
	);
}

function AdvancedRecommendationsPage() {
	return (
		<FeatureGate feature="advancedAnalysis">
			<RecommendationsPage />
		</FeatureGate>
	);
}

function GatedTechPage() {
	return (
		<FeatureGate feature="aiRealtimeChart">
			<TechPage />
		</FeatureGate>
	);
}

function GatedSignalScanPage() {
	return (
		<FeatureGate feature="aiRealtimeChart">
			<SignalScanPage />
		</FeatureGate>
	);
}

function GatedChartRelayPage() {
	return (
		<FeatureGate feature="aiRealtimeChart">
			<ChartRelayPage />
		</FeatureGate>
	);
}

function GatedChartBroadcastPage() {
	return (
		<FeatureGate feature="aiRealtimeChart">
			<ChartBroadcastPage />
		</FeatureGate>
	);
}

function GatedAutoTradePage() {
	return (
		<FeatureGate feature="aiRealtimeChart">
			<AutoTradePage />
		</FeatureGate>
	);
}

function GatedMarketAnalysisPage() {
	return (
		<FeatureGate feature="advancedAnalysis">
			<MarketAnalysisPage />
		</FeatureGate>
	);
}

function AdminAutoTradingPage() {
	return (
		<FeatureGate feature="autoTrading">
			<ScannerPage />
		</FeatureGate>
	);
}

function GatedWatchlistPage() {
	return (
		<FeatureGate feature="watchlist">
			<WatchlistPage />
		</FeatureGate>
	);
}

function GatedAlertsPage() {
	return (
		<FeatureGate feature="signals">
			<AlertsPage />
		</FeatureGate>
	);
}

function AdminOnlyPage() {
	return (
		<FeatureGate feature="admin">
			<AdminPage />
		</FeatureGate>
	);
}

function AdminUiBuilderOnlyPage() {
	return (
		<FeatureGate feature="admin">
			<AdminUiBuilderPage />
		</FeatureGate>
	);
}

function AdvancedCryptoHomeRedirect() {
	return (
		<FeatureGate feature="aiRealtimeChart">
			<CryptoHomeRedirect />
		</FeatureGate>
	);
}

function AdvancedCryptoSearchRedirect() {
	return (
		<FeatureGate feature="advancedAnalysis">
			<CryptoSearchRedirect />
		</FeatureGate>
	);
}

function AdvancedCryptoDetailRedirect() {
	return (
		<FeatureGate feature="advancedAnalysis">
			<CryptoDetailRedirect />
		</FeatureGate>
	);
}

function ApprovedRouter() {
	return (
		<Suspense fallback={<PageFallback />}>
			<Switch>
				<Route path="/" component={RoleHomePage} />
				<Route path="/home" component={RoleHomePage} />
				<Route path="/stocks" component={AdvancedStocksPage} />
				<Route path="/auto-trading" component={AdminAutoTradingPage} />
				<Route path="/stock-info" component={AdvancedStockInfoPage} />
				<Route path="/assets" component={AdvancedPortfolioPage} />
				<Route path="/settings" component={MorePage} />

				<Route path="/search" component={SearchPage} />

				{/* 종목 메뉴 전체 화면 라우트 (주식 국내/해외 · 코인 현물/선물) */}
				<Route path="/stocks/kr">
					{() => <MarketRouteRedirect to="/stocks?asset=stock&market=KR" />}
				</Route>
				<Route path="/stocks/us">
					{() => <MarketRouteRedirect to="/stocks?asset=stock&market=US" />}
				</Route>
				<Route path="/coins/spot">
					{() => <MarketRouteRedirect to="/stocks?asset=coin&coinMarket=spot" />}
				</Route>
				<Route path="/coins/futures">
					{() => <MarketRouteRedirect to="/stocks?asset=coin&coinMarket=futures" />}
				</Route>

				<Route path="/stocks/:market/ranking/:category" component={RankingPage} />
				<Route path="/coins/:market/ranking/:category" component={RankingPage} />
				<Route path="/scanner">{() => <MarketRouteRedirect to="/tech" />}</Route>
				<Route path="/tech" component={GatedTechPage} />
				<Route path="/tech/signal-scan" component={GatedSignalScanPage} />
				<Route path="/tech/signal-scan/:market" component={GatedSignalScanPage} />
				<Route path="/tech/chart-relay" component={GatedChartRelayPage} />
				<Route path="/tech/chart-relay/stockKR" component={GatedChartRelayPage} />
				<Route path="/tech/chart-relay/stockUS" component={GatedChartRelayPage} />
				<Route path="/tech/chart-relay/coinSpot" component={GatedChartRelayPage} />
				<Route path="/tech/chart-relay/coinFutures" component={GatedChartRelayPage} />
				<Route path="/tech/chart-broadcast" component={GatedChartBroadcastPage} />
				<Route path="/tech/auto-trade" component={GatedAutoTradePage} />
				<Route path="/analysis/:market" component={GatedMarketAnalysisPage} />
				<Route path="/learn" component={AdvancedLearnPage} />
				<Route path="/watchlist/assets" component={GatedWatchlistAssetsPage} />
				<Route path="/watchlist" component={GatedWatchlistPage} />
				<Route path="/alerts" component={GatedAlertsPage} />
				<Route path="/portfolio/summary" component={AdvancedAssetEvaluationPage} />
				<Route path="/portfolio/cash" component={AdvancedPortfolioCashPage} />
				<Route
					path="/portfolio/simulate"
					component={AdvancedPortfolioSimulatePage}
				/>
				<Route path="/portfolio/plan" component={AdvancedPortfolioPlanPage} />
				<Route path="/portfolio" component={AdvancedPortfolioPage} />
				<Route path="/account" component={AccountPage} />
				<Route path="/admin" component={AdminOnlyPage} />
				<Route path="/admin/ui-builder" component={AdminUiBuilderOnlyPage} />
				<Route path="/more" component={MorePage} />
				<Route path="/stock/:ticker" component={DetailPage} />
				<Route path="/recommendations" component={AdvancedRecommendationsPage} />
				<Route
					path="/recommendations/:category"
					component={AdvancedRecommendationsPage}
				/>

				<Route path="/crypto" component={AdvancedCryptoHomeRedirect} />
				<Route path="/crypto/search" component={AdvancedCryptoSearchRedirect} />
				<Route path="/crypto/:symbol" component={AdvancedCryptoDetailRedirect} />
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

	// 관심종목 서버 동기화·자동 백업은 정회원 이상 전용 API를 사용하므로
	// 준회원에게는 실행하지 않는다 (불필요한 403 방지).
	useEffect(() => {
		if (auth.isFullMember) ensureWatchlistSync();
	}, [auth.isFullMember]);

	if (auth.loading) return <PageFallback />;

	const recoveryMode = new URLSearchParams(window.location.search).get('recovery');

	if (
		recoveryMode === 'login_name' ||
		recoveryMode === 'password' ||
		recoveryMode === 'email_confirmed'
	) {
		return (
			<Suspense fallback={<PageFallback />}>
				<AccountPage />
			</Suspense>
		);
	}

	if (!auth.configured || !auth.isApproved) {
		return (
			<Suspense fallback={<PageFallback />}>
				<AccountPage />
			</Suspense>
		);
	}

	return (
		<>
			{auth.isFullMember && <AutoBackupSync />}
			<ApprovedRouter />
		</>
	);
}

function App() {
	useEffect(() => {
		const handlePreloadError = (event: Event) => {
			event.preventDefault();
			window.location.reload();
		};

		window.addEventListener('vite:preloadError', handlePreloadError);

		return () => {
			window.removeEventListener('vite:preloadError', handlePreloadError);
		};
	}, []);

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
