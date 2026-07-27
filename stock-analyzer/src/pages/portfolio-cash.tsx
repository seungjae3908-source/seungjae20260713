// 잔여 현금 관리 전체 화면.
// - 통화별(KRW/USD/USDT) 현금·최소보유 직접 입력 → portfolio_cash_settings upsert
// - 계좌 잔액 '조회 전용' (GET /api/portfolio/balances) — 주문·출금 권한 없음
// 실주문/출금 API는 절대 호출하지 않는다.
import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw, Wallet } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getSupabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import {
	CASH_CURRENCIES,
	fetchCashSettings,
	investableAmount,
	isMissingCashTableError,
	type CashCurrency,
	type CashSetting,
} from '@/lib/portfolio-cash';
import { formatKstTime } from '@/lib/portfolio-fx';

interface BalancesResponse {
	ok?: boolean;
	dataAsOf?: string;
	fxKrwPerUsd?: number;
	// available은 거래소에 따라 boolean(권한/상태 플래그)로 올 수 있으므로
	// 숫자 폴백에 사용하지 않고 표시 여부 판단에만 참고한다.
	kiwoom?: {
		available?: number | boolean;
		deposit?: number;
		orderable?: number;
		error?: string;
	};
	bitgetSpot?: {
		available?: number | boolean;
		totalUsdt?: number;
		assets?: Array<Record<string, unknown>>;
		error?: string;
	};
	bitgetFutures?: {
		available?: number | boolean;
		availableUsdt?: number;
		equityUsdt?: number;
		error?: string;
	};
	error?: string;
}

/** 숫자 후보들 중 첫 번째 유한 숫자를 반환한다(부분 응답·boolean 필드 안전). */
function pickNumber(...values: Array<number | boolean | undefined | null>): number | undefined {
	for (const value of values) {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
	}
	return undefined;
}

const CURRENCY_LABEL: Record<CashCurrency, string> = {
	KRW: '원화 (KRW)',
	USD: '미국 달러 (USD)',
	USDT: '테더 (USDT)',
};

function fmt(value: number, currency: CashCurrency): string {
	if (!Number.isFinite(value)) return '-';
	if (currency === 'KRW') return `${Math.round(value).toLocaleString()}원`;
	const num = value.toLocaleString(undefined, {
		minimumFractionDigits: 0,
		maximumFractionDigits: 2,
	});
	return currency === 'USD' ? `$${num}` : `${num} USDT`;
}

export default function PortfolioCashPage() {
	const [, navigate] = useLocation();
	const auth = useAuth();

	const [settings, setSettings] = useState<Record<CashCurrency, CashSetting>>({
		KRW: { currency: 'KRW', amount: 0, min_amount: 0, source: 'manual' },
		USD: { currency: 'USD', amount: 0, min_amount: 0, source: 'manual' },
		USDT: { currency: 'USDT', amount: 0, min_amount: 0, source: 'manual' },
	});
	const [inputs, setInputs] = useState<
		Record<CashCurrency, { amount: string; min: string }>
	>({
		KRW: { amount: '', min: '' },
		USD: { amount: '', min: '' },
		USDT: { amount: '', min: '' },
	});
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState<CashCurrency | null>(null);
	const [error, setError] = useState('');
	const [tableMissing, setTableMissing] = useState(false);
	const [notice, setNotice] = useState('');

	const load = useCallback(async () => {
		if (auth.loading) return;
		if (!auth.configured || !auth.user) {
			setLoading(false);
			return;
		}
		setLoading(true);
		setError('');
		setTableMissing(false);
		try {
			const rows = await fetchCashSettings(auth.user.id);
			const next = {} as Record<CashCurrency, CashSetting>;
			const nextInputs = {} as Record<CashCurrency, { amount: string; min: string }>;
			for (const row of rows) {
				next[row.currency] = row;
				nextInputs[row.currency] = {
					amount: row.amount > 0 ? String(row.amount) : '',
					min: row.min_amount > 0 ? String(row.min_amount) : '',
				};
			}
			setSettings(next);
			setInputs(nextInputs);
		} catch (cause) {
			if (isMissingCashTableError(cause)) {
				setTableMissing(true);
			} else {
				console.error('cash settings load error:', cause);
				setError('데이터를 불러오지 못했습니다.');
			}
		} finally {
			setLoading(false);
		}
	}, [auth.configured, auth.loading, auth.user]);

	useEffect(() => {
		void load();
	}, [load]);

	const balances = useQuery({
		queryKey: ['portfolio-balances', auth.user?.id ?? 'anon'],
		queryFn: () => apiGet<BalancesResponse>('/portfolio/balances'),
		enabled: false, // 사용자가 직접 버튼을 눌러야 조회 (조회 전용)
		retry: false,
	});

	async function saveCurrency(currency: CashCurrency) {
		if (!auth.user || saving) return;
		const amount = Number(inputs[currency].amount || '0');
		const min = Number(inputs[currency].min || '0');
		if (!Number.isFinite(amount) || amount < 0) {
			setError('보유 현금은 0 이상으로 입력해 주세요.');
			return;
		}
		if (!Number.isFinite(min) || min < 0) {
			setError('최소 보유 현금은 0 이상으로 입력해 주세요.');
			return;
		}
		setSaving(currency);
		setError('');
		setNotice('');
		try {
			const supabase = getSupabase();
			const { error: upsertError } = await supabase
				.from('portfolio_cash_settings')
				.upsert(
					{
						user_id: auth.user.id,
						currency,
						amount,
						min_amount: min,
						source: 'manual',
						updated_at: new Date().toISOString(),
					},
					{ onConflict: 'user_id,currency' },
				);
			if (upsertError) throw upsertError;
			setSettings((prev) => ({
				...prev,
				[currency]: { currency, amount, min_amount: min, source: 'manual' },
			}));
			setNotice(`${CURRENCY_LABEL[currency]} 저장 완료`);
		} catch (cause) {
			if (isMissingCashTableError(cause)) {
				setTableMissing(true);
			} else {
				console.error('cash settings save error:', cause);
				setError('저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
			}
		} finally {
			setSaving(null);
		}
	}

	function applyBalanceToInput(currency: CashCurrency, value: number | undefined) {
		if (value == null || !Number.isFinite(value)) return;
		setInputs((prev) => ({
			...prev,
			[currency]: { ...prev[currency], amount: String(value) },
		}));
		setNotice(
			`${CURRENCY_LABEL[currency]} 입력값에 조회 잔액을 반영했습니다. 저장 버튼을 눌러 확정하세요.`,
		);
	}

	const bal = balances.data;

	return (
		<div className="h-full overflow-y-auto overscroll-contain bg-background">
			<div className="mx-auto max-w-md px-4 pb-28 pt-4">
				<header className="relative flex min-h-[58px] items-center justify-center px-12 text-center">
					<button
						type="button"
						onClick={() => navigate('/portfolio')}
						aria-label="뒤로"
						className="absolute left-0 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-card-border bg-card"
					>
						<ArrowLeft className="h-4 w-4" />
					</button>
					<div className="min-w-0 text-center">
						<h1 className="whitespace-nowrap text-center text-lg font-extrabold">잔여 현금 관리</h1>
						<p className="text-[11px] font-bold text-muted-foreground">
							통화별 현금·최소보유 설정
						</p>
					</div>
					<button
						type="button"
						onClick={() => void load()}
						aria-label="새로고침"
						className="absolute right-0 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-card-border bg-card"
					>
						<RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
					</button>
				</header>

				{!auth.user && !auth.loading && (
					<StateBox className="mt-4">로그인이 필요합니다.</StateBox>
				)}

				{tableMissing && (
					<StateBox error className="mt-4">
						관리자가 데이터베이스 마이그레이션을 실행해야 합니다.
						<br />
						(portfolio_cash_settings 테이블 미존재)
					</StateBox>
				)}

				{error && (
					<StateBox error className="mt-4">
						{error}
					</StateBox>
				)}

				{notice && (
					<div className="mt-4 rounded-2xl border border-primary/30 bg-primary/10 p-3 text-center text-xs font-bold text-primary">
						{notice}
					</div>
				)}

				{auth.user && (
					<>
						<section className="mt-4 space-y-3">
							{CASH_CURRENCIES.map((currency) => {
								const setting = settings[currency];
								const invest = investableAmount({
									currency,
									amount: Number(inputs[currency].amount || '0'),
									min_amount: Number(inputs[currency].min || '0'),
									source: 'manual',
								});
								return (
									<div
										key={currency}
										className="rounded-2xl border border-card-border bg-card p-4 shadow-sm"
									>
										<div className="flex items-center gap-2">
											<Wallet className="h-4 w-4 text-primary" />
											<h2 className="text-sm font-black">{CURRENCY_LABEL[currency]}</h2>
										</div>
										<div className="mt-3 grid grid-cols-2 gap-2">
											<label className="block">
												<span className="text-[10px] font-bold text-muted-foreground">
													보유 현금
												</span>
												<input
													type="number"
													inputMode="decimal"
													step="any"
													min="0"
													value={inputs[currency].amount}
													onChange={(e) =>
														setInputs((prev) => ({
															...prev,
															[currency]: {
																...prev[currency],
																amount: e.target.value,
															},
														}))
													}
													placeholder="0"
													className="mt-1 h-11 w-full rounded-xl border border-card-border bg-background px-3 text-sm font-bold outline-none focus:border-primary"
												/>
											</label>
											<label className="block">
												<span className="text-[10px] font-bold text-muted-foreground">
													최소 보유 현금
												</span>
												<input
													type="number"
													inputMode="decimal"
													step="any"
													min="0"
													value={inputs[currency].min}
													onChange={(e) =>
														setInputs((prev) => ({
															...prev,
															[currency]: {
																...prev[currency],
																min: e.target.value,
															},
														}))
													}
													placeholder="0"
													className="mt-1 h-11 w-full rounded-xl border border-card-border bg-background px-3 text-sm font-bold outline-none focus:border-primary"
												/>
											</label>
										</div>
										<div className="mt-3 rounded-xl bg-muted/60 p-3">
											<p className="text-[10px] font-bold text-muted-foreground">
												추가 투자 가능 금액 = 보유 현금 − 최소 보유
											</p>
											<p className="mt-1 text-sm font-black">
												{fmt(invest, currency)}
											</p>
											<p className="mt-1 text-[10px] font-semibold text-muted-foreground">
												예) 보유 100만 원, 최소 30만 원 → 추가 투자 가능 70만 원
											</p>
										</div>
										<div className="mt-2 flex items-center justify-between gap-2">
											<span className="text-[10px] font-bold text-muted-foreground">
												저장됨: {fmt(setting.amount, currency)}
											</span>
											<button
												type="button"
												onClick={() => void saveCurrency(currency)}
												disabled={saving === currency || tableMissing}
												className="rounded-xl bg-primary px-4 py-2 text-xs font-black text-primary-foreground disabled:opacity-50"
											>
												{saving === currency ? '저장 중...' : '저장'}
											</button>
										</div>
									</div>
								);
							})}
						</section>

						<section className="mt-5 rounded-2xl border border-card-border bg-card p-4 shadow-sm">
							<div className="flex items-center justify-between gap-2">
								<h2 className="text-sm font-black">계좌 잔액 조회</h2>
								<button
									type="button"
									onClick={() => void balances.refetch()}
									disabled={balances.isFetching}
									className="rounded-xl border border-card-border px-3 py-2 text-xs font-black disabled:opacity-50"
								>
									{balances.isFetching ? '조회 중...' : '잔액 조회'}
								</button>
							</div>
							<p className="mt-2 rounded-xl bg-amber-500/10 p-2 text-[10px] font-bold leading-relaxed text-amber-600">
								조회 전용입니다. 주문·출금 권한은 사용하지 않으며, 조회한 잔액은
								사용자가 확인 후 입력값에 반영할 수 있습니다.
							</p>

							{balances.isError && (
								<StateBox error className="mt-3">
									잔액을 불러오지 못했습니다. (조회 API 미제공 또는 연결 오류)
								</StateBox>
							)}

							{bal && (
								<div className="mt-3 space-y-2">
									<p className="text-[10px] font-bold text-muted-foreground">
										데이터 기준 {formatKstTime(bal.dataAsOf)}
									</p>
									<BalanceRow
										title="키움 (원화)"
										error={bal.kiwoom?.error}
										value={pickNumber(
											bal.kiwoom?.orderable,
											bal.kiwoom?.deposit,
										)}
										currency="KRW"
										onApply={(v) => applyBalanceToInput('KRW', v)}
									/>
									<BalanceRow
										title="비트겟 현물 (USDT)"
										error={bal.bitgetSpot?.error}
										value={pickNumber(bal.bitgetSpot?.totalUsdt)}
										currency="USDT"
										onApply={(v) => applyBalanceToInput('USDT', v)}
									/>
									<BalanceRow
										title="비트겟 선물 (USDT)"
										error={bal.bitgetFutures?.error}
										value={pickNumber(
											bal.bitgetFutures?.availableUsdt,
											bal.bitgetFutures?.equityUsdt,
										)}
										currency="USDT"
										onApply={(v) => applyBalanceToInput('USDT', v)}
									/>
								</div>
							)}
						</section>
					</>
				)}
			</div>
			<BottomNav />
		</div>
	);
}

function BalanceRow({
	title,
	value,
	currency,
	error,
	onApply,
}: {
	title: string;
	value: number | undefined;
	currency: CashCurrency;
	error?: string;
	onApply: (value: number | undefined) => void;
}) {
	const hasValue = value != null && Number.isFinite(value);
	return (
		<div className="flex items-center justify-between gap-2 rounded-xl bg-secondary/60 p-3">
			<div className="min-w-0">
				<p className="text-[11px] font-bold">{title}</p>
				<p
					className={cn(
						'mt-0.5 text-sm font-black',
						!hasValue && 'text-muted-foreground',
					)}
				>
					{error ? `조회 실패: ${error}` : hasValue ? fmt(value as number, currency) : '데이터 없음'}
				</p>
			</div>
			<button
				type="button"
				disabled={!hasValue}
				onClick={() => onApply(value)}
				className="shrink-0 rounded-lg border border-card-border px-2 py-1.5 text-[10px] font-black disabled:opacity-40"
			>
				입력에 반영
			</button>
		</div>
	);
}

function StateBox({
	children,
	error,
	className,
}: {
	children: React.ReactNode;
	error?: boolean;
	className?: string;
}) {
	return (
		<div
			className={cn(
				'rounded-2xl border p-4 text-center text-xs font-bold',
				error
					? 'border-destructive/40 bg-destructive/10 text-destructive'
					: 'border-card-border bg-card text-muted-foreground',
				className,
			)}
		>
			{children}
		</div>
	);
}
