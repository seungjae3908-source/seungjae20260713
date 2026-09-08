import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { BottomNav } from './bottom-nav';
import { useAuth } from '@/lib/auth';
import { fetchCopilotSnapshot, reviewCopilot, validateResearchDsl, submitResearchBacktest, readResearchBacktest, type CopilotReview, type CopilotTask, type DslValidation } from '@/lib/research-copilot';

const ACTIONS: Array<[CopilotTask, string]> = [
  ['propose_candidates', '후보 가설 제안'], ['interpret_evidence', '검증 증거 해석'],
  ['compare_strategies', '비교 시 필요한 증거'], ['explain_health', 'Health 부족 증거 설명'],
];
const button = 'min-h-11 rounded-xl border border-border px-4 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50';
const bundleLabels: Record<string, string> = { strategy: 'Strategy Identity', model: 'Model Identity', feature: 'Feature Identity', dataset: 'Dataset', split: 'Frozen Split',
  risk: 'Risk Policy', fullCost: 'Full Cost (8 components)', oos: 'OOS Horizon', wf: 'Walk-forward Policy', holdout: 'Final Holdout' };

export function ResearchCopilotPanel() {
  const { profile, isAdmin } = useAuth();
  const snapshot = useQuery({ queryKey: ['admin', profile?.id, 'research-copilot'], queryFn: ({ signal }) => fetchCopilotSnapshot(signal), enabled: isAdmin && Boolean(profile?.id), staleTime: 30_000, retry: false });
  const [review, setReview] = useState<CopilotReview | null>(null);
  const [dsl, setDsl] = useState('');
  const [validation, setValidation] = useState<DslValidation | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const artifactPin = useRef<string | null>(null);
  // React Query retains cached data on refetch failure. It must not look like current evidence.
  const data = snapshot.isError ? undefined : snapshot.data;
  useEffect(() => () => { sequence.current += 1; pending.current?.abort(); }, []);
  useEffect(() => { sequence.current += 1; pending.current?.abort(); artifactPin.current = null; setReview(null); setValidation(null); setBusy(false); }, [profile?.id]);
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
    void run(async signal => {
      const result = await submitResearchBacktest(JSON.parse(dsl), bundle, signal);
      if (!signal.aborted) { artifactPin.current = result.resultArtifactDigest; setValidation(previous => previous ? { ...previous, bundle: result } : null); }
    });
  }
  function readBacktest() {
    const bundle = validation?.bundle;
    if (!bundle?.researchBundleReady || busy) return;
    void run(async signal => {
      const result = await readResearchBacktest(JSON.parse(dsl), { ...bundle, resultArtifactDigest: artifactPin.current ?? bundle.resultArtifactDigest }, signal);
      if (!signal.aborted) {
        if (result.publicationStatus === 'READBACK_VERIFIED') artifactPin.current = result.resultArtifactDigest;
        setValidation(previous => previous ? { ...previous, bundle: result } : null);
      }
    });
  }
  return <main className="h-full overflow-y-auto bg-background pb-28" data-testid="research-copilot">
    <div className="mx-auto max-w-7xl space-y-5 p-4 sm:p-6">
      <header className="rounded-2xl border border-border bg-card p-5">
        <p className="text-xs font-bold text-primary">RESEARCH ONLY · 실행 권한 없음</p>
        <h1 className="mt-2 text-2xl font-black">AI Research Copilot</h1>
        <p className="mt-3 text-sm leading-6 text-foreground/80">AI는 가설과 연구 절차를 설명합니다. 수익률·EV·PF·MDD·비용·확률·레버리지·Promotion·Champion은 AI가 계산하거나 결정하지 않습니다.</p>
      </header>
      {snapshot.isPending ? <p role="status">canonical 연구 증거를 불러오는 중…</p> : null}
      {snapshot.isError ? <div role="alert" className="rounded-xl border border-destructive p-4"><p>{snapshot.error.message}</p><button className={button} onClick={() => void snapshot.refetch()}>다시 조회</button></div> : null}
      {data ? <>
        <section aria-label="연구 근거와 AI 한도" className="rounded-2xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-bold">현재 증거 · {data.status}</h2><button className={button} disabled={busy || snapshot.isFetching} onClick={() => void snapshot.refetch()}>증거 새로고침</button></div>
          <p className="mt-2 text-sm">원본 기준 시각: {data.timestamp === null ? '미수집' : new Date(data.timestamp).toISOString()} · {data.freshness}</p>
          <p className="mt-2 break-all text-xs text-muted-foreground">출처: {data.data_sources.join(' / ')} · SHA-256: {data.evidenceDigest}</p>
          <p className="mt-2 text-sm">AI 요청 {data.ai.calls}회 · 캐시 적중 {data.ai.cacheHits}회 · 토큰 사용량/무료 잔여 한도: 미확인</p>
          <p className="mt-2 text-sm">{data.ai.available ? '명시 요청에만 AI를 호출합니다.' : `AI 사용 불가: ${data.ai.reason}`}</p>
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
          <p className="mt-3 text-sm">신뢰 확률·성과 수치: 미생성. 후보 가설은 검증된 전략이 아닙니다.</p>
        </section> : null}
        <section aria-label="연구 단계" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <p className="text-sm sm:col-span-2 lg:col-span-3">전체 등록 전략의 단계별 조회 현황입니다. 서로 다른 전략의 receipt 수를 합쳐 한 후보의 검증 완료로 판단하지 않습니다.</p>
          {data.stages.map(stage => <article key={stage.key} className="min-w-0 rounded-2xl border border-border bg-card p-4">
            <h2 className="font-bold">{stage.label}</h2><p className="mt-2 text-xs font-bold text-amber-600">{stage.status}</p>
            <p className="mt-2 text-xs">검증 receipt를 조회할 수 있는 전략: {stage.verifiedReceiptCount}개</p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{stage.reason}</p>
            {stage.observedTasks.map((task, i) => <p key={i} className="mt-2 break-all text-xs">관측 작업 {task.id}: {task.status} (검증 PASS 아님)</p>)}
          </article>)}
        </section>
        <section aria-label="DSL 검증" className="rounded-2xl border border-border bg-card p-4">
          <h2 className="font-bold">canonical DSL / Formula 검증</h2>
          <p className="mt-2 text-sm text-muted-foreground">기존 createSafeStrategyDslV1 검증기를 사용합니다. DSL 통과는 백테스트·수익성 통과가 아닙니다. AI가 만든 가설을 실행 코드로 변환하지 않습니다.</p>
          <label htmlFor="research-dsl" className="mt-4 block text-sm font-bold">연구 DSL JSON</label>
          <textarea id="research-dsl" value={dsl} disabled={busy} maxLength={32_001} onChange={event => { artifactPin.current = null; setDsl(event.target.value); setValidation(null); }} rows={6} className="mt-2 w-full rounded-xl border border-border bg-background p-3 font-mono text-xs" spellCheck={false} />
          <button className={button + ' mt-3'} disabled={busy || !dsl.trim()} onClick={validate}>DSL 검증</button>
          {validation ? <div role="status" className="mt-3 break-all text-sm"><p>{validation.status === 'ready' ? 'DSL 유효 · 전략 미평가' : 'DSL 차단: 지원 범위·필드·연산자·깊이를 확인하세요.'}</p>
            {validation.candidateId ? <p className="mt-2">{validation.candidateId}</p> : null}
            {!validation.bundle ? <p className="mt-2">Bundle 응답 없음 · 실행 차단</p> : null}
          </div> : null}
          {validation?.bundle ? <div aria-label="Backtest Bundle" className="mt-4 space-y-3 break-words text-sm [overflow-wrap:anywhere]">
            <p className="font-bold">Backtest Bundle · {validation.bundle.backtestStatus}</p>
            <p>DSL_VALID={String(validation.bundle.dslValid)} · RESEARCH_BUNDLE_READY={String(validation.bundle.researchBundleReady)} · BACKTEST_EXECUTABLE={String(validation.bundle.backtestExecutable)}</p>
            <div className="grid gap-2 sm:grid-cols-2">{validation.bundle.components.map(component => <div key={component.key} className="min-w-0 rounded-xl border border-border p-3">
              <p className="font-bold">{bundleLabels[component.key] ?? component.key} · {component.status}</p>
              <ul className="mt-2 space-y-1 break-all text-xs">{component.blockers.map(reason => <li key={reason}>{reason}</li>)}</ul>
            </div>)}</div>
            <p className="break-all text-xs">{validation.bundle.blockers.join(' · ')}</p>
            <p>WF: {validation.bundle.wfStatus} · OOS: {validation.bundle.oosStatus} · Holdout: {validation.bundle.holdoutStatus}</p>
            <p>통계 방화벽: {validation.bundle.statisticalFirewallStatus} · Promotion: 불가 · Champion: 없음</p>
            <p>이 요청의 백테스터 호출: {validation.bundle.backtesterCalls}회. 역사 백테스트 완료는 WF/OOS/Holdout 통과가 아닙니다.</p>
            <p>결과 보존·재조회: {validation.bundle.publicationStatus}. READBACK_VERIFIED는 동일 artifact의 재조회 확인이며 전략 성과 통과가 아닙니다.</p>
            <button className={button} disabled={busy || !validation.bundle.backtestExecutable || validation.bundle.backtestSubmitted} onClick={submitBacktest}>검증된 Bundle로 연구 백테스트 제출</button>
            <button className={button + ' ml-0 sm:ml-2'} disabled={busy || !validation.bundle.researchBundleReady} onClick={readBacktest}>저장된 연구 결과 재조회</button>
            <section aria-label="선택 후보의 증거 연결" className="rounded-xl border border-border p-3">
              <h3 className="font-bold">이 후보의 다음 단절 지점</h3>
              <p className="mt-2">{!validation.bundle.researchBundleReady ? 'BLOCKED_DATA · 실행 가능한 canonical Bundle 부족' : !validation.bundle.backtestCompleted ? `Backtest · ${validation.bundle.backtestStatus}` : validation.bundle.publicationStatus !== 'READBACK_VERIFIED' ? 'MISSING_EVIDENCE · 영구 결과 재조회 미확인' : 'NOT_EVALUABLE · 동일 후보의 OOS/WF/Holdout 평가 증거 부족'}</p>
              <p className="mt-2">Shadow · MISSING_EVIDENCE / Forward · MISSING_EVIDENCE</p>
              <p className="mt-2">Feature·Model identity는 아래 계약 검증과 별개로 Shadow/Forward의 실제 소비가 필요합니다. Trial·Observation 연결과 genuine 독립 표본 수: 확인 불가. 전체 운영 집계를 이 후보의 표본으로 사용하지 않습니다.</p>
              <p className="mt-2">Full Cost / Health / Promotion 판정: NOT_EVALUABLE. 수익성 입증 없음 · 검증 Champion 없음.</p>
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
          <Link href="/backtests" className="mt-4 inline-block text-sm font-bold text-primary underline">기존 백테스터 열기 (조건을 별도로 입력)</Link>
        </section>
        <section aria-label="전략 비교" className="rounded-2xl border border-border bg-card p-4">
          <h2 className="font-bold">전략 식별자 비교 · 성과 순위 없음</h2>
          <p className="mt-2 text-sm">같은 시장·기간·분할·비용 정책의 검증된 지표가 있어야 성과를 비교할 수 있습니다.</p>
          {data.comparisons.length ? <div className="mt-3 max-w-full overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>{['전략', '시장', '방향', '주기', '비용 정책'].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead><tbody>{data.comparisons.map(row => <tr key={row.strategyId} className="border-t border-border"><td className="max-w-64 break-all p-2">{row.strategyId}</td><td className="p-2">{row.market}</td><td className="p-2">{row.direction}</td><td className="p-2">{row.timeframe}</td><td className="p-2">{row.costPolicyVersion}</td></tr>)}</tbody></table></div> : <p className="mt-2 text-sm">비교할 canonical 전략 식별자가 없습니다.</p>}
        </section>
        <section aria-label="전략 상태와 인계" className="rounded-2xl border border-border bg-card p-4">
          <h2 className="font-bold">전체 연구 운영 Health: {data.health.status}</h2>
          <p className="mt-2 text-sm">서로 다른 전략과 작업을 포함한 운영 요약입니다. 위 DSL 후보의 Strategy Health 판정은 아닙니다.</p>
          <ul className="mt-3 list-disc space-y-2 break-all pl-5 text-xs">{data.health.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
          <p className="mt-3 text-sm">{data.next_action}</p>
          <p className="mt-2 text-sm">Shadow/Forward는 이 화면에서 활성화하지 않습니다. Holdout 열람·승격·Champion 지정·주문 실행은 모두 차단됩니다.</p>
          <Link href="/strategy-promotion" className="mt-3 inline-block text-sm font-bold text-primary underline">canonical 승격 증거 조회</Link>
        </section>
      </> : null}
    </div><BottomNav />
  </main>;
}
