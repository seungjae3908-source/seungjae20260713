import { ArrowRight, BookOpenCheck, FlaskConical, Link2, WalletCards } from 'lucide-react';
import type { UnifiedTradeJournal } from '@/lib/paper-journal-sync';

function countBySource(data: UnifiedTradeJournal, source: 'APP_PAPER'|'APP_SHADOW'|'APP_AUTO') {
  return data.trades.filter((trade) => trade.source === source).length;
}

function percent(numerator: number, denominator: number) {
  if (denominator <= 0) return 'N/A';
  return `${Math.round((numerator / denominator) * 100)}%`;
}

export function JournalPaperLinkageSummary({ data }: { data: UnifiedTradeJournal }) {
  const paperTrades = data.trades.filter((trade) => trade.source === 'APP_PAPER');
  const closedPaper = paperTrades.filter((trade) => trade.status === 'CLOSED').length;
  const openPaper = paperTrades.filter((trade) => trade.status === 'OPEN').length;
  const journalCostReady = paperTrades.filter((trade) => trade.costEvidence?.status === 'READY').length;
  const netPnlReady = paperTrades.filter((trade) => trade.status === 'CLOSED' && trade.netPnl != null).length;
  const strategyKnown = paperTrades.filter((trade) => Boolean(trade.strategy)).length;
  const timeframeKnown = paperTrades.filter((trade) => Boolean(trade.timeframe)).length;
  const paperSourceReady = paperTrades.length > 0;
  const integrityIssueN = data.integrityIssues.length;
  const bindingSummary = data.canonicalResearchBinding;
  const verifiedBindings = paperTrades.filter((trade) => trade.canonicalResearchBinding?.status === 'VERIFIED');
  const mismatchBindings = paperTrades.filter((trade) => trade.canonicalResearchBinding?.status === 'MISMATCH');
  const unavailableBindings = paperTrades.filter((trade) => (
    !trade.canonicalResearchBinding || trade.canonicalResearchBinding.status === 'NOT_AVAILABLE'
  ));
  const candidateIds = [...new Set(verifiedBindings
    .map((trade) => trade.canonicalResearchBinding?.candidateId)
    .filter((value): value is string => Boolean(value)))];
  const researchBindingReady = paperTrades.length > 0 && verifiedBindings.length === paperTrades.length;

  return (
    <section
      className="rounded-2xl border border-border bg-card p-4"
      data-testid="journal-paper-linkage"
      aria-label="Paper 매매일지 연결 상태"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-primary">Paper → Journal linkage</p>
          <h3 className="mt-1 text-base font-extrabold">Paper 기록 연결 상태</h3>
          <p className="mt-1 break-keep text-xs leading-5 text-muted-foreground">
            통합 매매일지가 실제로 어떤 앱 기록을 포함하는지 확인합니다. Research 후보 연결은 브라우저 self-claim이 아니라 authenticated Paper state와 일치한 경우에만 검증됩니다.
          </p>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-[10px] font-black ${
          paperSourceReady
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
            : 'border-border bg-muted/50 text-muted-foreground'
        }`}>
          {paperSourceReady ? 'APP_PAPER 연결 관측' : 'APP_PAPER 미관측'}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-xl bg-muted/40 p-3">
          <p className="text-[10px] font-bold text-muted-foreground">Paper 출처</p>
          <p className="mt-1 text-base font-black tabular-nums">{paperTrades.length}건</p>
        </div>
        <div className="rounded-xl bg-muted/40 p-3">
          <p className="text-[10px] font-bold text-muted-foreground">종료 / 진행</p>
          <p className="mt-1 text-base font-black tabular-nums">{closedPaper} / {openPaper}</p>
        </div>
        <div className="rounded-xl bg-muted/40 p-3">
          <p className="text-[10px] font-bold text-muted-foreground">Journal 비용필드</p>
          <p className="mt-1 text-base font-black tabular-nums">{journalCostReady}/{paperTrades.length || 0}</p>
          <p className="mt-1 text-[9px] text-muted-foreground">fees + tax 기준 · 8개 Full Cost와 별개</p>
        </div>
        <div className="rounded-xl bg-muted/40 p-3">
          <p className="text-[10px] font-bold text-muted-foreground">종료 Net PnL</p>
          <p className="mt-1 text-base font-black tabular-nums">{netPnlReady}/{closedPaper || 0}</p>
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <article className="rounded-xl border border-border bg-background p-3">
          <p className="text-xs font-black">전략 연결</p>
          <p className="mt-1 text-sm font-black">{strategyKnown}/{paperTrades.length || 0} · {percent(strategyKnown, paperTrades.length)}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">journal strategy 필드 존재 여부</p>
        </article>
        <article className="rounded-xl border border-border bg-background p-3">
          <p className="text-xs font-black">시간봉 연결</p>
          <p className="mt-1 text-sm font-black">{timeframeKnown}/{paperTrades.length || 0} · {percent(timeframeKnown, paperTrades.length)}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">journal timeframe 필드 존재 여부</p>
        </article>
        <article className="rounded-xl border border-border bg-background p-3">
          <p className="text-xs font-black">정합성 이슈</p>
          <p className="mt-1 text-sm font-black">{integrityIssueN}건</p>
          <p className="mt-1 text-[10px] text-muted-foreground">통합 ledger가 보고한 integrityIssues</p>
        </article>
      </div>

      <div className={`mt-3 rounded-xl border p-3 ${researchBindingReady
        ? 'border-emerald-500/30 bg-emerald-500/10'
        : 'border-amber-500/30 bg-amber-500/10'}`} data-testid="journal-candidate-binding-gap">
        <p className={`text-xs font-black ${researchBindingReady
          ? 'text-emerald-700 dark:text-emerald-300'
          : 'text-amber-700 dark:text-amber-300'}`}>
          Research 후보 직접 연결 · {researchBindingReady ? '검증됨' : '부분/미확인'}
        </p>
        <p className="mt-1 break-keep text-[11px] leading-5 text-muted-foreground">
          검증 {verifiedBindings.length}/{paperTrades.length || 0} · 불일치 {mismatchBindings.length} · 미확인 {unavailableBindings.length}.
          APP_PAPER 출처만으로 후보를 연결하지 않고 authenticated Paper state의 동일 tradeId·핵심 필드·validation receipt가 모두 일치해야 합니다.
        </p>
        <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">
          binding source · {bindingSummary?.source ?? 'NOT_AVAILABLE'} · sourceSha {bindingSummary?.sourceSha ?? 'NOT_AVAILABLE'}
        </p>
        {candidateIds.length ? (
          <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">candidateId · {candidateIds.join(' · ')}</p>
        ) : null}
        <p className="mt-1 text-[10px] text-muted-foreground">
          Settlement identity는 해당 trade의 canonicalResearchBinding.settlementBindingVerified=true일 때만 검증된 것으로 봅니다. 8개 Full Cost 수익성 증거와는 별도입니다.
        </p>
      </div>

      <details className="mt-3 rounded-xl border border-border bg-background">
        <summary className="min-h-11 cursor-pointer px-3 py-3 text-xs font-black">출처별 기록과 integration 근거</summary>
        <div className="grid gap-2 border-t border-border p-3 text-xs sm:grid-cols-2">
          <p>APP_PAPER · <strong>{countBySource(data, 'APP_PAPER')}건</strong></p>
          <p>APP_SHADOW · <strong>{countBySource(data, 'APP_SHADOW')}건</strong></p>
          <p>APP_AUTO · <strong>{countBySource(data, 'APP_AUTO')}건</strong></p>
          <p>generatedAt · <strong>{data.generatedAt}</strong></p>
          <p className="break-all sm:col-span-2">integrationBaseSha · <strong className="font-mono">{data.integrationBaseSha}</strong></p>
        </div>
      </details>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <a
          href="/paper-trading"
          className="flex min-h-11 items-center justify-between rounded-xl border border-border bg-background px-3 text-xs font-black"
          data-testid="journal-link-paper-trading"
        >
          <span className="flex items-center gap-2"><WalletCards className="h-4 w-4 text-primary" />모의매매 화면</span>
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </a>
        <a
          href="/research-center"
          className="flex min-h-11 items-center justify-between rounded-xl border border-border bg-background px-3 text-xs font-black"
          data-testid="journal-link-research-center"
        >
          <span className="flex items-center gap-2"><FlaskConical className="h-4 w-4 text-primary" />Research Center</span>
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </a>
      </div>

      <p className="mt-3 flex items-start gap-2 text-[10px] leading-4 text-muted-foreground">
        <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        이 카드는 기존 read-only Unified Journal 응답만 재구성합니다. 주문·동기화·계좌 변경을 실행하지 않습니다.
      </p>
    </section>
  );
}
