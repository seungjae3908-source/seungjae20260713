// Watchlist persistence backed by Supabase (table: watchlist_items).
// All access goes through the server's secret key; the table is locked by RLS
// so the publishable key cannot touch it directly.
import { getSupabase, hasSupabaseServerKey } from '../lib/supabase';

const TABLE = 'watchlist_items';

export interface WatchlistRecord {
	ticker: string;
	name: string;
	assetType: string;
	market: string | null;
	currency: string | null;
	targetPrice: number | null;
	updatedAt: string | null;
}

export interface WatchlistInput {
	ticker: string;
	name?: string;
	assetType?: string;
	market?: string | null;
	currency?: string | null;
	targetPrice?: number | null;
}

interface Row {
	ticker: string;
	name: string | null;
	asset_type: string | null;
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
		assetType: row.asset_type ?? 'stockKR',
		market: row.market,
		currency: row.currency,
		targetPrice: Number.isFinite(target as number) ? (target as number) : null,
		updatedAt: row.updated_at,
	};
}

// 기존 device_id 컬럼은 스키마 호환을 위해 유지하되 값은 항상
// 인증 미들웨어가 확인한 member.id만 사용한다.
function normalize(memberId: string, item: WatchlistInput) {
	return {
		device_id: memberId,
		ticker: item.ticker.toUpperCase(),
		name: item.name ?? item.ticker.toUpperCase(),
		asset_type: item.assetType ?? 'stockKR',
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

	async list(memberId: string): Promise<WatchlistRecord[]> {
		const { data, error } = await getSupabase()
			.from(TABLE)
			.select('ticker,name,asset_type,market,currency,target_price,updated_at')
			.eq('device_id', memberId)
			.order('created_at', { ascending: true });
		if (error) throw new Error(`supabase list failed: ${error.message}`);
		return (data as Row[]).map(toRecord);
	},

	async upsert(memberId: string, item: WatchlistInput): Promise<void> {
		const { error } = await getSupabase()
			.from(TABLE)
			.upsert(normalize(memberId, item), {
				onConflict: 'device_id,asset_type,ticker',
			});
		if (error) throw new Error(`supabase upsert failed: ${error.message}`);
	},

	async remove(memberId: string, ticker: string, assetType?: string): Promise<void> {
		let query = getSupabase()
			.from(TABLE)
			.delete()
			.eq('device_id', memberId)
			.eq('ticker', ticker.toUpperCase());
		if (assetType) query = query.eq('asset_type', assetType);
		const { error } = await query;
		if (error) throw new Error(`supabase delete failed: ${error.message}`);
	},

	// Replace the device's whole set: upsert everything in `items`, delete rows
	// that are no longer present. Returns the canonical server list.
	async syncReplace(
		memberId: string,
		items: WatchlistInput[],
	): Promise<WatchlistRecord[]> {
		const supabase = getSupabase();
		const keep = items.map(
			(item) => `${item.assetType ?? 'stockKR'}:${item.ticker.toUpperCase()}`,
		);

		if (items.length > 0) {
			const { error } = await supabase
				.from(TABLE)
				.upsert(items.map((item) => normalize(memberId, item)), {
					onConflict: 'device_id,asset_type,ticker',
				});
			if (error) throw new Error(`supabase sync upsert failed: ${error.message}`);
		}

		const { data: existing, error: listError } = await supabase
			.from(TABLE)
			.select('ticker,asset_type')
			.eq('device_id', memberId);
		if (listError) throw new Error(`supabase sync list failed: ${listError.message}`);
		const removeRows = (existing ?? []).filter(
			(row) =>
				!keep.includes(
					`${String(row.asset_type ?? 'stockKR')}:${String(row.ticker).toUpperCase()}`,
				),
		);
		const results = await Promise.all(
			removeRows.map((row) =>
				supabase
					.from(TABLE)
					.delete()
					.eq('device_id', memberId)
					.eq('asset_type', String(row.asset_type ?? 'stockKR'))
					.eq('ticker', String(row.ticker).toUpperCase()),
			),
		);
		const delError = results.find((result) => result.error)?.error;
		if (delError) throw new Error(`supabase sync delete failed: ${delError.message}`);

		return this.list(memberId);
	},
};
