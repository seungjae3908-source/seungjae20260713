import { useMemo } from 'react';
import { useSearch } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { BacktestPaperCandidatePreview } from '@/components/backtest-paper-candidate-preview';
import AutoTradingPage from '@/pages/auto-trading';
import { readBacktestPaperHandoff } from '../../../packages/strategy-hypothesis/src/backtest-paper-handoff.js';

export default function PaperTradingPage() {
  const search = useSearch();
  const imported = useMemo(() => readBacktestPaperHandoff(search), [search]);

  if (imported.active) {
    return (
      <div
        className="relative h-full min-h-0 overflow-hidden pb-[calc(5rem+env(safe-area-inset-bottom))]"
        data-testid="paper-trading-backtest-handoff"
      >
        <BacktestPaperCandidatePreview imported={imported} />
        <BottomNav />
      </div>
    );
  }

  return <AutoTradingPage initialMode="paper" />;
}
