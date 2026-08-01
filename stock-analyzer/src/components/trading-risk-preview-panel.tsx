import { useEffect, useMemo, useState } from 'react';
import { Calculator, ShieldAlert } from 'lucide-react';
import type { FuturesMarketSnapshot } from '@/lib/futures-market-data';
import {
  previewTradingRisk,
  type RiskBlockCode,
  type RiskEngineResult,
  type TradeSide,
} from '@/lib/trading-risk';
import { cn } from '@/lib/utils';

type Props = {
  symbol: string;
  snapshot?: FuturesMarketSnapshot;
  snapshotLoading?: boolean;
};

type FieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
};

const BLOCK_LABELS: Record<RiskBlockCode, string> = {
  INVALID_ACCOUNT_BALANCE: '계좌 기준 금액이 올바르지 않습니다.',
  INVALID_ENTRY_PRICE: '진입가가 올바르지 않습니다.',
  INVALID_STOP_LOSS: '손절가 방향 또는 값이 올바르지 않습니다.',
  INVALID_TARGET_PRICE: '목표가 방향 또는 값이 올바르지 않습니다.',
  INVALID_LEVERAGE: '레버리지는 1 이상이어야 합니다.',
  INVALID_RISK_PERCENT: '1회 허용 위험률은 0% 초과 1% 이하여야 합니다.',
  INVALID_COST_RATE: '수수료·슬리피지·펀딩비율을 확인하세요.',
  DATA_NOT_LIVE: '실시간 데이터가 아니므로 진입 가능 판정을 차단했습니다.',
  RISK_REWARD_TOO_LOW: '순손익 기준 손익비가 1.0 미만입니다.',
  DAILY_LOSS_LIMIT: '일일 손실 한도에 도달했습니다.',
  WEEKLY_LOSS_LIMIT: '주간 손실 한도에 도달했습니다.',
  CONSECUTIVE_LOSS_LIMIT: '연속 손실 차단 기준에 도달했습니다.',
  MINIMUM_QUANTITY: '거래소 최소 수량을 충족하지 못합니다.',
  MINIMUM_NOTIONAL: '거래소 최소 명목금액을 충족하지 못합니다.',
  EXPOSURE_LIMIT: '전체 또는 동일 방향 명목 노출 한도를 초과합니다.',
  LIQUIDATION_TOO_CLOSE: '손절가가 예상 청산가격보다 불리하거나 너무 가깝습니다.',
};

function NumericField({ label, value, onChange, placeholder, hint }: FieldProps) {
  return (
    <label className="block min-w-0">
      <span className="text-[9px] font-black text-muted-foreground">{label}</span>
      <input
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="mt-1 h-10 w-full rounded-xl border border-card-border bg-background px-3 text-[11px] font-bold outline-none focus:border-primary"
      />
      {hint ? <span className="mt-1 block text-[8px] font-semibold leading-relaxed text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-card-border bg-background p-3">
      <p className="text-[9px] font-black text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-[11px] font-black">{value}</p>
    </div>
  );
}

function parseRequired(value: string) {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function parseOptional(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : Number.NaN;
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

export function TradingRiskPreviewPanel({ symbol, snapshot, snapshotLoading = false }: Props) {
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
  const [result, setResult] = useState<RiskEngineResult | null>(null);
  const [message, setMessage] = useState('');
  const [calculating, setCalculating] = useState(false);

  useEffect(() => {
    setEntryTouched(false);
    setFundingTouched(false);
    setEntryPrice('');
    setStopLossPrice('');
    setTargetPrice1('');
    setTargetPrice2('');
    setFundingRate('');
    setResult(null);
    setMessage('');
  }, [symbol]);

  useEffect(() => {
    const markPrice = snapshot?.markPrice;
    if (!entryTouched && !entryPrice && markPrice != null && Number.isFinite(markPrice) && markPrice > 0) {
      const defaults = defaultsFor(side, markPrice);
      setEntryPrice(String(markPrice));
      setStopLossPrice(String(defaults.stop));
      setTargetPrice1(String(defaults.target1));
      setTargetPrice2(String(defaults.target2));
    }
    const rate = snapshot?.fundingRate;
    if (!fundingTouched && !fundingRate && rate != null && Number.isFinite(rate)) {
      setFundingRate(String(rate));
    }
  }, [entryPrice, entryTouched, fundingRate, fundingTouched, side, snapshot]);

  const autoFillLabel = useMemo(() => {
    const entries = [
      !entryTouched && snapshot?.markPrice != null ? '진입가: markPrice' : '진입가: 사용자 입력',
      !fundingTouched && snapshot?.fundingRate != null ? '펀딩비: snapshot' : '펀딩비: 사용자 입력',
      `데이터 상태: ${snapshot?.status ?? 'insufficient'}`,
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
    setResult(null);
    setMessage('markPrice 기준 예시값을 채웠습니다. 손절가와 목표가는 직접 확인하세요.');
  };

  const calculate = async () => {
    setCalculating(true);
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
        quantityStep: null,
        minimumQuantity: null,
        minimumNotional: null,
        maintenanceMarginRate: null,
        dailyRealizedPnl: parseRequired(dailyPnl),
        weeklyRealizedPnl: parseRequired(weeklyPnl),
        consecutiveLosses: parseRequired(consecutiveLosses),
        openExposure: parseRequired(openExposure),
        sameDirectionExposure: parseRequired(sameDirectionExposure),
        dataStatus: snapshot?.status ?? 'insufficient',
      });
      setResult(response.result ?? null);
      setMessage(response.ok ? '리스크 미리보기를 계산했습니다.' : response.message ?? '입력값을 확인하세요.');
    } catch (error) {
      setResult(null);
      setMessage(error instanceof Error ? error.message : '리스크 미리보기 계산에 실패했습니다.');
    } finally {
      setCalculating(false);
    }
  };

  return (
    <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-primary">
            <Calculator className="h-4 w-4" />
            <p className="text-[10px] font-black">선물·단타 공통 리스크 계산</p>
          </div>
          <h2 className="mt-1 text-sm font-black">{symbol} 리스크 미리보기</h2>
          <p className="mt-1 text-[9px] font-bold leading-relaxed text-muted-foreground">
            분석용 리스크 미리보기입니다. 실제 주문은 전송되지 않습니다.
          </p>
        </div>
        <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[9px] font-black text-primary">
          preview-only
        </span>
      </div>

      <div className="mt-3 rounded-2xl border border-card-border bg-background p-3">
        <p className="text-[9px] font-black text-muted-foreground">시장값 자동 채움</p>
        <p className="mt-1 text-[9px] font-bold leading-relaxed">{snapshotLoading ? '시장 데이터를 확인 중입니다.' : autoFillLabel}</p>
        <button
          type="button"
          onClick={applyMarketDefaults}
          className="mt-2 rounded-xl border border-card-border px-3 py-2 text-[9px] font-black"
        >
          markPrice 기준 예시값 다시 채우기
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => { setSide('long'); setResult(null); }}
          className={cn('h-10 rounded-xl border text-[10px] font-black', side === 'long' ? 'border-positive/40 bg-positive/10 text-positive' : 'border-card-border bg-background')}
        >
          롱
        </button>
        <button
          type="button"
          onClick={() => { setSide('short'); setResult(null); }}
          className={cn('h-10 rounded-xl border text-[10px] font-black', side === 'short' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-card-border bg-background')}
        >
          숏
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <NumericField label="계좌 기준 금액 (USDT)" value={accountBalance} onChange={setAccountBalance} />
        <NumericField label="레버리지 (배)" value={leverage} onChange={setLeverage} />
        <NumericField
          label="진입가 · markPrice 기준"
          value={entryPrice}
          onChange={(value) => { setEntryPrice(value); setEntryTouched(true); setResult(null); }}
        />
        <NumericField label="손절가" value={stopLossPrice} onChange={(value) => { setStopLossPrice(value); setResult(null); }} />
        <NumericField label="목표가 1" value={targetPrice1} onChange={(value) => { setTargetPrice1(value); setResult(null); }} />
        <NumericField label="목표가 2" value={targetPrice2} onChange={(value) => { setTargetPrice2(value); setResult(null); }} />
        <NumericField
          label="1회 허용 위험률 (%)"
          value={riskPercent}
          onChange={setRiskPercent}
          hint="0.5는 0.5%이며, 1% 초과는 차단됩니다."
        />
        <NumericField
          label="예상 펀딩비율 (소수)"
          value={fundingRate}
          onChange={(value) => { setFundingRate(value); setFundingTouched(true); }}
          hint="0.0001은 0.01%입니다. 1회 예상값만 반영합니다."
        />
        <NumericField label="진입 수수료율 (소수)" value={entryFeeRate} onChange={setEntryFeeRate} hint="0.0006은 0.06%입니다." />
        <NumericField label="청산 수수료율 (소수)" value={exitFeeRate} onChange={setExitFeeRate} hint="손절가 기준으로 계산합니다." />
        <NumericField label="슬리피지율 (소수)" value={slippageRate} onChange={setSlippageRate} hint="진입과 청산 양쪽에 보수적으로 반영합니다." />
        <NumericField label="연속 손실 횟수" value={consecutiveLosses} onChange={setConsecutiveLosses} />
        <NumericField label="일일 실현손익" value={dailyPnl} onChange={setDailyPnl} hint="손실은 음수로 입력합니다." />
        <NumericField label="주간 실현손익" value={weeklyPnl} onChange={setWeeklyPnl} hint="손실은 음수로 입력합니다." />
        <NumericField label="현재 전체 명목 노출" value={openExposure} onChange={setOpenExposure} />
        <NumericField label="동일 방향 명목 노출" value={sameDirectionExposure} onChange={setSameDirectionExposure} />
      </div>

      <button
        type="button"
        onClick={() => void calculate()}
        disabled={calculating}
        className="mt-4 h-11 w-full rounded-2xl bg-primary text-[11px] font-black text-primary-foreground disabled:opacity-60"
      >
        {calculating ? '계산 중…' : '리스크 미리보기 계산'}
      </button>

      {message ? <p className="mt-2 text-[9px] font-bold leading-relaxed text-muted-foreground">{message}</p> : null}

      {result ? (
        <div className="mt-4 space-y-3">
          <div className={cn('rounded-2xl border p-3', result.allowed ? 'border-positive/30 bg-positive/10' : 'border-destructive/30 bg-destructive/10')}>
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4" />
              <p className="text-[10px] font-black">{result.allowed ? '분석 시나리오 진입 가능' : '분석 시나리오 진입 차단'}</p>
            </div>
            <p className="mt-1 text-[9px] font-bold leading-relaxed">
              실제 주문 가능 여부가 아니라 입력값과 시장 데이터에 대한 리스크 판정입니다.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Metric label="권장 수량" value={formatNumber(result.recommendedQuantity, 8)} />
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
            <div className="rounded-2xl border border-destructive/25 bg-destructive/10 p-3">
              <p className="text-[10px] font-black text-destructive">차단 이유</p>
              <div className="mt-1 space-y-1">
                {result.blockCodes.map((code) => (
                  <p key={code} className="text-[9px] font-bold leading-relaxed text-destructive">· {BLOCK_LABELS[code]}</p>
                ))}
              </div>
            </div>
          ) : null}

          {result.warnings.length > 0 ? (
            <div className="rounded-2xl border border-warning/25 bg-warning/10 p-3">
              <p className="text-[10px] font-black text-warning">경고</p>
              <div className="mt-1 space-y-1">
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
