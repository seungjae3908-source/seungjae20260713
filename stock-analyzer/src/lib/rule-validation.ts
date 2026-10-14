import { authorizedFetch } from '@/lib/auth-fetch';

export type RuleVerdict = 'fail' | 'insufficient_samples' | 'pass';
export type StudyStatus = 'FAIL' | 'WATCH' | 'PASS';

export interface RuleSegment {
  n: number;
  winRate: number | null;
  expectancyPercent: number | null;
  lowerBoundPercent?: number | null;
  maxDrawdownPercent?: number | null;
}

export interface RuleRow {
  ruleLabel: string;
  barrierLabel: string;
  train: RuleSegment | null;
  validation: RuleSegment | null;
  test: RuleSegment | null;
  stressTest?: RuleSegment | null;
  verdict: RuleVerdict;
}

export interface RuleStudy {
  id: string;
  label: string;
  market: 'CRYPTO_SPOT';
  timeframe: string;
  periodLabel: string;
  symbolsLabel: string;
  costLabel: string;
  status: StudyStatus;
  note: string;
  rows: RuleRow[];
}

export interface RuleValidationReport {
  schemaVersion: 'rule-validation-report-v1';
  generatedAt: string;
  executionAuthority: 'NONE';
  profitabilityProven: false;
  passedRuleCount: number;
  summary: string;
  studies: RuleStudy[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The server already validates; the client still refuses anything that claims authority or profit. */
export function isRuleValidationReport(value: unknown): value is RuleValidationReport {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 'rule-validation-report-v1'
    && value.executionAuthority === 'NONE'
    && value.profitabilityProven === false
    && typeof value.passedRuleCount === 'number'
    && typeof value.summary === 'string'
    && Array.isArray(value.studies)
    && value.studies.every((study) => isRecord(study) && Array.isArray(study.rows));
}

export async function fetchRuleValidationReport(signal?: AbortSignal): Promise<RuleValidationReport> {
  const response = await authorizedFetch('/api/research/video/evidence/workspace/rule-validation', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw new Error('규칙 검증 결과를 불러오지 못했습니다.');
  const data: unknown = await response.json();
  if (!isRuleValidationReport(data)) throw new Error('검증되지 않은 응답은 표시하지 않습니다.');
  return data;
}

export const VERDICT_LABEL: Readonly<Record<RuleVerdict, string>> = {
  fail: '불합격',
  insufficient_samples: '표본 부족(보류)',
  pass: '합격',
};

export const STUDY_STATUS_LABEL: Readonly<Record<StudyStatus, string>> = {
  FAIL: '통과 규칙 없음',
  WATCH: '관찰 중',
  PASS: '통과',
};

export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '미측정';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export function formatSegment(segment: RuleSegment | null | undefined): string {
  if (!segment) return '—';
  const win = segment.winRate == null ? '' : ` · 승률 ${(segment.winRate * 100).toFixed(0)}%`;
  return `${segment.n}건${win} · ${formatPercent(segment.expectancyPercent)}`;
}
