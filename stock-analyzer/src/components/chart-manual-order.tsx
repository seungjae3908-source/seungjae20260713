import { useEffect, useRef, useState } from 'react';
import { authorizedFetch } from '@/lib/auth-fetch';
import type { AnalysisSelection } from '@/lib/analysis-selection';
import { formatChartMoney, nativeChartCurrency } from '@/lib/chart-currency';
import { TradeApprovalQueue } from './trade-approval-queue';
import { useChartCurrency } from './chart-currency-provider';

type IntentSide = 'buy' | 'sell' | 'long' | 'short';
type NativePlan = { id: string; symbol: string; market: string; exchange: string; side: string; orderType: string; quantity: number; limitPrice: number; leverage: number | null; reduceOnly: boolean; state: string; executionMode: string; accountMode: string; approvalExpiresAt: string };
type Conversion = { currency: string; krwRate: number; source: string; asOf: string };
const orderErrorLabels: Record<string, string> = {
  MANUAL_ORDER_MARKET_VERIFICATION_REQUIRED: '시장가 실주문 연결 검증 미완료 · 전송 금지',
  MANUAL_ORDER_FRESH_FX_REQUIRED: '최근 환율 확인 필요',
  MANUAL_ORDER_QUANTITY_RULES_REQUIRED: '거래소 수량 단위 확인 필요',
  MANUAL_ORDER_AMOUNT_INVALID: '주문 가능한 수량·금액을 확인해 주세요',
  MANUAL_ORDER_EXIT_PLAN_REQUIRED: '가격에 맞는 손절·목표 기준을 입력해 주세요',
  MANUAL_ORDER_LEVERAGE_POLICY_LIMIT: '계좌에서 허용한 레버리지를 초과했습니다',
  LIVE_EXECUTION_CONNECTION_NOT_CONFIGURED: '실계좌 연결이 필요합니다',
  LIVE_EXECUTION_CONNECTION_NOT_VERIFIED: '실계좌 연결 검증이 필요합니다',
  RISK_CHECK_BLOCKED: '서버 안전 규칙에 따라 주문 초안이 차단됐습니다',
  CAPABILITY_REQUIRED: '실주문 이용 권한이 필요합니다',
};

/** Remount for each instrument; no order is submitted by this composer. */
export function ChartManualOrder({ selection, nativePrice }: { selection: AnalysisSelection; nativePrice: number | null }) {
  const futures = selection.market === 'BITGET';
  const [provider, setProvider] = useState(selection.market === 'UPBIT' ? 'upbit' : futures ? 'bitget' : selection.market === 'US' ? 'kiwoom' : 'toss');
  const [side, setSide] = useState<IntentSide>(futures ? 'long' : 'buy');
  const [quantity, setQuantity] = useState('');
  const [budget, setBudget] = useState('');
  const [orderType, setOrderType] = useState<'limit' | 'market'>('limit');
  const [sizeMode, setSizeMode] = useState<'quantity' | 'amount'>('quantity');
  const [price, setPrice] = useState('');
  const [stop, setStop] = useState('');
  const [target, setTarget] = useState('');
  const [leverage, setLeverage] = useState('2');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [stockExchange, setStockExchange] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [plan, setPlan] = useState<NativePlan | null>(null);
  const [conversion, setConversion] = useState<Conversion | null>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const lock = useRef(false);
  const currency = nativeChartCurrency(selection.market);
  const { display, inputRate } = useChartCurrency();
  const inputCurrency = display === 'KRW' ? 'KRW' : currency;
  const priorCurrency = useRef({ inputCurrency, inputRate });
  useEffect(() => {
    const prior = priorCurrency.current;
    priorCurrency.current = { inputCurrency, inputRate };
    if (prior.inputCurrency === inputCurrency || plan) return;
    const convert = (value: string) => !value || !Number.isFinite(Number(value)) ? value : String(Number((Number(value) * inputRate / prior.inputRate).toPrecision(12)));
    setBudget(convert); setPrice(convert); setStop(convert); setTarget(convert);
  }, [inputCurrency, inputRate, plan]);
  const exit = futures ? reduceOnly : side === 'sell';
  const chosenPrice = orderType === 'market' ? nativePrice == null ? null : nativePrice * inputRate : price ? Number(price) : null;
  const amount = Number(quantity);
  const sizeValue = sizeMode === 'quantity' ? amount : Number(budget);
  const inputReady = chosenPrice != null && chosenPrice > 0 && Number.isFinite(chosenPrice) && Number.isFinite(sizeValue) && sizeValue > 0
    && (exit || (Number(stop) > 0 && Number(target) > 0)) && !(provider === 'kiwoom' && selection.market === 'US' && !stockExchange);
  const displayedNotional = sizeMode === 'amount' ? Number(budget) : amount * (chosenPrice ?? 0);
  const inputClass = 'h-11 w-full min-w-0 rounded-xl border border-card-border bg-background px-3 text-sm tabular-nums outline-none focus:border-primary disabled:opacity-50';
  const sideLabel = (value: string) => ({ buy: '매수', sell: '매도', long: '롱', short: '숏' }[value] ?? value);
  const preview = async () => {
    if (lock.current || !inputReady || plan) return;
    lock.current = true; setLoading(true); setMessage('');
    const intendedSymbol = selection.market === 'UPBIT' ? `KRW-${selection.ticker.replace(/^KRW-/, '')}` : selection.ticker;
    try {
      const response = await authorizedFetch('/api/trade-automation/chart/manual-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        requestId, exchange: provider, market: selection.market, symbol: selection.ticker, side, orderType, sizeMode, inputCurrency,
        ...(sizeMode === 'quantity' ? { quantity: amount } : { amount: Number(budget) }),
        ...(orderType === 'limit' ? { limitPrice: chosenPrice } : {}),
        stopPrice: Number(stop), targetPrice: Number(target), leverage: futures ? Number(leverage) : null, reduceOnly: exit, stockExchange: stockExchange || undefined,
      }) });
      const result = await response.json() as { ok?: boolean; error?: string; plan?: NativePlan; conversion?: Conversion | null; inputCurrency?: string; orderSubmitted?: boolean; automaticExecutionTriggered?: boolean; requiresExplicitApproval?: boolean; decision?: { blockCodes?: string[] } };
      if (!response.ok || !result.ok) throw new Error(result.error ? orderErrorLabels[result.error] ?? result.error : '서버 검증 실패');
      const basis = result.conversion;
      const foreignKrw = inputCurrency === 'KRW' && currency !== 'KRW';
      if (foreignKrw && (!basis || basis.currency !== currency || !basis.source || !Number.isFinite(basis.krwRate) || basis.krwRate <= 0 || !Number.isFinite(Date.parse(basis.asOf)) || Date.now() - Date.parse(basis.asOf) > 600_000 || Date.parse(basis.asOf) - Date.now() > 5_000)) throw new Error('주문 환율 확인 실패 · 전송 금지');
      const divisor = foreignKrw ? basis!.krwRate : 1;
      const expectedPrice = chosenPrice! / divisor;
      const returned = result.plan;
      if (!returned || !/^[0-9a-f-]{36}$/i.test(returned.id) || returned.exchange !== provider || returned.market !== (selection.market === 'UPBIT' ? 'KRW' : futures ? 'USDT-FUTURES' : selection.market) || returned.symbol !== intendedSymbol || returned.side !== side
        || returned.orderType !== orderType || result.inputCurrency !== inputCurrency
        || !Number.isFinite(returned.quantity) || returned.quantity <= 0 || (sizeMode === 'quantity' ? returned.quantity !== amount : returned.quantity * returned.limitPrice > Number(budget) / divisor + 1e-9)
        || Math.abs(returned.limitPrice - expectedPrice) > Math.max(1e-10, expectedPrice * 1e-10) || (futures && returned.leverage !== Number(leverage)) || returned.reduceOnly !== exit
        || returned.accountMode !== 'live' || returned.executionMode !== 'manual' || returned.state !== 'APPROVAL_PENDING'
        || !Number.isFinite(Date.parse(returned.approvalExpiresAt)) || result.orderSubmitted !== false || result.automaticExecutionTriggered !== false || result.requiresExplicitApproval !== true) throw new Error('주문 초안 확인 실패 · 전송 금지');
      setConversion(basis ?? null); setPlan(returned); setMessage('초안 준비 완료 · 아래에서 최종 승인');
    } catch (error) {
      setMessage(`주문 초안 미확인 · ${error instanceof Error ? error.message : '응답 확인 필요'}`);
    } finally { lock.current = false; setLoading(false); }
  };
  const locked = loading || !!plan;
  if (plan) return <section data-testid="chart-manual-order" className="rounded-2xl border border-card-border bg-card p-4">
    <h3 className="text-sm font-black">최종 주문 확인</h3>
    <p className="mt-3 text-sm">{sideLabel(plan.side)} · 지정가 {formatChartMoney(plan.limitPrice, selection.market)} · 수량 {plan.quantity.toLocaleString('ko-KR', { maximumFractionDigits: 8 })}</p>
    <p className="mt-2 text-xs">실제 결제 통화 {currency} · 주문 금액 {formatChartMoney(plan.quantity * plan.limitPrice, selection.market)}</p>
    {conversion && <p className="mt-2 text-xs text-muted-foreground">적용 환율 1 {conversion.currency} = {conversion.krwRate.toLocaleString('ko-KR')}원 · {new Date(conversion.asOf).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} · {conversion.source}</p>}
    <p role="status" className="mt-3 text-xs">{message}</p>
    <div className="mt-3"><TradeApprovalQueue key={plan.id} symbolFilter={plan.symbol} exchangeFilter={provider as 'toss' | 'kiwoom' | 'upbit' | 'bitget'} compact /></div>
  </section>;
  return <section data-testid="chart-manual-order" className="rounded-2xl border border-card-border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-black">{futures ? '선물 주문' : '매수·매도'}</h3><span className="text-xs text-muted-foreground">실계좌 · 입력 {inputCurrency}</span></div>
    {!futures && selection.market !== 'UPBIT' && <div className="mt-3 flex gap-2">{(selection.market === 'US' ? ['kiwoom'] as const : ['toss', 'kiwoom'] as const).map(value => <button key={value} type="button" disabled={locked} aria-pressed={provider === value} onClick={() => setProvider(value)} className={`min-h-10 rounded-xl border px-3 text-xs ${provider === value ? 'border-primary text-primary' : 'border-card-border'}`}>{value === 'toss' ? '토스증권' : '키움증권'}</button>)}</div>}
    <div className="mt-3 grid grid-cols-2 gap-2" role="group" aria-label="주문 방향">{(futures ? ['long', 'short'] : ['buy', 'sell']).map(value => <button key={value} type="button" disabled={locked} aria-pressed={side === value} onClick={() => setSide(value as IntentSide)} className={`min-h-11 rounded-xl border text-sm font-bold ${side === value ? value === 'buy' || value === 'long' ? 'border-red-500 bg-red-500/10 text-red-500' : 'border-blue-500 bg-blue-500/10 text-blue-500' : 'border-card-border text-muted-foreground'}`}>{sideLabel(value)}</button>)}</div>
    <div className="mt-3 grid grid-cols-2 gap-3">
      <div role="group" aria-label="주문 유형" className="grid grid-cols-2 gap-1">{(['limit', 'market'] as const).map(value => <button type="button" key={value} disabled={locked} aria-pressed={orderType === value} onClick={() => setOrderType(value)} className={`min-h-10 rounded-lg border px-2 text-xs font-bold ${orderType === value ? 'border-primary bg-primary/10 text-primary' : 'border-card-border'}`}>{value === 'limit' ? '지정가' : '시장가'}</button>)}</div>
      <div role="group" aria-label="주문 입력 기준" className="grid grid-cols-2 gap-1">{(['quantity', 'amount'] as const).map(value => <button type="button" key={value} disabled={locked} aria-pressed={sizeMode === value} onClick={() => setSizeMode(value)} className={`min-h-10 rounded-lg border px-2 text-xs font-bold ${sizeMode === value ? 'border-primary bg-primary/10 text-primary' : 'border-card-border'}`}>{value === 'quantity' ? '수량' : '금액'}</button>)}</div>
    </div>
    <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {sizeMode === 'quantity' ? <label className="min-w-0 text-xs text-muted-foreground">수량<input aria-label="주문 수량" inputMode="decimal" disabled={locked} value={quantity} onChange={event => setQuantity(event.target.value)} className={inputClass} /></label> : <label className="min-w-0 text-xs text-muted-foreground">{futures ? '주문 규모' : '금액'} ({inputCurrency})<input aria-label="주문 금액" inputMode="decimal" disabled={locked} value={budget} onChange={event => setBudget(event.target.value)} className={inputClass} /></label>}
      {orderType === 'limit' && <label className="min-w-0 text-xs text-muted-foreground">지정가 ({inputCurrency})<input aria-label="주문 지정가" inputMode="decimal" disabled={locked} value={price} placeholder={nativePrice == null ? '가격 입력' : (nativePrice * inputRate).toString()} onChange={event => setPrice(event.target.value)} className={inputClass} /></label>}
      {!exit && <><label className="text-xs text-muted-foreground">손절 기준 ({inputCurrency})<input aria-label="주문 손절 기준" inputMode="decimal" disabled={locked} value={stop} onChange={event => setStop(event.target.value)} className={inputClass} /></label><label className="text-xs text-muted-foreground">목표 기준 ({inputCurrency})<input aria-label="주문 목표 기준" inputMode="decimal" disabled={locked} value={target} onChange={event => setTarget(event.target.value)} className={inputClass} /></label></>}
      {futures && <><label className="text-xs text-muted-foreground">레버리지<select aria-label="선물 레버리지" disabled={locked} value={leverage} onChange={event => setLeverage(event.target.value)} className={inputClass}>{[2, 3, 4, 5, 6, 7].map(value => <option key={value} value={value}>{value}배</option>)}</select></label><label className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" disabled={locked} checked={reduceOnly} onChange={event => setReduceOnly(event.target.checked)} />기존 {sideLabel(side)} 포지션 청산만</label></>}
      {provider === 'kiwoom' && selection.market === 'US' && <label className="text-xs text-muted-foreground">상장 거래소<select aria-label="주문 거래소" disabled={locked} value={stockExchange} onChange={event => setStockExchange(event.target.value)} className={inputClass}><option value="">선택</option>{['NASDAQ', 'NYSE', 'AMEX'].map(value => <option key={value}>{value}</option>)}</select></label>}
    </div>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{inputReady ? `${orderType === 'market' ? '예상 ' : ''}주문 금액 ${displayedNotional.toLocaleString('ko-KR', { maximumFractionDigits: 4 })} ${inputCurrency}` : '수량·금액·가격 확인 필요'}{futures && inputReady ? ` · 예상 증거금 ${(displayedNotional / Number(leverage)).toLocaleString('ko-KR', { maximumFractionDigits: 4 })} ${inputCurrency}` : ''}</p><button type="button" data-testid="chart-manual-preview" disabled={!inputReady || locked} onClick={() => void preview()} className="min-h-11 rounded-xl bg-primary px-5 text-sm font-bold text-primary-foreground disabled:opacity-40">{loading ? '계좌·위험 검증 중' : exit ? '매도·청산 초안 확인' : '주문 초안 확인'}</button></div>
    <p className="mt-2 text-[11px] text-muted-foreground">실제 결제 {currency} · 원화 입력은 서버 환율로 환산 · 수수료 별도</p>
    {sizeMode === 'amount' && <p className="mt-2 text-[11px] text-muted-foreground">입력 금액 이하로 수량 환산 · 거래소 최소 수량·단위 확인 후 확정</p>}
    {orderType === 'market' && <p role="status" className="mt-2 text-xs text-warning">시장가 실주문 연결 검증 미완료 · 전송 금지</p>}
    {message && <p role="status" className="mt-3 break-words text-xs">{message}</p>}
  </section>;
}
