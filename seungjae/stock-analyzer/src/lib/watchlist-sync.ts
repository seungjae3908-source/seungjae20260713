// Supabase 동기화 계층 (server를 경유: /api/watchlist*).
//
// localStorage가 즉각적인 로컬 캐시, Supabase(watchlist_items)가 원본 저장소.
// - 앱 시작 시: 서버 목록을 내려받아 로컬과 병합(서버의 targetPrice 우선).
// - 로컬 변경 시(WATCHLIST_CHANGE_EVENT): 디바운스 후 전체 목록을 서버에 반영.
// - 서버가 아직 설정 전(503 SUPABASE_NOT_CONFIGURED)이면 로컬 전용으로 동작하고
//   콘솔에 한 번만 알린다 — 몰래 실패하지 않는다.
import { authorizedFetch } from './auth-fetch';
import {
  readWatchlistItems,
  writeWatchlistItems,
  WATCHLIST_CHANGE_EVENT,
  type WatchlistItem,
} from './stock-display';

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api';
const OWNER_KEY = 'seungjae_watchlist_owner_v2';
// detail 페이지가 과거에 쓰던 별도 키 — 1회 병합 후 제거.
const LEGACY_DETAIL_KEY = 'watchlist:tickers';

interface ServerWatchlistItem {
  ticker: string;
  name: string;
  assetType: 'stockKR' | 'stockUS' | 'coinSpot' | 'coinFutures';
  market: string | null;
  currency: string | null;
  targetPrice: number | null;
}

let installed = false;
let serverDisabled = false;
let warnedOnce = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

function warn(message: string): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(`[watchlist-sync] ${message}`);
}

async function request<T>(path: string, init?: RequestInit): Promise<T | null> {
  if (serverDisabled) return null;
  try {
    const res = await authorizedFetch(`${BASE}${path}`, init);
    if (res.status === 503) {
      serverDisabled = true;
      warn('Supabase 서버 키가 아직 없어 로컬 전용으로 동작합니다.');
      return null;
    }
    if (!res.ok) {
      warn(`서버 동기화 실패 (HTTP ${res.status}) — 로컬 데이터는 유지됩니다.`);
      return null;
    }
    return (await res.json()) as T;
  } catch (error) {
    warn(`서버 동기화 실패 (${String(error)}) — 로컬 데이터는 유지됩니다.`);
    return null;
  }
}

function toServerItem(item: WatchlistItem) {
  return {
    ticker: item.ticker,
    name: item.name,
    assetType: item.assetType ?? 'stockKR',
    market: item.market ?? null,
    currency: item.currency ?? null,
    targetPrice: typeof item.targetPrice === 'number' ? item.targetPrice : null,
  };
}

function mergeServerIntoLocal(serverItems: ServerWatchlistItem[]): void {
  const map = new Map(
    readWatchlistItems().map((item) => [
      `${item.assetType ?? 'stockKR'}:${item.ticker.toUpperCase()}`,
      item,
    ]),
  );
  let changed = false;

  for (const server of serverItems) {
    const key = `${server.assetType}:${server.ticker.toUpperCase()}`;
    const local = map.get(key);
    if (!local) {
      map.set(key, {
        ticker: server.ticker.toUpperCase(),
        assetType: server.assetType,
        name: server.name || server.ticker.toUpperCase(),
        market: server.market ?? undefined,
        currency: server.currency ?? undefined,
        targetPrice: server.targetPrice,
      });
      changed = true;
    } else if ((local.targetPrice ?? null) !== (server.targetPrice ?? null)) {
      map.set(key, { ...local, targetPrice: server.targetPrice });
      changed = true;
    }
  }

  if (changed) writeWatchlistItems(Array.from(map.values()));
}

function adoptServerOwner(ownerId: string, serverItems: ServerWatchlistItem[]): boolean {
  const previousOwner = window.localStorage.getItem(OWNER_KEY);
  window.localStorage.setItem(OWNER_KEY, ownerId);
  if (!previousOwner || previousOwner === ownerId) return false;

  writeWatchlistItems(
    serverItems.map((item) => ({
      ticker: item.ticker.toUpperCase(),
      assetType: item.assetType,
      name: item.name || item.ticker.toUpperCase(),
      market: item.market ?? undefined,
      currency: item.currency ?? undefined,
      targetPrice: item.targetPrice,
    })),
  );
  return true;
}

function migrateLegacyDetailKey(): void {
  try {
    const raw = window.localStorage.getItem(LEGACY_DETAIL_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const map = new Map(
        readWatchlistItems().map((item) => [item.ticker.toUpperCase(), item]),
      );
      for (const value of parsed) {
        const ticker = String(value).toUpperCase();
        if (ticker && !map.has(ticker)) {
          map.set(ticker, { ticker, name: ticker });
        }
      }
      writeWatchlistItems(Array.from(map.values()));
    }
    window.localStorage.removeItem(LEGACY_DETAIL_KEY);
  } catch {
    // 손상된 레거시 데이터는 무시.
  }
}

function schedulePush(): void {
  if (serverDisabled) return;
  if (pushTimer !== null) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void request('/watchlist/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: readWatchlistItems().map(toServerItem),
      }),
    });
  }, 800);
}

/** 앱 시작 시 1회 호출: 서버 병합 + 변경 감지 푸시를 설치한다. */
export function ensureWatchlistSync(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  migrateLegacyDetailKey();
  window.addEventListener(WATCHLIST_CHANGE_EVENT, schedulePush);

  void (async () => {
    const res = await request<{
      items: ServerWatchlistItem[];
      ownerId: string;
    }>('/watchlist');
    if (!res) return;
    const ownerChanged = adoptServerOwner(res.ownerId, res.items ?? []);
    if (!ownerChanged) mergeServerIntoLocal(res.items ?? []);
    schedulePush();
  })();
}
