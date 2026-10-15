import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { authorizedFetch } from './auth-fetch';
import { livePricePollMs } from './signal-entry-guard';

export type LivePriceMarket = 'KR' | 'US' | 'UPBIT' | 'BITGET';

export type LivePrice = {
  price: number | null;
  /** Provider timestamp of the quote (ms). Falls back to the fetch time only if the provider has none. */
  quotedAtMs: number | null;
  error: string | null;
};

const BASE = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') || '/api';

function positive(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function getJson(path: string, signal?: AbortSignal): Promise<any> {
  const response = await authorizedFetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}_ts=${Date.now()}`,
    { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json();
}

/** One current public quote for the order window. Never throws; errors are returned. */
export async function fetchLivePrice(market: LivePriceMarket, symbol: string, signal?: AbortSignal): Promise<LivePrice> {
  const now = Date.now();
  try {
    if (market === 'UPBIT') {
      const coin = symbol.replace(/^KRW-/u, '');
      const body = await getJson(`/crypto/spot/tickers?markets=${encodeURIComponent(coin)}`, signal);
      const row = (body?.tickers ?? []).find((item: any) => String(item?.symbol).toUpperCase() === coin.toUpperCase());
      return { price: positive(row?.price), quotedAtMs: positive(row?.timestamp) ?? now, error: row ? null : 'QUOTE_NOT_FOUND' };
    }
    if (market === 'BITGET') {
      const body = await getJson(`/crypto/futures/tickers?symbol=${encodeURIComponent(symbol)}`, signal);
      const row = (body?.tickers ?? []).find((item: any) => String(item?.symbol).toUpperCase() === symbol.toUpperCase());
      return { price: positive(row?.price), quotedAtMs: positive(row?.timestamp) ?? now, error: row ? null : 'QUOTE_NOT_FOUND' };
    }
    const body = await api.quotes([symbol]);
    const row = (body?.quotes ?? []).find((item: any) => String(item?.ticker).toUpperCase() === symbol.toUpperCase());
    const updated = Date.parse(String((row as any)?.updatedAt ?? ''));
    return { price: positive(row?.price), quotedAtMs: Number.isFinite(updated) ? updated : now, error: row ? null : 'QUOTE_NOT_FOUND' };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return { price: null, quotedAtMs: null, error: error instanceof Error ? error.message : 'QUOTE_FAILED' };
  }
}

/**
 * Polls the live price (crypto 2s, stocks 5s) and ticks every second so the
 * caller can show "n초 전 갱신" and block on stale quotes.
 */
export function useLivePrice(market: LivePriceMarket | null, symbol: string | null) {
  const [quote, setQuote] = useState<LivePrice>({ price: null, quotedAtMs: null, error: null });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const inFlight = useRef(false);

  useEffect(() => {
    if (!market || !symbol) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    const poll = async () => {
      if (inFlight.current || cancelled) return;
      inFlight.current = true;
      try {
        const next = await fetchLivePrice(market, symbol, controller.signal);
        // Keep the last good price on a failed poll; its age keeps growing and the guard blocks when stale.
        if (!cancelled) setQuote((prev) => (next.price != null ? next : { ...prev, error: next.error }));
      } catch {
        // aborted
      } finally {
        inFlight.current = false;
      }
    };
    void poll();
    const pollTimer = window.setInterval(() => void poll(), livePricePollMs(market));
    const clock = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(pollTimer);
      window.clearInterval(clock);
    };
  }, [market, symbol]);

  const ageMs = quote.quotedAtMs == null ? null : Math.max(0, nowMs - quote.quotedAtMs);
  return { ...quote, ageMs };
}

/** Order-window market for a scanner card (stock KR/US, Upbit spot, Bitget futures). */
export function liveMarketForCard(card: { assetClass?: string | null; market?: string | null }): LivePriceMarket | null {
  const assetClass = String(card.assetClass ?? '').toLowerCase();
  const market = String(card.market ?? '').toUpperCase();
  if (assetClass === 'stock') return market === 'KR' ? 'KR' : market === 'US' ? 'US' : null;
  if (assetClass === 'coin_spot') return 'UPBIT';
  if (assetClass === 'coin_futures') return 'BITGET';
  return null;
}
