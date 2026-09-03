import { authorizedFetch } from './auth-fetch';
export type AutoTradeMarket = "KR" | "US";
export type AutoTradeCurrency = "KRW" | "USD";
export type AutoTradeExchange = "NASDAQ" | "NYSE" | "AMEX";

export interface AutoTradeCandidate {
	ticker: string;
	name: string;
	market: AutoTradeMarket;
	currency: AutoTradeCurrency;
	exchange: AutoTradeExchange | null;
	rank: number;
	score: number;
	probability: number;
	riskScore: number;
	dataCompleteness: number;
	price: number | null;
	changePercent: number | null;
	reasons: string[];
	factors: string[];
	generatedAt: string;
}

export interface AutoTradeSettings {
	enabled: boolean;
	liveTrading: boolean;
	maxRanks: number;
	investmentPerTrade: number;
	accountValue: number;
	riskPerTradePercent: number;
	dailyLossLimitPercent: number;
	maxOpenPositions: number;
	maxConsecutiveLosses: number;
	maxDailyOrders: number;
	minProbability: number;
	stopLossPercent: number;
	takeProfitPercent: number;
	executionKey: string;
}

export interface AutoTradeRiskPreview {
	riskBudget: number;
	riskLimitedInvestment: number;
	perShareRisk: number;
	riskQuantity: number;
	budgetQuantity: number;
	finalQuantity: number;
	estimatedAmount: number;
}

export interface AutoTradeSafetyJournalEntry {
	market: AutoTradeMarket;
	status: "OPEN" | "TAKE_PROFIT" | "STOP_LOSS" | "MANUAL_CLOSE";
	quantity: number;
	entryPrice: number;
	exitPrice?: number | null;
	profitPercent?: number | null;
	openedAt: string;
	closedAt?: string | null;
}

export interface AutoTradeSafetySnapshot {
	allowed: boolean;
	blockedReason: string | null;
	openPositions: number;
	dailyOrders: number;
	consecutiveLosses: number;
	dailyLossAmount: number;
	dailyLossPercent: number;
}

export interface AutoTradeRunResult {
	ok: boolean;
	dryRun?: boolean;
	message?: string;
	results?: Array<{
		ticker: string;
		market?: AutoTradeMarket;
		ok: boolean;
		skipped?: boolean;
		quantity?: number;
		orderNo?: string | null;
		currentPrice?: number;
		stopPrice?: number;
		targetPrice?: number;
		approvalRequired?: boolean;
		message?: string;
	}>;
}

const SETTINGS_KEY = "sa-auto-trade-settings-v1";
const CANDIDATES_KEY = "sa-auto-trade-candidates-v1";
const EXECUTED_KEY = "sa-auto-trade-executed-v1";
const EXECUTION_SESSION_KEY = "sa-auto-trade-execution-session-v1";

const DEFAULT_SETTINGS: AutoTradeSettings = {
	enabled: false,
	liveTrading: false,
	maxRanks: 1,
	investmentPerTrade: 100000,
	accountValue: 10000000,
	riskPerTradePercent: 0.25,
	dailyLossLimitPercent: 0.75,
	maxOpenPositions: 3,
	maxConsecutiveLosses: 2,
	maxDailyOrders: 3,
	minProbability: 70,
	stopLossPercent: 3,
	takeProfitPercent: 5,
	executionKey: "",
};

function storageAvailable() {
	return typeof window !== "undefined" && Boolean(window.localStorage);
}

function sessionStorageAvailable() {
	return typeof window !== "undefined" && Boolean(window.sessionStorage);
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

export function calculateAutoTradeRiskPreview(
	settings: Pick<
		AutoTradeSettings,
		"accountValue" | "riskPerTradePercent" | "investmentPerTrade" | "stopLossPercent"
	>,
	price: number | null | undefined,
): AutoTradeRiskPreview {
	const currentPrice = Math.max(0, safeNumber(price, 0));
	const accountValue = Math.max(0, safeNumber(settings.accountValue, 0));
	const riskPercent = clamp(safeNumber(settings.riskPerTradePercent, 0), 0, 10);
	const maxInvestment = Math.max(0, safeNumber(settings.investmentPerTrade, 0));
	const stopPercent = clamp(safeNumber(settings.stopLossPercent, 0), 0, 100);
	const riskBudget = accountValue * (riskPercent / 100);
	const riskLimitedInvestment =
		stopPercent > 0 ? riskBudget / (stopPercent / 100) : 0;
	const perShareRisk = currentPrice * (stopPercent / 100);
	const riskQuantity =
		currentPrice > 0 && perShareRisk > 0
			? Math.max(0, Math.floor(riskBudget / perShareRisk))
			: 0;
	const budgetQuantity =
		currentPrice > 0 ? Math.max(0, Math.floor(maxInvestment / currentPrice)) : 0;
	const finalQuantity = Math.max(0, Math.min(riskQuantity, budgetQuantity));

	return {
		riskBudget,
		riskLimitedInvestment,
		perShareRisk,
		riskQuantity,
		budgetQuantity,
		finalQuantity,
		estimatedAmount: finalQuantity * currentPrice,
	};
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
			// 현재 정책은 후보 전체를 비교한 뒤 확률 1위 한 종목만 주문한다.
			maxRanks: 1,
			investmentPerTrade: Math.max(
				1,
				Math.round(
					safeNumber(
						parsed.investmentPerTrade,
						DEFAULT_SETTINGS.investmentPerTrade,
					),
				),
			),
			accountValue: Math.max(
				1,
				Math.round(
					safeNumber(parsed.accountValue, DEFAULT_SETTINGS.accountValue),
				),
			),
			riskPerTradePercent: clamp(
				safeNumber(
					parsed.riskPerTradePercent,
					DEFAULT_SETTINGS.riskPerTradePercent,
				),
				0.05,
				2,
			),
			dailyLossLimitPercent: clamp(
				safeNumber(
					parsed.dailyLossLimitPercent,
					DEFAULT_SETTINGS.dailyLossLimitPercent,
				),
				0.1,
				10,
			),
			maxOpenPositions: clamp(
				Math.round(
					safeNumber(
						parsed.maxOpenPositions,
						DEFAULT_SETTINGS.maxOpenPositions,
					),
				),
				1,
				10,
			),
			maxConsecutiveLosses: clamp(
				Math.round(
					safeNumber(
						parsed.maxConsecutiveLosses,
						DEFAULT_SETTINGS.maxConsecutiveLosses,
					),
				),
				1,
				10,
			),
			maxDailyOrders: clamp(
				Math.round(
					safeNumber(
						parsed.maxDailyOrders,
						DEFAULT_SETTINGS.maxDailyOrders,
					),
				),
				1,
				20,
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
			executionKey: sessionStorageAvailable()
				? String(window.sessionStorage.getItem(EXECUTION_SESSION_KEY) ?? "")
				: "",
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
		maxRanks: 1,
		investmentPerTrade: Math.max(0, Math.round(settings.investmentPerTrade)),
		accountValue: Math.max(1, Math.round(settings.accountValue)),
		riskPerTradePercent: clamp(settings.riskPerTradePercent, 0.05, 2),
		dailyLossLimitPercent: clamp(settings.dailyLossLimitPercent, 0.1, 10),
		maxOpenPositions: clamp(Math.round(settings.maxOpenPositions), 1, 10),
		maxConsecutiveLosses: clamp(
			Math.round(settings.maxConsecutiveLosses),
			1,
			10,
		),
		maxDailyOrders: clamp(Math.round(settings.maxDailyOrders), 1, 20),
		minProbability: clamp(Math.round(settings.minProbability), 0, 99),
		stopLossPercent: clamp(settings.stopLossPercent, 0, 50),
		takeProfitPercent: clamp(settings.takeProfitPercent, 0, 200),
		executionKey: settings.executionKey.trim(),
	};

	if (storageAvailable()) {
		// 실행키는 장기 저장하지 않습니다. 브라우저 탭 세션이 끝나면 자동 폐기됩니다.
		const persistable = { ...normalized, executionKey: "" };
		window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(persistable));
		if (sessionStorageAvailable()) {
			if (normalized.executionKey) {
				window.sessionStorage.setItem(EXECUTION_SESSION_KEY, normalized.executionKey);
			} else {
				window.sessionStorage.removeItem(EXECUTION_SESSION_KEY);
			}
		}
		window.dispatchEvent(new CustomEvent("sa-auto-trade-updated"));
	}

	return normalized;
}

export interface AutoTradeAssessmentInput {
	score: number;
	matchedCount: number;
	selectedCount: number;
	changePercent?: number | null;
	breakoutProbability?: number | null;
	price?: number | null;
	volume?: number | null;
	tradingValue?: number | null;
	marketCap?: number | null;
	confidence?: number | null;
	newsScore?: number | null;
	disclosureScore?: number | null;
	financialScore?: number | null;
	riskLevel?: string | null;
	isLeveraged?: boolean;
	isInverse?: boolean;
	isDerivative?: boolean;
}

export interface AutoTradeAssessment {
	probability: number;
	riskScore: number;
	dataCompleteness: number;
	factors: string[];
}

/**
 * 차트·수급·거래량·뉴스·공시·재무 데이터가 들어오는 만큼 가중하고,
 * 결측치와 급등락·고위험 상품을 감점하는 상대평가 모델입니다.
 * 반환값은 수익 보장이 아닌 후보 비교용 모델점수입니다.
 */
export function assessAutoTradeCandidate(input: AutoTradeAssessmentInput): AutoTradeAssessment {
	const selectedCount = Math.max(1, input.selectedCount);
	const matchRatio = input.matchedCount / selectedCount;
	const breakout = safeNumber(input.breakoutProbability, Number.NaN);
	const change = safeNumber(input.changePercent, 0);
	const normalizedBreakout = Number.isFinite(breakout) && breakout > 0
		? clamp(breakout, 0, 100)
		: 50;
	const optionalValues = [
		input.volume,
		input.tradingValue,
		input.marketCap,
		input.confidence,
		input.newsScore,
		input.disclosureScore,
		input.financialScore,
	];
	const availableOptional = optionalValues.filter(
		(value) => value != null && Number.isFinite(Number(value)),
	).length;
	const dataCompleteness = clamp(
		Math.round(45 + (availableOptional / optionalValues.length) * 55),
		0,
		100,
	);

	let riskScore = 14;
	const absoluteChange = Math.abs(change);
	if (absoluteChange > 5) riskScore += Math.min(24, (absoluteChange - 5) * 1.8);
	if (change < -3) riskScore += Math.min(12, Math.abs(change));
	const riskLevel = String(input.riskLevel ?? "").toUpperCase();
	if (riskLevel.includes("HIGH") || riskLevel.includes("위험")) riskScore += 28;
	else if (riskLevel.includes("CAUTION") || riskLevel.includes("주의")) riskScore += 14;
	if (input.isLeveraged) riskScore += 28;
	if (input.isInverse) riskScore += 35;
	if (input.isDerivative) riskScore += 24;
	if (dataCompleteness < 60) riskScore += (60 - dataCompleteness) * 0.35;
	riskScore = clamp(Math.round(riskScore), 0, 100);

	const confidence = clamp(safeNumber(input.confidence, 50), 0, 100);
	const contextScores = [input.newsScore, input.disclosureScore, input.financialScore]
		.map((value) => safeNumber(value, Number.NaN))
		.filter(Number.isFinite);
	const context = contextScores.length
		? contextScores.reduce((sum, value) => sum + value, 0) / contextScores.length
		: 50;
	const trendBonus = change > 0 ? Math.min(5, change * 0.8) : Math.max(-7, change);
	const technical =
		clamp(input.score, 0, 100) * 0.48 +
		matchRatio * 27 +
		normalizedBreakout * 0.25;
	const probability = clamp(
		Math.round(
			technical * 0.64 +
			confidence * 0.12 +
			context * 0.14 +
			dataCompleteness * 0.1 +
			trendBonus -
			riskScore * 0.28,
		),
		1,
		95,
	);
	const factors = [
		`기술지표 ${Math.round(technical)}점`,
		`데이터 ${dataCompleteness}%`,
		`위험 ${riskScore}점`,
		contextScores.length ? `뉴스·공시·재무 ${Math.round(context)}점` : "뉴스·공시·재무 확인 필요",
	];

	return { probability, riskScore, dataCompleteness, factors };
}

export function estimateAutoTradeProbability(input: AutoTradeAssessmentInput) {
	return assessAutoTradeCandidate(input).probability;
}

export function saveAutoTradeCandidates(candidates: AutoTradeCandidate[]) {
	if (!storageAvailable()) return;

	window.localStorage.setItem(
		CANDIDATES_KEY,
		JSON.stringify(candidates.slice(0, 100)),
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
				exchange: ["NASDAQ", "NYSE", "AMEX"].includes(String(item?.exchange))
					? item.exchange as AutoTradeExchange
					: null,
				rank: clamp(Math.round(safeNumber(item?.rank, 100)), 1, 100),
				score: clamp(Math.round(safeNumber(item?.score, 0)), 0, 100),
				probability: clamp(
					Math.round(safeNumber(item?.probability, 0)),
					0,
					100,
				),
				riskScore: clamp(Math.round(safeNumber(item?.riskScore, 50)), 0, 100),
				dataCompleteness: clamp(
					Math.round(safeNumber(item?.dataCompleteness, 50)),
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
				factors: Array.isArray(item?.factors)
					? item.factors.map(String).filter(Boolean)
					: [],
				generatedAt: String(item?.generatedAt ?? ""),
			}))
			.filter((item) => item.ticker)
			.slice(0, 100) as AutoTradeCandidate[];
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

function kstDateKey(value: string | Date = new Date()) {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return "";

	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Seoul",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);
}

export function calculateAutoTradeSafetySnapshot(
	entries: AutoTradeSafetyJournalEntry[],
	settings: Pick<
		AutoTradeSettings,
		| "accountValue"
		| "dailyLossLimitPercent"
		| "maxOpenPositions"
		| "maxConsecutiveLosses"
		| "maxDailyOrders"
	>,
	market: AutoTradeMarket,
): AutoTradeSafetySnapshot {
	const today = kstDateKey();
	const relevant = entries.filter((entry) => entry.market === market);
	const openPositions = relevant.filter((entry) => entry.status === "OPEN").length;
	const dailyOrders = relevant.filter(
		(entry) => kstDateKey(entry.openedAt) === today,
	).length;
	const closed = relevant
		.filter((entry) => entry.status !== "OPEN" && entry.closedAt)
		.sort(
			(a, b) =>
				new Date(b.closedAt ?? 0).getTime() -
				new Date(a.closedAt ?? 0).getTime(),
		);

	let consecutiveLosses = 0;
	for (const entry of closed) {
		const profitPercent = safeNumber(entry.profitPercent, 0);
		if (profitPercent < 0) consecutiveLosses += 1;
		else break;
	}

	const dailyLossAmount = closed
		.filter((entry) => kstDateKey(entry.closedAt ?? "") === today)
		.reduce((sum, entry) => {
			const quantity = Math.max(0, safeNumber(entry.quantity, 0));
			const entryPrice = Math.max(0, safeNumber(entry.entryPrice, 0));
			const exitPrice = safeNumber(entry.exitPrice, Number.NaN);
			if (Number.isFinite(exitPrice) && exitPrice < entryPrice) {
				return sum + (entryPrice - exitPrice) * quantity;
			}
			const profitPercent = safeNumber(entry.profitPercent, 0);
			if (profitPercent < 0) {
				return sum + entryPrice * quantity * (Math.abs(profitPercent) / 100);
			}
			return sum;
		}, 0);
	const accountValue = Math.max(1, safeNumber(settings.accountValue, 1));
	const dailyLossPercent = (dailyLossAmount / accountValue) * 100;

	let blockedReason: string | null = null;
	if (openPositions >= settings.maxOpenPositions) {
		blockedReason = `동시 보유 한도 ${settings.maxOpenPositions}종목에 도달했습니다.`;
	} else if (dailyOrders >= settings.maxDailyOrders) {
		blockedReason = `오늘 신규주문 한도 ${settings.maxDailyOrders}회에 도달했습니다.`;
	} else if (consecutiveLosses >= settings.maxConsecutiveLosses) {
		blockedReason = `연속손실 ${consecutiveLosses}회로 신규주문이 정지됐습니다.`;
	} else if (dailyLossPercent >= settings.dailyLossLimitPercent) {
		blockedReason = `오늘 확정 손실이 ${settings.dailyLossLimitPercent}% 한도에 도달했습니다.`;
	}

	return {
		allowed: blockedReason == null,
		blockedReason,
		openPositions,
		dailyOrders,
		consecutiveLosses,
		dailyLossAmount,
		dailyLossPercent,
	};
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
		throw new Error("1회 최대 주문금액을 직접 입력해 주세요.");
	}
	if (settings.accountValue <= 0) {
		throw new Error("계좌 평가금액을 직접 입력해 주세요.");
	}
	if (settings.riskPerTradePercent <= 0) {
		throw new Error("1회 허용손실률을 직접 입력해 주세요.");
	}
	if (settings.dailyLossLimitPercent <= 0) {
		throw new Error("일일 최대손실률을 직접 입력해 주세요.");
	}
	if (settings.minProbability <= 0) {
		throw new Error("최소 모델점수를 직접 입력해 주세요.");
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
			message: "실제 주문 기능이 활성화되어 있지 않습니다.",
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

	const journalResponse = await authorizedFetch("/api/stocks/auto-trade/journal");
	const journalPayload = (await journalResponse.json().catch(() => ({}))) as {
		message?: string;
		entries?: AutoTradeSafetyJournalEntry[];
	};
	if (!journalResponse.ok) {
		throw new Error(
			journalPayload.message ||
				`주문 전 안전상태 확인 실패 (HTTP ${journalResponse.status})`,
		);
	}

	const safety = calculateAutoTradeSafetySnapshot(
		Array.isArray(journalPayload.entries) ? journalPayload.entries : [],
		settings,
		targets[0].market,
	);
	if (!safety.allowed) {
		return {
			ok: false,
			message: `신규 주문 정지 · ${safety.blockedReason ?? "안전한도 확인 필요"}`,
			results: [],
		};
	}

	const riskBudget =
		settings.accountValue * (settings.riskPerTradePercent / 100);
	const riskLimitedInvestment =
		riskBudget / (settings.stopLossPercent / 100);
	const effectiveInvestmentPerTrade = Math.max(
		0,
		Math.floor(
			Math.min(settings.investmentPerTrade, riskLimitedInvestment),
		),
	);
	if (effectiveInvestmentPerTrade <= 0) {
		throw new Error("현재 위험 설정으로 주문 가능한 금액이 없습니다.");
	}

	type ApprovalPlan = {
		ok: boolean;
		approvalToken?: string;
		expiresAt?: string;
		message?: string;
		order?: {
			ticker: string;
			name: string;
			market: AutoTradeMarket;
			currency: AutoTradeCurrency;
			quantity: number;
			currentPrice: number;
			estimatedAmount: number;
			stopPrice: number;
			targetPrice: number;
		};
	};

	const planResponse = await authorizedFetch("/api/stocks/auto-trade/plan", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Auto-Trade-Key": settings.executionKey.trim(),
		},
		body: JSON.stringify({
			candidates: targets,
			investmentPerTrade: effectiveInvestmentPerTrade,
			stopLossPercent: settings.stopLossPercent,
			takeProfitPercent: settings.takeProfitPercent,
		}),
	});
	const plan = (await planResponse.json().catch(() => ({}))) as ApprovalPlan;
	if (!planResponse.ok || !plan.approvalToken || !plan.order) {
		throw new Error(
			plan.message || `주문계획 생성 실패 (HTTP ${planResponse.status})`,
		);
	}

	const order = plan.order;
	const preview = calculateAutoTradeRiskPreview(settings, order.currentPrice);
	const expectedLoss =
		order.quantity *
		order.currentPrice *
		(settings.stopLossPercent / 100);
	const number = new Intl.NumberFormat(
		order.currency === "USD" ? "en-US" : "ko-KR",
		{
			maximumFractionDigits: order.currency === "USD" ? 2 : 0,
		},
	);
	const approved = window.confirm(
		[
			"실제 주문을 1회 승인하시겠습니까?",
			"",
			`${order.name} (${order.ticker}) · ${order.market}`,
			`현재가: ${number.format(order.currentPrice)} ${order.currency}`,
			`수량: ${order.quantity}주`,
			`예상금액: ${number.format(order.estimatedAmount)} ${order.currency}`,
			`1회 허용손실금액: ${number.format(preview.riskBudget)} ${order.currency}`,
			`이번 주문 예상손실한도: ${number.format(expectedLoss)} ${order.currency}`,
			`손절가: ${number.format(order.stopPrice)} ${order.currency}`,
			`목표가: ${number.format(order.targetPrice)} ${order.currency}`,
			`안전상태: 보유 ${safety.openPositions}/${settings.maxOpenPositions} · 오늘 주문 ${safety.dailyOrders}/${settings.maxDailyOrders} · 연속손실 ${safety.consecutiveLosses}/${settings.maxConsecutiveLosses}`,
			`오늘 확정 손실: ${number.format(safety.dailyLossAmount)} ${order.currency} (${safety.dailyLossPercent.toFixed(2)}%)`,
			`승인 만료: ${
				plan.expiresAt
					? new Date(plan.expiresAt).toLocaleString("ko-KR")
					: "10분 이내"
			}`,
			"",
			"확인을 누른 경우에만 주문이 전송됩니다.",
		].join("\n"),
	);
	if (!approved) {
		return {
			ok: false,
			message: "주문 승인을 취소했습니다.",
			results: [],
		};
	}

	const response = await authorizedFetch("/api/stocks/auto-trade/execute", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Auto-Trade-Key": settings.executionKey.trim(),
		},
		body: JSON.stringify({ approvalToken: plan.approvalToken }),
	});
	const payload = (await response.json().catch(() => ({}))) as AutoTradeRunResult;
	if (!response.ok) {
		throw new Error(
			payload.message || `자동매매 주문 실패 (HTTP ${response.status})`,
		);
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

	const response = await authorizedFetch("/api/stocks/auto-trade/monitor", {
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


export type AutoTradeExitSignal = {
	ticker: string;
	market: AutoTradeMarket;
	currentPrice?: number;
	stopPrice?: number;
	targetPrice?: number;
	message?: string;
};

export async function closeAutoTradePosition(
	settings: AutoTradeSettings,
	signal: AutoTradeExitSignal,
): Promise<{
	ok: boolean;
	message?: string;
	ticker?: string;
	market?: AutoTradeMarket;
	quantity?: number;
	currentPrice?: number;
	profitPercent?: number;
	reason?: string;
}> {
	if (!settings.enabled || !settings.liveTrading || !settings.executionKey.trim()) {
		return { ok: false, message: '실제 주문 승인모드와 실행키를 먼저 확인해 주세요.' };
	}

	const planResponse = await authorizedFetch('/api/stocks/auto-trade/close-plan', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Auto-Trade-Key': settings.executionKey.trim(),
		},
		body: JSON.stringify({ ticker: signal.ticker, market: signal.market }),
	});
	const plan = (await planResponse.json().catch(() => ({}))) as {
		ok?: boolean;
		message?: string;
		approvalToken?: string;
		expiresAt?: string;
		order?: {
			ticker: string;
			name: string;
			market: AutoTradeMarket;
			currency: AutoTradeCurrency;
			quantity: number;
			currentPrice: number;
			estimatedAmount: number;
			stopPrice: number;
			targetPrice: number;
			reason: string;
		};
	};
	if (!planResponse.ok || !plan.approvalToken || !plan.order) {
		throw new Error(plan.message || `매도계획 생성 실패 (HTTP ${planResponse.status})`);
	}

	const order = plan.order;
	const number = new Intl.NumberFormat(order.currency === 'USD' ? 'en-US' : 'ko-KR', {
		maximumFractionDigits: order.currency === 'USD' ? 2 : 0,
	});
	const approved = window.confirm([
		'실제 매도 주문을 1회 승인하시겠습니까?',
		'',
		`${order.name} (${order.ticker}) · ${order.market}`,
		`사유: ${order.reason}`,
		`현재가: ${number.format(order.currentPrice)} ${order.currency}`,
		`수량: ${order.quantity}주 전량`,
		`예상금액: ${number.format(order.estimatedAmount)} ${order.currency}`,
		`손절가: ${number.format(order.stopPrice)} ${order.currency}`,
		`목표가: ${number.format(order.targetPrice)} ${order.currency}`,
		`승인 만료: ${plan.expiresAt ? new Date(plan.expiresAt).toLocaleString('ko-KR') : '10분 이내'}`,
		'',
		'확인을 누른 경우에만 시장가 매도 주문이 전송됩니다.',
	].join('\n'));
	if (!approved) return { ok: false, message: '매도 승인을 취소했습니다.' };

	const executeResponse = await authorizedFetch('/api/stocks/auto-trade/close-execute', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Auto-Trade-Key': settings.executionKey.trim(),
		},
		body: JSON.stringify({ approvalToken: plan.approvalToken }),
	});
	const result = (await executeResponse.json().catch(() => ({}))) as {
		ok: boolean;
		message?: string;
		ticker?: string;
		market?: AutoTradeMarket;
		quantity?: number;
		currentPrice?: number;
		profitPercent?: number;
		reason?: string;
	};
	if (!executeResponse.ok) {
		throw new Error(result.message || `매도 주문 실패 (HTTP ${executeResponse.status})`);
	}
	return result;
}