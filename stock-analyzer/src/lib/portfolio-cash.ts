// 잔여 현금 설정(portfolio_cash_settings) 공용 로더/타입.
// portfolio.tsx 의 getSupabase()+user.id 패턴을 그대로 사용한다.
// 실주문·출금과 무관한 조회/기록 전용이다.
import { getSupabase } from '@/lib/supabase';

export type CashCurrency = 'KRW' | 'USD' | 'USDT';

export interface CashSetting {
	currency: CashCurrency;
	amount: number;
	min_amount: number;
	source: string;
}

export const CASH_CURRENCIES: CashCurrency[] = ['KRW', 'USD', 'USDT'];

export function emptyCashSetting(currency: CashCurrency): CashSetting {
	return { currency, amount: 0, min_amount: 0, source: 'manual' };
}

/** Supabase 오류가 "테이블 미존재"인지 판별한다(42P01 등). */
export function isMissingCashTableError(cause: unknown): boolean {
	const code =
		cause && typeof cause === 'object' && 'code' in cause
			? String((cause as { code?: unknown }).code ?? '')
			: '';
	if (code === '42P01') return true;
	const raw =
		cause instanceof Error ? cause.message : String(cause ?? '');
	const lower = raw.toLowerCase();
	return (
		lower.includes('portfolio_cash_settings') &&
		(lower.includes('does not exist') ||
			lower.includes('could not find') ||
			lower.includes('schema cache') ||
			lower.includes('relation'))
	);
}

/** 사용자 현금 설정을 조회한다. 테이블 미존재 오류는 상위에서 안내하도록 그대로 throw. */
export async function fetchCashSettings(
	userId: string,
): Promise<CashSetting[]> {
	const supabase = getSupabase();
	const { data, error } = await supabase
		.from('portfolio_cash_settings')
		.select('currency, amount, min_amount, source')
		.eq('user_id', userId);

	if (error) throw error;

	const rows = Array.isArray(data) ? data : [];
	return CASH_CURRENCIES.map((currency) => {
		const found = rows.find(
			(row) => String((row as { currency?: unknown }).currency) === currency,
		) as Record<string, unknown> | undefined;
		if (!found) return emptyCashSetting(currency);
		const amount = Number(found.amount);
		const minAmount = Number(found.min_amount);
		return {
			currency,
			amount: Number.isFinite(amount) ? amount : 0,
			min_amount: Number.isFinite(minAmount) ? minAmount : 0,
			source: String(found.source ?? 'manual'),
		};
	});
}

/** 통화별 '추가 투자 가능 금액 = 현금 - 최소보유' (음수는 0). */
export function investableAmount(setting: CashSetting): number {
	const value = setting.amount - setting.min_amount;
	return value > 0 ? value : 0;
}
