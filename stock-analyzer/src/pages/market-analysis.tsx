// 시장분석 전용 전체 화면 — 국내/해외/코인 시장 상태 분석. 실제 확보 데이터만 표시한다.
import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { BottomNav } from '@/components/bottom-nav';
import { cn } from '@/lib/utils';

type MarketParam = 'kr' | 'us' | 'coin';

type AnalysisItem = {
	label: string;
	value: string | null;
	note?: string;
	tone?: 'up' | 'down' | 'flat';
};

type AnalysisSection = {
	key: string;
	title: string;
	items: AnalysisItem[];
	highlight?: boolean;
	unavailable?: string;
};

type AnalysisResponse = {
	ok?: boolean;
	market?: string;
	dataAsOf?: string;
	sections?: AnalysisSection[];
};

const MARKET_TABS: Array<{ key: MarketParam; label: string }> = [
	{ key: 'kr', label: '국내' },
	{ key: 'us', label: '해외' },
	{ key: 'coin', label: '코인' },
];

const MARKET_LABEL: Record<MarketParam, string> = {
	kr: '국내시장',
	us: '해외시장',
	coin: '코인시장',
};

function parseMarket(path: string): MarketParam | null {
	const match = path.split('?')[0].match(/^\/analysis\/([a-zA-Z]+)/);
	if (!match) return null;
	const value = match[1].toLowerCase();
	if (value === 'kr' || value === 'us' || value === 'coin') return value;
	return null;
}

function formatDataAsOf(value: string | undefined): string {
	if (!value) return '기준시각 없음';
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return '기준시각 없음';
	return new Intl.DateTimeFormat('ko-KR', {
		timeZone: 'Asia/Seoul',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	}).format(date);
}

export default function MarketAnalysisPage() {
	const [location, navigate] = useLocation();
	const market = parseMarket(location);
	const [selectedSection, setSelectedSection] = useState<AnalysisSection | null>(null);

	const query = useQuery({
		queryKey: ['market-analysis', market],
		queryFn: () => apiGet<AnalysisResponse>(`/market/analysis/${market}`),
		enabled: !!market,
		refetchInterval: 180_000,
	});

	const sections = useMemo(
		() => (query.data?.sections ?? []) as AnalysisSection[],
		[query.data],
	);

	if (!market) {
		return (
			<div className="flex h-full items-center justify-center bg-background p-6">
				<p className="text-center text-sm font-bold text-muted-foreground">잘못된 경로입니다.</p>
			</div>
		);
	}

	const dataAsOf = formatDataAsOf(query.data?.dataAsOf);
	const ok = query.data?.ok !== false;

	return (
		<div className="h-full overflow-y-auto overscroll-contain bg-background">
			<div className="mx-auto max-w-md px-4 pb-28 pt-4">
				<header className="relative flex min-h-[58px] items-center justify-center px-12 text-center">
					<div className="min-w-0 text-center">
						<h1 className="whitespace-nowrap text-center text-xl font-extrabold">시장분석</h1>
						<p className="mt-1 whitespace-nowrap text-center text-[11px] font-bold text-muted-foreground">
							{MARKET_LABEL[market]}
						</p>
					</div>
					<button
						type="button"
						onClick={() => void query.refetch()}
						aria-label="새로고침"
						className="absolute right-0 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-card-border bg-card"
					>
						<RefreshCw className={cn('h-4 w-4', query.isFetching && 'animate-spin')} />
					</button>
				</header>

				<div className="mt-3 grid grid-cols-3 gap-2">
					{MARKET_TABS.map((tab) => (
						<button
							key={tab.key}
							type="button"
							onClick={() => navigate(`/analysis/${tab.key}?from=info`)}
							className={cn(
								'rounded-xl border px-2 py-2 text-center text-[11px] font-extrabold',
								market === tab.key
									? 'border-primary bg-primary text-primary-foreground'
									: 'border-card-border bg-card text-muted-foreground',
							)}
						>
							{tab.label}
						</button>
					))}
				</div>

				<p className="mt-2 text-center text-[10px] font-bold text-muted-foreground">
					데이터 기준 {dataAsOf}
				</p>

				<div className="mt-3 space-y-3">
					{query.isLoading ? (
						<StateBox>데이터를 불러오는 중입니다.</StateBox>
					) : query.isError || !ok ? (
						<StateBox error>
							데이터를 불러오지 못했습니다.
							<button
								type="button"
								onClick={() => void query.refetch()}
								className="mt-2 block w-full rounded-xl border border-card-border bg-card py-2 text-center text-xs font-black text-foreground"
							>
								다시 시도
							</button>
						</StateBox>
					) : sections.length === 0 ? (
						<StateBox>분석 가능한 데이터가 없습니다.</StateBox>
					) : (
						sections.map((section) => (
							<button
								key={section.key}
								type="button"
								onClick={() => setSelectedSection(section)}
								className={cn(
									'flex min-h-[72px] w-full items-center justify-center rounded-2xl border bg-card px-4 py-3 text-center shadow-sm',
									section.highlight ? 'border-primary ring-1 ring-primary/40' : 'border-card-border',
								)}
							>
								<span className="min-w-0 text-center">
									<span className="block break-keep text-center text-sm font-black">{section.title}</span>
								</span>
							</button>
						))
					)}
				</div>
			</div>

			{selectedSection && (
				<div className="fixed inset-0 z-[120] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={selectedSection.title}>
					<button
						type="button"
						aria-label="팝업 닫기"
						onClick={() => setSelectedSection(null)}
						className="absolute inset-0 bg-black/70"
					/>
					<section className="relative z-10 flex max-h-[86dvh] w-full max-w-md flex-col overflow-hidden rounded-3xl border border-card-border bg-card shadow-2xl">
						<header className="relative flex min-h-[58px] items-center justify-center border-b border-card-border px-14 text-center">
							<h2 className="break-keep text-center text-base font-black">{selectedSection.title}</h2>
							<button
								type="button"
								onClick={() => setSelectedSection(null)}
								aria-label="닫기"
								className="absolute right-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-card-border bg-secondary text-xl font-black"
							>
								×
							</button>
						</header>
						<div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-4 text-center">
							{selectedSection.unavailable ? (
								<StateBox>{selectedSection.unavailable}</StateBox>
							) : selectedSection.items.length === 0 ? (
								<StateBox>분석 가능한 데이터가 없습니다.</StateBox>
							) : (
								selectedSection.items.map((item, index) => (
									<AnalysisRow key={`${item.label}:${index}`} item={item} />
								))
							)}
						</div>
					</section>
				</div>
			)}

			<BottomNav />
		</div>
	);
}

function AnalysisRow({ item }: { item: AnalysisItem }) {
	const hasValue = item.value != null && item.value.trim().length > 0;
	return (
		<div className="rounded-xl bg-secondary/60 p-3 text-center">
			<p className="text-center text-[10px] font-bold text-muted-foreground">{item.label}</p>
			<p
				className={cn(
					'mt-1 break-words text-center text-sm font-black',
					!hasValue && 'text-muted-foreground',
					hasValue && item.tone === 'up' && 'text-positive',
					hasValue && item.tone === 'down' && 'text-destructive',
				)}
			>
				{hasValue ? item.value : '데이터 없음'}
			</p>
			{item.note && (
				<p className="mt-1 break-keep text-center text-[10px] font-semibold leading-relaxed text-muted-foreground">
					{item.note}
				</p>
			)}
		</div>
	);
}

function StateBox({ children, error }: { children: React.ReactNode; error?: boolean }) {
	return (
		<div
			className={cn(
				'rounded-2xl border p-4 text-center text-xs font-bold',
				error
					? 'border-destructive/40 bg-destructive/10 text-destructive'
					: 'border-card-border bg-card text-muted-foreground',
			)}
		>
			{children}
		</div>
	);
}
