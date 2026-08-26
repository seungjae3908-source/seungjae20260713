// Authenticated member Watchlist sync layer (server: /api/member-watchlist*).
//
// localStorage remains the immediate/offline cache. Supabase member_watchlist_items
// is the cross-device canonical store for authenticated members.
// - server identity is derived from the bearer-authenticated member only.
// - client userId/deviceId is never sent as an ownership credential.
// - server unavailable states keep local data intact and fail closed for Telegram.
import { authorizedFetch } from './auth-fetch';
import {
  readWatchlistItems,
  writeWatchlistItems,
  WATCHLIST_CHANGE_EVENT,
  type WatchlistItem,
} from './stock-display';

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api';
// detail 페이지가 과거에 쓰던 별도 키 — 1회 병합 후 제거.
const LEGACY_DETAIL_KEY = 'watchlist:tickers';

interface ServerWatchlistItem {
  ticker: string;
  name: string;
  market: string | null;
  currency: string | null;
  targetPrice: number | null;
}

let installed = false;
let serverDisabled = false;
let warnedOnce = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pushInFlight = false;
let pushPending = false;
let applyingServerState = false;

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
      warn('회원 관심종목 저장소를 사용할 수 없어 로컬 전용으로 동작합니다.');
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

function canonicalServerItems(
  items: ReadonlyArray<WatchlistItem | ServerWatchlistItem>,
): ServerWatchlistItem[] {
  const unique = new Map<string, ServerWatchlistItem>();
  for (const item of items) {
    const ticker = String(item.ticker ?? '').trim().toUpperCase();
    if (!ticker) continue;
    const name = String(item.name ?? '').trim() || ticker;
    const market = String(item.market ?? '').trim() || null;
    const currency = String(item.currency ?? '').trim() || null;
    const targetPrice =
      typeof item.targetPrice === 'number' && Number.isFinite(item.targetPrice)
        ? item.targetPrice
        : null;
    unique.set(ticker, { ticker, name, market, currency, targetPrice });
  }
  return Array.from(unique.values()).sort((left, right) =>
    left.ticker.localeCompare(right.ticker),
  );
}

function sameServerState(
  left: ReadonlyArray<WatchlistItem | ServerWatchlistItem>,
  right: ReadonlyArray<WatchlistItem | ServerWatchlistItem>,
): boolean {
  return JSON.stringify(canonicalServerItems(left)) === JSON.stringify(canonicalServerItems(right));
}

function mergeServerIntoLocal(serverItems: ServerWatchlistItem[]): void {
  const map = new Map(
    readWatchlistItems().map((item) => [item.ticker.toUpperCase(), item]),
  );
  let changed = false;

  for (const server of serverItems) {
    const key = server.ticker.toUpperCase();
    const local = map.get(key);
    if (!local) {
      map.set(key, {
        ticker: key,
        name: server.name || key,
        market: server.market ?? undefined,
        currency: server.currency ?? undefined,
        targetPrice: server.targetPrice,
      });
      changed = true;
      continue;
    }

    const merged: WatchlistItem = {
      ...local,
      name: server.name || local.name || key,
      market: server.market ?? local.market,
      currency: server.currency ?? local.currency,
      targetPrice: server.targetPrice,
    };
    if (JSON.stringify(canonicalServerItems([local])) !== JSON.stringify(canonicalServerItems([merged]))) {
      map.set(key, merged);
      changed = true;
    }
  }

  if (!changed) return;
  applyingServerState = true;
  try {
    writeWatchlistItems(Array.from(map.values()));
  } finally {
    applyingServerState = false;
  }
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

async function flushPush(): Promise<void> {
  if (serverDisabled) return;
  if (pushInFlight) {
    pushPending = true;
    return;
  }

  pushInFlight = true;
  try {
    do {
      pushPending = false;
      const controller = new AbortController();
      await request('/member-watchlist/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: canonicalServerItems(readWatchlistItems()),
        }),
        keepalive: true,
        // 저장 요청은 화면 조회용 AbortSignal을 상속하지 않는다.
        signal: controller.signal,
      });
    } while (pushPending && !serverDisabled);
  } finally {
    pushInFlight = false;
  }
}

function schedulePush(): void {
  if (serverDisabled || applyingServerState) return;
  if (pushTimer !== null) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void flushPush();
  }, 800);
}

/** 앱 시작 시 1회 호출: 회원 서버 병합 + 변경 감지 푸시를 설치한다. */
export function ensureWatchlistSync(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  migrateLegacyDetailKey();
  window.addEventListener(WATCHLIST_CHANGE_EVENT, schedulePush);

  void (async () => {
    const res = await request<{ items: ServerWatchlistItem[] }>('/member-watchlist');
    if (!res) return;
    const serverItems = canonicalServerItems(res.items ?? []);
    mergeServerIntoLocal(serverItems);
    if (!sameServerState(readWatchlistItems(), serverItems)) schedulePush();
  })();
}
