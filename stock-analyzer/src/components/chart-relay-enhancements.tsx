import { useMemo, useState } from 'react';
import {
  Activity,
  BarChart3,
  ChevronRight,
  CircleDollarSign,
  Gauge,
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

type DisplayPlan = {
  ok: true;
  symbol: string;
  view: '매수' | '매도' | '중립';
  target: number | null;
  stop: number | null;
  buyLevels: (number | null)[];
  sellLevels: (number | null)[];
  basis: string[];
  invalidation: string[];
  risks: string[];
  dataAsOf: string | null;
  currentPrice: number | null;
  calculationSource: 'server' | 'chart-fallback';
  volatility: number | null;
  rewardRiskRatio: number | null;
};

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundPrice(value: number): number {
  if (value >= 1000) return Math.round(value);
  if (value >= 100) return Math.round(value * 10) / 10;
  if (value >= 1) return Math.round(value * 100) / 100;
  return Math.round(value * 10000) / 10000;
}

export function buildDisplayPlan(
  rawPlan: AnyObj | null,
  candles: AnyObj[],
  symbol = '',
): DisplayPlan | null {
  const normalizedCandles = candles
    .map((row) => ({
      time: finite(row?.time),
      open: finite(row?.open),
      high: finite(row?.high),
      low: finite(row?.low),
      close: finite(row?.close),
      volume: finite(row?.volume) ?? 0,
    }))
    .filter(
      (row) =>
        row.close != null &&
        row.high != null &&
        row.low != null &&
        row.open != null,
    );

  const latest = normalizedCandles.at(-1) ?? null;
  const currentPrice = latest?.close ?? finite(rawPlan?.currentPrice);
  if (currentPrice == null || currentPrice <= 0) return null;

  const recent = normalizedCandles.slice(-60);
  const recent20 = normalizedCandles.slice(-20);
  const recent5 = normalizedCandles.slice(-5);
  const close5 = average(recent5.map((row) => row.close!)) ?? currentPrice;
  const close20 = average(recent20.map((row) => row.close!)) ?? currentPrice;
  const support = recent20.length
    ? Math.min(...recent20.map((row) => row.low!))
    : currentPrice;
  const resistance = recent20.length
    ? Math.max(...recent20.map((row) => row.high!))
    : currentPrice;

  const trueRanges = recent.slice(1).map((row, index) => {
    const previous = recent[index]!;
    return Math.max(
      row.high! - row.low!,
      Math.abs(row.high! - previous.close!),
      Math.abs(row.low! - previous.close!),
    );
  });
  const atr =
    average(trueRanges.slice(-14)) ??
    Math.max(currentPrice * 0.015, Math.abs(resistance - support) / 6);
  const safeAtr = Math.max(atr, currentPrice * 0.005);
  const trendPercent = ((close5 - close20) / Math.max(close20, Number.EPSILON)) * 100;
  const view: DisplayPlan['view'] =
    trendPercent > 0.25 ? '매수' : trendPercent < -0.25 ? '매도' : '중립';

  const fallbackTarget = roundPrice(
    Math.max(resistance, currentPrice + safeAtr * (view === '매수' ? 2.4 : 1.8)),
  );
  const fallbackStop = roundPrice(
    Math.min(support, currentPrice - safeAtr * (view === '매도' ? 2.2 : 1.5)),
  );
  const fallbackBuys = [0.55, 1.05, 1.65].map((multiple) =>
    roundPrice(Math.max(Number.EPSILON, currentPrice - safeAtr * multiple)),
  );
  const fallbackSells = [0.8, 1.55, 2.35].map((multiple) =>
    roundPrice(currentPrice + safeAtr * multiple),
  );

  const serverTarget = finite(rawPlan?.target);
  const serverStop = finite(rawPlan?.stop);
  const serverBuyLevels = Array.isArray(rawPlan?.buyLevels)
    ? rawPlan.buyLevels.map(finite)
    : [];
  const serverSellLevels = Array.isArray(rawPlan?.sellLevels)
    ? rawPlan.sellLevels.map(finite)
    : [];
  const hasServerValues =
    serverTarget != null ||
    serverStop != null ||
    serverBuyLevels.some((value) => value != null) ||
    serverSellLevels.some((value) => value != null);

  const target = serverTarget ?? fallbackTarget;
  const stop = serverStop ?? fallbackStop;
  const buyLevels = [0, 1, 2].map(
    (index) => serverBuyLevels[index] ?? fallbackBuys[index] ?? null,
  );
  const sellLevels = [0, 1, 2].map(
    (index) => serverSellLevels[index] ?? fallbackSells[index] ?? null,
  );
  const risk = Math.max(currentPrice - stop, Number.EPSILON);
  const reward = Math.max(target - currentPrice, 0);
  const rewardRiskRatio = reward > 0 ? reward / risk : null;
  const volumeAverage = average(recent20.map((row) => row.volume));
  const latestVolume = latest?.volume ?? 0;
  const volumeRatio =
    volumeAverage != null && volumeAverage > 0 ? latestVolume / volumeAverage : null;

  const fallbackBasis = [
    `현재가 ${roundPrice(currentPrice).toLocaleString()} 기준으로 최근 5개 봉 평균과 20개 봉 평균을 비교했습니다.`,
    `단기 평균은 ${roundPrice(close5).toLocaleString()}, 중기 평균은 ${roundPrice(close20).toLocaleString()}이며 단기 추세 차이는 ${trendPercent >= 0 ? '+' : ''}${trendPercent.toFixed(2)}%입니다.`,
    `최근 20개 봉 지지 후보는 ${roundPrice(support).toLocaleString()}, 저항 후보는 ${roundPrice(resistance).toLocaleString()}입니다.`,
    `최근 변동폭 기준 ATR 추정값은 ${roundPrice(safeAtr).toLocaleString()}이며 목표가·손절가·분할 가격 간격에 반영했습니다.`,
    volumeRatio == null
      ? '거래량 평균을 계산할 데이터가 부족해 가격과 변동성 중심으로 산출했습니다.'
      : `최근 봉 거래량은 20개 봉 평균의 ${volumeRatio.toFixed(2)}배입니다.`,
  ];
  const serverBasis = Array.isArray(rawPlan?.basis)
    ? rawPlan.basis.map(String).filter(Boolean)
    : [];
  const serverInvalidation = Array.isArray(rawPlan?.invalidation)
    ? rawPlan.invalidation.map(String).filter(Boolean)
    : [];
  const serverRisks = Array.isArray(rawPlan?.risks)
    ? rawPlan.risks.map(String).filter(Boolean)
    : [];

  return {
    ok: true,
    symbol: String(rawPlan?.symbol ?? symbol),
    view:
      rawPlan?.view === '매수' || rawPlan?.view === '매도' || rawPlan?.view === '중립'
        ? rawPlan.view
        : view,
    target,
    stop,
    buyLevels,
    sellLevels,
    basis: serverBasis.length > 0 ? [...serverBasis, ...fallbackBasis] : fallbackBasis,
    invalidation:
      serverInvalidation.length > 0
        ? serverInvalidation
        : [
            `종가가 손절가 ${roundPrice(stop).toLocaleString()} 아래에서 유지되면 현재 상승 시나리오를 무효로 봅니다.`,
            '단기 평균이 중기 평균 아래로 재차 꺾이고 거래량이 동반 증가하면 전략을 다시 계산합니다.',
          ],
    risks:
      serverRisks.length > 0
        ? serverRisks
        : [
            '급등락·갭·호가 공백이 발생하면 표시 가격과 실제 체결 가격이 달라질 수 있습니다.',
            '현재 값은 최근 차트 데이터 기반 참고값이며 실제 주문을 실행하지 않습니다.',
          ],
    dataAsOf:
      rawPlan?.dataAsOf == null
        ? latest?.time == null
          ? null
          : new Date(latest.time * 1000).toISOString()
        : String(rawPlan.dataAsOf),
    currentPrice,
    calculationSource: hasServerValues ? 'server' : 'chart-fallback',
    volatility: safeAtr,
    rewardRiskRatio,
  };
}

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

function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '계산 불가';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function percentFrom(base: number | null, target: number | null): number | null {
  if (base == null || target == null || base === 0) return null;
  return ((target - base) / base) * 100;
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
  plan: DisplayPlan | null;
  asset: Asset;
  settings: AnyObj;
}) {
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const currentPrice = plan?.currentPrice ?? null;

  const rows = useMemo(() => {
    if (!plan) return [];
    const values = [
      {
        key: 'target',
        label: '목표가',
        value: plan.target,
        enabled: settings.target !== false,
        tone: 'text-orange-500',
        summary: '현재 분석 방향이 유지될 때 우선 확인하는 예상 도달 가격입니다.',
        reasons: plan.basis,
        caution: '목표가는 확정 수익 가격이 아니며 추세와 거래량이 바뀌면 함께 변경될 수 있습니다.',
      },
      ...[0, 1, 2].map((index) => ({
        key: `buy-${index + 1}`,
        label: `${index + 1}차 분할매수`,
        value: plan.buyLevels[index] ?? null,
        enabled: settings.buyLevels !== false && settings[`buyLevel${index + 1}`] !== false,
        tone: 'text-red-500',
        summary: '한 가격에 전부 진입하지 않고 가격 구간별로 위험을 나누는 매수 기준입니다.',
        reasons: plan.basis,
        caution: '손절 기준이 무너지면 다음 단계 분할매수를 중단해야 합니다.',
      })),
      ...[0, 1, 2].map((index) => ({
        key: `sell-${index + 1}`,
        label: `${index + 1}차 분할매도`,
        value: plan.sellLevels[index] ?? null,
        enabled: settings.sellLevels !== false && settings[`sellLevel${index + 1}`] !== false,
        tone: 'text-blue-500',
        summary: '상승 또는 반등 구간에서 수익 실현을 여러 단계로 나누는 매도 기준입니다.',
        reasons: plan.basis,
        caution: '분할매도 가격은 고정된 최고점 예측이 아니며 시장 상황에 따라 조정될 수 있습니다.',
      })),
      {
        key: 'stop',
        label: '손절가',
        value: plan.stop,
        enabled: settings.stop !== false,
        tone: 'text-cyan-500',
        summary: '현재 분석 시나리오가 무효화됐다고 판단하는 위험관리 가격입니다.',
        reasons: [...plan.invalidation, ...plan.risks],
        caution: '급격한 변동과 갭 발생 시 실제 체결 가격은 표시 손절가와 달라질 수 있습니다.',
      },
    ];
    return values.filter((item) => item.enabled);
  }, [plan, settings]);

  const targetPercent = percentFrom(currentPrice, plan?.target ?? null);
  const stopPercent = percentFrom(currentPrice, plan?.stop ?? null);

  return (
    <>
      <section className="mt-3 rounded-2xl border border-card-border bg-card p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-black">실시간 가격 계획</h2>
            <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">
              차트에도 같은 가격선이 표시되며 항목을 누르면 상세 근거가 열립니다.
            </p>
          </div>
          <Target className="h-5 w-5 shrink-0 text-primary" />
        </div>

        {!plan ? (
          <div className="mt-3 rounded-2xl bg-secondary px-3 py-4 text-center text-[11px] font-bold text-muted-foreground">
            현재 가격 계획을 계산할 캔들 데이터가 부족합니다.
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
                <span className="mt-1 block text-[9px] font-bold text-muted-foreground">
                  현재가 대비 {formatPercent(percentFrom(currentPrice, item.value))}
                </span>
                <span className="mt-1 flex items-center gap-1 text-[9px] font-bold text-primary">
                  근거 보기 <ChevronRight className="h-3 w-3" />
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {plan && (
        <section className="mt-3 rounded-2xl border border-card-border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-black">상세 전략 분석</h2>
              <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">
                목표가·분할매수·분할매도·손절가를 현재가와 함께 해석합니다.
              </p>
            </div>
            <Gauge className="h-5 w-5 shrink-0 text-primary" />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="rounded-2xl bg-secondary p-3">
              <p className="text-[9px] font-black text-muted-foreground">현재 판단</p>
              <p className="mt-1 text-base font-black">{plan.view}</p>
            </div>
            <div className="rounded-2xl bg-secondary p-3">
              <p className="text-[9px] font-black text-muted-foreground">산출 방식</p>
              <p className="mt-1 text-xs font-black">
                {plan.calculationSource === 'server' ? '서버 AI 계획' : '실시간 차트 보완 계산'}
              </p>
            </div>
            <div className="rounded-2xl bg-secondary p-3">
              <p className="text-[9px] font-black text-muted-foreground">목표 수익 거리</p>
              <p className="mt-1 text-base font-black text-orange-500">{formatPercent(targetPercent)}</p>
            </div>
            <div className="rounded-2xl bg-secondary p-3">
              <p className="text-[9px] font-black text-muted-foreground">손절 위험 거리</p>
              <p className="mt-1 text-base font-black text-cyan-500">{formatPercent(stopPercent)}</p>
            </div>
          </div>

          <div className="mt-3 rounded-2xl border border-card-border bg-background p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] font-black text-muted-foreground">현재가</span>
              <span className="text-sm font-black">{formatPrice(currentPrice, asset)}</span>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-[10px] font-black text-muted-foreground">예상 손익비</span>
              <span className="text-sm font-black text-primary">
                {plan.rewardRiskRatio == null ? '계산 불가' : `1 : ${plan.rewardRiskRatio.toFixed(2)}`}
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-[10px] font-black text-muted-foreground">변동폭 기준</span>
              <span className="text-sm font-black">{formatPrice(plan.volatility, asset)}</span>
            </div>
          </div>

          <div className="mt-4">
            <h3 className="text-xs font-black">산출 근거</h3>
            <div className="mt-2 space-y-2">
              {plan.basis.slice(0, 8).map((reason, index) => (
                <p key={`${index}:${reason}`} className="rounded-xl bg-secondary px-3 py-2 text-[10px] font-bold leading-4">
                  {index + 1}. {reason}
                </p>
              ))}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3">
            <div className="rounded-2xl border border-warning/40 bg-warning/10 p-3">
              <p className="text-[10px] font-black text-warning">무효화 조건</p>
              {plan.invalidation.map((reason, index) => (
                <p key={`${index}:${reason}`} className="mt-1 text-[10px] font-bold leading-4 text-warning">
                  · {reason}
                </p>
              ))}
            </div>
            <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-3">
              <p className="text-[10px] font-black text-destructive">위험요인</p>
              {plan.risks.map((risk, index) => (
                <p key={`${index}:${risk}`} className="mt-1 text-[10px] font-bold leading-4 text-destructive">
                  · {risk}
                </p>
              ))}
            </div>
          </div>
        </section>
      )}

      {explanation && (
        <CenterExplanationModal explanation={explanation} onClose={() => setExplanation(null)} />
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
  symbol,
  interval,
}: {
  query: AnyObj;
  signals: AnyObj[];
  activeSignalId: string | null;
  onSelect: (signal: AnyObj) => void;
  plan: DisplayPlan | null;
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
      const currentTime = current ? new Date(String(current.occurredAt ?? '')).getTime() || 0 : -1;
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
              현재 발생한 신호의 방향·강도·근거·무효화 조건을 한 화면에서 정리합니다.
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

      {plan && (
        <div className="rounded-2xl border border-card-border bg-card p-3">
          <h3 className="text-sm font-black">가격 전략 요약</h3>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] font-bold">
            <p className="rounded-xl bg-secondary px-3 py-2">목표가 {plan.target?.toLocaleString() ?? '없음'}</p>
            <p className="rounded-xl bg-secondary px-3 py-2">손절가 {plan.stop?.toLocaleString() ?? '없음'}</p>
            <p className="rounded-xl bg-secondary px-3 py-2">분할매수 {plan.buyLevels.filter((value) => value != null).length}단계</p>
            <p className="rounded-xl bg-secondary px-3 py-2">분할매도 {plan.sellLevels.filter((value) => value != null).length}단계</p>
          </div>
          <div className="mt-3 space-y-2">
            {plan.basis.slice(0, 6).map((reason, index) => (
              <p key={`${index}:${reason}`} className="rounded-xl bg-secondary px-3 py-2 text-[10px] font-bold leading-4">
                {index + 1}. {reason}
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
          <select value={kind} onChange={(event) => setKind(event.target.value)} className="rounded-xl border border-card-border bg-background px-2 py-2 text-[10px] font-black" aria-label="신호 종류">
            <option value="all">종류 전체</option>
            <option value="chart">차트 패턴</option>
            <option value="candle">캔들 패턴</option>
            <option value="volume">거래량</option>
            <option value="indicator">기술지표</option>
          </select>
          <select value={importance} onChange={(event) => setImportance(event.target.value)} className="rounded-xl border border-card-border bg-background px-2 py-2 text-[10px] font-black" aria-label="신호 중요도">
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
              <button key={`${signal.kind}:${signal.id}`} type="button" onClick={() => onSelect(signal)} className={cn('w-full rounded-2xl border p-3 text-left', activeSignalId === signal.id ? 'border-primary bg-primary/5' : 'border-card-border bg-background')}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1">
                      <p className="truncate text-sm font-black">{String(signal.name ?? '신호')}</p>
                      <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[9px] font-black text-muted-foreground">{stageLabel(String(signal.stage ?? 'START'))}</span>
                      <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-black text-primary">{importanceLabel(signal.importance)}</span>
                    </div>
                    <p className="mt-1 text-[10px] font-bold text-muted-foreground">{kindLabel(String(signal.kind ?? 'chart'))} · {formatTime(signal.occurredAt)}</p>
                    <p className="mt-2 line-clamp-2 text-[10px] font-bold leading-4 text-foreground">{String(signal.meaningHere || signal.meaningGeneral || '현재 조건과 과거 패턴의 관계를 분석한 신호입니다.')}</p>
                  </div>
                  <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-primary" />
                </div>
              </button>
            ))
          )}
        </div>
      </div>
      <div className="rounded-2xl border border-warning/40 bg-warning/10 p-3 text-[10px] font-bold leading-4 text-warning">
        신호 분석은 참고용이며 실제 주문을 실행하지 않습니다. 신호가 충돌하면 중요도, 거래량, 손절가와 무효화 조건을 함께 확인하세요.
      </div>
    </section>
  );
}
