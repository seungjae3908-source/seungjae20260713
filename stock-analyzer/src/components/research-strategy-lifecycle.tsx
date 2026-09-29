import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Bot,
  Braces,
  ChartNoAxesCombined,
  DatabaseZap,
  FlaskConical,
  ShieldCheck,
} from 'lucide-react';
import { Link } from 'wouter';
import {
  fetchResearchAdoptionReview,
  fetchResearchPromotionBridge,
} from '@/lib/strategy-promotion';

const LOOP = [
  {
    key: 'formula',
    label: '수식 후보',
    detail: '제한된 Strategy DSL로 후보를 만들고 미래참조·임의 실행 코드를 차단합니다.',
    owner: 'Formula Generator',
    icon: Braces,
  },
  {
    key: 'review',
    label: 'AI 반대검토',
    detail: 'Proposer와 Adversarial Reviewer는 가설만 제안하며 수익성 숫자를 결정하지 않습니다.',
    owner: 'Dual AI Review',
    icon: Bot,
  },
  {
    key: 'backtest',
    label: '백테스트',
    detail: '수익률·PF·MDD·거래수·비용은 기존 Backtester owner가 계산합니다.',
    owner: 'Backtester',
    icon: ChartNoAxesCombined,
  },
  {
    key: 'validation',
    label: 'Validation / OOS',
    detail: '개발 구간과 독립 검증 구간을 분리하고 Walk Forward 오염을 차단합니다.',
    owner: 'Trial Registry',
    icon: FlaskConical,
  },
  {
    key: 'registry',
    label: 'Strategy Registry',
    detail: '후보 정의·파라미터·연구 SHA를 고정하고 Holdout 상태를 별도로 관리합니다.',
    owner: 'Strategy Registry',
    icon: DatabaseZap,
  },
  {
    key: 'promotion',
    label: '승격 검토',
    detail: 'Full Cost·Paper·Shadow 근거가 같은 후보에 묶인 경우에만 사람 검토로 넘어갑니다.',
    owner: 'Promotion Gate',
    icon: ShieldCheck,
  },
] as const;

const DSL = [
  'FEATURE',
  'CONSTANT',
  'GT / GTE / LT / LTE / EQ',
  'AND / OR / NOT',
  'ADD / SUBTRACT / MULTIPLY / DIVIDE',
  'ABS',
  'CROSS_ABOVE / CROSS_BELOW',
] as const;

function number(value: number | null) {
  return value == null ? '미확인' : value.toLocaleString('ko-KR');
}

export function ResearchStrategyLifecycle() {
  const bridge = useQuery({
    queryKey: ['research-promotion-bridge'],
    queryFn: ({ signal }) => fetchResearchPromotionBridge(signal),
    staleTime: 0,
    retry: 1,
  });
  const adoption = useQuery({
    queryKey: ['research-adoption-review'],
    queryFn: ({ signal }) => fetchResearchAdoptionReview(signal),
    staleTime: 0,
    retry: 1,
  });

  const evidence = bridge.data?.evidence ?? null;
  const candidate = bridge.data?.candidate ?? null;

  return (
    <section
      className="rounded-2xl border border-card-border bg-card p-4 shadow-sm"
      data-testid="research-strategy-lifecycle"
      aria-label="수식 연구부터 전략 승격까지 연결 상태"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-primary">Strategy Research Loop</p>
          <h3 className="mt-1 text-base font-black">수식 → 검증 → Registry → 승격 검토</h3>
          <p className="mt-1 max-w-3xl break-keep text-xs leading-5 text-muted-foreground">
            기존 Formula Generator, Backtester, Trial/Strategy Registry, Promotion Gate를 재사용합니다.
            이 화면은 연구 상태를 읽기만 하며 자동채택·실거래 권한을 만들지 않습니다.
          </p>
        </div>
        <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-black text-emerald-700 dark:text-emerald-300">
          실행 권한 NONE
        </span>
      </div>

      <ol className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label="전략 연구 폐루프 단계">
        {LOOP.map((stage, index) => {
          const Icon = stage.icon;
          return (
            <li key={stage.key} className="min-w-0 rounded-xl border border-card-border bg-background/70 p-3">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="text-[10px] font-bold text-muted-foreground">{index + 1}. {stage.owner}</p>
                  <p className="truncate text-sm font-black">{stage.label}</p>
                </div>
                {index < LOOP.length - 1 ? <ArrowRight className="ml-auto hidden h-4 w-4 shrink-0 text-muted-foreground xl:block" aria-hidden="true" /> : null}
              </div>
              <p className="mt-2 break-keep text-xs leading-5 text-muted-foreground">{stage.detail}</p>
            </li>
          );
        })}
      </ol>

      <div className="mt-4 grid gap-3 lg:grid-cols-[1.15fr_1fr]">
        <section className="rounded-xl border border-card-border bg-background p-3" aria-label="수식 엔진 계약">
          <div className="flex items-center gap-2">
            <Braces className="h-4 w-4 text-primary" aria-hidden="true" />
            <h4 className="text-sm font-black">Formula DSL 계약</h4>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            임의 JavaScript 실행이 아니라 제한된 연산자만 허용합니다. KR/US/Spot은 매수 방향, Futures는 LONG/SHORT 연구가 가능합니다.
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5" data-testid="research-formula-dsl">
            {DSL.map((item) => (
              <span key={item} className="rounded-lg border border-card-border bg-muted/30 px-2 py-1 text-[10px] font-bold">
                {item}
              </span>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-card-border bg-background p-3" aria-label="현재 승격 근거">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-black">현재 Research → Promotion 근거</h4>
            <span className="text-[10px] font-bold text-muted-foreground">
              {bridge.isLoading ? '확인 중' : bridge.isError ? '조회 불가' : bridge.data?.status ?? '미연결'}
            </span>
          </div>
          {bridge.data ? (
            <>
              <p className="mt-2 break-all text-xs font-bold">
                후보: {candidate ? candidate.strategyId : '현재 연결 후보 없음'}
              </p>
              <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                {[
                  ['TRAIN', number(evidence?.trainN ?? null)],
                  ['Validation', number(evidence?.validationN ?? null)],
                  ['OOS', number(evidence?.oosN ?? null)],
                  ['Settlement', number(evidence?.settlementN ?? null)],
                  ['Full Cost', evidence?.fullCostReady ? 'READY' : '미완료'],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg bg-muted/30 p-2">
                    <dt className="text-[10px] font-bold text-muted-foreground">{label}</dt>
                    <dd className="mt-1 break-words text-xs font-black tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
              {bridge.data.blockers.length ? (
                <p className="mt-2 break-words text-[10px] leading-4 text-amber-700 dark:text-amber-300">
                  차단: {bridge.data.blockers.join(' · ')}
                </p>
              ) : null}
            </>
          ) : (
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              승격 bridge를 읽지 못했습니다. 미수집을 0건이나 실패로 간주하지 않습니다.
            </p>
          )}
          <p className="mt-2 text-[10px] text-muted-foreground">
            채택 Gate: {adoption.isLoading ? '확인 중' : adoption.isError ? '조회 불가' : adoption.data?.status ?? '미연결'} · 사람 검토 필수
          </p>
        </section>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <Link
          href="/backtests"
          className="flex min-h-11 items-center justify-center rounded-xl border border-card-border bg-background px-3 py-2 text-sm font-black hover:border-primary/40"
        >
          백테스터 열기
        </Link>
        <Link
          href="/strategy-promotion"
          className="flex min-h-11 items-center justify-center rounded-xl border border-card-border bg-background px-3 py-2 text-sm font-black hover:border-primary/40"
        >
          승격 근거 전체 보기
        </Link>
      </div>

      <p className="mt-3 text-[10px] leading-4 text-muted-foreground">
        자동 Live 승격 없음 · Final Holdout 자동 개방 없음 · Scanner/Paper 자동 적용 없음 · Production/DB/Secret 변경 없음
      </p>
    </section>
  );
}
