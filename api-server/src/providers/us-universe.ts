import { type CatalogEntry } from '../data/catalog';
import {
	classifyAssetType,
	isInverse,
	isLeveraged,
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
	return (symbol ?? '').trim().toUpperCase();
}

function cleanName(row: FinnhubSymbolRow): string {
	return (
		row.description?.trim() ||
		row.displaySymbol?.trim() ||
		row.symbol?.trim() ||
		''
	);
}

function isProbablyTradableSymbol(ticker: string): boolean {
	if (!ticker) return false;
	if (ticker.length > 8) return false;
	if (ticker.includes('.')) return false;
	if (ticker.includes('/')) return false;
	if (ticker.includes(' ')) return false;

	return /^[A-Z]+$/.test(ticker);
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

	const token = finnhubKey();

	if (!token) {
		console.error('[us-universe] Missing FINNHUB_API_KEY');
		return [];
	}

	const url = `${BASE}/stock/symbol?exchange=US&token=${encodeURIComponent(
		token,
	)}`;

	// 타임아웃 없는 fetch는 상류 지연 시 서버 전체를 붙잡을 수 있어 15초 제한을 둡니다.
const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

	if (!res.ok) {
		console.error('[us-universe] Finnhub failed:', res.status, res.statusText);
		return [];
	}

	const json = (await res.json()) as unknown;

	if (!Array.isArray(json)) {
		return [];
	}

	const seen = new Set<string>();
	const rows: UsUniverseEntry[] = [];

	for (const row of json as FinnhubSymbolRow[]) {
		const ticker = cleanTicker(row.symbol);
		if (!isProbablyTradableSymbol(ticker)) continue;
		if (seen.has(ticker)) continue;

		const name = cleanName(row);
		if (!name) continue;

		const assetType = detectAssetType(row);
		if (!allowedAssetType(assetType)) continue;

		seen.add(ticker);

		rows.push({
			ticker,
			name,
			market: 'US',
			currency: 'USD',
			assetType,
			exchange: normalizeExchange(row.mic),
			rawType: row.type ?? '',
		});
	}

	rows.sort((a, b) => {
		const ex = a.exchange.localeCompare(b.exchange);
		if (ex !== 0) return ex;

		return a.ticker.localeCompare(b.ticker);
	});

	cache = {
		at: Date.now(),
		rows,
	};

	console.log('[us-universe] loaded:', rows.length);

	return rows;
}