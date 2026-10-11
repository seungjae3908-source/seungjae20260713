import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { BottomNav } from './bottom-nav';
import { useAuth } from '@/lib/auth';
import { fetchCopilotSnapshot, reviewCopilot, validateResearchDsl, submitResearchBacktest, readResearchBacktest, readResearchSameCandidate, type CopilotReview, type CopilotTask, type DslValidation } from '@/lib/research-copilot';
import type { ResearchSameCandidatePrewireResult } from '../../../api-server/src/services/research-same-candidate-prewire.service';
import { ResearchSameCandidatePreview } from './research-same-candidate-preview';

const ACTIONS: Array<[CopilotTask, string]> = [
  ['propose_candidates', '후보 가설 제안'], ['interpret_evidence', '검증 증거 해석'],
  ['compare_strategies', '전략 비교'], ['explain_health', '전략 상태 분석'],
];
const button = 'min-h-11 rounded-xl border border-border px-4 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50';
const bundleLabels: Record<string, string> = { strategy: '전략', model: '분석 모델', feature: '입력 지표', dataset: '연구 데이터', split: '학습·검증 분할',
  risk: '위험 정책', fullCost: '총비용 8항목', oos: '미사용 표본 검증', wf: '순차 검증', holdout: '최종 검증' };

function copilotStatusLabel(status: string) {
  if (status === 'needs_context') return '추가 근거 필요';
  if (status === 'ready') return '사용 가능';
  if (status === 'blocked') return '차단됨';
  if (status === 'BLOCKED_DATA') return '자료 부족';
  if (status === 'MISSING_EVIDENCE') return '근거 미수집';
  if (status === 'NOT_EVALUABLE') return '평가 불가';
  if (status === 'VERIFIED') return '검증됨';
  if (status === 'NOT_PROVEN') return '미입증';
  return status;
}

function aiReasonLabel(reason: string | null | undefined) {
  if (!reason) return '사용 가능';
  if (reason === 'FREE_TIER_NOT_CONFIRMED') return 'AI 제공자 무료 사용 가능 여부 미확인';
  if (reason === 'PROVIDER_NOT_CONFIGURED') return 'AI 제공자 연결 필요';
  return 'AI 사용 조건 확인 필요';
}

export function ResearchCopilotPanel({ onOpenReview }: { onOpenReview?: () => void } = {}) {
  const { profile, isAdmin } = useAuth();
  const snapshot = useQuery({ queryKey: ['admin', profile?.id, 'research-copilot'], queryFn: ({ signal }) => fetchCopilotSnapshot(signal), enabled: isAdmin && Boolean(profile?.id), staleTime: 30_000, retry: false });
  const [review, setReview] = useState<CopilotReview | null>(null);
  const [dsl, setDsl] = useState('');
  const [validation, setValidation] = useState<DslValidation | null>(null);
  const [sameCandidate, setSameCandidate] = useState<ResearchSameCandidatePrewireResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const artifactPin = useRef<string | null>(null);
  // React Query retains cached data on refetch failure. It must not look like current evidence.
  const data = snapshot.isError ? undefined : snapshot.data;
  useEffect(() => () => { sequence.current += 1; pending.current?.abort(); }, []);
  useEffect(() => { sequence.current += 1; pending.current?.abort(); artifactPin.current = null; setReview(null); setValidation(null); setSameCandidate(null); setBusy(false); }, [profile?.id]);
  const visibleReview = !snapshot.isError && review?.evidenceDigest === data?.evidenceDigest && data?.freshness === 'FRESH' ? review : null;

  async function run(operation: (signal: AbortSignal) => Promise<void>) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const current = ++sequence.current;
    setBusy(true); setError('');
    try { await operation(controller.signal); }
    catch (cause) { if (!controller.signal.aborted && current === sequence.current) setError(cause instanceof Error ? cause.message : '연구 요청 실패'); }
    finally { if (current === sequence.current) setBusy(false); }
  }
  function ask(task: CopilotTask) {
    if (!data) return;
    setReview(null);
    void run(async signal => {
      const result = await reviewCopilot(task, data.evidenceDigest, signal);
      if (!signal.aborted) {
        const refreshed = await snapshot.refetch();
        if (!signal.aborted && !refreshed.isError && refreshed.data?.evidenceDigest === result.evidenceDigest) setReview(result);
      }
    });
  }
  function validate() {
    setSameCandidate(null);
    artifactPin.current = null;
    setValidation(null);
    void run(async signal => {
      if (dsl.length > 32_000) throw new Error('DSL은 32,000자 이내여야 합니다.');
      let value: unknown;
      try { value = JSON.parse(dsl); } catch { throw new Error('올바른 JSON DSL을 입력하세요. 실행 코드는 허용하지 않습니다.'); }
      const result = await validateResearchDsl(value, signal);
      if (!signal.aborted) setValidation(result);
    });
  }
  function submitBacktest() {
    const bundle = validation?.bundle;
    if (!bundle?.backtestExecutable || busy) return;
    setSameCandidate(null);
    void run(async signal => {
      const result = await submitResearchBacktest(JSON.parse(dsl), bundle, signal);
      if (!signal.aborted) { artifactPin.current = result.resultArtifactDigest; setValidation(previous => previous ? { ...previous, bundle: result } : null); }
    });
  }
  function readBacktest() {
    const bundle = validation?.bundle;
    if (!bundle?.researchBundleReady || busy) return;
    setSameCandidate(null);
    void run(async signal => {
      const result = await readResearchBacktest(JSON.parse(dsl), { ...bundle, resultArtifactDigest: artifactPin.current ?? bundle.resultArtifactDigest }, signal);
      if (!signal.aborted) {
        if (result.publicationStatus === 'READBACK_VERIFIED') artifactPin.current = result.resultArtifactDigest;
        setValidation(previous => previous ? { ...previous, bundle: result } : null);
      }
    });
  }
  function readSameCandidate() {
    const bundle = validation?.bundle;
    if (!isAdmin || busy || bundle?.publicationStatus !== 'READBACK_VERIFIED' || !bundle.backtestCompleted) return;
    setSameCandidate(null);
    void run(async signal => {
      const result = await readResearchSameCandidate(JSON.parse(dsl), bundle, signal);
      if (!signal.aborted) setSameCandidate(result);
    });
  }
  return <main className="h-full overflow-y-auto bg-background pb-28" data-testid="research-copilot">
    <div className="mx-auto w-full max-w-5xl space-y-3 p-3 [overflow-wrap:anywhere] sm:p-5">
      <header className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-black">AI 연구</h1>{onOpenReview ? <button type="button" className={button} onClick={onOpenReview}>AI 분석 결과</button> : null}</div>
      </header>
      {snapshot.isPending ? <p role="status">연구 근거를 불러오는 중…</p> : null}
      {snapshot.isError ? <div role="alert" className="rounded-xl border border-destructive p-4"><p>{snapshot.error.message}</p><button className={button} onClick={() => void snapshot.refetch()}>다시 조회</button></div> : null}
      {data ? <>
        <section aria-label="연구 근거와 AI 한도" className="rounded-2xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-bold text-muted-foreground">현재 증거</p><h2 className="mt-1 font-bold">{copilotStatusLabel(data.status)}</h2></div><button className={button} disabled={busy || snapshot.isFetching} onClick={() => void snapshot.refetch()}>증거 새로고침</button></div>
          <p data-testid="research-source-freshness" className="mt-2 text-xs text-muted-foreground">{data.freshness === 'FRESH' ? '최신 기록' : data.freshness === 'STALE' ? '자료 갱신 지연' : data.freshness === 'FUTURE_TIMESTAMP' ? '자료 시각 오류' : '자료 시각 미확인'}</p>
          {!data.ai.available ? <p role="status" className="mt-2 text-sm text-amber-600">{aiReasonLabel(data.ai.reason)}</p> : null}
          <div className="mt-4 flex flex-wrap gap-2">{ACTIONS.map(([task, label]) => <button key={task} className={button} disabled={busy || snapshot.isError || snapshot.isFetching || !data.ai.available} onClick={() => ask(task)}>{label}</button>)}</div>
        </section>
        {busy ? <p role="status">연구 요청을 검증하는 중…</p> : null}
        {error ? <p role="alert" className="rounded-xl border border-destructive p-4">{error}</p> : null}
        {visibleReview?.review ? <section aria-label="AI 연구 제안" className="rounded-2xl border border-primary/40 bg-card p-4">
          <h2 className="font-bold">검증 전 연구 제안 · {visibleReview.review.provider} / {visibleReview.review.model}</h2>
          <p className="mt-2 text-sm">{visibleReview.review.summary}</p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">{visibleReview.review.findings.map((finding, i) => <li key={i}>{finding}</li>)}</ul>
          {visibleReview.review.hypotheses.map((hypothesis, i) => <article key={i} className="mt-4 rounded-xl border border-border p-3">
            <h3 className="font-bold">{hypothesis.hypothesisId}</h3><p className="mt-2 text-sm">{hypothesis.thesis}</p>
            <p className="mt-2 text-sm">반증 조건: {hypothesis.falsification}</p><p className="mt-2 text-sm">필요 증거: {hypothesis.requiredEvidence.join(' · ')}</p>
          </article>)}
        </section> : null}
        <details className="rounded-2xl border border-border bg-card p-4">
          <summary className="min-h-11 cursor-pointer py-2 font-bold">단계별 검증 현황</summary>
          <section aria-label="연구 단계" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.stages.map(stage => <article key={stage.key} className="min-w-0 rounded-2xl border border-border bg-card p-4">
            <h2 className="font-bold">{stage.label}</h2><p className="mt-2 text-sm font-black text-amber-600">{copilotStatusLabel(stage.status)}</p>
            <p className="mt-2 text-xs">검증 기록 {stage.verifiedReceiptCount}개</p>
          </article>)}
          </section>
        </details>
        <section aria-label="DSL 검증" className="rounded-2xl border border-border bg-card p-4">
          <h2 className="font-bold">전략 검증·백테스트</h2>
          <label htmlFor="research-dsl" className="mt-4 block text-sm font-bold">연구 전략 입력</label>
          <textarea id="research-dsl" value={dsl} disabled={busy} maxLength={32_001} onChange={event => { artifactPin.current = null; setDsl(event.target.value); setValidation(null); setSameCandidate(null); }} rows={6} className="mt-2 w-full rounded-xl border border-border bg-background p-3 font-mono text-xs" spellCheck={false} />
          <button className={button + ' mt-3'} disabled={busy || !dsl.trim()} onClick={validate}>전략 검증</button>
          {validation ? <div role="status" className="mt-3 break-all text-sm"><p>{validation.status === 'ready' ? 'DSL 유효 · 전략 미평가' : 'DSL 차단: 지원 범위·필드·연산자·깊이를 확인하세요.'}</p>
            {validation.candidateId ? <p className="mt-2">{validation.candidateId}</p> : null}
            {!validation.bundle ? <p className="mt-2">Bundle 응답 없음 · 실행 차단</p> : null}
          </div> : null}
          {validation?.bundle ? <div aria-label="Backtest Bundle" className="mt-4 space-y-3 break-words text-sm [overflow-wrap:anywhere]">
            <p className="font-bold">백테스트 · {validation.bundle.backtestCompleted ? '완료' : validation.bundle.backtestExecutable ? '실행 가능' : '입력 연결 필요'}</p>
            <details><summary className="min-h-11 cursor-pointer py-3 font-bold">연구 입력 연결 진단</summary>
            <p className="font-mono text-xs">Backtest Bundle · {validation.bundle.backtestStatus}</p>
            <p>DSL_VALID={String(validation.bundle.dslValid)} · RESEARCH_BUNDLE_READY={String(validation.bundle.researchBundleReady)} · BACKTEST_EXECUTABLE={String(validation.bundle.backtestExecutable)}</p>
            <div className="grid gap-2 sm:grid-cols-2">{validation.bundle.components.map(component => <div key={component.key} className="min-w-0 rounded-xl border border-border p-3">
              <p className="font-bold">{bundleLabels[component.key] ?? component.key} · {component.status}</p>
              <ul className="mt-2 space-y-1 break-all text-xs">{component.blockers.map(reason => <li key={reason}>{reason}</li>)}</ul>
            </div>)}</div>
            <p className="break-all text-xs">{validation.bundle.blockers.join(' · ')}</p>
            <p>WF: {validation.bundle.wfStatus} · OOS: {validation.bundle.oosStatus} · Holdout: {validation.bundle.holdoutStatus}</p>
            <p>통계 방화벽: {validation.bundle.statisticalFirewallStatus} · Promotion: 불가 · Champion: 없음</p>
            <p>이 요청의 백테스터 호출: {validation.bundle.backtesterCalls}회. 역사 백테스트 완료는 WF/OOS/Holdout 통과가 아닙니다.</p>
            <p>결과 보존·재조회: {validation.bundle.publicationStatus}</p>
            </details>
            <button className={button} disabled={busy || !validation.bundle.backtestExecutable || validation.bundle.backtestSubmitted} onClick={submitBacktest}>연구 백테스트 제출</button>
            <button className={button + ' ml-0 sm:ml-2'} disabled={busy || !validation.bundle.researchBundleReady} onClick={readBacktest}>저장된 연구 결과 재조회</button>
            <section aria-label="선택 후보의 증거 연결" className="rounded-xl border border-border p-3">
              <h3 className="font-bold">이 후보의 다음 단절 지점</h3>
              <p className="mt-2">{!validation.bundle.researchBundleReady ? 'BLOCKED_DATA · 실행 가능한 canonical Bundle 부족' : !validation.bundle.backtestCompleted ? `Backtest · ${validation.bundle.backtestStatus}` : validation.bundle.publicationStatus !== 'READBACK_VERIFIED' ? 'MISSING_EVIDENCE · 영구 결과 재조회 미확인' : 'NOT_EVALUABLE · 동일 후보의 OOS/WF/Holdout 평가 증거 부족'}</p>
              <button className={button + ' mt-3'} disabled={busy || validation.bundle.publicationStatus !== 'READBACK_VERIFIED' || !validation.bundle.backtestCompleted} onClick={readSameCandidate}>동일 후보 모의매매 근거 조회</button>
              {sameCandidate ? <ResearchSameCandidatePreview result={sameCandidate} /> : <p className="mt-2">Forward / Shadow / Paper / Settlement · NOT_PROVEN — 이 후보의 서버 증거를 조회해야 합니다.</p>}
              <p className="mt-2 text-xs">독립 표본 수: 확인 불가 · 수익성 입증 없음</p>
              <details className="mt-3">
                <summary className="min-h-11 cursor-pointer py-3 font-bold">이 후보의 식별자와 출처 자세히</summary>
                <dl className="space-y-2 break-all text-xs">
                  {Object.entries({ DSL: validation.bundle.dslDigest, Strategy: validation.bundle.strategyIdentityDigest, Bundle: validation.bundle.bundleDigest,
                    Model: validation.bundle.modelIdentityDigest, 'Feature order': validation.bundle.featureOrderDigest, Preprocessing: validation.bundle.preprocessingVersion,
                    Dataset: validation.bundle.receipt?.datasetIdentity, 'Dataset SHA-256': validation.bundle.receipt?.datasetDigest,
                    Split: validation.bundle.receipt?.splitReceiptDigest, Risk: validation.bundle.receipt?.riskPolicyId,
                    Cost: validation.bundle.receipt?.costPolicyIdentity, 'Research SHA': validation.bundle.receipt?.researchCodeSha,
                    'Request / Publication key': validation.bundle.receipt?.requestDigest, 'Result artifact SHA-256': validation.bundle.resultArtifactDigest,
                  }).map(([label, value]) => <div key={label}><dt className="font-bold">{label}</dt><dd>{value ?? 'MISSING_EVIDENCE'}</dd></div>)}
                </dl>
              </details>
            </section>
          </div> : null}
          <Link href="/backtests" className="mt-4 inline-block text-sm font-bold text-primary underline">백테스터 열기</Link>
        </section>
        <details aria-label="전략 비교" className="rounded-2xl border border-border bg-card p-4">
          <summary className="min-h-11 cursor-pointer py-2 font-bold">등록 전략</summary>
          {data.comparisons.length ? <div className="mt-3 max-w-full overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>{['전략', '시장', '방향', '주기', '비용 정책'].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead><tbody>{data.comparisons.map(row => <tr key={row.strategyId} className="border-t border-border"><td className="max-w-64 break-all p-2">{row.strategyId}</td><td className="p-2">{row.market}</td><td className="p-2">{row.direction}</td><td className="p-2">{row.timeframe}</td><td className="p-2">{row.costPolicyVersion}</td></tr>)}</tbody></table></div> : <p className="mt-2 text-sm">비교할 canonical 전략 식별자가 없습니다.</p>}
        </details>
        <details aria-label="전략 상태와 인계" className="rounded-2xl border border-border bg-card p-4">
          <summary className="min-h-11 cursor-pointer py-2 font-bold">운영 진단</summary>
          <p className="mt-2 break-all text-xs">원본 기준 시각: {data.timestamp == null ? '미확인' : new Date(data.timestamp).toISOString()}</p>
          <ul className="mt-3 list-disc space-y-2 break-all pl-5 text-xs">{data.health.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
          <p className="mt-3 text-sm">{data.next_action}</p>
          <Link href="/strategy-promotion" className="mt-3 inline-block text-sm font-bold text-primary underline">승격 근거 조회</Link>
        </details>
      </> : null}
    </div><BottomNav />
  </main>;
}
