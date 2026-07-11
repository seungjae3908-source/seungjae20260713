import { Layers } from 'lucide-react';
import type { AccumulationResult } from '@/lib/api';
import { cn } from '@/lib/utils';

function Stars({ n }: { n: number }) {
  return (
    <span className="text-warning" aria-label={`${n}점 만점 별점`}>
      {'★'.repeat(n)}
      <span className="text-muted-foreground/40">{'★'.repeat(5 - n)}</span>
    </span>
  );
}

function scoreColor(score: number): string {
  if (score >= 65) return 'text-positive';
  if (score >= 50) return 'text-warning';
  return 'text-muted-foreground';
}

export function AccumulationCard({ acc, onClick }: { acc: AccumulationResult; onClick: () => void }) {
  const insufficient = acc.dataQuality === 'insufficient';
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-2xl border border-ai/25 bg-card p-4 text-left transition-colors hover:border-ai/50 active:scale-[0.99]"
    >
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ai/15">
          <Layers className="h-4 w-4 text-ai" />
        </span>
        <h3 className="text-sm font-bold">바닥권 매집</h3>
        {acc.dataQuality === 'partial' && (
          <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
            일부 데이터 제한
          </span>
        )}
        <span className="ml-auto text-[11px] text-ai">탭하여 AI 설명 →</span>
      </div>

      {insufficient ? (
        <p className="py-2 text-sm text-warning">데이터 부족으로 신뢰도 낮음</p>
      ) : (
        <>
          <div className="flex items-end gap-3">
            <span className={cn('font-mono text-4xl font-bold tabular-nums', scoreColor(acc.score))}>{acc.score}</span>
            <span className="pb-1 text-sm text-muted-foreground">/ 100점</span>
            <span className="ml-auto pb-1 text-lg">
              <Stars n={acc.stars} />
            </span>
          </div>
          <p className={cn('mt-1 text-sm font-semibold', scoreColor(acc.score))}>{acc.label}</p>

          <div className="mt-3 grid grid-cols-3 gap-2">
            <Metric label="신뢰도" value={`${acc.confidence}%`} />
            <Metric label="돌파 가능성" value={`${acc.breakoutProbability}%`} />
            <Metric label="예상 기간" value={acc.expectedPeriod} />
          </div>

          {acc.passed.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[11px] font-semibold text-positive">통과 조건</div>
              <ul className="space-y-0.5">
                {acc.passed.slice(0, 4).map((p, i) => (
                  <li key={i} className="flex gap-1.5 break-keep text-[12px] leading-relaxed">
                    <span className="text-positive">✓</span>
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {acc.failed.length > 0 && (
            <div className="mt-2">
              <div className="mb-1 text-[11px] font-semibold text-muted-foreground">미통과 조건</div>
              <ul className="space-y-0.5">
                {acc.failed.slice(0, 3).map((p, i) => (
                  <li key={i} className="flex gap-1.5 break-keep text-[12px] leading-relaxed text-muted-foreground">
                    <span>·</span>
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-card-border bg-background/40 px-2 py-1.5 text-center">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="font-mono text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}
