import { Link } from 'wouter';
import { ChevronRight, Gem } from 'lucide-react';
import { ScoreRing } from '@/components/score-ring';
import { formatPrice, formatPercent } from '@/lib/format';
import { changeTone, toneText } from '@/lib/labels';
import type { UndervaluedCard as UndervaluedCardData } from '@/lib/api';
import { cn } from '@/lib/utils';

function Metric({ label, value, suffix = '' }: { label: string; value: number | null; suffix?: string }) {
  return (
    <div className="rounded-lg border border-card-border bg-background/40 px-2 py-1.5 text-center">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="font-mono text-xs font-semibold tabular-nums">
        {value != null ? `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${suffix}` : '—'}
      </div>
    </div>
  );
}

function Level({ label, value, tone, currency }: { label: string; value: number; tone: string; currency: 'USD' | 'KRW' }) {
  return (
    <div className="rounded-lg border border-card-border bg-background/40 px-2 py-1.5 text-center">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={cn('font-mono text-xs font-semibold tabular-nums', tone)}>{formatPrice(value, currency)}</div>
    </div>
  );
}

const QUALITY_KO: Record<UndervaluedCardData['dataQuality'], string> = {
  ok: '데이터 충분',
  partial: '데이터 일부',
  insufficient: '데이터 부족',
};

export function UndervaluedCard({ card }: { card: UndervaluedCardData }) {
  const cTone = changeTone(card.changePercent);
  return (
    <Link
      href={`/stock/${card.ticker}`}
      className="block rounded-2xl border border-card-border bg-card p-4 transition-colors hover:border-primary/40 active:scale-[0.99] glass"
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Gem className="h-4 w-4 shrink-0 text-ai" />
            <span className="truncate font-semibold">{card.name}</span>
          </div>
          <div className="text-xs text-muted-foreground">{card.ticker}</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-sm font-semibold tabular-nums">{formatPrice(card.price, card.currency)}</div>
          <div className={cn('font-mono text-xs tabular-nums', toneText(cTone))}>{formatPercent(card.changePercent)}</div>
        </div>
        <ScoreRing score={card.score} tone="positive" size={48} label="저평가" />
      </div>

      <div className="mt-3 grid grid-cols-4 gap-1.5">
        <Metric label="PER" value={card.per} suffix="배" />
        <Metric label="PBR" value={card.pbr} suffix="배" />
        <Metric label="ROE" value={card.roe} suffix="%" />
        <Metric label="부채비율" value={card.debtRatio} suffix="%" />
      </div>

      {card.reasons.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">저평가 이유</div>
          <div className="flex flex-wrap gap-1.5">
            {card.reasons.map((r, i) => (
              <span key={i} className="rounded-full border border-positive/25 bg-positive/10 px-2 py-0.5 text-[11px] font-medium text-positive">
                {r}
              </span>
            ))}
          </div>
        </div>
      )}

      {card.risks.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">리스크</div>
          <div className="flex flex-wrap gap-1.5">
            {card.risks.map((r, i) => (
              <span key={i} className="rounded-full border border-warning/25 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
                {r}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 grid grid-cols-3 gap-1.5">
        <Level label="진입가" value={card.entry} tone="text-foreground" currency={card.currency} />
        <Level label="목표가" value={card.target} tone="text-positive" currency={card.currency} />
        <Level label="손절가" value={card.stop} tone="text-destructive" currency={card.currency} />
      </div>

      <div className="mt-3 flex items-center justify-between">
        <span className="rounded-full border border-card-border px-2 py-0.5 text-[11px] text-muted-foreground">
          {QUALITY_KO[card.dataQuality]}
        </span>
        <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
          상세 분석 <ChevronRight className="h-3.5 w-3.5" />
        </span>
      </div>
    </Link>
  );
}
