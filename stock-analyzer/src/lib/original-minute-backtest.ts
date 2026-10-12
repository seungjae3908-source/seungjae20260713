import {
  normalizeOriginalMinuteBacktestRequestV1,
  ORIGINAL_MINUTE_BACKTEST_SAFETY_V1,
  resolveOriginalMinuteBacktestPresetV1,
  type OriginalMinuteBacktestRequestV1,
  type OriginalMinuteBacktestRunV1,
  type OriginalMinuteMarketV1,
  type OriginalMinutePresetV1,
  type OriginalMinuteTimeframeV1,
} from '../../../packages/strategy-hypothesis/src/original-minute-backtest.js';

export type { OriginalMinuteBacktestRequestV1, OriginalMinuteBacktestRunV1 };
export const ORIGINAL_MINUTE_COST_FIELDS = [
  ['entryFeeRate', '진입 수수료'], ['exitFeeRate', '청산 수수료'],
  ['spreadRate', '스프레드'], ['slippageRate', '슬리피지'], ['taxRate', '세금'],
  ['latencyRate', '지연 비용'], ['fundingRatePerSession', '거래별 펀딩 모델'],
] as const;
type CostField = (typeof ORIGINAL_MINUTE_COST_FIELDS)[number][0];
export type OriginalMinuteFormValues = {
  market: OriginalMinuteMarketV1; symbol: string; startDate: string; endDate: string;
  timeframe: OriginalMinuteTimeframeV1; direction: 'LONG' | 'SHORT';
  fast: string; slow: string; stopPercent: string; targetPercent: string;
  initialCapitalKRW: string; leverage: string; riskPercent: string; fxRateKRWPerQuote: string;
  costPercent: Record<CostField, string>;
};

export function createOriginalMinuteForm(nowMs = Date.now()): OriginalMinuteFormValues {
  const endDate = new Date(nowMs - 86_400_000).toISOString().slice(0, 10);
  return {
    market: 'CRYPTO_SPOT', symbol: 'KRW-BTC',
    ...resolveOriginalMinuteBacktestPresetV1('1m', endDate),
    timeframe: '5m', direction: 'LONG', fast: '4', slow: '12', stopPercent: '1', targetPercent: '2',
    initialCapitalKRW: '1000000', leverage: '1', riskPercent: '1', fxRateKRWPerQuote: '1',
    costPercent: Object.fromEntries(ORIGINAL_MINUTE_COST_FIELDS.map(([key]) => [key, '0'])) as Record<CostField, string>,
  };
}

export function changeOriginalMinuteMarket(values: OriginalMinuteFormValues, market: OriginalMinuteMarketV1): OriginalMinuteFormValues {
  const futures = market === 'CRYPTO_FUTURES';
  const krw = market === 'KR_STOCK' || market === 'CRYPTO_SPOT';
  return {
    ...values, market,
    symbol: { KR_STOCK: '005930', US_STOCK: 'AAPL', CRYPTO_SPOT: 'KRW-BTC', CRYPTO_FUTURES: 'BTCUSDT' }[market],
    direction: futures ? values.direction : 'LONG', leverage: futures ? values.leverage : '1',
    fxRateKRWPerQuote: krw ? '1' : '',
    timeframe: (market === 'KR_STOCK' || market === 'US_STOCK') && values.timeframe === '1d' ? '5m' : values.timeframe,
    costPercent: { ...values.costPercent, fundingRatePerSession: futures ? values.costPercent.fundingRatePerSession : '0' },
  };
}

export function applyOriginalMinutePreset(values: OriginalMinuteFormValues, preset: OriginalMinutePresetV1): OriginalMinuteFormValues {
  return { ...values, ...resolveOriginalMinuteBacktestPresetV1(preset, values.endDate) };
}

export class OriginalMinuteClientError extends Error {
  code: string;
  constructor(code: string) { super(code); this.name = 'OriginalMinuteClientError'; this.code = code; }
}
const fail = (code = 'ORIGINAL_MINUTE_RESPONSE_INVALID'): never => { throw new OriginalMinuteClientError(code); };
const numericInput = (value: string): number => {
  if (!value.trim() || !/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value)) return fail('ORIGINAL_MINUTE_NUMBER_INPUT_REQUIRED');
  return Number(value);
};

/** Percent inputs are explicit model assumptions, never observed broker costs. */
export function normalizeOriginalMinuteForm(values: OriginalMinuteFormValues, nowMs = Date.now()): OriginalMinuteBacktestRequestV1 {
  const costModel = Object.fromEntries(ORIGINAL_MINUTE_COST_FIELDS.map(([key]) => [key, numericInput(values.costPercent[key]) / 100]));
  return normalizeOriginalMinuteBacktestRequestV1({
    market: values.market, symbol: values.symbol.trim().normalize('NFC'), startDate: values.startDate, endDate: values.endDate,
    timeframe: values.timeframe, direction: values.direction,
    strategy: { kind: 'EMA_TREND', fast: numericInput(values.fast), slow: numericInput(values.slow),
      stopPercent: numericInput(values.stopPercent), targetPercent: numericInput(values.targetPercent) },
    initialCapitalKRW: numericInput(values.initialCapitalKRW), leverage: numericInput(values.leverage),
    riskFraction: numericInput(values.riskPercent) / 100, fxRateKRWPerQuote: numericInput(values.fxRateKRWPerQuote), costModel,
  }, { nowMs });
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const count = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value >= 0;
const nullableCount = (value: unknown) => value === null || count(value);
const timestamp = (value: unknown): value is number => count(value) && value > 0 && value <= 8_640_000_000_000_000;
const nullableTimestamp = (value: unknown) => value === null || timestamp(value);
const code = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_:-]{0,159}$/u.test(value);
const nullableCode = (value: unknown) => value === null || code(value);
const codes = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 100 && value.every(code);
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const digest = (value: unknown) => value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value));
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
const activeStatuses = new Set(['RUNNING', 'CANCELLING']);
const statuses = new Set(['RUNNING', 'CANCELLING', 'COMPLETED', 'BLOCKED_DATA', 'CANCELLED', 'TIMED_OUT', 'FAILED']);
export const isOriginalMinuteRunActive = (run: OriginalMinuteBacktestRunV1 | null) => run !== null && activeStatuses.has(run.status);

/** Gate the full selection and evidence contract before any response is rendered. */
export function validateOriginalMinuteRun(
  raw: unknown, expectedSelection: OriginalMinuteBacktestRequestV1, expectedRunId?: string,
): OriginalMinuteBacktestRunV1 {
  if (!object(raw) || raw.schemaVersion !== 'original-minute-backtest-run-v1' || !uuid(raw.runId)
    || (expectedRunId !== undefined && raw.runId !== expectedRunId)) return fail();
  for (const [key, value] of Object.entries(ORIGINAL_MINUTE_BACKTEST_SAFETY_V1)) if (raw[key] !== value) return fail('ORIGINAL_MINUTE_SAFETY_CONTRACT_INVALID');
  let selection: OriginalMinuteBacktestRequestV1;
  try { selection = normalizeOriginalMinuteBacktestRequestV1(raw.selection); }
  catch { return fail('ORIGINAL_MINUTE_SELECTION_MISMATCH'); }
  if (JSON.stringify(selection) !== JSON.stringify(normalizeOriginalMinuteBacktestRequestV1(expectedSelection))) return fail('ORIGINAL_MINUTE_SELECTION_MISMATCH');
  if (typeof raw.status !== 'string' || !statuses.has(raw.status) || !nullableCode(raw.reason) || !codes(raw.blockers)
    || !timestamp(raw.createdAtMs) || !nullableTimestamp(raw.finishedAtMs)
    || (raw.finishedAtMs !== null && (raw.finishedAtMs as number) < raw.createdAtMs)
    || (activeStatuses.has(raw.status) ? raw.finishedAtMs !== null : raw.finishedAtMs === null)) return fail();
  if (!object(raw.source) || !object(raw.coverage)) return fail();
  const source = raw.source;
  const coverage = raw.coverage;
  if (![null, 'CURRENT_PROVIDER_ROSTER_SOURCE_ONLY', 'HISTORICAL_PIT_ROSTER'].includes(source.evidenceScope as null)
    || !digest(source.currentRosterDigestSha256) || !nullableTimestamp(source.currentRosterObservedAtMs)
    || typeof source.historicalPITRosterChecked !== 'boolean' || !digest(source.sourceSessionIndexDigestSha256)
    || !digest(source.sourceModelDigestSha256) || !nullableCode(source.sourceClass)
    || !(source.fixtureOnly === null || typeof source.fixtureOnly === 'boolean')
    || !nullableCount(coverage.indexedPrivateSessions) || !nullableCount(coverage.verifiedNativeMinuteSessions)
    || !nullableCount(coverage.missingSourceDays) || !nullableCount(coverage.missingExpectedStockSessions) || !Array.isArray(coverage.blockedDatesPreview)
    || coverage.blockedDatesPreview.length > 100 || !coverage.blockedDatesPreview.every(date)
    || !(coverage.blockedDate === null || date(coverage.blockedDate))) return fail();
  if (source.historicalPITRosterChecked && source.evidenceScope !== 'HISTORICAL_PIT_ROSTER') return fail();
  if (raw.status !== 'COMPLETED') {
    if (raw.report !== null) return fail();
  } else {
    const report = raw.report;
    if (!object(report) || report.kind !== 'PERIOD' || report.status !== 'SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY'
      || report.selectedStartDate !== selection.startDate || report.selectedEndDate !== selection.endDate
      || report.symbol !== selection.symbol || report.timeframe !== selection.timeframe || report.direction !== selection.direction
      || report.sessionClosePolicy !== 'CLOSE_EACH_SOURCE_SESSION') return fail();
    for (const key of ['sourceSessionsVerified', 'modeledTradeCount', 'modeledWins', 'modeledLosses']) if (!count(report[key])) return fail();
    if ((report.sourceSessionsVerified as number) < 1 || (report.modeledWins as number) + (report.modeledLosses as number) > (report.modeledTradeCount as number)) return fail();
    for (const key of ['modeledReturnPercent', 'modeledNetPnlKRW', 'modeledCostKRW', 'modeledMaxDrawdownPercent', 'modeledEndingCapitalKRW', 'modeledProfitReserveKRW']) if (!finite(report[key])) return fail();
    if ((report.modeledCostKRW as number) < 0 || (report.modeledMaxDrawdownPercent as number) < 0) return fail();
    for (const key of ['independentOOSProven', 'independentFullCostProven', 'originalHistoricalSignalVerified', 'profitabilityProven', 'paperCandidatePASS']) if (report[key] !== false) return fail('ORIGINAL_MINUTE_SAFETY_CONTRACT_INVALID');
    if (report.actualFillCount !== null || report.executionAuthority !== 'NONE') return fail('ORIGINAL_MINUTE_SAFETY_CONTRACT_INVALID');
    if (!Array.isArray(report.horizonReturns) || report.horizonReturns.length !== 9) return fail();
    const horizons = [1, 7, 30, 90, 180, 365, 1095, 1825, 3650];
    for (let index = 0; index < horizons.length; index += 1) {
      const row = report.horizonReturns[index];
      if (!object(row) || row.horizonDays !== horizons[index] || !date(row.requiredStartDate) || !nullableCode(row.reason)) return fail();
      const requiredStart = new Date(Date.parse(`${selection.endDate}T00:00:00.000Z`) - (horizons[index] - 1) * 86_400_000).toISOString().slice(0, 10);
      if (row.requiredStartDate !== requiredStart) return fail();
      if (row.status === 'BLOCKED_DATA') { if (row.modeledReturnPercent !== null || !code(row.reason)) return fail(); }
      else if (row.status === 'MODELED_SOURCE_ONLY') {
        if (!finite(row.modeledReturnPercent) || row.reason !== null || requiredStart < selection.startDate) return fail();
      } else return fail();
    }
    const review = report.canonicalPaperResearchReview;
    if (!object(review) || review.status !== 'RESEARCH_HOLD' || review.paperAdmissionAllowed !== false || review.executionAuthority !== 'NONE'
      || !codes(review.blockers) || !count(review.blockerCount) || review.blockerCount !== review.blockers.length
      || !code(review.canonicalProfitabilityStatus) || !code(review.canonicalPaperBridgeStatus) || !codes(review.canonicalPaperBridgeBlockers)) return fail();
  }
  // Only these typed, validated fields are used by the panel. No raw response body is displayed.
  return { ...ORIGINAL_MINUTE_BACKTEST_SAFETY_V1, schemaVersion: 'original-minute-backtest-run-v1',
    runId: raw.runId, selection, status: raw.status, reason: raw.reason, createdAtMs: raw.createdAtMs,
    finishedAtMs: raw.finishedAtMs, report: raw.report, blockers: raw.blockers,
    source: { evidenceScope: source.evidenceScope, currentRosterDigestSha256: source.currentRosterDigestSha256,
      currentRosterObservedAtMs: source.currentRosterObservedAtMs, historicalPITRosterChecked: source.historicalPITRosterChecked,
      sourceSessionIndexDigestSha256: source.sourceSessionIndexDigestSha256, sourceModelDigestSha256: source.sourceModelDigestSha256,
      sourceClass: source.sourceClass, fixtureOnly: source.fixtureOnly },
    coverage: { indexedPrivateSessions: coverage.indexedPrivateSessions, verifiedNativeMinuteSessions: coverage.verifiedNativeMinuteSessions,
      missingSourceDays: coverage.missingSourceDays, missingExpectedStockSessions: coverage.missingExpectedStockSessions,
      blockedDatesPreview: coverage.blockedDatesPreview, blockedDate: coverage.blockedDate },
  } as OriginalMinuteBacktestRunV1;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type OriginalMinuteClient = {
  start(selection: OriginalMinuteBacktestRequestV1, signal?: AbortSignal): Promise<OriginalMinuteBacktestRunV1>;
  get(runId: string, selection: OriginalMinuteBacktestRequestV1, signal?: AbortSignal): Promise<OriginalMinuteBacktestRunV1>;
  cancel(runId: string, selection: OriginalMinuteBacktestRequestV1, signal?: AbortSignal): Promise<OriginalMinuteBacktestRunV1>;
};
async function authenticatedFetch(input: RequestInfo | URL, init?: RequestInit) {
  const { authorizedFetch } = await import('./auth-fetch');
  return authorizedFetch(input, init);
}
const API_ROOT = '/api/backtests/original-minute/runs';
const MAX_RESPONSE_BYTES = 256 * 1024;
async function readRunJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel(); return fail();
  }
  const reader = response.body?.getReader();
  if (!reader) return fail();
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', onAbort, { once: true });
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); return fail(); }
      chunks.push(value);
    }
  } finally { signal.removeEventListener('abort', onAbort); reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return fail(); }
}

export function createOriginalMinuteClient(fetchImpl: Fetcher = authenticatedFetch, { timeoutMs = 15_000 }: { timeoutMs?: number } = {}): OriginalMinuteClient {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) return fail('ORIGINAL_MINUTE_TIMEOUT_INVALID');
  async function request(method: 'POST' | 'GET' | 'DELETE', selection: OriginalMinuteBacktestRequestV1, runId?: string, signal?: AbortSignal) {
    const normalized = normalizeOriginalMinuteBacktestRequestV1(selection);
    if (runId !== undefined && !uuid(runId)) return fail('ORIGINAL_MINUTE_RUN_ID_INVALID');
    const abort = new AbortController();
    const onAbort = () => abort.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => abort.abort(new OriginalMinuteClientError('ORIGINAL_MINUTE_REQUEST_TIMED_OUT')), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(runId ? `${API_ROOT}/${runId}` : API_ROOT, {
          method, signal: abort.signal, redirect: 'error', credentials: 'same-origin', cache: 'no-store',
          headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
          ...(method === 'POST' ? { body: JSON.stringify(normalized) } : {}),
        });
      } catch (error) {
        if (abort.signal.aborted) throw abort.signal.reason;
        return fail('ORIGINAL_MINUTE_NETWORK_UNAVAILABLE');
      }
      if (!(method === 'POST' ? response.status === 202 : method === 'GET' ? response.status === 200 : [200, 202].includes(response.status))) {
        await response.body?.cancel();
        return fail(({ 400: 'ORIGINAL_MINUTE_REQUEST_REJECTED', 401: 'ORIGINAL_MINUTE_LOGIN_REQUIRED', 403: 'ORIGINAL_MINUTE_ADMIN_REQUIRED',
          404: 'ORIGINAL_MINUTE_RUN_NOT_FOUND', 409: 'ORIGINAL_MINUTE_RUN_BUSY', 413: 'ORIGINAL_MINUTE_REQUEST_TOO_LARGE',
          429: 'ORIGINAL_MINUTE_RUN_BUSY', 503: 'ORIGINAL_MINUTE_SERVICE_UNAVAILABLE' } as Record<number, string>)[response.status] ?? 'ORIGINAL_MINUTE_SERVICE_ERROR');
      }
      if (response.redirected || !(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
        await response.body?.cancel(); return fail();
      }
      return validateOriginalMinuteRun(await readRunJson(response, abort.signal), normalized, runId);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }
  return {
    start: (selection, signal) => request('POST', selection, undefined, signal),
    get: (runId, selection, signal) => request('GET', selection, runId, signal),
    cancel: (runId, selection, signal) => request('DELETE', selection, runId, signal),
  };
}

export type OriginalMinuteRunState = Readonly<{
  run: OriginalMinuteBacktestRunV1 | null; submitting: boolean; cancelling: boolean; errorCode: string | null;
}>;
export const EMPTY_ORIGINAL_MINUTE_RUN: OriginalMinuteRunState = { run: null, submitting: false, cancelling: false, errorCode: null };
const errorCode = (error: unknown) => error instanceof OriginalMinuteClientError ? error.code
  : error instanceof TypeError && code(error.message) ? error.message : 'ORIGINAL_MINUTE_REQUEST_FAILED';
export const originalMinuteErrorCode = errorCode;

/** A manual POST starts each run. Timers only read that run; stale results cannot reappear. */
export function createOriginalMinuteRunController({ client, onChange, pollMs = 1500,
  schedule = (fn: () => void, ms: number) => setTimeout(fn, ms), unschedule = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
}: { client: OriginalMinuteClient; onChange: (state: OriginalMinuteRunState) => void; pollMs?: number;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; unschedule?: (timer: ReturnType<typeof setTimeout>) => void }) {
  type Context = { selection: OriginalMinuteBacktestRequestV1; run: OriginalMinuteBacktestRunV1 | null;
    discarded: boolean; cancelRequested: boolean; sequence: number; abort: AbortController | null;
    timer: ReturnType<typeof setTimeout> | null; reading: boolean };
  let context: Context | null = null;
  let state = EMPTY_ORIGINAL_MINUTE_RUN;
  let disposed = false;
  const emit = (next: OriginalMinuteRunState) => { state = next; if (!disposed) onChange(next); };
  const current = (ctx: Context) => !disposed && context === ctx && !ctx.discarded;
  const clearTimer = (ctx: Context) => { if (ctx.timer !== null) unschedule(ctx.timer); ctx.timer = null; };
  const planPoll = (ctx: Context) => { clearTimer(ctx); if (current(ctx) && isOriginalMinuteRunActive(ctx.run)) ctx.timer = schedule(() => { void poll(ctx); }, pollMs); };
  const accept = (ctx: Context, run: OriginalMinuteBacktestRunV1) => {
    ctx.run = run; emit({ run, submitting: false, cancelling: run.status === 'CANCELLING', errorCode: null }); planPoll(ctx);
  };
  async function poll(ctx: Context) {
    if (!current(ctx) || !ctx.run || ctx.reading) return;
    clearTimer(ctx); const sequence = ++ctx.sequence; ctx.reading = true;
    const abort = new AbortController(); ctx.abort = abort;
    try {
      const run = await client.get(ctx.run.runId, ctx.selection, abort.signal);
      if (current(ctx) && sequence === ctx.sequence) accept(ctx, run);
    } catch (error) {
      if (current(ctx) && sequence === ctx.sequence) emit({ ...state, errorCode: errorCode(error) });
    } finally { if (sequence === ctx.sequence) { ctx.reading = false; ctx.abort = null; } }
  }
  async function cancelKnown(ctx: Context) {
    if (!ctx.run) return;
    clearTimer(ctx); ctx.abort?.abort(); const sequence = ++ctx.sequence; ctx.reading = true;
    const abort = new AbortController(); ctx.abort = abort;
    if (current(ctx)) emit({ ...state, submitting: false, cancelling: true, errorCode: null });
    try {
      const run = await client.cancel(ctx.run.runId, ctx.selection, abort.signal);
      if (current(ctx) && sequence === ctx.sequence) accept(ctx, run);
    } catch (error) {
      if (current(ctx) && sequence === ctx.sequence) emit({ ...state, cancelling: false, errorCode: errorCode(error) });
    } finally { if (sequence === ctx.sequence) { ctx.reading = false; ctx.abort = null; } }
  }
  function reset() {
    const old = context; context = null;
    if (old) {
      old.discarded = true; old.cancelRequested = true; clearTimer(old);
      if (old.run) { old.abort?.abort(); if (isOriginalMinuteRunActive(old.run)) void cancelKnown(old); }
      // A POST already sent is allowed to return its ID so even a late acceptance can be cancelled.
    }
    emit(EMPTY_ORIGINAL_MINUTE_RUN);
  }
  return {
    async start(selection: OriginalMinuteBacktestRequestV1) {
      if (disposed || state.submitting || state.cancelling || isOriginalMinuteRunActive(state.run)) return;
      const normalized = normalizeOriginalMinuteBacktestRequestV1(selection);
      const ctx: Context = { selection: normalized, run: null, discarded: false, cancelRequested: false, sequence: 0, abort: null, timer: null, reading: false };
      context = ctx; emit({ run: null, submitting: true, cancelling: false, errorCode: null });
      try {
        const run = await client.start(normalized);
        ctx.run = run;
        if (ctx.cancelRequested || !current(ctx)) { if (isOriginalMinuteRunActive(run)) await cancelKnown(ctx); else if (current(ctx)) accept(ctx, run); }
        else accept(ctx, run);
      } catch (error) { if (current(ctx)) emit({ run: null, submitting: false, cancelling: false, errorCode: errorCode(error) }); }
    },
    async cancel() {
      const ctx = context;
      if (!ctx || (!state.submitting && !isOriginalMinuteRunActive(ctx.run))) return;
      ctx.cancelRequested = true;
      if (ctx.run) await cancelKnown(ctx);
      else emit({ ...state, cancelling: true, errorCode: null });
    },
    async refresh() { if (context) await poll(context); },
    reset,
    dispose() { disposed = true; reset(); },
  };
}
