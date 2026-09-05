import { useEffect, useMemo, useState } from 'react';
import { UnifiedAnalysisChart } from '@/components/unified-analysis-chart';
import type {
  AnalysisAssetType,
  AnalysisMarket,
  AnalysisSelection,
} from '@/lib/analysis-selection';

function canonicalSelection({
  assetType,
  market,
  symbol,
  displayName,
  timeframe,
}: {
  assetType: AnalysisAssetType;
  market: AnalysisMarket;
  symbol: string;
  displayName?: string;
  timeframe?: string;
}): AnalysisSelection {
  const ticker = symbol.trim().toUpperCase();
  return {
    assetType,
    market,
    symbol: ticker,
    ticker,
    displayName: displayName?.trim() || ticker,
    timeframe: timeframe?.trim() || '1D',
    selectedAt: new Date().toISOString(),
  };
}

export function CanonicalMarketChart({
  assetType,
  market,
  symbol,
  displayName,
  timeframe = '1D',
  className = '',
}: {
  assetType: AnalysisAssetType;
  market: AnalysisMarket;
  symbol: string;
  displayName?: string;
  timeframe?: string;
  className?: string;
}) {
  const input = useMemo(
    () => canonicalSelection({ assetType, market, symbol, displayName, timeframe }),
    [assetType, displayName, market, symbol, timeframe],
  );
  const inputKey = `${input.assetType}:${input.market}:${input.ticker}:${input.timeframe}`;
  const [selection, setSelection] = useState(input);

  useEffect(() => {
    setSelection(input);
  }, [inputKey]);

  return (
    <section
      aria-label="AI Chart 표준 시장차트"
      data-testid="canonical-ai-chart-surface"
      className={`min-w-0 overflow-hidden rounded-2xl border border-card-border bg-card p-2 sm:p-3 ${className}`}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-wide text-primary">Canonical Market Chart</p>
          <h3 className="truncate text-sm font-black">AI Chart 2.0 · {selection.displayName}</h3>
        </div>
        <span className="shrink-0 rounded-full border border-primary/30 bg-primary/10 px-2 py-1 text-[10px] font-black text-primary">
          앱 공통 차트
        </span>
      </div>
      <div className="min-w-0 overflow-hidden">
        <UnifiedAnalysisChart
          selection={selection}
          onSelectionChange={setSelection}
        />
      </div>
    </section>
  );
}
