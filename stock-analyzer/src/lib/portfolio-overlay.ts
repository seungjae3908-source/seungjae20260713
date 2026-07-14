export interface PortfolioChartOverlay {
	ticker: string;
	name: string;
	market: "KR" | "US";
	currency: "KRW" | "USD";
	averagePrice: number;
	quantity: number;
	purchaseDate: string;
	currentPrice: number | null;
	rate: number | null;
	updatedAt: string;
}

interface PortfolioOverlayInput {
	ticker: string;
	name: string;
	market: "KR" | "US";
	currency: "KRW" | "USD";
	average_price: number;
	quantity: number;
	purchase_date?: string | null;
	created_at?: string | null;
	currentPrice?: number | null;
}

const STORAGE_KEY = "sa-portfolio-chart-overlays-v1";
const PURCHASE_DATE_KEY = "sa-portfolio-purchase-dates-v1";

function hasStorage() {
	return typeof window !== "undefined" && Boolean(window.localStorage);
}

function normalizeDate(value: unknown) {
	const text = String(value ?? "").trim();

	if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

	const parsed = new Date(text);
	if (Number.isNaN(parsed.getTime())) return "";

	return parsed.toISOString().slice(0, 10);
}

function readPurchaseDates(): Record<string, string> {
	if (!hasStorage()) return {};

	try {
		const parsed = JSON.parse(
			window.localStorage.getItem(PURCHASE_DATE_KEY) ?? "{}",
		);

		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

export function getRememberedPurchaseDate(ticker: string) {
	return readPurchaseDates()[ticker.trim().toUpperCase()] ?? "";
}

export function rememberPurchaseDate(ticker: string, date: string) {
	if (!hasStorage()) return;

	const normalizedTicker = ticker.trim().toUpperCase();
	const normalizedDate = normalizeDate(date);
	if (!normalizedTicker || !normalizedDate) return;

	const dates = readPurchaseDates();
	dates[normalizedTicker] = normalizedDate;
	window.localStorage.setItem(PURCHASE_DATE_KEY, JSON.stringify(dates));
}

export function syncPortfolioChartOverlays(rows: PortfolioOverlayInput[]) {
	if (!hasStorage()) return;

	const purchaseDates = readPurchaseDates();
	const grouped = new Map<
		string,
		{
			ticker: string;
			name: string;
			market: "KR" | "US";
			currency: "KRW" | "USD";
			quantity: number;
			totalCost: number;
			purchaseDate: string;
			currentPrice: number | null;
		}
	>();

	for (const row of rows) {
		const ticker = row.ticker.trim().toUpperCase();
		const quantity = Number(row.quantity);
		const averagePrice = Number(row.average_price);

		if (
			!ticker ||
			!Number.isFinite(quantity) ||
			quantity <= 0 ||
			!Number.isFinite(averagePrice) ||
			averagePrice <= 0
		) {
			continue;
		}

		const rowDate =
			normalizeDate(row.purchase_date) ||
			purchaseDates[ticker] ||
			normalizeDate(row.created_at) ||
			new Date().toISOString().slice(0, 10);

		const previous = grouped.get(ticker);

		if (!previous) {
			grouped.set(ticker, {
				ticker,
				name: row.name,
				market: row.market,
				currency: row.currency,
				quantity,
				totalCost: averagePrice * quantity,
				purchaseDate: rowDate,
				currentPrice:
					row.currentPrice != null && Number.isFinite(Number(row.currentPrice))
						? Number(row.currentPrice)
						: null,
			});
			continue;
		}

		previous.quantity += quantity;
		previous.totalCost += averagePrice * quantity;
		previous.purchaseDate = [previous.purchaseDate, rowDate]
			.filter(Boolean)
			.sort()[0];
		if (row.currentPrice != null && Number.isFinite(Number(row.currentPrice))) {
			previous.currentPrice = Number(row.currentPrice);
		}
	}

	const overlays: PortfolioChartOverlay[] = [...grouped.values()].map((item) => {
		const averagePrice = item.totalCost / item.quantity;
		const rate =
			item.currentPrice != null && averagePrice > 0
				? ((item.currentPrice - averagePrice) / averagePrice) * 100
				: null;

		return {
			ticker: item.ticker,
			name: item.name,
			market: item.market,
			currency: item.currency,
			averagePrice,
			quantity: item.quantity,
			purchaseDate: item.purchaseDate,
			currentPrice: item.currentPrice,
			rate,
			updatedAt: new Date().toISOString(),
		};
	});

	window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overlays));
	window.dispatchEvent(new CustomEvent("sa-portfolio-overlay-updated"));
}

export function loadPortfolioChartOverlays(): PortfolioChartOverlay[] {
	if (!hasStorage()) return [];

	try {
		const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export function getPortfolioChartOverlay(ticker: string) {
	const normalized = ticker.trim().toUpperCase();
	return (
		loadPortfolioChartOverlays().find((item) => item.ticker === normalized) ??
		null
	);
}
