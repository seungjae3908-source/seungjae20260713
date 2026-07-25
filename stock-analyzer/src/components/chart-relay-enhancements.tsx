import { useMemo, useState } from 'react';
import {
  Activity,
  BarChart3,
  ChevronRight,
  CircleDollarSign,
  ShieldAlert,
  Target,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type AnyObj = Record<string, any>;
type Asset = 'stockKR' | 'stockUS' | 'coinSpot' | 'coinFutures';
type Explanation = {
  title: string;
  value?: string;
  summary: string;
  reasons: string[];
  caution?: string;
};

function formatPrice(value: number | null | undefined, asset: Asset): string {
  if (value == null || !Number.isFinite(value)) return '산출 불가';
  if (asset === 'stockUS') {
    return `$${value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  if (asset === 'coinSpot' || asset === 'coinFutures') {
    return value.toLocaleString(undefined, {
      maximumFractionDigits: value >= 100 ? 0 : 4,
    });
  }
  return `${Math.round(value).toLocaleString()}원`;
}

function formatTime(value: unknown): string {
  const date = new Date(String(value ?? ''));
  if (!Number.isFinite(date.getTime())) return '시간 정보 없음';
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function stageLabel(stage: string): string {
  if (stage === 'COMPLETED') return '완성';
  if (stage === 'DEVELOPING') return '진행';
  if (stage === 'INVALIDATED') return '이탈';
  return '시작';
}

function kindLabel(kind: string): string {
  if (kind === 'candle') return '캔들 패턴';
  if (kind === 'volume') return '거래량 신호';
  if (kind === 'indicator') return '기술지표';
  return '차트 패턴';
}

function importanceLabel(value: unknown): string {
  const text = String(value ?? '').toLowerCase();
  if (text.includes('high') || text.includes('높') || text.includes('critical')) return '높음';
  if (text.includes('low') || text.includes('낮')) return '낮음';
  return '중간';
}

function isBullish(signal: AnyObj): boolean {
  return /상승|매수|강세|돌파|쌍바닥|망치|샛별/.test(String(signal?.name ?? ''));
}

function isBearish(signal: AnyObj): boolean {
  return /하락|매도|약세|이탈|쌍봉|유성|석별/.test(String(signal?.name ?? ''));
}

function CenterExplanationModal({
  explanation,
  onClose,
}: {
  explanation: Explanation;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-4"
      onClick={onClose}
      role="presentation"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={explanation.title}
        className="relative max-h-[86vh] w-full max-w-md overflow-y-auto rounded-3xl border border-card-border bg-background p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="닫기"
          className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="pr-10">
          <p className="text-[10px] font-black text-primary">근거와 설명</p>
          <h3 className="mt-1 text-lg font-black">{explanation.title}</h3>
          {explanation.value && (
            <p className="mt-2 text-xl font-black text-foreground">{explanation.value}</p>
          )}
        </div>

        <p className="mt-4 rounded-2xl bg-secondary px-4 py-3 text-xs font-bold leading-5 text-foreground">
          {explanation.summary}
        </p>

        <div className="mt-4">
          <p className="text-xs font-black">왜 이 값이 표시됐나요?</p>
          <div className="mt-2 space-y-2">
            {explanation.reasons.length > 0 ? (
              explanation.reasons.map((reason, index) => (
                <div
                  key={`${index}:${reason}`}
                  className="rounded-2xl border border-card-border bg-card px-3 py-2.5 text-[11px] font-bold leading-5"
                >
                  {index + 1}. {reason}
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-card-border bg-card px-3 py-2.5 text-[11px] font-bold text-muted-foreground">
                현재 제공된 데이터에서 추가 근거 문구를 찾지 못했습니다.
              </div>
            )}
          </div>
        </div>

        {explanation.caution && (
          <div className="mt-4 flex gap-2 rounded-2xl border border-warning/40 bg-warning/10 p-3 text-[10px] font-bold leading-4 text-warning">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{explanation.caution}</span>
          </div>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-5 h-11 w-full rounded-2xl bg-primary text-sm font-black text-primary-foreground"
        >
          닫기
        </button>
      </section>
    </div>
  );
}

export function PlanLevelsPanel({
  plan,
  asset,
  settings,
}: {
  plan: AnyObj | null;
  asset: Asset;
  settings: AnyObj;
}) {
  const [explanation, setExplanation] = useState<Explanation | null>(null);

  const rows = useMemo(() => {
    if (!plan) return [];
    const basis = Array.isArray(plan.basis) ? plan.basis.map(String).filter(Boolean) : [];
    const invalidation = Array.isArray(plan.invalidation)
      ? plan.invalidation.map(String).filter(Boolean)
      : [];
    const risks = Array.isArray(plan.risks) ? plan.risks.map(String).filter(Boolean) : [];
    const values: Array<{
      key: string;
      label: string;
      value: number | null;
      enabled: boolean;
      tone: string;
      summary: string;
      reasons: string[];
      caution: string;
    }> = [
      {
        key: 'target',
        label: '목표가',
        value: plan.target ?? null,
        enabled: settings.target !== false,
        tone: 'text-orange-500',
        summary: '현재 분석 방향이 유지될 때 우선 확인하는 예상 도달 가격입니다.',
        reasons: basis,
        caution: '목표가는 확정 수익 가격이 아니며 추세와 거래량이 바뀌면 함께 변경될 수 있습니다.',
      },
      ...[0, 1, 2].map((index) => ({
        key: `buy-${index + 1}`,
        label: `${index + 1}차 분할매수`,
        value: plan.buyLevels?.[index] ?? null,
        enabled:
          settings.buyLevels !== false &&
          settings[`buyLevel${index + 1}`] !== false,
        tone: 'text-red-500',
        summary: '한 가격에 전부 진입하지 않고 가격 구간별로 위험을 나누는 매수 기준입니다.',
        reasons: basis,
        caution: '분할매수는 손실을 없애는 방법이 아닙니다. 손절 기준이 무너지면 추가매수를 중단해야 합니다.',
      })),
      ...[0, 1, 2].map((index) => ({
        key: `sell-${index + 1}`,
        label: `${index + 1}차 분할매도`,
        value: plan.sellLevels?.[index] ?? null,
        enabled:
          settings.sellLevels !== false &&
          settings[`sellLevel${index + 1}`] !== false,
        tone: 'text-blue-500',
        summary: '상승 또는 반등 구간에서 수익 실현을 여러 단계로 나누는 매도 기준입니다.',
        reasons: basis,
        caution: '분할매도 가격은 고정된 최고점 예측이 아니며 시장 상황에 따라 조정될 수 있습니다.',
      })),
      {
        key: 'stop',
        label: '손절가',
        value: plan.stop ?? null,
        enabled: settings.stop !== false,
        tone: 'text-cyan-500',
        summary: '현재 분석 시나리오가 무효화됐다고 판단하는 위험관리 가격입니다.',
        reasons: [...invalidation, ...risks],
        caution: '손절가는 참고 기준입니다. 급격한 변동과 갭 발생 시 실제 체결 가격은 달라질 수 있습니다.',
      },
    ];
    return values.filter((item) => item.enabled);
  }, [plan, settings]);

  return (
    <>
      <section className="mt-3 rounded-2xl border border-card-border bg-card p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-black">실시간 가격 계획</h2>
            <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">
              항목을 누르면 산출 근거와 주의사항을 확인할 수 있습니다.
            </p>
          </div>
          <Target className="h-5 w-5 shrink-0 text-primary" />
        </div>

        {!plan ? (
          <div className="mt-3 rounded-2xl bg-secondary px-3 py-4 text-center text-[11px] font-bold text-muted-foreground">
            현재 가격 계획을 계산 중이거나 제공할 데이터가 부족합니다.
          </div>
        ) : rows.length === 0 ? (
          <div className="mt-3 rounded-2xl bg-secondary px-3 py-4 text-center text-[11px] font-bold text-muted-foreground">
            환경설정에서 모든 가격 표시가 꺼져 있습니다.
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-2">
            {rows.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() =>
                  setExplanation({
                    title: item.label,
                    value: formatPrice(item.value, asset),
                    summary: item.summary,
                    reasons: item.reasons,
                    caution: item.caution,
                  })
                }
                className="rounded-2xl border border-card-border bg-background px-3 py-3 text-left"
              >
                <span className="block text-[10px] font-black text-muted-foreground">{item.label}</span>
                <span className={cn('mt-1 block text-sm font-black', item.tone)}>
                  {formatPrice(item.value, asset)}
                </span>
                <span className="mt-1 flex items-center gap-1 text-[9px] font-bold text-primary">
                  근거 보기 <ChevronRight className="h-3 w-3" />
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {explanation && (
        <CenterExplanationModal
          explanation={explanation}
          onClose={() => setExplanation(null)}
        />
      )}
    </>
  );
}

export function SignalAnalysisWorkspace({
  query,
  signals,
  activeSignalId,
  onSelect,
  plan,
  asset,
  symbol,
  interval,
}: {
  query: AnyObj;
  signals: AnyObj[];
  activeSignalId: string | null;
  onSelect: (signal: AnyObj) => void;
  plan: AnyObj | null;
  asset: Asset;
  symbol: string;
  interval: string;
}) {
  const [kind, setKind] = useState('all');
  const [importance, setImportance] = useState('all');

  const uniqueSignals = useMemo(() => {
    const found = new Map<string, AnyObj>();
    for (const signal of signals) {
      const key = `${signal.kind}:${String(signal.name ?? '').trim().toLowerCase()}`;
      const current = found.get(key);
      const nextTime = new Date(String(signal.occurredAt ?? '')).getTime() || 0;
      const currentTime = current
        ? new Date(String(current.occurredAt ?? '')).getTime() || 0
        : -1;
      if (!current || nextTime >= currentTime) found.set(key, signal);
    }
    return [...found.values()].sort(
      (left, right) =>
        (new Date(String(right.occurredAt ?? '')).getTime() || 0) -
        (new Date(String(left.occurredAt ?? '')).getTime() || 0),
    );
  }, [signals]);

  const visibleSignals = uniqueSignals.filter((signal) => {
    if (kind !== 'all' && signal.kind !== kind) return false;
    if (importance !== 'all' && importanceLabel(signal.importance) !== importance) return false;
    return true;
  });

  const bullish = uniqueSignals.filter(isBullish).length;
  const bearish = uniqueSignals.filter(isBearish).length;
  const high = uniqueSignals.filter((signal) => importanceLabel(signal.importance) === '높음').length;
  const conclusion =
    plan?.view === '매수'
      ? { label: '매수 우세', icon: TrendingUp, className: 'text-red-500' }
      : plan?.view === '매도'
        ? { label: '매도 우세', icon: TrendingDown, className: 'text-blue-500' }
        : { label: '중립·관찰', icon: Activity, className: 'text-foreground' };
  const ConclusionIcon = conclusion.icon;

  return (
    <section className="mt-3 space-y-3">
      <div className="rounded-3xl border border-card-border bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-black text-primary">실시간 신호 분석 전용 화면</p>
            <h2 className="mt-1 text-lg font-black">{symbol} · {interval}</h2>
            <p className="mt-1 text-[10px] font-bold text-muted-foreground">
              차트 화면을 반복하지 않고 현재 발생한 신호의 방향·강도·근거만 정리합니다.
            </p>
          </div>
          <BarChart3 className="h-6 w-6 shrink-0 text-primary" />
        </div>

        <div className="mt-4 rounded-2xl bg-secondary p-4">
          <p className="text-[10px] font-black text-muted-foreground">현재 종합 판단</p>
          <div className="mt-1 flex items-center gap-2">
            <ConclusionIcon className={cn('h-5 w-5', conclusion.className)} />
            <p className={cn('text-xl font-black', conclusion.className)}>{conclusion.label}</p>
          </div>
          <p className="mt-2 text-[10px] font-bold leading-4 text-muted-foreground">
            상승 신호 {bullish}개 · 하락 신호 {bearish}개 · 중요도 높음 {high}개
          </p>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <div className="rounded-2xl border border-card-border bg-background p-3 text-center">
            <TrendingUp className="mx-auto h-4 w-4 text-red-500" />
            <p className="mt-1 text-lg font-black">{bullish}</p>
            <p className="text-[9px] font-bold text-muted-foreground">상승 근거</p>
          </div>
          <div className="rounded-2xl border border-card-border bg-background p-3 text-center">
            <TrendingDown className="mx-auto h-4 w-4 text-blue-500" />
            <p className="mt-1 text-lg font-black">{bearish}</p>
            <p className="text-[9px] font-bold text-muted-foreground">하락 근거</p>
          </div>
          <div className="rounded-2xl border border-card-border bg-background p-3 text-center">
            <CircleDollarSign className="mx-auto h-4 w-4 text-primary" />
            <p className="mt-1 text-lg font-black">{uniqueSignals.length}</p>
            <p className="text-[9px] font-bold text-muted-foreground">현재 신호</p>
          </div>
        </div>
      </div>

      {Array.isArray(plan?.basis) && plan.basis.length > 0 && (
        <div className="rounded-2xl border border-card-border bg-card p-3">
          <h3 className="text-sm font-black">종합 판단 근거</h3>
          <div className="mt-2 space-y-2">
            {plan.basis.slice(0, 5).map((reason: unknown, index: number) => (
              <p key={`${index}:${String(reason)}`} className="rounded-xl bg-secondary px-3 py-2 text-[10px] font-bold leading-4">
                {index + 1}. {String(reason)}
              </p>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-card-border bg-card p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-black">감지된 신호</h3>
            <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">
              신호를 누르면 중앙 설명창에서 발생 이유와 무효화 조건을 확인합니다.
            </p>
          </div>
          <Activity className="h-5 w-5 shrink-0 text-primary" />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            className="rounded-xl border border-card-border bg-background px-2 py-2 text-[10px] font-black"
            aria-label="신호 종류"
          >
            <option value="all">종류 전체</option>
            <option value="chart">차트 패턴</option>
            <option value="candle">캔들 패턴</option>
            <option value="volume">거래량</option>
            <option value="indicator">기술지표</option>
          </select>
          <select
            value={importance}
            onChange={(event) => setImportance(event.target.value)}
            className="rounded-xl border border-card-border bg-background px-2 py-2 text-[10px] font-black"
            aria-label="신호 중요도"
          >
            <option value="all">중요도 전체</option>
            <option value="높음">높음</option>
            <option value="중간">중간</option>
            <option value="낮음">낮음</option>
          </select>
        </div>

        <div className="mt-3 space-y-2">
          {query?.isLoading && uniqueSignals.length === 0 ? (
            <div className="rounded-2xl bg-secondary px-3 py-5 text-center text-[11px] font-bold text-muted-foreground">신호 분석 중...</div>
          ) : query?.isError && uniqueSignals.length === 0 ? (
            <div className="rounded-2xl border border-warning/40 bg-warning/10 px-3 py-5 text-center text-[11px] font-bold text-warning">신호 데이터를 불러오지 못했습니다.</div>
          ) : visibleSignals.length === 0 ? (
            <div className="rounded-2xl bg-secondary px-3 py-5 text-center text-[11px] font-bold text-muted-foreground">선택한 조건에 맞는 신호가 없습니다.</div>
          ) : (
            visibleSignals.map((signal) => (
              <button
                key={`${signal.kind}:${signal.id}`}
                type="button"
                onClick={() => onSelect(signal)}
                className={cn(
                  'w-full rounded-2xl border p-3 text-left',
                  activeSignalId === signal.id
                    ? 'border-primary bg-primary/5'
                    : 'border-card-border bg-background',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1">
                      <p className="truncate text-sm font-black">{String(signal.name ?? '신호')}</p>
                      <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[9px] font-black text-muted-foreground">
                        {stageLabel(String(signal.stage ?? 'START'))}
                      </span>
                      <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-black text-primary">
                        {importanceLabel(signal.importance)}
                      </span>
                    </div>
                    <p className="mt-1 text-[10px] font-bold text-muted-foreground">
                      {kindLabel(String(signal.kind ?? 'chart'))} · {formatTime(signal.occurredAt)}
                    </p>
                    <p className="mt-2 line-clamp-2 text-[10px] font-bold leading-4 text-foreground">
                      {String(signal.meaningHere || signal.meaningGeneral || '현재 조건과 과거 패턴의 관계를 분석한 신호입니다.')}
                    </p>
                  </div>
                  <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-primary" />
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-warning/40 bg-warning/10 p-3 text-[10px] font-bold leading-4 text-warning">
        신호 분석은 참고용이며 실제 주문을 실행하지 않습니다. 신호가 서로 충돌하면 중요도, 거래량, 무효화 조건을 함께 확인하세요.
      </div>
    </section>
  );
}
