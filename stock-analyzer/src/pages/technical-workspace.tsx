import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { ResponsiveTabs } from '@/components/responsive-tabs';
import { ScannerApprovalComposer } from '@/components/scanner-approval-composer';
import { UiBuilderSignalScannerLayout } from '@/components/ui-builder-signal-scanner-layout';
import AiChartPage from '@/pages/ai-chart';
import AutoTradingPage from '@/pages/auto-trading';
import SignalScannerPage from '@/pages/signal-scanner';
import { useAnalysisSelection } from '@/lib/analysis-selection';
import { getPortfolioChartOverlay } from '@/lib/portfolio-overlay';
import {
  loadUiBuilderSignalScannerLayout,
  readStoredUiBuilderSignalScannerLayout,
  SIGNAL_SCANNER_INTEGRATION_LAYOUTS,
  type UiBuilderDeviceClass,
} from '@/lib/ui-builder-layout';

type MobileWorkspace = 'signal' | 'chart' | 'trade';

const MOBILE_WORKSPACE_TABS = [
  { value: 'signal', label: '신호' },
  { value: 'chart', label: 'AI 차트' },
  { value: 'trade', label: '자동매매' },
] as const;

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
        <h2 className="text-sm font-black">내 포지션</h2>
        <p className="mt-2 break-keep text-xs leading-5 text-muted-foreground">
          신호 종목을 선택하면 기존 포트폴리오 오버레이 캐시의 보유 정보를 읽기 전용으로 표시합니다.
        </p>
      </section>
    );
  }

  if (!overlay) {
    return (
      <section data-testid="ui-builder-position-summary-none" className="min-w-0 rounded-3xl border border-card-border bg-card p-3 shadow-sm sm:p-4">
        <h2 className="text-sm font-black">내 포지션</h2>
        <p className="mt-2 break-words text-xs font-bold">{selection.displayName} · {selection.ticker}</p>
        <p className="mt-1 break-keep text-xs leading-5 text-muted-foreground">
          기존 포트폴리오에 동기화된 보유 기록이 없습니다. 이 Block은 계좌·broker·private trading API를 호출하지 않습니다.
        </p>
      </section>
    );
  }

  const marketValue = overlay.currentPrice == null ? null : overlay.currentPrice * overlay.quantity;
  const cost = overlay.averagePrice * overlay.quantity;
  const pnl = marketValue == null ? null : marketValue - cost;

  return (
    <section data-testid="ui-builder-position-summary" className="min-w-0 rounded-3xl border border-card-border bg-card p-3 shadow-sm sm:p-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-black">내 포지션</h2>
          <p className="mt-1 truncate text-[11px] font-bold text-muted-foreground">{overlay.name} · {overlay.ticker}</p>
        </div>
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
      <p className="mt-3 break-keep text-[10px] leading-4 text-muted-foreground">
        Risk 판정은 기존 Risk Engine 소유이며 이 요약 Block은 위험 한도·포지션 사이징을 계산하거나 변경하지 않습니다.
      </p>
    </section>
  );
}

function TradeReviewSurface() {
  const { selection } = useAnalysisSelection();
  if (!selection) {
    return (
      <section
        data-testid="ui-builder-trade-review-empty"
        className="min-w-0 rounded-3xl border border-card-border bg-card p-3 shadow-sm sm:p-4"
      >
        <h2 className="text-sm font-black">거래 검토</h2>
        <p className="mt-2 break-keep text-xs leading-5 text-muted-foreground">
          검색 결과에서 종목을 선택하면 기존 승인형 Paper 검토 흐름을 사용할 수 있습니다.
          이 Layout Block은 주문 endpoint나 실행 방식을 지정할 수 없습니다.
        </p>
      </section>
    );
  }
  return <ScannerApprovalComposer selection={selection} />;
}

function MobileDefaultWorkspace({
  mobileWorkspace,
  setMobileWorkspace,
}: {
  mobileWorkspace: MobileWorkspace;
  setMobileWorkspace: (value: MobileWorkspace) => void;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <div className="shrink-0 border-b border-card-border bg-background px-2 py-2 sm:px-3">
        <ResponsiveTabs
          value={mobileWorkspace}
          options={MOBILE_WORKSPACE_TABS}
          onChange={setMobileWorkspace}
          ariaLabel="기술 워크스페이스 모바일 탭"
          testId="technical-mobile-tabs"
        />
      </div>
      <div
        role="tabpanel"
        data-testid={`technical-mobile-panel-${mobileWorkspace}`}
        className="min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        {mobileWorkspace === 'signal' ? <SignalScannerPage /> : null}
        {mobileWorkspace === 'chart' ? <AiChartPage embedded /> : null}
        {mobileWorkspace === 'trade' ? <AutoTradingPage /> : null}
      </div>
      {mobileWorkspace !== 'trade' ? <BottomNav /> : null}
    </div>
  );
}

function DesktopDefaultWorkspace() {
  return (
    <div className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(360px,0.88fr)_minmax(0,2fr)] overflow-hidden bg-background pb-20 xl:grid-cols-[minmax(420px,0.82fr)_minmax(0,2fr)]">
      <aside className="min-h-0 min-w-0 overflow-hidden border-r border-card-border"><SignalScannerPage embedded /></aside>
      <section className="min-h-0 min-w-0 overflow-hidden"><AiChartPage embedded /></section>
      <BottomNav />
    </div>
  );
}

export default function TechnicalWorkspacePage() {
  const desktop = useDesktopWorkspace();
  const [location] = useLocation();
  const phase11SignalRoute = location.startsWith('/__phase11-technical-workspace-e2e');
  const [mobileWorkspace, setMobileWorkspace] = useState<MobileWorkspace>(() => phase11SignalRoute ? 'signal' : 'signal');
  const deviceClass: UiBuilderDeviceClass = desktop ? 'desktop' : 'mobile';

  const loadedLayout = useMemo(() => {
    const raw = readStoredUiBuilderSignalScannerLayout(deviceClass);
    return loadUiBuilderSignalScannerLayout(
      raw,
      deviceClass,
      SIGNAL_SCANNER_INTEGRATION_LAYOUTS[deviceClass],
    );
  }, [deviceClass]);

  if (location.startsWith('/auto-trading')) return <AutoTradingPage />;

  const fallback = desktop
    ? <DesktopDefaultWorkspace />
    : <MobileDefaultWorkspace mobileWorkspace={mobileWorkspace} setMobileWorkspace={setMobileWorkspace} />;

  if (loadedLayout.source !== 'builder') return fallback;

  return (
    <div className="h-full min-h-0 min-w-0 overflow-hidden bg-background">
      <UiBuilderSignalScannerLayout
        layout={loadedLayout.layout}
        scanner={<SignalScannerPage embedded={desktop} />}
        chart={<AiChartPage embedded />}
        position={<PositionSummarySurface />}
        tradeReview={<TradeReviewSurface />}
        fallback={fallback}
      />
      {desktop ? <BottomNav /> : null}
    </div>
  );
}
