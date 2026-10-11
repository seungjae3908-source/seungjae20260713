import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { runFourMarketOriginalMinutePeriodV1 } from '../../../market-prediction-lab/src/four-market-original-minute-period-v1.js';
import { validateAndSanitizeOriginalMinuteDiagnosticV1 } from '../../../market-prediction-lab/src/research-original-minute-diagnostic-readonly-v1.js';
import { validatePublicNativeCryptoRosterCaptureV1 } from '../../../market-prediction-lab/src/public-native-crypto-roster-v1.js';
import { normalizeOriginalMinuteBacktestRequestV1, ORIGINAL_MINUTE_BACKTEST_SAFETY_V1,
  type OriginalMinuteBacktestRequestV1, type OriginalMinuteBacktestRunV1,
  type OriginalMinuteBacktestReportV1, type OriginalMinuteEvidenceScopeV1,
} from '../../../packages/strategy-hypothesis/src/original-minute-backtest.js';

// One manually requested, cooperative local archive replay per API process.
// No automatic strategy queue, DB writes, source collection, registry, orders,
// Paper promotion, journal or Telegram dependency belongs to this adapter.
const SCHEMA = 'original-minute-backtest-run-v1' as const;
const SHA = /^[a-f0-9]{64}$/u;
const REASON = /^[A-Z][A-Z0-9_]{0,159}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_SOURCE_FILE_BYTES = 16 * 1024 * 1024;
const DAY = 86_400_000;
const HORIZONS: readonly [string, number][] = [
  ['1d', 1], ['1w', 7], ['1m', 30], ['3m', 90], ['6m', 180],
  ['1y', 365], ['3y', 1095], ['5y', 1825], ['10y', 3650],
];
type Raw = Record<string, any>;
type Source = OriginalMinuteBacktestRunV1['source'];
type Coverage = OriginalMinuteBacktestRunV1['coverage'];
type RunStatus = OriginalMinuteBacktestRunV1['status'];
type Job = {
  owner: string; runId: string; selection: OriginalMinuteBacktestRequestV1;
  status: RunStatus; reason: string | null; createdAtMs: number; finishedAtMs: number | null;
  report: OriginalMinuteBacktestReportV1 | null; blockers: readonly string[];
  source: Source; coverage: Coverage; controller: AbortController;
  stop: 'CANCELLED' | 'TIMED_OUT' | null; timer: ReturnType<typeof setTimeout> | null;
};
export class OriginalMinuteBacktestServiceErrorV1 extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); }
}
class SourceBlocked extends Error {}
function unavailable(code: string): never { throw new SourceBlocked(code); }
function invalidResult(): never { throw new Error('ORIGINAL_MINUTE_RESULT_CONTRACT_INVALID'); }
const emptySource = (): Source => Object.freeze({ evidenceScope: null, currentRosterDigestSha256: null,
  currentRosterObservedAtMs: null, historicalPITRosterChecked: false, sourceSessionIndexDigestSha256: null,
  sourceModelDigestSha256: null, sourceClass: null, fixtureOnly: null });
const emptyCoverage = (): Coverage => Object.freeze({ indexedPrivateSessions: null, verifiedNativeMinuteSessions: null,
  missingSourceDays: null, missingExpectedStockSessions: null, blockedDatesPreview: Object.freeze([]), blockedDate: null });
const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const validDay = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(x)
  && Number.isFinite(Date.parse(x + 'T00:00:00Z')) && new Date(x + 'T00:00:00Z').toISOString().slice(0, 10) === x;
function snapshot(job: Job): OriginalMinuteBacktestRunV1 {
  return Object.freeze({ schemaVersion: SCHEMA, runId: job.runId, selection: job.selection,
    status: job.status, reason: job.reason, createdAtMs: job.createdAtMs, finishedAtMs: job.finishedAtMs,
    report: job.report, blockers: job.blockers, source: job.source, coverage: job.coverage,
    ...ORIGINAL_MINUTE_BACKTEST_SAFETY_V1 });
}
async function privateDirectory(directory: string) {
  let current = directory;
  while (true) {
    const st = await lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink() || (current === directory && (st.mode & 0o077) !== 0))
      unavailable('ORIGINAL_MINUTE_SOURCE_DIRECTORY_UNSAFE');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
async function fixedJson(file: string, missingReason: string): Promise<Raw> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o077) !== 0 || st.size < 2 || st.size > MAX_SOURCE_FILE_BYTES)
      unavailable('ORIGINAL_MINUTE_SOURCE_FILE_UNSAFE');
    // Read through the already checked descriptor; a replacement pathname is
    // never reopened after the no-follow / private-file check.
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(65_536, MAX_SOURCE_FILE_BYTES + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_SOURCE_FILE_BYTES) unavailable('ORIGINAL_MINUTE_SOURCE_FILE_UNSAFE');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable('ORIGINAL_MINUTE_SOURCE_FILE_INVALID');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') unavailable(missingReason);
    if (error instanceof SourceBlocked) throw error;
    return unavailable('ORIGINAL_MINUTE_SOURCE_FILE_INVALID');
  } finally { await handle?.close(); }
}

async function sourceContext(root: string | undefined, request: OriginalMinuteBacktestRequestV1, asOfMs: number): Promise<Raw> {
  if (!root) unavailable('ORIGINAL_MINUTE_SOURCE_ROOT_NOT_CONFIGURED');
  if (!isAbsolute(root) || resolve(root) !== root) unavailable('ORIGINAL_MINUTE_SOURCE_ROOT_INVALID');
  try { await privateDirectory(root); }
  catch (error) {
    if (error instanceof SourceBlocked) throw error;
    unavailable((error as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? 'ORIGINAL_MINUTE_SOURCE_ROOT_NOT_FOUND' : 'ORIGINAL_MINUTE_SOURCE_DIRECTORY_UNSAFE');
  }
  let context: Raw;
  let sourceClass: string;
  if (request.market === 'CRYPTO_SPOT' || request.market === 'CRYPTO_FUTURES') {
    const capture = await fixedJson(join(root, request.market + '-roster.json'), 'ORIGINAL_MINUTE_CURRENT_ROSTER_NOT_FOUND');
    const checked = validatePublicNativeCryptoRosterCaptureV1(capture, capture.roster?.rosterDigestSha256);
    if (!checked.ok || capture.roster.market !== request.market) unavailable('ORIGINAL_MINUTE_CURRENT_ROSTER_INVALID');
    if (capture.roster.observedAtMs > asOfMs) unavailable('ORIGINAL_MINUTE_CURRENT_ROSTER_NOT_AVAILABLE_AS_OF');
    if (!capture.roster.symbols.includes(request.symbol)) unavailable('ORIGINAL_MINUTE_CURRENT_ROSTER_MEMBER_NOT_FOUND');
    // The engine independently rechecks this same frozen capture and binds it
    // to exact source IDs before modeling any archived minute.
    context = { evidenceScope: 'CURRENT_PROVIDER_ROSTER_SOURCE_ONLY', currentRosterCapture: capture,
      expectedCurrentRosterDigestSha256: capture.roster.rosterDigestSha256 };
    sourceClass = 'CURRENT_PUBLIC_ROSTER';
  } else {
    const manifest = await fixedJson(join(root, request.market + '-pit-manifest.json'), 'ORIGINAL_MINUTE_HISTORICAL_PIT_MANIFEST_NOT_FOUND');
    const stockCalendar = await fixedJson(join(root, request.market + '-stock-calendar.json'), 'ORIGINAL_MINUTE_STOCK_CALENDAR_NOT_FOUND');
    if (!['TEST_FIXTURE', 'EXCHANGE_DATED_ARCHIVE', 'LICENSED_PIT_HISTORICAL_VENDOR'].includes(manifest.sourceClass))
      unavailable('ORIGINAL_MINUTE_HISTORICAL_PIT_SOURCE_CLASS_INVALID');
    context = { evidenceScope: 'HISTORICAL_PIT_ROSTER', manifest, stockCalendar };
    sourceClass = manifest.sourceClass;
  }
  const archive = join(root, 'archive');
  try { await privateDirectory(archive); }
  catch (error) {
    if (error instanceof SourceBlocked) throw error;
    unavailable((error as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? 'ORIGINAL_MINUTE_ARCHIVE_NOT_FOUND' : 'ORIGINAL_MINUTE_SOURCE_DIRECTORY_UNSAFE');
  }
  return { ...context, root: archive, sourceClass };
}

function projectCoverage(raw: Raw, request: OriginalMinuteBacktestRequestV1): Coverage {
  const dateInRange = (v: unknown): v is string => validDay(v) && v >= request.startDate && v <= request.endDate;
  if (raw.blockedDate != null && !dateInRange(raw.blockedDate)) invalidResult();
  const dates = raw.blockedDatesPreview ?? [];
  if (!Array.isArray(dates) || dates.length > 30 || dates.some(d => !dateInRange(d))) invalidResult();
  for (const key of ['indexedPrivateSessions', 'verifiedNativeMinuteSessions', 'missingSourceDays'])
    if (raw[key] != null && (!count(raw[key]) || raw[key] > 40_000)) invalidResult();
  if (raw.missingExpectedStockSessions != null && (!count(raw.missingExpectedStockSessions)
    || raw.missingExpectedStockSessions > 120_000)) invalidResult();
  return Object.freeze({ indexedPrivateSessions: raw.indexedPrivateSessions ?? null,
    verifiedNativeMinuteSessions: raw.verifiedNativeMinuteSessions ?? null,
    missingSourceDays: raw.missingSourceDays ?? null, missingExpectedStockSessions: raw.missingExpectedStockSessions ?? null,
    blockedDatesPreview: Object.freeze([...dates]),
    blockedDate: raw.blockedDate ?? null });
}
function projectReport(raw: Raw, selection: OriginalMinuteBacktestRequestV1): OriginalMinuteBacktestReportV1 | null {
  if (raw.market !== selection.market || raw.symbol !== selection.symbol || raw.selectedStartDate !== selection.startDate
    || raw.selectedEndDate !== selection.endDate) invalidResult();
  const base = validateAndSanitizeOriginalMinuteDiagnosticV1(raw, selection.market);
  if (!base) {
    if (raw.modeledTradeCount != null || raw.modeledNetPnlKRW != null) invalidResult();
    return null;
  }
  if (base.kind !== 'PERIOD' || raw.timeframe !== selection.timeframe || raw.direction !== selection.direction
    || raw.sessionClosePolicy !== 'CLOSE_EACH_SOURCE_SESSION'
    || !SHA.test(raw.sourceSessionIndexDigestSha256 ?? '') || !SHA.test(raw.sourceModelDigestSha256 ?? '')
    || !count(raw.modeledWinCount) || !count(raw.modeledLossCount)
    || raw.modeledWinCount + raw.modeledLossCount > raw.modeledTradeCount
    || !finite(raw.modeledCostKRW) || raw.modeledCostKRW < 0
    || !finite(raw.modeledMaximumDrawdownPercent) || raw.modeledMaximumDrawdownPercent < 0 || raw.modeledMaximumDrawdownPercent > 100
    || !finite(raw.paperCapitalModeledKRW) || raw.paperCapitalModeledKRW < 0
    || !finite(raw.paperReserveModeledKRW) || raw.paperReserveModeledKRW < 0
    || !base.canonicalPaperResearchReview || base.canonicalPaperResearchReview.status !== 'RESEARCH_HOLD') invalidResult();
  const totalEquity = raw.paperCapitalModeledKRW + raw.paperReserveModeledKRW;
  const expectedEquity = selection.initialCapitalKRW + raw.modeledNetPnlKRW;
  const toleranceKRW = Math.max(0.000001, selection.initialCapitalKRW * 1e-9, Math.abs(totalEquity) * 1e-9);
  const expectedReturn = 100 * raw.modeledNetPnlKRW / selection.initialCapitalKRW;
  // The existing research engine clamps an exhausted capital balance at zero;
  // it has no authenticated liquidation/debt model. Excess loss or a corrupted
  // modeled ledger must not become a contradictory completed HTTP result.
  if (!finite(totalEquity) || Math.abs(totalEquity - expectedEquity) > toleranceKRW
    || Math.abs(raw.modeledReturnPercent - expectedReturn) > Math.max(1e-8, Math.abs(expectedReturn) * 1e-9))
    unavailable('ORIGINAL_MINUTE_MODEL_EQUITY_RECONCILIATION_FAILED');
  const endExclusive = Date.parse(selection.endDate + 'T00:00:00Z') + DAY;
  const selectedDays = (endExclusive - Date.parse(selection.startDate + 'T00:00:00Z')) / DAY;
  const horizonReturns = HORIZONS.map(([key, days]) => {
    const result = raw.modeledPeriodReturns?.[key];
    const available = selectedDays >= days;
    if (!result || (available ? !finite(result.modeledReturnPercent)
      : result.modeledReturnPercent !== null || result.reason !== 'SELECTED_WINDOW_SHORTER_THAN_HORIZON')) invalidResult();
    return Object.freeze({ horizonDays: days, requiredStartDate: new Date(endExclusive - days * DAY).toISOString().slice(0, 10),
      status: available ? 'MODELED_SOURCE_ONLY' as const : 'BLOCKED_DATA' as const,
      modeledReturnPercent: available ? result.modeledReturnPercent as number : null,
      reason: available ? null : 'SELECTED_WINDOW_SHORTER_THAN_HORIZON' });
  });
  // Map only the existing engine's declared modeled metrics. Never expose raw
  // bars, source paths, whole input manifests or actual/private account fields.
  return Object.freeze({ ...base, kind: 'PERIOD', status: 'SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY',
    symbol: selection.symbol, timeframe: selection.timeframe, direction: selection.direction,
    sourceSessionsVerified: raw.verifiedNativeMinuteSessions, modeledTradeCount: raw.modeledTradeCount,
    modeledReturnPercent: raw.modeledReturnPercent, modeledNetPnlKRW: raw.modeledNetPnlKRW,
    modeledCostKRW: raw.modeledCostKRW, modeledMaxDrawdownPercent: raw.modeledMaximumDrawdownPercent,
    modeledEndingCapitalKRW: raw.paperCapitalModeledKRW, modeledProfitReserveKRW: raw.paperReserveModeledKRW,
    modeledWins: raw.modeledWinCount, modeledLosses: raw.modeledLossCount,
    sessionClosePolicy: 'CLOSE_EACH_SOURCE_SESSION', horizonReturns: Object.freeze(horizonReturns),
    canonicalPaperResearchReview: base.canonicalPaperResearchReview });
}

export type OriginalMinuteBacktestServiceOptionsV1 = {
  sourceRoot?: string; now?: () => number; runPeriod?: (input: Record<string, unknown>) => Promise<Raw>;
  maxRunMs?: number; resultTtlMs?: number; maxStoredRuns?: number;
};
export function createOriginalMinuteBacktestServiceV1(options: OriginalMinuteBacktestServiceOptionsV1 = {}) {
  const root = options.sourceRoot ?? process.env.RESEARCH_ORIGINAL_MINUTE_SOURCE_ROOT;
  const now = options.now ?? Date.now;
  const runPeriod = options.runPeriod ?? runFourMarketOriginalMinutePeriodV1;
  const maxRunMs = options.maxRunMs ?? 10 * 60_000;
  const resultTtlMs = options.resultTtlMs ?? 30 * 60_000;
  const maxStoredRuns = options.maxStoredRuns ?? 20;
  if (!Number.isSafeInteger(maxRunMs) || maxRunMs < 1 || maxRunMs > 10 * 60_000
    || !Number.isSafeInteger(resultTtlMs) || resultTtlMs < 1 || resultTtlMs > 3_600_000
    || !Number.isSafeInteger(maxStoredRuns) || maxStoredRuns < 1 || maxStoredRuns > 100)
    throw new TypeError('ORIGINAL_MINUTE_SERVICE_BUDGET_INVALID');
  const jobs = new Map<string, Job>();
  let active: Job | null = null;
  let disposed = false;
  const prune = () => {
    for (const [id, job] of jobs) if (job !== active && job.finishedAtMs !== null && now() - job.finishedAtMs >= resultTtlMs) jobs.delete(id);
  };
  const stop = (job: Job, kind: 'CANCELLED' | 'TIMED_OUT') => {
    if (job.finishedAtMs !== null || job.stop !== null) return;
    job.stop = kind; job.status = 'CANCELLING';
    job.reason = kind === 'CANCELLED' ? 'ORIGINAL_MINUTE_REPLAY_CANCELLED' : 'ORIGINAL_MINUTE_REPLAY_TIME_BUDGET_EXCEEDED';
    job.controller.abort();
  };
  const finish = (job: Job, status: RunStatus, reason: string | null) => {
    job.status = status; job.reason = reason; job.finishedAtMs = now();
    if (status !== 'COMPLETED') { job.report = null; job.blockers = Object.freeze(reason ? [reason] : []); }
  };
  async function execute(job: Job) {
    try {
      const context = await sourceContext(root, job.selection, job.createdAtMs);
      if (job.stop) return;
      const { startDate, endDate, ...selection } = job.selection;
      const result = await runPeriod({ ...selection, ...context, researchWindow: { startDate, endDate },
        asOfMs: job.createdAtMs, signal: job.controller.signal, deadlineMs: Date.now() + maxRunMs });
      if (job.stop) return;
      const report = projectReport(result, job.selection);
      job.coverage = projectCoverage(result, job.selection);
      const evidenceScope = context.evidenceScope as OriginalMinuteEvidenceScopeV1;
      const current = evidenceScope === 'CURRENT_PROVIDER_ROSTER_SOURCE_ONLY';
      if (report && (result.evidenceScope !== evidenceScope || result.sourceOnlyMode !== current
        || result.historicalPITRosterChecked !== !current
        || (current && (result.currentRosterDigestSha256 !== context.expectedCurrentRosterDigestSha256
          || result.currentRosterObservedAtMs !== context.currentRosterCapture.roster.observedAtMs)))) invalidResult();
      job.source = Object.freeze({ evidenceScope, sourceClass: context.sourceClass,
        fixtureOnly: typeof result.fixtureOnly === 'boolean' ? result.fixtureOnly : null,
        currentRosterDigestSha256: current && SHA.test(result.currentRosterDigestSha256 ?? '') ? result.currentRosterDigestSha256 : null,
        currentRosterObservedAtMs: current && count(result.currentRosterObservedAtMs) ? result.currentRosterObservedAtMs : null,
        historicalPITRosterChecked: !current && result.historicalPITRosterChecked === true,
        sourceSessionIndexDigestSha256: SHA.test(result.sourceSessionIndexDigestSha256 ?? '') ? result.sourceSessionIndexDigestSha256 : null,
        sourceModelDigestSha256: SHA.test(result.sourceModelDigestSha256 ?? '') ? result.sourceModelDigestSha256 : null });
      if (!report) {
        if (!REASON.test(result.reason ?? '')) invalidResult();
        const kind = result.reason === 'ORIGINAL_MINUTE_REPLAY_CANCELLED' ? 'CANCELLED'
          : result.reason === 'ORIGINAL_MINUTE_REPLAY_TIME_BUDGET_EXCEEDED' ? 'TIMED_OUT' : 'BLOCKED_DATA';
        finish(job, kind, result.reason);
      } else {
        job.report = report;
        job.blockers = Object.freeze([...report.canonicalPaperResearchReview.blockers]);
        finish(job, 'COMPLETED', 'RETROSPECTIVE_SOURCE_MODEL_ONLY_NOT_PROFITABILITY_PASS');
      }
    } catch (error) {
      if (!job.stop) finish(job, error instanceof SourceBlocked ? 'BLOCKED_DATA' : 'FAILED',
        error instanceof SourceBlocked ? error.message : 'ORIGINAL_MINUTE_REPLAY_FAILED');
    } finally {
      if (job.stop) finish(job, job.stop, job.reason);
      if (job.timer) clearTimeout(job.timer);
      job.timer = null;
      // Capacity is released only after the underlying execution settles.
      // A timeout response alone must not leave hidden concurrent work alive.
      if (active === job) active = null;
    }
  }
  return Object.freeze({
    async start(ownerId: string, input: unknown): Promise<OriginalMinuteBacktestRunV1> {
      if (disposed) throw new OriginalMinuteBacktestServiceErrorV1('ORIGINAL_MINUTE_SERVICE_STOPPED', 503);
      if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 128) throw new OriginalMinuteBacktestServiceErrorV1('LOGIN_REQUIRED', 401);
      const request = normalizeOriginalMinuteBacktestRequestV1(input, { nowMs: now() });
      prune();
      if (active) throw new OriginalMinuteBacktestServiceErrorV1('ORIGINAL_MINUTE_REPLAY_BUSY', 409);
      while (jobs.size >= maxStoredRuns) jobs.delete(jobs.keys().next().value!);
      const job: Job = { owner: ownerId, runId: randomUUID(), selection: request, status: 'RUNNING', reason: null,
        createdAtMs: now(), finishedAtMs: null, report: null, blockers: Object.freeze([]),
        source: emptySource(), coverage: emptyCoverage(), controller: new AbortController(), stop: null, timer: null };
      active = job; jobs.set(job.runId, job);
      job.timer = setTimeout(() => stop(job, 'TIMED_OUT'), maxRunMs);
      job.timer.unref?.();
      const initial = snapshot(job);
      void execute(job);
      return initial;
    },
    get(ownerId: string, runId: string): OriginalMinuteBacktestRunV1 | null {
      prune();
      const job = typeof runId === 'string' && UUID.test(runId) ? jobs.get(runId) : undefined;
      return job?.owner === ownerId ? snapshot(job) : null;
    },
    cancel(ownerId: string, runId: string): OriginalMinuteBacktestRunV1 | null {
      prune();
      const job = typeof runId === 'string' && UUID.test(runId) ? jobs.get(runId) : undefined;
      if (!job || job.owner !== ownerId) return null;
      stop(job, 'CANCELLED');
      return snapshot(job);
    },
    dispose() {
      disposed = true;
      if (active) stop(active, 'CANCELLED');
      jobs.clear();
    },
  });
}
export type OriginalMinuteBacktestServiceV1 = ReturnType<typeof createOriginalMinuteBacktestServiceV1>;
