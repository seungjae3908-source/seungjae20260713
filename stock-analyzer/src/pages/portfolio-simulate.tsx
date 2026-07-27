// 추가 투자 시뮬레이션 + 시나리오(보수/중립/적극) + 목표 가격 시뮬레이션.
// 전부 클라이언트 계산이며 주문 API를 호출하지 않는다. 시세만 /api/quotes 재사용.
import { useEffect, useMemo, useState } from 'react';
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
	computeBreakEvenPrice,
	computeBuyQuantity,
	computeNewAveragePrice,
	computeProfitAt,
	computeReturnRate,
	computeSpentAmount,
	concentrationRisk,
	weightPercent,
	type CalcMarket,
} from '@/lib/portfolio-calc';

type MarketTab = 'KR' | 'US' | 'COIN';

const MARKET_LABEL: Record<MarketTab, string> = {
	KR: '국내',
	US: '해외',
	COIN: '코인',
};

function fmtNum(value: number, digits = 2): string {
	if (!Number.isFinite(value)) return '-';
	return value.toLocaleString(undefined, {
		minimumFractionDigits: 0,
		maximumFractionDigits: digits,
	});
}

function fmtMoney(value: number, market: MarketTab): string {
	if (!Number.isFinite(value)) return '-';
	if (market === 'KR') return `${Math.round(value).toLocaleString()}원`;
	if (market === 'COIN') return `${fmtNum(value)} USDT`;
	return `$${fmtNum(value)}`;
}

function fmtPct(value: number): string {
	if (!Number.isFinite(value)) return '-';
	const prefix = value > 0 ? '+' : '';
	return `${prefix}${value.toFixed(2)}%`;
}

function marketCashCurrency(market: MarketTab): 'KRW' | 'USD' | 'USDT' {
	if (market === 'US') return 'USD';
	if (market === 'COIN') return 'USDT';
	return 'KRW';
}

export default function PortfolioSimulatePage() {
	const [, navigate] = useLocation();
	const auth = useAuth();
	const fx = useUsdKrwRate();

	const holdingsQuery = useQuery({
		queryKey: ['portfolio-sim-holdings', auth.user?.id ?? 'anon'],
		queryFn: () => fetchHoldingsWithQuotes(auth.user!.id),
		enabled: Boolean(auth.user && auth.configured),
	});

	const cashQuery = useQuery<CashSetting[], Error>({
		queryKey: ['portfolio-sim-cash', auth.user?.id ?? 'anon'],
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

	// 입력 상태
	const [market, setMarket] = useState<MarketTab>('KR');
	const [selectedId, setSelectedId] = useState<string>('');
	const [manualName, setManualName] = useState('');
	const [qty, setQty] = useState('');
	const [avg, setAvg] = useState('');
	const [current, setCurrent] = useState('');
	const [addAmount, setAddAmount] = useState('');
	const [buyPrice, setBuyPrice] = useState('');
	const [target, setTarget] = useState('');
	const [stop, setStop] = useState('');
	const [feeRate, setFeeRate] = useState('0.015');
	const [fxInput, setFxInput] = useState('');

	// 목표가 시뮬레이션 입력
	const [scenarioPrice, setScenarioPrice] = useState('');
	const [scenarioPct, setScenarioPct] = useState('');

	// 실환율 기본값 반영
	useEffect(() => {
		if (fx.rate != null && fxInput === '') {
			setFxInput(String(Math.round(fx.rate)));
		}
	}, [fx.rate, fxInput]);

	const marketHoldings = useMemo(
		() => holdings.filter((h) => h.market === market),
		[holdings, market],
	);

	// 보유종목 선택 시 자동 채우기
	useEffect(() => {
		if (!selectedId) return;
		const h = holdings.find((x) => x.id === selectedId);
		if (!h) return;
		setQty(String(h.quantity));
		setAvg(String(h.average_price));
		if (h.currentPrice != null) setCurrent(String(h.currentPrice));
	}, [selectedId, holdings]);

	// 사용가능현금 (cash settings 연동, 없으면 입력값 기준)
	const cashCurrency = marketCashCurrency(market);
	const cashSetting = (cashQuery.data ?? []).find(
		(c) => c.currency === cashCurrency,
	);
	const availableCash = cashSetting
		? Math.max(0, cashSetting.amount - cashSetting.min_amount)
		: null;

	const calcMarket: CalcMarket = market;

	// 파생 계산
	const result = useMemo(() => {
		const oldQty = Number(qty || '0');
		const oldAvg = Number(avg || '0');
		const cur = Number(current || avg || '0');
		const amount = Number(addAmount || '0');
		const price = Number(buyPrice || current || '0');
		const fee = Number(feeRate || '0');
		const targetP = Number(target || '0');
		const stopP = Number(stop || '0');

		const addQty = computeBuyQuantity(amount, price, fee, calcMarket);
		const spent = computeSpentAmount(addQty, price, fee);
		const newQty = oldQty + addQty;
		const newAvg = computeNewAveragePrice(oldQty, oldAvg, addQty, price);
		const oldCost = oldQty * oldAvg;
		const newCost = oldCost + addQty * price;
		const valueAfter = newQty * (cur || price);
		const breakEven = computeBreakEvenPrice(newAvg, fee);
		const targetProfit = targetP > 0 ? computeProfitAt(targetP, newAvg, newQty) : null;
		const targetRate = targetP > 0 ? computeReturnRate(targetP, newAvg) : null;
		const stopLoss = stopP > 0 ? computeProfitAt(stopP, newAvg, newQty) : null;
		const stopRate = stopP > 0 ? computeReturnRate(stopP, newAvg) : null;

		// 종목 비중 (해당 시장 보유 총 평가금액 기준)
		const marketTotalBefore = marketHoldings.reduce(
			(sum, h) => sum + (h.currentPrice ?? h.average_price) * h.quantity,
			0,
		);
		const thisBefore = oldQty * (cur || oldAvg);
		const otherValue = Math.max(0, marketTotalBefore - thisBefore);
		const weightBefore = weightPercent(thisBefore, marketTotalBefore || thisBefore);
		const weightAfter = weightPercent(valueAfter, otherValue + valueAfter);

		return {
			addQty,
			spent,
			newQty,
			newAvg,
			oldCost,
			newCost,
			valueAfter,
			breakEven,
			targetProfit,
			targetRate,
			stopLoss,
			stopRate,
			weightBefore,
			weightAfter,
			riskBefore: concentrationRisk(weightBefore),
			riskAfter: concentrationRisk(weightAfter),
		};
	}, [
		qty,
		avg,
		current,
		addAmount,
		buyPrice,
		feeRate,
		target,
		stop,
		calcMarket,
		marketHoldings,
	]);

	// 섹터 비중
	const sectorInfo = useMemo(() => {
		const withSector = marketHoldings.filter((h) => h.sector);
		if (withSector.length === 0) return null;
		const map = new Map<string, number>();
		let total = 0;
		for (const h of marketHoldings) {
			const v = (h.currentPrice ?? h.average_price) * h.quantity;
			total += v;
			const key = h.sector ?? '미분류';
			map.set(key, (map.get(key) ?? 0) + v);
		}
		return Array.from(map.entries())
			.map(([sector, v]) => ({ sector, weight: weightPercent(v, total) }))
			.sort((a, b) => b.weight - a.weight);
	}, [marketHoldings]);

	// 시나리오 3종
	const scenarioBase = availableCash ?? Number(addAmount || '0');
	const [scenarioAmounts, setScenarioAmounts] = useState<{
		con: string;
		neu: string;
		agg: string;
	}>({ con: '', neu: '', agg: '' });

	useEffect(() => {
		if (scenarioBase > 0 && scenarioAmounts.con === '') {
			setScenarioAmounts({
				con: String(Math.round(scenarioBase * 0.2)),
				neu: String(Math.round(scenarioBase * 0.5)),
				agg: String(Math.round(scenarioBase * 0.8)),
			});
		}
	}, [scenarioBase, scenarioAmounts.con]);

	const scenarios = useMemo(() => {
		const oldQty = Number(qty || '0');
		const oldAvg = Number(avg || '0');
		const cur = Number(current || avg || '0');
		const price = Number(buyPrice || current || '0');
		const fee = Number(feeRate || '0');
		const targetP = Number(target || '0');
		const stopP = Number(stop || '0');
		const marketTotalBefore = marketHoldings.reduce(
			(sum, h) => sum + (h.currentPrice ?? h.average_price) * h.quantity,
			0,
		);
		const thisBefore = oldQty * (cur || oldAvg);
		const otherValue = Math.max(0, marketTotalBefore - thisBefore);

		const build = (label: string, amountStr: string) => {
			const amount = Number(amountStr || '0');
			const addQty = computeBuyQuantity(amount, price, fee, calcMarket);
			const newQty = oldQty + addQty;
			const newAvg = computeNewAveragePrice(oldQty, oldAvg, addQty, price);
			const valueAfter = newQty * (cur || price);
			const remaining = Math.max(0, scenarioBase - amount);
			const w = weightPercent(valueAfter, otherValue + valueAfter);
			return {
				label,
				amount,
				addQty,
				newAvg,
				weight: w,
				remaining,
				targetProfit:
					targetP > 0 ? computeProfitAt(targetP, newAvg, newQty) : null,
				stopLoss: stopP > 0 ? computeProfitAt(stopP, newAvg, newQty) : null,
				risk: concentrationRisk(w),
			};
		};
		return [
			build('보수형', scenarioAmounts.con),
			build('중립형', scenarioAmounts.neu),
			build('적극형', scenarioAmounts.agg),
		];
	}, [
		scenarioAmounts,
		qty,
		avg,
		current,
		buyPrice,
		feeRate,
		target,
		stop,
		calcMarket,
		marketHoldings,
		scenarioBase,
	]);

	// 목표 가격 시뮬레이션
	const priceScenario = useMemo(() => {
		const oldQty = Number(qty || '0');
		const oldAvg = Number(avg || '0');
		const cur = Number(current || avg || '0');
		let projected = Number(scenarioPrice || '0');
		const pct = Number(scenarioPct || '0');
		if (projected <= 0 && pct !== 0 && cur > 0) {
			projected = cur * (1 + pct / 100);
		}
		if (projected <= 0) return null;
		const value = oldQty * projected;
		const cost = oldQty * oldAvg;
		const profit = value - cost;
		const rate = computeReturnRate(projected, oldAvg);
		const fxRate = Number(fxInput || fx.rate || '0');
		const isForeign = market === 'US' || market === 'COIN';
		const krwValue = isForeign && fxRate > 0 ? value * fxRate : null;
		const krwUp = krwValue != null ? value * fxRate * 1.05 : null;
		const krwDown = krwValue != null ? value * fxRate * 0.95 : null;
		return { projected, value, profit, rate, krwValue, krwUp, krwDown, isForeign };
	}, [qty, avg, current, scenarioPrice, scenarioPct, fxInput, fx.rate, market]);

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
						<h1 className="whitespace-nowrap text-center text-lg font-extrabold">추가 투자 시뮬레이션</h1>
						<p className="text-[11px] font-bold text-muted-foreground">
							가상 시뮬레이션 · 실제 주문 없음
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

				<p className="mt-3 rounded-2xl bg-amber-500/10 p-3 text-center text-[11px] font-bold leading-relaxed text-amber-600">
					가상 시뮬레이션이며 실제 주문과 연결되지 않습니다. 예측값은 확정 수익이
					아닙니다.
				</p>
				<p className="mt-2 text-center text-[10px] font-bold text-muted-foreground">
					적용 환율(USD/KRW) {fx.rate != null ? fmtNum(fx.rate, 2) : '산출 불가'} ·{' '}
					{formatKstTime(fx.updatedAt)}
				</p>

				{!auth.user ? (
					<StateBox className="mt-4">로그인이 필요합니다.</StateBox>
				) : (
					<>
						{/* 입력 */}
						<section className="mt-4 rounded-2xl border border-card-border bg-card p-4 shadow-sm">
							<div className="grid grid-cols-3 gap-2">
								{(['KR', 'US', 'COIN'] as MarketTab[]).map((m) => (
									<button
										key={m}
										type="button"
										onClick={() => {
											setMarket(m);
											setSelectedId('');
										}}
										className={cn(
											'rounded-xl border px-2 py-2 text-center text-[11px] font-extrabold',
											market === m
												? 'border-primary bg-primary text-primary-foreground'
												: 'border-card-border bg-card text-muted-foreground',
										)}
									>
										{MARKET_LABEL[m]}
									</button>
								))}
							</div>

							<label className="mt-3 block">
								<span className="text-[10px] font-bold text-muted-foreground">
									보유 종목 선택
								</span>
								<select
									value={selectedId}
									onChange={(e) => setSelectedId(e.target.value)}
									className="mt-1 h-11 w-full rounded-xl border border-card-border bg-background px-3 text-sm font-bold outline-none focus:border-primary"
								>
									<option value="">직접 입력</option>
									{marketHoldings.map((h) => (
										<option key={h.id} value={h.id}>
											{h.name}
										</option>
									))}
								</select>
							</label>

							{selectedId === '' && (
								<Field
									label="종목명 (직접 입력)"
									value={manualName}
									onChange={setManualName}
									placeholder="예: 삼성전자"
									type="text"
								/>
							)}

							<div className="mt-3 grid grid-cols-2 gap-2">
								<Field label="보유 수량" value={qty} onChange={setQty} />
								<Field label="평균 단가" value={avg} onChange={setAvg} />
								<Field label="현재가" value={current} onChange={setCurrent} />
								<Field label="추가 투자금" value={addAmount} onChange={setAddAmount} />
								<Field label="예상 매수가" value={buyPrice} onChange={setBuyPrice} />
								<Field label="목표가" value={target} onChange={setTarget} />
								<Field label="손절가" value={stop} onChange={setStop} />
								<Field label="수수료율(%)" value={feeRate} onChange={setFeeRate} />
								{(market === 'US' || market === 'COIN') && (
									<Field label="환율(USD/KRW)" value={fxInput} onChange={setFxInput} />
								)}
							</div>

							<p className="mt-3 rounded-xl bg-muted/60 p-2 text-[10px] font-bold text-muted-foreground">
								사용 가능 현금:{' '}
								{availableCash != null
									? fmtMoney(availableCash, market)
									: cashMissing
										? '현금 설정 테이블 미생성 — 입력값 기준 계산'
										: '현금 설정 없음 — 입력값 기준 계산'}
							</p>
						</section>

						{/* 결과 */}
						<section className="mt-4 rounded-2xl border border-card-border bg-card p-4 shadow-sm">
							<h2 className="text-sm font-black">시뮬레이션 결과</h2>
							<div className="mt-3 grid grid-cols-2 gap-2">
								<Row label="예상 추가 매수수량" value={fmtNum(result.addQty, market === 'KR' ? 0 : 8)} />
								<Row label="실제 사용금액(수수료 포함)" value={fmtMoney(result.spent, market)} />
								<Row label="총 수량" value={fmtNum(result.newQty, market === 'KR' ? 0 : 8)} />
								<Row label="변경 평균단가" value={fmtMoney(result.newAvg, market)} />
								<Row label="기존 총투자금" value={fmtMoney(result.oldCost, market)} />
								<Row label="변경 총투자금" value={fmtMoney(result.newCost, market)} />
								<Row label="투자 후 평가금액" value={fmtMoney(result.valueAfter, market)} />
								<Row label="손익분기 가격" value={fmtMoney(result.breakEven, market)} />
								<Row
									label="목표가 예상수익"
									value={
										result.targetProfit != null
											? `${fmtMoney(result.targetProfit, market)} (${fmtPct(result.targetRate ?? 0)})`
											: '목표가 미입력'
									}
								/>
								<Row
									label="손절가 예상손실"
									value={
										result.stopLoss != null
											? `${fmtMoney(result.stopLoss, market)} (${fmtPct(result.stopRate ?? 0)})`
											: '손절가 미입력'
									}
								/>
								<Row label="기존 종목 비중" value={fmtPct(result.weightBefore)} />
								<Row label="변경 종목 비중" value={fmtPct(result.weightAfter)} />
								<Row
									label="집중투자 위험도"
									value={`${result.riskBefore} → ${result.riskAfter}`}
								/>
							</div>

							<div className="mt-3 rounded-xl bg-secondary/60 p-3">
								<p className="text-[10px] font-bold text-muted-foreground">해설</p>
								<p className="mt-1 break-keep text-[11px] font-semibold leading-relaxed">
									추가 투자금 {fmtMoney(Number(addAmount || '0'), market)}로 약{' '}
									{fmtNum(result.addQty, market === 'KR' ? 0 : 4)}주(개)를 매수하면
									평균단가는 {fmtMoney(result.newAvg, market)}로 바뀌고, 해당 종목
									비중은 {fmtPct(result.weightBefore)}에서 {fmtPct(result.weightAfter)}
									(으)로 변합니다. 집중투자 위험도는 {result.riskBefore}에서{' '}
									{result.riskAfter}입니다.
								</p>
							</div>

							{/* 섹터 비중 */}
							<div className="mt-3 rounded-xl bg-secondary/60 p-3">
								<p className="text-[10px] font-bold text-muted-foreground">섹터 비중</p>
								{sectorInfo == null ? (
									<p className="mt-1 text-[11px] font-bold text-muted-foreground">
										섹터 정보 없음
									</p>
								) : (
									<div className="mt-1 space-y-1">
										{sectorInfo.map((s) => (
											<div
												key={s.sector}
												className="flex items-center justify-between text-[11px] font-bold"
											>
												<span>{s.sector}</span>
												<span>{fmtPct(s.weight)}</span>
											</div>
										))}
									</div>
								)}
							</div>
						</section>

						{/* 시나리오 3종 */}
						<section className="mt-4 rounded-2xl border border-card-border bg-card p-4 shadow-sm">
							<h2 className="text-sm font-black">시나리오 비교 (보수/중립/적극)</h2>
							<p className="mt-1 text-[10px] font-bold text-muted-foreground">
								기본 금액 = 사용 가능 현금의 20 / 50 / 80% (직접 수정 가능)
							</p>
							<div className="mt-3 grid grid-cols-3 gap-2">
								<ScenarioInput
									label="보수형"
									value={scenarioAmounts.con}
									onChange={(v) => setScenarioAmounts((p) => ({ ...p, con: v }))}
								/>
								<ScenarioInput
									label="중립형"
									value={scenarioAmounts.neu}
									onChange={(v) => setScenarioAmounts((p) => ({ ...p, neu: v }))}
								/>
								<ScenarioInput
									label="적극형"
									value={scenarioAmounts.agg}
									onChange={(v) => setScenarioAmounts((p) => ({ ...p, agg: v }))}
								/>
							</div>
							<div className="mt-3 overflow-hidden rounded-xl border border-card-border">
								<table className="w-full text-[10px] font-bold">
									<thead className="bg-muted/60">
										<tr>
											<th className="p-2 text-left">항목</th>
											{scenarios.map((s) => (
												<th key={s.label} className="p-2 text-right">
													{s.label}
												</th>
											))}
										</tr>
									</thead>
									<tbody>
										<ScenarioRow label="투자금" values={scenarios.map((s) => fmtMoney(s.amount, market))} />
										<ScenarioRow label="매수수량" values={scenarios.map((s) => fmtNum(s.addQty, market === 'KR' ? 0 : 4))} />
										<ScenarioRow label="변경 평균단가" values={scenarios.map((s) => fmtMoney(s.newAvg, market))} />
										<ScenarioRow label="투자 후 비중" values={scenarios.map((s) => fmtPct(s.weight))} />
										<ScenarioRow label="잔여현금" values={scenarios.map((s) => fmtMoney(s.remaining, market))} />
										<ScenarioRow label="목표가 수익" values={scenarios.map((s) => (s.targetProfit != null ? fmtMoney(s.targetProfit, market) : '-'))} />
										<ScenarioRow label="손절가 손실" values={scenarios.map((s) => (s.stopLoss != null ? fmtMoney(s.stopLoss, market) : '-'))} />
										<ScenarioRow label="위험도" values={scenarios.map((s) => s.risk)} />
									</tbody>
								</table>
							</div>
						</section>

						{/* 목표 가격 시뮬레이션 */}
						<section className="mt-4 rounded-2xl border border-card-border bg-card p-4 shadow-sm">
							<h2 className="text-sm font-black">목표 가격 시뮬레이션</h2>
							<div className="mt-3 grid grid-cols-2 gap-2">
								<Field label="예상 가격" value={scenarioPrice} onChange={setScenarioPrice} />
								<Field label="변동률(%)" value={scenarioPct} onChange={setScenarioPct} />
							</div>
							{priceScenario == null ? (
								<StateBox className="mt-3">
									예상 가격 또는 변동률을 입력하고 보유 수량·평균단가를 채워 주세요.
								</StateBox>
							) : (
								<div className="mt-3 grid grid-cols-2 gap-2">
									<Row label="예상 가격" value={fmtMoney(priceScenario.projected, market)} />
									<Row label="예상 평가금액" value={fmtMoney(priceScenario.value, market)} />
									<Row label="예상 손익" value={fmtMoney(priceScenario.profit, market)} />
									<Row label="예상 수익률" value={fmtPct(priceScenario.rate)} />
									{priceScenario.isForeign && (
										<>
											<Row
												label="원화 환산"
												value={
													priceScenario.krwValue != null
														? `${Math.round(priceScenario.krwValue).toLocaleString()}원`
														: '산출 불가'
												}
											/>
											<Row
												label="환율 ±5% 영향"
												value={
													priceScenario.krwUp != null && priceScenario.krwDown != null
														? `${Math.round(priceScenario.krwDown).toLocaleString()} ~ ${Math.round(priceScenario.krwUp).toLocaleString()}원`
														: '산출 불가'
												}
											/>
										</>
									)}
								</div>
							)}
							<p className="mt-3 text-[10px] font-bold text-muted-foreground">
								가정 기반 시뮬레이션이며 확정 수익이 아닙니다. USDT는 1 USDT≈1 USD로
								가정합니다.
							</p>
						</section>
					</>
				)}
			</div>
			<BottomNav />
		</div>
	);
}

function Field({
	label,
	value,
	onChange,
	placeholder,
	type = 'number',
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	type?: 'number' | 'text';
}) {
	return (
		<label className="block">
			<span className="text-[10px] font-bold text-muted-foreground">{label}</span>
			<input
				type={type}
				inputMode={type === 'number' ? 'decimal' : 'text'}
				step={type === 'number' ? 'any' : undefined}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder ?? '0'}
				className="mt-1 h-11 w-full rounded-xl border border-card-border bg-background px-3 text-sm font-bold outline-none focus:border-primary"
			/>
		</label>
	);
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-xl bg-secondary/60 p-2.5">
			<p className="text-[10px] font-bold text-muted-foreground">{label}</p>
			<p className="mt-0.5 break-words text-xs font-black">{value}</p>
		</div>
	);
}

function ScenarioInput({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<label className="block">
			<span className="text-[10px] font-bold text-muted-foreground">{label}</span>
			<input
				type="number"
				inputMode="decimal"
				step="any"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder="0"
				className="mt-1 h-10 w-full rounded-xl border border-card-border bg-background px-2 text-xs font-bold outline-none focus:border-primary"
			/>
		</label>
	);
}

function ScenarioRow({ label, values }: { label: string; values: string[] }) {
	return (
		<tr className="border-t border-card-border">
			<td className="p-2 text-left text-muted-foreground">{label}</td>
			{values.map((v, i) => (
				<td key={i} className="p-2 text-right">
					{v}
				</td>
			))}
		</tr>
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
