import { BottomNav } from '@/components/bottom-nav';
import { BacktestResearchPanel } from '@/components/backtest-research-panel';

export default function BacktestsPage() {
  return <div className="relative h-full min-h-0 overflow-hidden">
    <BacktestResearchPanel />
    <BottomNav />
  </div>;
}
