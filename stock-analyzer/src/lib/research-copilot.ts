import { authorizedFetch } from './auth-fetch';
import type { CopilotSnapshot, CopilotReview, CopilotTask, DslValidation } from '../../../api-server/src/services/research-copilot.contract';
export type { CopilotSnapshot, CopilotReview, CopilotTask, DslValidation };

async function request<T>(path: string, init: RequestInit, validate: (value: unknown) => boolean): Promise<T> {
  const response = await authorizedFetch('/api/admin/research/copilot' + path, init);
  const body: unknown = await response.json();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('관리자 권한이 필요합니다.');
    if (response.status === 409) throw new Error('증거가 변경되었습니다. 새로고침 후 다시 검토하세요.');
    if (response.status === 429) throw new Error('검토 한도에 도달했습니다. 잠시 후 다시 요청하세요.');
    throw new Error('연구 기능을 사용할 수 없습니다. 데이터 또는 무료 공급자 상태를 확인하세요.');
  }
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
      row.stages.every(stage => fields(stage, ['key', 'label', 'status', 'reason']) && Array.isArray(record(stage).observedTasks) &&
        (record(stage).observedTasks as unknown[]).every(task => fields(task, ['id', 'status']))) &&
      Array.isArray(row.comparisons) && row.comparisons.every(item => fields(item, ['strategyId', 'market', 'direction', 'timeframe', 'costPolicyVersion'])) &&
      strings(row.missing_data) && strings(row.data_sources) && strings(record(row.health).reasons) && fields(row.health, ['status', 'source']) &&
      (row.timestamp === null || typeof row.timestamp === 'number' && Number.isFinite(row.timestamp) && Math.abs(row.timestamp) <= 8.64e15) &&
      fields(row, ['status', 'freshness', 'evidenceDigest', 'next_action']) && fields(row.ai, ['reason']) && typeof record(row.ai).available === 'boolean';
  });
}
export function reviewCopilot(task: CopilotTask, evidenceDigest: string, signal?: AbortSignal): Promise<CopilotReview> {
  return request('/review', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task, evidenceDigest }) }, value => {
    const row = record(value);
    const review = record(row.review);
    return safe(row) && row.evidenceDigest === evidenceDigest && row.task === task && typeof review.summary === 'string' &&
      fields(review, ['provider', 'model']) && strings(review.findings) && strings(row.missing_data) &&
      Array.isArray(review.hypotheses) && review.hypotheses.every(hypothesis => fields(hypothesis, ['hypothesisId', 'thesis', 'falsification']) && strings(record(hypothesis).requiredEvidence));
  });
}
export function validateResearchDsl(dsl: unknown, signal?: AbortSignal): Promise<DslValidation> {
  return request('/validate-dsl', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dsl) },
    value => safe(value) && record(value).validator === 'createSafeStrategyDslV1' && record(value).evaluationStatus === 'NOT_EVALUATED' &&
      record(value).profitabilityProven === false && record(record(value).backtest).submitted === false && strings(record(record(value).backtest).missing_data));
}
