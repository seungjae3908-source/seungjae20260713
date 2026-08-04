import type {
  ChartAnalysis,
  ChartAnalysisPoint,
  ChartAnalysisStatus,
} from './chart-analysis';

export type ChartPatternOverlayAnchor = ChartAnalysisPoint & {
  order: number;
};

export type ChartPatternOverlayModel = {
  analysisId: string;
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
): ChartPatternOverlayModel | null {
  if (!analysis || analysis.status === 'expired') return null;
  if (analysis.type !== 'double-top' && analysis.type !== 'double-bottom') return null;

  const confirmationRole = analysis.type === 'double-top' ? 'support' : 'resistance';
  const invalidationRole = analysis.type === 'double-top' ? 'resistance' : 'support';
  const confirmationPrice = analysis.priceLevels.find((level) => level.role === confirmationRole)?.price;
  const invalidationPrice = analysis.priceLevels.find((level) => level.role === invalidationRole)?.price;
  if (confirmationPrice == null || invalidationPrice == null) return null;
  if (!validPrice(confirmationPrice) || !validPrice(invalidationPrice)) return null;

  const seen = new Set<string>();
  const anchors = analysis.points
    .filter((point) => Number.isFinite(point.time) && validPrice(point.price))
    .sort((left, right) => left.time - right.time || left.price - right.price)
    .flatMap((point) => {
      const key = `${Math.trunc(point.time)}:${point.role}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ ...point, order: seen.size }];
    });

  if (anchors.length < 2) return null;

  return {
    analysisId: analysis.id,
    type: analysis.type,
    label: analysis.subtype ?? (analysis.type === 'double-top' ? 'M자 · 이중천장' : 'W자 · 이중바닥'),
    status: analysis.status,
    bias: analysis.type === 'double-top' ? 'bearish' : 'bullish',
    anchors: anchors.slice(0, 2),
    confirmationPrice,
    invalidationPrice,
  };
}
