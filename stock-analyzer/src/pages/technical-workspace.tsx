import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { CenteredPageHeader } from '@/components/centered-page-header';
import { ResponsiveTabs } from '@/components/responsive-tabs';
import { ScannerApprovalComposer } from '@/components/scanner-approval-composer';
import { UiBuilderSignalScannerLayout } from '@/components/ui-builder-signal-scanner-layout';
import { useAnalysisSelection } from '@/lib/analysis-selection';
import { getPortfolioChartOverlay } from '@/lib/portfolio-overlay';
import {
  loadUiBuilderSignalScannerLayout,
  readStoredUiBuilderSignalScannerLayout,
  SIGNAL_SCANNER_INTEGRATION_LAYOUTS,
  type UiBuilderDeviceClass,
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

function useDesktopWorkspace() {
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

function WorkspaceFallback() {
  return (
    <div aria-busy="true" aria-label="기술 화면 준비 중" className="h-full overflow-hidden p-3">
      <div className="mx-auto h-full max-w-6xl animate-pulse rounded-3xl border border-card-border bg-card/60" />
    </div>
  );
}

function formatPositionNumber(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return '-';
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
      <section data-testid="ui-builder-position-summary-empty" className="min-w-0 rounded-3xl border border-card-border bg-card p-3 shadow-sm sm:p-4">
        <h2 className="text-center text-sm font-black">내 포지션</h2>
        <p className="mt-2 break-keep text-xs leading-5 text-muted-foreground">신호 종목을 선택하면 기존 포트폴리오의 보유 정보를 읽기 전용으로 표시합니다.</p>
      </section>
    );
  }

  if (!overlay) {
    return (
      <section data-testid="ui-builder-position-summary-none" className="min-w-0 rounded-3xl border border-card-border bg-card p-3 shadow-sm sm:p-4">
        <h2 className="text-center text-sm font-black">내 포지션</h2>
        <p className="mt-2 break-words text-xs font-bold">{selection.displayName} · {selection.ticker}</p>
        <p className="mt-1 break-keep text-xs leading-5 text-muted-foreground">동기화된 보유 기록이 없습니다. 읽기 전용 상태만 표시합니다.</p>
      </section>
    );
  }

  const marketValue = overlay.currentPrice == null ? null : overlay.currentPrice * overlay.quantity;
  const cost = overlay.averagePrice * overlay.quantity;
  const pnl = marketValue == null ? null : marketValue - cost;

  return (
    <section data-testid="ui-builder-position-summary" className="min-w-0 rounded-3xl border border-card-border bg-card p-3 shadow-sm sm:p-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><h2 className="text-sm font-black">내 포지션</h2><p className="mt-1 truncate text-[11px] font-bold text-muted-foreground">{overlay.name} · {overlay.ticker}</p></div>
        <span className="shrink-0 rounded-full border border-card-border px-2 py-1 text-[10px] font-black">읽기 전용</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
        <div className="min-w-0 rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">평단</p><strong className="break-words tabular-nums">{formatPositionNumber(overlay.averagePrice)}</strong></div>
        <div className="min-w-0 rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">현재가</p><strong className="break-words tabular-nums">{formatPositionNumber(overlay.currentPrice)}</strong></div>
        <div className="min-w-0 rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">수량</p><strong className="break-words tabular-nums">{formatPositionNumber(overlay.quantity, 6)}</strong></div>
        <div className="min-w-0 rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">평가액</p><strong className="break-words tabular-nums">{formatPositionNumber(marketValue)}</strong></div>
        <div className="min-w-0 rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">손익</p><strong className="break-words tabular-nums">{formatPositionNumber(pnl)}</strong></div>
        <div className="min-w-0 rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">수익률</p><strong className="break-words tabular-nums">{overlay.rate == null ? '-' : `${overlay.rate >= 0 ? '+' : ''}${formatPositionNumber(overlay.rate)}%`}</strong></div>
      </div>
    </section>
  );
}

function TradeReviewSurface() {
  const { selection } = useAnalysisSelection();
  if (!selection) {
    return (
      <section data-testid="ui-builder-trade-review-empty" className="min-w-0 rounded-3xl border border-card-border bg-card p-3 shadow-sm sm:p-4">
        <h2 className="text-center text-sm font-black">거래 검토</h2>
        <p className="mt-2 break-keep text-xs leading-5 text-muted-foreground">검색 결과에서 종목을 선택하면 기존 승인형 Paper 검토 흐름을 사용할 수 있습니다.</p>
      </section>
    );
  }
  return <ScannerApprovalComposer selection={selection} />;
}

function ScannerSurface({ desktop, showSectionHeader, builderMobile = false }: { desktop: boolean; showSectionHeader: boolean; builderMobile?: boolean }) {
  return (
    <div className={[
      'h-full min-h-0 min-w-0 overflow-hidden',
      showSectionHeader
        ? '[&_main>div>header:first-child]:rounded-2xl [&_main>div>header:first-child]:p-3 [&_main>div>header:first-child_p]:hidden [&_main>div>header:first-child_h1]:text-center'
        : '[&_main>div>header:first-child]:hidden',
      builderMobile ? '[&_main]:h-auto [&_main]:overflow-visible [&_main]:pb-0' : '',
    ].join(' ')}>
      <SignalScannerPage embedded={desktop} />
    </div>
  );
}

function MobileSignalWorkspace({ builderLayout }: { builderLayout: LoadedScannerLayout }) {
  if (builderLayout.source !== 'builder') {
    return <ScannerSurface desktop={false} showSectionHeader={builderLayout.issues.length > 0} />;
  }

  return (
    <UiBuilderSignalScannerLayout
      layout={builderLayout.layout}
      scanner={<ScannerSurface desktop={false} showSectionHeader builderMobile />}
      chart={<AiChartPage embedded />}
      position={<PositionSummarySurface />}
      tradeReview={<TradeReviewSurface />}
      fallback={<ScannerSurface desktop={false} showSectionHeader />}
    />
  );
}

function MobileWorkspace({ workspace, builderLayout }: { workspace: Workspace; builderLayout: LoadedScannerLayout }) {
  return (
    <div role="tabpanel" data-testid={`technical-mobile-panel-${workspace}`} className="min-h-0 min-w-0 flex-1 overflow-hidden">
      <Suspense fallback={<WorkspaceFallback />}>
        {workspace === 'signal' ? <MobileSignalWorkspace builderLayout={builderLayout} /> : null}
        {workspace === 'chart' ? <AiChartPage embedded /> : null}
        {workspace === 'backtest' ? <BacktestResearchPanel compact /> : null}
        {workspace === 'trade' ? <AutoTradingPage embedded /> : null}
      </Suspense>
    </div>
  );
}

function DesktopWorkspace({ workspace, builderLayout }: { workspace: Workspace; builderLayout: LoadedScannerLayout }) {
  if (workspace === 'chart') return <Suspense fallback={<WorkspaceFallback />}><AiChartPage embedded /></Suspense>;
  if (workspace === 'backtest') return <Suspense fallback={<WorkspaceFallback />}><BacktestResearchPanel compact /></Suspense>;
  if (workspace === 'trade') return <Suspense fallback={<WorkspaceFallback />}><AutoTradingPage embedded /></Suspense>;

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
  const [location] = useLocation();
  const [workspace, setWorkspace] = useState<Workspace>('signal');
  const deviceClass: UiBuilderDeviceClass = desktop ? 'desktop' : 'mobile';

  const loadedLayout = useMemo(() => {
    const raw = readStoredUiBuilderSignalScannerLayout(deviceClass);
    return loadUiBuilderSignalScannerLayout(raw, deviceClass, SIGNAL_SCANNER_INTEGRATION_LAYOUTS[deviceClass]);
  }, [deviceClass]);

  if (location.startsWith('/auto-trading')) return <Suspense fallback={<WorkspaceFallback />}><AutoTradingPage /></Suspense>;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background" data-testid="technical-workspace">
      <CenteredPageHeader
        title={WORKSPACE_TITLES[workspace]}
        infoTitle="기술 기능 안내"
        infoItems={[
          'AI 검색기에서 국내·미국·코인 현물·코인 선물 후보를 같은 방식으로 확인합니다.',
          '종목 선택 상태는 AI 차트와 승인형 모의매매 검토 흐름으로 이어집니다.',
          '실전 주문은 활성화하지 않으며 사용자 승인과 최종 위험 검증을 유지합니다.',
        ]}
      />
      <div className="shrink-0 border-b border-card-border bg-background px-2 py-2 sm:px-3">
        <ResponsiveTabs value={workspace} options={WORKSPACE_TABS} onChange={setWorkspace} ariaLabel="기술 기능 탭" testId={desktop ? 'technical-desktop-tabs' : 'technical-mobile-tabs'} compact />
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {desktop ? <DesktopWorkspace workspace={workspace} builderLayout={loadedLayout} /> : <MobileWorkspace workspace={workspace} builderLayout={loadedLayout} />}
      </div>
      <BottomNav />
    </div>
  );
}
