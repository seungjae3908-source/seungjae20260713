import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  Gauge,
  ShieldAlert,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import {
  buildStockAnalysis,
  type AnalysisEvent,
  type AnalysisMarket,
  type AnalysisMark,
  type DimensionResult,
  type StockAnalysisSnapshot,
  type TrendDirection,
} from '@/lib/stock-analysis-engine';
import { cn } from '@/lib/utils';

type AnyRecord = Record<string, unknown>;

type StockAnalysisHubProps = {
  ticker: string;
  name: string;
  market: AnalysisMarket;
  currency: string;
  quote?: unknown;
  profile?: unknown;
  financials?: unknown;
  news?: unknown[];
  disclosures?: unknown[];
  specialEvents?: unknown[];
  loading?: boolean;
};

type StoredAnalysis = {
  id: string;
  generatedAt: string;
  ticker: string;
  market: AnalysisMarket;
  overallScore: number;
  verdict: string;
  shortTermOutlook: string;
  riskScore: number;
  riskLevel: StockAnalysisSnapshot['riskLevel'];
  eventIds: string[];
  eventTitles: string[];
};

type RevisionView = {
  changes: string[];
  newEventTitles: string[];
};

const HISTORY_PREFIX = 'sa-stock-analysis-history-v1';

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as AnyRecord) : null;
}

function asRecords(value: unknown[] | undefined): AnyRecord[] {
  return (value ?? []).map(asRecord).filter((row): row is AnyRecord => Boolean(row));
}

function historyKey(market: AnalysisMarket, ticker: string) {
  return `${HISTORY_PREFIX}:${market}:${ticker.toUpperCase()}`;
}

function compactSnapshot(snapshot: StockAnalysisSnapshot): StoredAnalysis {
  return {
    id: snapshot.id,
    generatedAt: snapshot.generatedAt,
    ticker: snapshot.ticker,
    market: snapshot.market,
    overallScore: snapshot.overallScore,
    verdict: snapshot.verdict,
    shortTermOutlook: snapshot.shortTermOutlook,
    riskScore: snapshot.riskScore,
    riskLevel: snapshot.riskLevel,
    eventIds: snapshot.events.map((event) => event.id),
    eventTitles: snapshot.events.map((event) => event.title),
  };
}

function snapshotSignature(snapshot: StoredAnalysis) {
  return [
    snapshot.overallScore,
    snapshot.verdict,
    snapshot.shortTermOutlook,
    snapshot.riskScore,
    snapshot.riskLevel,
    snapshot.eventIds.join(','),
  ].join('|');
}

function compareStored(previous: StoredAnalysis | null, current: StoredAnalysis): RevisionView | null {
  if (!previous) return null;
  const changes: string[] = [];
  const scoreDelta = current.overallScore - previous.overallScore;
  const riskDelta = current.riskScore - previous.riskScore;
  if (Math.abs(scoreDelta) >= 1) changes.push(`종합점수 ${scoreDelta > 0 ? '+' : ''}${scoreDelta}점`);
  if (previous.verdict !== current.verdict) changes.push(`종합판단 ${previous.verdict} → ${current.verdict}`);
  if (previous.shortTermOutlook !== current.shortTermOutlook) changes.push(`단기전망 ${previous.shortTermOutlook} → ${current.shortTermOutlook}`);
  if (Math.abs(riskDelta) >= 1) changes.push(`위험도 ${riskDelta > 0 ? '+' : ''}${riskDelta}점`);
  const previousIds = new Set(previous.eventIds);
  const newEventTitles = current.eventTitles.filter((_, index) => !previousIds.has(current.eventIds[index]));
  if (changes.length === 0 && newEventTitles.length === 0) return null;
  return { changes, newEventTitles };
}

function readHistory(key: string): StoredAnalysis[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((row): row is StoredAnalysis => Boolean(row && typeof row === 'object')) : [];
  } catch {
    return [];
  }
}

function writeHistory(key: string, history: StoredAnalysis[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(history.slice(0, 12)));
  } catch {
    // 분석 화면은 저장 공간 오류가 있어도 현재 계산 결과를 계속 표시합니다.
  }
}

function formatDate(value: string | null | undefined) {
  const date = new Date(String(value ?? ''));
  return Number.isFinite(date.getTime()) ? date.toLocaleString('ko-KR') : '기준시각 없음';
}

function formatPercent(value: number | null) {
  if (value == null) return '자료 부족';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function formatPrice(value: number | null, currency: string) {
  if (value == null) return '자료 부족';
  const safeCurrency = currency === 'USDT' ? 'USD' : currency;
  try {
    return new Intl.NumberFormat(safeCurrency === 'KRW' ? 'ko-KR' : 'en-US', {
      style: 'currency',
      currency: safeCurrency || 'USD',
      maximumFractionDigits: safeCurrency === 'KRW' ? 0 : 2,
    }).format(value);
  } catch {
    return value.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
  }
}

function scoreTone(score: number) {
  if (score >= 70) return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (score >= 50) return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  return 'border-destructive/30 bg-destructive/10 text-destructive';
}

function riskTone(level: StockAnalysisSnapshot['riskLevel']) {
  if (level === '낮음') return 'text-emerald-600 dark:text-emerald-300';
  if (level === '보통') return 'text-amber-600 dark:text-amber-300';
  return 'text-destructive';
}

function outlookIcon(outlook: string) {
  if (outlook.includes('상승')) return <TrendingUp className="h-4 w-4" />;
  if (outlook.includes('하락')) return <TrendingDown className="h-4 w-4" />;
  return <Activity className="h-4 w-4" />;
}

function trendIcon(direction: TrendDirection) {
  if (direction === 'up') return <ArrowUpRight className="h-4 w-4 text-emerald-600" />;
  if (direction === 'down') return <ArrowDownRight className="h-4 w-4 text-destructive" />;
  return <Activity className="h-4 w-4 text-muted-foreground" />;
}

function impactEntries(event: AnalysisEvent) {
  const labels: Record<string, string> = {
    technology: '기술력',
    business: '사업성',
    growth: '성장성',
    financial: '재무',
    momentum: '주가',
    catalyst: '촉매',
    risk: '위험도',
  };
  return Object.entries(event.impacts)
    .filter(([, value]) => Number(value) !== 0)
    .map(([key, value]) => ({ key, label: labels[key] ?? key, value: Number(value) }));
}

function statusLabel(event: AnalysisEvent) {
  if (event.status === 'confirmed') return '공식 확인';
  if (event.status === 'likely') return '가능성 높음';
  if (event.status === 'refuted') return '반박됨';
  return '미확인';
}

function markTone(value: AnalysisMark | '자료 필요') {
  if (value === '◎') return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (value === '○') return 'bg-primary/10 text-primary';
  if (value === '△') return 'bg-amber-500/10 text-amber-700 dark:text-amber-300';
  return 'bg-secondary text-muted-foreground';
}

export function StockAnalysisHub({
  ticker,
  name,
  market,
  currency,
  quote,
  profile,
  financials,
  news,
  disclosures,
  specialEvents,
  loading = false,
}: StockAnalysisHubProps) {
  const analysis = useMemo(
    () => buildStockAnalysis({
      ticker,
      name,
      market,
      currency,
      quote: asRecord(quote),
      profile: asRecord(profile),
      financials: asRecord(financials),
      news: asRecords(news),
      disclosures: asRecords(disclosures),
      specialEvents: asRecords(specialEvents),
    }),
    [currency, disclosures, financials, market, name, news, profile, quote, specialEvents, ticker],
  );
  const [history, setHistory] = useState<StoredAnalysis[]>([]);
  const [revision, setRevision] = useState<RevisionView | null>(null);

  useEffect(() => {
    if (loading || !quote || !profile || !financials) return;
    const key = historyKey(market, ticker);
    const previousHistory = readHistory(key);
    const current = compactSnapshot(analysis);
    const previous = previousHistory[0] ?? null;
    const comparison = compareStored(previous, current);
    const nextHistory = previous && snapshotSignature(previous) === snapshotSignature(current)
      ? previousHistory
      : [current, ...previousHistory].slice(0, 12);
    if (nextHistory !== previousHistory) writeHistory(key, nextHistory);
    setHistory(nextHistory);
    setRevision(comparison);
  }, [analysis, financials, loading, market, profile, quote, ticker]);

  return (
    <section data-testid="stock-analysis-hub" className="space-y-3">
      <div className="overflow-hidden rounded-3xl border border-primary/25 bg-gradient-to-br from-primary/10 via-card to-card shadow-sm">
        <div className="border-b border-card-border/70 p-4">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-black">AI 종합평가</h2>
            <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-1 text-[10px] font-black text-primary">자체엔진</span>
            <span className="rounded-full border border-card-border bg-background/70 px-2 py-1 text-[10px] font-bold text-muted-foreground">투자 권유 아님</span>
          </div>
          <p className="mt-1 text-center text-[11px] font-bold text-muted-foreground">{analysis.sectorLabel} 업종별 기준 · {formatDate(analysis.generatedAt)}</p>
        </div>

        <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4">
          <SummaryMetric label="종합점수" value={`${analysis.overallScore}점`} sub={analysis.verdict} className={scoreTone(analysis.overallScore)} />
          <SummaryMetric label="단기 전망" value={analysis.shortTermOutlook} icon={outlookIcon(analysis.shortTermOutlook)} />
          <SummaryMetric label="위험도" value={analysis.riskLevel} sub={`${analysis.riskScore}점`} valueClassName={riskTone(analysis.riskLevel)} />
          <SummaryMetric label="분석 신뢰도" value={`${analysis.confidence}%`} sub={`${Math.max(1, Math.round(analysis.confidence / 20))}/5`} />
        </div>

        <div className="mx-4 mb-4 rounded-2xl border border-card-border bg-background/80 p-4 text-center">
          <p className="text-[10px] font-black uppercase tracking-wider text-muted-foreground">핵심 한줄</p>
          <p className="mt-2 break-keep text-sm font-black leading-6">“{analysis.oneLine}”</p>
          {loading && <p className="mt-2 text-[10px] font-bold text-primary">일부 데이터를 수집 중이며 점수는 자동 갱신됩니다.</p>}
        </div>
      </div>

      <AnalysisSection title="AI 종합 분석" summary="기술력·사업성·성장성·재무·주가·이벤트" defaultOpen>
        <div className="space-y-3">
          <div className="space-y-2">
            {analysis.dimensions.map((dimension) => <DimensionBar key={dimension.key} dimension={dimension} />)}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <PointList title="강점" tone="positive" items={analysis.strengths} />
            <PointList title="약점" tone="negative" items={analysis.weaknesses} />
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MiniMetric label="사업 단계" value={analysis.businessStage} />
            <MiniMetric label="매출 상태" value={analysis.revenueStatus} />
            <MiniMetric label="성장 가능성" value={analysis.growthPotential} />
            <MiniMetric label="검증 필요" value={analysis.validationNeeded[0] ?? '추가 자료'} />
          </div>
        </div>
      </AnalysisSection>

      <AnalysisSection title="경쟁력 비교" summary={`${analysis.peerNames.join(' · ')} 비교 준비`}>
        <div className="space-y-3">
          <p className="rounded-2xl bg-secondary/60 p-3 text-xs font-bold leading-5 text-muted-foreground">
            선택 종목은 현재 수집된 자료로 평가하고, 경쟁사는 정량자료가 없을 때 임의 점수를 만들지 않고 ‘자료 필요’로 표시합니다.
          </p>
          <div className="overflow-x-auto rounded-2xl border border-card-border">
            <table className="min-w-full text-xs">
              <thead className="bg-secondary/70">
                <tr>
                  <th className="px-3 py-3 text-left font-black">비교 기준</th>
                  <th className="px-3 py-3 text-center font-black">{name}</th>
                  {analysis.peerNames.map((peer) => <th key={peer} className="px-3 py-3 text-center font-black">{peer}</th>)}
                </tr>
              </thead>
              <tbody>
                {analysis.peerComparison.map((row) => (
                  <tr key={row.metric} className="border-t border-card-border">
                    <td className="whitespace-nowrap px-3 py-3 font-black">{row.metric}</td>
                    <td className="px-3 py-3 text-center"><Mark value={row.company} /></td>
                    {row.peers.map((peer) => <td key={`${row.metric}:${peer.name}`} className="px-3 py-3 text-center"><Mark value={peer.value} /></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </AnalysisSection>

      <AnalysisSection title="이벤트 분석" summary={`분류 이벤트 ${analysis.events.length}건 · 분석 변경 자동 추적`} defaultOpen>
        <div className="space-y-3">
          {revision ? (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3">
              <div className="flex items-center gap-2 text-sm font-black text-amber-800 dark:text-amber-200"><Clock3 className="h-4 w-4" /> 기존 전망 변경</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {revision.changes.map((change) => <span key={change} className="rounded-full bg-background/80 px-2 py-1 text-[10px] font-black">{change}</span>)}
                {revision.newEventTitles.map((title) => <span key={title} className="rounded-full bg-background/80 px-2 py-1 text-[10px] font-black">새 이벤트: {title}</span>)}
              </div>
            </div>
          ) : (
            <p className="rounded-2xl bg-secondary/60 p-3 text-xs font-bold text-muted-foreground">저장된 이전 분석과 비교할 유의미한 변경이 없습니다. 데이터가 바뀌면 점수·전망·위험도 변경 이유가 여기에 표시됩니다.</p>
          )}

          {analysis.events.length === 0 ? (
            <EmptyState text="현재 자료에서 분류 가능한 실적·계약·개발·증자·규제 이벤트를 찾지 못했습니다." />
          ) : (
            <div className="space-y-2">
              {analysis.events.slice(0, 8).map((event) => <EventCard key={event.id} event={event} />)}
            </div>
          )}

          {history.length > 1 && (
            <details className="rounded-2xl border border-card-border bg-background p-3">
              <summary className="cursor-pointer text-xs font-black">분석 이력 보기 ({history.length}개)</summary>
              <div className="mt-3 space-y-2">
                {history.slice(0, 8).map((item) => (
                  <div key={`${item.id}:${item.generatedAt}`} className="flex items-center justify-between gap-3 rounded-xl bg-secondary/60 px-3 py-2 text-xs">
                    <span className="font-bold text-muted-foreground">{formatDate(item.generatedAt)}</span>
                    <span className="font-black">{item.overallScore}점 · {item.verdict} · 위험 {item.riskLevel}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </AnalysisSection>

      <AnalysisSection title="재무 해석" summary={analysis.financial.summary}>
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <TrendMetric label="매출" value={analysis.financial.revenueText} direction={analysis.financial.revenueTrend} />
            <TrendMetric label="영업이익" value={analysis.financial.operatingIncomeText} direction={analysis.financial.operatingIncomeTrend} />
            <TrendMetric label="현금" value={analysis.financial.cashText} direction={analysis.financial.cashStatus === '양호' ? 'up' : analysis.financial.cashStatus === '주의' ? 'down' : 'flat'} />
          </div>
          <p className="rounded-2xl border border-card-border bg-secondary/40 p-3 text-xs font-bold leading-5">판단: {analysis.financial.summary}</p>
        </div>
      </AnalysisSection>

      <AnalysisSection title="주가와 연결" summary="현재 가격 위치·최근 상승/하락 이유·기대 선반영 확인">
        <div className="grid gap-2 sm:grid-cols-2">
          <MiniMetric label="현재가" value={formatPrice(analysis.priceContext.price, currency)} />
          <MiniMetric label="52주 고점 대비" value={formatPercent(analysis.priceContext.drawdownFromHigh)} />
          <MiniMetric label="52주 가격범위 위치" value={formatPercent(analysis.priceContext.positionInRange)} />
          <MiniMetric label="최근 영향 이벤트" value={analysis.priceContext.recentReason} />
        </div>
        <p className="mt-3 rounded-2xl border border-card-border bg-background p-3 text-xs font-bold leading-5">현재 위험: {analysis.priceContext.pricedIn}</p>
      </AnalysisSection>

      <AnalysisSection title="투자자가 궁금한 조건" summary="상승 가능 요인·하락 위험·기계적 관찰 가격">
        <div className="grid gap-3 md:grid-cols-2">
          <PointList title="왜 오를 수 있나?" tone="positive" items={analysis.upsideFactors} />
          <PointList title="왜 떨어질 수 있나?" tone="negative" items={analysis.downsideFactors} />
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <MiniMetric label="추격매수" value={analysis.timing.chase} />
          <MiniMetric label="기계적 관찰 가격" value={analysis.timing.observationLow == null || analysis.timing.observationHigh == null ? '자료 부족' : `${formatPrice(analysis.timing.observationLow, currency)} ~ ${formatPrice(analysis.timing.observationHigh, currency)}`} />
          <MiniMetric label="확인 가격" value={formatPrice(analysis.timing.confirmationPrice, currency)} />
        </div>
        <p className="mt-3 rounded-2xl border border-primary/20 bg-primary/5 p-3 text-xs font-bold leading-5">확인 조건: {analysis.timing.confirmationText}</p>
      </AnalysisSection>

      <AnalysisSection title="분석 신뢰도" summary={`${analysis.confidence}% · 근거와 부족 데이터를 함께 공개`}>
        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-2xl border border-card-border bg-background p-3">
            <Gauge className="h-7 w-7 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2 text-xs font-black"><span>신뢰도</span><span>{analysis.confidence}%</span></div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary" style={{ width: `${analysis.confidence}%` }} /></div>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <PointList title="근거" tone="neutral" items={analysis.dataSources.length ? analysis.dataSources : ['시세·재무 제공기관 표시 필요']} />
            <PointList title="부족" tone="warning" items={analysis.missingData.length ? analysis.missingData : ['중요 누락 데이터 없음']} />
          </div>
          <p className="rounded-2xl bg-secondary/60 p-3 text-[11px] font-bold leading-5 text-muted-foreground">
            자체엔진은 공식 공시를 가장 높게 평가하고, 일반 뉴스·미확인 이벤트는 영향도를 낮춰 반영합니다. 경쟁사 자료나 핵심 업종 지표가 없으면 점수를 만들어내지 않고 신뢰도를 낮춥니다.
          </p>
        </div>
      </AnalysisSection>
    </section>
  );
}

function SummaryMetric({ label, value, sub, icon, className, valueClassName }: { label: string; value: string; sub?: string; icon?: ReactNode; className?: string; valueClassName?: string }) {
  return (
    <div className={cn('rounded-2xl border border-card-border bg-background/80 p-3 text-center', className)}>
      <p className="text-[10px] font-black text-muted-foreground">{label}</p>
      <div className={cn('mt-1 flex min-h-8 items-center justify-center gap-1 text-base font-black', valueClassName)}>{icon}{value}</div>
      {sub && <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">{sub}</p>}
    </div>
  );
}

function AnalysisSection({ title, summary, defaultOpen = false, children }: { title: string; summary: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="group rounded-3xl border border-card-border bg-card shadow-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1 text-center">
          <span className="block text-sm font-black">{title}</span>
          <span className="mt-1 block truncate text-[10px] font-bold text-muted-foreground">{summary}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-card-border px-4 pb-4 pt-3">{children}</div>
    </details>
  );
}

function DimensionBar({ dimension }: { dimension: DimensionResult }) {
  return (
    <div className="rounded-2xl border border-card-border bg-background p-3">
      <div className="flex items-center justify-between gap-3 text-xs"><span className="font-black">{dimension.label}</span><span className="font-black">{dimension.score}점</span></div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary"><div className={cn('h-full rounded-full', dimension.score >= 65 ? 'bg-emerald-500' : dimension.score >= 45 ? 'bg-amber-500' : 'bg-destructive')} style={{ width: `${dimension.score}%` }} /></div>
      <p className="mt-2 break-keep text-[10px] font-bold leading-4 text-muted-foreground">{dimension.reasons.join(' · ')}</p>
    </div>
  );
}

function PointList({ title, items, tone }: { title: string; items: string[]; tone: 'positive' | 'negative' | 'neutral' | 'warning' }) {
  const Icon = tone === 'positive' ? CheckCircle2 : tone === 'negative' ? ShieldAlert : tone === 'warning' ? AlertTriangle : CircleHelp;
  const iconClass = tone === 'positive' ? 'text-emerald-600' : tone === 'negative' ? 'text-destructive' : tone === 'warning' ? 'text-amber-600' : 'text-primary';
  return (
    <div className="rounded-2xl border border-card-border bg-background p-3">
      <div className="mb-2 flex items-center justify-center gap-2 text-xs font-black"><Icon className={cn('h-4 w-4', iconClass)} />{title}</div>
      <ol className="space-y-2">
        {items.map((item, index) => <li key={`${title}:${item}`} className="flex items-start gap-2 text-xs font-bold leading-5"><span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary text-[9px] font-black">{index + 1}</span><span className="min-w-0 break-words">{item}</span></li>)}
      </ol>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl border border-card-border bg-background p-3 text-center"><p className="text-[10px] font-black text-muted-foreground">{label}</p><p className="mt-1 break-keep text-xs font-black leading-5">{value}</p></div>;
}

function TrendMetric({ label, value, direction }: { label: string; value: string; direction: TrendDirection }) {
  return <div className="rounded-2xl border border-card-border bg-background p-3"><p className="text-[10px] font-black text-muted-foreground">{label}</p><div className="mt-1 flex items-center gap-1.5 text-xs font-black">{trendIcon(direction)}{value}</div></div>;
}

function Mark({ value }: { value: AnalysisMark | '자료 필요' }) {
  return <span className={cn('inline-flex min-w-8 items-center justify-center rounded-full px-2 py-1 text-[10px] font-black', markTone(value))}>{value}</span>;
}

function EventCard({ event }: { event: AnalysisEvent }) {
  const risky = Number(event.impacts.risk ?? 0) > 0;
  return (
    <article className={cn('rounded-2xl border p-3', risky ? 'border-destructive/25 bg-destructive/5' : 'border-emerald-500/25 bg-emerald-500/5')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1"><p className="break-words text-xs font-black leading-5">{event.title}</p><p className="mt-1 text-[10px] font-bold text-muted-foreground">{formatDate(event.occurredAt)} · {statusLabel(event)} · 근거 {event.evidenceIds.length}건</p></div>
        {risky ? <TrendingDown className="h-4 w-4 shrink-0 text-destructive" /> : <TrendingUp className="h-4 w-4 shrink-0 text-emerald-600" />}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {impactEntries(event).map((impact) => <span key={`${event.id}:${impact.key}`} className={cn('rounded-full px-2 py-1 text-[9px] font-black', impact.key === 'risk' ? impact.value > 0 ? 'bg-destructive/10 text-destructive' : 'bg-emerald-500/10 text-emerald-700' : impact.value >= 0 ? 'bg-emerald-500/10 text-emerald-700' : 'bg-destructive/10 text-destructive')}>{impact.label} {impact.value > 0 ? '+' : ''}{impact.value}</span>)}
      </div>
      <p className="mt-2 break-keep text-[10px] font-bold leading-4 text-muted-foreground">{event.explanation}</p>
    </article>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-2xl border border-dashed border-card-border bg-background p-4 text-center text-xs font-bold text-muted-foreground"><BarChart3 className="mx-auto mb-2 h-5 w-5" />{text}</div>;
}
