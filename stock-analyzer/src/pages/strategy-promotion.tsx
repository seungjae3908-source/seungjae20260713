import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, ChevronUp, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import {
  completedPromotionStages,
  fetchStrategyPromotions,
  type PromotionStage,
  type StrategyPromotionItem,
} from '@/lib/strategy-promotion';

const STAGE_LABELS: Record<string, string> = {
  RESEARCH_DESIGN: 'Research design', HISTORICAL_BACKTEST: 'Historical backtest', OUT_OF_SAMPLE: 'Out-of-sample',
  PURGED_WALK_FORWARD: 'Purged walk-forward', COST_STRESS: 'Cost stress', REGIME: 'Regime validation',
  FINAL_HOLDOUT: 'Final holdout', PAPER: 'Paper', SHADOW: 'Shadow', RECOMMENDATION_OUTCOMES: 'Recommendation outcomes',
};

function statusClass(status: PromotionStage['status']) {
  if (status === 'PASS') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500';
  if (status === 'FAIL' || status === 'INVALIDATED') return 'border-destructive/40 bg-destructive/10 text-destructive';
  if (status === 'BLOCKED' || status === 'STALE') return 'border-amber-500/40 bg-amber-500/10 text-amber-500';
  return 'border-card-border bg-background text-muted-foreground';
}

function EvidenceValue({ value }: { value: unknown }) {
  if (value == null) return <span className="text-muted-foreground">Evidence required</span>;
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  if (typeof value === 'number') return <span className="tabular-nums">{value.toLocaleString()}</span>;
  return <span className="break-all">{String(value)}</span>;
}

function StageTimeline({ stages }: { stages: PromotionStage[] }) {
  return (
    <ol className="mt-4 space-y-2" aria-label="Promotion evidence timeline">
      {stages.map((stage, index) => (
        <li key={stage.stage} className="grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)] gap-2">
          <div className="flex flex-col items-center">
            <span className={`mt-1 h-3 w-3 rounded-full border ${statusClass(stage.status)}`} />
            {index < stages.length - 1 ? <span className="min-h-5 w-px flex-1 bg-border" aria-hidden="true" /> : null}
          </div>
          <div className="min-w-0 rounded-xl border border-card-border bg-background/60 p-3">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <h4 className="break-keep text-xs font-black">{STAGE_LABELS[stage.stage] ?? stage.stage}</h4>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-black ${statusClass(stage.status)}`}>{stage.status}</span>
            </div>
            <dl className="mt-2 grid min-w-0 grid-cols-1 gap-1 text-[10px] text-muted-foreground sm:grid-cols-2">
              <div className="min-w-0"><dt className="font-bold text-foreground">Source</dt><dd className="truncate">{stage.source}</dd></div>
              <div><dt className="font-bold text-foreground">Data quality</dt><dd>{stage.dataQuality}</dd></div>
              <div><dt className="font-bold text-foreground">Samples / trades</dt><dd><EvidenceValue value={stage.sampleSize ?? stage.tradeCount} /></dd></div>
              <div className="min-w-0"><dt className="font-bold text-foreground">Gate</dt><dd className="break-all">{stage.gate}</dd></div>
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
          <p className="truncate text-[10px] font-black text-primary">{item.identity.market} · {item.identity.direction}</p>
          <h3 className="mt-1 break-all text-sm font-black">{item.identity.strategyId}</h3>
          <p className="mt-1 text-[10px] text-muted-foreground">{item.identity.horizon} · {item.identity.timeframe} · {item.identity.version}</p>
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-1 text-[10px] font-black ${item.promotionEligible ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500' : 'border-card-border bg-background text-muted-foreground'}`}>{item.promotionState}</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted" aria-label={`${completed} of ${item.stages.length} promotion stages passed`}>
        <div className="h-full bg-primary" style={{ width: `${completed / item.stages.length * 100}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span>{completed}/{item.stages.length} gates passed</span><span>Drift: {item.drift.classification ?? item.drift.status}</span><span>Kill: {item.killState}</span>
      </div>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className="mt-3 flex min-h-11 w-full items-center justify-between rounded-xl border border-card-border px-3 text-xs font-black">
        Evidence and timeline {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {expanded ? (
        <div>
          <dl className="mt-3 grid min-w-0 grid-cols-1 gap-2 rounded-xl bg-background p-3 text-[10px] sm:grid-cols-2">
            <div className="min-w-0"><dt className="font-bold text-muted-foreground">Parameter hash</dt><dd className="truncate font-mono">{item.identity.parameterHash}</dd></div>
            <div className="min-w-0"><dt className="font-bold text-muted-foreground">Research SHA</dt><dd className="truncate font-mono">{item.identity.researchCodeSha}</dd></div>
            <div><dt className="font-bold text-muted-foreground">Cost policy</dt><dd className="break-all">{item.identity.costPolicyVersion}</dd></div>
            <div><dt className="font-bold text-muted-foreground">Risk policy</dt><dd className="break-all">{item.identity.riskPolicyVersion}</dd></div>
          </dl>
          <StageTimeline stages={item.stages} />
          {item.blockers.length ? <p className="mt-3 break-all text-[10px] text-muted-foreground">Blockers: {item.blockers.join(' · ')}</p> : null}
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
            <button type="button" aria-label="Back to scanner" onClick={() => navigate('/scanner')} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-card-border"><ArrowLeft className="h-4 w-4" /></button>
            <div className="min-w-0 flex-1"><p className="text-[10px] font-black text-primary">Evidence-only governance · no execution authority</p><h1 className="mt-1 text-xl font-black">Strategy Promotion Center</h1><p className="mt-1 break-keep text-xs leading-5 text-muted-foreground">Research, backtest, paper, shadow and recommendation evidence are linked to an exact strategy identity. Missing or stale evidence fails closed.</p></div>
            <button type="button" aria-label="Refresh promotion evidence" onClick={() => void query.refetch()} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-card-border"><RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} /></button>
          </div>
        </header>

        {query.data ? <section className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Promotion summary">
          <div className="rounded-2xl border border-card-border bg-card p-3"><p className="text-[10px] text-muted-foreground">Strategies</p><strong className="text-xl">{items.length}</strong></div>
          <div className="rounded-2xl border border-card-border bg-card p-3"><p className="text-[10px] text-muted-foreground">Candidates</p><strong data-testid="promotion-candidate-count" className="text-xl">{query.data.promotionCandidates}</strong></div>
          <div className="rounded-2xl border border-card-border bg-card p-3"><p className="text-[10px] text-muted-foreground">Live authority</p><strong className="text-sm">NONE</strong></div>
          <div className="rounded-2xl border border-card-border bg-card p-3"><p className="text-[10px] text-muted-foreground">Private API</p><strong className="text-sm">0</strong></div>
        </section> : null}

        <section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs" role="note"><div className="flex items-start gap-2"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" /><p className="break-keep">A promotion candidate is still a review candidate, never live-trading approval. Cost stress must pass at 1x, 1.25x, 1.5x and 2x.</p></div></section>
        {query.isPending ? <section aria-live="polite" className="rounded-3xl border border-card-border bg-card p-8 text-center text-sm">Loading linked evidence…</section> : null}
        {query.isError ? <section role="alert" className="rounded-3xl border border-destructive/40 bg-destructive/10 p-5"><p className="font-black text-destructive">Promotion evidence unavailable</p><button type="button" onClick={() => void query.refetch()} className="mt-3 min-h-11 rounded-xl border border-destructive/30 px-4 text-sm font-bold">Retry</button></section> : null}
        {query.data ? <section className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3">{items.map((item) => <StrategyCard key={item.identity.strategyId} item={item} />)}</section> : null}

        {query.data ? <section className="rounded-3xl border border-card-border bg-card p-4"><div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" /><h2 className="text-sm font-black">Evidence source ownership</h2></div><div className="mt-3 grid gap-2 sm:grid-cols-2">{query.data.evidenceSources.map((source) => <div key={source.id} className="min-w-0 rounded-xl bg-background p-3 text-[10px]"><div className="flex flex-wrap justify-between gap-2"><strong>{source.id}</strong><span>{source.status}</span></div><p className="mt-1 break-keep text-muted-foreground">{source.owner} · {source.use}</p></div>)}</div></section> : null}
      </div>
      <BottomNav />
    </main>
  );
}
