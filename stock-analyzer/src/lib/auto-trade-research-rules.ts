// Pure research classification; never an execution or probability authority.
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const safeNumber = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

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
	probability: null;
	ruleScore: number | null;
	ruleMethod: 'AUTO_RESEARCH_RULES_V2';
	riskScore: number | null;
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
	const change = safeNumber(input.changePercent, Number.NaN);
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
		(value) => typeof value === 'number' && Number.isFinite(value),
	).length;
	const dataCompleteness = clamp(
		Math.round((availableOptional / optionalValues.length) * 100),
		0,
		100,
	);

	const complete = availableOptional === optionalValues.length
		&& Number.isFinite(input.score) && input.score >= 0 && input.score <= 100
		&& Number.isFinite(change) && typeof input.price === 'number' && input.price > 0 && Number.isFinite(input.price)
		&& Number.isInteger(input.selectedCount) && input.selectedCount > 0
		&& Number.isInteger(input.matchedCount) && input.matchedCount >= 0 && input.matchedCount <= input.selectedCount
		&& [input.volume, input.tradingValue, input.marketCap].every((value) => typeof value === 'number' && value >= 0)
		&& [input.confidence, input.newsScore, input.disclosureScore, input.financialScore].every((value) => typeof value === 'number' && value >= 0 && value <= 100)
		&& ['LOW', 'MEDIUM', 'HIGH'].includes(String(input.riskLevel));
	if (!complete) return {
		probability: null, ruleScore: null, ruleMethod: 'AUTO_RESEARCH_RULES_V2',
		riskScore: null, dataCompleteness, factors: ['후보 비교에 필요한 근거 부족', '검증된 수익·돌파 확률 없음'],
	};

	let riskScore = 14;
	const absoluteChange = Math.abs(change);
	if (absoluteChange > 5) riskScore += Math.min(24, (absoluteChange - 5) * 1.8);
	if (change < -3) riskScore += Math.min(12, Math.abs(change));
	const riskLevel = String(input.riskLevel ?? "").toUpperCase();
	if (riskLevel.includes("HIGH") || riskLevel.includes("위험")) riskScore += 28;
	else if (riskLevel === 'MEDIUM' || riskLevel.includes("CAUTION") || riskLevel.includes("주의")) riskScore += 14;
	if (input.isLeveraged) riskScore += 28;
	if (input.isInverse) riskScore += 35;
	if (input.isDerivative) riskScore += 24;
	if (dataCompleteness < 60) riskScore += (60 - dataCompleteness) * 0.35;
	riskScore = clamp(Math.round(riskScore), 0, 100);

	const confidence = clamp(safeNumber(input.confidence, Number.NaN), 0, 100);
	const contextScores = [input.newsScore, input.disclosureScore, input.financialScore]
		.map((value) => safeNumber(value, Number.NaN))
		.filter(Number.isFinite);
	const context = contextScores.length
		? contextScores.reduce((sum, value) => sum + value, 0) / contextScores.length
		: Number.NaN;
	const trendBonus = change > 0 ? Math.min(5, change * 0.8) : Math.max(-7, change);
	const technical =
		clamp(input.score, 0, 100) * 0.65 +
		matchRatio * 35;
	const ruleScore = clamp(
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

	return { probability: null, ruleScore, ruleMethod: 'AUTO_RESEARCH_RULES_V2', riskScore, dataCompleteness, factors };
}

export function estimateAutoTradeProbability(input: AutoTradeAssessmentInput) {
	return assessAutoTradeCandidate(input).probability;
}

