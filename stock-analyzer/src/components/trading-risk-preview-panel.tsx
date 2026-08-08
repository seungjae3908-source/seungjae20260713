import { useEffect, useMemo, useRef, useState } from 'react';
import { Calculator, ShieldAlert, ShieldCheck } from 'lucide-react';
import type {
  DataStatus,
  FuturesContractRules,
  FuturesMarketSnapshot,
} from '@/lib/futures-market-data';
import {
  previewTradingRisk,
  type RiskBlockCode,
  type RiskEngineResult,
  type TradeSide,
} from '@/lib/trading-risk';
import { cn } from '@/lib/utils';

const APP_SAFE_MAXIMUM_LEVERAGE = 10;

const STATUS_LABEL: Record<DataStatus, string> = {
  live: '실시간',
  delayed: '지연',
  cached: '캐시',
  disconnected: '연결 끊김',
  error: '오류',
  insufficient: '데이터 부족',
};

type Props = {
  symbol: string;
  snapshot?: FuturesMarketSnapshot;
  snapshotLoading?: boolean;
  contractRules?: FuturesContractRules;
  contractRulesLoading?: boolean;
  contractRulesError?: boolean;
};

type FieldProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  allowNegative?: boolean;
};

const BLOCK_LABELS: Record<RiskBlockCode, string> = {
  INVALID_ACCOUNT_BALANCE: '계좌 기준 금액이 올바르지 않습니다.',
  INVALID_ENTRY_PRICE: '진입가가 올바르지 않습니다.',
  INVALID_STOP_LOSS: '손절가 방향 또는 값이 올바르지 않습니다.',
  INVALID_TARGET_PRICE: '목표가 방향 또는 값이 올바르지 않습니다.',
  INVALID_LEVERAGE: '레버리지는 1 이상이어야 합니다.',
  INVALID_RISK_PERCENT: '1회 허용 위험률은 0% 초과 1% 이하여야 합니다.',
  INVALID_COST_RATE: '수수료·슬리피지·펀딩비율을 확인하세요.',
  DATA_NOT_LIVE: '실시간 시장 데이터가 아니므로 진입 가능 판정을 차단했습니다.',
  CONTRACT_RULES_NOT_LIVE: '계약 규칙이 실시간 상태가 아니므로 진입 가능 판정을 차단했습니다.',
  LEVERAGE_EXCEEDS_EXCHANGE_LIMIT: '입력 레버리지가 거래소 제공 한도를 초과합니다.',
  LEVERAGE_EXCEEDS_APP_LIMIT: `입력 레버리지가 앱 안전 제한 ${APP_SAFE_MAXIMUM_LEVERAGE}배를 초과합니다.`,
  RISK_REWARD_TOO_LOW: '순손익 기준 손익비가 1.0 미만입니다.',
  DAILY_LOSS_LIMIT: '일일 손실 한도에 도달했습니다.',
  WEEKLY_LOSS_LIMIT: '주간 손실 한도에 도달했습니다.',
  CONSECUTIVE_LOSS_LIMIT: '연속 손실 차단 기준에 도달했습니다.',
  MINIMUM_QUANTITY: '거래소 최소 수량을 충족하지 못합니다.',
  MINIMUM_NOTIONAL: '거래소 최소 명목금액을 충족하지 못합니다.',
  EXPOSURE_LIMIT: '전체 또는 동일 방향 명목 노출 한도를 초과합니다.',
  LIQUIDATION_TOO_CLOSE: '손절가가 예상 청산가격보다 불리하거나 너무 가깝습니다.',
};

function normalizeNumericDraft(value: string, allowNegative: boolean) {
  let next = value.replace(/,/g, '').replace(/[eE+]/g, '').replace(/[^0-9.\-]/g, '');
  const negative = allowNegative && next.startsWith('-');
  next = next.replace(/-/g, '');
  const firstDot = next.indexOf('.');
  if (firstDot >= 0) {
    next = `${next.slice(0, firstDot + 1)}${next.slice(firstDot + 1).replace(/\./g, '')}`;
  }
  return negative ? `-${next}` : next;
}

function NumericField({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
  allowNegative = false,
}: FieldProps) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="text-[9px] font-black text-muted-foreground">
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(normalizeNumericDraft(event.target.value, allowNegative))}
        placeholder={placeholder}
        className="mt-1 h-11 w-full min-w-0 rounded-xl border border-card-border bg-background px-3 text-[11px] font-bold outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
      />
      {hint ? (
        <span className="mt-1 block text-[8px] font-semibold leading-relaxed text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function Metric({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-card-border bg-background p-3" data-testid={testId}>
      <p className="text-[9px] font-black text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-[11px] font-black">{value}</p>
    </div>
  );
}

function parseRequired(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '-' || trimmed === '.' || trimmed === '-.') return Number.NaN;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function parseOptional(value: string) {
  if (!value.trim()) return null;
  return parseRequired(value);
}

function formatNumber(value: number | null | undefined, digits = 6) {
  if (value == null || !Number.isFinite(value)) return '계산 불가';
  return value.toLocaleString('ko-KR', { maximumFractionDigits: digits });
}

function formatMoney(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '계산 불가';
  return `${value.toLocaleString('ko-KR', { maximumFractionDigits: 4 })} USDT`;
}

function formatPercent(value: number | null | undefined, digits = 3) {
  if (value == null || !Number.isFinite(value)) return '계산 불가';
  return `${value.toFixed(digits)}%`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return '확인 불가';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '확인 불가' : date.toLocaleString('ko-KR');
}

function defaultsFor(side: TradeSide, entry: number) {
  return side === 'long'
    ? {
        stop: entry * 0.985,
        target1: entry * 1.02,
        target2: entry * 1.03,
      }
    : {
        stop: entry * 1.015,
        target1: entry * 0.98,
        target2: entry * 0.97,
      };
}

function statusClass(status: DataStatus) {
  if (status === 'live') return 'border-positive/30 bg-positive/10 text-positive';
  if (status === 'cached' || status === 'delayed' || status === 'insufficient') {
    return 'border-warning/30 bg-warning/10 text-warning';
  }
  return 'border-destructive/30 bg-destructive/10 text-destructive';
}

export function TradingRiskPreviewPanel({
  symbol,
  snapshot,
  snapshotLoading = false,
  contractRules,
  contractRulesLoading = false,
  contractRulesError = false,
}: Props) {
  const requestControllerRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);
  const [side, setSide] = useState<TradeSide>('long');
  const [accountBalance, setAccountBalance] = useState('1000');
  const [entryPrice, setEntryPrice] = useState('');
  const [stopLossPrice, setStopLossPrice] = useState('');
  const [targetPrice1, setTargetPrice1] = useState('');
  const [targetPrice2, setTargetPrice2] = useState('');
  const [leverage, setLeverage] = useState('2');
  const [riskPercent, setRiskPercent] = useState('0.5');
  const [entryFeeRate, setEntryFeeRate] = useState('0.0006');
  const [exitFeeRate, setExitFeeRate] = useState('0.0006');
  const [slippageRate, setSlippageRate] = useState('0.0005');
  const [fundingRate, setFundingRate] = useState('');
  const [dailyPnl, setDailyPnl] = useState('0');
  const [weeklyPnl, setWeeklyPnl] = useState('0');
  const [consecutiveLosses, setConsecutiveLosses] = useState('0');
  const [openExposure, setOpenExposure] = useState('0');
  const [sameDirectionExposure, setSameDirectionExposure] = useState('0');
  const [entryTouched, setEntryTouched] = useState(false);
  const [fundingTouched, setFundingTouched] = useState(false);
  const [levelsTouched, setLevelsTouched] = useState(false);
  const [result, setResult] = useState<RiskEngineResult | null>(null);
  const [message, setMessage] = useState('');
  const [calculating, setCalculating] = useState(false);

  useEffect(() => () => requestControllerRef.current?.abort(), []);

  useEffect(() => {
    requestControllerRef.current?.abort();
    requestSequenceRef.current += 1;
    setEntryTouched(false);
    setFundingTouched(false);
    setLevelsTouched(false);
    setEntryPrice('');
    setStopLossPrice('');
    setTargetPrice1('');
    setTargetPrice2('');
    setFundingRate('');
    setResult(null);
    setMessage('');
    setCalculating(false);
  }, [symbol]);

  useEffect(() => {
    const markPrice = snapshot?.markPrice;
    if (!entryTouched && !entryPrice && markPrice != null && Number.isFinite(markPrice) && markPrice > 0) {
      const defaults = defaultsFor(side, markPrice);
      setEntryPrice(String(markPrice));
      if (!levelsTouched) {
        setStopLossPrice(String(defaults.stop));
        setTargetPrice1(String(defaults.target1));
        setTargetPrice2(String(defaults.target2));
      }
    }
    const rate = snapshot?.fundingRate;
    if (!fundingTouched && !fundingRate && rate != null && Number.isFinite(rate)) {
      setFundingRate(String(rate));
    }
  }, [entryPrice, entryTouched, fundingRate, fundingTouched, levelsTouched, side, snapshot]);

  const contractStatus: DataStatus = contractRulesError
    ? 'error'
    : contractRules?.status ?? 'insufficient';
  const trustedRules = contractStatus === 'live' ? contractRules : undefined;
  const contractWarnings = useMemo(
    () => [...new Set([
      ...(contractRules?.warnings ?? []),
      ...(contractRulesError ? ['거래소 계약 규칙을 불러오지 못했습니다.'] : []),
      ...(!contractRulesLoading && !contractRules ? ['거래소 최소 주문 규칙을 확인할 수 없습니다.'] : []),
    ])],
    [contractRules, contractRulesError, contractRulesLoading],
  );

  const autoFillLabel = useMemo(() => {
    const entries = [
      !entryTouched && snapshot?.markPrice != null ? '진입가: markPrice 자동 입력' : '진입가: 사용자 입력 보호',
      !fundingTouched && snapshot?.fundingRate != null ? '펀딩비: snapshot 자동 입력' : '펀딩비: 사용자 입력 보호',
      `시장 데이터: ${STATUS_LABEL[snapshot?.status ?? 'insufficient']}`,
    ];
    return entries.join(' · ');
  }, [entryTouched, fundingTouched, snapshot]);

  const applyMarketDefaults = () => {
    const entry = snapshot?.markPrice;
    if (entry == null || !Number.isFinite(entry) || entry <= 0) {
      setMessage('markPrice를 확인할 수 없어 시장값을 자동 채우지 못했습니다.');
      return;
    }
    const defaults = defaultsFor(side, entry);
    setEntryPrice(String(entry));
    setStopLossPrice(String(defaults.stop));
    setTargetPrice1(String(defaults.target1));
    setTargetPrice2(String(defaults.target2));
    setFundingRate(snapshot?.fundingRate == null ? '' : String(snapshot.fundingRate));
    setEntryTouched(false);
    setFundingTouched(false);
    setLevelsTouched(false);
    setResult(null);
    setMessage('markPrice 기준 예시값을 채웠습니다. 손절가와 목표가는 직접 확인하세요.');
  };

  const changeSide = (nextSide: TradeSide) => {
    setSide(nextSide);
    setResult(null);
    setMessage('');
    const entry = parseRequired(entryPrice);
    if (!levelsTouched && Number.isFinite(entry) && entry > 0) {
      const defaults = defaultsFor(nextSide, entry);
      setStopLossPrice(String(defaults.stop));
      setTargetPrice1(String(defaults.target1));
      setTargetPrice2(String(defaults.target2));
    }
  };

  const calculate = async () => {
    if (calculating) return;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    const sequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = sequence;
    setCalculating(true);
    setResult(null);
    setMessage('');
    try {
      const response = await previewTradingRisk({
        market: 'crypto-futures',
        symbol,
        side,
        accountBalance: parseRequired(accountBalance),
        entryPrice: parseRequired(entryPrice),
        stopLossPrice: parseRequired(stopLossPrice),
        targetPrice1: parseOptional(targetPrice1),
        targetPrice2: parseOptional(targetPrice2),
        leverage: parseRequired(leverage),
        riskPercent: parseRequired(riskPercent),
        entryFeeRate: parseRequired(entryFeeRate),
        exitFeeRate: parseRequired(exitFeeRate),
        slippageRate: parseRequired(slippageRate),
        estimatedFundingRate: parseRequired(fundingRate || '0'),
        quantityStep: trustedRules?.quantityStep ?? null,
        quantityPrecision: trustedRules?.quantityPrecision ?? null,
        minimumQuantity: trustedRules?.minimumQuantity ?? null,
        minimumNotional: trustedRules?.minimumNotional ?? null,
        maintenanceMarginRate: trustedRules?.maintenanceMarginRate ?? null,
        maximumLeverage: trustedRules?.maximumLeverage ?? null,
        appMaximumLeverage: APP_SAFE_MAXIMUM_LEVERAGE,
        contractRulesStatus: contractStatus,
        dailyRealizedPnl: parseRequired(dailyPnl),
        weeklyRealizedPnl: parseRequired(weeklyPnl),
        consecutiveLosses: parseRequired(consecutiveLosses),
        openExposure: parseRequired(openExposure),
        sameDirectionExposure: parseRequired(sameDirectionExposure),
        dataStatus: snapshot?.status ?? 'insufficient',
      }, controller.signal);
      if (sequence !== requestSequenceRef.current || controller.signal.aborted) return;
      setResult(response.result ?? null);
      setMessage(response.ok ? '리스크 미리보기를 계산했습니다.' : response.message ?? '입력값을 확인하세요.');
    } catch (error) {
      if (sequence !== requestSequenceRef.current || controller.signal.aborted) return;
      setResult(null);
      setMessage(error instanceof Error ? error.message : '리스크 미리보기 계산에 실패했습니다.');
    } finally {
      if (sequence === requestSequenceRef.current) setCalculating(false);
    }
  };

  return (
    <section className="min-w-0 rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="trading-risk-preview-panel">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-primary">
            <Calculator className="h-4 w-4 shrink-0" />
            <p className="text-[10px] font-black">선물·단타 공통 리스크 계산</p>
          </div>
          <h2 className="mt-1 truncate text-sm font-black">{symbol} 리스크 미리보기</h2>
          <p className="mt-1 text-[9px] font-bold leading-relaxed text-muted-foreground">
            분석용 리스크 미리보기입니다. 실제 주문은 전송되지 않습니다.
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[9px] font-black text-primary">
          preview-only
        </span>
      </div>

      <div className="mt-3 min-w-0 rounded-2xl border border-card-border bg-background p-3">
        <p className="text-[9px] font-black text-muted-foreground">시장값 자동 입력 상태</p>
        <p className="mt-1 break-words text-[9px] font-bold leading-relaxed">
          {snapshotLoading ? '시장 데이터를 확인 중입니다.' : autoFillLabel}
        </p>
        <button
          type="button"
          onClick={applyMarketDefaults}
          className="mt-2 min-h-10 rounded-xl border border-card-border px-3 py-2 text-[9px] font-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          markPrice 기준 예시값 다시 채우기
        </button>
      </div>

      <div className="mt-3 min-w-0 rounded-2xl border border-card-border bg-background p-3" data-testid="contract-rules-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            <p className="text-[10px] font-black">Bitget 공개 계약 규칙 · 읽기 전용</p>
          </div>
          <span className={cn('rounded-full border px-2.5 py-1 text-[9px] font-black', statusClass(contractStatus))}>
            {contractRulesLoading ? '불러오는 중' : STATUS_LABEL[contractStatus]}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">
          <Metric label="수량 단위" value={formatNumber(contractRules?.quantityStep, 12)} testId="quantity-step" />
          <Metric label="최소 수량" value={formatNumber(contractRules?.minimumQuantity, 12)} />
          <Metric label="최소 주문금액" value={contractRules?.minimumNotional == null ? '확인 불가' : formatMoney(contractRules.minimumNotional)} />
          <Metric label="가격 단위" value={formatNumber(contractRules?.priceStep, 12)} />
          <Metric label="거래소 최대 레버리지" value={contractRules?.maximumLeverage == null ? '확인 불가' : `${formatNumber(contractRules.maximumLeverage, 2)}배`} />
          <Metric label="앱 안전 레버리지" value={`최대 ${APP_SAFE_MAXIMUM_LEVERAGE}배`} />
          <Metric
            label="유지증거금률 출처"
            value={contractRules?.maintenanceMarginRate == null
              ? '거래소 값 미확인 · 앱 단순 근사'
              : `Bitget contracts · ${formatPercent(contractRules.maintenanceMarginRate * 100, 4)}`}
          />
          <Metric label="규칙 마지막 업데이트" value={formatDate(contractRules?.updatedAt)} />
        </div>
        {contractWarnings.length > 0 ? (
          <div className="mt-3 max-h-36 overflow-y-auto overscroll-contain rounded-xl border border-warning/25 bg-warning/10 p-3" role="status" aria-label="계약 규칙 경고">
            {contractWarnings.map((warning) => (
              <p key={warning} className="text-[9px] font-bold leading-relaxed text-warning">· {warning}</p>
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          aria-pressed={side === 'long'}
          onClick={() => changeSide('long')}
          className={cn('min-h-11 rounded-xl border text-[10px] font-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary', side === 'long' ? 'border-positive/40 bg-positive/10 text-positive' : 'border-card-border bg-background')}
        >
          롱
        </button>
        <button
          type="button"
          aria-pressed={side === 'short'}
          onClick={() => changeSide('short')}
          className={cn('min-h-11 rounded-xl border text-[10px] font-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary', side === 'short' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-card-border bg-background')}
        >
          숏
        </button>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 min-[380px]:grid-cols-2">
        <NumericField id="risk-account-balance" label="계좌 기준 금액 (USDT)" value={accountBalance} onChange={setAccountBalance} />
        <NumericField id="risk-leverage" label="레버리지 (배)" value={leverage} onChange={setLeverage} hint={`앱 안전 제한은 최대 ${APP_SAFE_MAXIMUM_LEVERAGE}배입니다.`} />
        <NumericField id="risk-entry-price" label="진입가 · markPrice 기준" value={entryPrice} onChange={(value) => { setEntryPrice(value); setEntryTouched(true); setResult(null); }} />
        <NumericField id="risk-stop-price" label="손절가" value={stopLossPrice} onChange={(value) => { setStopLossPrice(value); setLevelsTouched(true); setResult(null); }} />
        <NumericField id="risk-target-price-1" label="목표가 1" value={targetPrice1} onChange={(value) => { setTargetPrice1(value); setLevelsTouched(true); setResult(null); }} />
        <NumericField id="risk-target-price-2" label="목표가 2" value={targetPrice2} onChange={(value) => { setTargetPrice2(value); setLevelsTouched(true); setResult(null); }} />
        <NumericField id="risk-percent" label="1회 허용 위험률 (%)" value={riskPercent} onChange={setRiskPercent} hint="0.5는 0.5%이며, 1% 초과는 차단됩니다." />
        <NumericField id="risk-funding-rate" label="예상 펀딩비율 (소수)" value={fundingRate} onChange={(value) => { setFundingRate(value); setFundingTouched(true); }} allowNegative hint="0.0001은 0.01%입니다. 1회 예상값만 반영합니다." />
        <NumericField id="risk-entry-fee" label="진입 수수료율 (소수)" value={entryFeeRate} onChange={setEntryFeeRate} hint="0.0006은 0.06%입니다." />
        <NumericField id="risk-exit-fee" label="청산 수수료율 (소수)" value={exitFeeRate} onChange={setExitFeeRate} hint="손절가 기준으로 계산합니다." />
        <NumericField id="risk-slippage" label="슬리피지율 (소수)" value={slippageRate} onChange={setSlippageRate} hint="진입과 청산 양쪽에 보수적으로 반영합니다." />
        <NumericField id="risk-consecutive-losses" label="연속 손실 횟수" value={consecutiveLosses} onChange={setConsecutiveLosses} />
        <NumericField id="risk-daily-pnl" label="일일 실현손익" value={dailyPnl} onChange={setDailyPnl} allowNegative hint="손실은 음수로 입력합니다." />
        <NumericField id="risk-weekly-pnl" label="주간 실현손익" value={weeklyPnl} onChange={setWeeklyPnl} allowNegative hint="손실은 음수로 입력합니다." />
        <NumericField id="risk-open-exposure" label="현재 전체 명목 노출 (USDT)" value={openExposure} onChange={setOpenExposure} />
        <NumericField id="risk-direction-exposure" label="동일 방향 명목 노출 (USDT)" value={sameDirectionExposure} onChange={setSameDirectionExposure} />
      </div>

      <button
        type="button"
        onClick={() => void calculate()}
        disabled={calculating}
        aria-busy={calculating}
        className="mt-4 min-h-11 w-full rounded-2xl bg-primary px-4 text-[11px] font-black text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {calculating ? '계산 중…' : '리스크 미리보기 계산'}
      </button>

      {message ? (
        <p className="mt-2 text-[9px] font-bold leading-relaxed text-muted-foreground" role="status">
          {message}
        </p>
      ) : null}

      {result ? (
        <div className="mt-4 min-w-0 space-y-3" data-testid="risk-result">
          <div className={cn('rounded-2xl border p-3', result.allowed ? 'border-positive/30 bg-positive/10' : 'border-destructive/30 bg-destructive/10')} role="status">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 shrink-0" />
              <p className="text-[10px] font-black">{result.allowed ? '분석 시나리오 진입 가능' : '분석 시나리오 진입 차단'}</p>
            </div>
            <p className="mt-1 text-[9px] font-bold leading-relaxed">
              실제 주문 가능 여부가 아니라 입력값과 공개 시장 데이터에 대한 리스크 판정입니다.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">
            <Metric label="권장 수량" value={formatNumber(result.recommendedQuantity, 12)} testId="recommended-quantity" />
            <Metric label="적용 수량 단위" value={formatNumber(result.effectiveQuantityStep, 12)} />
            <Metric label="명목 금액" value={formatMoney(result.notionalValue)} />
            <Metric label="필요 증거금" value={formatMoney(result.requiredMargin)} />
            <Metric label="최대 허용손실" value={formatMoney(result.maximumRiskAmount)} />
            <Metric label="최대 예상손실" value={formatMoney(result.estimatedMaximumLoss)} />
            <Metric label="실제 위험률" value={formatPercent(result.actualRiskPercent)} />
            <Metric label="손익비 · 목표 1" value={formatNumber(result.riskReward1, 3)} />
            <Metric label="손익비 · 목표 2" value={formatNumber(result.riskReward2, 3)} />
            <Metric label="손익분기 가격" value={formatNumber(result.breakEvenPrice, 8)} />
            <Metric label="예상 청산가격 · 단순 근사" value={formatNumber(result.estimatedLiquidationPrice, 8)} />
            <Metric label="진입 수수료" value={formatMoney(result.estimatedEntryFee)} />
            <Metric label="손절 청산 수수료" value={formatMoney(result.estimatedExitFeeAtStop)} />
            <Metric label="예상 슬리피지" value={formatMoney(result.estimatedSlippageCost)} />
            <Metric label="예상 펀딩 비용" value={formatMoney(result.estimatedFundingCost)} />
          </div>

          {result.blockCodes.length > 0 ? (
            <div className="rounded-2xl border border-destructive/25 bg-destructive/10 p-3" role="alert" aria-label="리스크 차단 이유">
              <p className="text-[10px] font-black text-destructive">차단 이유</p>
              <div className="mt-1 max-h-40 space-y-1 overflow-y-auto overscroll-contain">
                {result.blockCodes.map((code) => (
                  <p key={code} className="text-[9px] font-bold leading-relaxed text-destructive">· {BLOCK_LABELS[code]}</p>
                ))}
              </div>
            </div>
          ) : null}

          {result.warnings.length > 0 ? (
            <div className="rounded-2xl border border-warning/25 bg-warning/10 p-3" role="status" aria-label="리스크 경고">
              <p className="text-[10px] font-black text-warning">경고</p>
              <div className="mt-1 max-h-48 space-y-1 overflow-y-auto overscroll-contain">
                {result.warnings.map((warning) => (
                  <p key={warning} className="text-[9px] font-bold leading-relaxed text-warning">· {warning}</p>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
