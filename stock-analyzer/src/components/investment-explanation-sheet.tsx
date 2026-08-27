import { useState, type ReactNode } from 'react';
import { CircleHelp, X } from 'lucide-react';
import {
  describeMetricChange,
  getInvestmentExplanation,
  type InvestmentExplanationKey,
} from '@/lib/investment-explanations';

type Props = {
  metric: InvestmentExplanationKey;
  value?: ReactNode;
  status?: string | null;
  current?: number | null;
  previous?: number | null;
  compact?: boolean;
  className?: string;
};

export function InvestmentExplanationButton({
  metric,
  value,
  status,
  current,
  previous,
  compact = false,
  className = '',
}: Props) {
  const [open, setOpen] = useState(false);
  const explanation = getInvestmentExplanation(metric);
  const change = describeMetricChange(metric, current, previous);

  return <>
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label={`${explanation.label} 설명 보기`}
      className={`${compact ? 'min-h-8 px-2 text-[10px]' : 'min-h-10 px-3 text-xs'} inline-flex items-center justify-center gap-1.5 rounded-full border border-border bg-background font-black text-muted-foreground transition hover:bg-muted hover:text-foreground ${className}`}
    >
      <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />
      왜?
    </button>

    {open ? <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) setOpen(false);
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={`investment-explanation-${metric}`}
        className="max-h-[82vh] w-full overflow-y-auto rounded-t-3xl border border-border bg-card p-4 shadow-2xl sm:max-w-lg sm:rounded-3xl sm:p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-black text-primary">숫자 쉽게 보기</p>
            <h2 id={`investment-explanation-${metric}`} className="mt-1 text-lg font-black">{explanation.label}</h2>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="설명 닫기"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-background"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {(value != null || status) ? <div className="mt-4 rounded-2xl border border-primary/20 bg-primary/5 p-3">
          <p className="text-[11px] font-bold text-muted-foreground">현재 화면</p>
          {value != null ? <div className="mt-1 text-base font-black">{value}</div> : null}
          {status ? <p className="mt-1 text-xs font-bold text-muted-foreground">상태: {status}</p> : null}
        </div> : null}

        <div className="mt-4 space-y-3 text-sm leading-6">
          <div>
            <p className="text-xs font-black text-muted-foreground">한마디로</p>
            <p className="mt-1 break-keep">{explanation.oneLine}</p>
          </div>
          <div>
            <p className="text-xs font-black text-muted-foreground">왜 중요한가</p>
            <p className="mt-1 break-keep">{explanation.whyItMatters}</p>
          </div>
          {change ? <div>
            <p className="text-xs font-black text-muted-foreground">이전과 비교</p>
            <p className="mt-1 break-keep">{change}</p>
          </div> : null}
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-3">
            <p className="text-xs font-black">주의해서 볼 점</p>
            <p className="mt-1 break-keep text-xs leading-5 text-muted-foreground">{explanation.caution}</p>
          </div>
          <div>
            <p className="text-xs font-black text-muted-foreground">같이 보면 좋은 것</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {explanation.related.map((item) => <span key={item} className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-bold">{item}</span>)}
            </div>
          </div>
        </div>

        <p className="mt-4 border-t border-border pt-3 text-[10px] font-bold leading-4 text-muted-foreground">
          이 설명은 정해진 정의와 현재 canonical 데이터만 해석합니다. AI 호출·주문·계좌 조회를 발생시키지 않습니다.
        </p>
      </section>
    </div> : null}
  </>;
}
