import type {
  ChartAnalysis,
  ChartAnalysisPoint,
  ChartAnalysisStatus,
} from './chart-analysis';
import type { DetectedChartPattern } from './chart-structure-engine';

export type ChartPatternOverlayAnchor = ChartAnalysisPoint & {
  order: number;
};

export type ChartPatternOverlayModel = {
  analysisId: string;
  patternId: string;
  type: 'double-top' | 'double-bottom';
  label: string;
  status: ChartAnalysisStatus;
  bias: 'bullish' | 'bearish';
  anchors: ChartPatternOverlayAnchor[];
  confirmationPrice: number;
  invalidationPrice: number;
};

function validPrice(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function buildChartPatternOverlay(
  analysis: ChartAnalysis | null,
  pattern: DetectedChartPattern | null,
): ChartPatternOverlayModel | null {
  if (!analysis || !pattern || pattern.status === 'expired') return null;
  if (analysis.type !== pattern.type) return null;
  if (!validPrice(pattern.neckline) || !validPrice(pattern.invalidationLevel)) return null;

  const seen = new Set<string>();
  const anchors = pattern.anchorPivots
    .filter((point) => Number.isFinite(point.time) && validPrice(point.price))
    .sort((left, right) => left.time - right.time || left.price - right.price)
    .flatMap((point) => {
      const key = `${Math.trunc(point.time)}:${point.kind}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{
        time: point.time,
        price: point.price,
        role: point.kind,
        order: seen.size,
      }];
    });

  if (anchors.length < 2) return null;

  return {
    analysisId: analysis.id,
    patternId: pattern.id,
    type: pattern.type,
    label: pattern.label,
    status: pattern.status,
    bias: pattern.bias,
    anchors: anchors.slice(0, 2),
    confirmationPrice: pattern.neckline,
    invalidationPrice: pattern.invalidationLevel,
  };
}
