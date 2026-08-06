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
import { cn } from '@/lib/utils';

type AssetClass = 'stock' | 'crypto_spot' | 'crypto_futures';
type Market = 'KR' | 'US' | 'UPBIT' | 'BITGET';
type Status = 'ready' | 'partial' | 'unavailable' | 'invalid' | 'provider_error';
type Currency = 'KRW' | 'USD' | 'USDT';
type Provider = 'kiwoom' | 'upbit' | 'bitget' | null;
type Source =
  | 'ka10004'
  | 'upbit_v1_orderbook'
  | 'bitget_v2_mix_market_merge_depth'
  | null;

type Level = {
  rank: number;
  price: number;
  quantity: number;
  cumulativeQuantity: number;
};

type Payload = {
  ok: boolean;
  available: boolean;
  status: Status;
  assetClass: AssetClass;
  market: Market;
  symbol: string;
  ticker: string;
  currency: Currency;
  provider: Provider;
  source: Source;
  sourceTimestampRaw: string | null;
  updatedAt: string | null;
  receivedAt: string;
  freshness: 'fresh' | 'stale' | 'unknown';
  stale: boolean;
  asks: Level[];
  bids: Level[];
  bestAsk: number | null;
  bestBid: number | null;
  spread: number | null;
  spreadPercent: number | null;
  displayedAskQuantity: number;
  displayedBidQuantity: number;
  totalAskQuantity: number | null;
  totalBidQuantity: number | null;
  imbalance: number | null;
  warnings: string[];
  reason: string | null;
};

const POLL_MS = 3_000;
const TIMEOUT_MS = 8_000;
const ASSET_CLASSES: AssetClass[] = ['stock', 'crypto_spot', 'crypto_futures'];
const MARKETS: Market[] = ['KR', 'US', 'UPBIT', 'BITGET'];
const STATUSES: Status[] = ['ready', 'partial', 'unavailable', 'invalid', 'provider_error'];
const CURRENCIES: Currency[] = ['KRW', 'USD', 'USDT'];

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
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
    rank == null
    || price == null
    || quantity == null
    || cumulativeQuantity == null
    || rank < 1
    || rank > 10
    || price <= 0
    || quantity <= 0
    || cumulativeQuantity < quantity
  ) {
    return null;
  }
  return { rank: Math.trunc(rank), price, quantity, cumulativeQuantity };
}

function invalidCrossedPayload(options: {
  assetClass: AssetClass;
  market: Market;
  symbol: string;
  currency: Currency;
  provider: Provider;
  source: Source;
  receivedAt: string;
  sourceTimestampRaw: string | null;
  warnings: string[];
}): Payload {
  return {
    ok: false,
    available: false,
    status: 'invalid',
    assetClass: options.assetClass,
    market: options.market,
    symbol: options.symbol,
    ticker: options.symbol,
    currency: options.currency,
    provider: options.provider,
    source: options.source,
    sourceTimestampRaw: options.sourceTimestampRaw,
    updatedAt: null,
    receivedAt: options.receivedAt,
    freshness: 'unknown',
    stale: true,
    asks: [],
    bids: [],
    bestAsk: null,
    bestBid: null,
    spread: null,
    spreadPercent: null,
    displayedAskQuantity: 0,
    displayedBidQuantity: 0,
    totalAskQuantity: null,
    totalBidQuantity: null,
    imbalance: null,
    warnings: [
      ...options.warnings,
      '교차 호가가 감지되어 클라이언트에서도 표시를 차단했습니다.',
    ],
    reason: 'ORDERBOOK_CROSSED',
  };
}

function parsePayload(value: unknown): Payload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ORDERBOOK_RESPONSE_INVALID');
  }
  const row = value as Record<string, unknown>;
  const assetClass = ASSET_CLASSES.includes(row.assetClass as AssetClass)
    ? row.assetClass as AssetClass
    : null;
  const market = MARKETS.includes(row.market as Market) ? row.market as Market : null;
  const status = STATUSES.includes(row.status as Status) ? row.status as Status : null;
  const currency = CURRENCIES.includes(row.currency as Currency)
    ? row.currency as Currency
    : null;
  const symbol = (text(row.symbol) ?? text(row.ticker) ?? '').toUpperCase();
  if (!assetClass || !market || !status || !currency || !symbol) {
    throw new Error('ORDERBOOK_RESPONSE_INVALID');
  }

  const levels = (input: unknown) => Array.isArray(input)
    ? input.map(parseLevel).filter((item): item is Level => item != null)
    : [];
  const asks = levels(row.asks).sort((left, right) => left.price - right.price);
  const bids = levels(row.bids).sort((left, right) => right.price - left.price);
  const bestAsk = finite(row.bestAsk) ?? asks[0]?.price ?? null;
  const bestBid = finite(row.bestBid) ?? bids[0]?.price ?? null;
  const provider: Provider = row.provider === 'kiwoom'
    || row.provider === 'upbit'
    || row.provider === 'bitget'
    ? row.provider
    : null;
  const source: Source = row.source === 'ka10004'
    || row.source === 'upbit_v1_orderbook'
    || row.source === 'bitget_v2_mix_market_merge_depth'
    ? row.source
    : null;
  const updatedAtRaw = text(row.updatedAt);
  const receivedAtRaw = text(row.receivedAt);
  const warnings = Array.isArray(row.warnings)
    ? row.warnings
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 20)
    : [];

  if (row.available === true && bestAsk != null && bestBid != null && bestBid >= bestAsk) {
    return invalidCrossedPayload({
      assetClass,
      market,
      symbol,
      currency,
      provider,
      source,
      receivedAt: receivedAtRaw ?? '',
      sourceTimestampRaw: text(row.sourceTimestampRaw),
      warnings,
    });
  }

  return {
    ok: row.ok === true,
    available: row.available === true,
    status,
    assetClass,
    market,
    symbol,
    ticker: text(row.ticker)?.toUpperCase() ?? symbol,
    currency,
    provider,
    source,
    sourceTimestampRaw: text(row.sourceTimestampRaw),
    updatedAt: updatedAtRaw && Number.isFinite(Date.parse(updatedAtRaw))
      ? updatedAtRaw
      : null,
    receivedAt: receivedAtRaw && Number.isFinite(Date.parse(receivedAtRaw))
      ? receivedAtRaw
      : '',
    freshness: row.freshness === 'fresh' || row.freshness === 'stale'
      ? row.freshness
      : 'unknown',
    stale: row.stale !== false,
    asks,
    bids,
    bestAsk,
    bestBid,
    spread: finite(row.spread),
    spreadPercent: finite(row.spreadPercent),
    displayedAskQuantity: finite(row.displayedAskQuantity) ?? 0,
    displayedBidQuantity: finite(row.displayedBidQuantity) ?? 0,
    totalAskQuantity: finite(row.totalAskQuantity),
    totalBidQuantity: finite(row.totalBidQuantity),
    imbalance: finite(row.imbalance),
    warnings,
    reason: text(row.reason),
  };
}

function priceText(value: number, currency: Currency): string {
  return new Intl.NumberFormat(
    currency === 'KRW' ? 'ko-KR' : 'en-US',
    currency === 'KRW'
      ? { maximumFractionDigits: 0 }
      : currency === 'USD'
        ? { minimumFractionDigits: 2, maximumFractionDigits: 4 }
        : { minimumFractionDigits: 0, maximumFractionDigits: 8 },
  ).format(value);
}

function quantityText(value: number | null): string {
  return value == null
    ? '-'
    : new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 8 }).format(value);
}

function timeText(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '-';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function reasonText(reason: string | null): string {
  return ({
    US_ORDERBOOK_PROVIDER_NOT_CONNECTED: '미국 주식 호가 공급자는 아직 연결되지 않았습니다.',
    ORDERBOOK_CROSSED: '교차 호가가 감지되어 안전을 위해 표시를 차단했습니다.',
    ORDERBOOK_LEVELS_EMPTY: '공급자가 유효한 호가 잔량을 반환하지 않았습니다.',
    ORDERBOOK_PROVIDER_NOT_CONFIGURED: '키움 호가 공급자 설정을 확인할 수 없습니다.',
    ORDERBOOK_PROVIDER_TIMEOUT: '키움 호가 공급자 응답 시간이 초과되었습니다.',
    ORDERBOOK_PROVIDER_UNAVAILABLE: '키움 호가 공급자를 사용할 수 없습니다.',
    UPBIT_ORDERBOOK_RATE_LIMITED: 'Upbit 공개 호가 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.',
    UPBIT_ORDERBOOK_REQUEST_ABORTED: 'Upbit 공개 호가 요청이 화면 전환으로 취소되었습니다.',
    UPBIT_ORDERBOOK_PROVIDER_TIMEOUT: 'Upbit 공개 호가 응답 시간이 초과되었습니다.',
    UPBIT_ORDERBOOK_PROVIDER_UNAVAILABLE: 'Upbit 공개 호가 공급자를 사용할 수 없습니다.',
    UPBIT_ORDERBOOK_RESPONSE_INVALID: 'Upbit 공개 호가 응답 형식이 올바르지 않습니다.',
    BITGET_ORDERBOOK_RATE_LIMITED: 'Bitget 공개 호가 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.',
    BITGET_ORDERBOOK_REQUEST_ABORTED: 'Bitget 공개 호가 요청이 화면 전환으로 취소되었습니다.',
    BITGET_ORDERBOOK_PROVIDER_TIMEOUT: 'Bitget 공개 호가 응답 시간이 초과되었습니다.',
    BITGET_ORDERBOOK_PROVIDER_UNAVAILABLE: 'Bitget 공개 호가 공급자를 사용할 수 없습니다.',
    BITGET_ORDERBOOK_PROVIDER_ERROR: 'Bitget 공개 호가 공급자가 오류를 반환했습니다.',
    BITGET_ORDERBOOK_RESPONSE_INVALID: 'Bitget 공개 호가 응답 형식이 올바르지 않습니다.',
    INVALID_STOCK_TICKER: '주식 종목 코드 형식이 올바르지 않습니다.',
    INVALID_ORDERBOOK_TARGET: '호가 조회 대상 형식이 올바르지 않습니다.',
    ORDERBOOK_RESPONSE_INVALID: '서버 호가 응답 형식이 올바르지 않습니다.',
    ORDERBOOK_REQUEST_TIMEOUT: '호가 조회 요청 시간이 초과되었습니다.',
    ORDERBOOK_REQUEST_FAILED: '호가 조회 요청에 실패했습니다.',
  }[reason ?? ''] ?? '호가 데이터를 불러올 수 없습니다.');
}

function providerText(data: Payload | null): string {
  if (data?.provider === 'kiwoom') return '키움 ka10004';
  if (data?.provider === 'upbit') return 'Upbit 공개 REST';
  if (data?.provider === 'bitget') return 'Bitget 공개 REST';
  return '미연결';
}

function marketText(assetClass: AssetClass, market: Market): string {
  if (assetClass === 'crypto_spot') return 'Upbit 코인 현물 · KRW';
  if (assetClass === 'crypto_futures') return 'Bitget 코인 선물 · USDT';
  return market === 'KR' ? 'KRX 국내주식 · KRW' : '미국주식 · USD';
}

function LevelRow({
  item,
  side,
  currency,
  max,
}: {
  item: Level;
  side: 'ask' | 'bid';
  currency: Currency;
  max: number;
}) {
  const sideText = side === 'ask' ? '매도' : '매수';
  const width = max > 0
    ? Math.max(4, Math.min(100, item.cumulativeQuantity / max * 100))
    : 0;
  return (
    <div
      role="listitem"
      aria-label={`${sideText} ${item.rank}호 가격 ${priceText(item.price, currency)} 잔량 ${quantityText(item.quantity)} 누적잔량 ${quantityText(item.cumulativeQuantity)}`}
      data-testid={`${side}-level-${item.rank}`}
      className="relative grid min-h-10 grid-cols-[38px_minmax(82px,1fr)_minmax(64px,1fr)_minmax(72px,1fr)] items-center overflow-hidden border-b border-border/50 px-2 text-[11px] last:border-b-0 sm:px-3 sm:text-xs"
    >
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-1 right-0 rounded-l opacity-15',
          side === 'ask' ? 'bg-rose-500' : 'bg-sky-500',
        )}
        style={{ width: `${width}%` }}
      />
      <span className="relative text-muted-foreground">{sideText} {item.rank}호</span>
      <span className={cn(
        'relative text-right font-semibold tabular-nums',
        side === 'ask' ? 'text-rose-500' : 'text-sky-500',
      )}>
        {priceText(item.price, currency)}
      </span>
      <span className="relative text-right tabular-nums">{quantityText(item.quantity)}</span>
      <span className="relative text-right tabular-nums">{quantityText(item.cumulativeQuantity)}</span>
    </div>
  );
}

export function InstrumentOrderbookDock({
  ticker,
  market,
  assetClass = market === 'UPBIT'
    ? 'crypto_spot'
    : market === 'BITGET'
      ? 'crypto_futures'
      : 'stock',
  defaultOpen = false,
}: {
  ticker: string;
  market: Market;
  assetClass?: AssetClass;
  defaultOpen?: boolean;
}) {
  const symbol = ticker.trim().toUpperCase();
  const targetKey = `${assetClass}:${market}:${symbol}`;
  const titleId = useId();
  const descriptionId = useId();
  const opener = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const timer = useRef<number | null>(null);
  const lastGood = useRef<{ targetKey: string; payload: Payload } | null>(null);
  const wasOpen = useRef(defaultOpen);
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

  const closeDialog = useCallback(() => {
    setOpen(false);
    window.requestAnimationFrame(() => opener.current?.focus());
  }, []);

  const schedule = useCallback(() => {
    if (document.visibilityState !== 'visible') return;
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void loadRef.current(), POLL_MS);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (timer.current != null) window.clearTimeout(timer.current);
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const current = ++sequence.current;
    let timedOut = false;
    setLoading(true);
    setError(null);
    const timeout = window.setTimeout(() => {
      timedOut = true;
      request.abort();
    }, TIMEOUT_MS);

    try {
      const query = new URLSearchParams({ assetClass, market, symbol });
      const response = await authorizedFetch(`/api/orderbook?${query.toString()}`, {
        cache: 'no-store',
        signal: request.signal,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const reason = body && typeof body === 'object'
          ? String((body as Record<string, unknown>).reason ?? '')
          : `ORDERBOOK_HTTP_${response.status}`;
        throw new Error(reason || `ORDERBOOK_HTTP_${response.status}`);
      }
      const next = parsePayload(body);
      if (request.signal.aborted || current !== sequence.current) return;

      if (next.status === 'ready' || next.status === 'partial') {
        lastGood.current = { targetKey, payload: next };
        setData(next);
      } else if (next.status === 'provider_error') {
        if (lastGood.current?.targetKey === targetKey) {
          setData(lastGood.current.payload);
        } else {
          setData(next);
        }
        setError(next.reason ?? 'ORDERBOOK_REQUEST_FAILED');
      } else {
        setData(next);
      }

      if (next.status !== 'unavailable') schedule();
    } catch (caught) {
      if (current !== sequence.current) return;
      if (request.signal.aborted && !timedOut) return;
      setError(
        timedOut
          ? 'ORDERBOOK_REQUEST_TIMEOUT'
          : caught instanceof Error
            ? caught.message
            : 'ORDERBOOK_REQUEST_FAILED',
      );
      schedule();
    } finally {
      window.clearTimeout(timeout);
      if (current === sequence.current) {
        setLoading(false);
        controller.current = null;
      }
    }
  }, [assetClass, market, schedule, symbol, targetKey]);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    stop();
    lastGood.current = null;
    setData(null);
    setError(null);
  }, [stop, targetKey]);

  useEffect(() => {
    if (!open) {
      stop();
      return;
    }
    void loadRef.current();
    const visibility = () => {
      if (document.visibilityState === 'hidden') stop();
      else void loadRef.current();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      stop();
    };
  }, [open, stop, targetKey]);

  useEffect(() => {
    if (!open) {
      if (wasOpen.current) opener.current?.focus();
      wasOpen.current = false;
      return;
    }
    wasOpen.current = true;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDialog();
        return;
      }
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = [
        ...dialog.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]),[href],[tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (!focusable.length) {
        event.preventDefault();
        dialog.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', keydown);
    window.requestAnimationFrame(() => dialog.current?.focus());
    return () => window.removeEventListener('keydown', keydown);
  }, [closeDialog, open]);

  const max = useMemo(() => Math.max(
    0,
    ...(data?.asks ?? []).map((item) => item.cumulativeQuantity),
    ...(data?.bids ?? []).map((item) => item.cumulativeQuantity),
  ), [data]);
  const hasLevels = Boolean(data?.available && (data.asks.length || data.bids.length));
  const imbalance = data?.imbalance == null
    ? '-'
    : data.imbalance > 0.1
      ? `매수 우위 ${(data.imbalance * 100).toFixed(1)}%`
      : data.imbalance < -0.1
        ? `매도 우위 ${(Math.abs(data.imbalance) * 100).toFixed(1)}%`
        : `균형 ${(data.imbalance * 100).toFixed(1)}%`;
  const freshness = !data
    ? '확인 전'
    : data.freshness === 'fresh'
      ? '공급자 시각 기준 최신'
      : data.freshness === 'stale'
        ? '공급자 시각 기준 지연'
        : '공급자 최신성 확인 불가';
  const backdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) closeDialog();
  };

  return (
    <>
      <button
        ref={opener}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="읽기 전용 호가창 열기"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="fixed bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] right-4 z-40 inline-flex min-h-11 items-center gap-2 rounded-full border border-border bg-background/95 px-4 py-2 text-sm font-semibold shadow-lg backdrop-blur hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <BookOpen className="h-4 w-4" aria-hidden />호가창
      </button>

      {open ? (
        <div
          onMouseDown={backdrop}
          className="fixed inset-0 z-[80] flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
          data-testid="orderbook-backdrop"
        >
          <div
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            tabIndex={-1}
            className="flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-border bg-background shadow-2xl outline-none sm:rounded-2xl"
            data-testid="instrument-orderbook-dialog"
          >
            <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id={titleId} className="text-base font-bold">{symbol} 호가창</h2>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium">읽기 전용</span>
                </div>
                <p id={descriptionId} className="mt-1 text-xs text-muted-foreground">
                  {marketText(assetClass, market)} · 주문 기능 없음
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => void loadRef.current()}
                  disabled={loading}
                  aria-label="호가 새로고침"
                  className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-accent disabled:opacity-50"
                >
                  <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={closeDialog}
                  aria-label="호가창 닫기"
                  className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-accent"
                >
                  <X className="h-5 w-5" aria-hidden />
                </button>
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <section className="grid grid-cols-2 gap-px bg-border text-xs sm:grid-cols-4">
                {[
                  ['공급자', providerText(data)],
                  ['스프레드', data?.spread == null ? '-' : priceText(data.spread, data.currency)],
                  ['스프레드율', data?.spreadPercent == null ? '-' : `${data.spreadPercent.toFixed(3)}%`],
                  ['잔량 균형', imbalance],
                ].map(([label, value]) => (
                  <div key={label} className="bg-background px-3 py-2">
                    <div className="text-[11px] text-muted-foreground">{label}</div>
                    <div className="mt-0.5 truncate font-semibold tabular-nums">{value}</div>
                  </div>
                ))}
              </section>

              <section className="border-b border-border px-4 py-2 text-xs" aria-live="polite">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={cn(
                    'font-medium',
                    data?.freshness === 'fresh' && !error ? 'text-emerald-600' : 'text-amber-600',
                  )}>
                    {error && hasLevels ? '갱신 실패 · 마지막 정상 데이터' : freshness}
                  </span>
                  <span className="text-muted-foreground">공급자 시각 {timeText(data?.updatedAt ?? null)}</span>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  서버 수신 {timeText(data?.receivedAt || null)}
                  {data?.sourceTimestampRaw ? ` · 원문 시각 ${data.sourceTimestampRaw}` : ''}
                </div>
              </section>

              {error && !hasLevels ? (
                <section role="alert" className="m-4 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
                  <div className="flex gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
                    <div>
                      <div className="font-semibold">호가 조회 실패</div>
                      <p className="mt-1 text-muted-foreground">{reasonText(error)}</p>
                      <button
                        type="button"
                        onClick={() => void loadRef.current()}
                        className="mt-3 min-h-11 rounded-lg border border-border px-3 font-medium hover:bg-accent"
                      >
                        다시 시도
                      </button>
                    </div>
                  </div>
                </section>
              ) : null}

              {error && hasLevels ? (
                <section role="status" className="mx-4 mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
                  {reasonText(error)} 마지막 정상 데이터의 공급자·서버 기준시각을 유지합니다.
                </section>
              ) : null}

              {!error && !loading && data && !data.available ? (
                <section role="status" className="m-4 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
                  <div className="flex gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                    <div>
                      <div className="font-semibold">호가 제공 불가</div>
                      <p className="mt-1 text-muted-foreground">{reasonText(data.reason)}</p>
                    </div>
                  </div>
                </section>
              ) : null}

              {loading && !data ? (
                <section aria-label="호가 로딩 중" className="space-y-2 p-4">
                  {Array.from({ length: 8 }, (_, index) => (
                    <div key={index} className="h-10 animate-pulse rounded-lg bg-muted" />
                  ))}
                </section>
              ) : null}

              {hasLevels && data ? (
                <section aria-label="호가 잔량">
                  <div className="grid grid-cols-[38px_minmax(82px,1fr)_minmax(64px,1fr)_minmax(72px,1fr)] border-b border-border bg-muted/50 px-2 py-2 text-[10px] font-medium text-muted-foreground sm:px-3 sm:text-[11px]">
                    <span>단계</span>
                    <span className="text-right">가격</span>
                    <span className="text-right">잔량</span>
                    <span className="text-right">누적잔량</span>
                  </div>
                  <div role="list" aria-label="매도 호가" data-testid="ask-levels">
                    {data.asks.slice().reverse().map((item) => (
                      <LevelRow key={`a-${item.rank}-${item.price}`} item={item} side="ask" currency={data.currency} max={max} />
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-px border-y border-border bg-border text-xs">
                    <div className="bg-background px-3 py-2">
                      <div className="text-[11px] text-muted-foreground">표시/공급자 매도잔량</div>
                      <div className="font-semibold tabular-nums">
                        {quantityText(data.displayedAskQuantity)} / {quantityText(data.totalAskQuantity)}
                      </div>
                    </div>
                    <div className="bg-background px-3 py-2 text-right">
                      <div className="text-[11px] text-muted-foreground">표시/공급자 매수잔량</div>
                      <div className="font-semibold tabular-nums">
                        {quantityText(data.displayedBidQuantity)} / {quantityText(data.totalBidQuantity)}
                      </div>
                    </div>
                  </div>
                  <div role="list" aria-label="매수 호가" data-testid="bid-levels">
                    {data.bids.map((item) => (
                      <LevelRow key={`b-${item.rank}-${item.price}`} item={item} side="bid" currency={data.currency} max={max} />
                    ))}
                  </div>
                </section>
              ) : null}

              {data?.warnings.length ? (
                <section className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
                  <div className="font-medium text-foreground">데이터 주의사항</div>
                  <ul className="mt-1 space-y-1">
                    {data.warnings.map((warning) => <li key={warning}>· {warning}</li>)}
                  </ul>
                </section>
              ) : null}
            </div>

            <footer className="border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
              공개 REST 호가를 3초 주기로 조회합니다. WebSocket 실시간 스트림이 아니며 주문·취소·계좌 API를 호출하지 않습니다.
            </footer>
          </div>
        </div>
      ) : null}
    </>
  );
}
