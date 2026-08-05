import type { AnalysisMarket } from '@/lib/analysis-selection';
import type { NormalizedChartCandle } from '@/lib/chart-candle-normalizer';
import type {
  ChartIndicatorResult,
  ChartIndicatorSnapshot,
} from '@/lib/chart-indicator-engine';
import type { UnifiedChartTimeframe } from '@/lib/unified-chart-data';

type SelectedCandleDetail = {
  candle: NormalizedChartCandle;
  indicator: ChartIndicatorSnapshot | null;
  index: number;
  isLatest: boolean;
};

type Props = {
  candles: NormalizedChartCandle[];
  indicators: ChartIndicatorResult;
  market: AnalysisMarket;
  timeframe: UnifiedChartTimeframe;
  selectedTime: number | null;
  onReset: () => void;
};

export function resolveSelectedCandleDetail(
  candles: NormalizedChartCandle[],
  indicators: ChartIndicatorResult,
  selectedTime: number | null,
): SelectedCandleDetail | null {
  if (!candles.length) return null;
  const selectedIndex = selectedTime == null
    ? candles.length - 1
    : candles.findIndex((candle) => candle.time === selectedTime);
  const index = selectedIndex >= 0 ? selectedIndex : candles.length - 1;
  return {
    candle: candles[index],
    indicator: indicators.points[index] ?? null,
    index,
    isLatest: index === candles.length - 1,
  };
}

function formatPrice(value: number | null | undefined, market: AnalysisMarket): string {
  if (value == null || !Number.isFinite(value)) return '-';
  if (market === 'US') {
    return `$${value.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (market === 'BITGET') {
    return `${value.toLocaleString('ko-KR', { maximumFractionDigits: value >= 1000 ? 2 : 8 })} USDT`;
  }
  return `${value.toLocaleString('ko-KR', { maximumFractionDigits: value >= 1000 ? 0 : 8 })}원`;
}

function formatIndicator(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return value.toLocaleString('ko-KR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatCandleTime(time: number, timeframe: UnifiedChartTimeframe): string {
  const date = new Date(time * 1000);
  if (!Number.isFinite(date.getTime())) return '-';
  return date.toLocaleString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: timeframe === '1D' ? undefined : '2-digit',
    minute: timeframe === '1D' ? undefined : '2-digit',
    hour12: false,
  });
}

function DetailMetric({ testId, label, value }: { testId: string; label: string; value: string }) {
  return (
    <div data-testid={testId} className="rounded-2xl border border-card-border bg-background p-3">
      <p className="text-[10px] font-extrabold text-muted-foreground">{label}</p>
      <p className="mt-2 break-words text-sm font-black">{value}</p>
    </div>
  );
}

export function SelectedCandleDetailPanel({
  candles,
  indicators,
  market,
  timeframe,
  selectedTime,
  onReset,
}: Props) {
  const detail = resolveSelectedCandleDetail(candles, indicators, selectedTime);
  if (!detail) return null;
  const { candle, indicator, isLatest } = detail;

  return (
    <section
      data-testid="selected-candle-detail"
      data-candle-time={String(candle.time)}
      className="rounded-3xl border border-card-border bg-card p-4 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-extrabold text-primary">차트 클릭 상세</p>
          <h2 className="mt-1 text-base font-black">선택 캔들 OHLCV·지표</h2>
          <p data-testid="selected-candle-time" className="mt-1 text-[11px] font-bold text-muted-foreground">
            {formatCandleTime(candle.time, timeframe)} · {timeframe}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span
            data-testid="selected-candle-mode"
            className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-[10px] font-black text-primary"
          >
            {selectedTime == null ? '최신 캔들' : isLatest ? '선택한 최신 캔들' : '선택한 과거 캔들'}
          </span>
          <button
            type="button"
            onClick={onReset}
            disabled={selectedTime == null}
            className="min-h-11 rounded-xl border border-card-border bg-background px-3 text-[11px] font-black disabled:cursor-not-allowed disabled:opacity-45"
          >
            최신 캔들 보기
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <DetailMetric testId="selected-candle-open" label="시가" value={formatPrice(candle.open, market)} />
        <DetailMetric testId="selected-candle-high" label="고가" value={formatPrice(candle.high, market)} />
        <DetailMetric testId="selected-candle-low" label="저가" value={formatPrice(candle.low, market)} />
        <DetailMetric testId="selected-candle-close" label="종가" value={formatPrice(candle.close, market)} />
        <DetailMetric testId="selected-candle-volume" label="거래량" value={candle.volume.toLocaleString('ko-KR')} />
        <DetailMetric testId="selected-candle-status" label="봉 상태" value={candle.isClosed ? '완료봉' : '진행 중'} />
        <DetailMetric testId="selected-candle-rsi" label="RSI14" value={formatIndicator(indicator?.rsi14, 1)} />
        <DetailMetric testId="selected-candle-macd" label="MACD" value={formatIndicator(indicator?.macd, 4)} />
        <DetailMetric testId="selected-candle-atr" label="ATR14" value={formatPrice(indicator?.atr14, market)} />
        <DetailMetric testId="selected-candle-sma5" label="SMA5" value={formatPrice(indicator?.sma5, market)} />
        <DetailMetric testId="selected-candle-sma20" label="SMA20" value={formatPrice(indicator?.sma20, market)} />
        <DetailMetric
          testId="selected-candle-volume-ratio"
          label="거래량 비율"
          value={indicator?.volumeRatio20 == null ? '-' : `${indicator.volumeRatio20.toFixed(2)}배`}
        />
      </div>
      <p className="mt-3 text-[10px] font-semibold leading-4 text-muted-foreground">
        차트의 캔들을 클릭하거나 터치하면 해당 시점 값만 표시합니다. 분석 기준과 주문 상태는 변경하지 않습니다.
      </p>
    </section>
  );
}
