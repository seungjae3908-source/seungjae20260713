import { useMemo } from 'react';
import { useSearch } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { BacktestPaperCandidatePreview } from '@/components/backtest-paper-candidate-preview';
import AutoTradingPage from '@/pages/auto-trading';
import { FourMarketPaperStatusPanel } from '@/components/four-market-paper-status-panel';
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

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="paper-only-four-market-workspace">
      <FourMarketPaperStatusPanel />
      <div className="min-h-0 flex-1"><AutoTradingPage initialMode="paper" /></div>
    </div>
  );
}
