import { Link } from 'wouter';
import type { readBacktestPaperHandoff } from '../../../packages/strategy-hypothesis/src/backtest-paper-handoff.js';

export function BacktestPaperCandidatePreview({ imported }: { imported: ReturnType<typeof readBacktestPaperHandoff> }) {
  const handoff = imported.handoff;
  return <div className="h-full overflow-y-auto overscroll-contain px-4 py-6">
    <section className="mx-auto max-w-3xl rounded-2xl border border-border bg-card p-4" data-testid="paper-candidate-reference">
      <h1 className="text-lg font-black">Backtest → Paper 후보 참조</h1>
      <p role="status" className="mt-3 break-words text-sm font-bold">{imported.error ?? 'REFERENCE_ONLY — 같은 전략 Paper 실행은 UNAVAILABLE'}</p>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">URL은 신뢰된 실행 권한이나 결과 증명이 아닙니다. 누락 identity는 기본 종목·방향·0으로 변환하지 않습니다. 기존 수동 Paper 계좌에 이 후보를 실행하거나 경제 증거로 적립하지 않습니다.</p>
      {handoff ? <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(['candidateId', 'strategyId', 'parameterHash', 'market', 'symbol', 'timeframe', 'side', 'leverage', 'riskPolicyRef', 'costPolicyRef', 'exitPolicyRef'] as const).map((field) => <div key={field} className="min-w-0 rounded-xl bg-background p-3">
          <dt className="text-xs text-muted-foreground">{field}</dt><dd className="mt-1 break-all text-xs font-bold" data-testid={`paper-candidate-${field}`}>{handoff[field] ?? 'MISSING'}</dd>
        </div>)}
      </dl> : <p className="mt-4 text-sm">INVALID / UNAVAILABLE — 수동 Paper 기본 화면으로 자동 전환하지 않았습니다.</p>}
      {handoff?.blockers.length ? <ul className="mt-4 space-y-2 text-xs" aria-label="Paper 실행 차단 사유">{handoff.blockers.map((blocker) => <li key={blocker} className="break-all">{blocker}</li>)}</ul> : null}
      <p className="mt-4 text-xs font-bold">executionAuthority=NONE · evidenceCredit=0 · orderSubmitted=false · privateTradingApiAllowed=false</p>
      <Link href="/backtests" className="mt-4 inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm font-bold">백테스트로 돌아가기</Link>
    </section>
  </div>;
}
