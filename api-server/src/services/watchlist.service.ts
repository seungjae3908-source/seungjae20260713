// Watchlist persistence backed by Supabase (table: watchlist_items).
// All access goes through the server's secret key; the table is locked by RLS
// so the publishable key cannot touch it directly.
import { getSupabase, hasSupabaseServerKey } from '../lib/supabase';

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
	const target =
		row.target_price === null || row.target_price === undefined
			? null
			: Number(row.target_price);
	return {
		ticker: row.ticker,
		name: row.name ?? row.ticker,
		market: row.market,
		currency: row.currency,
		targetPrice: Number.isFinite(target as number) ? (target as number) : null,
		updatedAt: row.updated_at,
	};
}

function normalize(deviceId: string, item: WatchlistInput) {
	return {
		device_id: deviceId,
		ticker: item.ticker.toUpperCase(),
		name: item.name ?? item.ticker.toUpperCase(),
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
	isAvailable(): boolean {
		return hasSupabaseServerKey();
	},

	async list(deviceId: string): Promise<WatchlistRecord[]> {
		const { data, error } = await getSupabase()
			.from(TABLE)
			.select('ticker,name,market,currency,target_price,updated_at')
			.eq('device_id', deviceId)
			.order('created_at', { ascending: true });
		if (error) throw new Error(`supabase list failed: ${error.message}`);
		return (data as Row[]).map(toRecord);
	},

	async upsert(deviceId: string, item: WatchlistInput): Promise<void> {
		const { error } = await getSupabase()
			.from(TABLE)
			.upsert(normalize(deviceId, item), { onConflict: 'device_id,ticker' });
		if (error) throw new Error(`supabase upsert failed: ${error.message}`);
	},

	async remove(deviceId: string, ticker: string): Promise<void> {
		const { error } = await getSupabase()
			.from(TABLE)
			.delete()
			.eq('device_id', deviceId)
			.eq('ticker', ticker.toUpperCase());
		if (error) throw new Error(`supabase delete failed: ${error.message}`);
	},

	// Replace the device's whole set: upsert everything in `items`, delete rows
	// that are no longer present. Returns the canonical server list.
	async syncReplace(
		deviceId: string,
		items: WatchlistInput[],
	): Promise<WatchlistRecord[]> {
		const supabase = getSupabase();
		const keep = items.map((item) => item.ticker.toUpperCase());

		if (items.length > 0) {
			const { error } = await supabase
				.from(TABLE)
				.upsert(items.map((item) => normalize(deviceId, item)), {
					onConflict: 'device_id,ticker',
				});
			if (error) throw new Error(`supabase sync upsert failed: ${error.message}`);
		}

		const del = supabase.from(TABLE).delete().eq('device_id', deviceId);
		const { error: delError } =
			keep.length > 0
				? await del.not('ticker', 'in', `(${keep.map((t) => `"${t}"`).join(',')})`)
				: await del;
		if (delError) throw new Error(`supabase sync delete failed: ${delError.message}`);

		return this.list(deviceId);
	},
};
