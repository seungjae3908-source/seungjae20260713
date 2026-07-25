import { useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { Panel, Bar } from '@/components/ui-bits';
import { ScoreRing } from '@/components/score-ring';
import { LoadingState, ErrorState } from '@/components/data-state';
import { useRisk } from '@/hooks/use-stock-data';
import { RISK_KO, riskTone, toneBadge, type Tone } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { ApiError, type RiskEvent, type RiskEventStatus } from '@/lib/api';

const STATUS_META: Record<
	Exclude<RiskEventStatus, 'IGNORED'>,
	{ label: string; tone: Tone; desc: string }
> = {
	CURRENT: {
		label: '현재',
		tone: 'destructive',
		desc: '현재 유효한 리스크입니다. 반드시 확인이 필요합니다.',
	},
	WATCH: {
		label: '관찰',
		tone: 'warning',
		desc: '아직 유효하지만 시간이 지난 항목으로, 지속 관찰이 필요합니다.',
	},
	HISTORICAL: {
		label: '과거',
		tone: 'neutral',
		desc: '과거 이력으로, 현재 영향은 제한적입니다.',
	},
};

const STATUS_ORDER: Exclude<RiskEventStatus, 'IGNORED'>[] = [
	'CURRENT',
	'WATCH',
	'HISTORICAL',
];

function statusBadge(status: RiskEventStatus): string {
	if (status === 'IGNORED') return toneBadge('neutral');
	return toneBadge(STATUS_META[status].tone);
}

function formatDate(date: string | null): string {
	// #19: null date must read 날짜 확인 필요, never a fabricated date.
	return date && date.trim() ? date : '날짜 확인 필요';
}

function EventDetailModal({
	event,
	onClose,
}: {
	event: RiskEvent;
	onClose: () => void;
}) {
	const meta =
		event.status === 'IGNORED'
			? { label: '해소/무시', tone: 'neutral' as Tone, desc: '해소되었거나 상위 공시로 대체된 항목입니다.' }
			: STATUS_META[event.status];

	return (
		<div
			className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
			role="dialog"
			aria-modal="true"
		>
			<div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
			<div className="relative z-10 max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-card-border bg-card p-4 sm:rounded-2xl">
				<div className="mb-3 flex items-start justify-between gap-2">
					<div className="min-w-0">
						<div className="mb-1 flex flex-wrap items-center gap-2">
							<span className={cn('rounded-full border px-2 py-0.5 text-xs font-semibold', statusBadge(event.status))}>
								{meta.label}
							</span>
							<span className={cn('rounded-full border px-2 py-0.5 text-xs font-medium', toneBadge(riskTone(event.level)))}>
								위험 {RISK_KO[event.level]}
							</span>
							<span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
								{event.label}
							</span>
						</div>
						<h3 className="break-keep text-base font-bold leading-relaxed">{event.title}</h3>
					</div>
					<button onClick={onClose} aria-label="닫기" className="rounded-lg p-1 hover:bg-secondary">
						<X className="h-5 w-5" />
					</button>
				</div>

				<div className="space-y-3">
					<div>
						<div className="mb-1 text-xs font-semibold text-muted-foreground">요약</div>
						<p className="break-keep text-sm leading-relaxed">{event.summary}</p>
					</div>

					<div className="grid grid-cols-2 gap-3">
						<div>
							<div className="mb-0.5 text-xs font-semibold text-muted-foreground">날짜</div>
							<p className="break-keep text-sm leading-relaxed">{formatDate(event.date)}</p>
						</div>
						<div>
							<div className="mb-0.5 text-xs font-semibold text-muted-foreground">출처</div>
							<p className="break-keep text-sm leading-relaxed">{event.source}</p>
						</div>
					</div>

					<div>
						<div className="mb-1 text-xs font-semibold text-muted-foreground">상태 안내</div>
						<p className="break-keep rounded-lg border border-border bg-secondary/40 p-2.5 text-sm leading-relaxed text-muted-foreground">
							{meta.desc}
						</p>
					</div>

					{event.url ? (
						<a
							href={event.url}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1 text-sm text-blue-400"
						>
							<ExternalLink className="h-4 w-4" />
							원문 보기
						</a>
					) : (
						<p className="text-xs text-muted-foreground">원문 링크 없음</p>
					)}
				</div>
			</div>
		</div>
	);
}

function EventRow({
	event,
	onOpen,
}: {
	event: RiskEvent;
	onOpen: (event: RiskEvent) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onOpen(event)}
			className="w-full rounded-xl bg-secondary/40 p-3 text-left transition-colors hover:bg-secondary/70"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<span className={cn('rounded-full border px-2 py-0.5 text-xs font-medium', toneBadge(riskTone(event.level)))}>
							위험 {RISK_KO[event.level]}
						</span>
						<span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
							{event.label}
						</span>
					</div>
					<p className="mt-2 break-keep text-sm font-semibold leading-relaxed">{event.title}</p>
					<p className="mt-1 break-keep text-xs leading-relaxed text-muted-foreground">{event.summary}</p>
				</div>
				<span className="shrink-0 font-mono text-xs text-muted-foreground">
					{formatDate(event.date)}
				</span>
			</div>
		</button>
	);
}

export function RiskTab({ ticker, active }: { ticker: string; active: boolean }) {
	const { data, isLoading, isError, error, refetch } = useRisk(ticker, active);
	const [selected, setSelected] = useState<RiskEvent | null>(null);

	if (isLoading) return <LoadingState />;
	if (isError || !data)
		return <ErrorState code={error instanceof ApiError ? error.code : undefined} onRetry={() => refetch()} />;

	const events = data.events ?? [];
	const grouped = STATUS_ORDER.map((status) => ({
		status,
		meta: STATUS_META[status],
		items: events.filter((e) => e.status === status),
	})).filter((g) => g.items.length > 0);

	return (
		<div className="space-y-3">
			<Panel title="종합 위험도">
				<div className="flex items-center justify-between gap-3">
					<div className="space-y-2">
						<span className={cn('inline-block rounded-full border px-3 py-1.5 text-sm font-semibold', toneBadge(riskTone(data.overallLevel)))}>
							위험 {RISK_KO[data.overallLevel]}
						</span>
						<p className="max-w-[220px] break-keep text-xs leading-relaxed text-muted-foreground">{data.explanation}</p>
					</div>
					<ScoreRing score={data.overallScore} tone={riskTone(data.overallLevel)} label="위험 점수" />
				</div>
			</Panel>

			{events.length > 0 ? (
				grouped.map((group) => (
					<Panel
						key={group.status}
						title={`${group.meta.label} 리스크 (${group.items.length})`}
						right={
							<span className={cn('rounded-full border px-2 py-0.5 text-xs font-semibold', toneBadge(group.meta.tone))}>
								{group.meta.label}
							</span>
						}
					>
						<p className="mb-2 break-keep text-xs leading-relaxed text-muted-foreground">
							{group.meta.desc}
						</p>
						<ul className="space-y-2">
							{group.items.map((event) => (
								<li key={event.id}>
									<EventRow event={event} onOpen={setSelected} />
								</li>
							))}
						</ul>
					</Panel>
				))
			) : (
				<Panel title="리스크 이벤트">
					<p className="break-keep text-sm leading-relaxed text-muted-foreground">
						현재 표시할 리스크 이벤트가 없습니다.
					</p>
				</Panel>
			)}

			<Panel title={data.market === 'US' ? '해외 주식 위험 항목' : '한국 주식 위험 항목'}>
				<ul className="space-y-3.5">
					{data.items.map((item) => (
						<li key={item.label} className="space-y-1.5">
							<div className="flex items-center justify-between gap-2">
								<span className="break-keep text-sm font-medium leading-relaxed">{item.label}</span>
								<span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium', toneBadge(riskTone(item.level)))}>
									{RISK_KO[item.level]} · {item.score}
								</span>
							</div>
							<Bar value={item.score} tone={riskTone(item.level)} />
							<p className="break-keep text-xs leading-relaxed text-muted-foreground">{item.explanation}</p>
						</li>
					))}
				</ul>
			</Panel>

			{selected && <EventDetailModal event={selected} onClose={() => setSelected(null)} />}
		</div>
	);
}
