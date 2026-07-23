import { Link } from 'wouter';
import { Star, ChevronRight } from 'lucide-react';
import { RatingBadge } from '@/components/rating-badge';
import { ScoreRing } from '@/components/score-ring';
import { useWatchlist } from '@/hooks/use-watchlist';
import { formatPrice, formatPercent } from '@/lib/format';
import { changeTone, ratingTone, toneText } from '@/lib/labels';
import type { QuoteRow, RiskLevel } from '@/lib/api';
import { cn } from '@/lib/utils';
import { InstrumentAlertButton } from '@/components/instrument-alert-modal';
import { toast } from '@/hooks/use-toast';

const RISK_KO: Record<RiskLevel, string> = { LOW: '낮음', MEDIUM: '보통', HIGH: '높음' };
const RISK_CLS: Record<RiskLevel, string> = {
  LOW: 'text-positive border-positive/30 bg-positive/10',
  MEDIUM: 'text-warning border-warning/30 bg-warning/10',
  HIGH: 'text-risk border-risk/30 bg-risk/10',
};

function Level({ label, value, tone }: { label: string; value?: number; tone: string; }) {
  return (
    <div className="rounded-lg border border-card-border bg-background/40 px-2 py-1.5 text-center">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={cn('font-mono text-xs font-semibold tabular-nums', tone)}>
        {value != null ? value.toLocaleString('en-US') : '—'}
      </div>
    </div>
  );
}

export function RecommendationCard({ stock }: { stock: QuoteRow }) {
  const { isWatchlisted, toggle } = useWatchlist();
  const watched = isWatchlisted(stock.ticker);
  const cTone = changeTone(stock.changePercent);

  return (
    <Link
      href={`/stock/${stock.ticker}`}
      className="block rounded-2xl border border-card-border bg-card p-4 transition-colors hover:border-primary/40 active:scale-[0.99] glass"
    >
      <div className="flex items-center gap-3">
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void toggle(stock).catch((error) => toast({
              title: '관심종목 저장 실패',
              description: error instanceof Error ? error.message : '원래 상태로 복구했습니다.',
              variant: 'destructive',
            }));
          }}
          className="shrink-0"
          aria-label="관심 종목"
        >
          <Star className={cn('h-5 w-5', watched ? 'fill-warning text-warning' : 'text-muted-foreground')} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="break-keep font-semibold leading-relaxed">{stock.name}</span>
            <RatingBadge rating={stock.rating.rating} />
          </div>
          <div className="text-xs text-muted-foreground">{stock.ticker}</div>
        </div>
        <div className="flex items-end gap-1.5 text-right">
          <div>
          <div className="font-mono text-sm font-semibold tabular-nums">{formatPrice(stock.price, stock.currency)}</div>
          <div className={cn('font-mono text-xs tabular-nums', toneText(cTone))}>{formatPercent(stock.changePercent)}</div>
          </div>
          <InstrumentAlertButton instrument={{ ticker: stock.ticker, name: stock.name, market: stock.market }} />
        </div>
        <ScoreRing score={stock.rating.score} tone={ratingTone(stock.rating.rating)} size={48} label="AI" />
      </div>

      {(stock.entry != null || stock.take1 != null) && (
        <div className="mt-3 grid grid-cols-4 gap-1.5">
          <Level label="진입가" value={stock.entry} tone="text-foreground" />
          <Level label="1차 익절" value={stock.take1} tone="text-positive" />
          <Level label="2차 익절" value={stock.take2} tone="text-positive" />
          <Level label="손절가" value={stock.stop} tone="text-destructive" />
        </div>
      )}

      <div className="mt-3 flex items-center justify-between">
        {stock.riskLevel ? (
          <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', RISK_CLS[stock.riskLevel])}>
            리스크 {RISK_KO[stock.riskLevel]}
          </span>
        ) : (
          <span />
        )}
        <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
          상세 분석 <ChevronRight className="h-3.5 w-3.5" />
        </span>
      </div>
    </Link>
  );
}
