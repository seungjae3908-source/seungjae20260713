// GET /api/market/ai-chart-plan 백엔드 서비스.
// 실제 캔들/ATR/지지저항/추세 기반. 조회 전용 — 실제 주문 연결 절대 금지.

import {
  atr,
  supportResistance,
  trendState,
  avg,
  last,
  lastNonNull,
  macd,
  rsi,
  volumeState,
  type Bar,
} from './candle-math';
import { loadBars } from './candle-loader';

export interface AiChartPlan {
  ok: boolean;
  symbol: string;
  view: '매수' | '매도' | '중립';
  target: number | null;
  stop: number | null;
  buyLevels: (number | null)[];
  sellLevels: (number | null)[];
  basis: string[];
  invalidation: string[];
  risks: string[];
  dataAsOf: string;
}

function round(v: number | null): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : abs >= 10 ? 2 : 4;
  return Number(v.toFixed(digits));
}

function evenLevels(from: number, to: number, steps: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= steps; i += 1) {
    out.push(from + ((to - from) * i) / (steps + 1));
  }
  return out;
}

export async function getAiChartPlan(
  asset: 'stock' | 'coin',
  coinMarket: string,
  symbol: string,
  interval: string,
  options: { allowFutures?: boolean } = {},
  barsOverride?: Bar[],
): Promise<AiChartPlan> {
  const bars = barsOverride ?? await loadBars(asset, coinMarket, symbol, interval, options);
  const dataAsOf = new Date().toISOString();

  const empty: AiChartPlan = {
    ok: true,
    symbol,
    view: '중립',
    target: null,
    stop: null,
    buyLevels: [null, null, null],
    sellLevels: [null, null, null],
    basis: ['분석 가능한 데이터가 없습니다.'],
    invalidation: [],
    risks: [],
    dataAsOf,
  };

  if (bars.length < 30) return empty;

  const closes = bars.map((b) => b.close);
  const latest = last(closes);
  if (latest == null) return empty;

  const atrSeries = atr(bars, 14);
  const atrValue = lastNonNull(atrSeries);
  const { support, resistance } = supportResistance(bars, 60);
  const trend = trendState(closes);
  const ma20 = avg(closes.slice(-20));
  const recentHigh = Math.max(...bars.slice(-60).map((b) => b.high));
  const rsiValue = lastNonNull(rsi(closes, 14));
  const macdResult = macd(closes);
  const macdValue = lastNonNull(macdResult.macd);
  const macdSignal = lastNonNull(macdResult.signal);
  const volume = volumeState(bars);

  let directionScore = trend === '상승추세' ? 2 : trend === '하락추세' ? -2 : 0;
  if (rsiValue != null && rsiValue >= 55 && rsiValue < 70) directionScore += 1;
  if (rsiValue != null && rsiValue > 30 && rsiValue <= 45) directionScore -= 1;
  if (macdValue != null && macdSignal != null) {
    directionScore += macdValue > macdSignal ? 1 : macdValue < macdSignal ? -1 : 0;
  }
  const view: AiChartPlan['view'] =
    directionScore >= 2 ? '매수' : directionScore <= -2 ? '매도' : '중립';

  const target = round(resistance != null ? Math.max(resistance, recentHigh) : recentHigh);
  const stop =
    support != null && atrValue != null
      ? round(support - atrValue)
      : support != null
        ? round(support)
        : null;

  const buyLevels: (number | null)[] = [null, null, null];
  if (support != null && latest > support) {
    const levels = evenLevels(latest, support, 3);
    buyLevels[0] = round(levels[0]);
    buyLevels[1] = round(levels[1]);
    buyLevels[2] = round(levels[2]);
  }

  const sellLevels: (number | null)[] = [null, null, null];
  const sellTarget = target ?? recentHigh;
  if (sellTarget != null && sellTarget > latest) {
    const levels = evenLevels(latest, sellTarget, 3);
    sellLevels[0] = round(levels[0]);
    sellLevels[1] = round(levels[1]);
    sellLevels[2] = round(levels[2]);
  }

  const basis: string[] = [];
  basis.push(`현재가 ${round(latest)}, 추세 판정: ${trend}`);
  if (ma20 != null) basis.push(`20일선 ${round(ma20)} 대비 ${latest >= ma20 ? '위' : '아래'}`);
  if (support != null) basis.push(`최근 60봉 지지선 ${round(support)}`);
  if (resistance != null) basis.push(`최근 60봉 저항선 ${round(resistance)}`);
  if (atrValue != null) basis.push(`ATR14 ${round(atrValue)} (변동성 기준 손절폭)`);
  basis.push(`거래량 상태: ${volume}`);
  if (rsiValue != null) basis.push(`RSI14 ${rsiValue.toFixed(1)}`);
  if (macdValue != null && macdSignal != null) {
    basis.push(`MACD ${round(macdValue)} · 시그널 ${round(macdSignal)} (${macdValue >= macdSignal ? '상승 우위' : '하락 우위'})`);
  }

  const invalidation: string[] = [];
  if (view === '매수' && stop != null) invalidation.push(`종가가 손절선 ${stop} 이탈 시 매수 관점 무효`);
  if (view === '매도' && resistance != null) invalidation.push(`종가가 저항선 ${round(resistance)} 돌파 시 매도 관점 무효`);
  if (ma20 != null) invalidation.push(`20일선 ${round(ma20)} ${view === '매도' ? '회복' : '이탈'} 지속 시 관점 재검토`);
  if (!invalidation.length) invalidation.push('추세 반전 신호 발생 시 관점 재검토');

  const risks: string[] = [];
  if (atrValue != null && latest > 0) {
    risks.push(`ATR 기준 1봉 변동폭 약 ${((atrValue / latest) * 100).toFixed(1)}% — 변동성 위험`);
  }
  if (trend === '횡보') risks.push('추세 방향성이 불명확해 신뢰도 낮음');
  if (rsiValue != null && rsiValue >= 70) risks.push('RSI 과매수 구간으로 단기 조정 위험');
  if (rsiValue != null && rsiValue <= 30) risks.push('RSI 과매도 구간으로 급반등 변동성 위험');
  if (volume.includes('감소')) risks.push('거래량이 감소해 현재 방향의 신뢰도가 낮음');
  risks.push('본 계획은 조회 전용 참고 정보이며 실제 주문과 연결되지 않습니다.');

  return {
    ok: true,
    symbol,
    view,
    target,
    stop,
    buyLevels,
    sellLevels,
    basis,
    invalidation,
    risks,
    dataAsOf,
  };
}
