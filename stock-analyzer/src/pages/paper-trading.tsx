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
        {imported.active ? <BacktestPaperCandidatePreview imported={imported} /> : null}
        <BottomNav />
      </div>
    );
  }

  // Manual Paper was removed: every Paper route (including an old ?kind=manual
  // link) opens automatic Paper. Existing records stay in the journal.
  return <AutoTradingPage key={search} initialMode="paper" paperOrigin="automatic" />;
}
