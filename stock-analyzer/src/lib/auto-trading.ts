export type AutoTradeMarket = "KR" | "US";
export type AutoTradeCurrency = "KRW" | "USD";

export interface AutoTradeCandidate {
	ticker: string;
	name: string;
	market: AutoTradeMarket;
	currency: AutoTradeCurrency;
	rank: number;
	score: number;
	probability: number;
	price: number | null;
	changePercent: number | null;
	reasons: string[];
	generatedAt: string;
}

export interface AutoTradeSettings {
	enabled: boolean;
	liveTrading: boolean;
	maxRanks: number;
	investmentPerTrade: number;
	minProbability: number;
	stopLossPercent: number;
	takeProfitPercent: number;
	executionKey: string;
}

export interface AutoTradeRunResult {
	ok: boolean;
	dryRun?: boolean;
	message?: string;
	results?: Array<{
		ticker: string;
		ok: boolean;
		skipped?: boolean;
		quantity?: number;
		orderNo?: string | null;
		message?: string;
	}>;
}

const SETTINGS_KEY = "sa-auto-trade-settings-v1";
const CANDIDATES_KEY = "sa-auto-trade-candidates-v1";
const EXECUTED_KEY = "sa-auto-trade-executed-v1";

const DEFAULT_SETTINGS: AutoTradeSettings = {
	enabled: false,
	liveTrading: false,
	maxRanks: 5,
	investmentPerTrade: 0,
	minProbability: 0,
	stopLossPercent: 0,
	takeProfitPercent: 0,
	executionKey: "",
};

function storageAvailable() {
	return typeof window !== "undefined" && Boolean(window.localStorage);
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function safeNumber(value: unknown, fallback = 0) {
	const parsed =
		typeof value === "number"
			? value
			: Number(String(value ?? "").replace(/,/g, "").replace(/%/g, ""));

	return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadAutoTradeSettings(): AutoTradeSettings {
	if (!storageAvailable()) return { ...DEFAULT_SETTINGS };

	try {
		const parsed = JSON.parse(
			window.localStorage.getItem(SETTINGS_KEY) ?? "{}",
		) as Partial<AutoTradeSettings>;

		return {
			...DEFAULT_SETTINGS,
			...parsed,
			maxRanks: clamp(Math.round(safeNumber(parsed.maxRanks, 5)), 1, 5),
			investmentPerTrade: Math.max(
				1,
				Math.round(safeNumber(parsed.investmentPerTrade, 0)),
			),
			minProbability: clamp(
				Math.round(safeNumber(parsed.minProbability, 0)),
				0,
				99,
			),
			stopLossPercent: clamp(
				safeNumber(parsed.stopLossPercent, 0),
				0,
				50,
			),
			takeProfitPercent: clamp(
				safeNumber(parsed.takeProfitPercent, 0),
				0,
				200,
			),
			executionKey: String(parsed.executionKey ?? ""),
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function saveAutoTradeSettings(
	settings: AutoTradeSettings,
): AutoTradeSettings {
	const normalized: AutoTradeSettings = {
		...settings,
		maxRanks: clamp(Math.round(settings.maxRanks), 1, 5),
		investmentPerTrade: Math.max(0, Math.round(settings.investmentPerTrade)),
		minProbability: clamp(Math.round(settings.minProbability), 0, 99),
		stopLossPercent: clamp(settings.stopLossPercent, 0, 50),
		takeProfitPercent: clamp(settings.takeProfitPercent, 0, 200),
		executionKey: settings.executionKey.trim(),
	};

	if (storageAvailable()) {
		window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
		window.dispatchEvent(new CustomEvent("sa-auto-trade-updated"));
	}

	return normalized;
}

export function estimateAutoTradeProbability(input: {
	score: number;
	matchedCount: number;
	selectedCount: number;
	changePercent?: number | null;
	breakoutProbability?: number | null;
}) {
	const selectedCount = Math.max(1, input.selectedCount);
	const matchRatio = input.matchedCount / selectedCount;
	const breakout = safeNumber(input.breakoutProbability, Number.NaN);

	if (Number.isFinite(breakout) && breakout > 0) {
		return clamp(Math.round(breakout), 1, 95);
	}

	const change = safeNumber(input.changePercent, 0);
	const trendBonus = change > 0 ? Math.min(6, change * 1.2) : Math.max(-8, change);
	const probability =
		35 +
		clamp(input.score, 0, 100) * 0.42 +
		matchRatio * 18 +
		trendBonus;

	return clamp(Math.round(probability), 1, 95);
}

export function saveAutoTradeCandidates(candidates: AutoTradeCandidate[]) {
	if (!storageAvailable()) return;

	window.localStorage.setItem(
		CANDIDATES_KEY,
		JSON.stringify(candidates.slice(0, 5)),
	);
	window.dispatchEvent(new CustomEvent("sa-auto-trade-updated"));
}

export function loadAutoTradeCandidates(): AutoTradeCandidate[] {
	if (!storageAvailable()) return [];

	try {
		const parsed = JSON.parse(
			window.localStorage.getItem(CANDIDATES_KEY) ?? "[]",
		);

		if (!Array.isArray(parsed)) return [];

		return parsed
			.map((item) => ({
				ticker: String(item?.ticker ?? "").trim().toUpperCase(),
				name: String(item?.name ?? item?.ticker ?? "").trim(),
				market: item?.market === "US" ? "US" : "KR",
				currency: item?.currency === "USD" ? "USD" : "KRW",
				rank: clamp(Math.round(safeNumber(item?.rank, 5)), 1, 5),
				score: clamp(Math.round(safeNumber(item?.score, 0)), 0, 100),
				probability: clamp(
					Math.round(safeNumber(item?.probability, 0)),
					0,
					100,
				),
				price:
					item?.price == null || !Number.isFinite(Number(item.price))
						? null
						: Number(item.price),
				changePercent:
					item?.changePercent == null ||
					!Number.isFinite(Number(item.changePercent))
						? null
						: Number(item.changePercent),
				reasons: Array.isArray(item?.reasons)
					? item.reasons.map(String).filter(Boolean)
					: [],
				generatedAt: String(item?.generatedAt ?? ""),
			}))
			.filter((item) => item.ticker)
			.slice(0, 5) as AutoTradeCandidate[];
	} catch {
		return [];
	}
}

export function getAutoTradeSignal(ticker: string) {
	const normalized = ticker.trim().toUpperCase();
	const settings = loadAutoTradeSettings();
	const candidate = loadAutoTradeCandidates().find(
		(item) => item.ticker === normalized,
	);

	if (
		!candidate ||
		!settings.enabled ||
		candidate.rank > settings.maxRanks ||
		candidate.probability < settings.minProbability
	) {
		return null;
	}

	return {
		candidate,
		settings,
		label: settings.liveTrading ? "자동매매 활성" : "자동신호 활성",
	};
}

function kstDateKey() {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Seoul",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date());
}

function loadExecutedKeys(): string[] {
	if (!storageAvailable()) return [];

	try {
		const parsed = JSON.parse(
			window.localStorage.getItem(EXECUTED_KEY) ?? "[]",
		);

		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

export function pendingAutoTradeCandidates(
	candidates: AutoTradeCandidate[],
	settings: AutoTradeSettings,
) {
	const executed = new Set(loadExecutedKeys());
	const dateKey = kstDateKey();

	return candidates
		.filter(
			(candidate) =>
				candidate.rank <= settings.maxRanks &&
				candidate.probability >= settings.minProbability,
		)
		.filter(
			(candidate) => !executed.has(`${dateKey}:${candidate.ticker}:BUY`),
		)
		.slice(0, settings.maxRanks);
}

export function markAutoTradeExecuted(tickers: string[]) {
	if (!storageAvailable() || tickers.length === 0) return;

	const dateKey = kstDateKey();
	const merged = new Set(loadExecutedKeys());

	for (const ticker of tickers) {
		merged.add(`${dateKey}:${ticker.trim().toUpperCase()}:BUY`);
	}

	window.localStorage.setItem(
		EXECUTED_KEY,
		JSON.stringify([...merged].slice(-200)),
	);
}

export async function executeAutoTradeCandidates(
	candidates: AutoTradeCandidate[],
	settings: AutoTradeSettings,
): Promise<AutoTradeRunResult> {
	if (settings.investmentPerTrade <= 0) {
		throw new Error("주문금액을 직접 입력해 주세요.");
	}
	if (settings.minProbability <= 0) {
		throw new Error("최소 확률을 직접 입력해 주세요.");
	}
	if (settings.stopLossPercent <= 0) {
		throw new Error("손절 기준을 직접 입력해 주세요.");
	}
	if (settings.takeProfitPercent <= 0) {
		throw new Error("목표 수익을 직접 입력해 주세요.");
	}

	const targets = pendingAutoTradeCandidates(candidates, settings);

	if (!settings.enabled || !settings.liveTrading) {
		return {
			ok: false,
			message: "실제 자동매매가 활성화되어 있지 않습니다.",
			results: [],
		};
	}

	if (!settings.executionKey.trim()) {
		return {
			ok: false,
			message: "자동매매 실행키를 입력해 주세요.",
			results: [],
		};
	}

	if (targets.length === 0) {
		return {
			ok: true,
			message: "오늘 이미 주문했거나 기준을 충족한 신규 후보가 없습니다.",
			results: [],
		};
	}

	const response = await fetch("/api/stocks/auto-trade/execute", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Auto-Trade-Key": settings.executionKey.trim(),
		},
		body: JSON.stringify({
			candidates: targets,
			investmentPerTrade: settings.investmentPerTrade,
			stopLossPercent: settings.stopLossPercent,
			takeProfitPercent: settings.takeProfitPercent,
		}),
	});

	const payload = (await response.json().catch(() => ({}))) as AutoTradeRunResult;

	if (!response.ok) {
		throw new Error(payload.message || `자동매매 주문 실패 (HTTP ${response.status})`);
	}

	const completed = (payload.results ?? [])
		.filter((item) => item.ok && !item.skipped)
		.map((item) => item.ticker);

	markAutoTradeExecuted(completed);

	return payload;
}

export async function monitorAutoTradePositions(
	settings: AutoTradeSettings,
): Promise<AutoTradeRunResult & { activePositions?: number }> {
	if (!settings.enabled || !settings.liveTrading || !settings.executionKey.trim()) {
		return { ok: false, results: [] };
	}

	const response = await fetch("/api/stocks/auto-trade/monitor", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Auto-Trade-Key": settings.executionKey.trim(),
		},
		body: "{}",
	});
	const payload = (await response.json().catch(() => ({}))) as AutoTradeRunResult & {
		activePositions?: number;
	};

	if (!response.ok) {
		throw new Error(payload.message || `자동청산 확인 실패 (HTTP ${response.status})`);
	}

	return payload;
}
