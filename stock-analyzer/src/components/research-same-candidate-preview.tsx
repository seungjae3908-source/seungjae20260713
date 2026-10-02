import type { ResearchSameCandidatePrewireResult } from '../../../api-server/src/services/research-same-candidate-prewire.service';

export function ResearchSameCandidatePreview({ result }: { result: ResearchSameCandidatePrewireResult }) {
  return <section className="mt-3 space-y-3 rounded-xl border border-border p-3" aria-label="동일 후보 runtime 증거 조회" data-testid="research-same-candidate-preview">
    <p className="break-all font-bold">{result.status}</p>
    <p className="break-all text-xs">Identity anchor: {result.identityAnchorDigest ?? 'MISSING_EVIDENCE'}</p>
    <div className="grid gap-2 sm:grid-cols-2">{Object.values(result.stages).map(stage => <article key={stage.stage} className="min-w-0 rounded-lg border border-border p-3">
      <h4 className="font-bold">{stage.stage} · {stage.status}</h4>
      <ul className="mt-2 space-y-1 break-all text-xs">{stage.blockers.map(reason => <li key={reason}>{reason}</li>)}</ul>
    </article>)}</div>
    <p className="break-all text-xs">{result.blockers.join(' · ')}</p>
    <p className="text-xs">식별자 일치는 수익성·OOS 통과가 아닙니다. evidenceCredit=0 · executionAuthority=NONE. Shadow/Forward/Paper 활성화와 주문은 하지 않습니다.</p>
  </section>;
}
