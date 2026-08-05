import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { useAuth } from '@/lib/auth';
import AiChartPage from '@/pages/ai-chart';
import ScannerPage from '@/pages/scanner';
import SignalScannerPage from '@/pages/signal-scanner';

type MobileWorkspace = 'signal' | 'legacy';

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
  const [mobileWorkspace, setMobileWorkspace] = useState<MobileWorkspace>(() => phase11SignalRoute ? 'signal' : 'legacy');

  if (!desktop) {
    if (!auth.isAdmin) {
      return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
          <div className="min-h-0 flex-1 overflow-hidden"><SignalScannerPage /></div>
        </div>
      );
    }
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <div className="shrink-0 border-b border-card-border bg-background px-3 py-2">
          {mobileWorkspace === 'legacy' ? (
            <button
              type="button"
              onClick={() => setMobileWorkspace('signal')}
              className="min-h-11 w-full rounded-xl border border-primary/30 bg-primary/10 px-3 text-sm font-extrabold text-primary"
            >
              다중 시장 AI 신호검색기
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setMobileWorkspace('legacy')}
              className="min-h-11 w-full rounded-xl border border-card-border bg-card px-3 text-sm font-extrabold"
            >
              관리자 주문 워크스페이스
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {mobileWorkspace === 'legacy' ? <ScannerPage /> : <SignalScannerPage />}
        </div>
      </div>
    );
  }

  if (!auth.can('canAccessRiskPreview')) {
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
