import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { useAuth } from '@/lib/auth';
import { approvalMessage } from '@/lib/trade-approval-ui';
import {
  isManualOrderExit,
  MANUAL_ORDER_ACTION_LABELS,
  MANUAL_ORDER_ERRORS,
  MANUAL_ORDER_MARKET_LABELS,
  onManualOrderPrice,
  onManualOrderTicketOpen,
  type ManualOrderAction,
  type ManualOrderMarket,
  type ManualOrderTicketRequest,
} from '@/lib/manual-order-ticket';
import { cn } from '@/lib/utils';

type Plan = {
  id: string;
  exchange: string;
  symbol: string;
  side: string;
  orderType: 'market' | 'limit';
  quantity: number | null;
  quoteAmount: number | null;
  limitPrice: number | null;
  estimatedKrw: number;
  stopPrice: number;
  reduceOnly?: boolean;
};

type Step =
  | { kind: 'edit' }
  | { kind: 'review'; plan: Plan; createdAt: number }
  | { kind: 'done'; message: string; ok: boolean };

const REVIEW_SECONDS = 25; // the server refuses a market snapshot older than 30 seconds

const ACTIONS: Record<ManualOrderMarket, ManualOrderAction[]> = {
  domestic_stock: ['buy', 'sell'],
  us_stock: ['buy', 'sell'],
  crypto_spot: ['buy', 'sell'],
  crypto_futures: ['long', 'short', 'close_long', 'close_short'],
};

const GENERIC_APPROVAL_TEXT = approvalMessage('__unknown__', null);
const RISK_BLOCK_TEXT: Record<string, string> = {
  DAILY_LOSS_LIMIT: '일일 손실 한도에 도달해 오늘은 새 주문을 낼 수 없습니다.',
  WEEKLY_LOSS_LIMIT: '주간 손실 한도에 도달했습니다.',
  CONSECUTIVE_LOSS_LIMIT: '연속 손실 한도에 도달했습니다.',
  MAX_ORDER_AMOUNT: '1회 최대 주문 금액을 넘었습니다.',
  INSUFFICIENT_MARGIN: '증거금(주문 가능 금액)이 부족합니다.',
  SPREAD_TOO_WIDE: '호가 차이가 너무 커서 주문을 막았습니다.',
  MARKET_HALTED: '거래가 정지됐거나 장이 열리지 않았습니다.',
  BITGET_OPPOSITE_POSITION_DUPLICATE: '반대 방향 포지션이 있어 먼저 청산해야 합니다.',
  BITGET_LIQUIDATION_RISK: '청산가가 너무 가까워 주문을 막았습니다.',
  BENCHMARK_DRAWDOWN_LONG_BLOCKED: 'BTC가 급락 중이라 코인 신규 매수·롱을 막았습니다.',
};

function errorText(code: string | undefined, fallback: string) {
  if (!code) return fallback;
  if (MANUAL_ORDER_ERRORS[code]) return MANUAL_ORDER_ERRORS[code];
  if (RISK_BLOCK_TEXT[code]) return RISK_BLOCK_TEXT[code];
  const approval = approvalMessage(code, null);
  return approval !== GENERIC_APPROVAL_TEXT ? approval : `${fallback} (${code})`;
}

function numberOrNull(value: string) {
  const parsed = Number(value.replace(/,/g, ''));
  return value.trim() && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Mounted once in the app shell; opens from the orderbook, holdings and stock screens. */
export function ManualOrderTicketHost() {
  const auth = useAuth();
  const [request, setRequest] = useState<ManualOrderTicketRequest | null>(null);
  const [priceHint, setPriceHint] = useState<{ price: number; nonce: number } | null>(null);

  useEffect(() => onManualOrderTicketOpen((next) => { setRequest(next); setPriceHint(null); }), []);
  useEffect(() => onManualOrderPrice((next) => {
    setRequest((current) => (current && current.market === next.market && current.symbol === next.symbol
      ? current : { ...next, action: next.action }));
    if (next.price) setPriceHint({ price: next.price, nonce: Date.now() });
  }), []);

  if (!request || !auth.can('canPlaceOrders')) return null;
  return <ManualOrderTicket key={`${request.market}:${request.symbol}`} request={request} priceHint={priceHint} onClose={() => setRequest(null)} />;
}

export function ManualOrderTicket({ request, priceHint, onClose }: {
  request: ManualOrderTicketRequest;
  priceHint?: { price: number; nonce: number } | null;
  onClose: () => void;
}) {
  const market = request.market;
  const actions = ACTIONS[market];
  const [action, setAction] = useState<ManualOrderAction>(request.action && actions.includes(request.action) ? request.action : actions[0]);
  const [orderType, setOrderType] = useState<'market' | 'limit'>(request.price ? 'limit' : 'market');
  const [quantity, setQuantity] = useState(request.quantity ? String(request.quantity) : '');
  const [amountKrw, setAmountKrw] = useState('');
  const [limitPrice, setLimitPrice] = useState(request.price ? String(request.price) : '');
  const [stopPrice, setStopPrice] = useState('');
  const [targetPrice, setTargetPrice] = useState('');
  const [stockExchange, setStockExchange] = useState<'NASDAQ' | 'NYSE' | 'AMEX'>('NASDAQ');
  const [step, setStep] = useState<Step>({ kind: 'edit' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!priceHint) return;
    setOrderType('limit');
    setLimitPrice(String(priceHint.price));
  }, [priceHint]);
  useEffect(() => {
    if (step.kind !== 'review') return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [step.kind]);

  const exit = isManualOrderExit(action);
  const upbitMarketBuy = market === 'crypto_spot' && orderType === 'market' && action === 'buy';
  const usStock = market === 'us_stock';
  const secondsLeft = step.kind === 'review' ? Math.max(0, REVIEW_SECONDS - Math.floor((now - step.createdAt) / 1000)) : 0;
  const tone = action === 'buy' || action === 'long' || action === 'close_short' ? 'bg-red-600' : 'bg-blue-600';

  const body = useMemo(() => ({
    market,
    symbol: request.symbol,
    action,
    orderType,
    quantity: upbitMarketBuy ? null : numberOrNull(quantity),
    quoteAmountKrw: upbitMarketBuy ? numberOrNull(amountKrw) : null,
    limitPrice: orderType === 'limit' ? numberOrNull(limitPrice) : null,
    stopPrice: exit ? null : numberOrNull(stopPrice),
    targetPrice: exit ? null : numberOrNull(targetPrice),
    stockExchange: usStock ? stockExchange : null,
  }), [action, amountKrw, exit, limitPrice, market, orderType, quantity, request.symbol, stockExchange, stopPrice, targetPrice, upbitMarketBuy, usStock]);

  async function review() {
    setBusy(true);
    setError(null);
    try {
      const response = await authorizedFetch('/api/trade-automation/manual-orders/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({})) as {
        ok?: boolean; error?: string; plan?: Plan; decision?: { blockCodes?: string[] };
      };
      if (!response.ok || payload.ok !== true || !payload.plan) {
        const blocked = payload.decision?.blockCodes?.[0];
        setError(errorText(blocked ?? payload.error, '주문을 준비하지 못했습니다.'));
        return;
      }
      setNow(Date.now());
      setStep({ kind: 'review', plan: payload.plan, createdAt: Date.now() });
    } catch {
      setError('네트워크 오류로 주문을 준비하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }

  async function submit(plan: Plan) {
    setBusy(true);
    setError(null);
    try {
      const response = await authorizedFetch(`/api/trade-automation/plans/${encodeURIComponent(plan.id)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      });
      const payload = await response.json().catch(() => ({})) as {
        ok?: boolean; error?: string; order?: { state?: string } | null; decision?: { blockCodes?: string[] };
      };
      if (!response.ok || payload.ok !== true) {
        setStep({ kind: 'done', ok: false, message: errorText(payload.decision?.blockCodes?.[0] ?? payload.error, '주문이 거절됐습니다.') });
        return;
      }
      setStep({ kind: 'done', ok: true, message: `주문을 보냈습니다. 상태: ${payload.order?.state ?? '접수'}` });
    } catch {
      setStep({ kind: 'done', ok: false, message: '응답을 받지 못했습니다. 주문 내역에서 실제 체결 여부를 꼭 확인해 주세요.' });
    } finally {
      setBusy(false);
    }
  }

  const field = 'mt-1 h-11 w-full rounded-xl border border-card-border bg-background px-3 text-sm tabular-nums';
  return (
    <div className="fixed inset-0 z-[95] flex items-end justify-center bg-black/50 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="실주문 주문창" data-testid="manual-order-ticket">
      <section className="flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl border border-border bg-background shadow-2xl sm:rounded-3xl">
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <p className="text-[11px] font-bold text-muted-foreground">{MANUAL_ORDER_MARKET_LABELS[market]} · 실제 주문</p>
            <h2 className="truncate text-base font-black">{request.symbol}</h2>
          </div>
          <button type="button" aria-label="주문창 닫기" onClick={onClose} className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-accent">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        <div className="min-h-0 overflow-y-auto overscroll-contain p-4">
          {step.kind === 'edit' ? (
            <div className="space-y-3">
              <div className={cn('grid gap-2', actions.length === 4 ? 'grid-cols-4' : 'grid-cols-2')} role="radiogroup" aria-label="주문 종류">
                {actions.map((item) => (
                  <button key={item} type="button" role="radio" aria-checked={action === item} data-testid={`manual-order-action-${item}`}
                    onClick={() => setAction(item)}
                    className={cn('h-11 rounded-xl text-xs font-extrabold', action === item ? `${tone} text-white` : 'bg-secondary')}>
                    {MANUAL_ORDER_ACTION_LABELS[item]}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="주문 방식">
                {(['market', 'limit'] as const).map((type) => (
                  <button key={type} type="button" role="radio" aria-checked={orderType === type} data-testid={`manual-order-type-${type}`}
                    onClick={() => setOrderType(type)}
                    className={cn('h-10 rounded-xl text-xs font-bold', orderType === type ? 'bg-foreground text-background' : 'bg-secondary')}>
                    {type === 'market' ? '시장가' : '지정가'}
                  </button>
                ))}
              </div>
              {orderType === 'limit' ? (
                <label className="block text-xs font-bold">지정가 <span className="font-normal text-muted-foreground">(호가를 누르면 자동 입력)</span>
                  <input inputMode="decimal" className={field} value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} data-testid="manual-order-limit-price" />
                </label>
              ) : null}
              {upbitMarketBuy ? (
                <label className="block text-xs font-bold">주문 금액 (원)
                  <input inputMode="numeric" className={field} value={amountKrw} onChange={(e) => setAmountKrw(e.target.value)} data-testid="manual-order-amount" />
                </label>
              ) : (
                <label className="block text-xs font-bold">수량 {market === 'crypto_futures' ? '(계약 수량)' : ''}
                  <input inputMode="decimal" className={field} value={quantity} onChange={(e) => setQuantity(e.target.value)} data-testid="manual-order-quantity" />
                </label>
              )}
              {!exit ? (
                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-xs font-bold">손절가 <span className="text-red-600">*</span>
                    <input inputMode="decimal" className={field} value={stopPrice} onChange={(e) => setStopPrice(e.target.value)} data-testid="manual-order-stop" />
                  </label>
                  <label className="block text-xs font-bold">목표가 <span className="font-normal text-muted-foreground">(선택)</span>
                    <input inputMode="decimal" className={field} value={targetPrice} onChange={(e) => setTargetPrice(e.target.value)} data-testid="manual-order-target" />
                  </label>
                </div>
              ) : (
                <p className="rounded-xl bg-secondary/70 p-3 text-[11px] leading-5 text-muted-foreground">청산·매도 주문은 보유 수량을 줄이는 주문(reduce-only)으로만 나갑니다.</p>
              )}
              {usStock ? (
                <label className="block text-xs font-bold">거래소 <span className="font-normal text-muted-foreground">(키움 미국주식에 필요)</span>
                  <select className={field} value={stockExchange} onChange={(e) => setStockExchange(e.target.value as 'NASDAQ' | 'NYSE' | 'AMEX')}>
                    <option value="NASDAQ">NASDAQ</option><option value="NYSE">NYSE</option><option value="AMEX">AMEX</option>
                  </select>
                </label>
              ) : null}
              {error ? <p role="alert" className="flex gap-2 rounded-xl bg-destructive/10 p-3 text-xs font-semibold text-destructive"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</p> : null}
              <p className="text-[11px] leading-5 text-muted-foreground">
                주문 확인을 누르면 서버가 거래소 실시간 시세와 계좌를 확인해 주문서를 만듭니다. 이 단계에서는 주문이 나가지 않습니다.
              </p>
            </div>
          ) : null}

          {step.kind === 'review' ? (
            <div className="space-y-3" data-testid="manual-order-review">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-2xl border border-card-border bg-card p-4 text-sm">
                <dt className="text-muted-foreground">주문</dt><dd className="text-right font-black">{MANUAL_ORDER_ACTION_LABELS[action]} · {step.plan.orderType === 'market' ? '시장가' : '지정가'}</dd>
                <dt className="text-muted-foreground">거래소</dt><dd className="text-right font-bold">{step.plan.exchange}</dd>
                <dt className="text-muted-foreground">수량/금액</dt><dd className="text-right font-bold tabular-nums">{step.plan.quantity ?? `${Number(step.plan.quoteAmount ?? 0).toLocaleString('ko-KR')}원`}</dd>
                <dt className="text-muted-foreground">기준가</dt><dd className="text-right font-bold tabular-nums">{step.plan.limitPrice?.toLocaleString('ko-KR') ?? '-'}</dd>
                {!exit ? <><dt className="text-muted-foreground">손절가</dt><dd className="text-right font-bold tabular-nums">{step.plan.stopPrice.toLocaleString('ko-KR')}</dd></> : null}
                <dt className="text-muted-foreground">예상 금액</dt><dd className="text-right font-black tabular-nums">{Math.round(step.plan.estimatedKrw).toLocaleString('ko-KR')}원</dd>
              </dl>
              <p className="text-center text-xs font-bold text-muted-foreground" data-testid="manual-order-countdown">
                {secondsLeft > 0 ? `${secondsLeft}초 안에 확정해 주세요` : '시세가 오래됐습니다. 다시 확인해 주세요.'}
              </p>
              {error ? <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-xs font-semibold text-destructive">{error}</p> : null}
            </div>
          ) : null}

          {step.kind === 'done' ? (
            <div className={cn('flex flex-col items-center gap-3 rounded-2xl p-6 text-center', step.ok ? 'bg-emerald-500/10' : 'bg-destructive/10')} data-testid="manual-order-result">
              {step.ok ? <CheckCircle2 className="h-10 w-10 text-emerald-600" /> : <AlertTriangle className="h-10 w-10 text-destructive" />}
              <p className="break-keep text-sm font-bold">{step.message}</p>
            </div>
          ) : null}
        </div>

        <footer className="grid grid-cols-2 gap-2 border-t border-border p-3">
          {step.kind === 'edit' ? (
            <>
              <button type="button" onClick={onClose} className="h-12 rounded-2xl bg-secondary text-sm font-extrabold">취소</button>
              <button type="button" disabled={busy} onClick={() => void review()} data-testid="manual-order-review-button"
                className={cn('h-12 rounded-2xl text-sm font-extrabold text-white disabled:opacity-50', tone)}>
                {busy ? '확인 중' : '주문 확인'}
              </button>
            </>
          ) : step.kind === 'review' ? (
            <>
              <button type="button" disabled={busy} onClick={() => setStep({ kind: 'edit' })} className="h-12 rounded-2xl bg-secondary text-sm font-extrabold">수정</button>
              {secondsLeft > 0 ? (
                <button type="button" disabled={busy} onClick={() => void submit(step.plan)} data-testid="manual-order-submit"
                  className={cn('h-12 rounded-2xl text-sm font-extrabold text-white disabled:opacity-50', tone)}>
                  {busy ? '보내는 중' : `실제 ${MANUAL_ORDER_ACTION_LABELS[action]} 주문`}
                </button>
              ) : (
                <button type="button" disabled={busy} onClick={() => void review()} className="h-12 rounded-2xl bg-foreground text-sm font-extrabold text-background">다시 확인</button>
              )}
            </>
          ) : (
            <>
              <button type="button" onClick={() => setStep({ kind: 'edit' })} className="h-12 rounded-2xl bg-secondary text-sm font-extrabold">새 주문</button>
              <button type="button" onClick={onClose} className="h-12 rounded-2xl bg-foreground text-sm font-extrabold text-background">닫기</button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}
