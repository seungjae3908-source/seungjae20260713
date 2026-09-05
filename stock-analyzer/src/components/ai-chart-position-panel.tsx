import { lazy, Suspense } from 'react';
import type { AnalysisMarket, AnalysisPricePlan } from '@/lib/analysis-selection';

export type {
  AiChartAccountPosition,
  AiChartPositionOverlay,
} from './ai-chart-position-panel-impl';

type Props = {
  market: AnalysisMarket;
  symbol: string;
  chartPrice: number | null;
  pricePlan?: AnalysisPricePlan;
  onOverlayChange: (
    overlay: import('./ai-chart-position-panel-impl').AiChartPositionOverlay | null,
  ) => void;
};

const LazyAiChartPositionPanel = lazy(() =>
  import('./ai-chart-position-panel-impl').then((module) => ({
    default: module.AiChartPositionPanel,
  })),
);

export function AiChartPositionPanel(props: Props) {
  return (
    <Suspense
      fallback={(
        <section
          aria-busy="true"
          aria-label="포지션 패널 준비 중"
          className="min-h-24 rounded-2xl border border-card-border bg-background/85 p-3 shadow-sm"
        >
          <p className="text-[10px] font-bold text-muted-foreground">내 포지션을 준비하고 있습니다.</p>
        </section>
      )}
    >
      <LazyAiChartPositionPanel {...props} />
    </Suspense>
  );
}
