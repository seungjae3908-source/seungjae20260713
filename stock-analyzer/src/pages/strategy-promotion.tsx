import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, ChevronUp, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import {
  DRIFT_STATE_KO,
  KILL_STATE_KO,
  PROMOTION_STAGE_KO,
  PROMOTION_STATE_KO,
  USER_DIRECTION_KO,
  USER_MARKET_KO,
  USER_STATUS_KO,
  userFacingCodeLabel,
} from '@/lib/labels';
import {
  completedPromotionStages,
  fetchStrategyPromotions,
  type PromotionStage,
  type StrategyPromotionItem,
} from '@/lib/strategy-promotion';

function statusClass(status: PromotionStage['status']) {
  if (status === 'PASS') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500';
  if (status === 'FAIL' || status === 'INVALIDATED') return 'border-destructive/40 bg-destructive/10 text-destructive';
  if (status === 'BLOCKED' || status === 'STALE') return 'border-amber-500/40 bg-amber-500/10 text-amber-500';
  return 'border-card-border bg-background text-muted-foreground';
}

function EvidenceValue({ value }: { value: unknown }) {
  if (value == null) return <span className="text-muted-foreground">근거 필요</span>;
  if (typeof value === 'boolean') return <span>{value ? '예' : '아니요'}</span>;
  if (typeof value === 'number') return <span className="tabular-nums">{value.toLocaleString()}</span>;
  return <span className="break-all">{String(value)}</span>;
}

function StageTimeline({ stages }: { stages: PromotionStage[] }) {
  return (
    <ol className="mt-4 space-y-2" aria-label="승격 검증 근거 단계">
      {stages.map((stage, index) => (
        <li key={stage.stage} className="grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)] gap-2">
          <div className="flex flex-col items-center">
            <span className={`mt-1 h-3 w-3 rounded-full border ${statusClass(stage.status)}`} />
            {index < stages.length - 1 ? <span className="min-h-5 w-px flex-1 bg-border" aria-hidden="true" /> : null}
          </div>
          <div className="min-w-0 rounded-xl border border-card-border bg-background/60 p-3">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <h4 className="break-keep text-xs font-black">{userFacingCodeLabel(stage.stage, PROMOTION_STAGE_KO)}</h4>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-black ${statusClass(stage.status)}`}>{userFacingCodeLabel(stage.status, USER_STATUS_KO)}</span>
            </div>
            <dl className="mt-2 grid min-w-0 grid-cols-1 gap-1 text-[10px] text-muted-foreground sm:grid-cols-2">
              <div className="min-w-0"><dt className="font-bold text-foreground">근거 출처</dt><dd className="truncate">{stage.source}</dd></div>
              <div><dt className="font-bold text-foreground">데이터 품질</dt><dd>{userFacingCodeLabel(stage.dataQuality, USER_STATUS_KO)}</dd></div>
              <div><dt className="font-bold text-foreground">표본 / 거래 수</dt><dd><EvidenceValue value={stage.sampleCount ?? stage.sampleSize ?? stage.tradeCount} /></dd></div>
              <div className="min-w-0"><dt className="font-bold text-foreground">통과 조건</dt><dd className="break-all">{userFacingCodeLabel(stage.gateResult, USER_STATUS_KO)}: {stage.gate}</dd></div>
            </dl>
            {stage.failureReason ? <p className="mt-2 break-all text-[10px] font-bold text-amber-500">{stage.failureReason}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function StrategyCard({ item }: { item: StrategyPromotionItem }) {
  const [expanded, setExpanded] = useState(false);
  const completed = completedPromotionStages(item);
  return (
    <article data-testid="strategy-promotion-card" className="min-w-0 rounded-3xl border border-card-border bg-card p-4 shadow-sm">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[10px] font-black text-primary">{userFacingCodeLabel(item.identity.market, USER_MARKET_KO)} · {userFacingCodeLabel(item.identity.direction, USER_DIRECTION_KO)}</p>
          <h3 className="mt-1 break-all text-sm font-black">{item.identity.strategyId}</h3>
          <p className="mt-1 text-[10px] text-muted-foreground">{item.identity.strategyHorizon} · {item.identity.timeframe} · {item.identity.strategyVersion}</p>
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-1 text-[10px] font-black ${item.promotionEligible ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500' : 'border-card-border bg-background text-muted-foreground'}`}>{userFacingCodeLabel(item.promotionState, PROMOTION_STATE_KO)}</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted" aria-label={`승격 검증 ${item.stages.length}단계 중 ${completed}단계 통과`}>
        <div className="h-full bg-primary" style={{ width: `${completed / item.stages.length * 100}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span>{completed}/{item.stages.length} 단계 통과</span><span>드리프트: {userFacingCodeLabel(item.drift.classification ?? item.drift.status, DRIFT_STATE_KO)}</span><span>긴급중단 상태: {userFacingCodeLabel(item.killState, KILL_STATE_KO)}</span>
      </div>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className="mt-3 flex min-h-11 w-full items-center justify-between rounded-xl border border-card-border px-3 text-xs font-black">
        근거와 검증 단계 {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {expanded ? (
        <div>
          <dl className="mt-3 grid min-w-0 grid-cols-1 gap-2 rounded-xl bg-background p-3 text-[10px] sm:grid-cols-2">
            <div className="min-w-0"><dt className="font-bold text-muted-foreground">파라미터 해시</dt><dd className="truncate font-mono">{item.identity.parameterHash}</dd></div>
            <div className="min-w-0"><dt className="font-bold text-muted-foreground">연구 코드 SHA</dt><dd className="truncate font-mono">{item.identity.researchCodeSha}</dd></div>
            <div><dt className="font-bold text-muted-foreground">비용 정책</dt><dd className="break-all">{item.identity.costPolicyVersion}</dd></div>
            <div><dt className="font-bold text-muted-foreground">위험 정책</dt><dd className="break-all">{item.identity.riskPolicyVersion}</dd></div>
          </dl>
          <StageTimeline stages={item.stages} />
          {item.blockers.length ? <p className="mt-3 break-all text-[10px] text-muted-foreground">차단 사유: {item.blockers.join(' · ')}</p> : null}
        </div>
      ) : null}
    </article>
  );
}

export default function StrategyPromotionPage() {
  const [, navigate] = useLocation();
  const query = useQuery({ queryKey: ['strategy-promotion', 'all'], queryFn: ({ signal }) => fetchStrategyPromotions(signal), staleTime: 60_000 });
  const items = query.data?.items ?? [];
  return (
    <main className="h-full overflow-y-auto overscroll-contain bg-background pb-24" data-testid="strategy-promotion-page">
      <div className="mx-auto w-full max-w-7xl space-y-4 px-3 py-4 sm:px-5">
        <header className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
          <div className="flex min-w-0 items-start gap-3">
            <button type="button" aria-label="검색기로 돌아가기" onClick={() => navigate('/scanner')} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-card-border"><ArrowLeft className="h-4 w-4" /></button>
            <div className="min-w-0 flex-1"><p className="text-[10px] font-black text-primary">근거 기반 검증 · 주문 실행 권한 없음</p><h1 className="mt-1 text-xl font-black">전략 승격센터</h1><p className="mt-1 break-keep text-xs leading-5 text-muted-foreground">연구·과거검증·모의자동매매·실시간 추적검증·추천 결과를 정확한 전략 식별자에 연결합니다. 근거가 없거나 오래된 경우 통과시키지 않습니다.</p></div>
            <button type="button" aria-label="승격 근거 새로고침" onClick={() => void query.refetch()} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-card-border"><RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} /></button>
          </div>
        </header>

        {query.data ? <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6" aria-label="승격 검증 요약">
          <div className="rounded-2xl border border-card-border bg-card p-3"><p className="text-[10px] text-muted-foreground">전략</p><strong className="text-xl">{items.length}</strong></div>
          <div className="rounded-2xl border border-card-border bg-card p-3"><p className="text-[10px] text-muted-foreground">승격 후보</p><strong data-testid="promotion-candidate-count" className="text-xl">{query.data.promotionCandidates}</strong></div>
          <div className="rounded-2xl border border-card-border bg-card p-3"><p className="text-[10px] text-muted-foreground">추적검증 완료</p><strong className="text-xl">{query.data.counts.SHADOW_VALIDATED}</strong></div>
          <div className="rounded-2xl border border-card-border bg-card p-3"><p className="text-[10px] text-muted-foreground">연구 보류</p><strong className="text-xl">{query.data.counts.RESEARCH_HOLD}</strong></div>
          <div className="rounded-2xl border border-card-border bg-card p-3"><p className="text-[10px] text-muted-foreground">중단</p><strong className="text-xl">{query.data.counts.SUSPENDED}</strong></div>
          <div className="rounded-2xl border border-card-border bg-card p-3"><p className="text-[10px] text-muted-foreground">종료</p><strong className="text-xl">{query.data.counts.KILLED}</strong></div>
        </section> : null}

        {query.data ? <section className="grid grid-cols-2 gap-2" aria-label="주문 실행 안전 요약">
          <div className="rounded-2xl border border-card-border bg-card p-3"><p className="text-[10px] text-muted-foreground">실전 주문 권한</p><strong className="text-sm">없음 (NONE)</strong></div>
          <div className="rounded-2xl border border-card-border bg-card p-3"><p className="text-[10px] text-muted-foreground">비공개 거래 API</p><strong className="text-sm">0건</strong></div>
        </section> : null}

        <section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs" role="note"><div className="flex items-start gap-2"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" /><p className="break-keep">승격 후보는 검토 대상일 뿐 실전매매 승인이 아닙니다. 비용 스트레스 검증은 1x, 1.25x, 1.5x, 2x 조건을 모두 통과해야 합니다.</p></div></section>
        {query.isPending ? <section aria-live="polite" className="rounded-3xl border border-card-border bg-card p-8 text-center text-sm">연결된 근거를 불러오는 중…</section> : null}
        {query.isError ? <section role="alert" className="rounded-3xl border border-destructive/40 bg-destructive/10 p-5"><p className="font-black text-destructive">승격 검증 근거를 불러오지 못했습니다.</p><button type="button" onClick={() => void query.refetch()} className="mt-3 min-h-11 rounded-xl border border-destructive/30 px-4 text-sm font-bold">다시 시도</button></section> : null}
        {query.data && items.length === 0 ? <section data-testid="strategy-promotion-empty" className="rounded-3xl border border-card-border bg-card p-8 text-center text-sm text-muted-foreground">현재 조건에 맞는 전략 검증 근거가 없습니다.</section> : null}
        {query.data ? <section className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3">{items.map((item) => <StrategyCard key={item.identity.strategyId} item={item} />)}</section> : null}

        {query.data ? <section className="rounded-3xl border border-card-border bg-card p-4"><div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" /><h2 className="text-sm font-black">근거 출처 및 담당</h2></div><div className="mt-3 grid gap-2 sm:grid-cols-2">{query.data.evidenceSources.map((source) => <div key={source.id} className="min-w-0 rounded-xl bg-background p-3 text-[10px]"><div className="flex flex-wrap justify-between gap-2"><strong>{source.id}</strong><span>{userFacingCodeLabel(source.status, USER_STATUS_KO)}</span></div><p className="mt-1 break-keep text-muted-foreground">{source.owner} · {source.use}</p></div>)}</div></section> : null}
      </div>
      <BottomNav />
    </main>
  );
}
