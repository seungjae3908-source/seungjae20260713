import { Link } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { BacktestResearchPanel } from '@/components/backtest-research-panel';

export default function BacktestsPage() {
  return <div className="relative h-full min-h-0 overflow-hidden">
    <div className="absolute right-4 top-4 z-20"><Link href="/paper-trading" className="rounded-lg border border-border bg-card px-3 py-2 text-xs font-bold shadow-sm">모의매매로 이동</Link></div>
    <BacktestResearchPanel />
    <BottomNav />
  </div>;
}
