import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle, Download, Loader2, RotateCcw, Upload, X } from 'lucide-react';
import { getFuturesContractRules, getFuturesMarketSnapshot, type FuturesContractRules, type FuturesMarketSnapshot } from '@/lib/futures-market-data';
import type { RiskEngineInput } from '@/lib/trading-risk';
import {
  calculatePaperStatistics,
  clearPaperState,
  evaluatePaperTrading,
  exportPaperState,
  getLatestCompletedCandle,
  importPaperState,
  loadPaperState,
  savePaperState,
  type PaperOrderRequest,
  type PaperTradingAction,
  type PaperTradingActionResult,
  type PaperTradingState,
  type StorageLike,
} from '@/lib/paper-trading';

const inputClass = 'h-10 min-w-0 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';
const buttonClass = 'inline-flex min-h-10 items-center justify-center rounded-lg border border-border px-3 text-sm font-semibold disabled:opacity-50';
const fmt = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 6 });
const number = (value: number | null | undefined) => value == null ? '-' : fmt.format(value);
const money = (value: number) => `${fmt.format(value)} USDT`;
const eventId = (prefix: string) => `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

type FormValues = {
  symbol: string;
  side: 'long' | 'short';
  orderType: 'market' | 'limit' | 'stop_market';
  quantity: string;
  leverage: number;
  requestedPrice: string;
  triggerPrice: string;
  stopLossPrice: number;
  takeProfitPrice1: string;
  takeProfitPrice2: string;
  targetClosePercent1: number;
  targetClosePercent2: number;
  riskPercent: number;
};

const DEFAULT_FORM: FormValues = {
  symbol: 'BTCUSDT', side: 'long', orderType: 'market', quantity: '', leverage: 2,
  requestedPrice: '99000', triggerPrice: '101000', stopLossPrice: 98000,
  takeProfitPrice1: '104000', takeProfitPrice2: '108000',
  targetClosePercent1: 50, targetClosePercent2: 50, riskPercent: 0.5,
};

type Props = {
  execute?: (state: PaperTradingState, action: PaperTradingAction) => Promise<PaperTradingActionResult>;
  loadMarket?: (symbol: string) => Promise<FuturesMarketSnapshot>;
  loadRules?: (symbol: string) => Promise<FuturesContractRules>;
  loadCandle?: (symbol: string) => ReturnType<typeof getLatestCompletedCandle>;
  storage?: StorageLike;
  compact?: boolean;
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-1 text-xs font-medium text-muted-foreground"><span>{label}</span>{children}</label>;
}

function Metric({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return <div className="rounded-xl border border-border/70 bg-background/70 p-3"><div className="text-[11px] text-muted-foreground">{label}</div><div className="mt-1 text-sm font-bold" data-testid={testId}>{value}</div></div>;
}

export function PaperTradingPanel({
  execute = evaluatePaperTrading,
  loadMarket = getFuturesMarketSnapshot,
  loadRules = getFuturesContractRules,
  loadCandle = getLatestCompletedCandle,
  storage = window.localStorage,
  compact = false,
}: Props) {
  const initial = useMemo(() => loadPaperState(storage), [storage]);
  const [state, setState] = useState(initial.state);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [market, setMarket] = useState<FuturesMarketSnapshot | null>(null);
  const [rules, setRules] = useState<FuturesContractRules | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(initial.warning);
  const [confirming, setConfirming] = useState(false);
  const [resetStep, setResetStep] = useState(false);
  const [journalFilter, setJournalFilter] = useState('all');
  const [closeQuantities, setCloseQuantities] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const requestSequence = useRef(0);

  const openPositions = state.positions.filter((position) => position.status !== 'closed');
  const statistics = useMemo(() => calculatePaperStatistics(state.journal), [state.journal]);
  const filteredJournal = state.journal.filter((entry) => journalFilter === 'all' || entry.side === journalFilter || entry.symbol === journalFilter);

  useEffect(() => { savePaperState(storage, state); }, [state, storage]);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    setMarket(null); setRules(null); setError('');
    Promise.all([loadMarket(form.symbol), loadRules(form.symbol)])
      .then(([nextMarket, nextRules]) => {
        if (sequence !== requestSequence.current) return;
        setMarket(nextMarket); setRules(nextRules);
        const price = nextMarket.markPrice ?? nextMarket.price ?? 100;
        setForm((current) => ({
          ...current,
          requestedPrice: String(price * 0.99),
          triggerPrice: String(price * 1.01),
          stopLossPrice: current.side === 'long' ? price * 0.98 : price * 1.02,
          takeProfitPrice1: String(current.side === 'long' ? price * 1.04 : price * 0.96),
          takeProfitPrice2: String(current.side === 'long' ? price * 1.08 : price * 0.92),
        }));
      })
      .catch((cause) => { if (sequence === requestSequence.current) setError(cause instanceof Error ? cause.message : '시장 데이터를 불러오지 못했습니다.'); });
  }, [form.symbol, loadMarket, loadRules]);

  const update = <K extends keyof FormValues,>(key: K, value: FormValues[K]) => setForm((current) => ({ ...current, [key]: value }));

  const changeSide = (side: FormValues['side']) => {
    const price = market?.markPrice ?? market?.price ?? 100;
    setForm((current) => ({
      ...current,
      side,
      stopLossPrice: side === 'long' ? price * 0.98 : price * 1.02,
      takeProfitPrice1: String(side === 'long' ? price * 1.04 : price * 0.96),
      takeProfitPrice2: String(side === 'long' ? price * 1.08 : price * 0.92),
    }));
  };

  const estimatedRiskReward = useMemo(() => {
    const entry = market?.askPrice ?? market?.bidPrice ?? market?.markPrice ?? market?.price ?? null;
    const target = form.takeProfitPrice1 === '' ? null : Number(form.takeProfitPrice1);
    if (entry == null || target == null || !Number.isFinite(target)) return null;
    const risk = Math.abs(entry - form.stopLossPrice);
    const reward = Math.abs(target - entry);
    return risk > 0 && Number.isFinite(reward) ? reward / risk : null;
  }, [form.stopLossPrice, form.takeProfitPrice1, market]);

  const localBlocks = useMemo(() => {
    const blocks: string[] = [];
    const price = market?.askPrice ?? market?.bidPrice ?? market?.markPrice ?? market?.price ?? null;
    if (!market || market.status !== 'live') blocks.push('시장 데이터가 live가 아닙니다.');
    if (!rules || rules.status !== 'live') blocks.push('계약 규칙이 live가 아닙니다.');
    if (price == null) blocks.push('진입 기준가격이 없습니다.');
    if (form.side === 'long' && price != null && form.stopLossPrice >= price) blocks.push('롱 손절가는 진입가보다 낮아야 합니다.');
    if (form.side === 'short' && price != null && form.stopLossPrice <= price) blocks.push('숏 손절가는 진입가보다 높아야 합니다.');
    if (form.targetClosePercent1 + form.targetClosePercent2 > 100) blocks.push('부분익절 비율 합계는 100% 이하여야 합니다.');
    return blocks;
  }, [form, market, rules]);

  async function runAction(action: PaperTradingAction) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await execute(state, action);
      setState(result.state);
      setNotice(result.duplicateEvent ? '중복 이벤트를 무시했습니다.' : result.warnings.join(' '));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '모의거래 작업을 처리하지 못했습니다.');
    } finally { setBusy(false); }
  }

  function buildPlaceAction(): PaperTradingAction {
    if (!market || !rules) throw new Error('시장 데이터와 계약 규칙을 확인하세요.');
    const reference = market.askPrice ?? market.bidPrice ?? market.markPrice ?? market.price ?? 0;
    const request: PaperOrderRequest = {
      symbol: form.symbol.trim().toUpperCase(), side: form.side, orderType: form.orderType,
      quantity: form.quantity === '' ? null : Number(form.quantity), leverage: form.leverage,
      requestedPrice: form.orderType === 'limit' ? Number(form.requestedPrice) : null,
      triggerPrice: form.orderType === 'stop_market' ? Number(form.triggerPrice) : null,
      stopLossPrice: form.stopLossPrice,
      takeProfitPrice1: form.takeProfitPrice1 === '' ? null : Number(form.takeProfitPrice1),
      takeProfitPrice2: form.takeProfitPrice2 === '' ? null : Number(form.takeProfitPrice2),
      targetClosePercent1: form.targetClosePercent1, targetClosePercent2: form.targetClosePercent2,
      strategyName: 'manual', marketRegime: 'manual',
    };
    const riskInput: RiskEngineInput = {
      market: 'crypto-futures', symbol: request.symbol, side: request.side, accountBalance: state.account.equity,
      entryPrice: reference, stopLossPrice: request.stopLossPrice, targetPrice1: request.takeProfitPrice1,
      targetPrice2: request.takeProfitPrice2, leverage: request.leverage, riskPercent: form.riskPercent,
      entryFeeRate: 0.0006, exitFeeRate: 0.0006, slippageRate: 0.0005,
      estimatedFundingRate: market.fundingRate ?? 0, quantityStep: rules.quantityStep,
      quantityPrecision: rules.quantityPrecision, minimumQuantity: rules.minimumQuantity,
      minimumNotional: rules.minimumNotional, maintenanceMarginRate: rules.maintenanceMarginRate,
      maximumLeverage: rules.maximumLeverage, contractRulesStatus: rules.status,
      dailyRealizedPnl: state.riskState.dailyRealizedPnl, weeklyRealizedPnl: state.riskState.weeklyRealizedPnl,
      consecutiveLosses: state.riskState.consecutiveLosses,
      openExposure: openPositions.reduce((sum, item) => sum + item.notionalValue, 0),
      sameDirectionExposure: openPositions.filter((item) => item.side === form.side).reduce((sum, item) => sum + item.notionalValue, 0),
      dataStatus: market.status,
    };
    return { type: 'place_order', eventId: eventId('place'), request, market, contractRules: rules, riskInput };
  }

  function submit(event: FormEvent) { event.preventDefault(); setConfirming(true); }
  async function confirmOrder() { setConfirming(false); await runAction(buildPlaceAction()); }

  async function refreshMarket() {
    const sequence = ++requestSequence.current;
    setError('');
    try {
      const next = await loadMarket(form.symbol);
      if (sequence !== requestSequence.current) return;
      setMarket(next);
      const price = next.markPrice ?? next.price;
      if (price != null) await runAction({ type: 'mark_price', eventId: eventId('mark'), symbol: form.symbol, price, at: next.updatedAt });
    } catch (cause) { setError(cause instanceof Error ? cause.message : '시장 데이터를 갱신하지 못했습니다.'); }
  }

  async function applyCandle() {
    setError('');
    try {
      const candle = await loadCandle(form.symbol);
      if (!candle) throw new Error('완료된 캔들을 찾지 못했습니다.');
      await runAction({ type: 'process_candle', eventId: eventId('candle'), candle });
    } catch (cause) { setError(cause instanceof Error ? cause.message : '완료 봉을 처리하지 못했습니다.'); }
  }

  function downloadJson() {
    const blob = new Blob([exportPaperState(state)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `paper-trading-${new Date().toISOString().slice(0, 10)}.json`; anchor.click();
    URL.revokeObjectURL(url);
  }

  async function importJson(file: File) {
    try { setState(importPaperState(await file.text())); setNotice('모의거래 JSON을 가져왔습니다.'); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'JSON을 가져오지 못했습니다.'); }
  }

  function updateNote(id: string, value: string) {
    setState((current) => ({ ...current, journal: current.journal.map((entry) => entry.id === id ? { ...entry, note: value.slice(0, 2_000) } : entry) }));
  }

  return <main className="h-full overflow-y-auto overscroll-contain pb-28" data-testid="paper-trading-page">
    <div className={`mx-auto w-full ${compact ? 'max-w-5xl' : 'max-w-6xl'} space-y-4 px-4 py-5 sm:px-5`}>
      <header className="rounded-2xl border border-border bg-card p-4">
        <h1 className="text-lg font-bold">코인 선물 모의매매</h1>
        <p className="mt-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm font-bold">모의매매입니다. 실제 거래소 주문은 전송되지 않습니다.</p>
        <p className="mt-2 text-xs text-muted-foreground">현재 모의거래 기록은 이 브라우저에만 저장됩니다. 서버·다른 기기와 동기화되지 않습니다.</p>
      </header>

      {error ? <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
      {notice ? <div role="status" className="rounded-xl border border-border bg-muted p-3 text-sm">{notice}</div> : null}

      <section className="rounded-2xl border border-border bg-card p-4" data-testid="paper-account">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="font-bold">모의계좌</h2><div className="flex gap-2"><button type="button" className={buttonClass} onClick={() => void refreshMarket()} disabled={busy}>현재가 갱신</button><button type="button" className={buttonClass} onClick={() => void applyCandle()} disabled={busy}>완료 봉 처리</button></div></div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><Metric label="초기 자본" value={money(state.account.initialBalance)} /><Metric label="현금" value={money(state.account.cashBalance)} /><Metric label="자산" value={money(state.account.equity)} testId="paper-equity" /><Metric label="사용 증거금" value={money(state.account.usedMargin)} /><Metric label="사용 가능" value={money(state.account.availableMargin)} /><Metric label="실현손익" value={money(state.account.realizedPnl)} /><Metric label="미실현손익" value={money(state.account.unrealizedPnl)} /><Metric label="일일 / 주간" value={`${money(state.riskState.dailyRealizedPnl)} / ${money(state.riskState.weeklyRealizedPnl)}`} /></div>
      </section>

      <form onSubmit={submit} className="rounded-2xl border border-border bg-card p-4" data-testid="paper-order-form">
        <h2 className="mb-3 font-bold">모의주문</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="종목"><input className={inputClass} value={form.symbol} onChange={(e) => update('symbol', e.target.value.toUpperCase())} /></Field>
          <Field label="롱·숏"><select className={inputClass} value={form.side} onChange={(e) => changeSide(e.target.value as FormValues['side'])}><option value="long">롱</option><option value="short">숏</option></select></Field>
          <Field label="주문 유형"><select className={inputClass} value={form.orderType} onChange={(e) => update('orderType', e.target.value as FormValues['orderType'])}><option value="market">시장가</option><option value="limit">지정가</option><option value="stop_market">스탑 시장가</option></select></Field>
          <Field label="수량 (비우면 추천)"><input className={inputClass} type="number" min="0" step="any" value={form.quantity} onChange={(e) => update('quantity', e.target.value)} /></Field>
          <Field label="레버리지"><input className={inputClass} type="number" min="1" max="10" value={form.leverage} onChange={(e) => update('leverage', Number(e.target.value))} /></Field>
          {form.orderType === 'limit' ? <Field label="지정가"><input className={inputClass} type="number" min="0" step="any" value={form.requestedPrice} onChange={(e) => update('requestedPrice', e.target.value)} /></Field> : null}
          {form.orderType === 'stop_market' ? <Field label="트리거 가격"><input className={inputClass} type="number" min="0" step="any" value={form.triggerPrice} onChange={(e) => update('triggerPrice', e.target.value)} /></Field> : null}
          <Field label="손절가"><input className={inputClass} type="number" min="0" step="any" value={form.stopLossPrice} onChange={(e) => update('stopLossPrice', Number(e.target.value))} /></Field>
          <Field label="목표가 1"><input className={inputClass} type="number" min="0" step="any" value={form.takeProfitPrice1} onChange={(e) => update('takeProfitPrice1', e.target.value)} /></Field>
          <Field label="목표가 2"><input className={inputClass} type="number" min="0" step="any" value={form.takeProfitPrice2} onChange={(e) => update('takeProfitPrice2', e.target.value)} /></Field>
          <Field label="목표 1 비율"><input className={inputClass} type="number" min="0" max="100" value={form.targetClosePercent1} onChange={(e) => update('targetClosePercent1', Number(e.target.value))} /></Field>
          <Field label="목표 2 비율"><input className={inputClass} type="number" min="0" max="100" value={form.targetClosePercent2} onChange={(e) => update('targetClosePercent2', Number(e.target.value))} /></Field>
          <Field label="거래당 위험률 %"><input className={inputClass} type="number" min="0.01" max="1" step="0.01" value={form.riskPercent} onChange={(e) => update('riskPercent', Number(e.target.value))} /></Field>
        </div>
        <div className="mt-3 rounded-xl border border-border bg-muted/50 p-3 text-xs"><div>시장 상태: <b>{market?.status ?? '불러오는 중'}</b> / 계약 규칙: <b>{rules?.status ?? '불러오는 중'}</b></div><div className="mt-1">현재가 {number(market?.price)} · bid {number(market?.bidPrice)} · ask {number(market?.askPrice)} · 예상 최대손실 {money(state.account.equity * form.riskPercent / 100)} · 예상 손익비 {number(estimatedRiskReward)}</div>{localBlocks.map((block) => <div className="mt-1 text-destructive" key={block}>• {block}</div>)}</div>
        <button data-testid="paper-submit" className="mt-3 min-h-11 w-full rounded-xl bg-primary px-4 font-bold text-primary-foreground disabled:opacity-50" disabled={busy || localBlocks.length > 0}>{busy ? <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> : null}모의주문</button>
      </form>

      <section className="rounded-2xl border border-border bg-card p-4" data-testid="paper-positions"><h2 className="mb-3 font-bold">포지션</h2>{openPositions.length === 0 ? <p className="text-sm text-muted-foreground">열린 모의포지션이 없습니다.</p> : openPositions.map((position) => <article className="mb-3 rounded-xl border border-border p-3" key={position.id}><div className="flex flex-wrap justify-between gap-2"><b>{position.symbol} {position.side === 'long' ? '롱' : '숏'}</b><span>{position.status}</span></div><div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4"><span>진입 {number(position.entryPrice)}</span><span>현재 {number(position.currentPrice)}</span><span>잔여 {number(position.remainingQuantity)}</span><span>미실현 {money(position.unrealizedPnl)}</span><span>청산가격 근사 {number(state.orders.find((order) => order.id === position.orderId)?.riskResult?.estimatedLiquidationPrice)}</span><span>손절 {number(position.stopLossPrice)}</span><span>목표 {number(position.takeProfitPrice1)} / {number(position.takeProfitPrice2)}</span></div><div className="mt-3 grid grid-cols-4 gap-2">{([25, 50, 75, 100] as const).map((percent) => <button type="button" className={buttonClass} disabled={busy || !market} key={percent} onClick={() => market && void runAction({ type: 'close_position', eventId: eventId(`close-${percent}`), positionId: position.id, percentage: percent, market, reason: percent === 100 ? 'manual_close' : 'partial_close' })}>{percent === 100 ? '전체청산' : `${percent}%`}</button>)}</div><div className="mt-2 grid grid-cols-[1fr_auto] gap-2"><input aria-label={`${position.symbol} 직접 청산 수량`} className={inputClass} type="number" min="0" step="any" value={closeQuantities[position.id] ?? ''} onChange={(e) => setCloseQuantities((current) => ({ ...current, [position.id]: e.target.value }))} placeholder="직접 수량" /><button type="button" className={buttonClass} disabled={busy || !market || !(Number(closeQuantities[position.id]) > 0)} onClick={() => market && void runAction({ type: 'close_position', eventId: eventId('close-quantity'), positionId: position.id, quantity: Number(closeQuantities[position.id]), market, reason: 'partial_close' })}>수량 청산</button></div></article>)}</section>

      <section className="rounded-2xl border border-border bg-card p-4" data-testid="paper-orders"><h2 className="mb-3 font-bold">주문 목록</h2><div className="space-y-2">{state.orders.length === 0 ? <p className="text-sm text-muted-foreground">모의주문이 없습니다.</p> : [...state.orders].reverse().map((order) => <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3 text-xs" key={order.id}><span>{order.symbol} · {order.side} · {order.orderType} · <b>{order.status}</b></span>{order.status === 'pending' ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void runAction({ type: 'cancel_order', eventId: eventId('cancel'), orderId: order.id })}>취소</button> : null}{order.rejectionCodes.length ? <span className="w-full text-destructive">{order.rejectionCodes.join(', ')}</span> : null}</div>)}</div></section>

      <section className="rounded-2xl border border-border bg-card p-4" data-testid="paper-journal"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="font-bold">거래일지</h2><select className={inputClass} value={journalFilter} onChange={(e) => setJournalFilter(e.target.value)}><option value="all">전체</option><option value="long">롱</option><option value="short">숏</option><option value="BTCUSDT">BTCUSDT</option></select></div><div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><Metric label="총 거래" value={String(statistics.totalTrades)} /><Metric label="승률" value={`${number(statistics.winRate)}%`} /><Metric label="누적 순손익" value={money(statistics.cumulativeNetPnl)} /><Metric label="Profit Factor" value={number(statistics.profitFactor)} /><Metric label="총 수수료" value={money(statistics.totalFees)} /><Metric label="총 슬리피지" value={money(statistics.totalSlippage)} /><Metric label="총 펀딩비" value={money(statistics.totalFunding)} /><Metric label="최대 연속 손실" value={String(statistics.maximumConsecutiveLosses)} /></div><div className="mt-3 space-y-2">{filteredJournal.length === 0 ? <p className="text-sm text-muted-foreground">종료된 거래일지가 없습니다.</p> : [...filteredJournal].reverse().map((entry) => <article className="rounded-xl border border-border p-3 text-xs" key={entry.id}><div className="flex flex-wrap justify-between gap-2"><b>{entry.symbol} {entry.side}</b><span>{entry.status} · {entry.exitReason}</span></div><div className="mt-2">진입 {number(entry.entryPrice)} · 종료 {number(entry.exitPrice)} · 순손익 {money(entry.netPnl)} · R {number(entry.rMultiple)}</div><textarea aria-label={`${entry.symbol} 거래 메모`} className="mt-2 min-h-20 w-full rounded-lg border border-border bg-background p-2" value={entry.note} onChange={(e) => updateNote(entry.id, e.target.value)} placeholder="복기 메모 (일반 텍스트)" /></article>)}</div></section>

      <section className="rounded-2xl border border-border bg-card p-4"><h2 className="mb-3 font-bold">로컬 기록 관리</h2><div className="grid grid-cols-2 gap-2 sm:grid-cols-3"><button type="button" className={buttonClass} onClick={downloadJson}><Download className="mr-2 h-4 w-4" />JSON 내보내기</button><button type="button" className={buttonClass} onClick={() => fileRef.current?.click()}><Upload className="mr-2 h-4 w-4" />JSON 가져오기</button><button type="button" className={buttonClass} onClick={() => setResetStep(true)}><RotateCcw className="mr-2 h-4 w-4" />전체 초기화</button></div><input ref={fileRef} className="hidden" type="file" accept="application/json,.json" onChange={(e) => { const file = e.target.files?.[0]; if (file) void importJson(file); e.currentTarget.value = ''; }} /></section>
    </div>

    {confirming ? <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center" role="dialog" aria-modal="true" aria-label="모의주문 확인"><div className="max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-2xl bg-card p-4"><div className="flex justify-between"><h2 className="font-bold">모의주문 확인</h2><button aria-label="닫기" onClick={() => setConfirming(false)}><X /></button></div><p className="mt-3 text-sm">{form.symbol} {form.side === 'long' ? '롱' : '숏'} · {form.orderType}</p><p className="mt-2 text-sm font-bold">예상 최대손실: {money(state.account.equity * form.riskPercent / 100)}</p><div className="mt-2 rounded-xl bg-amber-500/10 p-3 text-xs">실제 주문은 전송되지 않습니다. 최종 수량과 차단 여부는 서버 리스크 엔진이 다시 계산합니다.</div><div className="mt-4 grid grid-cols-2 gap-2"><button className={buttonClass} onClick={() => setConfirming(false)}>취소</button><button data-testid="confirm-paper-order" className="rounded-lg bg-primary px-3 font-bold text-primary-foreground disabled:opacity-50" disabled={busy || localBlocks.length > 0} onClick={() => void confirmOrder()}>모의주문 확인</button></div></div></div> : null}

    {resetStep ? <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center" role="dialog" aria-modal="true" aria-label="전체 초기화 확인"><div className="w-full max-w-md rounded-2xl bg-card p-4"><div className="flex items-start gap-2"><AlertTriangle className="h-5 w-5 text-destructive" /><div><h2 className="font-bold">모든 로컬 기록을 삭제할까요?</h2><p className="mt-1 text-xs text-muted-foreground">계좌·주문·포지션·거래일지가 복구 없이 삭제됩니다.</p></div></div><div className="mt-4 grid grid-cols-2 gap-2"><button className={buttonClass} onClick={() => setResetStep(false)}>돌아가기</button><button className="rounded-lg bg-destructive px-3 font-bold text-destructive-foreground" onClick={() => { setState(clearPaperState(storage)); setResetStep(false); setNotice('모의거래 기록을 초기화했습니다.'); }}>2단계 초기화</button></div></div></div> : null}
  </main>;
}
