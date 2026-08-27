import { getSupabase, getUserSupabase, hasSupabaseServerKey } from '../lib/supabase';

export const MEMBER_WATCHLIST_MARKETS = [
  'KR_STOCK',
  'US_STOCK',
  'CRYPTO_SPOT',
  'CRYPTO_FUTURES',
] as const;
export type MemberWatchlistMarket = (typeof MEMBER_WATCHLIST_MARKETS)[number];
type StoredMemberWatchlistMarket = MemberWatchlistMarket | 'UNRESOLVED';

type MemberTelegramEligibilityProfile = {
  status?: unknown;
  membership_level?: unknown;
  is_active?: unknown;
};

export type MemberWatchlistInput = {
  ticker?: unknown;
  name?: unknown;
  market?: unknown;
  currency?: unknown;
  targetPrice?: unknown;
};

export type MemberWatchlistItem = {
  ticker: string;
  name: string;
  market: StoredMemberWatchlistMarket;
  currency: string | null;
  targetPrice: number | null;
};

export type MemberWatchlistSubscriber = {
  userId: string;
};

const MAX_ITEMS = 200;
const MATCH_PAGE_SIZE = 500;
const MAX_MATCH_PAGES = 20;
const MAX_PROFILE_LOOKUP_BATCH = 200;

function text(value: unknown, maxLength: number): string {
  return String(value ?? '').normalize('NFKC').trim().slice(0, maxLength);
}

/**
 * Database projection of the current canConnectPersonalTelegram gate.
 * The query already requires status=approved. An explicitly inactive profile
 * or an explicit pending membership tier must still fail closed immediately.
 * Other approved tiers (associate/regular/admin, or legacy approved rows with
 * no explicit tier) have the personal-Telegram capability in the canonical
 * member-access matrix.
 */
export function memberEligibleForPersonalTelegram(profile: MemberTelegramEligibilityProfile): boolean {
  return profile.status === 'approved'
    && profile.is_active !== false
    && profile.membership_level !== 'pending';
}

function canonicalMarket(value: unknown, symbol: string): StoredMemberWatchlistMarket {
  const raw = text(value, 32).toUpperCase().replace(/[-\s]/gu, '_');
  if (['KR', 'KR_STOCK', 'KOSPI', 'KOSDAQ'].includes(raw)) return 'KR_STOCK';
  if (['US', 'US_STOCK', 'NASDAQ', 'NYSE', 'AMEX'].includes(raw)) return 'US_STOCK';
  if (['CRYPTO_SPOT', 'COIN_SPOT', 'SPOT', 'UPBIT'].includes(raw)) return 'CRYPTO_SPOT';
  if (['CRYPTO_FUTURES', 'COIN_FUTURES', 'FUTURES', 'BITGET'].includes(raw)) return 'CRYPTO_FUTURES';
  if (/^\d{6}$/u.test(symbol)) return 'KR_STOCK';
  if (/^KRW-[A-Z0-9]{2,20}$/u.test(symbol)) return 'CRYPTO_SPOT';
  return 'UNRESOLVED';
}

export function normalizeMemberWatchlistItem(input: MemberWatchlistInput): MemberWatchlistItem | null {
  const ticker = text(input.ticker, 64).toUpperCase();
  if (!ticker) return null;
  const name = text(input.name, 120) || ticker;
  const currency = text(input.currency, 16).toUpperCase() || null;
  const parsedTarget = Number(input.targetPrice);
  const targetPrice = input.targetPrice == null || input.targetPrice === ''
    ? null
    : Number.isFinite(parsedTarget) && parsedTarget > 0
      ? parsedTarget
      : null;
  return {
    ticker,
    name,
    market: canonicalMarket(input.market, ticker),
    currency,
    targetPrice,
  };
}

function normalizeItems(rawItems: unknown): MemberWatchlistItem[] {
  if (!Array.isArray(rawItems)) throw new Error('MEMBER_WATCHLIST_ITEMS_REQUIRED');
  if (rawItems.length > MAX_ITEMS) throw new Error('MEMBER_WATCHLIST_TOO_LARGE');
  const unique = new Map<string, MemberWatchlistItem>();
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const item = normalizeMemberWatchlistItem(raw as MemberWatchlistInput);
    if (!item) continue;
    unique.set(`${item.market}:${item.ticker}`, item);
  }
  return Array.from(unique.values()).sort((left, right) =>
    `${left.market}:${left.ticker}`.localeCompare(`${right.market}:${right.ticker}`),
  );
}

function rowToItem(row: Record<string, unknown>): MemberWatchlistItem | null {
  return normalizeMemberWatchlistItem({
    ticker: row.symbol,
    name: row.name,
    market: row.market,
    currency: row.currency,
    targetPrice: row.target_price,
  });
}

export async function listMemberWatchlist(userId: string, accessToken: string): Promise<MemberWatchlistItem[]> {
  const client = getUserSupabase(accessToken);
  const { data, error } = await client
    .from('member_watchlist_items')
    .select('market,symbol,name,currency,target_price')
    .eq('user_id', userId)
    .order('market', { ascending: true })
    .order('symbol', { ascending: true });
  if (error) throw new Error('MEMBER_WATCHLIST_STORAGE_UNAVAILABLE');
  return (Array.isArray(data) ? data : [])
    .flatMap((row) => {
      const item = rowToItem(row as Record<string, unknown>);
      return item ? [item] : [];
    });
}

export async function syncMemberWatchlist(
  userId: string,
  accessToken: string,
  rawItems: unknown,
): Promise<{ items: MemberWatchlistItem[]; unresolvedCount: number }> {
  const items = normalizeItems(rawItems);
  const client = getUserSupabase(accessToken);
  const now = new Date().toISOString();

  if (items.length > 0) {
    const rows = items.map((item) => ({
      user_id: userId,
      market: item.market,
      symbol: item.ticker,
      name: item.name,
      currency: item.currency,
      target_price: item.targetPrice,
      updated_at: now,
    }));
    const { error } = await client
      .from('member_watchlist_items')
      .upsert(rows, { onConflict: 'user_id,market,symbol' });
    if (error) throw new Error('MEMBER_WATCHLIST_STORAGE_UNAVAILABLE');
  }

  const { data: existing, error: existingError } = await client
    .from('member_watchlist_items')
    .select('market,symbol')
    .eq('user_id', userId);
  if (existingError) throw new Error('MEMBER_WATCHLIST_STORAGE_UNAVAILABLE');

  const desired = new Set(items.map((item) => `${item.market}:${item.ticker}`));
  for (const row of Array.isArray(existing) ? existing : []) {
    const market = text((row as Record<string, unknown>).market, 32);
    const symbol = text((row as Record<string, unknown>).symbol, 64).toUpperCase();
    if (!market || !symbol || desired.has(`${market}:${symbol}`)) continue;
    const { error } = await client
      .from('member_watchlist_items')
      .delete()
      .eq('user_id', userId)
      .eq('market', market)
      .eq('symbol', symbol);
    if (error) throw new Error('MEMBER_WATCHLIST_STORAGE_UNAVAILABLE');
  }

  return {
    items,
    unresolvedCount: items.filter((item) => item.market === 'UNRESOLVED').length,
  };
}

export async function findMemberWatchlistSubscribers(
  market: MemberWatchlistMarket,
  symbolValue: string,
): Promise<MemberWatchlistSubscriber[]> {
  if (!hasSupabaseServerKey()) throw new Error('MEMBER_WATCHLIST_SERVER_KEY_REQUIRED');
  const symbol = text(symbolValue, 64).toUpperCase();
  if (!symbol) return [];
  const client = getSupabase();
  const userIds = new Set<string>();
  let exhausted = false;

  for (let page = 0; page < MAX_MATCH_PAGES; page += 1) {
    const from = page * MATCH_PAGE_SIZE;
    const to = from + MATCH_PAGE_SIZE - 1;
    const { data, error } = await client
      .from('member_watchlist_items')
      .select('user_id')
      .eq('market', market)
      .eq('symbol', symbol)
      .range(from, to);
    if (error) throw new Error('MEMBER_WATCHLIST_STORAGE_UNAVAILABLE');
    const rows = Array.isArray(data) ? data : [];
    for (const row of rows) {
      const userId = text((row as Record<string, unknown>).user_id, 64);
      if (userId) userIds.add(userId);
    }
    if (rows.length < MATCH_PAGE_SIZE) {
      exhausted = true;
      break;
    }
  }

  if (!exhausted) throw new Error('MEMBER_WATCHLIST_MATCH_LIMIT_EXCEEDED');
  const candidates = Array.from(userIds).sort();
  if (candidates.length === 0) return [];

  const eligible = new Set<string>();
  for (let index = 0; index < candidates.length; index += MAX_PROFILE_LOOKUP_BATCH) {
    const batch = candidates.slice(index, index + MAX_PROFILE_LOOKUP_BATCH);
    const { data: profiles, error: profileError } = await client
      .from('profiles')
      .select('id,status,membership_level,is_active')
      .in('id', batch)
      .eq('status', 'approved');
    if (profileError) throw new Error('MEMBER_WATCHLIST_STORAGE_UNAVAILABLE');
    for (const row of Array.isArray(profiles) ? profiles : []) {
      const profile = row as Record<string, unknown> & MemberTelegramEligibilityProfile;
      const userId = text(profile.id, 64);
      if (userId && memberEligibleForPersonalTelegram(profile)) eligible.add(userId);
    }
  }

  return candidates
    .filter((userId) => eligible.has(userId))
    .map((userId) => ({ userId }));
}
