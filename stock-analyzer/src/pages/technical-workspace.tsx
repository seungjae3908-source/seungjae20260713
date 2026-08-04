import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { ShieldCheck } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import AiChartPage from '@/pages/ai-chart';
import AutoTradingPage from '@/pages/auto-trading';
import ScannerPage from '@/pages/scanner';

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

function ApprovalEntry({ children, onOpen }: { children: ReactNode; onOpen: () => void }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-card-border bg-background px-4 py-2">
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full items-center justify-between gap-3 rounded-2xl border border-primary/30 bg-primary/10 px-3 py-2 text-left"
        >
          <span className="min-w-0">
            <span className="block text-xs font-extrabold text-primary">승인형 모의주문</span>
            <span className="block truncate text-[10px] font-bold text-muted-foreground">조건 유지 재검증 후 1·2·3차 진입을 모의 실행합니다.</span>
          </span>
          <ShieldCheck className="h-5 w-5 shrink-0 text-primary" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

export default function TechnicalWorkspacePage() {
  const desktop = useDesktopWorkspace();
  const [location, navigate] = useLocation();
  const openApproval = () => navigate('/scanner-approval');

  if (location.startsWith('/auto-trading')) return <AutoTradingPage />;
  if (!desktop) return <ApprovalEntry onOpen={openApproval}><ScannerPage /></ApprovalEntry>;
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(340px,0.72fr)_minmax(0,2fr)] overflow-hidden bg-background pb-20">
      <aside className="min-h-0 overflow-hidden border-r border-card-border">
        <ApprovalEntry onOpen={openApproval}><ScannerPage embedded /></ApprovalEntry>
      </aside>
      <section className="min-h-0 overflow-hidden"><AiChartPage embedded /></section>
      <BottomNav />
    </div>
  );
}
