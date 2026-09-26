// Authenticated member Watchlist sync layer (server: /api/member-watchlist*).
//
// The legacy stock-display localStorage key remains the current-screen working
// cache for compatibility, but ownership is bound here to the authenticated
// member. Every member gets an isolated cache envelope and identity generation.
// Unowned legacy rows are quarantined, never auto-imported into a member.
import { authorizedFetch } from './auth-fetch';
import { getSupabase, isSupabaseConfigured } from './supabase';
import {
  readWatchlistItems,
  writeWatchlistItems,
  WATCHLIST_CHANGE_EVENT,
  type WatchlistItem,
} from './stock-display';

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api';
const MEMBER_CACHE_PREFIX = 'seungjae_member_watchlist_v1:';
const LEGACY_DETAIL_KEY = 'watchlist:tickers';
const LEGACY_QUARANTINE_KEY = 'seungjae_watchlist_legacy_quarantine_v1';
const MAX_ITEMS = 200;

type CanonicalMarket =
  | 'KR_STOCK'
  | 'US_STOCK'
  | 'CRYPTO_SPOT'
  | 'CRYPTO_FUTURES'
  | 'UNRESOLVED';

interface ServerWatchlistItem {
  ticker: string;
  name: string;
  market: CanonicalMarket;
  currency: string | null;
  targetPrice: number | null;
}

type MemberEnvelope = {
  ok: true;
  items: ServerWatchlistItem[];
  identitySource: 'AUTHENTICATED_MEMBER';
};

type AuthSubscription = { unsubscribe(): void };

let installed = false;
let authSubscription: AuthSubscription | null = null;
let activeMemberId: string | null = null;
let identityGeneration = 0;
let requestedIdentityVersion = 0;
let identityAbort: AbortController | null = null;
let identityHydrated = false;
let transitionChain: Promise<void> = Promise.resolve();
let explicitIdentityOverrideActive = false;
let serverDisabled = false;
let warnedOnce = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pushInFlight = false;
let pushPending = false;
let applyingServerState = false;

function cleanMemberId(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && id.length <= 128 ? id : null;
}

function memberCacheKey(memberId: string): string {
  return `${MEMBER_CACHE_PREFIX}${encodeURIComponent(memberId)}`;
}

function warn(message: string): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(`[watchlist-sync] ${message}`);
}

function canonicalMarketForLocal(value: unknown): CanonicalMarket {
  const market = String(value ?? '').trim().toUpperCase().replace(/[-\s]/gu, '_');
  if (['KR', 'KOSPI', 'KOSDAQ', 'KR_STOCK'].includes(market)) return 'KR_STOCK';
  if (['US', 'NASDAQ', 'NYSE', 'AMEX', 'US_STOCK'].includes(market)) return 'US_STOCK';
  if (['CRYPTO_SPOT', 'COIN_SPOT', 'SPOT', 'UPBIT'].includes(market)) return 'CRYPTO_SPOT';
  if (['CRYPTO_FUTURES', 'COIN_FUTURES', 'FUTURES', 'BITGET'].includes(market)) return 'CRYPTO_FUTURES';
  return 'UNRESOLVED';
}

function strictServerMarket(value: unknown): CanonicalMarket | null {
  return value === 'KR_STOCK'
    || value === 'US_STOCK'
    || value === 'CRYPTO_SPOT'
    || value === 'CRYPTO_FUTURES'
    || value === 'UNRESOLVED'
    ? value
    : null;
}

function localMarketFromServer(value: CanonicalMarket): string | undefined {
  if (value === 'KR_STOCK') return 'KR';
  if (value === 'US_STOCK') return 'US';
  if (value === 'UNRESOLVED') return undefined;
  return value;
}

function parseServerItem(value: unknown): ServerWatchlistItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const ticker = typeof row.ticker === 'string' ? row.ticker.trim().toUpperCase() : '';
  const market = strictServerMarket(row.market);
  if (!ticker || ticker.length > 64 || !market) return null;
  if (typeof row.name !== 'string') return null;
  const name = row.name.trim() || ticker;
  if (name.length > 120) return null;
  const currency = row.currency == null
    ? null
    : typeof row.currency === 'string' && row.currency.trim().length <= 16
      ? row.currency.trim().toUpperCase() || null
      : undefined;
  if (currency === undefined) return null;
  const targetPrice = row.targetPrice;
  if (targetPrice !== null && (typeof targetPrice !== 'number' || !Number.isFinite(targetPrice) || targetPrice <= 0)) {
    return null;
  }
  return { ticker, name, market, currency, targetPrice };
}

function validateServerItems(value: unknown): ServerWatchlistItem[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null;
  const unique = new Map<string, ServerWatchlistItem>();
  const tickerMarkets = new Map<string, CanonicalMarket>();
  for (const raw of value) {
    const item = parseServerItem(raw);
    if (!item) return null;
    const identity = `${item.market}:${item.ticker}`;
    if (unique.has(identity)) return null;
    const seenMarket = tickerMarkets.get(item.ticker);
    // The current local UI cache cannot represent the same ticker in two
    // different markets. Refuse to collapse those identities silently.
    if (seenMarket && seenMarket !== item.market) return null;
    tickerMarkets.set(item.ticker, item.market);
    unique.set(identity, item);
  }
  return Array.from(unique.values()).sort((left, right) =>
    `${left.market}:${left.ticker}`.localeCompare(`${right.market}:${right.ticker}`),
  );
}

function validateEnvelope(value: unknown): MemberEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.ok !== true || row.identitySource !== 'AUTHENTICATED_MEMBER') return null;
  const items = validateServerItems(row.items);
  return items ? { ok: true, items, identitySource: 'AUTHENTICATED_MEMBER' } : null;
}

function canonicalServerItems(
  items: ReadonlyArray<WatchlistItem | ServerWatchlistItem>,
): ServerWatchlistItem[] {
  const unique = new Map<string, ServerWatchlistItem>();
  for (const item of items) {
    const ticker = String(item.ticker ?? '').trim().toUpperCase();
    if (!ticker || ticker.length > 64) continue;
    const name = String(item.name ?? '').trim().slice(0, 120) || ticker;
    const market = canonicalMarketForLocal(item.market);
    const currencyText = String(item.currency ?? '').trim().toUpperCase();
    const currency = currencyText ? currencyText.slice(0, 16) : null;
    const targetPrice = typeof item.targetPrice === 'number' && Number.isFinite(item.targetPrice) && item.targetPrice > 0
      ? item.targetPrice
      : null;
    unique.set(`${market}:${ticker}`, { ticker, name, market, currency, targetPrice });
  }
  return Array.from(unique.values()).sort((left, right) =>
    `${left.market}:${left.ticker}`.localeCompare(`${right.market}:${right.ticker}`),
  );
}

function sameServerState(
  left: ReadonlyArray<WatchlistItem | ServerWatchlistItem>,
  right: ReadonlyArray<WatchlistItem | ServerWatchlistItem>,
): boolean {
  return JSON.stringify(canonicalServerItems(left)) === JSON.stringify(canonicalServerItems(right));
}

function toLocalItem(item: ServerWatchlistItem): WatchlistItem {
  return {
    ticker: item.ticker,
    name: item.name,
    market: localMarketFromServer(item.market),
    currency: item.currency ?? undefined,
    targetPrice: item.targetPrice,
  };
}

function replaceWorkingItems(items: WatchlistItem[]): void {
  applyingServerState = true;
  try {
    writeWatchlistItems(items);
  } finally {
    applyingServerState = false;
  }
}

function persistMemberCache(memberId: string): void {
  try {
    window.localStorage.setItem(memberCacheKey(memberId), JSON.stringify(canonicalServerItems(readWatchlistItems())));
  } catch {
    // Local cache is best-effort only. Server ownership remains authoritative.
  }
}

function restoreMemberCache(memberId: string): WatchlistItem[] {
  try {
    const raw = window.localStorage.getItem(memberCacheKey(memberId));
    if (!raw) return [];
    const items = validateServerItems(JSON.parse(raw));
    if (!items) {
      window.localStorage.removeItem(memberCacheKey(memberId));
      return [];
    }
    return items.map(toLocalItem);
  } catch {
    return [];
  }
}

function quarantineUnownedLegacyState(): void {
  try {
    const working = readWatchlistItems();
    const detailRaw = window.localStorage.getItem(LEGACY_DETAIL_KEY);
    if ((working.length > 0 || detailRaw) && !window.localStorage.getItem(LEGACY_QUARANTINE_KEY)) {
      window.localStorage.setItem(LEGACY_QUARANTINE_KEY, JSON.stringify({
        quarantinedAt: new Date().toISOString(),
        watchlist: canonicalServerItems(working),
        legacyDetailRaw: detailRaw,
        importedIntoMember: false,
      }));
    }
    window.localStorage.removeItem(LEGACY_DETAIL_KEY);
  } catch {
    // Never assign uncertain legacy ownership to the current member.
  }
}

function mergeServerIntoMemberCache(serverItems: ServerWatchlistItem[]): WatchlistItem[] | null {
  const localRows = readWatchlistItems();
  const byTicker = new Map(localRows.map((item) => [String(item.ticker).toUpperCase(), item]));

  for (const server of serverItems) {
    const local = byTicker.get(server.ticker);
    if (!local) {
      byTicker.set(server.ticker, toLocalItem(server));
      continue;
    }
    const localMarket = canonicalMarketForLocal(local.market);
    if (localMarket !== 'UNRESOLVED' && server.market !== 'UNRESOLVED' && localMarket !== server.market) {
      return null;
    }
    byTicker.set(server.ticker, {
      ...local,
      name: server.name || local.name || server.ticker,
      market: localMarketFromServer(server.market) ?? local.market,
      currency: server.currency ?? local.currency,
      targetPrice: server.targetPrice,
    });
  }
  return Array.from(byTicker.values());
}

async function request(
  path: string,
  init: RequestInit,
  memberId: string,
  generation: number,
): Promise<unknown | null> {
  if (serverDisabled || activeMemberId !== memberId || generation !== identityGeneration) return null;
  const signal = identityAbort?.signal;
  if (!signal || signal.aborted) return null;
  try {
    const response = await authorizedFetch(`${BASE}${path}`, { ...init, signal });
    if (activeMemberId !== memberId || generation !== identityGeneration || signal.aborted) return null;
    if (response.status === 503) {
      serverDisabled = true;
      warn('회원 관심종목 저장소를 사용할 수 없어 이 세션에서는 로컬 캐시만 사용합니다.');
      return null;
    }
    if (!response.ok) {
      warn(`회원 관심종목 동기화 실패 (HTTP ${response.status}). 기존 회원 캐시는 유지됩니다.`);
      return null;
    }
    return await response.json() as unknown;
  } catch (error) {
    if (signal.aborted || activeMemberId !== memberId || generation !== identityGeneration) return null;
    warn(`회원 관심종목 동기화 실패 (${String(error)}). 기존 회원 캐시는 유지됩니다.`);
    return null;
  }
}

async function pullMemberState(memberId: string, generation: number): Promise<void> {
  const raw = await request('/member-watchlist', { method: 'GET' }, memberId, generation);
  if (raw == null || activeMemberId !== memberId || generation !== identityGeneration) return;
  const envelope = validateEnvelope(raw);
  if (!envelope) {
    warn('회원 관심종목 응답이 잘못되어 적용하지 않았습니다.');
    return;
  }
  const merged = mergeServerIntoMemberCache(envelope.items);
  if (!merged) {
    warn('같은 ticker의 market identity가 충돌하여 회원 관심종목을 적용하지 않았습니다.');
    return;
  }
  replaceWorkingItems(merged);
  persistMemberCache(memberId);
  if (!sameServerState(merged, envelope.items)) schedulePush();
}

async function flushPush(memberId = activeMemberId, generation = identityGeneration): Promise<void> {
  if (!memberId || serverDisabled || activeMemberId !== memberId || generation !== identityGeneration) return;
  if (pushInFlight) {
    pushPending = true;
    return;
  }

  pushInFlight = true;
  try {
    do {
      pushPending = false;
      if (activeMemberId !== memberId || generation !== identityGeneration || identityAbort?.signal.aborted) break;
      persistMemberCache(memberId);
      const payload = { items: canonicalServerItems(readWatchlistItems()) };
      const raw = await request('/member-watchlist/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, memberId, generation);
      if (raw != null && !validateEnvelope(raw)) {
        warn('회원 관심종목 저장 확인 응답이 잘못되어 성공으로 처리하지 않았습니다.');
        break;
      }
    } while (pushPending && !serverDisabled && activeMemberId === memberId && generation === identityGeneration);
  } finally {
    if (generation === identityGeneration) pushInFlight = false;
  }
}

function schedulePush(): void {
  if (serverDisabled || applyingServerState || !activeMemberId) return;
  persistMemberCache(activeMemberId);
  if (pushTimer !== null) clearTimeout(pushTimer);
  const memberId = activeMemberId;
  const generation = identityGeneration;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void flushPush(memberId, generation);
  }, 800);
}

async function transitionIdentity(nextValue: string | null): Promise<void> {
  const nextMemberId = cleanMemberId(nextValue);
  if (nextMemberId === activeMemberId && identityHydrated) return;

  const previousMemberId = activeMemberId;
  if (previousMemberId) persistMemberCache(previousMemberId);
  else if (nextMemberId) quarantineUnownedLegacyState();

  identityGeneration += 1;
  identityAbort?.abort(new DOMException('Watchlist member identity changed.', 'AbortError'));
  identityAbort = null;
  if (pushTimer !== null) clearTimeout(pushTimer);
  pushTimer = null;
  pushInFlight = false;
  pushPending = false;
  serverDisabled = false;
  warnedOnce = false;
  identityHydrated = false;
  activeMemberId = nextMemberId;

  replaceWorkingItems([]);
  if (!nextMemberId) return;

  replaceWorkingItems(restoreMemberCache(nextMemberId));
  const generation = identityGeneration;
  identityAbort = new AbortController();
  await pullMemberState(nextMemberId, generation);
  if (activeMemberId === nextMemberId && generation === identityGeneration) identityHydrated = true;
}

function queueIdentity(nextValue: string | null): void {
  const nextMemberId = cleanMemberId(nextValue);
  const requestVersion = ++requestedIdentityVersion;

  // Do not wait for a slow previous transition to complete before invalidating
  // its transport. A logout/member switch makes every prior GET/POST obsolete
  // at the moment the new identity event is observed.
  if (nextMemberId !== activeMemberId) {
    identityGeneration += 1;
    identityAbort?.abort(new DOMException('Watchlist member identity superseded.', 'AbortError'));
    identityAbort = null;
    if (pushTimer !== null) clearTimeout(pushTimer);
    pushTimer = null;
    pushInFlight = false;
    pushPending = false;
    identityHydrated = false;
  }

  transitionChain = transitionChain
    .catch(() => undefined)
    .then(async () => {
      if (requestVersion !== requestedIdentityVersion) return;
      await transitionIdentity(nextMemberId);
    });
}

function installOnce(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener(WATCHLIST_CHANGE_EVENT, schedulePush);

  if (!isSupabaseConfigured) return;
  try {
    const { data } = getSupabase().auth.onAuthStateChange((_event, session) => {
      if (explicitIdentityOverrideActive) return;
      queueIdentity(session?.user.id ?? null);
    });
    authSubscription = data.subscription as AuthSubscription;
  } catch {
    authSubscription = null;
  }
}

async function authenticatedMemberId(): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await getSupabase().auth.getSession();
    if (error) return null;
    return cleanMemberId(data.session?.user.id ?? null);
  } catch {
    return null;
  }
}

/**
 * Installs member-scoped sync. Production callers omit the argument and the
 * identity is read from the authenticated Supabase session. Tests may provide
 * an explicit local identity; it is never sent to the server and cannot change
 * server-side ownership, which always comes from req.member.id.
 */
export function ensureWatchlistSync(memberIdOverride?: string | null): void {
  if (typeof window === 'undefined') return;
  const hasExplicitOverride = memberIdOverride !== undefined;
  if (hasExplicitOverride) explicitIdentityOverrideActive = true;
  installOnce();
  if (hasExplicitOverride) {
    queueIdentity(memberIdOverride ?? null);
    return;
  }
  explicitIdentityOverrideActive = false;
  void authenticatedMemberId().then((memberId) => {
    if (!explicitIdentityOverrideActive) queueIdentity(memberId);
  });
}

// Kept reachable for deterministic module cleanup in browser tests/dev HMR.
export function stopWatchlistSync(): void {
  requestedIdentityVersion += 1;
  identityGeneration += 1;
  identityAbort?.abort(new DOMException('Watchlist sync stopped.', 'AbortError'));
  identityAbort = null;
  authSubscription?.unsubscribe();
  authSubscription = null;
  if (pushTimer !== null) clearTimeout(pushTimer);
  pushTimer = null;
  if (typeof window !== 'undefined' && installed) window.removeEventListener(WATCHLIST_CHANGE_EVENT, schedulePush);
  installed = false;
  activeMemberId = null;
  identityHydrated = false;
  explicitIdentityOverrideActive = false;
  pushInFlight = false;
  pushPending = false;
}
