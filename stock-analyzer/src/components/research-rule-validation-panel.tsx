import { useQuery } from '@tanstack/react-query';
import {
  fetchRuleValidationReport,
  formatSegment,
  STUDY_STATUS_LABEL,
  VERDICT_LABEL,
  type RuleStudy,
  type RuleVerdict,
} from '@/lib/rule-validation';

const VERDICT_STYLE: Readonly<Record<RuleVerdict, string>> = {
  fail: 'border-destructive/30 bg-destructive/10 text-destructive',
  insufficient_samples: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  pass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
};

function StudyBlock({ study }: { study: RuleStudy }) {
  return (
    <details className="rounded-2xl border border-card-border bg-background" data-testid={`rule-validation-study-${study.id}`}>
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-2 p-3 text-xs">
        <span className="min-w-0 font-black">{study.label}</span>
        <span className="shrink-0 rounded-full border border-card-border px-2.5 py-1 text-[11px] font-black">
          {STUDY_STATUS_LABEL[study.status]}
        </span>
      </summary>
      <div className="space-y-2 border-t border-card-border p-3 text-[11px]">
        <dl className="grid grid-cols-2 gap-2">
          <div><dt className="text-muted-foreground">봉 단위</dt><dd className="mt-0.5 font-bold">{study.timeframe}</dd></div>
          <div><dt className="text-muted-foreground">종목</dt><dd className="mt-0.5 font-bold">{study.symbolsLabel}</dd></div>
          <div className="col-span-2"><dt className="text-muted-foreground">기간</dt><dd className="mt-0.5 font-bold">{study.periodLabel}</dd></div>
          <div className="col-span-2"><dt className="text-muted-foreground">비용 가정</dt><dd className="mt-0.5 font-bold">{study.costLabel}</dd></div>
        </dl>
        <p className="rounded-lg bg-muted/50 p-2 leading-5 text-muted-foreground">{study.note}</p>
        {study.rows.length ? (
          <ul className="space-y-2">
            {study.rows.map((row, index) => (
              <li key={`${row.ruleLabel}-${row.barrierLabel}-${index}`} className="rounded-xl border border-card-border p-2.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 font-black">{row.ruleLabel} <span className="font-normal text-muted-foreground">· {row.barrierLabel}</span></p>
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-black ${VERDICT_STYLE[row.verdict]}`}>
                    {VERDICT_LABEL[row.verdict]}
                  </span>
                </div>
                <dl className="mt-2 grid gap-1 tabular-nums">
                  <div className="flex justify-between gap-2"><dt className="text-muted-foreground">학습</dt><dd>{formatSegment(row.train)}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-muted-foreground">검증</dt><dd>{formatSegment(row.validation)}</dd></div>
                  {row.test ? <div className="flex justify-between gap-2"><dt className="text-muted-foreground">테스트</dt><dd>{formatSegment(row.test)}</dd></div> : null}
                  {row.stressTest ? <div className="flex justify-between gap-2"><dt className="text-muted-foreground">테스트(비용 1.5배)</dt><dd>{formatSegment(row.stressTest)}</dd></div> : null}
                </dl>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">세부 수치는 기록하지 않았습니다.</p>
        )}
      </div>
    </details>
  );
}

/** Read-only. No order, strategy-submit or trading action exists on this panel. */
export function ResearchRuleValidationPanel() {
  const query = useQuery({
    queryKey: ['research-rule-validation'],
    queryFn: ({ signal }) => fetchRuleValidationReport(signal),
    staleTime: 60_000,
    retry: false,
  });
  const report = query.data ?? null;
  return (
    <section className="rounded-3xl border border-card-border bg-card p-4 sm:p-5" data-testid="research-rule-validation">
      <h2 className="text-base font-black">규칙 검증 결과</h2>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        수수료와 슬리피지를 뺀 뒤에도 기대수익이 플러스인지, 학습·검증·테스트 구간을 모두 통과하는지 확인한 기록입니다. 매매 신호가 아니며 주문과 연결되지 않습니다.
      </p>
      {query.isPending ? <p role="status" className="mt-3 text-xs text-muted-foreground">불러오는 중</p> : null}
      {query.isError ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          규칙 검증 결과를 불러오지 못했습니다. 오류를 합격이나 0으로 바꾸지 않습니다.
        </p>
      ) : null}
      {report ? (
        <div className="mt-3 space-y-3">
          <div
            className={`rounded-2xl border p-3 ${report.passedRuleCount === 0 ? 'border-amber-500/30 bg-amber-500/10' : 'border-emerald-500/30 bg-emerald-500/10'}`}
            data-testid="rule-validation-headline"
          >
            <p className="text-sm font-black">
              {report.passedRuleCount === 0 ? '통과한 규칙이 없습니다' : `통과한 규칙 ${report.passedRuleCount}개`}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{report.summary}</p>
          </div>
          <div className="space-y-2">
            {report.studies.map((study) => <StudyBlock key={study.id} study={study} />)}
          </div>
          <p className="text-[10px] text-muted-foreground">
            기록 시각 {new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(report.generatedAt))} · 과거 데이터 기준이며 수익을 보장하지 않습니다.
          </p>
        </div>
      ) : null}
    </section>
  );
}
