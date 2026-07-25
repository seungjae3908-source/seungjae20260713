import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Layers, Search, X } from "lucide-react";
import { api, apiGet, type ThemeGroup, type ThemeStock } from "@/lib/api";
import {
	classifyStock,
	stockClassBadgeClass,
	type StockGrade,
} from "@/lib/stock-classifier";
import { BottomNav } from "@/components/bottom-nav";
import { cn } from "@/lib/utils";
import { FavoriteButton } from "@/components/favorite-button";
import { InstrumentAlertButton } from "@/components/instrument-alert-modal";
import { displayCoinName, displayStockName, formatAppPercent, formatAppPrice } from "@/lib/stock-display";

type MarketTab = "KR" | "US" | "COIN";
type CoinTicker = {
	symbol: string;
	market?: string;
	koreanName?: string;
	englishName?: string;
	price?: number | null;
	changePercent?: number | null;
};

function signedPercent(value: number | undefined) {
	if (value == null || !Number.isFinite(value)) return "—";

	return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatPrice(price: number, currency: string) {
	if (!Number.isFinite(price)) return "—";

	if (currency === "KRW") {
		return `${Math.round(price).toLocaleString("ko-KR")}원`;
	}

	return `$${price.toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}

export default function ThemesPage() {
	const [, navigate] = useLocation();
	const scrollRef = useRef<HTMLElement | null>(null);
	const [market, setMarket] = useState<MarketTab>("KR");
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [page, setPage] = useState(1);

	const themesQuery = useQuery({
		queryKey: ["themes", market],
		queryFn: () => api.themes(market === "US" ? "US" : "KR"),
		enabled: market !== "COIN",
		staleTime: 5 * 60 * 1000,
	});
	const coinQuery = useQuery({
		queryKey: ["themes", "UPBIT", "spot-tickers"],
		queryFn: () => apiGet<{ tickers?: CoinTicker[] }>("/crypto/spot/tickers"),
		enabled: market === "COIN",
		staleTime: 15_000,
		refetchInterval: market === "COIN" ? 30_000 : false,
	});

	const themes = useMemo(
		() => themesQuery.data?.themes ?? [],
		[themesQuery.data],
	);

	const filteredThemes = useMemo(() => {
		const keyword = query.trim().toLowerCase();
		if (!keyword) return themes;
		return themes
			.map((theme) => ({
				...theme,
				stocks: theme.stocks.filter(
					(stock) =>
						theme.label.toLowerCase().includes(keyword) ||
						stock.name.toLowerCase().includes(keyword) ||
						stock.ticker.toLowerCase().includes(keyword),
				),
			}))
			.filter(
				(theme) =>
					theme.label.toLowerCase().includes(keyword) ||
					theme.stocks.length > 0,
			);
	}, [themes, query]);

	const selected = useMemo(() => {
		if (!filteredThemes.length) return null;

		const found = filteredThemes.find((theme) => theme.key === selectedKey);

		return found ?? filteredThemes[0];
	}, [filteredThemes, selectedKey]);
	const filteredCoins = useMemo(() => {
		const keyword = query.trim().toLowerCase();
		return (coinQuery.data?.tickers ?? []).filter((coin) => {
			if (!keyword) return true;
			const name = displayCoinName(coin.symbol, coin.koreanName, coin.englishName);
			return [coin.symbol, coin.market, coin.koreanName, coin.englishName, name]
				.some((value) => String(value ?? "").toLowerCase().includes(keyword));
		});
	}, [coinQuery.data?.tickers, query]);

	const changeMarket = (next: MarketTab) => {
		setMarket(next);
		setSelectedKey(null);
		setQuery("");
		setPage(1);
		scrollRef.current?.scrollTo({ top: 0, left: 0 });
	};

	useEffect(() => {
		setPage(1);
	}, [query, selected?.key]);

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
			<header className="sticky top-0 z-20 border-b border-card-border bg-background/90 px-4 pb-3 pt-4 glass">
				<div className="mb-3 text-left">
					<h1 className="text-xl font-extrabold">테마</h1>
				</div>

				<div className="grid grid-cols-3 gap-2">
					<MarketButton
						active={market === "KR"}
						onClick={() => changeMarket("KR")}
					>
						국내주식
					</MarketButton>

					<MarketButton
						active={market === "US"}
						onClick={() => changeMarket("US")}
					>
						해외주식
					</MarketButton>
					<MarketButton
						active={market === "COIN"}
						onClick={() => changeMarket("COIN")}
					>
						코인
					</MarketButton>
				</div>
				<label className="mt-2 flex items-center gap-2 rounded-xl border border-card-border bg-card px-3 py-2.5">
					<Search className="h-4 w-4 text-muted-foreground" />
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={market === "COIN" ? "코인명·영문명·심볼 검색" : "테마·한글명·영문명·티커 검색"}
						className="min-w-0 flex-1 bg-transparent text-sm font-bold outline-none placeholder:text-muted-foreground"
					/>
					{query && (
						<button type="button" aria-label="검색어 지우기" onClick={() => setQuery("")} className="rounded-full p-1 text-muted-foreground">
							<X className="h-4 w-4" />
						</button>
					)}
				</label>
			</header>

			<main ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 pb-24">
				{market !== "COIN" && themesQuery.isLoading && (
					<div className="rounded-3xl border border-card-border bg-card p-8 text-center text-sm font-bold">
						테마 데이터 수집 중...
					</div>
				)}

				{market !== "COIN" && themesQuery.isError && (
					<div className="rounded-3xl border border-card-border bg-card p-8 text-center">
						<p className="break-keep text-sm font-bold leading-relaxed text-destructive">
							테마 데이터를 불러오지 못했습니다.
						</p>

						<button
							type="button"
							onClick={() => void themesQuery.refetch()}
							className="mt-3 rounded-full bg-primary px-4 py-2 text-xs font-bold text-primary-foreground"
						>
							다시 시도
						</button>
					</div>
				)}

				{market !== "COIN" && themesQuery.data && themes.length === 0 && (
					<div className="rounded-3xl border border-card-border bg-card p-8 text-center">
						<p className="break-keep text-sm font-bold leading-relaxed">
							표시할 테마가 없습니다.
						</p>

						<p className="mt-2 break-keep text-xs leading-relaxed text-muted-foreground">
							데이터 수집 중이거나 해당 시장 정보가 부족합니다.
						</p>
					</div>
				)}

				{market !== "COIN" && themes.length > 0 && (
					<>
						<div className="mb-3 flex gap-2 overflow-x-auto pb-1">
							{filteredThemes.map((theme) => (
								<ThemeChip
									key={theme.key}
									theme={theme}
									active={selected?.key === theme.key}
									onClick={() => setSelectedKey(theme.key)}
								/>
							))}
						</div>
						{selected ? (
							<ThemeSection theme={selected} page={page} onPageChange={setPage} />
						) : (
							<div className="rounded-3xl border border-card-border bg-card p-8 text-center text-sm font-bold text-muted-foreground">
								검색 결과가 없습니다.
							</div>
						)}
					</>
				)}

				{market === "COIN" && coinQuery.isLoading && (
					<div className="rounded-3xl border border-card-border bg-card p-8 text-center text-sm font-bold">Upbit 코인 데이터를 불러오는 중...</div>
				)}
				{market === "COIN" && coinQuery.isError && (
					<div className="rounded-3xl border border-card-border bg-card p-8 text-center text-sm font-bold text-destructive">Upbit 코인 데이터를 불러오지 못했습니다.</div>
				)}
				{market === "COIN" && coinQuery.data && (
					<CoinThemeSection coins={filteredCoins} page={page} onPageChange={setPage} onOpen={(symbol) => navigate(`/stock-info?asset=coin&coinMarket=spot&symbol=${encodeURIComponent(symbol)}`)} />
				)}
			</main>

			<BottomNav />
		</div>
	);
}

function MarketButton({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"rounded-xl border px-3 py-2 text-sm font-bold transition-colors",
				active
					? "border-primary bg-primary text-primary-foreground"
					: "border-card-border bg-card text-muted-foreground",
			)}
		>
			{children}
		</button>
	);
}

function ThemeChip({
	theme,
	active,
	onClick,
}: {
	theme: ThemeGroup;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold transition-colors",
				active
					? "border-primary bg-primary text-primary-foreground"
					: "border-card-border bg-card text-muted-foreground",
			)}
		>
			<span>{theme.label}</span>

			<span
				className={cn(
					"rounded-full px-1.5 py-0.5 text-[10px] font-bold",
					active
						? "bg-primary-foreground/20 text-primary-foreground"
						: "bg-secondary text-muted-foreground",
				)}
			>
				{theme.count}
			</span>
		</button>
	);
}

function ThemeSection({
	theme,
	page,
	onPageChange,
}: {
	theme: ThemeGroup;
	page: number;
	onPageChange: (page: number) => void;
}) {
	const totalPages = Math.max(1, Math.ceil(theme.stocks.length / 10));
	const safePage = Math.min(page, totalPages);
	const visibleStocks = theme.stocks.slice((safePage - 1) * 10, safePage * 10);

	return (
		<section>
			<div className="mb-2 flex items-center gap-2 px-1">
				<span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
					<Layers className="h-4 w-4" />
				</span>

				<div>
					<h2 className="text-base font-extrabold leading-tight">
						{theme.label}
					</h2>

					<p className="text-xs text-muted-foreground">종목 {theme.count}개</p>
				</div>
			</div>

			{theme.stocks.length === 0 ? (
				<div className="rounded-3xl border border-card-border bg-card p-8 text-center text-sm font-bold text-muted-foreground">
					해당 테마의 종목 데이터가 부족합니다.
				</div>
			) : (
				<div className="space-y-2">
					{visibleStocks.map((stock) => (
						<ThemeStockCard key={stock.ticker} stock={stock} />
					))}
				</div>
			)}
			<Pagination page={safePage} totalPages={totalPages} onPageChange={onPageChange} />
		</section>
	);
}

function CoinThemeSection({
	coins,
	page,
	onPageChange,
	onOpen,
}: {
	coins: CoinTicker[];
	page: number;
	onPageChange: (page: number) => void;
	onOpen: (symbol: string) => void;
}) {
	const totalPages = Math.max(1, Math.ceil(coins.length / 10));
	const safePage = Math.min(page, totalPages);
	const visibleCoins = coins.slice((safePage - 1) * 10, safePage * 10);

	return (
		<section>
			<div className="mb-2 rounded-2xl border border-card-border bg-card p-3 text-center">
				<h2 className="text-base font-extrabold">Upbit 원화마켓</h2>
				<p className="mt-1 text-xs text-muted-foreground">공식 마켓명·시세 {coins.length}개</p>
				<p className="mt-1 break-keep text-left text-[11px] leading-relaxed text-muted-foreground">
					Upbit는 분야·생태계 분류를 제공하지 않아 근거 없는 테마를 만들지 않고 원화마켓으로만 표시합니다.
				</p>
			</div>
			{visibleCoins.length ? (
				<div className="space-y-2">
					{visibleCoins.map((coin) => {
						const symbol = String(coin.symbol ?? "").toUpperCase();
						const name = displayCoinName(symbol, coin.koreanName, coin.englishName);
						const change = Number(coin.changePercent);
						return (
							<div key={symbol} role="button" tabIndex={0} onClick={() => onOpen(symbol)} onKeyDown={(event) => { if (event.key === "Enter") onOpen(symbol); }} className="flex items-center gap-2 rounded-2xl border border-card-border bg-card p-3 shadow-sm">
								<div className="flex min-w-0 flex-1 items-center gap-1 text-center">
									<FavoriteButton item={{ ticker: symbol, name, market: "UPBIT", currency: "KRW" }} />
									<div className="min-w-0 flex-1"><p className="truncate text-sm font-extrabold">{name}</p><p className="text-[11px] font-bold text-muted-foreground">{symbol}</p></div>
								</div>
								<div className="flex shrink-0 items-center gap-1 text-center">
									<div><p className="text-sm font-extrabold">{formatAppPrice(Number(coin.price), "KRW")}</p><p className={cn("text-xs font-extrabold", change > 0 ? "text-positive" : change < 0 ? "text-destructive" : "text-muted-foreground")}>{Number.isFinite(change) ? formatAppPercent(change) : "—"}</p></div>
									<InstrumentAlertButton instrument={{ ticker: symbol, name, market: "UPBIT", assetType: "coin_spot" }} />
								</div>
							</div>
						);
					})}
				</div>
			) : (
				<div className="rounded-2xl border border-card-border bg-card p-8 text-center text-sm font-bold text-muted-foreground">검색 결과가 없습니다.</div>
			)}
			<Pagination page={safePage} totalPages={totalPages} onPageChange={onPageChange} />
		</section>
	);
}

function Pagination({ page, totalPages, onPageChange }: { page: number; totalPages: number; onPageChange: (page: number) => void }) {
	if (totalPages <= 1) return null;
	return (
		<div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-center">
			<button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)} className="rounded-xl border border-card-border bg-card px-3 py-2 text-xs font-bold disabled:opacity-40">이전</button>
			<span className="text-xs font-extrabold">{page} / {totalPages}</span>
			<button type="button" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} className="rounded-xl border border-card-border bg-card px-3 py-2 text-xs font-bold disabled:opacity-40">다음</button>
		</div>
	);
}

function ThemeStockCard({ stock }: { stock: ThemeStock }) {
	const name = displayStockName(stock.ticker, stock.name, stock.market);
	const classification = classifyStock({
		ticker: stock.ticker,
		name: stock.name,
		changePercent: stock.changePercent,
		currency: stock.currency,
		market: stock.market,
	});

	const positive = (stock.changePercent ?? 0) >= 0;

	return (
		<Link href={`/stock/${stock.ticker}?back=${encodeURIComponent("/themes")}`}>
			<article className="flex items-center justify-between gap-3 rounded-3xl border border-card-border bg-card p-4 shadow-sm transition active:scale-[0.99]">
				<div className="flex min-w-0 flex-1 items-start gap-1">
					<FavoriteButton item={{ ticker: stock.ticker, name, market: stock.market, currency: stock.currency }} />
				<div className="min-w-0 text-center">
					<div className="flex flex-wrap items-center gap-1.5">
						<h3 className="min-w-0 break-keep text-sm font-extrabold leading-relaxed">
							{name}
						</h3>

						<span
							className={cn(
								"shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-bold leading-relaxed",
								stockClassBadgeClass(
									(stock as { grade?: StockGrade }).grade?.label ??
										classification.label,
								),
							)}
						>
							{(stock as { grade?: StockGrade }).grade?.label ??
								classification.label}
						</span>
					</div>

					<p className="mt-1 break-keep text-xs leading-relaxed text-muted-foreground">
						{stock.market === "KR" ? stock.ticker : `티커 ${stock.ticker}`}
					</p>
				</div>
				</div>

				<div className="flex shrink-0 items-end gap-1 text-right">
				<div>
					<p className="text-sm font-extrabold">
						{formatPrice(stock.price, stock.currency)}
					</p>

					<p
						className={cn(
							"mt-0.5 text-xs font-extrabold",
							positive ? "text-positive" : "text-destructive",
						)}
					>
						{signedPercent(stock.changePercent)}
					</p>
				</div>
				<InstrumentAlertButton instrument={{ ticker: stock.ticker, name, market: stock.market }} />
				</div>

				<ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
			</article>
		</Link>
	);
}
