import type { AnalysisMarket } from './analysis-selection';
import type { ChartAnalysis } from './chart-analysis';
import type { AutoDrawing } from './chart-auto-drawing';

export type ChartLiveSnapshot = {
  identity: string; market: AnalysisMarket; analysis: ChartAnalysis | null; drawing: AutoDrawing;
  price: number | null; closedTime: number | null; volumeRatio: number | null;
  source: string; status: string;
  dataState: 'ok' | 'delayed' | 'stale' | 'insufficient' | 'unavailable';
  transport: '공개 WS 검증' | 'REST 주기 조회';
  asOf: number | null;
};
export type ChartLiveEventKind = 'analysis' | 'pattern' | 'wave' | 'bar' | 'data';
export type ChartLiveEvent = {
  id: string; identity: string; kind: ChartLiveEventKind; at: number;
  title: string; detail: string; source: string; market: AnalysisMarket; price?: number;
  levels?: ChartAnalysis['priceLevels']; confirmation?: string[]; invalidation?: string[];
};
export const CHART_LIVE_EVENT_LIMIT = 100;
export const ANALYSIS_STATUS_LABELS: Record<ChartAnalysis['status'], string> = {
  forming: '형성 중', candidate: '후보', confirmed: '확정',
  weakened: '약화', invalidated: '무효화', expired: '만료',
};
const PATTERN_STATUS_LABELS = { candidate: '후보 감지', confirmed: '돌파 확인', invalidated: '무효화' };
const safeTime = (value: number | null, now: number) => value != null && Number.isFinite(value) && value > 0 && value <= now;
const safePrice = (value: number | null | undefined) => value != null && Number.isFinite(value) && value > 0 ? value : undefined;
export function isChartLiveSnapshotUsable(snapshot: ChartLiveSnapshot, now = Date.now()): boolean {
  return ['ok', 'delayed'].includes(snapshot.dataState) && safeTime(snapshot.asOf, now);
}
function matchingAnalysis(snapshot: ChartLiveSnapshot): ChartAnalysis | null {
  const analysis = snapshot.analysis;
  return analysis && `${analysis.market}:${analysis.symbol}:${analysis.timeframe}` === snapshot.identity ? analysis : null;
}

/** Observed transitions only: no timer-driven story and no execution signal. */
export function buildChartLiveEvents(previous: ChartLiveSnapshot | null, snapshot: ChartLiveSnapshot, now = Date.now()): ChartLiveEvent[] {
  if (!Number.isFinite(now) || now <= 0 || !snapshot.identity) return [];
  const prior = previous?.identity === snapshot.identity ? previous : null;
  const at = safeTime(snapshot.asOf, now) ? snapshot.asOf! : now;
  const events: ChartLiveEvent[] = [];
  const add = (kind: ChartLiveEventKind, key: string, title: string, detail: string, extra: Partial<ChartLiveEvent> = {}) => {
    events.push({ id: `${snapshot.identity}:${kind}:${key}`, identity: snapshot.identity,
      kind, at, title, detail, source: snapshot.source, market: snapshot.market, ...extra });
  };
  const usable = isChartLiveSnapshotUsable(snapshot, now);
  // An outage/reconnect or provider switch is a new observation baseline.
  // Never turn bars that accumulated while disconnected into live-completed
  // candles or volume-surges just because a fresh snapshot has arrived.
  const continuousSource = usable && prior != null && isChartLiveSnapshotUsable(prior, now)
    && prior.source === snapshot.source && prior.transport === snapshot.transport;
  if (!prior || prior.dataState !== snapshot.dataState || prior.source !== snapshot.source || prior.transport !== snapshot.transport
    || isChartLiveSnapshotUsable(prior, now) !== usable) {
    const status = ['ok', 'delayed'].includes(snapshot.dataState) && !usable ? '가격 기준 시각 미확인' : snapshot.status;
    add('data', `${now}:${snapshot.dataState}:${snapshot.source}:${snapshot.transport}:${usable}`, `데이터 상태 · ${status}`,
      `${snapshot.source} · ${snapshot.transport}${usable ? '' : ' · 새 판단 중단'}`, { at: now });
  }
  if (!usable) return events;
  const analysis = matchingAnalysis(snapshot);
  const priorAnalysis = prior && isChartLiveSnapshotUsable(prior, now) ? matchingAnalysis(prior) : null;
  if (analysis && (!priorAnalysis || analysis.id !== priorAnalysis.id || analysis.status !== priorAnalysis.status || analysis.bias !== priorAnalysis.bias)) {
    const direction = analysis.bias === 'bullish' ? '상승 우세' : analysis.bias === 'bearish' ? '하락 우세' : '판단 보류';
    add('analysis', `${analysis.id}:${analysis.status}:${analysis.bias}:${snapshot.closedTime}`,
      `현재 판단 · ${direction} · ${ANALYSIS_STATUS_LABELS[analysis.status]}`,
      [analysis.transitionReason || analysis.summary, ...analysis.reasons.slice(0, 3)].filter(Boolean).join(' · '), {
        price: safePrice(snapshot.price), levels: analysis.priceLevels.filter(level => safePrice(level.price) != null).slice(0, 4),
        confirmation: analysis.confirmationConditions.slice(0, 2), invalidation: analysis.invalidationConditions.slice(0, 2),
      });
  }
  if (continuousSource && prior?.closedTime != null && snapshot.closedTime != null && safeTime(snapshot.closedTime * 1000, now)
    && snapshot.closedTime > prior.closedTime) {
    add('bar', String(snapshot.closedTime), '새 완료봉 · 판단 갱신', '완료봉만 확정 판단에 사용합니다.',
      { at: snapshot.closedTime * 1000, price: safePrice(snapshot.price) });
  }
  for (const pattern of snapshot.drawing.patterns) {
    if (!safeTime(pattern.eventAt * 1000, now) || prior?.drawing.patterns.some(item => item.id === pattern.id && item.status === pattern.status)) continue;
    add('pattern', `${pattern.id}:${pattern.status}:${pattern.eventAt}`, `${pattern.name} · ${PATTERN_STATUS_LABELS[pattern.status]}`,
      pattern.status === 'candidate' ? '아직 돌파 미확인 · 측정 목표는 예측이나 승률이 아닙니다.' : '완료봉 기준 상태 · 목표 도달을 보장하지 않습니다.',
      { at: pattern.eventAt * 1000, price: safePrice(pattern.confirmation) });
  }
  for (const wave of snapshot.drawing.waves) {
    const last = wave.points.at(-1);
    if (!last || !safeTime(last.confirmedAt * 1000, now)) continue;
    const signature = wave.points.map(point => `${point.label}:${point.time}`).join('|');
    if (prior?.drawing.waves.some(item => item.id === wave.id && item.points.map(point => `${point.label}:${point.time}`).join('|') === signature)) continue;
    add('wave', `${wave.id}:${signature}`, `${wave.name}${last.label === 'C' ? ' · A–B–C 후보' : ''}`,
      '관측된 스윙 기반 후보 · 미래 파동을 확정하지 않습니다.', { at: last.confirmedAt * 1000 });
  }
  if (continuousSource && prior?.volumeRatio != null && Number.isFinite(prior.volumeRatio)
    && Number.isFinite(snapshot.volumeRatio) && snapshot.volumeRatio! >= 1.8 && prior.volumeRatio < 1.8) {
    add('bar', `volume:${snapshot.closedTime}:${at}`, `거래량 증가 · ${snapshot.volumeRatio!.toFixed(1)}배`, '최근 평균 대비 거래량입니다. 방향이나 수익을 보장하지 않습니다.');
  }
  return events;
}

export function mergeChartLiveEvents(current: readonly ChartLiveEvent[], next: readonly ChartLiveEvent[], identity: string): ChartLiveEvent[] {
  const seen = new Set<string>();
  return [...next, ...current].filter(event => {
    if (event.identity !== identity || !Number.isFinite(event.at) || seen.has(event.id)) return false;
    seen.add(event.id); return true;
  }).sort((a, b) => b.at - a.at).slice(0, CHART_LIVE_EVENT_LIMIT);
}
