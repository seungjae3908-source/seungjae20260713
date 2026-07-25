import { authorizedFetch } from './auth-fetch';
import {
  readWatchlistItems,
  setWatchlistAccount,
  writeWatchlistItems,
  WATCHLIST_CHANGE_EVENT,
  type WatchlistItem,
} from './stock-display';

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api';

interface ServerWatchlistItem {
  ticker: string;
  name: string;
  market: string | null;
  currency: string | null;
  targetPrice: number | null;
}

let activeMemberId: string | null = null;
let installed = false;
let syncing = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let canonicalItems: WatchlistItem[] = [];

function toLocalItem(item: ServerWatchlistItem): WatchlistItem {
  return {
    ticker: item.ticker.toUpperCase(),
    name: item.name || item.ticker,
    market: item.market ?? undefined,
    currency: item.currency ?? undefined,
    targetPrice: item.targetPrice,
  };
}

function toServerItem(item: WatchlistItem) {
  return {
    ticker: item.ticker,
    name: item.name,
    market: item.market ?? null,
    currency: item.currency ?? null,
    targetPrice: typeof item.targetPrice === 'number' ? item.targetPrice : null,
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authorizedFetch(`${BASE}${path}`, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = String(payload?.message ?? payload?.error ?? `HTTP_${response.status}`);
    throw new Error(`관심종목을 계정에 저장하지 못했습니다. (${reason})`);
  }
  return payload as T;
}

export async function persistWatchlist(items = readWatchlistItems()): Promise<WatchlistItem[]> {
  if (!activeMemberId) throw new Error('로그인 계정을 확인할 수 없습니다.');
  if (pushTimer !== null) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  const response = await request<{ items: ServerWatchlistItem[] }>('/watchlist/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: items.map(toServerItem) }),
  });
  canonicalItems = (response.items ?? []).map(toLocalItem);
  return canonicalItems;
}

async function pushCurrentWithRollback(): Promise<void> {
  if (syncing || !activeMemberId) return;
  syncing = true;
  const before = canonicalItems;
  try {
    const saved = await persistWatchlist();
    writeWatchlistItems(saved);
  } catch (error) {
    writeWatchlistItems(before);
    console.error('[watchlist-sync]', error);
  } finally {
    syncing = false;
  }
}

function schedulePush(): void {
  if (syncing || !activeMemberId) return;
  if (pushTimer !== null) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushCurrentWithRollback();
  }, 500);
}

export async function ensureWatchlistSync(memberId: string): Promise<void> {
  if (!memberId) return;
  if (activeMemberId !== memberId) {
    activeMemberId = memberId;
    setWatchlistAccount(memberId);
    canonicalItems = [];
  }
  if (!installed && typeof window !== 'undefined') {
    installed = true;
    window.addEventListener(WATCHLIST_CHANGE_EVENT, schedulePush);
  }

  const response = await request<{ items: ServerWatchlistItem[] }>('/watchlist');
  canonicalItems = (response.items ?? []).map(toLocalItem);
  syncing = true;
  try {
    writeWatchlistItems(canonicalItems);
  } finally {
    syncing = false;
  }
}

export function resetWatchlistSync(): void {
  activeMemberId = null;
  canonicalItems = [];
  setWatchlistAccount(null);
  if (pushTimer !== null) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
}
