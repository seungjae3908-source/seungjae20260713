import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { AlertTriangle, BookOpen, RefreshCw, X } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { cn } from '@/lib/utils';

type Market = 'KR' | 'US';
type Status = 'ready' | 'partial' | 'unavailable' | 'invalid' | 'provider_error';
type Level = { rank: number; price: number; quantity: number; cumulativeQuantity: number };
type Payload = {
  ok: boolean; available: boolean; status: Status; market: Market; ticker: string;
  currency: 'KRW' | 'USD'; provider: 'kiwoom' | null; source: 'ka10004' | null;
  sourceTimestampRaw: string | null; updatedAt: string | null; receivedAt: string;
  freshness: 'fresh' | 'stale' | 'unknown'; asks: Level[]; bids: Level[];
  spread: number | null; spreadPercent: number | null; displayedAskQuantity: number;
  displayedBidQuantity: number; imbalance: number | null; warnings: string[]; reason: string | null;
};

const POLL_MS = 3_000;
const TIMEOUT_MS = 8_000;
const num = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : null;

function level(value: unknown): Level | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const rank = num(row.rank); const price = num(row.price); const quantity = num(row.quantity);
  const cumulativeQuantity = num(row.cumulativeQuantity);
  if (rank == null || price == null || quantity == null || cumulativeQuantity == null
    || rank < 1 || rank > 10 || price <= 0 || quantity < 0 || cumulativeQuantity < quantity) return null;
  return { rank: Math.trunc(rank), price, quantity, cumulativeQuantity };
}

function payload(value: unknown): Payload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ORDERBOOK_RESPONSE_INVALID');
  const row = value as Record<string, unknown>;
  const market = row.market === 'KR' || row.market === 'US' ? row.market : null;
  const validStatuses: Status[] = ['ready', 'partial', 'unavailable', 'invalid', 'provider_error'];
  const status = validStatuses.includes(row.status as Status) ? row.status as Status : null;
  const ticker = typeof row.ticker === 'string' ? row.ticker.trim().toUpperCase() : '';
  if (!market || !status || !ticker) throw new Error('ORDERBOOK_RESPONSE_INVALID');
  const levels = (input: unknown) => Array.isArray(input)
    ? input.map(level).filter((item): item is Level => item != null)
    : [];
  const text = (input: unknown) => typeof input === 'string' && input.trim() ? input.trim() : null;
  return {
    ok: row.ok === true, available: row.available === true, status, market, ticker,
    currency: market === 'KR' ? 'KRW' : 'USD', provider: row.provider === 'kiwoom' ? 'kiwoom' : null,
    source: row.source === 'ka10004' ? 'ka10004' : null, sourceTimestampRaw: text(row.sourceTimestampRaw),
    updatedAt: typeof row.updatedAt === 'string' && Number.isFinite(Date.parse(row.updatedAt)) ? row.updatedAt : null,
    receivedAt: typeof row.receivedAt === 'string' && Number.isFinite(Date.parse(row.receivedAt)) ? row.receivedAt : '',
    freshness: row.freshness === 'fresh' || row.freshness === 'stale' ? row.freshness : 'unknown',
    asks: levels(row.asks), bids: levels(row.bids), spread: num(row.spread), spreadPercent: num(row.spreadPercent),
    displayedAskQuantity: num(row.displayedAskQuantity) ?? 0, displayedBidQuantity: num(row.displayedBidQuantity) ?? 0,
    imbalance: num(row.imbalance),
    warnings: Array.isArray(row.warnings) ? row.warnings.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 20) : [],
    reason: text(row.reason),
  };
}

const priceText = (value: number, currency: 'KRW' | 'USD') => new Intl.NumberFormat(
  currency === 'KRW' ? 'ko-KR' : 'en-US',
  currency === 'KRW' ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 4 },
).format(value);
const quantityText = (value: number | null) => value == null ? '-' : new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 4 }).format(value);
const timeText = (value: string | null) => {
  if (!value || !Number.isFinite(Date.parse(value))) return '-';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
};
const reasonText = (reason: string | null) => ({
  US_ORDERBOOK_PROVIDER_NOT_CONNECTED: '미국 주식 호가 공급자는 아직 연결되지 않았습니다.',
  ORDERBOOK_CROSSED: '교차 호가가 감지되어 안전을 위해 표시를 차단했습니다.',
  ORDERBOOK_LEVELS_EMPTY: '공급자가 유효한 호가 잔량을 반환하지 않았습니다.',
  ORDERBOOK_PROVIDER_NOT_CONFIGURED: '키움 호가 공급자 설정을 확인할 수 없습니다.',
  ORDERBOOK_PROVIDER_TIMEOUT: '키움 호가 공급자 응답 시간이 초과되었습니다.',
  INVALID_KR_TICKER: '국내 종목 코드 형식이 올바르지 않습니다.',
}[reason ?? ''] ?? '호가 데이터를 불러올 수 없습니다.');

function LevelRow({ item, side, currency, max }: { item: Level; side: 'ask' | 'bid'; currency: 'KRW' | 'USD'; max: number }) {
  const width = max > 0 ? Math.max(4, Math.min(100, item.cumulativeQuantity / max * 100)) : 0;
  return <div data-testid={`${side}-level-${item.rank}`} className="relative grid min-h-10 grid-cols-[44px_1fr_1fr] items-center overflow-hidden border-b border-border/50 px-3 text-xs last:border-b-0">
    <div aria-hidden className={cn('pointer-events-none absolute inset-y-1 right-0 rounded-l opacity-15', side === 'ask' ? 'bg-rose-500' : 'bg-sky-500')} style={{ width: `${width}%` }} />
    <span className="relative text-muted-foreground">{item.rank}호</span>
    <span className={cn('relative text-right font-semibold tabular-nums', side === 'ask' ? 'text-rose-500' : 'text-sky-500')}>{priceText(item.price, currency)}</span>
    <span className="relative text-right tabular-nums">{quantityText(item.quantity)}</span>
  </div>;
}

export function InstrumentOrderbookDock({ ticker, market, defaultOpen = false }: { ticker: string; market: Market; defaultOpen?: boolean }) {
  const symbol = ticker.trim().toUpperCase();
  const titleId = useId(); const descriptionId = useId();
  const opener = useRef<HTMLButtonElement>(null); const dialog = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null); const sequence = useRef(0); const timer = useRef<number | null>(null);
  const [open, setOpen] = useState(defaultOpen); const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    sequence.current += 1; controller.current?.abort(); controller.current = null;
    if (timer.current != null) window.clearTimeout(timer.current); timer.current = null;
  }, []);

  const load = useCallback(async () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    controller.current?.abort(); const request = new AbortController(); controller.current = request;
    const current = ++sequence.current; setLoading(true); setError(null);
    const timeout = window.setTimeout(() => request.abort(), TIMEOUT_MS);
    try {
      const response = await authorizedFetch(`/api/stocks/${encodeURIComponent(symbol)}/orderbook?market=${market}`, { cache: 'no-store', signal: request.signal });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body && typeof body === 'object' ? String((body as Record<string, unknown>).reason ?? '') : `ORDERBOOK_HTTP_${response.status}`);
      const next = payload(body);
      if (request.signal.aborted || current !== sequence.current) return;
      setData(next);
      if (next.available && (next.status === 'ready' || next.status === 'partial') && document.visibilityState === 'visible') {
        timer.current = window.setTimeout(() => void load(), POLL_MS);
      }
    } catch (caught) {
      if (!request.signal.aborted && current === sequence.current) setError(caught instanceof Error ? caught.message : 'ORDERBOOK_REQUEST_FAILED');
    } finally {
      window.clearTimeout(timeout);
      if (current === sequence.current) { setLoading(false); controller.current = null; }
    }
  }, [market, symbol]);

  useEffect(() => {
    if (!open) { stop(); return; }
    void load();
    const visibility = () => document.visibilityState === 'hidden' ? stop() : void load();
    document.addEventListener('visibilitychange', visibility);
    return () => { document.removeEventListener('visibilitychange', visibility); stop(); };
  }, [load, open, stop]);

  useEffect(() => {
    if (!open) { opener.current?.focus(); return; }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return; }
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]),[href],[tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) { event.preventDefault(); dialog.current.focus(); return; }
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', keydown); window.requestAnimationFrame(() => dialog.current?.focus());
    return () => window.removeEventListener('keydown', keydown);
  }, [open]);

  const max = useMemo(() => Math.max(0, ...(data?.asks ?? []).map((item) => item.cumulativeQuantity), ...(data?.bids ?? []).map((item) => item.cumulativeQuantity)), [data]);
  const hasLevels = Boolean(data?.available && (data.asks.length || data.bids.length));
  const imbalance = data?.imbalance == null ? '-' : data.imbalance > .1 ? `매수 우위 ${(data.imbalance * 100).toFixed(1)}%` : data.imbalance < -.1 ? `매도 우위 ${(Math.abs(data.imbalance) * 100).toFixed(1)}%` : `균형 ${(data.imbalance * 100).toFixed(1)}%`;
  const freshness = !data ? '확인 전' : data.freshness === 'fresh' ? '공급자 시각 기준 최신' : data.freshness === 'stale' ? '공급자 시각 기준 지연' : '공급자 최신성 확인 불가';
  const backdrop = (event: MouseEvent<HTMLDivElement>) => { if (event.target === event.currentTarget) setOpen(false); };

  return <>
    <button ref={opener} type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} className="fixed bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] right-4 z-40 inline-flex min-h-11 items-center gap-2 rounded-full border border-border bg-background/95 px-4 py-2 text-sm font-semibold shadow-lg backdrop-blur hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><BookOpen className="h-4 w-4" aria-hidden />호가창</button>
    {open ? <div onMouseDown={backdrop} className="fixed inset-0 z-[80] flex items-end justify-center bg-black/50 sm:items-center sm:p-4" data-testid="orderbook-backdrop">
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1} className="flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl border border-border bg-background shadow-2xl outline-none sm:rounded-2xl" data-testid="instrument-orderbook-dialog">
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 id={titleId} className="text-base font-bold">{symbol} 호가창</h2><span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium">읽기 전용</span></div><p id={descriptionId} className="mt-1 text-xs text-muted-foreground">{market === 'KR' ? 'KRX · KRW' : '미국 주식 · USD'} · 주문 기능 없음</p></div><div className="flex shrink-0 items-center gap-1"><button type="button" onClick={() => void load()} disabled={loading} aria-label="호가 새로고침" className="inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-accent disabled:opacity-50"><RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden /></button><button type="button" onClick={() => setOpen(false)} aria-label="호가창 닫기" className="inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-accent"><X className="h-5 w-5" aria-hidden /></button></div></header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <section className="grid grid-cols-2 gap-px bg-border text-xs sm:grid-cols-4">{[['공급자', data?.provider === 'kiwoom' ? '키움 ka10004' : '미연결'], ['스프레드', data?.spread == null ? '-' : priceText(data.spread, data.currency)], ['스프레드율', data?.spreadPercent == null ? '-' : `${data.spreadPercent.toFixed(3)}%`], ['잔량 균형', imbalance]].map(([label, value]) => <div key={label} className="bg-background px-3 py-2"><div className="text-[11px] text-muted-foreground">{label}</div><div className="mt-0.5 truncate font-semibold tabular-nums">{value}</div></div>)}</section>
          <section className="border-b border-border px-4 py-2 text-xs"><div className="flex flex-wrap items-center justify-between gap-2"><span className={cn('font-medium', data?.freshness === 'fresh' && !error ? 'text-emerald-600' : 'text-amber-600')}>{error && hasLevels ? '갱신 실패 · 마지막 확인 데이터' : freshness}</span><span className="text-muted-foreground">공급자 시각 {timeText(data?.updatedAt ?? null)}</span></div><div className="mt-1 text-[11px] text-muted-foreground">서버 수신 {timeText(data?.receivedAt || null)}{data?.sourceTimestampRaw ? ` · 원문 시각 ${data.sourceTimestampRaw}` : ''}</div></section>
          {error && !hasLevels ? <section role="alert" className="m-4 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm"><div className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden /><div><div className="font-semibold">호가 조회 실패</div><p className="mt-1 text-muted-foreground">{reasonText(error)}</p><button type="button" onClick={() => void load()} className="mt-3 min-h-10 rounded-lg border border-border px-3 font-medium hover:bg-accent">다시 시도</button></div></div></section> : null}
          {!loading && data && !data.available ? <section role="status" className="m-4 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm"><div className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden /><div><div className="font-semibold">호가 제공 불가</div><p className="mt-1 text-muted-foreground">{reasonText(data.reason)}</p></div></div></section> : null}
          {loading && !data ? <section aria-label="호가 로딩 중" className="space-y-2 p-4">{Array.from({ length: 8 }, (_, index) => <div key={index} className="h-10 animate-pulse rounded-lg bg-muted" />)}</section> : null}
          {hasLevels && data ? <section aria-label="호가 잔량"><div className="grid grid-cols-[44px_1fr_1fr] border-b border-border bg-muted/50 px-3 py-2 text-[11px] font-medium text-muted-foreground"><span>단계</span><span className="text-right">가격</span><span className="text-right">잔량</span></div><div aria-label="매도 호가">{data.asks.slice().reverse().map((item) => <LevelRow key={`a-${item.rank}-${item.price}`} item={item} side="ask" currency={data.currency} max={max} />)}</div><div className="grid grid-cols-2 gap-px border-y border-border bg-border text-xs"><div className="bg-background px-3 py-2"><div className="text-[11px] text-muted-foreground">표시 매도잔량</div><div className="font-semibold tabular-nums">{quantityText(data.displayedAskQuantity)}</div></div><div className="bg-background px-3 py-2 text-right"><div className="text-[11px] text-muted-foreground">표시 매수잔량</div><div className="font-semibold tabular-nums">{quantityText(data.displayedBidQuantity)}</div></div></div><div aria-label="매수 호가">{data.bids.map((item) => <LevelRow key={`b-${item.rank}-${item.price}`} item={item} side="bid" currency={data.currency} max={max} />)}</div></section> : null}
          {data?.warnings.length ? <section className="border-t border-border px-4 py-3 text-xs text-muted-foreground"><div className="font-medium text-foreground">데이터 주의사항</div><ul className="mt-1 space-y-1">{data.warnings.map((warning) => <li key={warning}>· {warning}</li>)}</ul></section> : null}
        </div>
        <footer className="border-t border-border px-4 py-3 text-[11px] text-muted-foreground">이 화면은 호가 조회 전용이며 주문·취소·계좌 API를 호출하지 않습니다.</footer>
      </div>
    </div> : null}
  </>;
}
