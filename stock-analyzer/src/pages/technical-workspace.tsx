import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { CenteredPageHeader } from '@/components/centered-page-header';
import { ResponsiveTabs } from '@/components/responsive-tabs';
import { ScannerApprovalComposer } from '@/components/scanner-approval-composer';
import { UiBuilderSignalScannerLayout } from '@/components/ui-builder-signal-scanner-layout';
import { ADAPTIVE_VIEWPORT_BREAKPOINTS } from '@/lib/adaptive-layout';
import { useAnalysisSelection } from '@/lib/analysis-selection';
import { useAuth } from '@/lib/auth';
import { getPortfolioChartOverlay } from '@/lib/portfolio-overlay';
import {
  loadUiBuilderSignalScannerLayout,
  readStoredUiBuilderSignalScannerLayout,
  SIGNAL_SCANNER_INTEGRATION_LAYOUTS,
} from '@/lib/ui-builder-layout';

const AiChartPage = lazy(() => import('@/pages/ai-chart'));
const AutoTradingPage = lazy(() => import('@/pages/auto-trading'));
const SignalScannerPage = lazy(() => import('@/pages/signal-scanner'));
const BacktestResearchPanel = lazy(() => import('@/components/backtest-research-panel').then((module) => ({
  default: module.BacktestResearchPanel,
})));

type Workspace = 'signal' | 'chart' | 'backtest' | 'trade';
type LoadedScannerLayout = ReturnType<typeof loadUiBuilderSignalScannerLayout>;

const WORKSPACE_TABS = [
  { value: 'signal', label: 'AI 검색기' },
  { value: 'chart', label: 'AI 차트' },
  { value: 'backtest', label: '백테스트' },
  { value: 'trade', label: '자동매매' },
] as const;

const WORKSPACE_TITLES: Record<Workspace, string> = {
  signal: 'AI 검색기',
  chart: 'AI 차트',
  backtest: '백테스트',
  trade: '자동매매',
};

const TECHNICAL_INFO_ITEMS = [
  '검색·차트·백테스트는 읽기·분석 중심 화면이며 권한이 없는 기능은 잠금 상태로 유지됩니다.',
  '자동매매 화면은 권한과 승인 절차가 있는 경우에만 열리며 실거래는 활성화하지 않습니다.',
] as const;

function useDesktopWorkspace() {
  const query = `(min-width: ${ADAPTIVE_VIEWPORT_BREAKPOINTS.desktopMin}px)`;
  const [desktop, setDesktop] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);

  return desktop;
}

function WorkspaceFallback() {
  return (
    <div aria-busy="true" aria-label="기술 화면 준비 중" className="h-full overflow-hidden p-3">
      <div className="mx-auto h-full max-w-6xl animate-pulse rounded-2xl border border-card-border bg-card/60" />
    </div>
  );
}

function formatPositionNumber(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return '미확인';
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: digits }).format(value);
}

function PositionSummarySurface() {
  const { selection } = useAnalysisSelection();
  const ticker = selection?.ticker ?? '';
  const [overlay, setOverlay] = useState(() => ticker ? getPortfolioChartOverlay(ticker) : null);

  useEffect(() => {
    const update = () => setOverlay(ticker ? getPortfolioChartOverlay(ticker) : null);
    update();
    window.addEventListener('storage', update);
    window.addEventListener('sa-portfolio-overlay-updated', update);
    return () => {
      window.removeEventListener('storage', update);
      window.removeEventListener('sa-portfolio-overlay-updated', update);
    };
  }, [ticker]);

  if (!selection) {
    return (
      <section data-testid="ui-builder-position-summary-empty" className="min-w-0 rounded-2xl border border-card-border bg-card p-3 text-center shadow-sm sm:p-4">
        <h2 className="text-sm font-bold">내 포지션</h2>
        <p className="mt-2 break-keep text-xs font-medium leading-5 text-muted-foreground">신호 종목을 선택하면 포트폴리오의 보유 정보를 읽기 전용으로 표시합니다.</p>
      </section>
    );
  }

  if (!overlay) {
    return (
      <section data-testid="ui-builder-position-summary-none" className="min-w-0 rounded-2xl border border-card-border bg-card p-3 text-center shadow-sm sm:p-4">
        <h2 className="text-sm font-bold">내 포지션</h2>
        <p className="mt-2 break-words text-xs font-semibold">{selection.displayName} · {selection.ticker}</p>
        <p className="mt-1 break-keep text-xs font-medium leading-5 text-muted-foreground">동기화된 보유 기록이 없습니다.</p>
      </section>
    );
  }

  const marketValue = overlay.currentPrice == null ? null : overlay.currentPrice * overlay.quantity;
  const cost = overlay.averagePrice * overlay.quantity;
  const pnl = marketValue == null ? null : marketValue - cost;

  return (
    <section data-testid="ui-builder-position-summary" className="min-w-0 rounded-2xl border border-card-border bg-card p-3 shadow-sm sm:p-4">
      <div className="text-center">
        <h2 className="text-sm font-bold">내 포지션</h2>
        <p className="mt-1 truncate text-xs font-medium text-muted-foreground">{overlay.name} · {overlay.ticker}</p>
        <span className="mt-2 inline-flex rounded-full border border-card-border px-2.5 py-1 text-xs font-semibold">읽기 전용</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
        <PositionMetric label="평단" value={formatPositionNumber(overlay.averagePrice)} />
        <PositionMetric label="현재가" value={formatPositionNumber(overlay.currentPrice)} />
        <PositionMetric label="수량" value={formatPositionNumber(overlay.quantity, 6)} />
        <PositionMetric label="평가액" value={formatPositionNumber(marketValue)} />
        <PositionMetric label="손익" value={formatPositionNumber(pnl)} />
        <PositionMetric label="수익률" value={overlay.rate == null ? '미확인' : `${overlay.rate >= 0 ? '+' : ''}${formatPositionNumber(overlay.rate)}%`} />
      </div>
    </section>
  );
}

function PositionMetric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-xl bg-background p-2 text-center"><p className="text-xs font-medium text-muted-foreground">{label}</p><strong className="mt-1 block break-words font-semibold tabular-nums">{value}</strong></div>;
}

function TradeReviewSurface() {
  const { selection } = useAnalysisSelection();
  if (!selection) {
    return (
      <section data-testid="ui-builder-trade-review-empty" className="min-w-0 rounded-2xl border border-card-border bg-card p-3 text-center shadow-sm sm:p-4">
        <h2 className="text-sm font-bold">거래 검토</h2>
        <p className="mt-2 break-keep text-xs font-medium leading-5 text-muted-foreground">검색 결과에서 종목을 선택하면 기존 승인형 Paper 검토 흐름을 사용할 수 있습니다.</p>
      </section>
    );
  }
  return <ScannerApprovalComposer selection={selection} />;
}

function ScannerSurface({ desktop, showSectionHeader }: { desktop: boolean; showSectionHeader: boolean }) {
  return (
    <div className={[
      'h-full min-h-0 min-w-0 overflow-hidden',
      showSectionHeader
        ? '[&_main>div>header:first-child]:rounded-2xl [&_main>div>header:first-child]:p-3 [&_main>div>header:first-child_p]:hidden [&_main>div>header:first-child_h1]:text-center'
        : '[&_main>div>header:first-child]:hidden',
    ].join(' ')}>
      <SignalScannerPage embedded={desktop} />
    </div>
  );
}

function MobileWorkspace({ workspace }: { workspace: Workspace }) {
  return (
    <div role="tabpanel" data-testid={`technical-mobile-panel-${workspace}`} className="min-h-0 min-w-0 flex-1 overflow-hidden">
      <Suspense fallback={<WorkspaceFallback />}>
        {workspace === 'signal' ? <ScannerSurface desktop={false} showSectionHeader={false} /> : null}
        {workspace === 'chart' ? <AiChartPage embedded /> : null}
        {workspace === 'backtest' ? <BacktestResearchPanel compact /> : null}
        {workspace === 'trade' ? <AutoTradingPage embedded /> : null}
      </Suspense>
    </div>
  );
}

function DesktopWorkspace({
  workspace,
  builderLayout,
  canAccessRiskPreview,
}: {
  workspace: Workspace;
  builderLayout: LoadedScannerLayout;
  canAccessRiskPreview: boolean;
}) {
  if (workspace === 'chart') return <Suspense fallback={<WorkspaceFallback />}><AiChartPage embedded /></Suspense>;
  if (workspace === 'backtest') return <Suspense fallback={<WorkspaceFallback />}><BacktestResearchPanel compact /></Suspense>;
  if (workspace === 'trade') return <Suspense fallback={<WorkspaceFallback />}><AutoTradingPage embedded /></Suspense>;
  if (!canAccessRiskPreview) {
    return <Suspense fallback={<WorkspaceFallback />}><ScannerSurface desktop showSectionHeader /></Suspense>;
  }

  const fallback = (
    <div className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(360px,0.88fr)_minmax(0,2fr)] overflow-hidden bg-background xl:grid-cols-[minmax(420px,0.82fr)_minmax(0,2fr)]">
      <aside className="min-h-0 min-w-0 overflow-hidden border-r border-card-border"><ScannerSurface desktop showSectionHeader /></aside>
      <section className="min-h-0 min-w-0 overflow-hidden"><AiChartPage embedded /></section>
    </div>
  );

  if (builderLayout.source !== 'builder') return <Suspense fallback={<WorkspaceFallback />}>{fallback}</Suspense>;

  return (
    <Suspense fallback={<WorkspaceFallback />}>
      <UiBuilderSignalScannerLayout
        layout={builderLayout.layout}
        scanner={<ScannerSurface desktop showSectionHeader />}
        chart={<AiChartPage embedded />}
        position={<PositionSummarySurface />}
        tradeReview={<TradeReviewSurface />}
        fallback={fallback}
      />
    </Suspense>
  );
}

export default function TechnicalWorkspacePage() {
  const desktop = useDesktopWorkspace();
  const auth = useAuth();
  const [location] = useLocation();
  const [workspace, setWorkspace] = useState<Workspace>('signal');
  const phase11FullCapabilityFixture = import.meta.env.VITE_PHASE11_E2E === 'true'
    && location.startsWith('/__phase11-technical-workspace-e2e');
  const canAccessRiskPreview = phase11FullCapabilityFixture || auth.can('canAccessRiskPreview');
  const canAccessBacktests = phase11FullCapabilityFixture || auth.can('canAccessBacktests');
  const canPlaceOrders = phase11FullCapabilityFixture || auth.can('canPlaceOrders');

  const workspaceAllowed = (value: Workspace) => {
    if (value === 'signal') return true;
    if (value === 'chart') return canAccessRiskPreview;
    if (value === 'backtest') return canAccessBacktests;
    return canPlaceOrders;
  };

  const workspaceTabs = WORKSPACE_TABS.map((tab) => {
    const disabled = !workspaceAllowed(tab.value);
    const disabledReason = tab.value === 'chart'
      ? 'AI 차트 권한이 필요합니다.'
      : tab.value === 'backtest'
        ? '백테스트 권한이 필요합니다.'
        : tab.value === 'trade'
          ? '주문 승인 권한이 필요합니다.'
          : undefined;
    return { ...tab, disabled, disabledReason };
  });

  useEffect(() => {
    if (!workspaceAllowed(workspace)) setWorkspace('signal');
  }, [canAccessBacktests, canAccessRiskPreview, canPlaceOrders, workspace]);

  const desktopLayout = useMemo(() => {
    const raw = readStoredUiBuilderSignalScannerLayout('desktop');
    return loadUiBuilderSignalScannerLayout(raw, 'desktop', SIGNAL_SCANNER_INTEGRATION_LAYOUTS.desktop);
  }, []);

  if (location.startsWith('/auto-trading')) return <Suspense fallback={<WorkspaceFallback />}><AutoTradingPage /></Suspense>;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background" data-testid="technical-workspace">
      <h1 className="sr-only sm:hidden" data-testid="technical-mobile-accessible-title">{WORKSPACE_TITLES[workspace]}</h1>
      <div className="hidden sm:block" data-testid="technical-desktop-header">
        <CenteredPageHeader
          title={WORKSPACE_TITLES[workspace]}
          infoTitle="기술 기능 안내"
          infoItems={[...TECHNICAL_INFO_ITEMS]}
        />
      </div>
      <div className="shrink-0 border-b border-card-border bg-background px-2 py-2 sm:px-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <ResponsiveTabs
              value={workspace}
              options={workspaceTabs}
              onChange={(nextWorkspace) => {
                if (workspaceAllowed(nextWorkspace)) setWorkspace(nextWorkspace);
              }}
              ariaLabel="기술 기능 탭"
              testId={desktop ? 'technical-desktop-tabs' : 'technical-mobile-tabs'}
              compact
            />
          </div>
          <details className="group relative shrink-0 sm:hidden">
            <summary
              aria-label="기술 기능 안내 보기"
              className="flex h-11 w-11 cursor-pointer list-none items-center justify-center rounded-xl border border-card-border bg-background text-muted-foreground transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
              data-testid="technical-mobile-help"
            >
              <Info className="h-4 w-4" aria-hidden="true" />
            </summary>
            <div className="absolute right-0 z-50 mt-2 w-[min(82vw,320px)] rounded-2xl border border-card-border bg-background p-4 text-left shadow-xl">
              <p className="text-center text-sm font-semibold text-foreground">기술 기능 안내</p>
              <ul className="mt-2 space-y-1.5 text-xs font-medium leading-5 text-muted-foreground">
                {TECHNICAL_INFO_ITEMS.map((item) => <li key={item}>• {item}</li>)}
              </ul>
            </div>
          </details>
        </div>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {desktop ? (
          <DesktopWorkspace
            workspace={workspace}
            builderLayout={desktopLayout}
            canAccessRiskPreview={canAccessRiskPreview}
          />
        ) : <MobileWorkspace workspace={workspace} />}
      </div>
      <BottomNav />
    </div>
  );
}
