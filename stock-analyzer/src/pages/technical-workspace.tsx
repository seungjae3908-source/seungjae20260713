import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { useAuth } from '@/lib/auth';
import AiChartPage from '@/pages/ai-chart';
import ScannerPage from '@/pages/scanner';
import SignalScannerPage from '@/pages/signal-scanner';

type MobileWorkspace = 'legacy' | 'signal' | 'chart';

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

export default function TechnicalWorkspacePage() {
  const desktop = useDesktopWorkspace();
  const auth = useAuth();
  const [location] = useLocation();
  const phase11SignalRoute = location.startsWith('/__phase11-technical-workspace-e2e');
  const canUseAiChart = auth.can('canAccessRiskPreview') || phase11SignalRoute;
  const [mobileWorkspace, setMobileWorkspace] = useState<MobileWorkspace>(() => (
    phase11SignalRoute ? 'signal' : 'legacy'
  ));

  useEffect(() => {
    if (mobileWorkspace === 'chart' && !canUseAiChart) setMobileWorkspace('signal');
  }, [canUseAiChart, mobileWorkspace]);

  if (!desktop) {
    const workspaces: Array<{ id: MobileWorkspace; label: string }> = [
      { id: 'legacy', label: 'AI 검색기' },
      { id: 'signal', label: '다중 시장 신호검색기' },
      ...(canUseAiChart ? [{ id: 'chart' as const, label: '통합 차트' }] : []),
    ];
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <div className="grid shrink-0 gap-2 border-b border-card-border bg-background px-3 py-2" style={{ gridTemplateColumns: `repeat(${workspaces.length}, minmax(0, 1fr))` }}>
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              aria-pressed={mobileWorkspace === workspace.id}
              onClick={() => setMobileWorkspace(workspace.id)}
              className={mobileWorkspace === workspace.id
                ? 'min-h-11 rounded-xl border border-primary/30 bg-primary/10 px-2 text-xs font-extrabold text-primary'
                : 'min-h-11 rounded-xl border border-card-border bg-card px-2 text-xs font-extrabold'}
            >
              {workspace.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {mobileWorkspace === 'legacy' ? <ScannerPage /> : null}
          {mobileWorkspace === 'signal' ? <SignalScannerPage /> : null}
          {mobileWorkspace === 'chart' && canUseAiChart ? <AiChartPage /> : null}
        </div>
      </div>
    );
  }

  if (!canUseAiChart) {
    return (
      <div className="h-full min-h-0 overflow-hidden bg-background pb-20">
        <SignalScannerPage />
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(380px,0.88fr)_minmax(0,2fr)] overflow-hidden bg-background pb-20">
      <aside className="min-h-0 overflow-hidden border-r border-card-border"><SignalScannerPage embedded /></aside>
      <section className="min-h-0 overflow-hidden"><AiChartPage embedded /></section>
      <BottomNav />
    </div>
  );
}
