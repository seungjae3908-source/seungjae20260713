import type { AnalysisMarket } from '@/lib/analysis-selection';
import type { ChartPatternOverlayModel } from '@/lib/chart-pattern-overlay';
import { cn } from '@/lib/utils';

type Props = {
  overlay: ChartPatternOverlayModel | null;
  market: AnalysisMarket;
  visible: boolean;
};

function formatPrice(value: number, market: AnalysisMarket): string {
  if (market === 'US') {
    return `$${value.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (market === 'BITGET') {
    return `${value.toLocaleString('ko-KR', { maximumFractionDigits: value >= 1000 ? 2 : 8 })} USDT`;
  }
  return `${value.toLocaleString('ko-KR', { maximumFractionDigits: value >= 1000 ? 0 : 8 })}원`;
}

function statusLabel(status: ChartPatternOverlayModel['status']): string {
  return {
    forming: '형성 중',
    candidate: '후보',
    confirmed: '확정',
    weakened: '약화',
    invalidated: '무효화',
    expired: '만료',
  }[status];
}

export function ChartPatternOverlayPanel({ overlay, market, visible }: Props) {
  if (!visible || !overlay) return null;

  return (
    <section
      data-testid="chart-pattern-overlay"
      data-analysis-id={overlay.analysisId}
      data-pattern-type={overlay.type}
      data-pattern-status={overlay.status}
      className="rounded-3xl border border-card-border bg-card p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-extrabold text-primary">패턴 오버레이</p>
          <h2 className="mt-1 text-base font-black">{overlay.label}</h2>
        </div>
        <span
          data-testid="chart-pattern-overlay-status"
          className={cn(
            'rounded-full border px-3 py-1.5 text-xs font-black',
            overlay.status === 'confirmed' && 'border-positive/30 bg-positive/10 text-positive',
            overlay.status === 'invalidated' && 'border-destructive/30 bg-destructive/10 text-destructive',
            overlay.status !== 'confirmed' && overlay.status !== 'invalidated' && 'border-warning/30 bg-warning/10 text-warning',
          )}
        >
          {statusLabel(overlay.status)}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {overlay.anchors.map((anchor) => (
          <div
            key={`${anchor.time}:${anchor.role}`}
            data-testid="chart-pattern-anchor"
            data-anchor-time={anchor.time}
            data-anchor-role={anchor.role}
            className="rounded-2xl border border-card-border bg-background p-3"
          >
            <p className="text-[10px] font-extrabold text-muted-foreground">
              {anchor.role === 'high' ? `고점 앵커 ${anchor.order}` : `저점 앵커 ${anchor.order}`}
            </p>
            <p className="mt-2 text-sm font-black">{formatPrice(anchor.price, market)}</p>
          </div>
        ))}
        <div
          data-testid="chart-pattern-confirmation-line"
          data-price={overlay.confirmationPrice}
          className="rounded-2xl border border-positive/30 bg-positive/5 p-3"
        >
          <p className="text-[10px] font-extrabold text-muted-foreground">확인선 · 넥라인</p>
          <p className="mt-2 text-sm font-black text-positive">{formatPrice(overlay.confirmationPrice, market)}</p>
        </div>
        <div
          data-testid="chart-pattern-invalidation-line"
          data-price={overlay.invalidationPrice}
          className="rounded-2xl border border-destructive/30 bg-destructive/5 p-3"
        >
          <p className="text-[10px] font-extrabold text-muted-foreground">무효화선</p>
          <p className="mt-2 text-sm font-black text-destructive">{formatPrice(overlay.invalidationPrice, market)}</p>
        </div>
      </div>
      <p className="mt-3 text-[10px] font-semibold leading-4 text-muted-foreground">
        앵커와 가격선은 현재 분석 ID 하나만 표시하며 상태가 변경되면 기존 오버레이를 제거하고 최신 상태로 교체합니다.
      </p>
    </section>
  );
}
