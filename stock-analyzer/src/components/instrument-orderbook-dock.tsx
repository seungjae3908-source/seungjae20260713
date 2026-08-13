import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { AlertTriangle, BookOpen, RefreshCw, X } from 'lucide-react';

import { authorizedFetch } from '@/lib/auth-fetch';

export type OrderbookAssetClass = 'stock' | 'crypto_spot' | 'crypto_futures';
export type OrderbookMarket = 'KR' | 'US' | 'UPBIT' | 'BITGET';
type OrderbookStatus = 'ready' | 'partial' | 'stale' | 'unavailable' | 'invalid';
type Currency = 'KRW' | 'USD' | 'USDT';
type Provider = 'kiwoom' | 'upbit' | 'bitget' | null;

type Level = {
  rank: number;
  price: number;
  quantity: number;
  cumulativeQuantity: number;
};

type Payload = {
  status: OrderbookStatus;
  assetClass: OrderbookAssetClass;
  market: OrderbookMarket;
  symbol: string;
  currency: Currency;
  provider: Provider;
  providerTimestamp: string | null;
  receivedAt: string;
  freshness: 'fresh' | 'stale' | 'unknown';
  asks: Level[];
  bids: Level[];
  bestAsk: number | null;
  bestBid: number | null;
  spread: number | null;
  spreadPct: number | null;
  imbalance: number | null;
  warnings: string[];
  reason: string | null;
  orderSubmitted: false;
  exchangeRequestSent: false;
};

const POLL_MS = 3_000;
const TIMEOUT_MS = 6_500;
const STATUSES: OrderbookStatus[] = ['ready', 'partial', 'stale', 'unavailable', 'invalid'];
const FAIL_CLOSED_CLIENT_ERRORS = new Set([
  'ORDERBOOK_RESPONSE_INVALID',
  'ORDERBOOK_LEVELS_CORRUPT',
  'ORDERBOOK_IDENTITY_MISMATCH',
]);

function finite(value: unknown): number | null {
  if (typeof value === 'boolean' || value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseLevel(value: unknown): Level | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const rank = finite(row.rank);
  const price = finite(row.price);
  const quantity = finite(row.quantity);
  const cumulativeQuantity = finite(row.cumulativeQuantity);
  if (
    rank == null || price == null || quantity == null || cumulativeQuantity == null
    || rank < 1 || price <= 0 || quantity <= 0 || cumulativeQuantity < quantity
  ) return null;
  return { rank: Math.trunc(rank), price, quantity, cumulativeQuantity };
}

function parsePayload(value: unknown): Payload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ORDERBOOK_RESPONSE_INVALID');
  }
  const row = value as Record<string, unknown>;
  const status = STATUSES.includes(row.status as OrderbookStatus)
    ? row.status as OrderbookStatus
    : null;
  const assetClass = ['stock', 'crypto_spot', 'crypto_futures'].includes(String(row.assetClass))
    ? row.assetClass as OrderbookAssetClass
    : null;
  const market = ['KR', 'US', 'UPBIT', 'BITGET'].includes(String(row.market))
    ? row.market as OrderbookMarket
    : null;
  const currency = ['KRW', 'USD', 'USDT'].includes(String(row.currency))
    ? row.currency as Currency
    : null;
  const symbol = cleanText(row.symbol)?.toUpperCase() ?? '';
  if (!status || !assetClass || !market || !currency || !symbol) {
    throw new Error('ORDERBOOK_RESPONSE_INVALID');
  }

  const levels = (input: unknown, side: 'ask' | 'bid') => {
    if (!Array.isArray(input)) throw new Error('ORDERBOOK_LEVELS_CORRUPT');
    const parsed = input.map(parseLevel);
    if (parsed.some((item) => item == null)) throw new Error('ORDERBOOK_LEVELS_CORRUPT');
    const rows = parsed as Level[];
    const seen = new Set<number>();
    for (const item of rows) {
      if (seen.has(item.price)) throw new Error('ORDERBOOK_LEVELS_CORRUPT');
      seen.add(item.price);
    }
    rows.sort((left, right) => side === 'ask' ? left.price - right.price : right.price - left.price);
    let cumulative = 0;
    for (const item of rows) {
      cumulative += item.quantity;
      if (Math.abs(item.cumulativeQuantity - cumulative) > 1e-8) {
        throw new Error('ORDERBOOK_LEVELS_CORRUPT');
      }
    }
    return rows;
  };

  const asks = levels(row.asks, 'ask');
  const bids = levels(row.bids, 'bid');
  if ((status === 'ready' || status === 'stale') && (asks.length === 0 || bids.length === 0)) {
    throw new Error('ORDERBOOK_LEVELS_CORRUPT');
  }
  if (status === 'partial' && ((asks.length === 0) === (bids.length === 0))) {
    throw new Error('ORDERBOOK_LEVELS_CORRUPT');
  }
  if ((status === 'unavailable' || status === 'invalid') && (asks.length > 0 || bids.length > 0)) {
    throw new Error('ORDERBOOK_LEVELS_CORRUPT');
  }

  const bestAsk = finite(row.bestAsk) ?? asks[0]?.price ?? null;
  const bestBid = finite(row.bestBid) ?? bids[0]?.price ?? null;
  const warnings = Array.isArray(row.warnings)
    ? row.warnings.filter((item): item is string => typeof item === 'string').slice(0, 20)
    : [];

  if (bestAsk != null && bestBid != null && bestBid >= bestAsk) {
    return {
      status: 'invalid', assetClass, market, symbol, currency,
      provider: null, providerTimestamp: null,
      receivedAt: cleanText(row.receivedAt) ?? '', freshness: 'unknown',
      asks: [], bids: [], bestAsk: null, bestBid: null, spread: null, spreadPct: null,
      imbalance: null,
      warnings: [...warnings, '교차 호가가 감지되어 클라이언트에서도 표시를 차단했습니다.'],
      reason: 'ORDERBOOK_CROSSED', orderSubmitted: false, exchangeRequestSent: false,
    };
  }

  const provider: Provider = row.provider === 'kiwoom' || row.provider === 'upbit' || row.provider === 'bitget'
    ? row.provider
    : null;
  const providerTimestamp = cleanText(row.providerTimestamp);
  const receivedAt = cleanText(row.receivedAt) ?? '';
  const freshness = row.freshness === 'fresh' || row.freshness === 'stale' ? row.freshness : 'unknown';

  return {
    status, assetClass, market, symbol, currency, provider,
    providerTimestamp: providerTimestamp && Number.isFinite(Date.parse(providerTimestamp)) ? providerTimestamp : null,
    receivedAt: receivedAt && Number.isFinite(Date.parse(receivedAt)) ? receivedAt : '',
    freshness,
    asks, bids, bestAsk, bestBid,
    spread: finite(row.spread),
    spreadPct: finite(row.spreadPct),
    imbalance: finite(row.imbalance),
    warnings,
    reason: cleanText(row.reason),
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

function canonicalRequestedSymbol(assetClass: OrderbookAssetClass, symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (assetClass === 'crypto_spot') return normalized.replace(/^KRW-/, '');
  if (assetClass === 'crypto_futures') {
    const base = normalized.replace(/-USDT$/, '').replace(/USDT$/, '');
    return `${base}USDT`;
  }
  return normalized;
}

function invalidPayloadForTarget(
  assetClass: OrderbookAssetClass,
  market: OrderbookMarket,
  symbol: string,
  reason: string,
): Payload {
  const currency: Currency = market === 'US' ? 'USD' : market === 'BITGET' ? 'USDT' : 'KRW';
  return {
    status: 'invalid',
    assetClass,
    market,
    symbol: canonicalRequestedSymbol(assetClass, symbol),
    currency,
    provider: null,
    providerTimestamp: null,
    receivedAt: new Date().toISOString(),
    freshness: 'unknown',
    asks: [],
    bids: [],
    bestAsk: null,
    bestBid: null,
    spread: null,
    spreadPct: null,
    imbalance: null,
    warnings: ['응답 identity 또는 호가 레벨 무결성이 요청 target과 일치하지 않아 표시를 차단했습니다.'],
    reason,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

function formatPrice(value: number | null, currency: Currency | undefined): string {
  if (value == null) return '-';
  return new Intl.NumberFormat(currency === 'KRW' ? 'ko-KR' : 'en-US', {
    maximumFractionDigits: currency === 'KRW' ? 0 : 8,
  }).format(value);
}

function formatQuantity(value: number | null): string {
  if (value == null) return '-';
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 8 }).format(value);
}

function formatTime(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '확인 불가';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value));
}

function providerLabel(provider: Provider): string {
  if (provider === 'kiwoom') return 'Kiwoom read-only';
  if (provider === 'upbit') return 'Upbit public REST';
  if (provider === 'bitget') return 'Bitget public REST';
  return 'Provider unavailable';
}

function statusLabel(data: Payload | null): string {
  if (!data) return '확인 전';
  if (data.status === 'ready') return 'Fresh';
  if (data.status === 'partial') return 'Partial';
  if (data.status === 'stale') return 'Stale';
  if (data.status === 'invalid') return 'Invalid';
  return 'Unavailable';
}

function LevelList({ side, levels, currency }: { side: 'ask' | 'bid'; levels: Level[]; currency: Currency }) {
  return (
    <div role="list" aria-label={side === 'ask' ? '매도 호가' : '매수 호가'} data-testid={`${side}-levels`}>
      {levels.map((level) => (
        <div
          role="listitem"
          data-testid={`${side}-level-${level.rank}`}
          key={`${side}-${level.price}`}
          className="grid min-h-10 grid-cols-[54px_1fr_1fr_1fr] items-center gap-1 border-b border-border/50 px-3 text-xs last:border-b-0"
        >
          <span className="text-muted-foreground">{side === 'ask' ? 'Ask' : 'Bid'} {level.rank}</span>
          <span className="text-right font-semibold tabular-nums">{formatPrice(level.price, currency)}</span>
          <span className="text-right tabular-nums">{formatQuantity(level.quantity)}</span>
          <span className="text-right tabular-nums">{formatQuantity(level.cumulativeQuantity)}</span>
        </div>
      ))}
    </div>
  );
}

export function InstrumentOrderbookDock({
  ticker,
  market,
  assetClass,
  defaultOpen = false,
}: {
  ticker: string;
  market: OrderbookMarket;
  assetClass: OrderbookAssetClass;
  defaultOpen?: boolean;
}) {
  const symbol = ticker.trim().toUpperCase();
  const targetKey = `${assetClass}:${market}:${symbol}`;
  const titleId = useId();
  const opener = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const controller = useRef<AbortController | null>(null);
  const timer = useRef<number | null>(null);
  const sequence = useRef(0);
  const lastGood = useRef<{ key: string; payload: Payload } | null>(null);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);
  const [open, setOpen] = useState(defaultOpen);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    sequence.current += 1;
    controller.current?.abort();
    controller.current = null;
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const schedule = useCallback(() => {
    if (!open || document.visibilityState !== 'visible') return;
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void loadRef.current(), POLL_MS);
  }, [open]);

  const load = useCallback(async () => {
    if (!open || document.visibilityState !== 'visible') return;
    if (timer.current != null) window.clearTimeout(timer.current);
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const current = ++sequence.current;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      request.abort();
    }, TIMEOUT_MS);
    setLoading(true);
    setError(null);

    try {
      const query = new URLSearchParams({ assetClass, market, symbol });
      const response = await authorizedFetch(`/api/orderbook?${query.toString()}`, {
        cache: 'no-store', signal: request.signal,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(
        body && typeof body === 'object' ? String((body as Record<string, unknown>).reason ?? `HTTP_${response.status}`) : `HTTP_${response.status}`,
      );
      const next = parsePayload(body);
      if (request.signal.aborted || current !== sequence.current) return;
      const expectedSymbol = canonicalRequestedSymbol(assetClass, symbol);
      if (next.assetClass !== assetClass || next.market !== market || next.symbol !== expectedSymbol) {
        throw new Error('ORDERBOOK_IDENTITY_MISMATCH');
      }

      if ((next.status === 'ready' || next.status === 'partial') && next.freshness === 'fresh') {
        lastGood.current = { key: targetKey, payload: next };
        setData(next);
      } else if (next.status === 'unavailable' && lastGood.current?.key === targetKey) {
        setData({
          ...lastGood.current.payload,
          status: 'stale',
          freshness: 'stale',
          warnings: [...lastGood.current.payload.warnings, '공급자 재조회 실패로 마지막 정상 호가를 stale 상태로 표시합니다.'],
        });
        setError(next.reason ?? 'ORDERBOOK_PROVIDER_UNAVAILABLE');
      } else {
        if (next.status === 'invalid') lastGood.current = null;
        setData(next);
      }

      if (next.status !== 'unavailable' || next.provider !== null) schedule();
    } catch (caught) {
      if (current !== sequence.current) return;
      if (request.signal.aborted && !timedOut) return;
      const message = timedOut
        ? 'ORDERBOOK_REQUEST_TIMEOUT'
        : caught instanceof Error ? caught.message : 'ORDERBOOK_REQUEST_FAILED';
      if (FAIL_CLOSED_CLIENT_ERRORS.has(message)) {
        lastGood.current = null;
        setData(invalidPayloadForTarget(assetClass, market, symbol, message));
      } else if (lastGood.current?.key === targetKey) {
        setData({ ...lastGood.current.payload, status: 'stale', freshness: 'stale' });
      }
      setError(message);
      schedule();
    } finally {
      window.clearTimeout(timeout);
      if (current === sequence.current) {
        setLoading(false);
        controller.current = null;
      }
    }
  }, [assetClass, market, open, schedule, symbol, targetKey]);

  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => {
    stop();
    lastGood.current = null;
    setData(null);
    setError(null);
  }, [stop, targetKey]);
  useEffect(() => {
    if (!open) { stop(); return; }
    void loadRef.current();
    const focusFrame = window.requestAnimationFrame(() => closeButton.current?.focus());
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
      else void loadRef.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [open, stop, targetKey]);

  const close = useCallback(() => {
    setOpen(false);
    stop();
    window.requestAnimationFrame(() => opener.current?.focus());
  }, [stop]);

  const backdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) close();
  };
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog.current.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close, open]);

  const currency = data?.currency ?? (market === 'US' ? 'USD' : market === 'BITGET' ? 'USDT' : 'KRW');
  const imbalance = useMemo(() => data?.imbalance == null ? '-' : `${(data.imbalance * 100).toFixed(1)}%`, [data?.imbalance]);

  return (
    <>
      <button
        ref={opener}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="읽기 전용 호가창 열기"
        className="fixed bottom-[calc(env(safe-area-inset-bottom)+5rem)] right-4 z-40 inline-flex min-h-11 items-center gap-2 rounded-full border border-border bg-background/95 px-4 py-2 text-sm font-semibold shadow-lg"
      >
        <BookOpen className="h-4 w-4" aria-hidden />호가
      </button>

      {open ? (
        <div data-testid="instrument-orderbook-backdrop" onMouseDown={backdrop} className="fixed inset-0 z-[90] flex items-end justify-center bg-black/50 sm:items-center sm:p-4">
          <section
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            data-testid="instrument-orderbook-dialog"
            className="flex max-h-[92dvh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl border border-border bg-background shadow-2xl sm:rounded-2xl"
          >
            <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id={titleId} className="font-bold">{symbol} 호가창</h2>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px]">읽기 전용</span>
                  <span className="rounded-full border border-border px-2 py-0.5 text-[11px]">{statusLabel(data)}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{providerLabel(data?.provider ?? null)} · 주문/취소/정정 기능 없음</p>
              </div>
              <div className="flex gap-1">
                <button type="button" aria-label="호가 새로고침" disabled={loading} onClick={() => void loadRef.current()} className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-accent disabled:opacity-50">
                  <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
                </button>
                <button ref={closeButton} type="button" aria-label="호가창 닫기" onClick={close} className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-accent">
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
            </header>

            <div className="min-h-0 overflow-y-auto overscroll-contain">
              <div className="grid grid-cols-2 gap-2 border-b border-border p-3 text-xs sm:grid-cols-4">
                <div><span className="text-muted-foreground">Best Ask</span><strong className="mt-1 block tabular-nums">{formatPrice(data?.bestAsk ?? null, currency)}</strong></div>
                <div><span className="text-muted-foreground">Best Bid</span><strong className="mt-1 block tabular-nums">{formatPrice(data?.bestBid ?? null, currency)}</strong></div>
                <div><span className="text-muted-foreground">Spread</span><strong className="mt-1 block tabular-nums">{formatPrice(data?.spread ?? null, currency)}</strong></div>
                <div><span className="text-muted-foreground">Spread %</span><strong className="mt-1 block tabular-nums">{data?.spreadPct == null ? '-' : `${data.spreadPct.toFixed(4)}%`}</strong></div>
              </div>

              <div className="grid grid-cols-2 gap-x-3 border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
                <span>Provider Update: {formatTime(data?.providerTimestamp)}</span>
                <span className="text-right">Received: {formatTime(data?.receivedAt)}</span>
                <span>Freshness: {data?.freshness ?? 'unknown'}</span>
                <span className="text-right">Depth imbalance: {imbalance}</span>
              </div>

              {error ? (
                <div className="flex items-start gap-2 border-b border-border bg-amber-500/10 px-3 py-2 text-xs" role="status">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>{error}</span>
                </div>
              ) : null}

              {data?.warnings.map((warning) => (
                <p className="border-b border-border/50 px-3 py-2 text-xs text-muted-foreground" key={warning}>{warning}</p>
              ))}

              <div className="grid grid-cols-[54px_1fr_1fr_1fr] gap-1 border-b border-border bg-muted/40 px-3 py-2 text-[11px] font-semibold">
                <span>Side</span><span className="text-right">Price</span><span className="text-right">Quantity</span><span className="text-right">Cumulative</span>
              </div>
              <LevelList side="ask" levels={data?.asks ?? []} currency={currency} />
              <LevelList side="bid" levels={data?.bids ?? []} currency={currency} />

              {!loading && data && data.asks.length === 0 && data.bids.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">표시 가능한 실제 호가가 없습니다.</p>
              ) : null}
              {!data && loading ? <p className="px-4 py-8 text-center text-sm text-muted-foreground">호가를 불러오는 중입니다.</p> : null}
            </div>

            <footer className="border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
              Depth imbalance는 참고용 호가 통계이며 거래 신호가 아닙니다. ORDERBOOK_IMBALANCE != TRADE_SIGNAL
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}