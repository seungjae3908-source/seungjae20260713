import { cloneElement, useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { useAuth } from '@/lib/auth';
import {
  applyOriginalMinutePreset, changeOriginalMinuteMarket, createOriginalMinuteClient, createOriginalMinuteForm,
  createOriginalMinuteRunController, EMPTY_ORIGINAL_MINUTE_RUN, isOriginalMinuteRunActive,
  normalizeOriginalMinuteForm, originalMinuteErrorCode, ORIGINAL_MINUTE_COST_FIELDS,
  type OriginalMinuteBacktestRunV1, type OriginalMinuteClient, type OriginalMinuteFormValues,
} from '@/lib/original-minute-backtest';
import {
  ORIGINAL_MINUTE_MARKETS_V1, ORIGINAL_MINUTE_PRESETS_V1, ORIGINAL_MINUTE_TIMEFRAMES_V1,
  type OriginalMinuteMarketV1, type OriginalMinutePresetV1,
} from '../../../packages/strategy-hypothesis/src/original-minute-backtest.js';

const marketLabels = { KR_STOCK: '국내주식', US_STOCK: '미국주식', CRYPTO_SPOT: '코인현물 · Upbit KRW', CRYPTO_FUTURES: '코인선물 · Bitget USDT' };
const presetLabels = { '1d': '1일', '1w': '1주', '1m': '1개월', '3m': '3개월', '6m': '6개월', '1y': '1년', '3y': '3년', '5y': '5년', '10y': '10년' };
const timeframeLabels = { '1m': '1분', '3m': '3분', '5m': '5분', '15m': '15분', '30m': '30분', '1h': '1시간', '4h': '4시간', '1d': '1일' };
const statusLabels = { RUNNING: '원본 검증·연구 실행 중', CANCELLING: '취소 처리 중', COMPLETED: '연구 모델 계산 완료', BLOCKED_DATA: '자료 확인 필요 · 실행 차단', CANCELLED: '실행 취소됨', TIMED_OUT: '실행 시간 한도 도달', FAILED: '연구 실행 실패' };
const reasonLabels: Record<string, string> = {
  ORIGINAL_MINUTE_NUMBER_INPUT_REQUIRED: '숫자 입력을 확인해 주세요. 빈 값은 0으로 처리하지 않습니다.',
  ORIGINAL_MINUTE_DATE_WINDOW_INVALID: '시작일과 종료일을 확인해 주세요. 시작일은 종료일보다 늦을 수 없습니다.',
  ORIGINAL_MINUTE_FUTURE_DATE_INVALID: '완료된 날짜까지 선택해 주세요. 오늘 또는 미래 날짜의 원본은 아직 완성되지 않았습니다.',
  ORIGINAL_MINUTE_SYMBOL_INVALID: '선택 시장의 정확한 원본 종목 코드를 입력해 주세요.',
  ORIGINAL_MINUTE_FX_ASSUMPTION_REQUIRED: '미국주식·코인선물에는 1 USD 또는 1 USDT당 원화 환율 가정이 필요합니다.',
  ORIGINAL_MINUTE_EMA_FAST_INVALID: '빠른 EMA는 2~100의 정수여야 합니다.',
  ORIGINAL_MINUTE_EMA_SLOW_INVALID: '느린 EMA는 빠른 EMA보다 크고 250 이하여야 합니다.',
  ORIGINAL_MINUTE_LEVERAGE_INVALID: '현금 시장은 1배, 선물은 1~7배의 정수만 선택할 수 있습니다.',
  ORIGINAL_MINUTE_RISK_FRACTION_INVALID: '거래당 위험 비율은 0% 초과, 10% 이하로 입력해 주세요.',
  ORIGINAL_MINUTE_CAPITAL_INVALID: '초기 자본은 1원 이상으로 입력해 주세요.',
  ORIGINAL_MINUTE_COST_RATE_INVALID: '각 비용 가정은 0% 이상, 20% 미만으로 입력해 주세요.',
  ORIGINAL_MINUTE_STOP_INVALID: '손절 비율은 0% 초과, 20% 이하로 입력해 주세요.',
  ORIGINAL_MINUTE_TARGET_INVALID: '목표 수익 비율은 0% 초과, 100% 이하로 입력해 주세요.',
  ORIGINAL_MINUTE_DIRECTION_INVALID: '국내주식·미국주식·코인현물은 매수(LONG)만 연구합니다.',
  ORIGINAL_MINUTE_STOCK_DAILY_SOURCE_REQUIRED: '주식 일봉은 별도 일봉 원본이 필요합니다. 이 화면에서는 분·시간봉을 선택해 주세요.',
  ORIGINAL_MINUTE_LOGIN_REQUIRED: '로그인 상태를 확인해 주세요.',
  ORIGINAL_MINUTE_ADMIN_REQUIRED: '관리자 권한이 필요합니다.',
  ORIGINAL_MINUTE_RUN_BUSY: '이미 진행 중인 작업이 있거나 현재 실행 한도에 도달했습니다.',
  ORIGINAL_MINUTE_RUN_NOT_FOUND: '실행 기록을 찾을 수 없습니다. 서버가 재시작되었거나 기록 보관 기간이 지났을 수 있습니다.',
  ORIGINAL_MINUTE_NETWORK_UNAVAILABLE: '서버에 연결하지 못했습니다. 알려진 실행은 상태 다시 확인 또는 취소를 이용해 주세요.',
  ORIGINAL_MINUTE_REQUEST_TIMED_OUT: '서버 응답을 기다리는 시간이 지났습니다. 알려진 실행은 상태 다시 확인 또는 취소를 이용해 주세요.',
  ORIGINAL_MINUTE_SERVICE_UNAVAILABLE: '원본 연구 서비스가 준비되지 않았습니다.',
  ORIGINAL_MINUTE_SELECTION_MISMATCH: '응답의 시장·기간·전략·비용 가정이 요청과 달라 결과를 표시하지 않았습니다.',
  ORIGINAL_MINUTE_SAFETY_CONTRACT_INVALID: '응답의 연구·권한 계약이 일치하지 않아 결과를 표시하지 않았습니다.',
  ORIGINAL_MINUTE_RESPONSE_INVALID: '원본 연구 응답을 검증하지 못했습니다. 수익이나 거래 수를 확정하지 않습니다.',
  ORIGINAL_MINUTE_REPLAY_TIME_BUDGET_EXCEEDED: '실행 시간 한도에 도달했습니다. 진행 중인 원본 처리가 종료될 때까지 취소 상태로 기다립니다.',
  ORIGINAL_MINUTE_REPLAY_CANCELLED: '사용자가 실행 취소를 요청했습니다.',
  RETROSPECTIVE_SOURCE_MODEL_ONLY_NOT_PROFITABILITY_PASS: '과거 원본에 대한 모델 계산입니다. 수익성 PASS를 입증하지 않습니다.',
  SELECTED_WINDOW_SHORTER_THAN_HORIZON: '선택 구간이 이 고정 일수보다 짧습니다.',
  ORIGINAL_MINUTE_SOURCE_ROOT_NOT_CONFIGURED: '서버의 원본 보관 위치가 설정되지 않았습니다. 관리자의 서버 설정과 실제 원본 자료 준비가 필요합니다.',
  ORIGINAL_MINUTE_SOURCE_ROOT_NOT_FOUND: '설정된 원본 보관 위치를 서버에서 찾지 못했습니다.',
  ORIGINAL_MINUTE_SOURCE_ROOT_INVALID: '서버의 원본 보관 설정을 검증하지 못했습니다.',
  ORIGINAL_MINUTE_ARCHIVE_NOT_FOUND: '선택 시장의 보관 원본을 찾지 못했습니다.',
  ORIGINAL_MINUTE_CURRENT_ROSTER_NOT_FOUND: '서버에 선택 시장의 현재 종목 목록이 없습니다.',
  ORIGINAL_MINUTE_CURRENT_ROSTER_INVALID: '현재 종목 목록의 원본·무결성 검증을 통과하지 못했습니다.',
  ORIGINAL_MINUTE_CURRENT_ROSTER_MEMBER_NOT_FOUND: '입력한 종목이 제공된 현재 종목 목록에 없습니다. 과거 존재 여부는 별도 확인이 필요합니다.',
  ORIGINAL_MINUTE_HISTORICAL_PIT_MANIFEST_NOT_FOUND: '해당 주식 시장의 과거 시점별 종목 명부가 준비되지 않았습니다.',
  ORIGINAL_MINUTE_STOCK_CALENDAR_NOT_FOUND: '해당 주식 시장의 거래일·거래시간 자료가 준비되지 않았습니다.',
  ORIGINAL_PERIOD_PRIVATE_SESSION_INDEX_UNAVAILABLE: '선택 종목·기간의 원본 세션 목록을 찾거나 검증하지 못했습니다.',
  ORIGINAL_MINUTE_MODEL_EQUITY_RECONCILIATION_FAILED: '비용 반영 손익과 모델 자본 정산이 일치하지 않아 계산값을 표시하지 않았습니다.',
};
const inputClass = 'h-11 w-full min-w-0 rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';
const numberFormatter = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });
const money = (value: number) => `${numberFormatter.format(value)}원`;
const percent = (value: number) => `${numberFormatter.format(value)}%`;
const observed = (value: number | null) => value === null ? '미확인' : numberFormatter.format(value);
const defaultClient = createOriginalMinuteClient();

function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const generatedId = useId();
  const controlId = children.props.id ?? `original-minute-${generatedId}`;
  return <div className="grid min-w-0 gap-1.5 text-xs font-semibold text-muted-foreground"><label htmlFor={controlId}>{label}</label>{cloneElement(children, { id: controlId })}</div>;
}
function Metric({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return <div className="min-w-0 rounded-xl border border-border bg-background p-3"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words text-base font-semibold" data-testid={testId}>{value}</dd></div>;
}
function Reason({ value }: { value: string }) {
  return <span className="block min-w-0 break-words"><span>{reasonLabels[value] ?? '원본 자료 또는 연구 조건 확인이 필요합니다.'}</span><code className="mt-1 block break-all text-[10px] opacity-75">{value}</code></span>;
}

function OriginalMinuteRunResult({ run }: { run: OriginalMinuteBacktestRunV1 }) {
  const report = run.report;
  return (
    <section className="space-y-4 rounded-2xl border border-border bg-card p-4" aria-labelledby="original-minute-result-title" data-testid="original-minute-result">
      <div className="space-y-1">
        <h3 id="original-minute-result-title" className="font-semibold" data-testid="original-minute-status">{statusLabels[run.status]}</h3>
        <p className="break-words text-xs text-muted-foreground">{marketLabels[run.selection.market]} · {run.selection.symbol} · {run.selection.direction} · {timeframeLabels[run.selection.timeframe]}</p>
        <p className="text-xs text-muted-foreground">{run.selection.startDate} ~ {run.selection.endDate} · 시작일·종료일 포함</p>
      </div>
      {run.reason ? <div className="rounded-xl bg-muted p-3 text-xs"><Reason value={run.reason} /></div> : null}
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Metric label="목록에서 찾은 원본 세션" value={observed(run.coverage.indexedPrivateSessions)} />
        <Metric label="검증된 원본 1분봉 세션" value={observed(run.coverage.verifiedNativeMinuteSessions)} />
        <Metric label="자료를 확인하지 못한 날짜" value={observed(run.coverage.missingSourceDays)} />
        {run.selection.market === 'KR_STOCK' || run.selection.market === 'US_STOCK' ? <Metric label="자료가 없는 주식 예상 세션" value={observed(run.coverage.missingExpectedStockSessions)} /> : null}
      </dl>
      {run.coverage.blockedDatesPreview.length > 0 ? <p className="break-words text-xs text-muted-foreground">확인 필요 날짜 일부: {run.coverage.blockedDatesPreview.join(', ')}</p> : null}
      {run.coverage.blockedDate ? <p className="text-xs text-muted-foreground">검증이 중단된 날짜: {run.coverage.blockedDate}</p> : null}
      <div className="space-y-1 text-xs text-muted-foreground">
        <p data-testid="original-minute-source-kind">원본 구분: {run.source.fixtureOnly === true || run.source.sourceClass === 'TEST_FIXTURE' ? '테스트용 원본 · 실제 시장 성과로 사용할 수 없음' : run.source.fixtureOnly === false ? '비테스트 원본 · 공급 범위 내 연구' : '미확인'}</p>
        <p>종목 범위: {run.source.evidenceScope === 'CURRENT_PROVIDER_ROSTER_SOURCE_ONLY' ? '현재 공급원 종목 목록 기준 · 과거 전체 종목 명부 미검증' : run.source.evidenceScope === 'HISTORICAL_PIT_ROSTER' ? '과거 PIT 명부 입력 기준' : '미확인'}</p>
        <p>과거 PIT 명부 확인: {run.source.historicalPITRosterChecked ? '제공된 명부 확인' : '미확인'}</p>
        {run.source.currentRosterObservedAtMs !== null ? <p>현재 종목 목록 관측: {new Date(run.source.currentRosterObservedAtMs).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}</p> : null}
      </div>
      {report ? (
        <>
          <h4 className="text-sm font-semibold">선택 구간의 모델 계산값</h4>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Metric label="비용 가정 반영 수익률" value={percent(report.modeledReturnPercent)} testId="original-minute-modeled-return" />
            <Metric label="모델 순손익" value={money(report.modeledNetPnlKRW)} />
            <Metric label="모델 최대 낙폭 · 청산 손익 기준" value={percent(report.modeledMaxDrawdownPercent)} />
            <Metric label="모델 거래 수" value={`${observed(report.modeledTradeCount)}건`} />
            <Metric label="모델 이익 / 손실 거래" value={`${observed(report.modeledWins)} / ${observed(report.modeledLosses)}`} />
            <Metric label="모델 비용 합계" value={money(report.modeledCostKRW)} />
            <Metric label="모델 종료 운용 자본" value={money(report.modeledEndingCapitalKRW)} />
            <Metric label="모델 이익 적립금" value={money(report.modeledProfitReserveKRW)} />
            <Metric label="검증된 원본 세션 수" value={observed(report.sourceSessionsVerified)} />
          </dl>
          <p className="text-xs leading-relaxed text-muted-foreground">원본 가격으로 계산한 가상 거래입니다. 최대 낙폭은 청산 직후 자본·적립금 기준이며 미실현 손실을 포함하지 않습니다. 실제 체결 수·당시 검색 성공률·독립 OOS·워크포워드 수익성은 입증되지 않았습니다.</p>
          <div className="min-w-0 overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left text-xs" data-testid="original-minute-horizons">
              <caption className="p-3 text-left font-semibold">종료일 기준 고정 일수 성과 · 달력의 월·년 기간 선택과 기준이 다릅니다.</caption>
              <thead className="bg-muted"><tr><th className="p-2">일수</th><th className="p-2">필요 시작일</th><th className="p-2">모델 수익률 / 차단</th></tr></thead>
              <tbody>{report.horizonReturns.map((row) => <tr key={row.horizonDays} className="border-t border-border"><td className="p-2 align-top">{observed(row.horizonDays)}일</td><td className="whitespace-nowrap p-2 align-top">{row.requiredStartDate}</td><td className="p-2 align-top">{row.status === 'MODELED_SOURCE_ONLY' && row.modeledReturnPercent !== null ? percent(row.modeledReturnPercent) : <span className="text-muted-foreground">미확인 · 자료 부족{row.reason ? <code className="mt-1 block break-all text-[10px]">{row.reason}</code> : null}</span>}</td></tr>)}</tbody>
            </table>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">고정 일수 수익률은 선택 실행의 마지막 N일에 청산된 모델 손익을 전체 실행의 초기 자본으로 나눈 값입니다. 기간마다 전략을 다시 시작한 독립 실험이나 해당 기간 시작 자본 대비 수익률이 아닙니다.</p>
          <div className="rounded-xl bg-muted p-3 text-xs">
            <h4 className="font-semibold">수익성·자동모의매매 심사: 연구 보류</h4>
            <ul className="mt-2 space-y-2">{report.canonicalPaperResearchReview.blockers.map((blocker, index) => <li key={`${blocker}-${index}`}><Reason value={blocker} /></li>)}</ul>
          </div>
        </>
      ) : (
        <div className="rounded-xl bg-muted p-3 text-sm" data-testid="original-minute-unverified-result">수익률 · 거래 수: 미확인. 계산이 완료되지 않은 구간을 0% 또는 기회 0건으로 표시하지 않습니다.</div>
      )}
      {run.blockers.length > 0 ? <div className="text-xs"><h4 className="font-semibold">차단 사유</h4><ul className="mt-2 space-y-2">{run.blockers.map((blocker, index) => <li key={`${blocker}-${index}`}><Reason value={blocker} /></li>)}</ul></div> : null}
    </section>
  );
}

/** The route uses the auth wrapper below; an injected client is only for deterministic local UI QA. */
export function OriginalMinuteBacktestPanelContent({ client = defaultClient }: { client?: OriginalMinuteClient }) {
  const [values, setValues] = useState<OriginalMinuteFormValues>(() => createOriginalMinuteForm());
  const [preset, setPreset] = useState<OriginalMinutePresetV1 | 'custom'>('1m');
  const [runState, setRunState] = useState(EMPTY_ORIGINAL_MINUTE_RUN);
  const [validationError, setValidationError] = useState<string | null>(null);
  const controller = useRef<ReturnType<typeof createOriginalMinuteRunController> | null>(null);
  useEffect(() => {
    const current = createOriginalMinuteRunController({ client, onChange: setRunState });
    controller.current = current;
    return () => { current.dispose(); if (controller.current === current) controller.current = null; };
  }, [client]);
  const futures = values.market === 'CRYPTO_FUTURES';
  const stock = values.market === 'KR_STOCK' || values.market === 'US_STOCK';
  const krw = values.market === 'KR_STOCK' || values.market === 'CRYPTO_SPOT';
  const busy = runState.submitting || runState.cancelling || isOriginalMinuteRunActive(runState.run);
  const maxDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const omittedCosts = ORIGINAL_MINUTE_COST_FIELDS.filter(([key]) => (futures || key !== 'fundingRatePerSession') && values.costPercent[key].trim() !== '' && Number(values.costPercent[key]) === 0).map(([, label]) => label);
  function change(next: OriginalMinuteFormValues) { controller.current?.reset(); setValidationError(null); setValues(next); }
  function changeDate(field: 'startDate' | 'endDate', value: string) { setPreset('custom'); change({ ...values, [field]: value }); }
  function choosePreset(next: OriginalMinutePresetV1 | 'custom') {
    setPreset(next);
    if (next === 'custom') return;
    try { change(applyOriginalMinutePreset(values, next)); }
    catch (error) { controller.current?.reset(); setValidationError(originalMinuteErrorCode(error)); }
  }
  function submit(event: FormEvent) {
    event.preventDefault(); setValidationError(null);
    try { const selection = normalizeOriginalMinuteForm(values); void controller.current?.start(selection); }
    catch (error) { setValidationError(originalMinuteErrorCode(error)); }
  }
  return (
    <section className="h-full min-h-0 overflow-y-auto overscroll-contain p-3 pb-6 sm:p-5" aria-labelledby="original-minute-title" data-testid="original-minute-panel">
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="space-y-2">
          <h2 id="original-minute-title" className="text-lg font-semibold">원본 1분봉 기간 연구</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">서버에 보관한 실제 원본 자료로 선택 종목·기간의 전략을 수동 실행합니다. 전체 종목 수집이나 수익성 검증 완료를 뜻하지 않습니다.</p>
          <div className="rounded-xl border border-border bg-muted p-3 text-xs leading-relaxed" data-testid="original-minute-research-hold">수익성 미입증 · 독립 OOS 통과 0건 · 자동모의매매 진입 차단 · 주문 권한 없음</div>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-border bg-card p-4" data-testid="original-minute-form">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="시장"><select className={inputClass} value={values.market} onChange={(e) => change(changeOriginalMinuteMarket(values, e.target.value as OriginalMinuteMarketV1))}>{ORIGINAL_MINUTE_MARKETS_V1.map((market) => <option key={market} value={market}>{marketLabels[market]}</option>)}</select></Field>
            <Field label="원본 종목 코드"><input className={inputClass} value={values.symbol} autoComplete="off" autoCapitalize="characters" spellCheck={false} onChange={(e) => change({ ...values, symbol: e.target.value })} /></Field>
            <Field label="재생 시간봉"><select className={inputClass} value={values.timeframe} onChange={(e) => change({ ...values, timeframe: e.target.value as OriginalMinuteFormValues['timeframe'] })}>{ORIGINAL_MINUTE_TIMEFRAMES_V1.filter((timeframe) => !(stock && timeframe === '1d')).map((timeframe) => <option key={timeframe} value={timeframe}>{timeframeLabels[timeframe]}</option>)}</select></Field>
            <Field label="진입 방향"><select className={inputClass} value={values.direction} disabled={!futures} onChange={(e) => change({ ...values, direction: e.target.value as 'LONG' | 'SHORT' })}><option value="LONG">매수 · LONG</option>{futures ? <option value="SHORT">매도 · SHORT</option> : null}</select></Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="기간 선택"><select className={inputClass} value={preset} onChange={(e) => choosePreset(e.target.value as OriginalMinutePresetV1 | 'custom')}>{ORIGINAL_MINUTE_PRESETS_V1.map((key) => <option key={key} value={key}>{presetLabels[key]}</option>)}<option value="custom">직접 선택</option></select></Field>
            <Field label="시작일 (포함)"><input className={inputClass} type="date" min="1970-01-02" max={maxDate} value={values.startDate} onChange={(e) => changeDate('startDate', e.target.value)} /></Field>
            <Field label="종료일 (포함)"><input className={inputClass} type="date" min="1970-01-02" max={maxDate} value={values.endDate} onChange={(e) => changeDate('endDate', e.target.value)} /></Field>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">1일~10년 또는 직접 지정한 기간을 요청합니다. 원본이 없는 날짜는 차단 사유로 남기며, 자료에 맞춰 요청 기간을 줄이지 않습니다. 주식은 분·시간봉만 지원합니다.</p>
          <fieldset className="space-y-3 border-t border-border pt-3">
            <legend className="pr-2 text-sm font-semibold">전략·자본 가정 · EMA 추세</legend>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {([['fast', '빠른 EMA'], ['slow', '느린 EMA'], ['stopPercent', '손절 (%)'], ['targetPercent', '목표 수익 (%)'], ['initialCapitalKRW', '초기 자본 (원)'], ['riskPercent', '거래당 위험 (%)']] as const).map(([key, label]) => <Field key={key} label={label}><input className={inputClass} type="text" inputMode="decimal" value={values[key]} onChange={(e) => change({ ...values, [key]: e.target.value })} /></Field>)}
              <Field label="레버리지 (배)"><input className={inputClass} type="text" inputMode="numeric" disabled={!futures} value={values.leverage} onChange={(e) => change({ ...values, leverage: e.target.value })} /></Field>
              <Field label={krw ? '원화 환산 (1 KRW당 원)' : `고정 환율 (1 ${values.market === 'US_STOCK' ? 'USD' : 'USDT'}당 원)`}><input className={inputClass} type="text" inputMode="decimal" disabled={krw} placeholder={krw ? '1' : '환율 가정 입력'} value={values.fxRateKRWPerQuote} onChange={(e) => change({ ...values, fxRateKRWPerQuote: e.target.value })} /></Field>
            </div>
          </fieldset>
          <details className="rounded-xl border border-border p-3">
            <summary className="min-h-8 cursor-pointer text-sm font-semibold">비용 가정 설정 · 모두 % 단위</summary>
            <p className="mb-3 mt-2 text-xs leading-relaxed text-muted-foreground">공급원·계좌의 실제 요율을 자동 조회하지 않습니다. 입력 값은 연구용 가정이며, 0%는 해당 비용을 계산에서 제외한다는 뜻입니다.</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{ORIGINAL_MINUTE_COST_FIELDS.filter(([key]) => futures || key !== 'fundingRatePerSession').map(([key, label]) => <Field key={key} label={`${label} (%)`}><input className={inputClass} type="text" inputMode="decimal" value={values.costPercent[key]} onChange={(e) => change({ ...values, costPercent: { ...values.costPercent, [key]: e.target.value } })} /></Field>)}</div>
          </details>
          {omittedCosts.length > 0 ? <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300" data-testid="original-minute-omitted-costs">0%로 미반영된 비용: {omittedCosts.join(' · ')}. 실제 비용이 0이라는 증거가 아닙니다.</p> : null}
          <p className="text-xs leading-relaxed text-muted-foreground">현재 모델은 각 원본 세션 종료 시 전량 청산하며, 기간 전체에 고정 환율을 적용합니다. 선물 펀딩은 종료된 거래마다 1회 적용하는 단순 모델로, 실제 8시간 등 펀딩 시각·과거 요율을 재현하지 않습니다.</p>
          {validationError ? <div role="alert" className="rounded-xl bg-destructive/10 p-3 text-xs text-destructive"><Reason value={validationError} /></div> : null}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className="min-h-11 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50">{runState.submitting ? '실행 요청 중…' : '원본 연구 수동 실행'}</button>
            {busy ? <button type="button" disabled={runState.cancelling} onClick={() => { void controller.current?.cancel(); }} className="min-h-11 rounded-xl border border-border px-4 text-sm font-semibold disabled:opacity-50">{runState.cancelling ? '취소 처리 중…' : '실행 취소'}</button> : null}
            {runState.run && runState.errorCode ? <button type="button" onClick={() => { void controller.current?.refresh(); }} className="min-h-11 rounded-xl border border-border px-4 text-sm font-semibold">상태 다시 확인</button> : null}
          </div>
          <p className="text-xs text-muted-foreground">조건을 변경하면 이전 결과를 지우고 진행 중인 연구에 취소를 요청합니다. 기간별 자동 반복 실행은 하지 않습니다.</p>
        </form>
        <div aria-live="polite" aria-atomic="true" className="text-sm">{runState.submitting ? runState.cancelling ? '실행 접수 확인 후 취소를 요청합니다.' : '수동 실행을 접수하고 있습니다.' : runState.run ? statusLabels[runState.run.status] : null}</div>
        {runState.errorCode ? <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs"><Reason value={runState.errorCode} /></div> : null}
        {runState.run ? <OriginalMinuteRunResult run={runState.run} /> : <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="original-minute-no-result">실행 결과 없음 · 아직 수익률이나 거래 수를 계산하지 않았습니다.</p>}
      </div>
    </section>
  );
}

export function OriginalMinuteBacktestPanel() {
  const auth = useAuth();
  if (auth.loading) return <div className="p-5 text-sm text-muted-foreground" role="status">관리자 권한 확인 중…</div>;
  if (!auth.configured || !auth.session) return <div className="p-5 text-sm text-muted-foreground">원본 연구는 관리자 로그인 후 사용할 수 있습니다.</div>;
  if (!auth.can('canManageMembers')) return <div className="p-5 text-sm text-muted-foreground" data-testid="original-minute-admin-required">원본 연구 실행·결과 조회·취소에는 관리자 권한이 필요합니다.</div>;
  return <OriginalMinuteBacktestPanelContent />;
}
