/**
 * Admin-only Research PIT original-minute SOURCE INVENTORY period read.
 * This never fetches prices, executes strategies, or proves opportunities.
 * Every request remains the established authenticated GET-only 31-day API.
 *
 * Historical periods are divided into bounded chunks (<=31 calendar days)
 * and read with at most three concurrent requests. No zero filling: if any
 * chunk has unknown provenance its affected totals remain null.
 */
export type PITMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
export type PITSelection = {
  market: PITMarket; startDate: string; endDate: string; cursorDate: string | null;
};
export type PITDailyReadiness = {
  date: string; status: string; originalMinuteRows: number | null;
  historicalMemberCount?: number | null; missingSourceSessions?: number | null;
  historicalScannerAsOfEvidenceVerified?: false;
};
export type PITReport = {
  status: string; reason: string | null;
  inspectedStartDate: string; inspectedEndDate: string; nextCursorDate: string | null;
  expectedHistoricalTradingDays: number | null;
  missingSourceDays: number | null; partialSourceDays: number | null;
  locallyCompleteMinuteSourceDays: number | null;
  retrospectiveMinuteRows: number | null; sourceMinuteRows: number | null;
  dailyReadiness?: PITDailyReadiness[];
  originalScannerAsOfEvidenceVerified: false;
  fullMarketOpportunityDenominatorVerified: false;
  profitabilityProven: false; executionAuthority: 'NONE';
  requestedPageCount?: number; checkedPageCount?: number;
  completeSelectionPageRead?: boolean; dailyPreviewTruncated?: boolean;
};
export type PITResponse = {
  schemaVersion: 'research-pit-minute-coverage-readonly-v1';
  available: boolean; status: string; reason: string | null;
  report?: PITReport | null; market?: PITMarket;
  executionAuthority: 'NONE'; profitabilityProven: false;
};
export type PITPageReader =
  (selection: PITSelection, signal?: AbortSignal) => Promise<unknown>;
const DAY = 86_400_000;
const MAX_DAYS = 36_600;
const CHUNK = 31;
const CONCURRENCY = 3;
const FIRST = Date.parse('1970-01-02T00:00:00Z');
const LIMIT = Date.parse('2100-01-01T00:00:00Z');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUS = /^[A-Z][A-Z0-9_]{0,119}$/;
const PAGE_STATUSES = new Set([
  'BLOCKED_DATA',
  'INCOMPLETE_OR_BLOCKED_COMPACT_PIT_MINUTE_DATE_CHUNK',
  'TEST_FIXTURE_COMPACT_SOURCE_CHUNK_ONLY',
  'SOURCE_LINEAGE_OR_SELECTED_SPAN_UNATTESTED',
  'SOURCE_ATTESTED_COMPACT_MINUTE_SOURCE_CHUNK_ONLY',
]);
const markets = new Set<PITMarket>([
  'KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES',
]);
const keys = [
  'expectedHistoricalTradingDays', 'missingSourceDays', 'partialSourceDays',
  'locallyCompleteMinuteSourceDays', 'retrospectiveMinuteRows',
  'sourceMinuteRows',
] as const;
type Counter = typeof keys[number];
function record(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}
function ms(value: unknown): number | null {
  if (typeof value !== 'string' || !DATE.test(value)) return null;
  const at = Date.parse(value + 'T00:00:00.000Z');
  return Number.isSafeInteger(at) && new Date(at).toISOString().slice(0, 10) === value
    ? at : null;
}
function iso(value: number): string { return new Date(value).toISOString().slice(0, 10); }
function countOrNull(x: unknown): boolean {
  return x === null || (Number.isSafeInteger(x) && Number(x) >= 0);
}
function optionalCount(x: unknown): boolean {
  return x === undefined || countOrNull(x);
}
function concreteCount(x: unknown): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
}
function reasonOrNull(x: unknown): boolean {
  return x == null || (typeof x === 'string' && x.length > 0 && x.length <= 200);
}

/** Reject contradictory/fabricated market claims and malformed daily rows. */
export function isValidPITCoverageResponse(value: unknown): value is PITResponse {
  if (!record(value) || value.schemaVersion !== 'research-pit-minute-coverage-readonly-v1'
    || typeof value.available !== 'boolean'
    || value.executionAuthority !== 'NONE' || value.profitabilityProven !== false
    || (value.realOrders !== undefined && value.realOrders !== false)
    || (value.liveTrading !== undefined && value.liveTrading !== false)
    || (value.autoTrading !== undefined && value.autoTrading !== false)
    || (value.providerGETCount !== undefined && value.providerGETCount !== 0)
    || (value.financialMutationCount !== undefined && value.financialMutationCount !== 0)
    || !reasonOrNull(value.reason) || typeof value.status !== 'string'
    || !STATUS.test(value.status) || !PAGE_STATUSES.has(value.status)
    || (value.market !== undefined && !markets.has(value.market as PITMarket)))
    return false;
  if (!value.available) return value.status === 'BLOCKED_DATA'
    && value.report == null && typeof value.reason === 'string';
  // A claimed source inventory must identify the market being reported.
  if (!markets.has(value.market as PITMarket)) return false;
  const r = value.report;
  if (!record(r)
    || r.executionAuthority !== 'NONE' || r.profitabilityProven !== false
    || r.fullMarketOpportunityDenominatorVerified !== false
    || r.originalScannerAsOfEvidenceVerified !== false
    || typeof r.status !== 'string' || !STATUS.test(r.status)
    || r.status !== value.status || !reasonOrNull(r.reason)
    || typeof r.inspectedStartDate !== 'string'
    || typeof r.inspectedEndDate !== 'string'
    || ms(r.inspectedStartDate) == null || ms(r.inspectedEndDate) == null
    || r.inspectedStartDate > r.inspectedEndDate
    || (r.nextCursorDate !== null && ms(r.nextCursorDate) == null)
    || keys.some(key => !optionalCount(r[key]))
    || !PAGE_STATUSES.has(r.status))
    return false;
  // Only BLOCKED_DATA may contain unknown source totals. All other pages
  // must reconcile every observed trading day to complete/partial/missing.
  if (r.status !== 'BLOCKED_DATA' && (
    keys.some(key => !concreteCount(r[key]))
    || Number(r.missingSourceDays) + Number(r.partialSourceDays)
       + Number(r.locallyCompleteMinuteSourceDays)
       !== Number(r.expectedHistoricalTradingDays)
    || Number(r.retrospectiveMinuteRows) > Number(r.sourceMinuteRows)
  )) return false;
  const rows = r.dailyReadiness;
  if (rows != null) {
    if (!Array.isArray(rows) || rows.length > CHUNK) return false;
    let previous = '';
    for (const item of rows) {
      if (!record(item) || typeof item.date !== 'string'
        || ms(item.date) == null
        || (item.date as string) <= previous
        || item.date < r.inspectedStartDate || item.date > r.inspectedEndDate
        || typeof item.status !== 'string' || !STATUS.test(item.status)
        || !countOrNull(item.originalMinuteRows)
        || !optionalCount(item.missingSourceSessions)
        || !optionalCount(item.historicalMemberCount)
        || (item.historicalScannerAsOfEvidenceVerified !== undefined
          && item.historicalScannerAsOfEvidenceVerified !== false)) return false;
      previous = item.date as string;
    }
  }
  return true;
}

export function checkedPITSelection(selection: PITSelection): {
  first: number; last: number; pages: number;
} {
  const first = ms(selection.startDate), last = ms(selection.endDate);
  if (!markets.has(selection.market) || selection.cursorDate != null
    || first == null || last == null || first < FIRST || last >= LIMIT || last < first
    || ((last - first) / DAY) + 1 > MAX_DAYS)
    throw new Error('시장·날짜 범위를 다시 확인해 주세요.');
  return { first, last, pages: Math.ceil((((last - first) / DAY) + 1) / CHUNK) };
}

/**
 * Consume ALL selected dates, not the previous single 7-day preview.
 * A failed/unauthorized chunk invalidates the whole aggregate. Never
 * silently turn an unavailable stock calendar or missing source into zero.
 */
export async function collectPITMinuteCoveragePeriod(
  selection: PITSelection, reader: PITPageReader, signal?: AbortSignal,
  progress?: (checkedPages: number, totalPages: number) => void,
): Promise<PITResponse> {
  const { first, last, pages } = checkedPITSelection(selection);
  const totals: Record<Counter, number | null> = {
    expectedHistoricalTradingDays: 0, missingSourceDays: 0,
    partialSourceDays: 0, locallyCompleteMinuteSourceDays: 0,
    retrospectiveMinuteRows: 0, sourceMinuteRows: 0,
  };
  const preview: PITDailyReadiness[] = [];
  let blocked = false, partial = false, count = 0;
  for (let chunkOffset = 0; chunkOffset < pages; chunkOffset += CONCURRENCY) {
    if (signal?.aborted) throw new Error('원본 조회가 취소됐습니다.');
    const work = Array.from({ length: Math.min(CONCURRENCY, pages - chunkOffset) }, (_, j) => {
      const position = chunkOffset + j;
      const from = first + position * CHUNK * DAY;
      const to = Math.min(last, from + (CHUNK - 1) * DAY);
      const next = to < last ? iso(to + DAY) : null;
      const request: PITSelection = {
        market: selection.market, startDate: selection.startDate,
        endDate: selection.endDate,
        cursorDate: position === 0 ? null : iso(from),
      };
      return { request, from, to, next };
    });
    const responses = await Promise.all(work.map(async task => {
      const value = await reader(task.request, signal);
      if (!isValidPITCoverageResponse(value))
        throw new Error('검증되지 않은 응답은 표시하지 않습니다.');
      if (value.available && value.market !== selection.market)
        throw new Error('조회 시장과 원본 자료의 시장이 일치하지 않습니다.');
      return { task, response: value };
    }));
    for (const { task, response } of responses) {
      if (!response.available || !response.report) {
        return {
          schemaVersion: 'research-pit-minute-coverage-readonly-v1',
          market: selection.market, available: false, status: 'BLOCKED_DATA',
          reason: response.reason ?? 'SELECTED_PERIOD_SOURCE_UNAVAILABLE',
          report: null, executionAuthority: 'NONE', profitabilityProven: false,
        };
      }
      const r = response.report;
      if (r.inspectedStartDate !== iso(task.from)
        || r.inspectedEndDate !== iso(task.to)
        || r.nextCursorDate !== task.next)
        throw new Error('조회 구간·다음 페이지 근거가 일치하지 않습니다.');
      const tradingDays = (task.to - task.from) / DAY + 1;
      if ((r.expectedHistoricalTradingDays ?? 0) > tradingDays
        || (r.missingSourceDays ?? 0) > tradingDays
        || (r.partialSourceDays ?? 0) > tradingDays
        || (r.locallyCompleteMinuteSourceDays ?? 0) > tradingDays)
        throw new Error('기간별 원본 수량이 검증되지 않았습니다.');
      blocked ||= r.status === 'BLOCKED_DATA';
      partial ||= /INCOMPLETE|UNATTESTED|FIXTURE|BLOCKED/.test(r.status);
      for (const key of keys) {
        const n = r[key];
        if (totals[key] === null || n == null) {
          totals[key] = null;
        } else {
          const sum = totals[key] + n;
          if (!Number.isSafeInteger(sum)) throw new Error('기간 합계가 허용 범위를 초과했습니다.');
          totals[key] = sum;
        }
      }
      for (const row of r.dailyReadiness ?? []) {
        if (preview.length < CHUNK) preview.push(row);
      }
      count += 1;
    }
    if (!signal?.aborted) progress?.(count, pages);
  }
  const status = blocked ? 'BLOCKED_DATA'
    : partial ? 'INCOMPLETE_OR_BLOCKED_COMPACT_PIT_MINUTE_DATE_CHUNK'
    : 'SOURCE_ATTESTED_COMPACT_MINUTE_SOURCE_CHUNK_ONLY';
  const report: PITReport = {
    status, reason: blocked ? 'STOCK_CALENDAR_OR_SOURCE_UNVERIFIED'
      : partial ? 'PARTIAL_OR_UNATTESTED_HISTORICAL_SOURCE'
      : 'SOURCE_INVENTORY_ONLY_NOT_HISTORICAL_SCANNER_EVIDENCE',
    inspectedStartDate: selection.startDate, inspectedEndDate: selection.endDate,
    nextCursorDate: null, ...totals, dailyReadiness: preview,
    originalScannerAsOfEvidenceVerified: false,
    fullMarketOpportunityDenominatorVerified: false,
    profitabilityProven: false, executionAuthority: 'NONE',
    requestedPageCount: pages, checkedPageCount: count,
    completeSelectionPageRead: count === pages, dailyPreviewTruncated: count > 1,
  };
  return {
    schemaVersion: 'research-pit-minute-coverage-readonly-v1',
    market: selection.market, available: true, status, reason: report.reason, report,
    executionAuthority: 'NONE', profitabilityProven: false,
  };
}
