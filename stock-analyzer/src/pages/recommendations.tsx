// AI 추천 화면 — 규칙 기반 엔진(LLM 미연결)이 실데이터로 선별한 후보를 보여준다.
import { useState } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw, ShieldAlert, TrendingUp } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { cn } from '@/lib/utils';
import { BottomNav } from '@/components/bottom-nav';
import {
  displayStockName,
  formatAppPercent,
  formatAppPrice,
} from '@/lib/stock-display';

type Category = 'undervalued' | 'breakout';

interface RecoRow {
  ticker: string;
  name: string;
  market: 'KR' | 'US';
  currency: 'KRW' | 'USD';
  category: Category;
  categoryLabel: string;
  price: number;
  changePercent: number | null;
  reasons: string[];
  usedData: string[];
  missingData: string[];
  risks: string[];
  overheated: boolean;
  financialStability: string;
  newsRisk: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  shortTermOutlook: string;
  midTermOutlook: string;
  opinion: string;
  targetPrice: number | null;
  targetBasis: string;
  stopLoss: number | null;
  stopBasis: string;
  score: number;
  generatedAt: string;
  dataUpdatedAt: string;
  providers: string[];
  dataQuality: string;
  previousGeneratedAt?: string;
  changeSincePrevious?: number;
}

interface RecoResponse {
  ok: boolean;
  provider: string;
  analysisMode: string;
  aiConfigured: boolean;
  analysisDescription: string;
  market: 'KR' | 'US';
  generatedAt: string;
  rows: RecoRow[];
  excludedCount: number;
  excludedBreakdown: Record<string, number>;
  dataQualityNote: string;
  error?: string;
  message?: string;
}

const QUALITY_LABEL: Record<string, string> = {
  sufficient: '데이터 충분',
  partial: '데이터 일부 부족',
  insufficient: '데이터 부족',
  stale: '데이터 오래됨',
};

export default function RecommendationsPage() {
  const [, navigate] = useLocation();
  const [market, setMarket] = useState<'KR' | 'US'>('KR');
  const [category, setCategory] = useState<Category>('undervalued');

  const query = useQuery({
    queryKey: ['recommendations', market],
    queryFn: () => apiGet<RecoResponse>(`/market/recommendations?market=${market}`),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const data = query.data;
  const rows = (data?.rows ?? []).filter((row) => row.category === category);

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
      data-testid="recommendations-shell"
    >
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        data-testid="recommendations-scroll-content"
      >
        <div className="mx-auto w-full max-w-6xl px-3 pb-24 pt-3 sm:px-4 sm:pt-4">
          <header className="grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2 border-b border-card-border pb-3">
            <button
              type="button"
              onClick={() => navigate('/home')}
              aria-label="홈으로 돌아가기"
              className="flex h-11 w-11 items-center justify-center rounded-xl border border-card-border bg-card"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <div className="min-w-0 text-center">
              <h1 className="truncate text-xl font-bold sm:text-2xl">AI 추천</h1>
              <p className="mt-1 truncate text-xs font-medium text-muted-foreground">규칙 기반 후보 · LLM 미연결</p>
            </div>
            <button
              type="button"
              onClick={() => void query.refetch()}
              aria-label="추천 새로고침"
              className="flex h-11 w-11 items-center justify-center rounded-xl border border-card-border bg-card"
            >
              <RefreshCw
                className={cn('h-4 w-4', query.isFetching && 'animate-spin')}
                aria-hidden="true"
              />
            </button>
          </header>

          <section className="mt-3 grid gap-2 sm:grid-cols-2" aria-label="추천 필터">
            <div className="grid grid-cols-2 gap-2">
              {(['KR', 'US'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMarket(m)}
                  className={cn(
                    'min-h-11 rounded-xl border px-3 text-sm font-semibold',
                    market === m
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-card-border bg-card text-muted-foreground',
                  )}
                >
                  {m === 'KR' ? '국내주식' : '해외주식'}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setCategory('undervalued')}
                className={cn(
                  'flex min-h-11 items-center justify-center gap-1.5 rounded-xl border px-3 text-sm font-semibold',
                  category === 'undervalued'
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-card-border bg-card text-muted-foreground',
                )}
              >
                <ShieldAlert className="h-4 w-4" aria-hidden="true" /> 저평가
              </button>
              <button
                type="button"
                onClick={() => setCategory('breakout')}
                className={cn(
                  'flex min-h-11 items-center justify-center gap-1.5 rounded-xl border px-3 text-sm font-semibold',
                  category === 'breakout'
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-card-border bg-card text-muted-foreground',
                )}
              >
                <TrendingUp className="h-4 w-4" aria-hidden="true" /> 추세돌파
              </button>
            </div>
          </section>

          {data && (
            <details className="mt-3 rounded-2xl border border-card-border bg-card" data-testid="recommendation-methodology">
              <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-4 text-sm font-semibold [&::-webkit-details-marker]:hidden">
                <span>추천 산출 기준</span>
                <span className="text-xs font-medium text-muted-foreground">상세 보기</span>
              </summary>
              <div className="border-t border-card-border px-4 py-3">
                <p className="break-keep text-sm font-normal leading-6 text-muted-foreground">
                  {data.analysisDescription}
                </p>
                <p className="mt-2 break-keep text-xs font-medium leading-5 text-muted-foreground">
                  생성 {new Date(data.generatedAt).toLocaleString('ko-KR')} · 제외 {data.excludedCount}종목 · {data.dataQualityNote}
                </p>
              </div>
            </details>
          )}

          <div className="mt-3">
            {query.isLoading && (
              <StateBox>실데이터를 수집해 추천을 계산하는 중입니다.</StateBox>
            )}
            {query.isError && (
              <StateBox error>추천 산출에 실패했습니다. 데이터 공급 상태를 확인한 뒤 다시 시도해 주세요.</StateBox>
            )}
            {!query.isLoading && !query.isError && rows.length === 0 && (
              <StateBox>
                현재 조건을 충족하는 {category === 'undervalued' ? '저평가' : '초기 추세돌파'} 후보가 없습니다. 조건 미달 종목으로 채우지 않습니다.
              </StateBox>
            )}
          </div>

          <div className="mt-3 grid gap-3 min-[900px]:grid-cols-2" data-testid="recommendation-card-grid">
            {rows.map((row) => (
              <RecoCard
                key={`${row.market}:${row.ticker}`}
                row={row}
                onOpen={() => navigate(`/stock/${encodeURIComponent(row.ticker)}`)}
              />
            ))}
          </div>
        </div>
      </div>
      <BottomNav />
    </div>
  );
}

function StateBox({
  children,
  error,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border p-5 text-center text-sm font-medium leading-6',
        error
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : 'border-card-border bg-card text-muted-foreground',
      )}
    >
      {children}
    </div>
  );
}

function RecoCard({ row, onOpen }: { row: RecoRow; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <article className="min-w-0 rounded-2xl border border-card-border bg-card p-4 shadow-sm">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <p className="truncate text-base font-semibold">
            {displayStockName(row.ticker, row.name, row.market)}
          </p>
          <p className="mt-1 truncate text-xs font-medium text-muted-foreground">
            {row.ticker} · {row.market === 'KR' ? '국내' : '해외'} · {row.categoryLabel}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-base font-bold tabular-nums">
            {formatAppPrice(row.price, row.currency)}
          </p>
          <p
            className={cn(
              'mt-1 text-xs font-semibold tabular-nums',
              row.changePercent == null
                ? 'text-muted-foreground'
                : row.changePercent >= 0
                  ? 'text-positive'
                  : 'text-destructive',
            )}
          >
            {row.changePercent == null ? '—' : formatAppPercent(row.changePercent)}
          </p>
        </div>
      </button>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge tone={row.score >= 70 ? 'positive' : 'muted'}>규칙 점수 {row.score}점</Badge>
        <Badge tone={row.opinion === '매수' ? 'positive' : 'muted'}>{row.opinion}</Badge>
        <Badge tone={row.riskLevel === 'HIGH' ? 'negative' : row.riskLevel === 'MEDIUM' ? 'warn' : 'muted'}>
          위험 {row.riskLevel}
        </Badge>
        <Badge tone={row.dataQuality === 'sufficient' ? 'positive' : 'warn'}>
          {QUALITY_LABEL[row.dataQuality] ?? row.dataQuality}
        </Badge>
      </div>

      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm font-normal leading-5 text-foreground/90">
        {row.reasons.slice(0, open ? undefined : 3).map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>

      {open && (
        <div className="mt-3 space-y-3 text-sm">
          {row.risks.length > 0 && (
            <div className="rounded-xl bg-destructive/10 p-3 text-sm font-medium leading-5 text-destructive">
              {row.risks.map((risk) => (
                <p key={risk}>⚠ {risk}</p>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Info
              label="목표가"
              value={row.targetPrice != null ? formatAppPrice(row.targetPrice, row.currency) : '산출 불가'}
              sub={row.targetBasis}
            />
            <Info
              label="손절 기준"
              value={row.stopLoss != null ? formatAppPrice(row.stopLoss, row.currency) : '산출 불가'}
              sub={row.stopBasis}
            />
            <Info label="재무 안정성" value={row.financialStability} />
            <Info label="뉴스 리스크" value={row.newsRisk} />
          </div>
          <div className="space-y-1 rounded-xl border border-card-border bg-secondary/30 p-3 text-sm leading-5 text-muted-foreground">
            <p>단기: {row.shortTermOutlook}</p>
            <p>중기: {row.midTermOutlook}</p>
          </div>
          <details className="rounded-xl border border-card-border bg-secondary/30">
            <summary className="cursor-pointer list-none px-3 py-2 text-xs font-semibold text-muted-foreground [&::-webkit-details-marker]:hidden">
              데이터 근거 보기
            </summary>
            <div className="border-t border-card-border px-3 py-2 text-xs font-normal leading-5 text-muted-foreground">
              <p>
                사용 데이터: {row.usedData.join(', ')}
                {row.missingData.length ? ` · 미반영: ${row.missingData.join(', ')}` : ''}
              </p>
              <p className="mt-1">
                데이터 기준 {new Date(row.dataUpdatedAt).toLocaleString('ko-KR')} · 공급자 {row.providers.join(', ')}
                {row.previousGeneratedAt
                  ? ` · 직전 추천 ${new Date(row.previousGeneratedAt).toLocaleDateString('ko-KR')}${row.changeSincePrevious != null ? ` 이후 ${row.changeSincePrevious >= 0 ? '+' : ''}${row.changeSincePrevious}%` : ''}`
                  : ''}
              </p>
            </div>
          </details>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-3 min-h-11 w-full rounded-xl border border-card-border bg-secondary/60 px-3 text-sm font-semibold text-muted-foreground"
      >
        {open ? '접기' : '근거·위험 자세히'}
      </button>
    </article>
  );
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: 'positive' | 'negative' | 'warn' | 'muted';
}) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-1 text-xs font-semibold',
        tone === 'positive' && 'bg-positive/10 text-positive',
        tone === 'negative' && 'bg-destructive/10 text-destructive',
        tone === 'warn' && 'bg-amber-500/10 text-amber-500',
        tone === 'muted' && 'bg-secondary text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

function Info({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="min-w-0 rounded-xl bg-secondary/60 p-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-sm font-semibold">{value}</p>
      {sub && <p className="mt-1 break-keep text-xs font-normal leading-5 text-muted-foreground">{sub}</p>}
    </div>
  );
}
