import { memo, useEffect, useMemo, useState } from 'react';
import { fetchPaperPromotionTrades } from '@/lib/paper-promotion-trades-client';
import type { PaperPromotionTradesReadback } from '@/lib/paper-promotion-trades';
import { buildPaperScorecard, evaluatePaperPromotion, type PromotionChecklistState } from '@/lib/research-center-product';

const LABEL: Readonly<Record<PromotionChecklistState, string>> = Object.freeze({ met: '충족', unmet: '미충족', unmeasured: '미측정' });
const STYLE: Readonly<Record<PromotionChecklistState, string>> = Object.freeze({
  met: 'text-emerald-700 dark:text-emerald-300',
  unmet: 'text-amber-800 dark:text-amber-300',
  unmeasured: 'text-muted-foreground',
});

/**
 * Read-only paper-trading scorecard against the owner-fixed review criteria
 * (>=30 closed trades after costs, 95% lower bound > 0, >=3 symbols, >=60% wins).
 * It reports review eligibility only: no order permission, no live switch.
 */
function PaperPromotionScorecardView({ readback, error }: { readback: PaperPromotionTradesReadback | null; error: boolean }) {
  const card = useMemo(() => buildPaperScorecard(readback?.trades), [readback]);
  const checklist = useMemo(() => evaluatePaperPromotion(card), [card]);
  return (
    <section className="rounded-2xl border border-card-border bg-card p-3 shadow-sm" aria-labelledby="paper-scorecard-title" data-testid="research-paper-scorecard">
      <h2 id="paper-scorecard-title" className="text-sm font-black">모의매매 승격 점수표</h2>
      {error ? (
        <p className="mt-2 text-[11px] text-amber-800 dark:text-amber-300" role="status">모의 거래 내역을 불러오지 못했습니다. 미측정이며 수익성 없음과 다릅니다.</p>
      ) : !readback ? (
        <p className="mt-2 text-[11px] text-muted-foreground" role="status">불러오는 중…</p>
      ) : (
        <>
          <ul className="mt-2 space-y-1" data-testid="research-paper-scorecard-checklist">
            {checklist.map((row) => (
              <li key={row.key} className="flex items-start justify-between gap-2 text-[11px]">
                <span className="min-w-0"><span className="font-bold">{row.label}</span><span className="block text-muted-foreground">{row.detail}</span></span>
                <span className={`shrink-0 font-black ${STYLE[row.state]}`}>{LABEL[row.state]}</span>
              </li>
            ))}
          </ul>
          {readback.excludedCostIncomplete > 0 ? (
            <p className="mt-2 text-[10px] text-muted-foreground" data-testid="research-paper-scorecard-excluded">
              수수료·세금 근거가 없어 제외한 거래 {readback.excludedCostIncomplete}건 (비용 0으로 계산하지 않습니다)
            </p>
          ) : null}
        </>
      )}
      <p className="mt-2 text-[10px] text-muted-foreground">읽기 전용 · 주문 권한 없음 · 전부 충족해도 검토 대상일 뿐 실전매매 승인이 아닙니다</p>
    </section>
  );
}

export const PaperPromotionScorecard = memo(function PaperPromotionScorecard() {
  const [readback, setReadback] = useState<PaperPromotionTradesReadback | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetchPaperPromotionTrades(controller.signal)
      .then((value) => { setReadback(value); setError(false); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, []);
  return <PaperPromotionScorecardView readback={readback} error={error} />;
});
