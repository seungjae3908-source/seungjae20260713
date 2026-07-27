// 월 적립식 + AI 배분안 전체 화면. 전부 클라이언트 계산. 주문 실행 버튼 없음.
import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import {
	fetchHoldingsWithQuotes,
	type SimpleHolding,
} from '@/lib/portfolio-holdings';
import { fetchCashSettings, type CashSetting } from '@/lib/portfolio-cash';
import { isMissingCashTableError } from '@/lib/portfolio-cash';
import { useUsdKrwRate, formatKstTime } from '@/lib/portfolio-fx';
import {
	computeMonthlyAccumulation,
	toKrw,
	weightPercent,
} from '@/lib/portfolio-calc';

type AllocMode =
	| 'current'
	| 'underweight'
	| 'manual'
	| 'stable'
	| 'balanced'
	| 'growth';

const ALLOC_LABEL: Record<AllocMode, string> = {
	current: '현재 비중대로',
	underweight: '부족 자산 우선',
	manual: '직접 설정',
	stable: '안정형',
	balanced: '균형형',
	growth: '성장형',
};

const PERIOD_OPTIONS = [3, 6, 12, 24, 36];

function fmtKrw(value: number | null): string {
	if (value == null || !Number.isFinite(value)) return '산출 불가';
	return `${Math.round(value).toLocaleString()}원`;
}

function fmtPct(value: number): string {
	if (!Number.isFinite(value)) return '-';
	return `${value.toFixed(1)}%`;
}

export default function PortfolioPlanPage() {
	const [, navigate] = useLocation();
	const auth = useAuth();
	const fx = useUsdKrwRate();

	const holdingsQuery = useQuery({
		queryKey: ['portfolio-plan-holdings', auth.user?.id ?? 'anon'],
		queryFn: () => fetchHoldingsWithQuotes(auth.user!.id),
		enabled: Boolean(auth.user && auth.configured),
	});
	const cashQuery = useQuery<CashSetting[], Error>({
		queryKey: ['portfolio-plan-cash', auth.user?.id ?? 'anon'],
		queryFn: () => fetchCashSettings(auth.user!.id),
		enabled: Boolean(auth.user && auth.configured),
		retry: false,
	});

	const holdings = useMemo<SimpleHolding[]>(
		() => holdingsQuery.data ?? [],
		[holdingsQuery.data],
	);
	const cashMissing = Boolean(
		cashQuery.error && isMissingCashTableError(cashQuery.error),
	);

	// 월 적립식 입력
	const [monthly, setMonthly] = useState('100');
	const [months, setMonths] = useState(12);
	const [annualRate, setAnnualRate] = useState('7');
	const [allocMode, setAllocMode] = useState<AllocMode>('balanced');

	const accumulation = useMemo(() => {
		const m = Number(monthly || '0') * 10_000;
		const r = Number(annualRate || '0');
		return computeMonthlyAccumulation(m, months, r);
	}, [monthly, months, annualRate]);

	// 자산별 원화 환산 평가금액 (KRW/USD/USDT → KRW)
	const assetBreakdown = useMemo(() => {
		let kr = 0;
		let us = 0;
		let coin = 0;
		let usdMissing = false;
		for (const h of holdings) {
			const price = h.currentPrice ?? h.average_price;
			const rawValue = price * h.quantity;
			if (h.market === 'KR') {
				kr += rawValue;
			} else {
				const krw = toKrw(
					rawValue,
					h.currency === 'KRW' ? 'KRW' : h.currency === 'USDT' ? 'USDT' : 'USD',
					fx.rate,
				);
				if (krw == null) {
					usdMissing = true;
				} else if (h.market === 'COIN') {
					coin += krw;
				} else {
					us += krw;
				}
			}
		}
		const stockUsKrw = us;
		return { kr, us: stockUsKrw, coin, usdMissing };
	}, [holdings, fx.rate]);

	// 현금 원화 환산
	const cashKrw = useMemo(() => {
		const rows = cashQuery.data ?? [];
		let total = 0;
		let missing = false;
		for (const c of rows) {
			const krw = toKrw(c.amount, c.currency, fx.rate);
			if (krw == null) {
				if (c.amount > 0) missing = true;
			} else {
				total += krw;
			}
		}
		return { total, missing };
	}, [cashQuery.data, fx.rate]);

	const stockTotal = assetBreakdown.kr + assetBreakdown.us;
	const totalAssets = stockTotal + assetBreakdown.coin + cashKrw.total;

	const weights = {
		cash: weightPercent(cashKrw.total, totalAssets),
		kr: weightPercent(assetBreakdown.kr, totalAssets),
		us: weightPercent(assetBreakdown.us, totalAssets),
		coin: weightPercent(assetBreakdown.coin, totalAssets),
	};

	// AI 배분안: 잔여 현금 기준 3안 (규칙 기반)
	const aiPlans = useMemo(() => {
		const investableCash = (cashQuery.data ?? []).reduce((sum, c) => {
			const krw = toKrw(Math.max(0, c.amount - c.min_amount), c.currency, fx.rate);
			return sum + (krw ?? 0);
		}, 0);

		type Plan = {
			key: string;
			title: string;
			risk: string;
			keepCashPct: number;
			addExistingPct: number;
			newAssetPct: number;
			targetKr: number;
			targetUs: number;
			targetCoin: number;
			basis: string;
			caution: string;
		};

		const plans: Plan[] = [
			{
				key: 'stable',
				title: '안정형',
				risk: '낮음',
				keepCashPct: 50,
				addExistingPct: 40,
				newAssetPct: 10,
				targetKr: 60,
				targetUs: 35,
				targetCoin: 5,
				basis: `현재 현금 비중 ${fmtPct(weights.cash)}, 코인 비중 ${fmtPct(weights.coin)} 기준. 변동성 축소를 위해 현금 절반을 유지하고 기존 종목 중심으로 보강합니다.`,
				caution: '수익 기회를 일부 포기하는 대신 손실 위험을 줄이는 방식입니다.',
			},
			{
				key: 'balanced',
				title: '균형형',
				risk: '보통',
				keepCashPct: 30,
				addExistingPct: 45,
				newAssetPct: 25,
				targetKr: 45,
				targetUs: 45,
				targetCoin: 10,
				basis: `국내 ${fmtPct(weights.kr)} / 해외 ${fmtPct(weights.us)} 비중을 균형에 가깝게 조정합니다. 현금의 70%를 투자에 배분합니다.`,
				caution: '국내·해외 비중이 한쪽으로 치우친 경우 리밸런싱이 필요합니다.',
			},
			{
				key: 'growth',
				title: '성장형',
				risk: '높음',
				keepCashPct: 10,
				addExistingPct: 40,
				newAssetPct: 50,
				targetKr: 35,
				targetUs: 50,
				targetCoin: 15,
				basis: `현금 비중 ${fmtPct(weights.cash)}을 최소화하고 성장 자산(해외·코인) 비중을 높입니다.`,
				caution: '변동성이 크므로 손실 감내 범위를 반드시 확인하세요.',
			},
		];

		return plans.map((p) => ({
			...p,
			keepAmount: (investableCash * p.keepCashPct) / 100,
			addAmount: (investableCash * p.addExistingPct) / 100,
			newAmount: (investableCash * p.newAssetPct) / 100,
			investableCash,
		}));
	}, [cashQuery.data, fx.rate, weights.cash, weights.coin, weights.kr, weights.us]);

	const loading = holdingsQuery.isLoading;

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
						<h1 className="whitespace-nowrap text-center text-lg font-extrabold">적립식 · AI 배분</h1>
						<p className="text-[11px] font-bold text-muted-foreground">
							가정 기반 시뮬레이션
						</p>
					</div>
					<button
						type="button"
						onClick={() => void holdingsQuery.refetch()}
						aria-label="새로고침"
						className="absolute right-0 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-card-border bg-card"
					>
						<RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
					</button>
				</header>

				<p className="mt-3 text-center text-[10px] font-bold text-muted-foreground">
					적용 환율(USD/KRW) {fx.rate != null ? fx.rate.toLocaleString() : '산출 불가'}{' '}
					· {formatKstTime(fx.updatedAt)} · USDT는 1 USDT≈1 USD로 가정
				</p>

				{!auth.user ? (
					<StateBox className="mt-4">로그인이 필요합니다.</StateBox>
				) : (
					<>
						{/* 월 적립식 */}
						<section className="mt-4 rounded-2xl border border-card-border bg-card p-4 shadow-sm">
							<h2 className="text-center text-sm font-black">월 적립식 시뮬레이션</h2>
							<div className="mt-3 grid grid-cols-2 gap-2">
								<label className="block">
									<span className="text-[10px] font-bold text-muted-foreground">
										월 투자금(만원)
									</span>
									<input
										type="number"
										inputMode="decimal"
										step="any"
										value={monthly}
										onChange={(e) => setMonthly(e.target.value)}
										placeholder="0"
										className="mt-1 h-11 w-full rounded-xl border border-card-border bg-background px-3 text-center text-sm font-bold outline-none focus:border-primary"
									/>
								</label>
								<label className="block">
									<span className="text-[10px] font-bold text-muted-foreground">
										예상 연수익률(%)
									</span>
									<input
										type="number"
										inputMode="decimal"
										step="any"
										value={annualRate}
										onChange={(e) => setAnnualRate(e.target.value)}
										placeholder="7"
										className="mt-1 h-11 w-full rounded-xl border border-card-border bg-background px-3 text-center text-sm font-bold outline-none focus:border-primary"
									/>
								</label>
							</div>
							<div className="mt-3">
								<span className="text-[10px] font-bold text-muted-foreground">기간</span>
								<div className="mt-1 grid grid-cols-5 gap-1">
									{PERIOD_OPTIONS.map((p) => (
										<button
											key={p}
											type="button"
											onClick={() => setMonths(p)}
											className={cn(
												'rounded-lg border px-1 py-2 text-center text-[11px] font-extrabold',
												months === p
													? 'border-primary bg-primary text-primary-foreground'
													: 'border-card-border bg-card text-muted-foreground',
											)}
										>
											{p}개월
										</button>
									))}
								</div>
							</div>
							<label className="mt-3 block">
								<span className="text-[10px] font-bold text-muted-foreground">
									배분 방식
								</span>
								<select
									value={allocMode}
									onChange={(e) => setAllocMode(e.target.value as AllocMode)}
									className="mt-1 h-11 w-full rounded-xl border border-card-border bg-background px-3 text-center text-sm font-bold outline-none focus:border-primary"
								>
									{(Object.keys(ALLOC_LABEL) as AllocMode[]).map((m) => (
										<option key={m} value={m}>
											{ALLOC_LABEL[m]}
										</option>
									))}
								</select>
							</label>

							<div className="mt-3 grid grid-cols-2 gap-2">
								<Row label="누적 원금" value={fmtKrw(accumulation.principal)} />
								<Row label="예상 평가금액" value={fmtKrw(accumulation.value)} />
								<Row label="예상 수익" value={fmtKrw(accumulation.profit)} />
								<Row label="배분 방식" value={ALLOC_LABEL[allocMode]} />
							</div>

							{accumulation.monthly.length > 0 && (
								<div className="mt-3 rounded-xl bg-secondary/60 p-3">
									<p className="text-[10px] font-bold text-muted-foreground">
										월별 변화 요약 (월복리)
									</p>
									<div className="mt-1 space-y-1">
										{[6, 12, months]
											.filter((m, i, arr) => m <= months && arr.indexOf(m) === i)
											.map((m) => (
												<div
													key={m}
													className="flex items-center justify-between text-[11px] font-bold"
												>
													<span>{m}개월 후</span>
													<span>{fmtKrw(accumulation.monthly[m - 1])}</span>
												</div>
											))}
									</div>
								</div>
							)}
							<p className="mt-3 text-[10px] font-bold text-muted-foreground">
								가정 기반 시뮬레이션이며 확정 수익이 아닙니다.
							</p>
						</section>

						{/* 현재 자산 비중 */}
						<section className="mt-4 rounded-2xl border border-card-border bg-card p-4 shadow-sm">
							<h2 className="text-center text-sm font-black">현재 자산 비중</h2>
							<div className="mt-3 grid grid-cols-2 gap-2">
								<Row label="총자산(원화 환산)" value={fmtKrw(totalAssets)} />
								<Row label="현금 비중" value={fmtPct(weights.cash)} />
								<Row label="국내 비중" value={fmtPct(weights.kr)} />
								<Row label="해외 비중" value={fmtPct(weights.us)} />
								<Row label="코인 비중" value={fmtPct(weights.coin)} />
							</div>
							{(assetBreakdown.usdMissing || cashKrw.missing) && (
								<p className="mt-2 text-[10px] font-bold text-destructive">
									환율을 산출하지 못해 일부 통화 환산이 제외되었습니다.
								</p>
							)}
							{cashMissing && (
								<p className="mt-2 text-[10px] font-bold text-muted-foreground">
									현금 설정 테이블이 없어 현금 비중은 0으로 표시됩니다.
								</p>
							)}
						</section>

						{/* AI 배분안 */}
						<section className="mt-4 rounded-2xl border border-card-border bg-card p-4 shadow-sm">
							<h2 className="text-center text-sm font-black">AI 배분안 (잔여 현금 기준)</h2>
							<p className="mt-1 rounded-xl bg-amber-500/10 p-2 text-[10px] font-bold text-amber-600">
								AI는 실제 주문을 실행할 수 없습니다. 아래는 참고용 배분 제안입니다.
							</p>
							<div className="mt-3 space-y-3">
								{aiPlans.map((p) => (
									<div
										key={p.key}
										className="rounded-xl border border-card-border bg-secondary/40 p-3"
									>
										<div className="flex items-center justify-between">
											<h3 className="text-sm font-black">{p.title}</h3>
											<span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-black text-primary">
												위험도 {p.risk}
											</span>
										</div>
										<div className="mt-2 grid grid-cols-3 gap-1 text-center">
											<MiniBox label="현금 유지" value={fmtPct(p.keepCashPct)} />
											<MiniBox label="기존 추가" value={fmtPct(p.addExistingPct)} />
											<MiniBox label="신규 배분" value={fmtPct(p.newAssetPct)} />
										</div>
										<div className="mt-2 grid grid-cols-3 gap-1 text-center">
											<MiniBox label="국내" value={fmtPct(p.targetKr)} />
											<MiniBox label="해외" value={fmtPct(p.targetUs)} />
											<MiniBox label="코인" value={fmtPct(p.targetCoin)} />
										</div>
										{p.investableCash > 0 && (
											<div className="mt-2 grid grid-cols-3 gap-1 text-center">
												<MiniBox label="현금 유지액" value={fmtKrw(p.keepAmount)} />
												<MiniBox label="기존 추가액" value={fmtKrw(p.addAmount)} />
												<MiniBox label="신규 배분액" value={fmtKrw(p.newAmount)} />
											</div>
										)}
										<p className="mt-2 break-keep text-[10px] font-semibold leading-relaxed text-muted-foreground">
											근거: {p.basis}
										</p>
										<p className="mt-1 break-keep text-[10px] font-semibold leading-relaxed text-destructive">
											주의: {p.caution}
										</p>
									</div>
								))}
							</div>
							{(cashQuery.data ?? []).every((c) => c.amount - c.min_amount <= 0) && (
								<p className="mt-3 text-[10px] font-bold text-muted-foreground">
									배분 가능한 잔여 현금이 없어 금액은 표시되지 않습니다. 비중 제안만
									참고하세요.
								</p>
							)}
							<p className="mt-3 text-[10px] font-bold text-muted-foreground">
								위 제안은 실제 보유 비중과 현금 비중 수치에 기반한 규칙 계산이며,
								확정 수익을 보장하지 않습니다.
							</p>
						</section>
					</>
				)}
			</div>
			<BottomNav />
		</div>
	);
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex min-h-[72px] flex-col items-center justify-center rounded-xl bg-secondary/60 p-2.5 text-center">
			<p className="text-[10px] font-bold text-muted-foreground">{label}</p>
			<p className="mt-0.5 break-words text-xs font-black">{value}</p>
		</div>
	);
}

function MiniBox({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex min-h-[64px] flex-col items-center justify-center rounded-lg bg-background p-1.5 text-center">
			<p className="text-[9px] font-bold text-muted-foreground">{label}</p>
			<p className="mt-0.5 text-[11px] font-black">{value}</p>
		</div>
	);
}

function StateBox({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				'rounded-2xl border border-card-border bg-card p-4 text-center text-xs font-bold text-muted-foreground',
				className,
			)}
		>
			{children}
		</div>
	);
}
