import { useEffect, useRef, useState } from 'react';
import { useChartCurrency } from './chart-currency-provider';
import type { AnalysisMarket } from '@/lib/analysis-selection';
import type { ChartAnalysis } from '@/lib/chart-analysis';
import type { AutoDrawing } from '@/lib/chart-auto-drawing';

export type ChartLiveSnapshot = { identity: string; market: AnalysisMarket; analysis: ChartAnalysis | null; drawing: AutoDrawing; price: number | null; closedTime: number | null; volumeRatio: number | null; source: string; status: string; asOf: number | null };
type Event = { id: string; at: number; title: string; price?: number };
const label = { candidate: '후보 감지', confirmed: '돌파 확인', invalidated: '무효화' };

export function AiChartLivePanel({ snapshot }: { snapshot: ChartLiveSnapshot | null }) {
  const { format } = useChartCurrency();
  const previous = useRef<ChartLiveSnapshot | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [paused, setPaused] = useState<Event[] | null>(null);
  useEffect(() => {
    if (!snapshot) return;
    const prior = previous.current;
    previous.current = snapshot;
    if (!prior || prior.identity !== snapshot.identity) { setEvents([]); setPaused(null); return; }
    const next: Event[] = [];
    const at = snapshot.asOf;
    if (at == null) return;
    if (snapshot.status !== prior.status) next.push({ id: `status:${at}:${snapshot.status}`, at, title: `데이터 상태 · ${snapshot.status}` });
    if (snapshot.closedTime && snapshot.closedTime !== prior.closedTime) next.push({ id: `bar:${snapshot.closedTime}`, at: snapshot.closedTime * 1000, title: '새 완료봉 · 판단 갱신', price: snapshot.price ?? undefined });
    for (const pattern of snapshot.drawing.patterns) {
      if (!prior.drawing.patterns.some(p => p.id === pattern.id && p.status === pattern.status)) next.push({ id: `${pattern.id}:${pattern.status}`, at: pattern.eventAt * 1000, title: `${pattern.name} · ${label[pattern.status]}`, price: pattern.confirmation });
    }
    for (const wave of snapshot.drawing.waves) {
      if (!prior.drawing.waves.some(w => w.id === wave.id)) next.push({ id: wave.id, at: wave.points.at(-1)!.confirmedAt * 1000, title: wave.name });
    }
    if ((snapshot.volumeRatio ?? 0) >= 1.8 && (prior.volumeRatio ?? 0) < 1.8) next.push({ id: `volume:${snapshot.closedTime}`, at, title: `거래량 증가 · ${snapshot.volumeRatio!.toFixed(1)}배` });
    if (next.length) setEvents(current => [...next.reverse(), ...current].filter((event, i, all) => all.findIndex(x => x.id === event.id) === i).slice(0, 100));
  }, [snapshot]);
  const visible = paused ?? events;
  return <section data-testid="ai-chart-live-feed" className="min-w-0 rounded-2xl border border-card-border bg-card p-4">
    <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-black">AI 생중계</h2><div className="flex gap-1">
      <button type="button" className="min-h-9 rounded-lg border border-card-border px-2 text-xs" onClick={() => setPaused(paused ? null : [...events])}>{paused ? '재개' : '일시정지'}</button>
      <button type="button" className="min-h-9 rounded-lg px-2 text-xs text-muted-foreground" onClick={() => { setEvents([]); if (paused) setPaused([]); }}>비우기</button>
    </div></div>
    <p className="mt-2 text-xs text-muted-foreground">{snapshot?.status ?? '연결 대기'} · {snapshot?.source ?? '시세 확인 중'} · 자동 기술분석</p>
    <div role="log" aria-label="차트 변화 기록" aria-live="off" className="mt-3 max-h-[32rem] space-y-2 overflow-y-auto">
      {visible.length ? visible.map(event => <div key={event.id} className="rounded-xl bg-background p-3"><time className="text-[11px] tabular-nums text-muted-foreground">{new Date(event.at).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' })}</time><p className="mt-1 text-xs font-bold">{event.title}</p>{event.price != null && snapshot && <p className="mt-1 text-xs tabular-nums text-primary">{format(event.price, snapshot.market)}</p>}</div>) : <p className="py-6 text-center text-xs text-muted-foreground">새 봉·패턴·거래량 변화를 기다리는 중</p>}
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
