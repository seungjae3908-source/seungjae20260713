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
  canonicalPaperResearchReview?: {
    status: 'RESEARCH_HOLD';
    blockerCount: number;
    blockers: readonly string[];
    canonicalProfitabilityStatus: 'RESEARCH_HOLD';
    canonicalPaperBridgeStatus: 'BLOCKED';
    canonicalPaperBridgeBlockers: readonly string[];
    paperAdmissionAllowed: false;
    executionAuthority: 'NONE';
  };
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
  supplementarySweepReport?: DiagnosticReport | null;
  supplementarySweepWindowMatches?: boolean | null;
  supplementarySweepPublishedAtMs?: number | null;
  supplementarySweepPublicationAgeStatus?:
    'UNKNOWN' | 'LOCAL_PUBLICATION_ONLY' | 'OLDER_THAN_7_DAYS';
};
const BLOCKER_LABEL: Record<string, string> = {
  INDEPENDENT_WHOLE_VENUE_HISTORICAL_PIT_ROSTER_MISSING: '과거 전체 종목·상장폐지 이력 독립 검증',
  SOURCE_CALENDAR_AND_NATIVE_ONE_MINUTE_ENTITLEMENTS_UNVERIFIED: '거래소 원본 1분봉·세션·이용 권한 검증',
  ORIGINAL_TIME_T_MINUS_SCANNER_SIGNAL_UNVERIFIED: '당시 실시간 T-60~T0 신호 기록',
  FROZEN_STRATEGY_AND_INDEPENDENT_OOS_UNVERIFIED: '전략 동결·독립 OOS·워크포워드 검증',
  DATED_FX_FEES_FUNDING_LIQUIDITY_SLIPPAGE_FILLS_UNVERIFIED: '환율·수수료·펀딩·슬리피지·체결 실측',
  FUTURE_PROSPECTIVE_SIGNAL_UNVERIFIED: '미래 데이터 실관측 신호',
  AUTOMATIC_PAPER_FILL_SETTLEMENT_JOURNAL_TELEGRAM_UNVERIFIED: '모의주문·체결·정산·일지·텔레그램 폐루프',
  HISTORIC_WHOLE_VENUE_PIT_SWEEP_REQUIRED: '해당 기간 전 종목 PIT 원본 점검 자료',
  ORIGINAL_ONE_MINUTE_MODEL_LINEAGE_OR_COUNTER_UNVERIFIED: '원본 계보·거래 횟수 무결성 보완',
  HISTORIC_PIT_SWEEP_LINEAGE_OR_COMPLETENESS_UNVERIFIED: '전 종목 점검 범위·원본 계보 미확인',
  HISTORIC_WHOLE_VENUE_PIT_SWEEP_BLOCKED: '전 종목 점검 자료 불완전',
  PERIOD_SWEEP_SELECTED_DATE_WINDOW_MISMATCH: '종목 연구·전 종목 점검 기간 불일치',
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
  const review = r.canonicalPaperResearchReview;
  if (review != null && (!isRecord(review)
    || review.status !== 'RESEARCH_HOLD'
    || review.canonicalProfitabilityStatus !== 'RESEARCH_HOLD'
    || review.canonicalPaperBridgeStatus !== 'BLOCKED'
    || review.paperAdmissionAllowed !== false
    || review.executionAuthority !== 'NONE'
    || !Array.isArray(review.blockers) || review.blockers.length > 32
    || !review.blockers.every(v => typeof v === 'string' && /^[A-Z0-9_]{1,120}$/.test(v))
    || review.blockerCount !== review.blockers.length))
    return false;
  const companion = value.supplementarySweepReport;
  if (companion != null) {
    if (r.kind !== 'PERIOD' || !isRecord(companion)
      || companion.kind !== 'SWEEP'
      || companion.status !== 'LOCAL_HISTORIC_SOURCE_PAGES_TRAVERSED_RESEARCH_ONLY'
      || companion.executionAuthority !== 'NONE'
      || companion.profitabilityProven !== false
      || companion.paperCandidatePASS !== false
      || companion.actualFillCount !== null
      || companion.independentOOSProven !== false
      || companion.independentFullCostProven !== false
      || companion.originalHistoricalSignalVerified !== false
      || typeof companion.selectedStartDate !== 'string'
      || typeof companion.selectedEndDate !== 'string'
      || !Number.isSafeInteger(companion.pageCountSelfAttested)
      || !Number.isSafeInteger(companion.sourceOnlyObservedPriceEventLabels)
      || Number(companion.sourceOnlyObservedPriceEventLabels) < 0
      || value.supplementarySweepWindowMatches !== (
        companion.selectedStartDate === r.selectedStartDate
        && companion.selectedEndDate === r.selectedEndDate
      )) return false;
  } else if (value.supplementarySweepWindowMatches != null) return false;
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
          {report.kind === 'PERIOD' && value?.supplementarySweepReport ? (
            <div className="rounded-xl border border-card-border bg-background p-3"
              data-testid="research-native-sweep-companion">
              <p className="text-xs font-bold">
                전 종목 PIT 점검 자료 대조 (로컬 근거, 독립 원본 인증 아님)
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {value.supplementarySweepReport.selectedStartDate} ~{' '}
                {value.supplementarySweepReport.selectedEndDate}
                {' · '}
                {value.supplementarySweepWindowMatches
                  ? '기간 일치' : '기간 불일치 — 함께 승인할 수 없음'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                로컬 점검 페이지 {number(value.supplementarySweepReport.pageCountSelfAttested)}개
                {' · '}사후 가격 이벤트{' '}
                {number(value.supplementarySweepReport.sourceOnlyObservedPriceEventLabels)}개
                {' · '}실제 탐지율·체결 수익 아님
              </p>
            </div>
          ) : null}
          {report.kind === 'PERIOD' && report.canonicalPaperResearchReview ? (
            <div className="rounded-xl border border-card-border bg-background p-3"
              data-testid="research-native-paper-blockers">
              <p className="text-xs font-bold">
                기존 수익성·Paper 후보 심사: RESEARCH_HOLD (실행 불가)
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                {report.canonicalPaperResearchReview.blockers.slice(0, 10).map(code =>
                  <li key={code}>{BLOCKER_LABEL[code] ?? code}</li>)}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                공식 Paper 승인 검사 결과: BLOCKED · 자동주문/정산 실행 없음
              </p>
            </div>
          ) : null}
          <p className="text-xs font-semibold text-muted-foreground">
            읽기 전용 · 독립 OOS 미검증 · 실제 체결 0건 입증 아님
            · 실제 수익성 미증명 · Paper/LIVE 실행 권한 없음
          </p>
        </div>
      ) : null}
    </section>
  );
}
