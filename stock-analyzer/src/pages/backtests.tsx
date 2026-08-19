import { Link } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { CenteredPageHeader } from '@/components/centered-page-header';
import { BacktestResearchPanel } from '@/components/backtest-research-panel';

export default function BacktestsPage() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <CenteredPageHeader
        title="백테스트"
        eyebrow="코인 선물 연구"
        action={<Link href="/paper-trading" className="flex min-h-11 items-center rounded-xl border border-card-border bg-card px-3 text-[11px] font-black text-primary">모의매매</Link>}
      />
      <div className="min-h-0 flex-1 overflow-hidden"><BacktestResearchPanel compact /></div>
      <BottomNav />
    </div>
  );
}
