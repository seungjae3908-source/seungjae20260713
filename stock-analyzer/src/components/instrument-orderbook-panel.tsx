import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { cn } from '@/lib/utils';

export type InstrumentOrderbookMarket = 'KR' | 'US';
type Level = { rank: number; price: number; quantity: number; cumulativeQuantity: number };
type Payload = {
  available: boolean;
  status: 'ready' | 'partial' | 'unavailable' | 'invalid' | 'provider_error';
  currency: 'KRW' | 'USD';
  provider: 'kiwoom' | null;
  updatedAt: string | null;
  receivedAt: string;
  freshness: 'fresh' | 'stale' | 'unknown';
  asks: Level[];
  bids: Level[];
  spread: number | null;
  spreadPercent: number | null;
  displayedAskQuantity: number;
  displayedBidQuantity: number;
  imbalance: number | null;
  warnings: string[];
  reason: string | null;
};

const POLL_MS = 3_000;
const TIMEOUT_MS = 8_000;
const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : null;
const reasonText = (reason: string | null) => ({
  US_ORDERBOOK_PROVIDER_NOT_CONNECTED: '미국 주식 호가 공급자는 아직 연결되지 않았습니다.',
  ORDERBOOK_CROSSED: '교차 호가가 감지되어 표시를 차단했습니다.',
  ORDERBOOK_LEVELS_EMPTY: '유효한 호가 잔량이 없습니다.',
  ORDERBOOK_PROVIDER_NOT_CONFIGURED: '키움 호가 공급자 설정을 확인할 수 없습니다.',
  ORDERBOOK_PROVIDER_TIMEOUT: '호가 공급자 응답 시간이 초과되었습니다.',
}[reason ?? ''] ?? '호가 데이터를 불러올 수 없습니다.');

function parseLevel(value: unknown): Level | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const rank = number(row.rank);
  const price = number(row.price);
  const quantity = number(row.quantity);
  const cumulativeQuantity = number(row.cumulativeQuantity);
  if (rank == null || price == null || quantity == null || cumulativeQuantity == null
    || rank < 1 || rank > 10 || price <= 0 || quantity < 0 || cumulativeQuantity < quantity) return null;
  return { rank: Math.trunc(rank), price, quantity, cumulativeQuantity };
}

function parsePayload(value: unknown, market: InstrumentOrderbookMarket): Payload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ORDERBOOK_RESPONSE_INVALID');
  const row = value as Record<string, unknown>;
  const validStatus = ['ready', 'partial', 'unavailable', 'invalid', 'provider_error'].includes(String(row.status));
  if (!validStatus || row.market !== market) throw new Error('ORDERBOOK_RESPONSE_INVALID');
  const levels = (input: unknown) => Array.isArray(input)
    ? input.map(parseLevel).filter((item): item is Level => item != null)
    : [];
  return {
    available: row.available === true,
    status: row.status as Payload['status'],
    currency: market === 'KR' ? 'KRW' : 'USD',
    provider: row.provider === 'kiwoom' ? 'kiwoom' : null,
    updatedAt: typeof row.updatedAt === 'string' && Number.isFinite(Date.parse(row.updatedAt)) ? row.updatedAt : null,
    receivedAt: typeof row.receivedAt === 'string' && Number.isFinite(Date.parse(row.receivedAt)) ? row.receivedAt : '',
    freshness: row.freshness === 'fresh' || row.freshness === 'stale' ? row.freshness : 'unknown',
    asks: levels(row.asks),
    bids: levels(row.bids),
    spread: number(row.spread),
    spreadPercent: number(row.spreadPercent),
    displayedAskQuantity: number(row.displayedAskQuantity) ?? 0,
    displayedBidQuantity: number(row.displayedBidQuantity) ?? 0,
    imbalance: number(row.imbalance),
    warnings: Array.isArray(row.warnings)
      ? row.warnings.filter((item): item is string => typeof item === 'string').slice(0, 20)
      : [],
    reason: typeof row.reason === 'string' ? row.reason : null,
  };
}

const priceText = (value: number, currency: 'KRW' | 'USD') => new Intl.NumberFormat(
  currency === 'KRW' ? 'ko-KR' : 'en-US',
  currency === 'KRW' ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 4 },
).format(value);
const quantityText = (value: number) => new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 4 }).format(value);
const timeText = (value: string | null) => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value))
  : '-';

export function InstrumentOrderbookPanel({ ticker, market }: { ticker: string; market: InstrumentOrderbookMarket }) {
  const symbol = ticker.trim().toUpperCase();
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const timer = useRef<number | null>(null);
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

  const load = useCallback(async () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const current = ++sequence.current;
    setLoading(true);
    setError(null);
    const timeout = window.setTimeout(() => request.abort(), TIMEOUT_MS);
    try {
      const response = await authorizedFetch(`/api/stocks/${encodeURIComponent(symbol)}/orderbook?market=${market}`, {
        cache: 'no-store',
        signal: request.signal,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body && typeof body === 'object' ? String((body as Record<string, unknown>).reason ?? '') : `ORDERBOOK_HTTP_${response.status}`);
      const next = parsePayload(body, market);
      if (request.signal.aborted || current !== sequence.current) return;
      setData(next);
      if (next.available && (next.status === 'ready' || next.status === 'partial') && document.visibilityState === 'visible') {
        timer.current = window.setTimeout(() => void load(), POLL_MS);
      }
    } catch (caught) {
      if (!request.signal.aborted && current === sequence.current) setError(caught instanceof Error ? caught.message : 'ORDERBOOK_REQUEST_FAILED');
    } finally {
      window.clearTimeout(timeout);
      if (current === sequence.current) {
        setLoading(false);
        controller.current = null;
      }
    }
  }, [market, symbol]);

  useEffect(() => {
    setData(null);
    setError(null);
    void load();
    const visibility = () => document.visibilityState === 'hidden' ? stop() : void load();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      stop();
    };
  }, [load, stop]);

  const max = useMemo(() => Math.max(0,
    ...(data?.asks ?? []).map((item) => item.cumulativeQuantity),
    ...(data?.bids ?? []).map((item) => item.cumulativeQuantity)), [data]);
  const hasLevels = Boolean(data?.available && (data.asks.length || data.bids.length));
  const imbalance = data?.imbalance == null ? '-'
    : data.imbalance > 0.1 ? `매수 우위 ${(data.imbalance * 100).toFixed(1)}%`
      : data.imbalance < -0.1 ? `매도 우위 ${(Math.abs(data.imbalance) * 100).toFixed(1)}%`
        : `균형 ${(data.imbalance * 100).toFixed(1)}%`;

  const rows = (items: Level[], side: 'ask' | 'bid') => items.map((item) => {
    const width = max > 0 ? Math.max(4, Math.min(100, item.cumulativeQuantity / max * 100)) : 0;
    return <div key={`${side}-${item.rank}-${item.price}`} data-testid={`${side}-level-${item.rank}`} className="relative grid min-h-9 grid-cols-[40px_1fr_1fr] items-center overflow-hidden border-b border-border/50 px-3 text-xs last:border-0">
      <div aria-hidden className={cn('absolute inset-y-1 right-0 opacity-15', side === 'ask' ? 'bg-rose-500' : 'bg-sky-500')} style={{ width: `${width}%` }} />
      <span className="relative text-muted-foreground">{item.rank}호</span>
      <strong className={cn('relative text-right tabular-nums', side === 'ask' ? 'text-rose-500' : 'text-sky-500')}>{priceText(item.price, data!.currency)}</strong>
      <span className="relative text-right tabular-nums">{quantityText(item.quantity)}</span>
    </div>;
  });

  return <section data-testid="instrument-orderbook-panel" className="overflow-hidden rounded-3xl border border-card-border bg-card shadow-sm">
    <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
      <div><div className="flex items-center gap-2"><h2 className="font-bold">{symbol} 호가창</h2><span className="rounded-full bg-muted px-2 py-0.5 text-[11px]">읽기 전용</span></div><p className="mt-1 text-xs text-muted-foreground">{market === 'KR' ? 'KRX · KRW' : '미국 주식 · USD'} · 주문 기능 없음</p></div>
      <button type="button" onClick={() => void load()} disabled={loading} aria-label="호가 새로고침" className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-accent disabled:opacity-50"><RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /></button>
    </header>
    <div className="grid grid-cols-2 gap-px bg-border text-xs sm:grid-cols-4">{[['공급자', data?.provider === 'kiwoom' ? '키움 ka10004' : '미연결'], ['스프레드', data?.spread == null ? '-' : priceText(data.spread, data.currency)], ['스프레드율', data?.spreadPercent == null ? '-' : `${data.spreadPercent.toFixed(3)}%`], ['잔량 균형', imbalance]].map(([label, value]) => <div key={label} className="bg-background px-3 py-2"><div className="text-[11px] text-muted-foreground">{label}</div><strong className="tabular-nums">{value}</strong></div>)}</div>
    <div className="border-b border-border px-4 py-2 text-[11px] text-muted-foreground">공급자 시각 {timeText(data?.updatedAt ?? null)} · 서버 수신 {timeText(data?.receivedAt || null)} · {data?.freshness === 'fresh' ? '최신' : data?.freshness === 'stale' ? '지연' : '최신성 확인 불가'}</div>
    {loading && !data ? <div aria-label="호가 로딩 중" className="space-y-2 p-4">{Array.from({ length: 6 }, (_, index) => <div key={index} className="h-9 animate-pulse rounded bg-muted" />)}</div> : null}
    {error && !hasLevels ? <div role="alert" className="m-4 flex gap-2 rounded-xl border border-destructive/40 p-3 text-xs"><AlertTriangle className="h-4 w-4 text-destructive" /><div><strong>호가 조회 실패</strong><p className="mt-1 text-muted-foreground">{reasonText(error)}</p></div></div> : null}
    {!loading && data && !data.available ? <div role="status" className="m-4 flex gap-2 rounded-xl border border-amber-500/40 p-3 text-xs"><AlertTriangle className="h-4 w-4 text-amber-600" /><p>{reasonText(data.reason)}</p></div> : null}
    {hasLevels && data ? <div className="max-h-[48dvh] overflow-y-auto"><div className="grid grid-cols-[40px_1fr_1fr] bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground"><span>단계</span><span className="text-right">가격</span><span className="text-right">잔량</span></div>{rows(data.asks.slice().reverse(), 'ask')}<div className="grid grid-cols-2 border-y border-border px-3 py-2 text-xs"><span>매도 {quantityText(data.displayedAskQuantity)}</span><span className="text-right">매수 {quantityText(data.displayedBidQuantity)}</span></div>{rows(data.bids, 'bid')}</div> : null}
    {data?.warnings.length ? <div className="border-t border-border px-4 py-3 text-[11px] text-muted-foreground">{data.warnings.map((warning) => <p key={warning}>· {warning}</p>)}</div> : null}
    <footer className="border-t border-border px-4 py-3 text-[11px] text-muted-foreground">호가 조회 전용이며 주문·취소·계좌 API를 호출하지 않습니다.</footer>
  </section>;
}
