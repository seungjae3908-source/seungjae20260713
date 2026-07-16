import { authorizedFetch } from '@/lib/auth-fetch';
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Layers, Search } from "lucide-react";
import { api, type ThemeGroup, type ThemeStock } from "@/lib/api";
import { classifyStock, stockClassBadgeClass } from "@/lib/stock-classifier";
import { BottomNav } from "@/components/bottom-nav";
import { cn } from "@/lib/utils";

type MarketTab = "KR" | "US";

function signedPercent(value: number | undefined) {
	if (value == null || !Number.isFinite(value)) return "—";
	return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}
function formatPrice(price: number, currency: string) {
	if (!Number.isFinite(price) || price <= 0) return "현재가 확인 중";
	return currency === "KRW" ? `${Math.round(price).toLocaleString("ko-KR")}원` : `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function fetchThemeQuotes(tickers: string[]) {
	if (!tickers.length) return [] as ThemeStock[];
	const response = await authorizedFetch(`/api/quotes?tickers=${encodeURIComponent(tickers.join(","))}&_ts=${Date.now()}`, { cache: "no-store" });
	if (!response.ok) return [];
	const raw = await response.json();
	return (Array.isArray(raw?.quotes) ? raw.quotes : Array.isArray(raw?.items) ? raw.items : []) as ThemeStock[];
}

export default function ThemesPage() {
	const [location, navigate] = useLocation();
	const initialMarket = new URLSearchParams(location.split("?")[1] ?? "").get("market") === "US" ? "US" : "KR";
	const [market, setMarket] = useState<MarketTab>(initialMarket);
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const themesQuery = useQuery({ queryKey: ["themes-complete", market], queryFn: () => api.themes(market), staleTime: 0, refetchInterval: 5 * 60_000, refetchOnWindowFocus: true });
	useEffect(() => {
		const params = new URLSearchParams(location.split("?")[1] ?? "");
		params.set("market", market);
		const next = `/themes?${params.toString()}`;
		if (location !== next) navigate(next, { replace: true });
	}, [location, market, navigate]);
	const themes = useMemo(() => themesQuery.data?.themes ?? [], [themesQuery.data]);
	const filteredThemes = useMemo(() => {
		const keyword = query.trim().toLowerCase();
		if (!keyword) return themes;
		return themes.map((theme) => ({ ...theme, stocks: theme.stocks.filter((stock) => theme.label.toLowerCase().includes(keyword) || stock.name.toLowerCase().includes(keyword) || stock.ticker.toLowerCase().includes(keyword)) })).filter((theme) => theme.label.toLowerCase().includes(keyword) || theme.stocks.length > 0).map((theme) => ({ ...theme, count: theme.stocks.length }));
	}, [themes, query]);
	const selected = useMemo(() => filteredThemes.find((theme) => theme.key === selectedKey) ?? filteredThemes[0] ?? null, [filteredThemes, selectedKey]);
	const quotes = useQuery({ queryKey: ["theme-quotes", selected?.key, selected?.stocks.map((s) => s.ticker).join(",")], queryFn: () => fetchThemeQuotes((selected?.stocks ?? []).map((stock) => stock.ticker)), enabled: Boolean(selected?.stocks.length), staleTime: 0, refetchInterval: 15_000, refetchOnWindowFocus: true });
	const selectedLive = useMemo(() => {
		if (!selected) return null;
		const live = new Map((quotes.data ?? []).map((stock: any) => [String(stock.ticker ?? stock.symbol), stock]));
		const stocks = selected.stocks.map((stock) => ({ ...stock, ...(live.get(stock.ticker) ?? {}) }));
		return { ...selected, count: stocks.length, stocks };
	}, [selected, quotes.data]);

	return <div className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain bg-background">
		<header className="relative z-20 border-b border-card-border bg-background/90 px-4 pb-3 pt-4 glass">
			<div className="mb-3 text-center"><h1 className="text-xl font-extrabold">테마종목</h1><p className="mt-1 break-keep text-xs leading-relaxed text-muted-foreground">전체 등록 기업을 업종·사업 기준으로 분류합니다.</p></div>
			<div className="grid grid-cols-2 gap-2"><MarketButton active={market === "KR"} onClick={() => { setMarket("KR"); setSelectedKey(null); }}>국내주식</MarketButton><MarketButton active={market === "US"} onClick={() => { setMarket("US"); setSelectedKey(null); }}>해외주식</MarketButton></div>
		</header>
		<main className="flex-none p-3 pb-24">
			<label className="mb-3 flex w-full items-center gap-2 rounded-2xl border border-card-border bg-card px-4 py-3"><Search className="h-4 w-4 text-muted-foreground" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="테마 또는 종목명 검색" className="min-w-0 flex-1 bg-transparent text-sm font-bold outline-none placeholder:text-muted-foreground" /></label>
			{themesQuery.isFetching && <p className="mb-2 text-right text-[10px] font-bold text-muted-foreground">테마·현재가 최신화 중</p>}
			<div className="mb-3 flex gap-2 overflow-x-auto pb-1">{filteredThemes.map((theme) => <ThemeChip key={theme.key} theme={theme} active={selectedLive?.key === theme.key} onClick={() => setSelectedKey(theme.key)} />)}</div>
			{selectedLive ? <ThemeSection theme={selectedLive} /> : <div className="rounded-3xl border border-card-border bg-card p-8 text-center text-sm font-bold text-muted-foreground">검색 결과가 없습니다.</div>}
		</main><BottomNav />
	</div>;
}

function MarketButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) { return <button type="button" onClick={onClick} className={cn("rounded-xl border px-3 py-2 text-sm font-bold", active ? "border-primary bg-primary text-primary-foreground" : "border-card-border bg-card text-muted-foreground")}>{children}</button>; }
function ThemeChip({ theme, active, onClick }: { theme: ThemeGroup; active: boolean; onClick: () => void }) { return <button type="button" onClick={onClick} className={cn("flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold", active ? "border-primary bg-primary text-primary-foreground" : "border-card-border bg-card text-muted-foreground")}><span>{theme.label}</span><span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-bold", active ? "bg-primary-foreground/20" : "bg-secondary text-muted-foreground")}>{theme.count}</span></button>; }
function ThemeSection({ theme }: { theme: ThemeGroup }) { return <section><div className="mb-2 flex items-center gap-2 px-1"><span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary"><Layers className="h-4 w-4" /></span><div><h2 className="text-base font-extrabold">{theme.label}</h2><p className="text-xs text-muted-foreground">종목 {theme.count}개</p></div></div><div className="space-y-2">{theme.stocks.map((stock) => <ThemeStockCard key={stock.ticker} stock={stock} />)}</div></section>; }
function ThemeStockCard({ stock }: { stock: ThemeStock }) {
	const classification = classifyStock({ ticker: stock.ticker, name: stock.name, changePercent: stock.changePercent, currency: stock.currency, market: stock.market, marketCap: (stock as any).marketCap, aiScore: (stock as any).score });
	const positive = (stock.changePercent ?? 0) >= 0;
	return <Link href={`/stock/${stock.ticker}?back=${encodeURIComponent("/themes")}`}><article className="flex items-center justify-between gap-3 rounded-3xl border border-card-border bg-card p-4 shadow-sm transition active:scale-[0.99]"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-1.5"><h3 className="min-w-0 break-keep text-sm font-extrabold leading-relaxed">{stock.name}</h3><span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-bold", stockClassBadgeClass(classification.label))}>{classification.label}</span></div><p className="mt-1 text-xs text-muted-foreground">{stock.market === "KR" ? stock.ticker : `티커 ${stock.ticker}`}</p></div><div className="shrink-0 text-right"><p className="text-sm font-extrabold">{formatPrice(stock.price, stock.currency)}</p><p className={cn("mt-0.5 text-xs font-extrabold", positive ? "text-positive" : "text-destructive")}>{signedPercent(stock.changePercent)}</p></div><ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" /></article></Link>;
}
