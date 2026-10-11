import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { authorizedFetch } from '@/lib/auth-fetch';

type Market = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
type Selection = {
  market: Market; startDate: string; endDate: string;
  cursorDate: string | null;
};
type DailyReadiness = {
  date: string; status: string; originalMinuteRows: number | null;
  missingSourceSessions: number | null; historicalMemberCount: number | null;
  historicalScannerAsOfEvidenceVerified?: false;
};
type Report = {
  status: string; reason: string | null;
  inspectedStartDate: string; inspectedEndDate: string;
  nextCursorDate: string | null;
  expectedHistoricalTradingDays: number | null;
  missingSourceDays: number | null; partialSourceDays: number | null;
  locallyCompleteMinuteSourceDays: number | null;
  retrospectiveMinuteRows: number | null; sourceMinuteRows: number | null;
  dailyReadiness?: DailyReadiness[];
  originalScannerAsOfEvidenceVerified: false;
  fullMarketOpportunityDenominatorVerified: false;
  profitabilityProven: false;
  executionAuthority: 'NONE';
};
type Response = {
  schemaVersion: 'research-pit-minute-coverage-readonly-v1';
  available: boolean; status: string; reason: string | null;
  report: Report | null;
  executionAuthority: 'NONE'; profitabilityProven: false;
};
const MARKET_LABEL: Record<Market, string> = {
  KR_STOCK: '국내주식', US_STOCK: '미국주식',
  CRYPTO_SPOT: '코인현물', CRYPTO_FUTURES: '코인선물',
};
const displayNumber = (n: number | null | undefined) =>
  n == null ? '미확인' : n.toLocaleString('ko-KR');
function localDay(deltaDays = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + deltaDays);
  const digits = (value: number) => String(value).padStart(2, '0');
  return String(date.getFullYear()) + '-' + digits(date.getMonth() + 1)
    + '-' + digits(date.getDate());
}
function validResponse(value: unknown): value is Response {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Partial<Response>;
  return r.schemaVersion === 'research-pit-minute-coverage-readonly-v1'
    && typeof r.available === 'boolean'
    && r.executionAuthority === 'NONE'
    && r.profitabilityProven === false
    && (r.report == null || (
      typeof r.report === 'object'
      && r.report.executionAuthority === 'NONE'
      && r.report.profitabilityProven === false
      && r.report.fullMarketOpportunityDenominatorVerified === false
      && (r.report.dailyReadiness == null || (
        Array.isArray(r.report.dailyReadiness)
        && r.report.dailyReadiness.length <= 31))));
}
async function fetchCoverage(selection: Selection, signal?: AbortSignal): Promise<Response> {
  const query = new URLSearchParams({
    market: selection.market,
    startDate: selection.startDate,
    endDate: selection.endDate,
    chunkDays: '7',
  });
  if (selection.cursorDate) query.set('cursorDate', selection.cursorDate);
  const response = await authorizedFetch(
    '/api/research/video/evidence/workspace/pit-minute-coverage?' + query,
    { method: 'GET', headers: { Accept: 'application/json' }, signal },
  );
  if (response.status === 401 || response.status === 403)
    throw new Error('관리자 권한이 필요한 자료입니다.');
  if (!response.ok) throw new Error(
    response.status === 400 ? '시장·날짜 범위를 다시 확인해 주세요.'
      : '원본 자료를 안전하게 검증하지 못했습니다.',
  );
  const data: unknown = await response.json();
  if (!validResponse(data)) throw new Error('검증되지 않은 응답은 표시하지 않습니다.');
  return data;
}
/** Read-only research view. Does not submit strategies, backtests or orders. */
export function ResearchPITMinuteCoveragePanel() {
  const [market, setMarket] = useState<Market>('CRYPTO_SPOT');
  const [startDate, setStartDate] = useState(() => localDay(-7));
  const [endDate, setEndDate] = useState(() => localDay(-1));
  const [request, setRequest] = useState<Selection | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['research-pit-minute-coverage', request],
    enabled: request !== null,
    queryFn: ({ signal }) => fetchCoverage(request!, signal),
    staleTime: 0,
    // Source coverage belongs to the CURRENT authenticated admin session.
    // Don't keep a readable admin cache after this panel unmounts.
    gcTime: 0,
    retry: false,
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!startDate || !endDate || startDate > endDate) {
      setInputError('조회 시작일과 종료일을 확인해 주세요.');
      return;
    }
    setInputError(null);
    // React Query structurally hashes selection keys. Repeating the exact
    // same form would otherwise reuse a stale key without checking permission.
    if (request?.market === market && request.startDate === startDate
      && request.endDate === endDate && request.cursorDate === null) {
      void query.refetch();
      return;
    }
    setRequest({ market, startDate, endDate, cursorDate: null });
  }
  // TanStack Query may retain a prior success result after a refetch fails
  // with 401/403. Never display previously authorized private source totals
  // during revalidation or after an error.
  const response = query.isSuccess && !query.isFetching ? query.data : null;
  const report = response?.available === true ? response.report : null;
  const next = report?.nextCursorDate;
  return (
    <section className="rounded-3xl border border-card-border bg-card p-4 sm:p-5" data-testid="research-pit-minute-coverage">
      <h2 className="text-base font-black">4시장 과거 1분봉 원본 보유 현황</h2>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        선택한 기간의 PIT 종목·원본 보유량·누락일만 조회합니다. 이 수치는 과거 매매 신호나 수익률을 증명하지 않습니다.
      </p>
      <form className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" onSubmit={submit}>
        <label className="text-xs font-semibold">
          시장
          <select className="mt-1 min-h-11 w-full rounded-lg border border-card-border bg-background px-2"
            aria-label="과거 데이터 시장" value={market}
            onChange={e => setMarket(e.target.value as Market)}>
            {(Object.keys(MARKET_LABEL) as Market[]).map(key =>
              <option value={key} key={key}>{MARKET_LABEL[key]}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold">
          시작일
          <input type="date" aria-label="과거 데이터 시작일"
            className="mt-1 min-h-11 w-full rounded-lg border border-card-border bg-background px-2"
            value={startDate} onChange={e => setStartDate(e.target.value)} required />
        </label>
        <label className="text-xs font-semibold">
          종료일
          <input type="date" aria-label="과거 데이터 종료일"
            className="mt-1 min-h-11 w-full rounded-lg border border-card-border bg-background px-2"
            value={endDate} onChange={e => setEndDate(e.target.value)} required />
        </label>
        <button type="submit" disabled={query.isFetching}
          className="min-h-11 self-end rounded-lg bg-primary px-3 text-xs font-bold text-primary-foreground disabled:opacity-50">
          {query.isFetching ? '조회 중' : '원본 보유 현황 조회'}
        </button>
      </form>
      {inputError ? <p role="alert" className="mt-3 text-xs text-destructive">{inputError}</p> : null}
      {query.isError ? <p role="alert" className="mt-3 text-xs text-destructive">{query.error instanceof Error ? query.error.message : '조회 실패'}</p> : null}
      {!query.isFetching && response?.available === false ? (
        <p className="mt-3 rounded-lg border border-card-border p-3 text-xs">
          원본 보고서 미연결 또는 미검증 ({response.reason ?? '근거 없음'}). 데이터가 없다고 거래 기회가 0건인 것은 아닙니다.
        </p>
      ) : null}
      {report ? (
        <div className="mt-3 space-y-3" aria-live="polite">
          <p className="text-xs text-muted-foreground">
            조회 구간: {report.inspectedStartDate} ~ {report.inspectedEndDate} · 상태: {report.status}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {([
              ['요구 거래일', report.expectedHistoricalTradingDays],
              ['원본 완료일', report.locallyCompleteMinuteSourceDays],
              ['누락된 날짜', report.missingSourceDays],
              ['보관된 1분봉', report.sourceMinuteRows],
            ] as const).map(([label, value]) =>
              <div className="rounded-lg border border-card-border bg-background p-3" key={label}>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-1 text-base font-bold tabular-nums">{displayNumber(value)}</p>
              </div>)}
          </div>
          <p className="text-xs text-muted-foreground">
            부분 보관일 {displayNumber(report.partialSourceDays)} · 사후 수집 분봉 {displayNumber(report.retrospectiveMinuteRows)}
          </p>
          {report.dailyReadiness?.length ? (
            <div className="max-h-56 overflow-y-auto rounded-lg border border-card-border">
              <table className="w-full text-left text-xs">
                <thead><tr className="bg-muted/40"><th className="p-2">날짜</th><th className="p-2">상태</th><th className="p-2 text-right">1분봉</th></tr></thead>
                <tbody>{(report.dailyReadiness ?? []).map(row =>
                  <tr key={row.date} className="border-t border-card-border">
                    <td className="p-2">{row.date}</td>
                    <td className="p-2">{row.status === 'BLOCKED_DATA' ? '자료 미확인' : row.status.includes('INCOMPLETE') ? '일부 누락' : '원본 기록만 확인'}</td>
                    <td className="p-2 text-right tabular-nums">{displayNumber(row.originalMinuteRows)}</td>
                  </tr>)}</tbody>
              </table>
            </div>
          ) : null}
          {typeof next === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(next) && request ? (
            <button type="button" className="min-h-11 rounded-lg border border-card-border px-3 text-xs font-bold"
              onClick={() => setRequest({ ...request, cursorDate: next })}>
              다음 기간 조회 ({next}부터)
            </button>
          ) : null}
          <p className="text-xs font-semibold text-muted-foreground">
            READ ONLY · 실행 권한 없음 · 최초 신호 탐지·OOS·실체결·수익성 미검증
          </p>
        </div>
      ) : null}
    </section>
  );
}
