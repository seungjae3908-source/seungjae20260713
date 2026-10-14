// Read-only "rule validation" report contract for the research center.
//
// Pure module: no network, filesystem, database, exchange or order access.
// It only validates a plain JSON-shaped report so the UI never shows numbers
// that were not checked. A report can never grant execution authority or
// claim proven profitability.

export const RULE_VALIDATION_SCHEMA = 'rule-validation-report-v1';

export type RuleVerdict = 'fail' | 'insufficient_samples' | 'pass';
export type StudyStatus = 'FAIL' | 'WATCH' | 'PASS';

export interface RuleSegment {
  n: number;
  /** 0..1 */
  winRate: number | null;
  /** Net of fees and slippage, in percent. */
  expectancyPercent: number | null;
  /** Conservative bound (mean - 1 standard error), in percent. */
  lowerBoundPercent?: number | null;
  maxDrawdownPercent?: number | null;
}

export interface RuleRow {
  ruleLabel: string;
  barrierLabel: string;
  train: RuleSegment | null;
  validation: RuleSegment | null;
  test: RuleSegment | null;
  /** Test segment re-run with costs multiplied (stress). */
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
  schemaVersion: typeof RULE_VALIDATION_SCHEMA;
  generatedAt: string;
  executionAuthority: 'NONE';
  profitabilityProven: false;
  passedRuleCount: number;
  summary: string;
  studies: RuleStudy[];
}

type UnknownRecord = Record<string, unknown>;

// Same intent as the research overview sanitizer: no filesystem paths, keys or tokens.
const PRIVATE_TEXT_PATTERN = /(?:^[a-z]:[\\/]|\/(?:var|home|root|etc|opt|srv|users)\/|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ghp|github_pat|sk_live|sk_test)_[a-z0-9_-]+)/i;
const VERDICTS = new Set<string>(['fail', 'insufficient_samples', 'pass']);
const STATUSES = new Set<string>(['FAIL', 'WATCH', 'PASS']);
const MAX_STUDIES = 20;
const MAX_ROWS = 60;
const MAX_TEXT = 400;

function rec(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_TEXT || PRIVATE_TEXT_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function finiteOrNull(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function segment(value: unknown): RuleSegment | null | undefined {
  if (value === null || value === undefined) return null;
  const source = rec(value);
  if (!source) return undefined;
  if (!Number.isInteger(source.n) || (source.n as number) < 0) return undefined;
  const winRate = finiteOrNull(source.winRate);
  const expectancy = finiteOrNull(source.expectancyPercent);
  const lower = finiteOrNull(source.lowerBoundPercent);
  const drawdown = finiteOrNull(source.maxDrawdownPercent);
  if (winRate === undefined || expectancy === undefined || lower === undefined || drawdown === undefined) return undefined;
  if (winRate !== null && (winRate < 0 || winRate > 1)) return undefined;
  if (drawdown !== null && drawdown < 0) return undefined;
  return {
    n: source.n as number,
    winRate,
    expectancyPercent: expectancy,
    lowerBoundPercent: lower,
    maxDrawdownPercent: drawdown,
  };
}

function row(value: unknown): RuleRow | null {
  const source = rec(value);
  if (!source) return null;
  const ruleLabel = text(source.ruleLabel);
  const barrierLabel = text(source.barrierLabel);
  const train = segment(source.train);
  const validation = segment(source.validation);
  const test = segment(source.test);
  const stress = segment(source.stressTest);
  if (!ruleLabel || !barrierLabel || train === undefined || validation === undefined
    || test === undefined || stress === undefined) return null;
  if (typeof source.verdict !== 'string' || !VERDICTS.has(source.verdict)) return null;
  return {
    ruleLabel, barrierLabel, train, validation, test, stressTest: stress,
    verdict: source.verdict as RuleVerdict,
  };
}

function study(value: unknown): RuleStudy | null {
  const source = rec(value);
  if (!source) return null;
  const id = text(source.id);
  const label = text(source.label);
  const timeframe = text(source.timeframe);
  const periodLabel = text(source.periodLabel);
  const symbolsLabel = text(source.symbolsLabel);
  const costLabel = text(source.costLabel);
  const note = text(source.note);
  if (!id || !label || !timeframe || !periodLabel || !symbolsLabel || !costLabel || !note) return null;
  if (source.market !== 'CRYPTO_SPOT') return null;
  if (typeof source.status !== 'string' || !STATUSES.has(source.status)) return null;
  if (!Array.isArray(source.rows) || source.rows.length > MAX_ROWS) return null;
  const rows: RuleRow[] = [];
  for (const raw of source.rows) {
    const parsed = row(raw);
    if (!parsed) return null;
    rows.push(parsed);
  }
  return {
    id, label, market: 'CRYPTO_SPOT', timeframe, periodLabel, symbolsLabel, costLabel,
    status: source.status as StudyStatus, note, rows,
  };
}

/**
 * Returns a sanitized copy, or null when anything is malformed or unsafe.
 * Fail-closed: the caller shows "unavailable" instead of partial data.
 */
export function sanitizeRuleValidationReport(input: unknown): RuleValidationReport | null {
  const source = rec(input);
  if (!source || source.schemaVersion !== RULE_VALIDATION_SCHEMA) return null;
  if (source.executionAuthority !== 'NONE' || source.profitabilityProven !== false) return null;
  const generatedAt = text(source.generatedAt);
  const summary = text(source.summary);
  if (!generatedAt || !summary || !Number.isFinite(Date.parse(generatedAt))) return null;
  if (!Array.isArray(source.studies) || source.studies.length > MAX_STUDIES) return null;
  const studies: RuleStudy[] = [];
  for (const raw of source.studies) {
    const parsed = study(raw);
    if (!parsed) return null;
    studies.push(parsed);
  }
  // The headline count must be derived from the rows, never trusted from input.
  const passedRuleCount = studies.reduce(
    (sum, item) => sum + item.rows.filter((candidate) => candidate.verdict === 'pass').length, 0);
  if (source.passedRuleCount !== passedRuleCount) return null;
  return {
    schemaVersion: RULE_VALIDATION_SCHEMA,
    generatedAt,
    executionAuthority: 'NONE',
    profitabilityProven: false,
    passedRuleCount,
    summary,
    studies,
  };
}
