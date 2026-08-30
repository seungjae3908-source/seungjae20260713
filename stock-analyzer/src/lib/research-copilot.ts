import { authorizedFetch } from './auth-fetch';
import type { CopilotSnapshot, CopilotReview, CopilotTask, DslValidation } from '../../../api-server/src/services/research-copilot.contract';
import type { ResearchBundleResolution } from '../../../api-server/src/services/research-bundle.contract';
export type { CopilotSnapshot, CopilotReview, CopilotTask, DslValidation };
export type { ResearchBundleResolution };

function validBundle(value: unknown): boolean {
  const b = record(value);
  return b.schemaVersion === 'research-bundle-resolution-v1' && b.executionAuthority === 'NONE' &&
    b.promotionEligible === false && b.profitabilityProven === false && b.champion === null && b.evidenceCredit === 0 &&
    b.statisticalFirewallPass === false && b.statisticalFirewallStatus === 'MISSING_EVIDENCE' &&
    b.wfEvidencePresent === false && b.oosEvidencePresent === false && b.holdoutEvidencePresent === false &&
    b.wfStatus === 'NOT_EVALUATED' && b.oosStatus === 'NOT_EVALUATED' && ['LOCKED', 'NOT_EVALUATED'].includes(String(b.holdoutStatus)) &&
    ['NOT_SUBMITTED', 'BLOCKED_DATA', 'RUNNING', 'COMPLETED', 'FAILED'].includes(String(b.backtestStatus)) &&
    ['MISSING_EVIDENCE', 'BLOCKED_DATA', 'READBACK_VERIFIED'].includes(String(b.publicationStatus)) &&
    (b.resultArtifactDigest === null || typeof b.resultArtifactDigest === 'string' && /^[a-f0-9]{64}$/.test(b.resultArtifactDigest)) &&
    (b.receipt === null || validReceipt(b)) &&
    (b.publicationStatus !== 'READBACK_VERIFIED' || b.backtestCompleted === true && b.backtestStatus === 'COMPLETED' && b.resultArtifactDigest !== null && validReceipt(b)) &&
    ['dslValid', 'researchBundleReady', 'backtestExecutable', 'backtestSubmitted', 'backtestCompleted'].every(k => typeof b[k] === 'boolean') &&
    (!b.backtestExecutable || b.researchBundleReady === true && b.dslValid === true && typeof b.bundleDigest === 'string' && typeof b.strategyIdentityDigest === 'string') &&
    count(b.backtesterCalls) && strings(b.blockers) && Array.isArray(b.components) && b.components.every(c =>
      fields(c, ['key', 'status']) && ['READY', 'MISSING_EVIDENCE', 'BLOCKED_DATA'].includes(String(record(c).status)) && strings(record(c).blockers));
}
function validReceipt(bundle: Record<string, unknown>): boolean {
  const r = record(bundle.receipt);
  return r.bundleDigest === bundle.bundleDigest && r.strategyIdentityDigest === bundle.strategyIdentityDigest && r.dslDigest === bundle.dslDigest &&
    ['requestDigest', 'strategyIdentityDigest', 'dslDigest', 'bundleDigest', 'datasetDigest', 'splitReceiptDigest'].every(k => typeof r[k] === 'string' && /^[a-f0-9]{64}$/.test(String(r[k]))) &&
    fields(r, ['datasetIdentity', 'riskPolicyId', 'riskPolicyVersion', 'costPolicyIdentity', 'researchCodeSha']) &&
    /^[a-f0-9]{40}$/.test(String(r.researchCodeSha)) && typeof r.submittedAt === 'number' && Number.isSafeInteger(r.submittedAt) && r.submittedAt > 0 && r.submittedAt <= 8.64e15;
}
export function readResearchBacktest(dsl: unknown, bundle: ResearchBundleResolution, signal?: AbortSignal): Promise<ResearchBundleResolution> {
  return request('/read-backtest', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dsl, bundleDigest: bundle.bundleDigest, strategyIdentityDigest: bundle.strategyIdentityDigest, resultArtifactDigest: bundle.resultArtifactDigest }) },
  value => validBundle(value) && (record(value).publicationStatus !== 'READBACK_VERIFIED' ||
    record(value).bundleDigest === bundle.bundleDigest && record(value).strategyIdentityDigest === bundle.strategyIdentityDigest && record(value).dslDigest === bundle.dslDigest &&
    (bundle.resultArtifactDigest === null || record(value).resultArtifactDigest === bundle.resultArtifactDigest)));
}
export function submitResearchBacktest(dsl: unknown, bundle: ResearchBundleResolution, signal?: AbortSignal): Promise<ResearchBundleResolution> {
  return request('/submit-backtest', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dsl, bundleDigest: bundle.bundleDigest, strategyIdentityDigest: bundle.strategyIdentityDigest }) },
    value => validBundle(value) && (!record(value).backtestCompleted || validReceipt(record(value)) && record(value).bundleDigest === bundle.bundleDigest && record(value).strategyIdentityDigest === bundle.strategyIdentityDigest));
}

async function request<T>(path: string, init: RequestInit, validate: (value: unknown) => boolean): Promise<T> {
  const response = await authorizedFetch('/api/admin/research/copilot' + path, init);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('관리자 권한이 필요합니다.');
    if (response.status === 409) throw new Error('증거가 변경되었습니다. 새로고침 후 다시 검토하세요.');
    if (response.status === 429) throw new Error('검토 한도에 도달했습니다. 잠시 후 다시 요청하세요.');
    throw new Error('연구 기능을 사용할 수 없습니다. 데이터 또는 무료 공급자 상태를 확인하세요.');
  }
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new Error('연구 응답 계약을 확인할 수 없습니다.'); }
  if (!validate(body)) throw new Error('연구 응답 계약을 확인할 수 없습니다.');
  return body as T;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}
function fields(value: unknown, names: string[]): boolean {
  const row = record(value);
  return names.every(name => typeof row[name] === 'string');
}
function count(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function safe(value: unknown): boolean {
  const authority = record(record(value).authority);
  return authority.executionAuthority === 'NONE' && authority.orderAllowed === false && authority.numericPerformanceAuthority === false &&
    authority.promotionAuthority === false && authority.championAuthority === false && authority.leverageAuthority === false &&
    authority.finalHoldoutOpened === false && authority.paidFallback === false;
}
export function fetchCopilotSnapshot(signal?: AbortSignal): Promise<CopilotSnapshot> {
  return request('', { signal }, value => {
    const row = record(value);
    return safe(row) && row.schemaVersion === 'research-copilot-v1' && Array.isArray(row.stages) &&
      row.stages.every(stage => fields(stage, ['key', 'label', 'status', 'reason']) && ['READY', 'BLOCKED_DATA', 'MISSING_EVIDENCE'].includes(String(record(stage).status)) && count(record(stage).verifiedReceiptCount) && Array.isArray(record(stage).observedTasks) &&
        (record(stage).observedTasks as unknown[]).every(task => fields(task, ['id', 'status']))) &&
      Array.isArray(row.comparisons) && row.comparisons.every(item => fields(item, ['strategyId', 'market', 'direction', 'timeframe', 'costPolicyVersion'])) &&
      strings(row.missing_data) && strings(row.data_sources) && strings(record(row.health).reasons) && fields(row.health, ['status', 'source']) &&
      (row.timestamp === null || typeof row.timestamp === 'number' && Number.isFinite(row.timestamp) && Math.abs(row.timestamp) <= 8.64e15) &&
      fields(row, ['status', 'freshness', 'evidenceDigest', 'next_action']) && /^[a-f0-9]{64}$/.test(String(row.evidenceDigest)) &&
      fields(row.ai, ['reason']) && typeof record(row.ai).available === 'boolean' && count(record(row.ai).calls) && count(record(row.ai).cacheHits);
  });
}
export function reviewCopilot(task: CopilotTask, evidenceDigest: string, signal?: AbortSignal): Promise<CopilotReview> {
  return request('/review', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task, evidenceDigest }) }, value => {
    const row = record(value);
    const review = record(row.review);
    return safe(row) && row.evidenceDigest === evidenceDigest && row.task === task && typeof review.summary === 'string' &&
      row.confidence === null && row.signal === null && row.risk_reward === null && row.entry_zone === null && row.stop_loss === null &&
      row.invalidation === null && Array.isArray(row.targets) && row.targets.length === 0 && row.approval_required === false &&
      fields(review, ['provider', 'model']) && strings(review.findings) && strings(row.missing_data) &&
      Array.isArray(review.hypotheses) && review.hypotheses.every(hypothesis => fields(hypothesis, ['hypothesisId', 'thesis', 'falsification']) && strings(record(hypothesis).requiredEvidence));
  });
}
export function validateResearchDsl(dsl: unknown, signal?: AbortSignal): Promise<DslValidation> {
  return request('/validate-dsl', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dsl) },
    value => safe(value) && record(value).validator === 'createSafeStrategyDslV1' && record(value).evaluationStatus === 'NOT_EVALUATED' &&
      record(value).profitabilityProven === false && record(record(value).backtest).submitted === false && strings(record(record(value).backtest).missing_data) &&
      validBundle(record(value).bundle));
}
