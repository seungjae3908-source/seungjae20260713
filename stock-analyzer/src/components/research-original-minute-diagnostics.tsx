import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { authorizedFetch } from '@/lib/auth-fetch';

type Market = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
type DiagnosticReport = {
  kind: 'PERIOD' | 'SWEEP';
  status: string;
  selectedStartDate: string;
  selectedEndDate: string;
  symbol?: string;
  timeframe?: string | null;
  sourceSessionsVerified?: number | null;
  modeledTradeCount?: number | null;
  modeledReturnPercent?: number | null;
  modeledNetPnlKRW?: number | null;
  pageCountSelfAttested?: number;
  sourceTasksSelfAttested?: number | null;
  sourceOnlyObservedPriceEventLabels?: number;
  actualFillCount: null;
  profitabilityProven: false;
  independentOOSProven: false;
  independentFullCostProven: false;
  originalHistoricalSignalVerified: false;
  paperCandidatePASS: false;
  executionAuthority: 'NONE';
};
type Response = {
  schemaVersion: 'research-original-minute-diagnostic-readonly-v1';
  market: Market; available: boolean;
  status: string; reason: string;
  report: DiagnosticReport | null;
  readOnly: true; privateSourcePathsDisclosed: false;
  providerGETCount: 0; financialMutationCount: 0;
  fullMarketOpportunityDenominatorVerified: false;
  actualMarketWideOpportunityCount: null;
  trueMarketWideRecall: null;
  actualFillCount: null; OOSPassCount: 0;
  profitabilityProven: false; executionAuthority: 'NONE';
  paperAdmissionAllowed: false; orderSubmitted: false;
  realOrders: false;
  reportPublishedAtMs: number | null;
  publicationAgeStatus: 'UNKNOWN' | 'LOCAL_PUBLICATION_ONLY' | 'OLDER_THAN_7_DAYS';
  publicationTimeIndependentlyAttested: false;
};
const MARKET_LABEL: Record<Market, string> = {
  KR_STOCK: '국내주식', US_STOCK: '미국주식',
  CRYPTO_SPOT: '코인현물', CRYPTO_FUTURES: '코인선물',
};
const number = (n: number | null | undefined) =>
  typeof n === 'number' && Number.isFinite(n)
    ? n.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '미확인';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const safeNumber = (v: unknown) =>
  v === null || (typeof v === 'number' && Number.isFinite(v));
function validResponse(value: unknown, requested: Market): value is Response {
  if (!isRecord(value)
    || value.schemaVersion !== 'research-original-minute-diagnostic-readonly-v1'
    || value.market !== requested
    || typeof value.available !== 'boolean'
    || value.status === undefined || typeof value.status !== 'string'
    || value.executionAuthority !== 'NONE'
    || value.profitabilityProven !== false
    || value.actualFillCount !== null
    || value.paperAdmissionAllowed !== false
    || value.realOrders !== false
    || value.readOnly !== true
    || value.privateSourcePathsDisclosed !== false
    || value.providerGETCount !== 0 || value.financialMutationCount !== 0
    || value.fullMarketOpportunityDenominatorVerified !== false
    || value.actualMarketWideOpportunityCount !== null
    || value.trueMarketWideRecall !== null
    || value.OOSPassCount !== 0
    || value.publicationTimeIndependentlyAttested !== false
    || !['UNKNOWN', 'LOCAL_PUBLICATION_ONLY', 'OLDER_THAN_7_DAYS']
      .includes(String(value.publicationAgeStatus))
    || (value.reportPublishedAtMs !== null
      && (!Number.isSafeInteger(value.reportPublishedAtMs)
        || Number(value.reportPublishedAtMs) <= 0)))
    return false;
  if (!value.available) return value.report === null;
  const r = value.report;
  if (!isRecord(r) || !['PERIOD', 'SWEEP'].includes(String(r.kind))
    || r.status !== value.status
    || typeof r.selectedStartDate !== 'string'
    || typeof r.selectedEndDate !== 'string'
    || r.executionAuthority !== 'NONE'
    || r.profitabilityProven !== false
    || r.paperCandidatePASS !== false
    || r.independentOOSProven !== false
    || r.independentFullCostProven !== false
    || r.originalHistoricalSignalVerified !== false
    || r.actualFillCount !== null) return false;
  return r.kind === 'SWEEP'
    ? Number.isSafeInteger(r.sourceOnlyObservedPriceEventLabels)
      && Number(r.sourceOnlyObservedPriceEventLabels) >= 0
      && Number.isSafeInteger(r.pageCountSelfAttested)
    : r.kind === 'PERIOD' && safeNumber(r.modeledReturnPercent)
      && r.modeledReturnPercent !== null
      && safeNumber(r.modeledNetPnlKRW)
      && Number.isSafeInteger(r.sourceSessionsVerified)
      && Number(r.sourceSessionsVerified) >= 0;
}
async function fetchReport(market: Market, signal: AbortSignal): Promise<Response> {
  const query = new URLSearchParams({ market });
  const res = await authorizedFetch(
    '/api/research/video/evidence/workspace/original-minute-diagnostics?' + query,
    { method: 'GET', headers: { Accept: 'application/json' }, signal },
  );
  if (res.status === 401 || res.status === 403)
    throw new Error('관리자 로그인과 연구 자료 조회 권한이 필요합니다.');
  if (!res.ok)
    throw new Error('비공개 연구 결과의 권한·무결성을 검증하지 못했습니다.');
  const raw: unknown = await res.json();
  if (!validResponse(raw, market))
    throw new Error('안전하지 않거나 검증되지 않은 연구 결과는 표시하지 않습니다.');
  return raw;
}
/**
 * Only sanitized offline research RESULT summaries, never trades/parameters.
 * Only visible when an administrator explicitly requests a market report.
 */
export function ResearchOriginalMinuteDiagnosticsPanel() {
  const [market, setMarket] = useState<Market>('CRYPTO_SPOT');
  const [request, setRequest] = useState<{ market: Market; revision: number } | null>(null);
  const query = useQuery({
    queryKey: ['research-original-minute-diagnostics', request],
    enabled: request !== null,
    queryFn: ({ signal }) => fetchReport(request!.market, signal),
    retry: false, staleTime: 0, gcTime: 0,
  });
  const value = query.isSuccess && !query.isFetching
    && request?.market === market ? query.data : null;
  const report = value?.available ? value.report : null;
  return (
    <section className="rounded-3xl border border-card-border bg-card p-4 sm:p-5"
      data-testid="research-original-minute-diagnostics">
      <h2 className="text-base font-black">4시장 원본 1분봉 연구 결과 확인</h2>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        서버의 비공개 연구 파일에서 검증된 요약만 읽습니다.
        사후 백테스트 모델 결과와 당시 실제 탐지·체결 수익은 서로 다릅니다.
        원본 캔들·계좌·전략 파라미터·비공개 경로는 표시하지 않습니다.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="min-w-40 flex-1 text-xs font-semibold">
          조회 시장
          <select className="mt-1 min-h-11 w-full rounded-lg border border-card-border bg-background px-2"
            value={market} aria-label="원본 연구 결과 시장"
            onChange={event => {
              setMarket(event.target.value as Market);
              setRequest(null);
            }}>
            {(Object.keys(MARKET_LABEL) as Market[]).map(key =>
              <option key={key} value={key}>{MARKET_LABEL[key]}</option>)}
          </select>
        </label>
        <button type="button" disabled={query.isFetching}
          className="min-h-11 rounded-lg bg-primary px-4 text-xs font-bold text-primary-foreground disabled:opacity-50"
          onClick={() => setRequest(previous => ({
            market, revision: (previous?.revision ?? 0) + 1,
          }))}>
          {query.isFetching ? '검증 중' : '비공개 연구 요약 조회'}
        </button>
      </div>
      {query.isError ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {query.error instanceof Error ? query.error.message : '연구 요약 조회 실패'}
        </p>
      ) : null}
      {!query.isFetching && value?.available === false ? (
        <p className="mt-3 text-xs text-muted-foreground">
          현재 연구 요약은 미연결 또는 차단 상태입니다 ({value.reason}).
          자료 부재를 기회 0건이나 수익률 0%로 판단하지 않습니다.
        </p>
      ) : null}
      {report ? (
        <div className="mt-3 space-y-3" aria-live="polite">
          <p className="text-xs font-medium">
            {report.kind === 'PERIOD'
              ? '종목별 연속 기간 연구 모델' : '과거 종목·날짜 전체 페이지의 원본 점검'}
            {' · '}{report.selectedStartDate} ~ {report.selectedEndDate}
          </p>
          <p role="status" className="text-xs text-muted-foreground">
            결과 발행 시각(서버 로컬 기록):{' '}
            {value?.reportPublishedAtMs == null
              ? '미확인'
              : new Date(value.reportPublishedAtMs).toLocaleString('ko-KR')}
            {' · '}독립적인 시장 원본·OOS 검증 증거 아님
          </p>
          {value?.publicationAgeStatus === 'OLDER_THAN_7_DAYS' ? (
            <p role="alert" className="text-xs font-semibold text-destructive">
              발행 후 7일 이상 지난 연구 결과입니다. 현재 시장 상태나 최신 수익률로 사용하지 마세요.
            </p>
          ) : null}
          {report.kind === 'PERIOD' ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {([
                ['종목', report.symbol ?? '미확인'],
                ['보관 세션', number(report.sourceSessionsVerified)],
                ['모델 거래', number(report.modeledTradeCount)],
                ['모델 수익률(%)',
                  report.modeledReturnPercent == null
                    ? '미확인' : number(report.modeledReturnPercent) + '%'],
              ] as const).map(([label, result]) =>
                <div key={label} className="rounded-lg border border-card-border bg-background p-3">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="mt-1 text-sm font-bold tabular-nums">{result}</p>
                </div>)}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-card-border bg-background p-3">
                <p className="text-xs text-muted-foreground">검사된 페이지</p>
                <p className="mt-1 text-sm font-bold">{number(report.pageCountSelfAttested)}</p>
              </div>
              <div className="rounded-lg border border-card-border bg-background p-3">
                <p className="text-xs text-muted-foreground">사후 관측 가격 이벤트</p>
                <p className="mt-1 text-sm font-bold">
                  {number(report.sourceOnlyObservedPriceEventLabels)}
                </p>
              </div>
            </div>
          )}
          <p className="text-xs font-semibold text-muted-foreground">
            읽기 전용 · 독립 OOS 미검증 · 실제 체결 0건 입증 아님
            · 실제 수익성 미증명 · Paper/LIVE 실행 권한 없음
          </p>
        </div>
      ) : null}
    </section>
  );
}
