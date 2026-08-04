import { type CatalogEntry } from '../data/catalog';
import {
	classifyAssetType,
	type AssetType,
} from '../data/asset-type';

interface FinnhubSymbolRow {
	currency?: string;
	description?: string;
	displaySymbol?: string;
	figi?: string;
	mic?: string;
	symbol?: string;
	type?: string;
}

export interface UsUniverseEntry extends CatalogEntry {
	assetType: AssetType;
	exchange: 'NASDAQ' | 'NYSE' | 'AMEX' | 'US';
	rawType: string;
}

const BASE = 'https://finnhub.io/api/v1';
const CACHE_MS = 12 * 60 * 60 * 1000;

let cache:
	| {
			at: number;
			rows: UsUniverseEntry[];
		}
	| null = null;

function finnhubKey(): string {
	return (
		process.env.FINNHUB_API_KEY ??
		process.env.VITE_FINNHUB_API_KEY ??
		process.env.FINNHUB_KEY ??
		''
	);
}

function normalizeExchange(mic?: string): UsUniverseEntry['exchange'] {
	const v = (mic ?? '').toUpperCase();

	if (v === 'XNAS' || v === 'XNMS' || v === 'XNCM' || v === 'XNGS') {
		return 'NASDAQ';
	}

	if (v === 'XNYS') {
		return 'NYSE';
	}

	if (v === 'XASE' || v === 'ARCX' || v === 'BATS' || v === 'AMEX') {
		return 'AMEX';
	}

	return 'US';
}

function cleanTicker(symbol?: string): string {
	return (symbol ?? '').normalize('NFKC').trim().toUpperCase();
}

function cleanName(row: FinnhubSymbolRow): string {
	return (
		row.description?.normalize('NFKC').trim() ||
		row.displaySymbol?.normalize('NFKC').trim() ||
		row.symbol?.normalize('NFKC').trim() ||
		''
	);
}

function isProbablyTradableSymbol(ticker: string): boolean {
	if (!ticker || ticker.length > 15) return false;
	if (ticker.includes('/') || ticker.includes(' ')) return false;
	return /^[A-Z0-9]+(?:[.-][A-Z0-9]+)*$/.test(ticker);
}

function detectAssetType(row: FinnhubSymbolRow): AssetType {
	const name = cleanName(row);
	const rawType = (row.type ?? '').toLowerCase();
	const merged = `${name} ${rawType}`.toLowerCase();

	if (merged.includes('etn')) {
		if (isLeveragedName(merged)) return 'LEVERAGED_ETN';
		if (isInverseName(merged)) return 'INVERSE_ETN';
		return 'ETN';
	}

	if (
		merged.includes('etf') ||
		merged.includes('etp') ||
		merged.includes('fund')
	) {
		if (isLeveragedName(merged)) return 'LEVERAGED_ETF';
		if (isInverseName(merged)) return 'INVERSE_ETF';
		return 'ETF';
	}

	if (merged.includes('adr')) return 'ADR';
	if (merged.includes('reit')) return 'REIT';

	return classifyAssetType(name, 'US');
}

function isLeveragedName(v: string): boolean {
	return (
		v.includes('2x') ||
		v.includes('3x') ||
		v.includes('bull') ||
		v.includes('ultra') ||
		v.includes('leveraged')
	);
}

function isInverseName(v: string): boolean {
	return (
		v.includes('inverse') ||
		v.includes('short') ||
		v.includes('bear')
	);
}

function allowedAssetType(assetType: AssetType): boolean {
	return (
		assetType === 'STOCK' ||
		assetType === 'ADR' ||
		assetType === 'REIT' ||
		assetType === 'ETF' ||
		assetType === 'ETN' ||
		assetType === 'LEVERAGED_ETF' ||
		assetType === 'INVERSE_ETF' ||
		assetType === 'LEVERAGED_ETN' ||
		assetType === 'INVERSE_ETN'
	);
}

export async function getUsUniverse(): Promise<UsUniverseEntry[]> {
	if (cache && Date.now() - cache.at < CACHE_MS) {
		return cache.rows;
	}

	const lastGoodRows = cache?.rows ?? [];
	const token = finnhubKey();

	if (!token) {
		console.error('[us-universe] Missing FINNHUB_API_KEY');
		return lastGoodRows;
	}

	const url = `${BASE}/stock/symbol?exchange=US&token=${encodeURIComponent(token)}`;

	let res: Response;
	try {
		res = await fetch(url);
	} catch (error) {
		console.error('[us-universe] Finnhub request failed:', error);
		return lastGoodRows;
	}

	if (!res.ok) {
		console.error('[us-universe] Finnhub failed:', res.status, res.statusText);
		return lastGoodRows;
	}

	const json = (await res.json()) as unknown;

	if (!Array.isArray(json)) {
		return lastGoodRows;
	}

	const seen = new Set<string>();
	const rows: UsUniverseEntry[] = [];

	for (const row of json as FinnhubSymbolRow[]) {
		const ticker = cleanTicker(row.symbol);
		if (!isProbablyTradableSymbol(ticker)) continue;

		const exchange = normalizeExchange(row.mic);
		const uniqueKey = `${exchange}:${ticker}`;
		if (seen.has(uniqueKey)) continue;

		const name = cleanName(row);
		if (!name) continue;

		const assetType = detectAssetType(row);
		if (!allowedAssetType(assetType)) continue;

		seen.add(uniqueKey);

		rows.push({
			ticker,
			name,
			market: 'US',
			currency: 'USD',
			assetType,
			exchange,
			rawType: row.type ?? '',
		});
	}

	rows.sort((a, b) => {
		const ex = a.exchange.localeCompare(b.exchange);
		if (ex !== 0) return ex;
		return a.ticker.localeCompare(b.ticker);
	});

	if (rows.length === 0) return lastGoodRows;

	cache = {
		at: Date.now(),
		rows,
	};

	console.log('[us-universe] loaded:', rows.length);

	return rows;
}
