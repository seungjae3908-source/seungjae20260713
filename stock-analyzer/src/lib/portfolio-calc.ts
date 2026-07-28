// 포트폴리오 확장 화면 공용 순수 계산 함수 모음.
// 서버·주문 API를 호출하지 않으며 전부 클라이언트에서 계산한다.
// 여기의 함수는 부작용이 없어야 하며, 자체 점검(테스트 가능)을 목적으로 분리한다.

export type CalcMarket = 'KR' | 'US' | 'COIN';

/** 시장에 따라 매수 가능 수량을 계산한다. 국내주식은 정수(floor), 해외주식·코인은 소수 허용. */
export function computeBuyQuantity(
	amount: number,
	buyPrice: number,
	feeRate: number,
	market: CalcMarket,
): number {
	if (!Number.isFinite(amount) || amount <= 0) return 0;
	if (!Number.isFinite(buyPrice) || buyPrice <= 0) return 0;

	const fee = Number.isFinite(feeRate) && feeRate > 0 ? feeRate / 100 : 0;
	const perUnitCost = buyPrice * (1 + fee);
	if (perUnitCost <= 0) return 0;

	const raw = amount / perUnitCost;
	if (!Number.isFinite(raw) || raw <= 0) return 0;

	if (market === 'KR') {
		return Math.floor(raw);
	}
	// 소수 8자리까지 허용
	return Math.floor(raw * 1e8) / 1e8;
}

/** 실제 사용금액(수수료 포함). */
export function computeSpentAmount(
	quantity: number,
	buyPrice: number,
	feeRate: number,
): number {
	if (!Number.isFinite(quantity) || quantity <= 0) return 0;
	if (!Number.isFinite(buyPrice) || buyPrice <= 0) return 0;
	const fee = Number.isFinite(feeRate) && feeRate > 0 ? feeRate / 100 : 0;
	return quantity * buyPrice * (1 + fee);
}

/** 추가 매수 후 변경 평균단가(수수료 미포함 단가 기준). */
export function computeNewAveragePrice(
	oldQuantity: number,
	oldAveragePrice: number,
	addQuantity: number,
	addPrice: number,
): number {
	const totalQty = oldQuantity + addQuantity;
	if (totalQty <= 0) return 0;
	const totalCost = oldQuantity * oldAveragePrice + addQuantity * addPrice;
	return totalCost / totalQty;
}

/**
 * 손익분기 가격(수수료 반영).
 * 매수 시 수수료를 지불하므로 평균단가 * (1 + feeRate)를 손익분기로 본다.
 * 매도 수수료까지 고려하려면 (1+fee) 두 번 곱하지만, 여기서는 매수 기준 단순 반영.
 */
export function computeBreakEvenPrice(
	averagePrice: number,
	feeRate: number,
): number {
	if (!Number.isFinite(averagePrice) || averagePrice <= 0) return 0;
	const fee = Number.isFinite(feeRate) && feeRate > 0 ? feeRate / 100 : 0;
	return averagePrice * (1 + fee);
}

/** 목표가 도달 시 예상 손익(수량 * (목표가 - 평균단가)). */
export function computeProfitAt(
	targetPrice: number,
	averagePrice: number,
	quantity: number,
): number {
	if (!Number.isFinite(targetPrice) || !Number.isFinite(averagePrice)) return 0;
	if (!Number.isFinite(quantity) || quantity <= 0) return 0;
	return (targetPrice - averagePrice) * quantity;
}

/** 수익률(%) = (도달가 - 평균단가) / 평균단가 * 100. */
export function computeReturnRate(
	targetPrice: number,
	averagePrice: number,
): number {
	if (!Number.isFinite(averagePrice) || averagePrice <= 0) return 0;
	if (!Number.isFinite(targetPrice)) return 0;
	return ((targetPrice - averagePrice) / averagePrice) * 100;
}

/** 단일 종목 집중투자 위험도 (비중 %). */
export type RiskLevel = '낮음' | '보통' | '높음';

export function concentrationRisk(weightPercent: number): RiskLevel {
	if (!Number.isFinite(weightPercent) || weightPercent <= 0) return '낮음';
	if (weightPercent >= 40) return '높음';
	if (weightPercent >= 20) return '보통';
	return '낮음';
}

/** 비중(%) = part / total * 100. total<=0이면 0. */
export function weightPercent(part: number, total: number): number {
	if (!Number.isFinite(total) || total <= 0) return 0;
	if (!Number.isFinite(part)) return 0;
	return (part / total) * 100;
}

/** 월복리 적립식 예상 평가금액. monthlyReturn = 연수익률/12/100. */
export function computeMonthlyAccumulation(
	monthlyAmount: number,
	months: number,
	annualRatePercent: number,
): { principal: number; value: number; profit: number; monthly: number[] } {
	const monthly: number[] = [];
	if (
		!Number.isFinite(monthlyAmount) ||
		monthlyAmount <= 0 ||
		!Number.isFinite(months) ||
		months <= 0
	) {
		return { principal: 0, value: 0, profit: 0, monthly };
	}
	const r =
		Number.isFinite(annualRatePercent) && annualRatePercent !== 0
			? annualRatePercent / 100 / 12
			: 0;
	let value = 0;
	for (let m = 0; m < months; m += 1) {
		// 매월 초 납입 후 한 달간 수익 반영
		value = (value + monthlyAmount) * (1 + r);
		monthly.push(value);
	}
	const principal = monthlyAmount * months;
	return { principal, value, profit: value - principal, monthly };
}

/** 통화 합산: 개별 통화 금액을 KRW 기준으로 환산한다. usdt는 usd와 동일 취급. */
export function toKrw(
	amount: number,
	currency: 'KRW' | 'USD' | 'USDT',
	fxKrwPerUsd: number | null,
): number | null {
	if (!Number.isFinite(amount)) return null;
	if (currency === 'KRW') return amount;
	if (fxKrwPerUsd == null || !Number.isFinite(fxKrwPerUsd) || fxKrwPerUsd <= 0) {
		return null;
	}
	return amount * fxKrwPerUsd;
}
