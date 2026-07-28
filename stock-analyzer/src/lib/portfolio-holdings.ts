// 보유 종목(portfolio_holdings) 공용 로더 — portfolio.tsx 의 패턴을 요약 재사용한다.
// 시세는 /api/quotes 만 사용하며 주문 API는 호출하지 않는다.
import { authorizedFetch } from '@/lib/auth-fetch';
import { getSupabase } from '@/lib/supabase';

export type HoldingMarket = 'KR' | 'US' | 'COIN';
export type HoldingCurrency = 'KRW' | 'USD' | 'USDT';

export interface SimpleHolding {
	id: string;
	ticker: string;
	name: string;
	market: HoldingMarket;
	currency: HoldingCurrency;
	quantity: number;
	average_price: number;
	sector: string | null;
	currentPrice: number | null;
}

function num(value: unknown, fallback = 0): number {
	const parsed = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeMarket(value: unknown): HoldingMarket {
	const raw = String(value ?? '').toUpperCase();
	if (raw === 'US') return 'US';
	if (raw === 'COIN') return 'COIN';
	return 'KR';
}

function isManualTicker(ticker: string): boolean {
	return ticker.startsWith('MANUAL-');
}

/** 사용자 보유 종목 + /api/quotes 현재가를 결합해 반환한다. */
export async function fetchHoldingsWithQuotes(
	userId: string,
): Promise<SimpleHolding[]> {
	const supabase = getSupabase();
	const { data, error } = await supabase
		.from('portfolio_holdings')
		.select('*')
		.eq('user_id', userId)
		.order('created_at', { ascending: false });

	if (error) throw error;

	const rows = (Array.isArray(data) ? data : [])
		.map((item) => {
			const record = item as Record<string, unknown>;
			const market = normalizeMarket(record.market);
			const currency: HoldingCurrency =
				record.currency === 'USD'
					? 'USD'
					: record.currency === 'USDT'
						? 'USDT'
						: market === 'US'
							? 'USD'
							: market === 'COIN'
								? 'USDT'
								: 'KRW';
			const ticker = String(record.ticker ?? '').trim().toUpperCase();
			const sectorRaw = String(
				record.sector ?? record.sector_name ?? record.industry ?? '',
			).trim();
			return {
				id: String(record.id ?? ''),
				ticker,
				name: String(record.name ?? record.ticker ?? '').trim(),
				market,
				currency,
				quantity: Math.max(0, num(record.quantity)),
				average_price: Math.max(0, num(record.average_price)),
				sector: sectorRaw.length > 0 ? sectorRaw : null,
				currentPrice: null,
			} satisfies SimpleHolding;
		})
		.filter((row) => Boolean(row.id && row.ticker));

	if (rows.length === 0) return rows;

	const tickers = rows
		.filter((row) => !isManualTicker(row.ticker))
		.map((row) => row.ticker);

	if (tickers.length === 0) return rows;

	try {
		const response = await authorizedFetch(
			`/api/quotes?tickers=${encodeURIComponent(tickers.join(','))}`,
			{ cache: 'no-store' },
		);
		if (!response.ok) return rows;
		const payload = (await response.json()) as {
			quotes?: Array<Record<string, unknown>>;
		};
		const quoteRows = Array.isArray(payload?.quotes)
			? payload.quotes
			: Array.isArray(payload)
				? (payload as Array<Record<string, unknown>>)
				: [];
		const map = new Map<string, Record<string, unknown>>();
		for (const q of quoteRows) {
			const t = String(q.ticker ?? q.symbol ?? q.code ?? '')
				.trim()
				.toUpperCase();
			if (t) map.set(t, q);
		}
		return rows.map((row) => {
			const quote = map.get(row.ticker);
			const price = num(
				quote?.price ?? quote?.currentPrice ?? quote?.cur_prc,
				Number.NaN,
			);
			return {
				...row,
				currentPrice: Number.isFinite(price) ? Math.abs(price) : null,
			};
		});
	} catch (cause) {
		console.error('holdings quote error:', cause);
		return rows;
	}
}
