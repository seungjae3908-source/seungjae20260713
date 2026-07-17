import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Layers, Search, X } from "lucide-react";
import { api, type ThemeGroup, type ThemeStock } from "@/lib/api";
import {
	classifyStock,
	stockClassBadgeClass,
	type StockGrade,
} from "@/lib/stock-classifier";
import { BottomNav } from "@/components/bottom-nav";
import { cn } from "@/lib/utils";

type MarketTab = "KR" | "US";

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
	const [market, setMarket] = useState<MarketTab>("KR");
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [searchOpen, setSearchOpen] = useState(false);
	const [query, setQuery] = useState("");

	const themesQuery = useQuery({
		queryKey: ["themes", market],
		queryFn: () => api.themes(market),
		staleTime: 5 * 60 * 1000,
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

	const changeMarket = (next: MarketTab) => {
		setMarket(next);
		setSelectedKey(null);
	};

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
			<header className="sticky top-0 z-20 border-b border-card-border bg-background/90 px-4 pb-3 pt-4 glass">
				<div className="mb-3 text-center">
					<h1 className="text-xl font-extrabold">테마</h1>
				</div>

				<div className="grid grid-cols-2 gap-2">
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
				</div>
			</header>

			<main className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 pb-24">
				{themesQuery.isLoading && (
					<div className="rounded-3xl border border-card-border bg-card p-8 text-center text-sm font-bold">
						테마 데이터 수집 중...
					</div>
				)}

				{themesQuery.isError && (
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

				{themesQuery.data && themes.length === 0 && (
					<div className="rounded-3xl border border-card-border bg-card p-8 text-center">
						<p className="break-keep text-sm font-bold leading-relaxed">
							표시할 테마가 없습니다.
						</p>

						<p className="mt-2 break-keep text-xs leading-relaxed text-muted-foreground">
							데이터 수집 중이거나 해당 시장 정보가 부족합니다.
						</p>
					</div>
				)}

				{themes.length > 0 && !searchOpen && (
					<section className="rounded-3xl border border-card-border bg-card p-5 text-center">
						<div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
							<Layers className="h-7 w-7" />
						</div>
						<h2 className="mt-3 text-lg font-extrabold">
							원하는 테마를 찾아보세요
						</h2>
						<p className="mt-1 break-keep text-xs leading-relaxed text-muted-foreground">
							반도체·바이오·2차전지 등 섹터와 종목명을 검색할 수 있습니다.
						</p>
						<button
							type="button"
							onClick={() => setSearchOpen(true)}
							className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground"
						>
							<Search className="h-4 w-4" /> 테마 검색하기
						</button>
					</section>
				)}

				{themes.length > 0 && searchOpen && (
					<>
						<div className="mb-3 flex items-center gap-2">
							<label className="flex flex-1 items-center gap-2 rounded-2xl border border-card-border bg-card px-3 py-3">
								<Search className="h-4 w-4 text-muted-foreground" />
								<input
									value={query}
									onChange={(event) => setQuery(event.target.value)}
									placeholder="테마 또는 종목명 검색"
									className="min-w-0 flex-1 bg-transparent text-sm font-bold outline-none placeholder:text-muted-foreground"
									autoFocus
								/>
							</label>
							<button
								type="button"
								aria-label="검색 닫기"
								onClick={() => {
									setSearchOpen(false);
									setQuery("");
								}}
								className="flex h-11 w-11 items-center justify-center rounded-2xl border border-card-border bg-card text-muted-foreground"
							>
								<X className="h-4 w-4" />
							</button>
						</div>
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
							<ThemeSection theme={selected} />
						) : (
							<div className="rounded-3xl border border-card-border bg-card p-8 text-center text-sm font-bold text-muted-foreground">
								검색 결과가 없습니다.
							</div>
						)}
					</>
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

function ThemeSection({ theme }: { theme: ThemeGroup }) {
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
					{theme.stocks.map((stock) => (
						<ThemeStockCard key={stock.ticker} stock={stock} />
					))}
				</div>
			)}
		</section>
	);
}

function ThemeStockCard({ stock }: { stock: ThemeStock }) {
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
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-1.5">
						<h3 className="min-w-0 break-keep text-sm font-extrabold leading-relaxed">
							{stock.name}
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

				<div className="shrink-0 text-right">
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

				<ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
			</article>
		</Link>
	);
}
