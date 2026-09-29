export type StockClassLabel = '우량주' | '보통주' | '저평가주' | '잡주';
export type StockClassificationMissingEvidence = 'score' | 'debt' | 'financial' | 'risk';

/**
 * Legacy UI consumers type classification labels as the four evaluated classes.
 * Missing evidence is carried authoritatively by evidenceState/score and rendered
 * with this runtime sentinel instead of fabricating one of those four classes.
 */
const MISSING_CLASSIFICATION_LABEL = '분류 확인 필요' as StockClassLabel;

export interface StockClassifierInput {
	ticker?: string;
	name?: string;
	score?: number | null;
	aiScore?: number | null;
	rating?: { score?: number | null } | null;
	changePercent?: number | null;
	marketCap?: number | null;
	per?: number | null;
	pbr?: number | null;
	roe?: number | null;
	debtRatio?: number | null;
	revenueGrowth?: number | null;
	operatingIncome?: number | null;
	netIncome?: number | null;
	equity?: number | null;
	debt?: number | null;
	currency?: string | null;
	market?: string | null;
	reasons?: string[] | null;
	risks?: string[] | null;
	signals?: string[] | null;
	news?: string[] | null;
	disclosures?: string[] | null;
	riskFactors?: { label?: string; detail?: string; level?: string }[] | null;
	financials?: unknown;
	/** Explicit upstream proof that risk review completed, including a valid empty result. */
	riskEvidenceComplete?: boolean | null;
}

export interface StockClassification {
	label: StockClassLabel;
	score: number | null;
	evidenceState: 'EVALUABLE' | 'MISSING_EVIDENCE';
	missingEvidence: StockClassificationMissingEvidence[];
	reason: string;
	reasons: string[];
	riskCaption: string;
	marketCapGrade: '초대형' | '대형' | '중형' | '소형' | '초소형' | '시총확인필요';
	/** True when serious delisting-warning keywords were detected in the inputs. */
	delistingWarning: boolean;
}

// Compact grade payload type shared with the API (list/search rows).
export type { StockGrade } from '@workspace/stock-grade';

function num(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;

	if (typeof value === 'string') {
		const normalized = value.replace(/,/g, '').replace(/%/g, '').trim();
		if (!normalized) return null;

		const parsed = Number(normalized);
		if (Number.isFinite(parsed)) return parsed;
	}

	return null;
}

function clamp(value: number) {
	return Math.max(0, Math.min(100, Math.round(value)));
}

function flattenText(input: StockClassifierInput): string {
	const parts: string[] = [];

	const push = (value: unknown) => {
		if (typeof value === 'string') {
			parts.push(value);
			return;
		}

		if (Array.isArray(value)) {
			value.forEach(push);
			return;
		}

		if (value && typeof value === 'object') {
			Object.values(value).forEach(push);
		}
	};

	push(input.name);
	push(input.reasons);
	push(input.risks);
	push(input.signals);
	push(input.news);
	push(input.disclosures);
	push(input.riskFactors);

	return parts.join(' ').toLowerCase();
}

function removeNegatedRiskText(text: string) {
	return text
		.replace(/상장폐지\s*(위험|리스크)?\s*(없음|낮음|해당\s*없음|미해당|아님)/g, '')
		.replace(/delisting\s*(risk)?\s*(none|low|no)/g, '')
		.replace(/희석\s*(위험|리스크)?\s*(없음|낮음|해당\s*없음|미해당|아님)/g, '')
		.replace(/atm\s*(없음|해당\s*없음|미해당)/g, '')
		.replace(/offering\s*(none|no)/g, '');
}

function getMarketCapGrade(
	marketCap: number | null,
	currency?: string | null,
): StockClassification['marketCapGrade'] {
	if (marketCap == null || !Number.isFinite(marketCap) || marketCap <= 0) {
		return '시총확인필요';
	}

	if (currency === 'USD') {
		if (marketCap >= 200_000_000_000) return '초대형';
		if (marketCap >= 10_000_000_000) return '대형';
		if (marketCap >= 2_000_000_000) return '중형';
		if (marketCap >= 300_000_000) return '소형';
		return '초소형';
	}

	if (currency !== 'KRW') {
		return '시총확인필요';
	}

	if (marketCap >= 50_0000_0000_0000) return '초대형';
	if (marketCap >= 5_0000_0000_0000) return '대형';
	if (marketCap >= 1_0000_0000_0000) return '중형';
	if (marketCap >= 1000_0000_0000) return '소형';

	return '초소형';
}

function countMatches(text: string, words: string[]) {
	return words.reduce((count, word) => {
		if (text.includes(word.toLowerCase())) return count + 1;

		return count;
	}, 0);
}

function hasSubstantiveEvidence(value: unknown): boolean {
	if (typeof value === 'string') return value.trim().length > 0;
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value === 'boolean') return true;
	if (Array.isArray(value)) return value.some(hasSubstantiveEvidence);
	if (value && typeof value === 'object') {
		return Object.values(value).some(hasSubstantiveEvidence);
	}
	return false;
}

function hasRiskEvidence(input: StockClassifierInput): boolean {
	return input.riskEvidenceComplete === true ||
		hasSubstantiveEvidence(input.risks) ||
		hasSubstantiveEvidence(input.riskFactors);
}

function buildRiskCaption(
	text: string,
	label: StockClassLabel,
	seriousDelisting: boolean,
	dilutionScore: number,
) {
	if (label === '우량주') return '리스크 별도 확인';
	if (label === '보통주') return '일반 위험';
	if (label === '저평가주') return '재무 확인';

	if (seriousDelisting) return '상장폐지 주의';
	if (dilutionScore >= 2) return '희석 주의';
	if (dilutionScore >= 1) return '희석 가능성';

	if (text.includes('거래정지') || text.includes('관리종목')) {
		return '상장 리스크 주의';
	}

	return '고위험 유의';
}

export function classifyStock(input: StockClassifierInput): StockClassification {
	const rawText = flattenText(input);
	const text = removeNegatedRiskText(rawText);

	const ai =
		num(input.aiScore) ??
		num(input.score) ??
		num(input.rating?.score);

	const change = num(input.changePercent);
	const marketCap = num(input.marketCap);
	const marketCapGrade = getMarketCapGrade(marketCap, input.currency);

	const per = num(input.per);
	const pbr = num(input.pbr);
	const roe = num(input.roe);
	const debtRatio = num(input.debtRatio);
	const revenueGrowth = num(input.revenueGrowth);
	const operatingIncome = num(input.operatingIncome);
	const netIncome = num(input.netIncome);
	const equity = num(input.equity);
	const debt = num(input.debt);

	const isProtectedLargeCap =
		marketCapGrade === '초대형' || marketCapGrade === '대형';

	const delistingWords = [
		'상장폐지',
		'delisting',
		'거래정지',
		'관리종목',
		'감사의견 거절',
		'going concern',
		'계속기업 불확실',
	];

	const dilutionWords = [
		'유상증자',
		'오퍼링',
		'offering',
		'atm',
		'신주발행',
		'전환사채',
		'rights offering',
	];

	const otherRiskWords = ['reverse split', '역분할', '자본잠식', '감자'];

	const delistingScore = countMatches(text, delistingWords);
	const dilutionScore = countMatches(text, dilutionWords);
	const otherRiskScore = countMatches(text, otherRiskWords);

	const seriousDelisting =
		text.includes('상장폐지 유력') ||
		text.includes('상장폐지 결정') ||
		text.includes('거래정지') ||
		text.includes('관리종목') ||
		text.includes('delisting notice') ||
		text.includes('nasdaq deficiency');

	const hasDebtEvidence =
		debtRatio != null || (debt != null && equity != null);
	const hasFinancialEvidence = [
		per,
		pbr,
		roe,
		revenueGrowth,
		operatingIncome,
		netIncome,
		equity,
	].some((value) => value != null);
	const riskEvidenceAvailable = hasRiskEvidence(input);
	const missingEvidence: StockClassificationMissingEvidence[] = [];
	if (ai == null) missingEvidence.push('score');
	if (!hasDebtEvidence) missingEvidence.push('debt');
	if (!hasFinancialEvidence) missingEvidence.push('financial');
	if (!riskEvidenceAvailable) missingEvidence.push('risk');

	if (missingEvidence.length > 0) {
		const categoryText = missingEvidence
			.map((category) => {
				if (category === 'score') return '점수';
				if (category === 'debt') return '부채';
				if (category === 'financial') return '재무';
				return '리스크';
			})
			.join('·');

		return {
			label: MISSING_CLASSIFICATION_LABEL,
			score: null,
			evidenceState: 'MISSING_EVIDENCE',
			missingEvidence,
			reason: seriousDelisting
				? `${categoryText} 근거가 부족해 종목 등급을 보류하지만 상장 관련 중대 리스크 키워드는 확인됩니다.`
				: `${categoryText} 근거가 부족해 종목 등급을 확정할 수 없습니다.`,
			reasons: seriousDelisting
				? ['상장 관련 중대 리스크 키워드가 확인됩니다.', '누락된 분류 근거를 확보한 뒤 다시 평가해야 합니다.']
				: ['누락된 점수·부채·재무·리스크 근거를 확보한 뒤 분류해야 합니다.'],
			riskCaption: seriousDelisting ? '상장 리스크 주의' : '리스크 확인 필요',
			marketCapGrade,
			delistingWarning: seriousDelisting,
		};
	}

	const evaluatedAi = ai as number;
	const reasons: string[] = [];
	let score = evaluatedAi;

	if (marketCapGrade === '초대형') {
		score += 22;
		reasons.push('확인된 시가총액이 초대형 기준입니다.');
	} else if (marketCapGrade === '대형') {
		score += 16;
		reasons.push('확인된 시가총액이 대형 기준입니다.');
	} else if (marketCapGrade === '중형') {
		score += 5;
		reasons.push('확인된 시가총액이 중형 기준입니다.');
	} else if (marketCapGrade === '소형') {
		score -= 6;
		reasons.push('확인된 시가총액이 소형 기준이라 변동성 확인이 필요합니다.');
	} else if (marketCapGrade === '초소형') {
		score -= 18;
		reasons.push('확인된 시가총액이 초소형 기준이라 급등락과 희석 리스크 확인이 필요합니다.');
	}

	if (equity != null && equity <= 0) {
		score -= isProtectedLargeCap ? 12 : 30;
		reasons.push('자본잠식 또는 음의 자본 가능성이 있습니다.');
	}

	if (debtRatio != null && debtRatio > 250) {
		score -= isProtectedLargeCap ? 8 : 18;
		reasons.push('부채비율이 높아 재무 부담이 있습니다.');
	} else if (debtRatio != null && debtRatio <= 100) {
		score += 8;
		reasons.push('확인된 부채비율이 비교적 낮습니다.');
	}

	if (debt != null && equity != null && equity > 0 && debt / equity > 2.5) {
		score -= isProtectedLargeCap ? 5 : 12;
		reasons.push('자본 대비 부채가 많은 편입니다.');
	}

	if (operatingIncome != null && operatingIncome > 0) {
		score += 7;
		reasons.push('영업이익이 흑자입니다.');
	}

	if (netIncome != null && netIncome > 0) {
		score += 7;
		reasons.push('순이익이 흑자입니다.');
	}

	if (revenueGrowth != null && revenueGrowth > 0) {
		score += 7;
		reasons.push('매출 증가 흐름이 확인됩니다.');
	}

	if (roe != null && roe >= 8) {
		score += 7;
		reasons.push('ROE가 양호합니다.');
	}

	if (seriousDelisting) {
		score -= isProtectedLargeCap ? 12 : 35;
		reasons.push('상장 관련 중대 리스크 키워드가 확인됩니다.');
	} else if (delistingScore > 0 && !isProtectedLargeCap) {
		score -= Math.min(20, 8 + delistingScore * 4);
		reasons.push('상장 관련 리스크 키워드가 확인됩니다.');
	}

	if (dilutionScore > 0) {
		score -= isProtectedLargeCap
			? Math.min(10, dilutionScore * 3)
			: Math.min(28, 8 + dilutionScore * 5);
		reasons.push('희석 리스크 키워드가 확인됩니다.');
	}

	if (otherRiskScore > 0) {
		score -= isProtectedLargeCap
			? Math.min(8, otherRiskScore * 3)
			: Math.min(20, 8 + otherRiskScore * 5);
		reasons.push('기타 고위험 키워드가 확인됩니다.');
	}

	if (change != null && Math.abs(change) >= 15) {
		score -= 10;
		reasons.push('단기 급등락 변동성이 큽니다.');
	}

	const finalScore = clamp(score);

	const undervalued =
		(pbr != null && pbr > 0 && pbr <= 1.2) ||
		(per != null && per > 0 && per <= 12);

	const trueJunk =
		!isProtectedLargeCap &&
		((evaluatedAi < 42 && marketCapGrade === '초소형') ||
			seriousDelisting ||
			dilutionScore >= 2 ||
			otherRiskScore >= 2 ||
			(equity != null && equity <= 0) ||
			finalScore < 40);

	const bluechip =
		!trueJunk &&
		isProtectedLargeCap &&
		!seriousDelisting &&
		debtRatio != null &&
		debtRatio <= 250 &&
		riskEvidenceAvailable;

	let label: StockClassLabel;
	let reason: string;

	if (trueJunk) {
		label = '잡주';
		reason =
			reasons[0] ??
			'확인된 시총, 재무, 공시 리스크 기준으로 고위험 종목에 가깝습니다.';
	} else if (bluechip) {
		label = '우량주';
		reason = '확인된 시가총액·부채·재무·리스크 근거를 기준으로 우량주로 분류했습니다.';
	} else if (undervalued && finalScore >= 45) {
		label = '저평가주';

		reason =
			pbr != null && pbr > 0 && pbr <= 1.2
				? `PBR ${pbr.toFixed(2)}배 기준으로 저평가 가능성이 있습니다.`
				: `PER ${per?.toFixed(1)}배 기준으로 저평가 가능성이 있습니다.`;
	} else {
		label = '보통주';
		reason =
			'현재 확인된 점수와 시총·부채·재무·리스크 근거 기준으로 우량/저평가/고위험에 강하게 치우치지 않습니다.';
	}

	const riskCaption = buildRiskCaption(
		text,
		label,
		seriousDelisting,
		dilutionScore,
	);

	return {
		label,
		score:
			label === '잡주'
				? Math.min(finalScore, 44)
				: label === '우량주'
					? Math.max(finalScore, 70)
					: finalScore,
		evidenceState: 'EVALUABLE',
		missingEvidence: [],
		reason,
		reasons: reasons.length
			? reasons.slice(0, 6)
			: ['추가 재무·공시·차트 확인이 필요합니다.'],
		riskCaption,
		marketCapGrade,
		delistingWarning: seriousDelisting,
	};
}

export function stockClassBadgeClass(
	label: StockClassLabel | null | undefined,
): string {
	if (label === '우량주') {
		return 'border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400';
	}

	if (label === '보통주') {
		return 'border-neutral-950 bg-neutral-950 text-white';
	}

	if (label === '저평가주') {
		return 'border-yellow-500/50 bg-yellow-400/20 text-yellow-700 dark:text-yellow-300';
	}

	if (label === '잡주') {
		return 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400';
	}

	return 'border-card-border bg-secondary/70 text-muted-foreground';
}
