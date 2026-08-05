import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CheckCircle2, Keyboard, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import { useLocation } from 'wouter';
import { ChartBroadcastPanel, type ChartBroadcastMarket } from '@/components/chart-broadcast';
import {
  selectionFromSearch,
  selectionQuery,
  useAnalysisSelection,
  type AnalysisSelection,
} from '@/lib/analysis-selection';
import type { ChartAnalysis } from '@/lib/chart-analysis';

const SESSION_STORAGE_KEY = 'ai-trading-workspace:local-mock-orders:v1';

type MockSide = 'buy' | 'sell';
type MockOrderType = 'limit' | 'market';
type MockOrderStatus = 'pending' | 'cancelled';

type PreparedMockOrder = {
  side: MockSide;
  orderType: MockOrderType;
  quantity: number;
  price: number | null;
  ticker: string;
  displayName: string;
  market: 'KR' | 'US';
};

type LocalMockOrder = PreparedMockOrder & {
  id: string;
  status: MockOrderStatus;
  createdAt: string;
};

function fallbackSelection(): AnalysisSelection {
  return {
    assetType: 'stock',
    market: 'KR',
    symbol: '005930',
    ticker: '005930',
    displayName: '삼성전자',
    timeframe: '5m',
    selectedAt: new Date().toISOString(),
  };
}

function readOrders(): LocalMockOrder[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(SESSION_STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeOrders(orders: LocalMockOrder[]) {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(orders));
}

function positiveNumber(value: string): number | null {
  const parsed = Number(value.replaceAll(',', '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function orderId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `mock-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatNumber(value: number | null) {
  return value === null ? '시장가' : value.toLocaleString('ko-KR');
}

export default function TradingWorkspacePage() {
  const [location, navigate] = useLocation();
  const selectionState = useAnalysisSelection();
  const fromUrl = useMemo(
    () => selectionFromSearch(location.includes('?') ? location.slice(location.indexOf('?')) : ''),
    [location],
  );
  const selection = useMemo<AnalysisSelection>(
    () => fromUrl
      ? { ...(selectionState.selection?.ticker === fromUrl.ticker ? selectionState.selection : {}), ...fromUrl }
      : selectionState.selection ?? fallbackSelection(),
    [fromUrl, selectionState.selection],
  );
  const market: ChartBroadcastMarket = selection.market === 'US' ? 'US' : 'KR';
  const [analysis, setAnalysis] = useState<ChartAnalysis | null>(null);
  const [side, setSide] = useState<MockSide>('buy');
  const [orderType, setOrderType] = useState<MockOrderType>('limit');
  const [quantity, setQuantity] = useState('1');
  const [price, setPrice] = useState('');
  const [prepared, setPrepared] = useState<PreparedMockOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [orders, setOrders] = useState<LocalMockOrder[]>(readOrders);

  useEffect(() => {
    if (fromUrl) {
      selectionState.select({
        ...selectionState.selection,
        ...fromUrl,
        selectedAt: selectionState.selection?.selectedAt ?? fromUrl.selectedAt,
      } as AnalysisSelection);
    }
    // URL selection is authoritative only when the URL changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromUrl?.ticker, fromUrl?.market, fromUrl?.timeframe]);

  useEffect(() => {
    setPrepared(null);
    setError(null);
  }, [selection.ticker, selection.market]);

  const updateSelection = useCallback((next: {
    ticker: string;
    name: string;
    market: ChartBroadcastMarket;
    timeframe: string;
  }) => {
    const merged: AnalysisSelection = {
      ...selection,
      assetType: 'stock',
      market: next.market,
      symbol: next.ticker,
      ticker: next.ticker,
      displayName: next.name,
      timeframe: next.timeframe,
      selectedAt: selection.ticker === next.ticker ? selection.selectedAt : new Date().toISOString(),
    };
    const changed = selection.ticker !== merged.ticker
      || selection.market !== merged.market
      || selection.timeframe !== merged.timeframe
      || selection.displayName !== merged.displayName;
    if (changed) selectionState.select(merged);
    const nextLocation = `/trading-workspace?${selectionQuery(merged)}`;
    if (location !== nextLocation) navigate(nextLocation, { replace: true });
  }, [location, navigate, selection, selectionState]);

  const clearPreparation = useCallback(() => {
    setPrepared(null);
    setError(null);
  }, []);

  const prepareOrder = useCallback(() => {
    const parsedQuantity = positiveNumber(quantity);
    const parsedPrice = orderType === 'limit' ? positiveNumber(price) : null;
    if (parsedQuantity === null) {
      setError('수량은 0보다 큰 숫자여야 합니다.');
      return;
    }
    if (orderType === 'limit' && parsedPrice === null) {
      setError('지정가 주문은 0보다 큰 가격이 필요합니다.');
      return;
    }
    setError(null);
    setPrepared({
      side,
      orderType,
      quantity: parsedQuantity,
      price: parsedPrice,
      ticker: selection.ticker,
      displayName: selection.displayName,
      market,
    });
  }, [market, orderType, price, quantity, selection.displayName, selection.ticker, side]);

  const executePreparedOrder = useCallback(() => {
    if (!prepared) return;
    const next: LocalMockOrder = {
      ...prepared,
      id: orderId(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    setOrders((current) => {
      const updated = [next, ...current].slice(0, 50);
      writeOrders(updated);
      return updated;
    });
    setPrepared(null);
    setError(null);
  }, [prepared]);

  const submitOrder = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (prepared) executePreparedOrder();
    else prepareOrder();
  }, [executePreparedOrder, prepareOrder, prepared]);

  const cancelOrder = useCallback((id: string) => {
    setOrders((current) => {
      const updated = current.map((order) => order.id === id && order.status === 'pending'
        ? { ...order, status: 'cancelled' as const }
        : order);
      writeOrders(updated);
      return updated;
    });
  }, []);

  const estimatedAmount = prepared?.price === null
    ? null
    : prepared ? prepared.quantity * prepared.price : null;
  const chartPath = `/ai-chart?${selectionQuery(selection)}`;

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-background pb-8">
      <header className="sticky top-0 z-20 border-b border-card-border bg-background/95 px-4 py-3 backdrop-blur-xl">
        <div className="mx-auto flex max-w-screen-2xl items-center gap-3">
          <button
            type="button"
            aria-label="AI 차트 분석기로 돌아가기"
            onClick={() => navigate(chartPath)}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-card-border bg-card"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-extrabold text-primary">기술탭 · 안전 복구</p>
            <h1 className="truncate text-lg font-black">AI 매매 워크스페이스</h1>
          </div>
          <div className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-right text-[10px] font-black text-emerald-700 dark:text-emerald-300">
            로컬 모의주문 전용<br />네트워크 주문 요청 0
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-screen-2xl gap-4 p-4 xl:grid-cols-[minmax(0,2fr)_minmax(340px,1fr)]">
        <section className="min-w-0">
          <ChartBroadcastPanel
            market={market}
            initialSelection={{
              ticker: selection.ticker,
              name: selection.displayName,
              market,
              timeframe: selection.timeframe,
            }}
            onAnalysisChange={setAnalysis}
            onSelectionChange={updateSelection}
          />
        </section>

        <aside className="space-y-4 xl:sticky xl:top-20 xl:self-start">
          <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-extrabold text-primary">선택 종목</p>
                <h2 className="mt-1 text-lg font-black">{selection.displayName}</h2>
                <p className="mt-1 text-xs font-bold text-muted-foreground">{selection.ticker} · {market} · {selection.timeframe}</p>
              </div>
              <span className="rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-black text-primary">
                {analysis?.status ?? '분석 대기'}
              </span>
            </div>
            <p className="mt-3 break-keep text-xs leading-5 text-muted-foreground">
              {analysis?.summary ?? '실제 캔들 분석이 준비되면 이 영역에 상태를 표시합니다. 분석 결과는 주문을 자동 실행하지 않습니다.'}
            </p>
          </section>

          <form
            onSubmit={submitOrder}
            onKeyDown={(event) => {
              if (event.key === 'Escape') clearPreparation();
            }}
            className="rounded-3xl border border-card-border bg-card p-4 shadow-sm"
          >
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-black">로컬 모의주문</h2>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => { setSide('buy'); clearPreparation(); }}
                className={`h-11 rounded-2xl border text-sm font-black ${side === 'buy' ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-card-border bg-background text-muted-foreground'}`}
              >
                매수 모의
              </button>
              <button
                type="button"
                onClick={() => { setSide('sell'); clearPreparation(); }}
                className={`h-11 rounded-2xl border text-sm font-black ${side === 'sell' ? 'border-rose-500 bg-rose-500/10 text-rose-700 dark:text-rose-300' : 'border-card-border bg-background text-muted-foreground'}`}
              >
                매도 모의
              </button>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => { setOrderType('limit'); clearPreparation(); }}
                className={`h-10 rounded-2xl border text-xs font-black ${orderType === 'limit' ? 'border-primary bg-primary/10 text-primary' : 'border-card-border bg-background text-muted-foreground'}`}
              >
                지정가
              </button>
              <button
                type="button"
                onClick={() => { setOrderType('market'); clearPreparation(); }}
                className={`h-10 rounded-2xl border text-xs font-black ${orderType === 'market' ? 'border-primary bg-primary/10 text-primary' : 'border-card-border bg-background text-muted-foreground'}`}
              >
                시장가 모의
              </button>
            </div>

            <label className="mt-4 block text-xs font-black">
              수량
              <input
                inputMode="decimal"
                value={quantity}
                onChange={(event) => { setQuantity(event.target.value); clearPreparation(); }}
                className="mt-1 h-11 w-full rounded-2xl border border-card-border bg-background px-3 text-sm font-bold outline-none focus:border-primary"
                aria-label="모의주문 수량"
              />
            </label>

            <label className="mt-3 block text-xs font-black">
              가격
              <input
                inputMode="decimal"
                value={price}
                disabled={orderType === 'market'}
                onChange={(event) => { setPrice(event.target.value); clearPreparation(); }}
                placeholder={orderType === 'market' ? '시장가 모의주문' : '지정가 입력'}
                className="mt-1 h-11 w-full rounded-2xl border border-card-border bg-background px-3 text-sm font-bold outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="모의주문 가격"
              />
            </label>

            {error ? <p role="alert" className="mt-3 rounded-2xl bg-destructive/10 p-3 text-xs font-bold text-destructive">{error}</p> : null}

            {prepared ? (
              <div className="mt-4 rounded-2xl border border-warning/40 bg-warning/5 p-3 text-xs">
                <div className="flex items-center gap-2 font-black"><CheckCircle2 className="h-4 w-4 text-warning" />2차 확인 대기</div>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground">
                  <dt>구분</dt><dd className="text-right font-black text-foreground">{prepared.side === 'buy' ? '매수' : '매도'} · {prepared.orderType === 'limit' ? '지정가' : '시장가'}</dd>
                  <dt>수량</dt><dd className="text-right font-black text-foreground">{prepared.quantity.toLocaleString('ko-KR')}</dd>
                  <dt>가격</dt><dd className="text-right font-black text-foreground">{formatNumber(prepared.price)}</dd>
                  <dt>예상금액</dt><dd className="text-right font-black text-foreground">{estimatedAmount === null ? '-' : estimatedAmount.toLocaleString('ko-KR')}</dd>
                </dl>
                <p className="mt-2 font-semibold text-muted-foreground">Enter 또는 아래 버튼을 한 번 더 눌러 이 브라우저 세션에만 기록합니다.</p>
              </div>
            ) : null}

            <button
              type="submit"
              className="mt-4 h-12 w-full rounded-2xl bg-primary text-sm font-black text-primary-foreground shadow-sm"
            >
              {prepared ? '모의주문 기록 확정' : '모의주문 검토'}
            </button>
            {prepared ? (
              <button type="button" onClick={clearPreparation} className="mt-2 h-10 w-full rounded-2xl border border-card-border text-xs font-black">
                검토 취소 (Esc)
              </button>
            ) : null}
            <p className="mt-3 flex gap-2 text-[10px] font-semibold leading-4 text-muted-foreground">
              <Keyboard className="h-4 w-4 shrink-0" />첫 Enter는 검토, 두 번째 Enter는 로컬 기록입니다. 주문 API·계좌 API·DB를 호출하지 않습니다.
            </p>
          </form>

          <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-black">이 세션의 모의주문</h2>
              <span className="text-[10px] font-bold text-muted-foreground">최대 50건</span>
            </div>
            {orders.length === 0 ? (
              <p className="mt-3 rounded-2xl bg-background p-3 text-xs leading-5 text-muted-foreground">아직 기록된 모의주문이 없습니다. 브라우저 탭 세션을 닫으면 별도 영속성을 보장하지 않습니다.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {orders.map((order) => (
                  <article key={order.id} className="rounded-2xl border border-card-border bg-background p-3 text-xs">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-black">{order.displayName} · {order.side === 'buy' ? '매수' : '매도'}</p>
                        <p className="mt-1 text-[10px] font-semibold text-muted-foreground">{order.ticker} · {order.quantity.toLocaleString('ko-KR')}주 · {formatNumber(order.price)}</p>
                        <p className="mt-1 text-[10px] text-muted-foreground">{new Date(order.createdAt).toLocaleString('ko-KR')}</p>
                      </div>
                      <span className={`rounded-full px-2 py-1 text-[10px] font-black ${order.status === 'pending' ? 'bg-warning/10 text-warning' : 'bg-muted text-muted-foreground'}`}>
                        {order.status === 'pending' ? 'pending' : 'cancelled'}
                      </span>
                    </div>
                    {order.status === 'pending' ? (
                      <button
                        type="button"
                        onClick={() => cancelOrder(order.id)}
                        className="mt-2 flex h-9 w-full items-center justify-center gap-1 rounded-xl border border-card-border font-black text-muted-foreground"
                      >
                        <XCircle className="h-3.5 w-3.5" />pending 취소
                      </button>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
            {orders.length > 0 ? (
              <button
                type="button"
                onClick={() => { setOrders([]); writeOrders([]); }}
                className="mt-3 flex h-9 w-full items-center justify-center gap-1 rounded-xl border border-card-border text-xs font-black text-muted-foreground"
              >
                <Trash2 className="h-3.5 w-3.5" />세션 기록 비우기
              </button>
            ) : null}
          </section>
        </aside>
      </main>
    </div>
  );
}
