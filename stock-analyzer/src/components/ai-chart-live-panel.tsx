import { useEffect, useRef, useState } from 'react';
import { useChartCurrency } from './chart-currency-provider';
import { buildChartLiveEvents, isChartLiveSnapshotUsable, mergeChartLiveEvents, type ChartLiveEvent, type ChartLiveEventKind, type ChartLiveSnapshot } from '@/lib/chart-live-feed';

export type { ChartLiveSnapshot } from '@/lib/chart-live-feed';
const filters: Array<{ value: ChartLiveEventKind | 'all'; label: string }> = [{ value: 'all', label: '전체' }, { value: 'analysis', label: '판단' }, { value: 'pattern', label: '패턴' }, { value: 'wave', label: '파동' }, { value: 'data', label: '데이터' }];
const levelLabels: Record<string, string> = { support: '지지', resistance: '저항', target: '참고 목표', invalidation: '무효화' };
const timeLabel = (value: number) => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const label = { candidate: '후보 감지', confirmed: '돌파 확인', invalidated: '무효화' };

export function AiChartLivePanel({ snapshot }: { snapshot: ChartLiveSnapshot | null }) {
  const { format } = useChartCurrency();
  const previous = useRef<ChartLiveSnapshot | null>(null);
  const [events, setEvents] = useState<ChartLiveEvent[]>([]);
  const [paused, setPaused] = useState<ChartLiveEvent[] | null>(null);
  const [filter, setFilter] = useState<ChartLiveEventKind | 'all'>('all');
  useEffect(() => {
    if (!snapshot) { previous.current = null; setEvents([]); setPaused(null); return; }
    const prior = previous.current;
    previous.current = snapshot;
    const next = buildChartLiveEvents(prior, snapshot);
    if (!prior || prior.identity !== snapshot.identity) { setEvents(mergeChartLiveEvents([], next, snapshot.identity)); setPaused(null); }
    else if (next.length) setEvents(current => mergeChartLiveEvents(current, next, snapshot.identity));
  }, [snapshot]);
  const recorded = snapshot ? (paused ?? events).filter(event => event.identity === snapshot.identity) : [];
  const visible = filter === 'all' ? recorded : recorded.filter(event => event.kind === filter);
  const halted = snapshot && !isChartLiveSnapshotUsable(snapshot);
  const validAsOf = snapshot?.asOf != null && Number.isFinite(snapshot.asOf) && snapshot.asOf > 0 && snapshot.asOf <= Date.now();
  const status = snapshot && ['ok', 'delayed'].includes(snapshot.dataState) && !validAsOf ? '가격 기준 시각 미확인' : snapshot?.status;
  return <section data-testid="ai-chart-live-feed" className="min-w-0 rounded-2xl border border-card-border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-black">AI 생중계</h2><div className="flex gap-1">
      <button type="button" aria-pressed={paused !== null} className="min-h-11 rounded-lg border border-card-border px-3 text-xs" onClick={() => setPaused(paused !== null ? null : [...events])}>{paused !== null ? '재개' : '일시정지'}</button>
      <button type="button" className="min-h-11 rounded-lg px-3 text-xs text-muted-foreground" onClick={() => { setEvents([]); if (paused !== null) setPaused([]); }}>비우기</button>
    </div></div>
    <p className="mt-2 break-words text-xs text-muted-foreground">{status ?? '연결 대기'} · {snapshot?.source ?? '시세 확인 중'} · {snapshot?.transport ?? '연결 확인 중'}</p>
    <p className="mt-2 text-[11px] text-muted-foreground">규칙 기반 기술분석 · LLM 해설 아님 · 주문 실행 없음</p>
    <p data-testid="chart-live-data-asof" className="mt-2 text-[11px] tabular-nums text-muted-foreground">가격 데이터 기준: {validAsOf ? timeLabel(snapshot!.asOf!) : '미확인'} · 한국시간</p>
    {halted && <p role="status" data-testid="chart-live-halted" className="mt-3 rounded-xl bg-warning/10 p-3 text-xs font-bold text-warning">{status} · 새 판단 중단. 아래 기록은 이전 관측이며 현재 매매 신호가 아닙니다.</p>}
    {paused !== null && <p role="status" className="mt-2 text-xs text-muted-foreground">기록 표시만 일시정지 · 차트와 데이터 갱신은 계속됩니다.</p>}
    <div role="group" aria-label="생중계 기록 필터" className="mt-3 flex flex-wrap gap-1">{filters.map(item => <button key={item.value} type="button" aria-pressed={filter === item.value} onClick={() => setFilter(item.value)} className={`min-h-11 rounded-lg border px-2 text-xs ${filter === item.value ? 'border-primary bg-primary/10 text-primary' : 'border-card-border text-muted-foreground'}`}>{item.label}</button>)}</div>
    <p className="mt-2 text-[11px] text-muted-foreground">최근 {recorded.length}/100건 · 최신순</p>
    <div role="log" aria-label="차트 변화 기록" aria-live="off" className="mt-3 max-h-[32rem] space-y-2 overflow-y-auto overscroll-contain">
      {visible.length ? visible.map(event => <article key={event.id} data-testid="chart-live-event" data-event-kind={event.kind} className="rounded-xl bg-background p-3">
        <time dateTime={new Date(event.at).toISOString()} className="text-[11px] tabular-nums text-muted-foreground">{timeLabel(event.at)}</time>
        <h3 className="mt-1 break-keep text-xs font-bold">{event.title}</h3><p className="mt-2 break-words text-xs leading-5 text-muted-foreground">{event.detail}</p>
        {event.price != null && <p className="mt-2 text-xs tabular-nums text-primary">관측 가격 {format(event.price, event.market)}</p>}
        {event.levels?.length ? <dl className="mt-2 grid grid-cols-2 gap-2 text-[11px]">{event.levels.map((level, index) => <div key={`${level.role}:${index}`} className="min-w-0"><dt className="text-muted-foreground">{levelLabels[level.role] ?? level.role}</dt><dd className="break-words font-bold tabular-nums">{format(level.price, event.market)}</dd></div>)}</dl> : null}
        {event.confirmation?.map((condition, index) => <p key={`confirm:${index}`} className="mt-2 text-[11px] leading-5">확인 조건 · {condition}</p>)}
        {event.invalidation?.map((condition, index) => <p key={`invalidate:${index}`} className="mt-2 text-[11px] leading-5 text-warning">무효화 조건 · {condition}</p>)}
      </article>) : <p className="py-6 text-center text-xs text-muted-foreground">{snapshot ? '선택한 기록 없음 · 새로운 관측 변화를 기다리는 중' : '현재 종목의 데이터를 기다리는 중'}</p>}
    </div>
  </section>;
}

export function AiChartDrawingSummary({ snapshot }: { snapshot: ChartLiveSnapshot | null }) {
  const { format } = useChartCurrency();
  return <section data-testid="ai-chart-drawing-summary" className="rounded-2xl border border-card-border bg-card p-4">
    <h2 className="text-sm font-black">패턴·파동 후보</h2>
    {snapshot?.drawing.patterns.length ? snapshot.drawing.patterns.map(pattern => <div key={pattern.id} className="mt-3 rounded-xl bg-background p-3 text-xs">
      <div className="flex justify-between gap-2"><strong>{pattern.name}</strong><span className={pattern.status === 'invalidated' ? 'text-destructive' : 'text-primary'}>{label[pattern.status]}</span></div>
      <dl className="mt-2 grid grid-cols-2 gap-2"><dt className="text-muted-foreground">돌파 확인가</dt><dd className="text-right tabular-nums">{format(pattern.confirmation, snapshot.market)}</dd><dt className="text-muted-foreground">측정 목표 구간</dt><dd className="text-right tabular-nums">{format(pattern.target[0], snapshot.market)} ~ {format(pattern.target[1], snapshot.market)}</dd><dt className="text-muted-foreground">무효화 가격</dt><dd className="text-right tabular-nums text-destructive">{format(pattern.invalidation, snapshot.market)}</dd></dl>
      {pattern.direction === 'both' && <p className="mt-2 text-muted-foreground">상단 돌파 시나리오 · 방향 미확정</p>}
    </div>) : <p className="mt-3 text-xs text-muted-foreground">조건을 만족하는 패턴 없음</p>}
    {snapshot?.drawing.waves.map(wave => <p key={wave.id} className="mt-3 text-xs font-bold text-primary">{wave.name}{wave.points.some(p => p.label === 'C') ? ' · A–B–C 후보' : ''}</p>)}
    <p className="mt-3 text-[11px] text-muted-foreground">파동은 후보 · 점선 끝점은 미확정 · 목표는 측정치</p>
  </section>;
}
