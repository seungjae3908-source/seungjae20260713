import type { SupabaseClient } from '@supabase/supabase-js';

const TABLE = 'watchlist_items';

export interface WatchlistRecord {
  ticker: string;
  name: string;
  market: string | null;
  currency: string | null;
  targetPrice: number | null;
  updatedAt: string | null;
}

export interface WatchlistInput {
  ticker: string;
  name?: string;
  market?: string | null;
  currency?: string | null;
  targetPrice?: number | null;
}

interface Row {
  ticker: string;
  name: string | null;
  market: string | null;
  currency: string | null;
  target_price: number | string | null;
  updated_at: string | null;
}

function toRecord(row: Row): WatchlistRecord {
  const target = row.target_price == null ? null : Number(row.target_price);
  return {
    ticker: row.ticker,
    name: row.name ?? row.ticker,
    market: row.market,
    currency: row.currency,
    targetPrice: target !== null && Number.isFinite(target) ? target : null,
    updatedAt: row.updated_at,
  };
}

function normalize(memberId: string, item: WatchlistInput) {
  const ticker = item.ticker.trim().toUpperCase();
  return {
    member_id: memberId,
    ticker,
    name: item.name?.trim() || ticker,
    market: item.market ?? null,
    currency: item.currency ?? null,
    target_price:
      typeof item.targetPrice === 'number' && Number.isFinite(item.targetPrice)
        ? item.targetPrice
        : null,
    updated_at: new Date().toISOString(),
  };
}

export const WatchlistService = {
  async list(db: SupabaseClient, memberId: string): Promise<WatchlistRecord[]> {
    const { data, error } = await db
      .from(TABLE)
      .select('ticker,name,market,currency,target_price,updated_at')
      .eq('member_id', memberId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(`supabase list failed: ${error.message}`);
    return (data as Row[]).map(toRecord);
  },

  async upsert(db: SupabaseClient, memberId: string, item: WatchlistInput): Promise<void> {
    const { error } = await db
      .from(TABLE)
      .upsert(normalize(memberId, item), { onConflict: 'member_id,ticker' });
    if (error) throw new Error(`supabase upsert failed: ${error.message}`);
  },

  async remove(db: SupabaseClient, memberId: string, ticker: string): Promise<void> {
    const { error } = await db
      .from(TABLE)
      .delete()
      .eq('member_id', memberId)
      .eq('ticker', ticker.trim().toUpperCase());
    if (error) throw new Error(`supabase delete failed: ${error.message}`);
  },

  async syncReplace(
    db: SupabaseClient,
    memberId: string,
    items: WatchlistInput[],
  ): Promise<WatchlistRecord[]> {
    const uniqueItems = Array.from(
      new Map(items.map((item) => [item.ticker.trim().toUpperCase(), item])).values(),
    );
    const keep = uniqueItems.map((item) => item.ticker.trim().toUpperCase());

    if (uniqueItems.length > 0) {
      const { error } = await db
        .from(TABLE)
        .upsert(uniqueItems.map((item) => normalize(memberId, item)), {
          onConflict: 'member_id,ticker',
        });
      if (error) throw new Error(`supabase sync upsert failed: ${error.message}`);
    }

    const remove = db.from(TABLE).delete().eq('member_id', memberId);
    const { error: removeError } = keep.length > 0
      ? await remove.not('ticker', 'in', `(${keep.map((ticker) => `"${ticker}"`).join(',')})`)
      : await remove;
    if (removeError) throw new Error(`supabase sync delete failed: ${removeError.message}`);

    return this.list(db, memberId);
  },
};
