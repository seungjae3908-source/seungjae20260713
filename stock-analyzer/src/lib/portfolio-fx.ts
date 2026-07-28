// 시장현황(/api/market/summary)에서 USD/KRW 실환율을 추출하는 공용 훅.
import { useQuery } from '@tanstack/react-query';
import { api, type SummaryItem } from '@/lib/api';

export interface FxState {
	rate: number | null; // KRW per 1 USD
	updatedAt: string | null;
	isLoading: boolean;
	isError: boolean;
	refetch: () => void;
}

/** /api/market/summary 에서 usdkrw 항목을 찾아 실환율을 반환한다. 없으면 null. */
export function useUsdKrwRate(): FxState {
	const query = useQuery({
		queryKey: ['portfolio-fx-usdkrw'],
		queryFn: () => api.summary(),
		refetchInterval: 60_000,
	});

	const items = (query.data?.items ?? []) as SummaryItem[];
	const usdkrw = items.find(
		(item) => item.key === 'usdkrw' && item.ok && item.price > 0,
	);

	return {
		rate: usdkrw ? usdkrw.price : null,
		updatedAt:
			(query.data as { updatedAt?: string } | undefined)?.updatedAt ?? null,
		isLoading: query.isLoading,
		isError: query.isError,
		refetch: () => void query.refetch(),
	};
}

export function formatKstTime(value: string | null | undefined): string {
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
