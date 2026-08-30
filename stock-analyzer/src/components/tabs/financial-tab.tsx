import { useState } from 'react';
import { X } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from 'recharts';
import { Panel, Stat, Bar as ProgressBar } from '@/components/ui-bits';
import { LoadingState, ErrorState } from '@/components/data-state';
import { useFinancials } from '@/hooks/use-stock-data';
import { formatCompact, formatPrice } from '@/lib/format';
import { financialDisplayEvidence } from '@/lib/financial-display-evidence';
import { HEALTH_KO, healthTone, toneBadge, toneText } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { ApiError, type Currency, type FinancialRow, type Financials } from '@/lib/api';

// Recharts 2.x publishes class component declarations that TypeScript 5.9 can
// reject under the React 18 JSX constructor check even though runtime support
// is valid. Keep the runtime components and narrow only the JSX declaration.
const ChartXAxis = XAxis as any;
const ChartYAxis = YAxis as any;
const ChartReferenceLine = ReferenceLine as any;
const ChartBar = Bar as any;

const METRICS: { key: keyof FinancialRow; label: string; signed?: boolean }[] = [
  { key: 'revenue', label: '매출' },
  { key: 'operatingIncome', label: '영업이익', signed: true },
  { key: 'netIncome', label: '순이익', signed: true },
  { key: 'cash', label: '현금' },
  { key: 'debt', label: '부채' },
];

type RatioKey = 'per' | 'pbr' | 'roe' | 'debtRatio';

type Ratios = Financials['ratios'];

// A measured zero is still evidence; absent/non-finite ratios remain unknown.
function hasValue(v: number): boolean {
  return Number.isFinite(v);
}

function formatRatio(key: RatioKey, ratios: Ratios): string {
  const v = ratios[key];
  if (!Number.isFinite(v)) return '데이터 부족';

  if (key === 'per' || key === 'pbr') return `${v}배`;
  return `${v}%`;
}

function ratioTone(key: RatioKey, ratios: Ratios): 'positive' | 'warning' | 'destructive' | undefined {
  const v = ratios[key];
  if (!Number.isFinite(v)) return undefined;

  if (key === 'roe') return v > 0 ? 'positive' : v < 0 ? 'destructive' : undefined;
  if (key === 'debtRatio') return hasValue(v) && v > 120 ? 'warning' : undefined;
  return undefined;
}

// Short inline interpretation label shown next to the metric value.
// Returns '데이터 부족' when the value is missing / non-finite so we never
// fabricate a reading (live-data rule).
function ratioInterpretation(key: RatioKey, ratios: Ratios): string {
  const v = ratios[key];

  if (key === 'per') {
    if (!Number.isFinite(v)) return '데이터 부족';
    if (v <= 0) return '해석 제한';
    if (v < 10) return '낮은 편';
    if (v < 25) return '보통';
    if (v < 40) return '높은 편';
    return '매우 높은 편';
  }

  if (key === 'pbr') {
    if (!Number.isFinite(v)) return '데이터 부족';
    if (v <= 0) return '해석 제한';
    if (v < 1) return '낮은 편';
    if (v < 3) return '보통';
    if (v < 7) return '높은 편';
    return '매우 높은 편';
  }

  if (key === 'roe') {
    if (!Number.isFinite(v)) return '데이터 부족';
    if (v < 0) return '적자/부진';
    if (v < 5) return '낮음';
    if (v < 15) return '보통';
    return '우수';
  }

  // debtRatio
  if (!Number.isFinite(v)) return '데이터 부족';
  if (v < 100) return '안정적';
  if (v < 200) return '보통';
  return '높음';
}

// Plain-language reading of this stock's specific value.
function ratioReading(key: RatioKey, ratios: Ratios): string {
  const v = ratios[key];

  if (key === 'per') {
    if (!Number.isFinite(v)) return '이 종목의 PER 데이터가 부족합니다.';
    if (v === 0) return '제공된 PER은 0배입니다. 이 값만으로 저평가나 적자를 판정할 수 없습니다.';
    if (v < 0) return '순이익이 적자라 PER로는 밸류에이션을 판단하기 어렵습니다.';
    if (v < 10) return `이 종목의 PER은 ${v}배로, 이익 대비 주가가 낮은 편입니다.`;
    if (v < 25) return `이 종목의 PER은 ${v}배입니다. 고정 분류 기준의 중간 구간이며 실제 시장·업종 평균과 비교한 값은 아닙니다.`;
    return `이 종목의 PER은 ${v}배로, 이익 대비 주가가 높은 편이라 성장 기대가 반영된 상태입니다.`;
  }

  if (key === 'pbr') {
    if (!Number.isFinite(v)) return '이 종목의 PBR 데이터가 부족합니다.';
    if (v <= 0) return `제공된 PBR은 ${v}배입니다. 이 값만으로 자산가치 대비 저평가를 판정할 수 없습니다.`;
    if (v < 1) return `이 종목의 PBR은 ${v}배로, 자산가치보다 주가가 낮게 평가되어 있습니다.`;
    if (v < 3) return `이 종목의 PBR은 ${v}배로, 무난한 수준입니다.`;
    return `이 종목의 PBR은 ${v}배로, 자산가치 대비 주가가 높은 편입니다.`;
  }

  if (key === 'roe') {
    if (!Number.isFinite(v)) return '이 종목의 ROE 데이터가 부족합니다.';
    if (v < 0) return `이 종목의 ROE는 ${v}%로, 자기자본에서 손실이 발생하고 있습니다.`;
    if (v < 8) return `이 종목의 ROE는 ${v}%로, 수익성이 다소 낮은 편입니다.`;
    if (v < 15) return `이 종목의 ROE는 ${v}%로, 양호한 수익성입니다.`;
    return `이 종목의 ROE는 ${v}%로, 자기자본을 효율적으로 굴리는 우수한 수익성입니다.`;
  }

  // debtRatio
  if (!Number.isFinite(v)) return '이 종목의 부채비율 데이터가 부족합니다.';
  if (v < 100) return `이 종목의 부채비율은 ${v}%로, 재무 안정성이 양호합니다.`;
  if (v < 200) return `이 종목의 부채비율은 ${v}%로, 보통 수준입니다.`;
  return `이 종목의 부채비율은 ${v}%로 높은 편이라, 재무 부담을 확인할 필요가 있습니다.`;
}

const RATIO_INFO: Record<RatioKey, { title: string; what: string }> = {
  per: {
    title: 'PER (주가수익비율)',
    what: '주가를 주당순이익(EPS)으로 나눈 값입니다. 이익 1원당 주가가 몇 배로 거래되는지를 나타내며, 낮을수록 이익 대비 저평가, 높을수록 성장 기대가 반영된 것으로 봅니다.',
  },
  pbr: {
    title: 'PBR (주가순자산비율)',
    what: '주가를 주당순자산으로 나눈 값입니다. 회사의 장부상 순자산 대비 주가 수준을 나타내며, 1배 미만이면 자산가치보다 낮게 거래되는 상태입니다.',
  },
  roe: {
    title: 'ROE (자기자본이익률)',
    what: '순이익을 자기자본으로 나눈 값입니다. 주주가 투자한 자본으로 얼마나 이익을 냈는지를 보여주며, 높을수록 자본을 효율적으로 활용하는 회사입니다.',
  },
  debtRatio: {
    title: '부채비율',
    what: '부채총계를 자기자본으로 나눈 값입니다. 회사가 빚에 얼마나 의존하는지를 나타내며, 낮을수록 재무가 안정적이고 높을수록 부담이 큽니다.',
  },
};

const RATIO_ORDER: { key: RatioKey; label: string }[] = [
  { key: 'per', label: 'PER' },
  { key: 'pbr', label: 'PBR' },
  { key: 'roe', label: 'ROE' },
  { key: 'debtRatio', label: '부채비율' },
];

function RatioModal({
  metric,
  ratios,
  onClose,
}: {
  metric: RatioKey;
  ratios: Ratios;
  onClose: () => void;
}) {
  const info = RATIO_INFO[metric];
  const value = formatRatio(metric, ratios);
  const reading = ratioReading(metric, ratios);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-card-border bg-card p-4 sm:rounded-2xl">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <h3 className="break-keep text-base font-bold leading-relaxed">{info.title}</h3>
            <div className="mt-0.5 font-mono text-sm text-primary">{value}</div>
          </div>
          <button onClick={onClose} aria-label="닫기" className="rounded-lg p-1 hover:bg-secondary">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <div className="mb-1 text-xs font-semibold text-muted-foreground">무엇인가요?</div>
            <p className="break-keep text-sm leading-relaxed">{info.what}</p>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold text-muted-foreground">이 종목은?</div>
            <p className="break-keep rounded-lg border border-border bg-secondary/40 p-2.5 text-sm leading-relaxed">
              {reading}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function RatioCard({
  label,
  metric,
  ratios,
  onOpen,
}: {
  label: string;
  metric: RatioKey;
  ratios: Ratios;
  onOpen: (metric: RatioKey) => void;
}) {
  const value = formatRatio(metric, ratios);
  const tone = ratioTone(metric, ratios);
  const interpretation = ratioInterpretation(metric, ratios);

  return (
    <button
      type="button"
      onClick={() => onOpen(metric)}
      className="flex flex-col items-start gap-1 rounded-2xl border border-card-border bg-secondary/40 p-3 text-left transition-colors hover:bg-secondary/70"
    >
      <span className="flex w-full items-center justify-between text-xs text-muted-foreground">
        {label}
        <span className="flex h-4 w-4 items-center justify-center rounded-full border border-muted-foreground/50 text-[10px] font-bold text-muted-foreground">
          ?
        </span>
      </span>
      <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span
          className={cn(
            'break-keep font-mono text-lg font-semibold leading-relaxed tabular-nums',
            tone && toneText(tone),
          )}
        >
          {value}
        </span>
        <span className="break-keep text-[11px] font-medium leading-relaxed text-muted-foreground">
          ({interpretation})
        </span>
      </span>
      <span className="text-[11px] text-primary">설명 보기</span>
    </button>
  );
}

function FinCards({ rows, currency }: { rows: FinancialRow[]; currency: Currency }) {
  if (rows.length === 0) {
    return <p className="break-keep text-sm leading-relaxed text-muted-foreground">데이터 부족</p>;
  }

  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.period} className="rounded-2xl border border-card-border bg-secondary/40 p-3">
          <div className="mb-2 text-xs font-bold text-muted-foreground">{r.period}</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {METRICS.map((m) => {
              const v = r[m.key] as number | undefined;
              const has = typeof v === 'number' && Number.isFinite(v);
              const neg = m.signed && has && (v as number) < 0;
              return (
                <div key={m.key} className="flex flex-col gap-0.5">
                  <span className="text-[11px] text-muted-foreground">{m.label}</span>
                  <span
                    className={cn(
                      'break-keep font-mono text-sm font-medium leading-relaxed tabular-nums',
                      neg && 'text-destructive',
                    )}
                  >
                    {has ? formatCompact(v as number, currency) : '데이터 부족'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function GrowthChart({ labels, values }: { labels: string[]; values: number[] }) {
  if (!values.length) return <p className="text-sm text-muted-foreground">성장률 근거 부족</p>;
  const data = values.map((v, i) => ({ name: labels[i] ?? '', value: v }));
  return (
    <ResponsiveContainer width="100%" height={140}>
      <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -20 }}>
        <ChartXAxis dataKey="name" tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 10 }} axisLine={false} tickLine={false} />
        <ChartYAxis tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }} axisLine={false} tickLine={false} unit="%" width={44} />
        <ChartReferenceLine y={0} stroke="rgba(255,255,255,0.2)" />
        <ChartBar dataKey="value" radius={[3, 3, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.value >= 0 ? '#22c55e' : '#ef4444'} />
          ))}
        </ChartBar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function FinancialTab({ ticker, currency, active }: { ticker: string; currency: Currency; active: boolean }) {
  const { data, isLoading, isError, error, refetch } = useFinancials(ticker, active);
  const [openMetric, setOpenMetric] = useState<RatioKey | null>(null);

  if (isLoading) return <LoadingState />;
  if (isError || !data || !Array.isArray(data.annual) || !Array.isArray(data.quarterly) || !data.ratios || ('available' in data && data.available === false) || ('ok' in data && data.ok === false))
    return <ErrorState code={error instanceof ApiError ? error.code : undefined} onRetry={() => refetch()} />;

  const growthLabels = data.annual.slice(1).map((a) => a.period);
  const revenueGrowth = Array.isArray(data.growth?.revenue) ? data.growth.revenue : [];
  const profitGrowth = Array.isArray(data.growth?.profit) ? data.growth.profit : [];
  const evidence = financialDisplayEvidence(data);
  if (evidence.sample) return <p className="text-sm text-destructive">샘플 재무제표는 투자 판단 근거로 표시하지 않습니다.</p>;

  // The current statement route and the service use opposite array orders.
  // Sort explicit period labels without mutating either provider response.
  const annualRows = [...data.annual].sort((a, b) => String(b.period).localeCompare(String(a.period)));
  const quarterlyRows = [...data.quarterly].sort((a, b) => String(b.period).localeCompare(String(a.period)));

  return (
    <div className="space-y-3">
      <Panel title="핵심 투자지표">
        <div className="grid grid-cols-2 gap-2">
          {RATIO_ORDER.map((r) => (
            <RatioCard
              key={r.key}
              label={r.label}
              metric={r.key}
              ratios={data.ratios}
              onOpen={setOpenMetric}
            />
          ))}
        </div>
        <p className="mt-2 break-keep text-[11px] leading-relaxed text-muted-foreground">
          각 지표를 눌러 뜻과 이 종목의 해석을 확인하세요.
          {Number.isFinite(data.ratios.eps) && (
            <> EPS는 {formatPrice(data.ratios.eps, currency)}입니다.</>
          )}
        </p>
      </Panel>

      <Panel title="분기 실적 (최근 4분기)">
        <FinCards rows={quarterlyRows} currency={currency} />
      </Panel>

      <Panel title="연간 실적 (최근 5년)">
        <FinCards rows={annualRows} currency={currency} />
      </Panel>

      <Panel title="매출 성장률 (YoY)">
        <GrowthChart labels={growthLabels} values={revenueGrowth} />
      </Panel>
      <Panel title="이익 성장률 (YoY)">
        <GrowthChart labels={growthLabels} values={profitGrowth} />
      </Panel>

      <Panel title="현금 소진 분석">
        <div className="grid grid-cols-3 gap-4">
          <Stat label="보유 현금" value={formatCompact(evidence.cashBalance, currency)} />
          <Stat
            label="분기 현금흐름"
            value="근거 부족"
          />
          <Stat
            label="예상 존속"
            value="산정 불가"
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">검증된 현금흐름표가 없습니다. 순이익을 현금흐름으로 대체하거나 현금 소진 기간을 추정하지 않습니다.</p>
      </Panel>

      <Panel title="재무 건전성" right={evidence.healthLevel ? <span className={cn('rounded-full border px-2.5 py-1 text-xs font-semibold', toneBadge(healthTone(evidence.healthLevel)))}>{HEALTH_KO[evidence.healthLevel]}</span> : undefined}>
        {evidence.healthScore !== null && evidence.healthLevel ? <>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <ProgressBar value={evidence.healthScore} tone={healthTone(evidence.healthLevel)} />
          </div>
          <span className="text-xs font-medium">규칙 점수 {evidence.healthScore}/100</span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">ROE·부채비율·PER의 고정 규칙 평가입니다. 성공확률이나 검증된 신뢰도가 아닙니다.</p>
        </> : <p className="text-sm text-muted-foreground">재무 평가 근거 부족</p>}
      </Panel>

      {openMetric && (
        <RatioModal metric={openMetric} ratios={data.ratios} onClose={() => setOpenMetric(null)} />
      )}
    </div>
  );
}
