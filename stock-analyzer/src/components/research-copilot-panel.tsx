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
  ['compare_strategies', '비교 시 필요한 증거'], ['explain_health', '전략 상태 부족 이유'],
];
const button = 'min-h-11 rounded-xl border border-border px-4 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50';
const bundleLabels: Record<string, string> = {
  strategy: '전략 식별', model: '모델 식별', feature: '특징 식별', dataset: '데이터셋', split: '고정 분할',
  risk: '위험 정책', fullCost: '전체 비용 8항목', oos: '미래 검증 기간', wf: '순차 검증 정책', holdout: '최종 독립 검증',
};

function evidenceStatusLabel(value: string | null | undefined) {
  const status = String(value ?? '').toUpperCase();
  if (['COMPLETED', 'PASS', 'PRESENT', 'READY', 'READBACK_VERIFIED'].includes(status)) return '완료';
  if (['BLOCKED_DATA', 'MISSING_EVIDENCE', 'MISSING', 'NOT_EVALUABLE'].includes(status)) return '자료 부족';
  if (['FAILED', 'FAIL', 'INVALID', 'BLOCKED'].includes(status)) return '차단';
  if (['PENDING', 'QUEUED', 'RUNNING', 'COLLECTING'].includes(status)) return '진행 중';
  return status ? '검증 필요' : '미확인';
}

function marketLabel(value: string) {
  return ({ KR_STOCK: '국내주식', US_STOCK: '미국주식', CRYPTO_SPOT: '코인현물', CRYPTO_FUTURES: '코인선물' } as Record<string, string>)[value] ?? '기타';
}

function directionLabel(value: string) {
  return ({ BUY: '매수', LONG: '롱', SHORT: '숏' } as Record<string, string>)[value] ?? '확인 필요';
}

function yesNo(value: boolean) { return value ? '예' : '아니오'; }

function copilotStatusLabel(status: string) {
  if (status === 'needs_context') return '추가 근거 필요';
  if (status === 'ready') return '사용 가능';
  if (status === 'blocked') return '차단됨';
  return status;
}

function aiReasonLabel(reason: string | null | undefined) {
  if (!reason) return '사용 가능';
  if (reason === 'FREE_TIER_NOT_CONFIRMED') return 'AI 제공자 무료 사용 가능 여부 미확인';
  if (reason === 'PROVIDER_NOT_CONFIGURED') return 'AI 제공자 연결 필요';
  return 'AI 사용 조건 확인 필요';
}

export function ResearchCopilotPanel() {
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
      if (dsl.length > 32_000) throw new Error('수식은 32,000자 이내여야 합니다.');
      let value: unknown;
      try { value = JSON.parse(dsl); } catch { throw new Error('올바른 수식 형식을 입력하세요. 실행 코드는 허용하지 않습니다.'); }
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
    <div className="mx-auto max-w-7xl space-y-5 p-4 sm:p-6">
      <header className="rounded-2xl border border-border bg-card p-5">
        <p className="text-xs font-bold text-primary">연구 전용 · 실행 권한 없음</p>
        <h1 className="mt-2 text-2xl font-black">인공지능 연구 도우미</h1>
        <p className="mt-1 text-xs font-bold text-muted-foreground"></p>
        <p className="mt-3 text-sm leading-6 text-foreground/80">가설과 검증 절차를 설명합니다. 수익성·승격·실거래는 결정하지 않습니다.</p>
      </header>
      {snapshot.isPending ? <p role="status">연구 자료를 불러오는 중…</p> : null}
      {snapshot.isError ? <div role="alert" className="rounded-xl border border-destructive p-4"><p>{snapshot.error.message}</p><button className={button} onClick={() => void snapshot.refetch()}>다시 조회</button></div> : null}
      {data ? <>
        <section aria-label="연구 자료와 인공지능 한도" className="rounded-2xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-bold text-muted-foreground">현재 증거</p><h2 className="mt-1 font-bold">{copilotStatusLabel(data.status)}</h2></div><button className={button} disabled={busy || snapshot.isFetching} onClick={() => void snapshot.refetch()}>증거 새로고침</button></div>
          <p className="mt-2 text-sm">원본 기준 시각: {data.timestamp === null ? '미수집' : new Date(data.timestamp).toISOString()} · {data.freshness}</p>
          <p className="mt-2 break-all text-xs text-muted-foreground">출처: {data.data_sources.join(' / ')} · SHA-256: {data.evidenceDigest}</p>
          <p className="mt-2 text-sm">인공지능 요청 {data.ai.calls}회 · 캐시 적중 {data.ai.cacheHits}회 · 토큰 사용량/무료 잔여 한도: 미확인</p>
          <p className="mt-2 text-sm">{data.ai.available ? '명시 요청에만 인공지능을 호출합니다.' : aiReasonLabel(data.ai.reason)}</p>{!data.ai.available ? <div className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-sm"><p className="font-black">왜 버튼을 누를 수 없나요?</p><p className="mt-1 break-keep text-muted-foreground">현재 인공지능 사용 조건이 확인되지 않아 요청 기능을 꺼두었습니다.</p><details className="mt-2 text-xs"><summary className="cursor-pointer font-bold">기술 상태 코드 보기</summary><p className="mt-2 break-all font-mono text-muted-foreground">{data.ai.reason}</p></details></div> : null}
          <div className="mt-4 flex flex-wrap gap-2">{ACTIONS.map(([task, label]) => <button key={task} className={button} disabled={busy || snapshot.isError || snapshot.isFetching || !data.ai.available} onClick={() => ask(task)}>{label}</button>)}</div>
        </section>
        {busy ? <p role="status">연구 요청을 검증하는 중…</p> : null}
        {error ? <p role="alert" className="rounded-xl border border-destructive p-4">{error}</p> : null}
        {visibleReview?.review ? <section aria-label="인공지능 연구 제안" className="rounded-2xl border border-primary/40 bg-card p-4">
          <h2 className="font-bold">검증 전 제안 · {visibleReview.review.provider} / {visibleReview.review.model}</h2>
          <p className="mt-2 text-sm">{visibleReview.review.summary}</p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">{visibleReview.review.findings.map((finding, i) => <li key={i}>{finding}</li>)}</ul>
          {visibleReview.review.hypotheses.map((hypothesis, i) => <article key={i} className="mt-4 rounded-xl border border-border p-3">
            <h3 className="font-bold">{hypothesis.hypothesisId}</h3><p className="mt-2 text-sm">{hypothesis.thesis}</p>
            <p className="mt-2 text-sm">반증 조건: {hypothesis.falsification}</p><p className="mt-2 text-sm">필요 증거: {hypothesis.requiredEvidence.join(' · ')}</p>
          </article>)}
          <p className="mt-3 text-sm">신뢰 확률·성과 수치: 미생성. 후보 가설은 검증된 전략이 아닙니다.</p>
        </section> : null}
        <section aria-label="연구 단계" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <p className="text-sm sm:col-span-2 lg:col-span-3">전체 전략의 검증 진행상태입니다. 서로 다른 전략의 결과를 합치지 않습니다.</p>
          {data.stages.map(stage => <article key={stage.key} className="min-w-0 rounded-2xl border border-border bg-card p-4">
            <h2 className="font-bold">{stage.label}</h2><p className="mt-2 text-sm font-black text-amber-600">{copilotStatusLabel(stage.status)}</p>
            <p className="mt-2 text-xs">검증 자료가 있는 전략: {stage.verifiedReceiptCount}개</p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{stage.reason}</p>
            {stage.observedTasks.map((task, i) => <p key={i} className="mt-2 break-all text-xs">관측 작업 {i + 1}: {evidenceStatusLabel(task.status)}</p>)}
          </article>)}
        </section>
        <section aria-label="수식 검증" className="rounded-2xl border border-border bg-card p-4">
          <h2 className="font-bold">안전 수식 검증</h2>
          <p className="mt-2 text-sm text-muted-foreground">지원된 수식만 검사합니다. 수식 통과가 수익성 통과를 뜻하지 않습니다.</p>
          <label htmlFor="research-dsl" className="mt-4 block text-sm font-bold">연구 수식 입력</label>
          <textarea id="research-dsl" value={dsl} disabled={busy} maxLength={32_001} onChange={event => { artifactPin.current = null; setDsl(event.target.value); setValidation(null); setSameCandidate(null); }} rows={6} className="mt-2 w-full rounded-xl border border-border bg-background p-3 font-mono text-xs" spellCheck={false} />
          <button className={button + ' mt-3'} disabled={busy || !dsl.trim()} onClick={validate}>수식 검증</button>
          {validation ? <div role="status" className="mt-3 break-all text-sm"><p>{validation.status === 'ready' ? '수식 유효 · 전략 미평가' : '수식 차단: 지원 범위를 확인하세요.'}</p>
            {validation.candidateId ? <p className="mt-2">{validation.candidateId}</p> : null}
            {!validation.bundle ? <p className="mt-2">백테스트 자료 없음 · 실행 차단</p> : null}
          </div> : null}
          {validation?.bundle ? <div aria-label="백테스트 묶음" className="mt-4 space-y-3 break-words text-sm [overflow-wrap:anywhere]">
            <p className="font-bold">백테스트 묶음 · {evidenceStatusLabel(validation.bundle.backtestStatus)}</p>
            <p>수식 유효 {yesNo(validation.bundle.dslValid)} · 연구자료 준비 {yesNo(validation.bundle.researchBundleReady)} · 실행 가능 {yesNo(validation.bundle.backtestExecutable)}</p>
            <div className="grid gap-2 sm:grid-cols-2">{validation.bundle.components.map(component => <div key={component.key} className="min-w-0 rounded-xl border border-border p-3">
              <p className="font-bold">{bundleLabels[component.key] ?? '검증 항목'} · {evidenceStatusLabel(component.status)}</p>
              {component.blockers.length ? <p className="mt-2 text-xs">필요 자료 {component.blockers.length}건</p> : null}
            </div>)}</div>
            {validation.bundle.blockers.length ? <p className="text-xs">추가로 필요한 자료 {validation.bundle.blockers.length}건</p> : null}
            <p>순차 검증 {evidenceStatusLabel(validation.bundle.wfStatus)} · 미래 검증 {evidenceStatusLabel(validation.bundle.oosStatus)} · 최종 독립 검증 {evidenceStatusLabel(validation.bundle.holdoutStatus)}</p>
            <p>통계 검증 {evidenceStatusLabel(validation.bundle.statisticalFirewallStatus)} · 승격 불가 · 최종 전략 없음</p>
            <p>백테스트 실행 {validation.bundle.backtesterCalls}회</p>
            <p>결과 보존 상태: {evidenceStatusLabel(validation.bundle.publicationStatus)}</p>
            <button className={button} disabled={busy || !validation.bundle.backtestExecutable || validation.bundle.backtestSubmitted} onClick={submitBacktest}>검증된 묶음으로 백테스트 실행</button>
            <button className={button + ' ml-0 sm:ml-2'} disabled={busy || !validation.bundle.researchBundleReady} onClick={readBacktest}>저장된 결과 확인</button>
            <section aria-label="선택 후보의 증거 연결" className="rounded-xl border border-border p-3">
              <h3 className="font-bold">이 후보의 다음 단계</h3>
              <p className="mt-2">{!validation.bundle.researchBundleReady ? '백테스트 자료 부족' : !validation.bundle.backtestCompleted ? `백테스트 · ${evidenceStatusLabel(validation.bundle.backtestStatus)}` : validation.bundle.publicationStatus !== 'READBACK_VERIFIED' ? '저장 결과 확인 필요' : '같은 후보의 미래 검증 자료 부족'}</p>
              <button className={button + ' mt-3'} disabled={busy || validation.bundle.publicationStatus !== 'READBACK_VERIFIED' || !validation.bundle.backtestCompleted} onClick={readSameCandidate}>같은 후보의 미래검증·모의매매 자료 확인</button>
              {sameCandidate ? <ResearchSameCandidatePreview result={sameCandidate} /> : <p className="mt-2">미래검증·모의매매 자료가 더 필요합니다.</p>}
              <p className="mt-2">특징·모델 식별과 독립 표본은 실제 미래검증 자료로 확인합니다.</p>
              <p className="mt-2">전체 비용·전략 상태·승격은 아직 검증 중입니다.</p>
              <details className="mt-3">
                <summary className="min-h-11 cursor-pointer py-3 font-bold">식별자와 출처</summary>
                <dl className="space-y-2 break-all text-xs">
                  {Object.entries({
                    '수식': validation.bundle.dslDigest, '전략': validation.bundle.strategyIdentityDigest, '묶음': validation.bundle.bundleDigest,
                    '모델': validation.bundle.modelIdentityDigest, '특징 순서': validation.bundle.featureOrderDigest, '전처리': validation.bundle.preprocessingVersion,
                    '데이터셋': validation.bundle.receipt?.datasetIdentity, '데이터 지문': validation.bundle.receipt?.datasetDigest,
                    '분할': validation.bundle.receipt?.splitReceiptDigest, '위험 정책': validation.bundle.receipt?.riskPolicyId,
                    '비용 정책': validation.bundle.receipt?.costPolicyIdentity, '연구 버전': validation.bundle.receipt?.researchCodeSha,
                    '요청 식별': validation.bundle.receipt?.requestDigest, '결과 지문': validation.bundle.resultArtifactDigest,
                  }).map(([label, value]) => <div key={label}><dt className="font-bold">{label}</dt><dd>{value ?? '자료 없음'}</dd></div>)}
                </dl>
              </details>
            </section>
          </div> : null}
          <Link href="/backtests" className="mt-4 inline-block text-sm font-bold text-primary underline">백테스터 열기</Link>
        </section>
        <section aria-label="전략 비교" className="rounded-2xl border border-border bg-card p-4">
          <h2 className="font-bold">전략 식별자 비교 · 성과 순위 없음</h2>
          <p className="mt-2 text-sm">같은 시장·기간·분할·비용 정책의 검증된 지표가 있어야 성과를 비교할 수 있습니다.</p>
          {data.comparisons.length ? <div className="mt-3 max-w-full overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>{['전략', '시장', '방향', '주기', '비용 정책'].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead><tbody>{data.comparisons.map(row => <tr key={row.strategyId} className="border-t border-border"><td className="max-w-64 break-all p-2">{row.strategyId}</td><td className="p-2">{marketLabel(row.market)}</td><td className="p-2">{directionLabel(row.direction)}</td><td className="p-2">{row.timeframe}</td><td className="p-2">{row.costPolicyVersion}</td></tr>)}</tbody></table></div> : <p className="mt-2 text-sm">비교할 전략이 없습니다.</p>}
        </section>
        <section aria-label="전략 상태와 인계" className="rounded-2xl border border-border bg-card p-4">
          <h2 className="font-bold">전체 연구 상태: {evidenceStatusLabel(data.health.status)}</h2>
          <p className="mt-2 text-sm">전체 연구 운영 상태입니다.</p>
          <ul className="mt-3 list-disc space-y-2 break-all pl-5 text-xs">{data.health.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
          <p className="mt-3 text-sm">필요한 자료가 쌓이면 다음 검증 단계로 자동 갱신됩니다.</p>
          <p className="mt-2 text-sm">이 화면에서는 미래검증 활성화·승격·실주문을 실행하지 않습니다.</p>
          <Link href="/strategy-promotion" className="mt-3 inline-block text-sm font-bold text-primary underline">승격 검증 보기</Link>
        </section>
      </> : null}
    </div><BottomNav />
  </main>;
}
