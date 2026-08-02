import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle, BarChart3, Loader2, PlayCircle, ShieldCheck } from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  runBacktest,
  type BacktestFormValues,
  type BacktestResult,
} from '@/lib/backtest';

const today = new Date();
const endDate = today.toISOString().slice(0, 10);
const start = new Date(today.getTime() - 30 * 24 * 60 * 60_000);
const startDate = start.toISOString().slice(0, 10);

const DEFAULT_VALUES: BacktestFormValues = {
  symbol: 'BTCUSDT', timeframe: '15m', startDate, endDate, initialCapital: 10_000,
  strategy: 'breakout', side: 'both', riskPercent: 0.5, leverage: 2,
  entryFeeRate: 0.0006, exitFeeRate: 0.0006, slippageRate: 0.0005,
  fundingRatePerInterval: 0.0001, fundingIntervalHours: 8,
  stopLossMode: 'percent', stopLossValue: 1,
  takeProfitMode: 'risk_multiple', takeProfitValue: 2,
  trailingEnabled: false, trailingActivationR: 1, trailingDistanceR: 0.5,
};

type Props = {
  execute?: (values: BacktestFormValues) => Promise<BacktestResult>;
  initialResult?: BacktestResult | null;
  compact?: boolean;
};

const numberFormatter = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });
const money = (value: number) => `${numberFormatter.format(value)} USDT`;
const percent = (value: number | null) => value == null ? '-' : `${numberFormatter.format(value)}%`;
const ratio = (value: number | null) => value == null ? '-' : numberFormatter.format(value);
const dateTime = (value: number) => new Date(value).toLocaleString('ko-KR', { timeZone: 'UTC' });

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-1 text-xs font-medium text-muted-foreground"><span>{label}</span>{children}</label>;
}

const inputClass = 'h-10 min-w-0 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';

function Metric({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return <div className="rounded-xl border border-border/70 bg-background/70 p-3"><div className="text-[11px] text-muted-foreground">{label}</div><div className="mt-1 break-words text-base font-semibold" data-testid={testId}>{value}</div></div>;
}

function CurveChart({ title, data, dataKey }: { title: string; data: Array<Record<string, number | string>>; dataKey: string }) {
  return <section className="rounded-2xl border border-border bg-card p-4" data-testid={`${dataKey}-chart`}>
    <h3 className="mb-3 text-sm font-semibold">{title}</h3>
    {data.length === 0 ? <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">표시할 데이터가 없습니다.</div> : <div className="h-56 w-full min-w-0"><ResponsiveContainer width="100%" height="100%"><LineChart data={data} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="label" minTickGap={24} fontSize={10} /><YAxis width={58} fontSize={10} domain={['auto', 'auto']} /><Tooltip /><Line type="monotone" dataKey={dataKey} stroke="currentColor" dot={false} isAnimationActive={false} /></LineChart></ResponsiveContainer></div>}
  </section>;
}

export function BacktestResearchPanel({ execute = runBacktest, initialResult = null, compact = false }: Props) {
  const [values, setValues] = useState(DEFAULT_VALUES);
  const [result, setResult] = useState<BacktestResult | null>(initialResult);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const update = <K extends keyof BacktestFormValues>(key: K, value: BacktestFormValues[K]) => setValues((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError(''); setResult(null);
    try { setResult(await execute(values)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '백테스트를 실행하지 못했습니다.'); }
    finally { setLoading(false); }
  }

  const equityData = useMemo(() => result?.equityCurve.map((point) => ({ label: new Date(point.timestamp).toISOString().slice(5, 16).replace('T', ' '), equity: Number(point.equity.toFixed(2)) })) ?? [], [result]);
  const drawdownData = useMemo(() => result?.drawdownCurve.map((point) => ({ label: new Date(point.timestamp).toISOString().slice(5, 16).replace('T', ' '), drawdownPercent: Number(point.drawdownPercent.toFixed(2)) })) ?? [], [result]);

  return <main className="h-full overflow-y-auto overscroll-contain pb-28" data-testid="backtest-page">
    <div className={`mx-auto w-full ${compact ? 'max-w-5xl' : 'max-w-6xl'} space-y-4 px-4 py-5 sm:px-5`}>
      <header className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-start gap-3"><div className="rounded-xl bg-primary/10 p-2 text-primary"><BarChart3 className="h-5 w-5" /></div><div className="min-w-0"><h1 className="text-lg font-bold">코인 선물 백테스트 연구</h1><p className="mt-1 text-xs leading-5 text-muted-foreground">완료 봉 신호를 계산하고 다음 봉 시가부터 체결합니다. 실제 주문 기능과 분리된 읽기 전용 분석입니다.</p></div></div>
        <div className="mt-3 grid gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5" role="status"><p>과거 데이터 기반 백테스트이며 미래 수익을 보장하지 않습니다.</p><p>수수료·슬리피지·펀딩비와 보수적인 봉 내부 체결 가정을 반영합니다.</p></div>
      </header>

      <form onSubmit={submit} className="rounded-2xl border border-border bg-card p-4" aria-busy={loading} data-testid="backtest-form">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="종목"><input id="backtest-symbol" aria-label="종목" className={inputClass} value={values.symbol} onChange={(event) => update('symbol', event.target.value.toUpperCase())} /></Field>
          <Field label="시간봉"><select id="backtest-timeframe" aria-label="시간봉" className={inputClass} value={values.timeframe} onChange={(event) => update('timeframe', event.target.value)}>{['1m', '5m', '15m', '30m', '1H', '4H', '1D'].map((item) => <option key={item}>{item}</option>)}</select></Field>
          <Field label="시작일"><input id="backtest-start" aria-label="시작일" className={inputClass} type="date" value={values.startDate} onChange={(event) => update('startDate', event.target.value)} /></Field>
          <Field label="종료일"><input id="backtest-end" aria-label="종료일" className={inputClass} type="date" value={values.endDate} onChange={(event) => update('endDate', event.target.value)} /></Field>
          <Field label="초기 자본"><input aria-label="초기 자본" className={inputClass} type="number" min="1" step="100" inputMode="decimal" value={values.initialCapital} onChange={(event) => update('initialCapital', Number(event.target.value))} /></Field>
          <Field label="전략"><select id="backtest-strategy" aria-label="전략" className={inputClass} value={values.strategy} onChange={(event) => update('strategy', event.target.value as BacktestFormValues['strategy'])}><option value="trend_pullback">추세 눌림목</option><option value="breakout">고점·저점 돌파</option><option value="vwap_reclaim">UTC VWAP 회복</option></select></Field>
          <Field label="방향"><select aria-label="방향" className={inputClass} value={values.side} onChange={(event) => update('side', event.target.value as BacktestFormValues['side'])}><option value="both">롱·숏</option><option value="long">롱</option><option value="short">숏</option></select></Field>
          <Field label="위험률 %"><input aria-label="위험률" className={inputClass} type="number" min="0.01" max="1" step="0.01" inputMode="decimal" value={values.riskPercent} onChange={(event) => update('riskPercent', Number(event.target.value))} /></Field>
          <Field label="레버리지"><input aria-label="레버리지" className={inputClass} type="number" min="1" max="10" step="1" inputMode="decimal" value={values.leverage} onChange={(event) => update('leverage', Number(event.target.value))} /></Field>
          <Field label="진입 수수료"><input aria-label="진입 수수료" className={inputClass} type="number" min="0" step="0.0001" inputMode="decimal" value={values.entryFeeRate} onChange={(event) => update('entryFeeRate', Number(event.target.value))} /></Field>
          <Field label="청산 수수료"><input aria-label="청산 수수료" className={inputClass} type="number" min="0" step="0.0001" inputMode="decimal" value={values.exitFeeRate} onChange={(event) => update('exitFeeRate', Number(event.target.value))} /></Field>
          <Field label="슬리피지"><input aria-label="슬리피지" className={inputClass} type="number" min="0" step="0.0001" inputMode="decimal" value={values.slippageRate} onChange={(event) => update('slippageRate', Number(event.target.value))} /></Field>
          <Field label="펀딩비/구간"><input aria-label="펀딩비" className={inputClass} type="number" step="0.0001" inputMode="decimal" value={values.fundingRatePerInterval} onChange={(event) => update('fundingRatePerInterval', Number(event.target.value))} /></Field>
          <Field label="펀딩 간격(시간)"><input aria-label="펀딩 간격" className={inputClass} type="number" min="1" step="1" inputMode="decimal" value={values.fundingIntervalHours} onChange={(event) => update('fundingIntervalHours', Number(event.target.value))} /></Field>
          <Field label="손절 방식"><select aria-label="손절 방식" className={inputClass} value={values.stopLossMode} onChange={(event) => update('stopLossMode', event.target.value as BacktestFormValues['stopLossMode'])}><option value="percent">퍼센트</option><option value="atr">ATR</option><option value="swing">스윙</option></select></Field>
          <Field label="손절 값"><input aria-label="손절 값" className={inputClass} type="number" min="0.01" step="0.1" inputMode="decimal" value={values.stopLossValue} onChange={(event) => update('stopLossValue', Number(event.target.value))} /></Field>
          <Field label="목표 방식"><select aria-label="목표 방식" className={inputClass} value={values.takeProfitMode} onChange={(event) => update('takeProfitMode', event.target.value as BacktestFormValues['takeProfitMode'])}><option value="risk_multiple">위험 배수</option><option value="percent">퍼센트</option></select></Field>
          <Field label="목표 값"><input aria-label="목표 값" className={inputClass} type="number" min="0.01" step="0.1" inputMode="decimal" value={values.takeProfitValue} onChange={(event) => update('takeProfitValue', Number(event.target.value))} /></Field>
        </div>
        <label className="mt-3 flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm"><input type="checkbox" checked={values.trailingEnabled} onChange={(event) => update('trailingEnabled', event.target.checked)} />트레일링 스톱 사용</label>
        <button type="submit" disabled={loading} className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-60" data-testid="run-backtest">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}{loading ? '백테스트 계산 중' : '백테스트 실행'}</button>
      </form>

      {error ? <div className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm" role="alert" data-testid="backtest-error"><AlertTriangle className="mr-2 inline h-4 w-4" />{error}</div> : null}

      {result ? <div className="space-y-4" data-testid="backtest-results">
        <section className="rounded-2xl border border-border bg-card p-4"><div className="mb-3 flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-emerald-500" /><h2 className="text-sm font-semibold">비용 차감 후 성과</h2></div><div className="grid grid-cols-2 gap-2 md:grid-cols-4"><Metric label="총 수익률" value={percent(result.totalReturnPercent)} testId="total-return" /><Metric label="최종 자산" value={money(result.finalCapital)} /><Metric label="거래 수" value={`${result.totalTrades}회`} testId="total-trades" /><Metric label="승률" value={percent(result.winRate)} /><Metric label="기대값" value={money(result.expectancy)} /><Metric label="Profit Factor" value={ratio(result.profitFactor)} /><Metric label="최대 낙폭" value={`${money(result.maximumDrawdown)} · ${percent(result.maximumDrawdownPercent)}`} /><Metric label="평균 R" value={ratio(result.averageRMultiple)} /><Metric label="Sharpe" value={ratio(result.sharpeRatio)} /><Metric label="Sortino" value={ratio(result.sortinoRatio)} /><Metric label="Calmar" value={ratio(result.calmarRatio)} /><Metric label="비용 합계" value={money(result.totalFees + result.totalSlippage + result.totalFunding)} /></div></section>
        <CurveChart title="실현 자산 곡선" data={equityData} dataKey="equity" />
        <CurveChart title="드로다운 곡선 (%)" data={drawdownData} dataKey="drawdownPercent" />
        <section className="rounded-2xl border border-border bg-card p-4" data-testid="validation-results"><h3 className="mb-3 text-sm font-semibold">학습·검증·테스트 구간</h3><div className="grid gap-2 sm:grid-cols-3">{result.validationPerformance.map((item) => <div key={item.name} className="rounded-xl border border-border p-3 text-xs"><div className="font-semibold uppercase">{item.name}</div><div className="mt-2 grid gap-1 text-muted-foreground"><span>거래 {item.trades}회</span><span>순손익 {money(item.netPnl)}</span><span>낙폭 {percent(item.maximumDrawdownPercent)}</span></div></div>)}</div></section>
        <section className="rounded-2xl border border-border bg-card p-4"><h3 className="mb-3 text-sm font-semibold">거래 목록</h3><div className="max-h-96 overflow-auto rounded-xl border border-border" data-testid="trade-list"><table className="w-full min-w-[760px] text-left text-xs"><thead className="sticky top-0 bg-muted"><tr><th className="p-2">진입</th><th className="p-2">방향</th><th className="p-2">진입가</th><th className="p-2">청산가</th><th className="p-2">순손익</th><th className="p-2">R</th><th className="p-2">종료</th><th className="p-2">시장 상태</th></tr></thead><tbody>{result.trades.length ? result.trades.map((trade) => <tr key={trade.id} className="border-t border-border"><td className="p-2 whitespace-nowrap">{dateTime(trade.entryTime)}</td><td className="p-2">{trade.side}</td><td className="p-2">{numberFormatter.format(trade.entryPrice)}</td><td className="p-2">{numberFormatter.format(trade.exitPrice)}</td><td className="p-2">{money(trade.netPnl)}</td><td className="p-2">{numberFormatter.format(trade.rMultiple)}</td><td className="p-2">{trade.exitReason}</td><td className="p-2">{trade.marketRegime}</td></tr>) : <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">조건에 맞는 거래가 없습니다.</td></tr>}</tbody></table></div></section>
        <section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4" role="status" data-testid="backtest-warnings"><h3 className="mb-2 text-sm font-semibold">가정과 경고</h3><ul className="grid gap-1 text-xs leading-5">{result.warnings.map((warning) => <li key={warning}>• {warning}</li>)}</ul></section>
      </div> : null}
    </div>
  </main>;
}
