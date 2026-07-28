// GET /api/market/chart-signals 백엔드 서비스.
// 매 호출 시 실제 캔들에서 재계산 → 조건을 만족하는 신호만 존재.
// id = kind:name:barTime 로 안정적. 가짜 신호 생성 금지, 불확실하면 미표시.

import {
  avg,
  sma,
  rsi,
  macd,
  bollinger,
  type Bar,
} from './candle-math';
import { loadBars } from './candle-loader';

export interface ChartSignal {
  id: string;
  kind: 'chart' | 'candle' | 'indicator';
  name: string;
  occurredAt: string;
  price: number;
  barTime: number | string;
  importance: string;
  meaningGeneral: string;
  meaningHere: string;
  confirmations: string[];
  invalidation: string[];
  risk: string;
  overlay: {
    type: 'candle' | 'vline' | 'zone' | 'level';
    fromTime?: number | string;
    toTime?: number | string;
    level?: number;
    level2?: number;
  };
}

export interface ChartSignalsResult {
  ok: boolean;
  symbol: string;
  interval: string;
  updatedAt: string;
  signals: ChartSignal[];
}

function timeToIso(time: number | string): string {
  if (typeof time === 'number') {
    const ms = time < 1e12 ? time * 1000 : time;
    return new Date(ms).toISOString();
  }
  const parsed = Date.parse(time);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(time);
}

function push(signals: ChartSignal[], s: ChartSignal): void {
  if (!signals.some((x) => x.id === s.id)) signals.push(s);
}

function body(b: Bar): number {
  return Math.abs(b.close - b.open);
}
function range(b: Bar): number {
  return b.high - b.low;
}
function isBull(b: Bar): boolean {
  return b.close > b.open;
}

function detectCandlePatterns(bars: Bar[], signals: ChartSignal[]): void {
  const n = bars.length;
  const avgBody = avg(bars.slice(-20).map(body)) ?? 0;
  for (let i = Math.max(2, n - 3); i < n; i += 1) {
    const b = bars[i];
    const r = range(b);
    const bd = body(b);
    if (r <= 0) continue;
    const upper = b.high - Math.max(b.open, b.close);
    const lower = Math.min(b.open, b.close) - b.low;

    // 장대양봉 / 장대음봉
    if (avgBody > 0 && bd >= avgBody * 1.8 && bd / r >= 0.6) {
      const bull = isBull(b);
      push(signals, {
        id: `candle:${bull ? '장대양봉' : '장대음봉'}:${b.time}`,
        kind: 'candle',
        name: bull ? '장대양봉' : '장대음봉',
        occurredAt: timeToIso(b.time),
        price: b.close,
        barTime: b.time,
        importance: '평소보다 큰 몸통의 방향성 강한 캔들로 매수·매도 힘의 우위를 보여줍니다.',
        meaningGeneral: bull ? '강한 매수세를 의미합니다.' : '강한 매도세를 의미합니다.',
        meaningHere: `이 봉의 몸통이 최근 20봉 평균의 ${(bd / avgBody).toFixed(1)}배입니다.`,
        confirmations: ['다음 봉이 같은 방향으로 이어지는지 확인'],
        invalidation: [bull ? '다음 봉이 저가 이탈 시 무효' : '다음 봉이 고가 돌파 시 무효'],
        risk: '단발성 급변동일 수 있어 후속 확인이 필요합니다.',
        overlay: { type: 'candle', fromTime: b.time },
      });
    }

    // 도지
    if (avgBody > 0 && bd <= r * 0.1) {
      push(signals, {
        id: `candle:도지:${b.time}`,
        kind: 'candle',
        name: '도지',
        occurredAt: timeToIso(b.time),
        price: b.close,
        barTime: b.time,
        importance: '시가와 종가가 거의 같아 매수·매도 균형(추세 전환 신호)일 수 있습니다.',
        meaningGeneral: '방향성 불확실 또는 추세 전환 가능성을 의미합니다.',
        meaningHere: '몸통이 전체 범위의 10% 이하로 매우 짧습니다.',
        confirmations: ['다음 봉의 방향으로 추세 확인'],
        invalidation: ['다음 봉이 도지 범위 안에서 마감 시 의미 약화'],
        risk: '단독으로는 신뢰도가 낮습니다.',
        overlay: { type: 'candle', fromTime: b.time },
      });
    }

    // 망치형 / 역망치형 (하단 추세에서)
    if (lower >= bd * 2 && upper <= bd * 0.6 && bd > 0) {
      push(signals, {
        id: `candle:망치형:${b.time}`,
        kind: 'candle',
        name: '망치형',
        occurredAt: timeToIso(b.time),
        price: b.close,
        barTime: b.time,
        importance: '긴 아래꼬리로 저가 매수세 유입을 시사합니다.',
        meaningGeneral: '하락 후 반등 가능성을 의미합니다.',
        meaningHere: `아래꼬리가 몸통의 ${(lower / bd).toFixed(1)}배입니다.`,
        confirmations: ['다음 봉 양봉 마감 시 신뢰도 상승'],
        invalidation: ['이 봉의 저가 이탈 시 무효'],
        risk: '하락 추세 지속 시 실패할 수 있습니다.',
        overlay: { type: 'candle', fromTime: b.time },
      });
    }
    if (upper >= bd * 2 && lower <= bd * 0.6 && bd > 0) {
      push(signals, {
        id: `candle:역망치형:${b.time}`,
        kind: 'candle',
        name: '역망치형',
        occurredAt: timeToIso(b.time),
        price: b.close,
        barTime: b.time,
        importance: '긴 위꼬리로 고점 매도 압력 또는 반등 시도를 시사합니다.',
        meaningGeneral: '추세 전환 시도를 의미합니다.',
        meaningHere: `위꼬리가 몸통의 ${(upper / bd).toFixed(1)}배입니다.`,
        confirmations: ['다음 봉 방향 확인 필요'],
        invalidation: ['이 봉의 고가 돌파 실패 시 무효'],
        risk: '단독 신뢰도가 낮습니다.',
        overlay: { type: 'candle', fromTime: b.time },
      });
    }

    // 상승/하락 장악형 (2봉)
    if (i >= 1) {
      const prev = bars[i - 1];
      if (
        !isBull(prev) &&
        isBull(b) &&
        b.close >= prev.open &&
        b.open <= prev.close
      ) {
        push(signals, {
          id: `candle:상승장악형:${b.time}`,
          kind: 'candle',
          name: '상승장악형',
          occurredAt: timeToIso(b.time),
          price: b.close,
          barTime: b.time,
          importance: '직전 음봉을 양봉이 완전히 감싸 매수 전환을 시사합니다.',
          meaningGeneral: '하락 후 상승 반전 신호입니다.',
          meaningHere: '직전 음봉 몸통을 현재 양봉이 감쌌습니다.',
          confirmations: ['후속 양봉으로 추세 확인'],
          invalidation: ['현재 봉 저가 이탈 시 무효'],
          risk: '거래량 동반이 없으면 신뢰도가 낮습니다.',
          overlay: { type: 'candle', fromTime: prev.time, toTime: b.time },
        });
      }
      if (
        isBull(prev) &&
        !isBull(b) &&
        b.open >= prev.close &&
        b.close <= prev.open
      ) {
        push(signals, {
          id: `candle:하락장악형:${b.time}`,
          kind: 'candle',
          name: '하락장악형',
          occurredAt: timeToIso(b.time),
          price: b.close,
          barTime: b.time,
          importance: '직전 양봉을 음봉이 완전히 감싸 매도 전환을 시사합니다.',
          meaningGeneral: '상승 후 하락 반전 신호입니다.',
          meaningHere: '직전 양봉 몸통을 현재 음봉이 감쌌습니다.',
          confirmations: ['후속 음봉으로 추세 확인'],
          invalidation: ['현재 봉 고가 돌파 시 무효'],
          risk: '거래량 동반이 없으면 신뢰도가 낮습니다.',
          overlay: { type: 'candle', fromTime: prev.time, toTime: b.time },
        });
      }
    }

    // 샛별형 / 석별형 (3봉)
    if (i >= 2) {
      const b1 = bars[i - 2];
      const b2 = bars[i - 1];
      const midSmall = body(b2) <= body(b1) * 0.5;
      if (!isBull(b1) && midSmall && isBull(b) && b.close > (b1.open + b1.close) / 2) {
        push(signals, {
          id: `candle:샛별형:${b.time}`,
          kind: 'candle',
          name: '샛별형',
          occurredAt: timeToIso(b.time),
          price: b.close,
          barTime: b.time,
          importance: '음봉→소형봉→양봉 3봉 조합으로 바닥 반전을 시사합니다.',
          meaningGeneral: '하락 추세 바닥 반전 신호입니다.',
          meaningHere: '3봉 조합이 샛별형 구조를 형성했습니다.',
          confirmations: ['후속 양봉 확인'],
          invalidation: ['첫 음봉 저가 이탈 시 무효'],
          risk: '거래량 확인이 필요합니다.',
          overlay: { type: 'candle', fromTime: b1.time, toTime: b.time },
        });
      }
      if (isBull(b1) && midSmall && !isBull(b) && b.close < (b1.open + b1.close) / 2) {
        push(signals, {
          id: `candle:석별형:${b.time}`,
          kind: 'candle',
          name: '석별형',
          occurredAt: timeToIso(b.time),
          price: b.close,
          barTime: b.time,
          importance: '양봉→소형봉→음봉 3봉 조합으로 천장 반전을 시사합니다.',
          meaningGeneral: '상승 추세 천장 반전 신호입니다.',
          meaningHere: '3봉 조합이 석별형 구조를 형성했습니다.',
          confirmations: ['후속 음봉 확인'],
          invalidation: ['첫 양봉 고가 돌파 시 무효'],
          risk: '거래량 확인이 필요합니다.',
          overlay: { type: 'candle', fromTime: b1.time, toTime: b.time },
        });
      }
    }
  }
}

function detectIndicators(bars: Bar[], signals: ChartSignal[]): void {
  const closes = bars.map((b) => b.close);
  const n = bars.length;
  const latest = bars[n - 1];

  // 거래량 급증 (20봉 평균 대비 2배+)
  const base = avg(bars.slice(-21, -1).map((b) => b.volume));
  if (base && base > 0 && latest.volume >= base * 2) {
    push(signals, {
      id: `indicator:거래량급증:${latest.time}`,
      kind: 'indicator',
      name: '거래량 급증',
      occurredAt: timeToIso(latest.time),
      price: latest.close,
      barTime: latest.time,
      importance: '거래량이 평소의 2배 이상으로 세력·이벤트 유입 가능성을 시사합니다.',
      meaningGeneral: '큰 거래량은 추세 전환·강화의 단서입니다.',
      meaningHere: `최근 봉 거래량이 20봉 평균의 ${(latest.volume / base).toFixed(1)}배입니다.`,
      confirmations: ['가격 방향과 함께 해석'],
      invalidation: ['다음 봉 거래량 급감 시 일시적 이벤트로 판단'],
      risk: '거래량만으로 방향을 단정할 수 없습니다.',
      overlay: { type: 'vline', fromTime: latest.time },
    });
  }

  // 골든/데드크로스 (MA5/MA20, 최근 5봉 내)
  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  for (let i = Math.max(1, n - 5); i < n; i += 1) {
    const a = ma5[i];
    const aPrev = ma5[i - 1];
    const b = ma20[i];
    const bPrev = ma20[i - 1];
    if (a == null || aPrev == null || b == null || bPrev == null) continue;
    if (aPrev <= bPrev && a > b) {
      push(signals, {
        id: `indicator:골든크로스:${bars[i].time}`,
        kind: 'indicator',
        name: '골든크로스(MA5/MA20)',
        occurredAt: timeToIso(bars[i].time),
        price: bars[i].close,
        barTime: bars[i].time,
        importance: '단기 이평이 중기 이평을 상향 돌파해 추세 전환을 시사합니다.',
        meaningGeneral: '중기 상승 전환 신호입니다.',
        meaningHere: '5일선이 20일선을 상향 교차했습니다.',
        confirmations: ['가격이 두 이평 위에서 유지되는지 확인'],
        invalidation: ['재차 데드크로스 발생 시 무효'],
        risk: '횡보장에서는 잦은 속임수 신호가 발생합니다.',
        overlay: { type: 'vline', fromTime: bars[i].time },
      });
    }
    if (aPrev >= bPrev && a < b) {
      push(signals, {
        id: `indicator:데드크로스:${bars[i].time}`,
        kind: 'indicator',
        name: '데드크로스(MA5/MA20)',
        occurredAt: timeToIso(bars[i].time),
        price: bars[i].close,
        barTime: bars[i].time,
        importance: '단기 이평이 중기 이평을 하향 돌파해 하락 전환을 시사합니다.',
        meaningGeneral: '중기 하락 전환 신호입니다.',
        meaningHere: '5일선이 20일선을 하향 교차했습니다.',
        confirmations: ['가격이 두 이평 아래에서 유지되는지 확인'],
        invalidation: ['재차 골든크로스 발생 시 무효'],
        risk: '횡보장에서는 잦은 속임수 신호가 발생합니다.',
        overlay: { type: 'vline', fromTime: bars[i].time },
      });
    }
  }

  // RSI 과매수/과매도
  const rsiSeries = rsi(closes, 14);
  const rsiLatest = rsiSeries[n - 1];
  if (rsiLatest != null && rsiLatest >= 70) {
    push(signals, {
      id: `indicator:RSI과매수:${latest.time}`,
      kind: 'indicator',
      name: 'RSI 과매수',
      occurredAt: timeToIso(latest.time),
      price: latest.close,
      barTime: latest.time,
      importance: 'RSI 70 이상으로 단기 과열·조정 가능성을 시사합니다.',
      meaningGeneral: '매수세가 과열된 상태입니다.',
      meaningHere: `현재 RSI ${rsiLatest.toFixed(0)}입니다.`,
      confirmations: ['가격 상단 이탈 후 하락 반전 확인'],
      invalidation: ['RSI가 70 아래로 내려오면 해소'],
      risk: '강세장에서는 과매수가 오래 지속될 수 있습니다.',
      overlay: { type: 'level', level: latest.close },
    });
  }
  if (rsiLatest != null && rsiLatest <= 30) {
    push(signals, {
      id: `indicator:RSI과매도:${latest.time}`,
      kind: 'indicator',
      name: 'RSI 과매도',
      occurredAt: timeToIso(latest.time),
      price: latest.close,
      barTime: latest.time,
      importance: 'RSI 30 이하로 단기 과매도·반등 가능성을 시사합니다.',
      meaningGeneral: '매도세가 과도한 상태입니다.',
      meaningHere: `현재 RSI ${rsiLatest.toFixed(0)}입니다.`,
      confirmations: ['가격 반등 및 RSI 상승 전환 확인'],
      invalidation: ['RSI가 30 위로 올라오면 해소'],
      risk: '약세장에서는 과매도가 오래 지속될 수 있습니다.',
      overlay: { type: 'level', level: latest.close },
    });
  }

  // MACD 상향/하향 교차 (최근 5봉)
  const { macd: macdLine, signal } = macd(closes);
  for (let i = Math.max(1, n - 5); i < n; i += 1) {
    const m = macdLine[i];
    const mPrev = macdLine[i - 1];
    const s = signal[i];
    const sPrev = signal[i - 1];
    if (m == null || mPrev == null || s == null || sPrev == null) continue;
    if (mPrev <= sPrev && m > s) {
      push(signals, {
        id: `indicator:MACD상향교차:${bars[i].time}`,
        kind: 'indicator',
        name: 'MACD 상향 교차',
        occurredAt: timeToIso(bars[i].time),
        price: bars[i].close,
        barTime: bars[i].time,
        importance: 'MACD가 시그널선을 상향 돌파해 상승 모멘텀 강화를 시사합니다.',
        meaningGeneral: '상승 모멘텀 전환 신호입니다.',
        meaningHere: 'MACD선이 시그널선을 상향 교차했습니다.',
        confirmations: ['히스토그램 양전환 유지 확인'],
        invalidation: ['다시 하향 교차 시 무효'],
        risk: '후행 지표로 진입 타이밍이 늦을 수 있습니다.',
        overlay: { type: 'vline', fromTime: bars[i].time },
      });
    }
    if (mPrev >= sPrev && m < s) {
      push(signals, {
        id: `indicator:MACD하향교차:${bars[i].time}`,
        kind: 'indicator',
        name: 'MACD 하향 교차',
        occurredAt: timeToIso(bars[i].time),
        price: bars[i].close,
        barTime: bars[i].time,
        importance: 'MACD가 시그널선을 하향 돌파해 하락 모멘텀 강화를 시사합니다.',
        meaningGeneral: '하락 모멘텀 전환 신호입니다.',
        meaningHere: 'MACD선이 시그널선을 하향 교차했습니다.',
        confirmations: ['히스토그램 음전환 유지 확인'],
        invalidation: ['다시 상향 교차 시 무효'],
        risk: '후행 지표로 진입 타이밍이 늦을 수 있습니다.',
        overlay: { type: 'vline', fromTime: bars[i].time },
      });
    }
  }

  // 볼린저 상단 돌파 / 하단 이탈
  const bb = bollinger(closes, 20, 2);
  const upper = bb.upper[n - 1];
  const lower = bb.lower[n - 1];
  if (upper != null && latest.close > upper) {
    push(signals, {
      id: `indicator:볼린저상단돌파:${latest.time}`,
      kind: 'indicator',
      name: '볼린저밴드 상단 돌파',
      occurredAt: timeToIso(latest.time),
      price: latest.close,
      barTime: latest.time,
      importance: '가격이 밴드 상단을 넘어 단기 강세 또는 과열을 시사합니다.',
      meaningGeneral: '변동성 확대와 강한 상승을 의미합니다.',
      meaningHere: `종가가 상단선(${Math.round(upper * 100) / 100})을 상회했습니다.`,
      confirmations: ['상단선 위 지속 여부 확인'],
      invalidation: ['밴드 안으로 재진입 시 과열 해소'],
      risk: '밴드워킹 없이 상단 이탈 시 되돌림 위험이 있습니다.',
      overlay: { type: 'level', level: upper },
    });
  }
  if (lower != null && latest.close < lower) {
    push(signals, {
      id: `indicator:볼린저하단이탈:${latest.time}`,
      kind: 'indicator',
      name: '볼린저밴드 하단 이탈',
      occurredAt: timeToIso(latest.time),
      price: latest.close,
      barTime: latest.time,
      importance: '가격이 밴드 하단을 이탈해 단기 약세 또는 과매도를 시사합니다.',
      meaningGeneral: '변동성 확대와 강한 하락을 의미합니다.',
      meaningHere: `종가가 하단선(${Math.round(lower * 100) / 100})을 하회했습니다.`,
      confirmations: ['하단선 아래 지속 여부 확인'],
      invalidation: ['밴드 안으로 재진입 시 과매도 해소'],
      risk: '급락 시 추가 하락 위험이 있습니다.',
      overlay: { type: 'level', level: lower },
    });
  }

  // 60봉 고점 돌파 / 저점 이탈
  if (n >= 61) {
    const prior = bars.slice(-61, -1);
    const high60 = Math.max(...prior.map((b) => b.high));
    const low60 = Math.min(...prior.map((b) => b.low));
    if (latest.close >= high60) {
      push(signals, {
        id: `chart:60봉고점돌파:${latest.time}`,
        kind: 'chart',
        name: '60봉 고점 돌파',
        occurredAt: timeToIso(latest.time),
        price: latest.close,
        barTime: latest.time,
        importance: '최근 60봉 최고가를 돌파해 신고가 추세를 시사합니다.',
        meaningGeneral: '강한 상승 추세의 단서입니다.',
        meaningHere: `종가가 60봉 고점(${Math.round(high60 * 100) / 100})을 돌파했습니다.`,
        confirmations: ['거래량 동반 및 돌파 유지 확인'],
        invalidation: ['고점 아래로 재차 하락 시 속임수'],
        risk: '돌파 실패 시 되돌림 위험이 있습니다.',
        overlay: { type: 'level', level: high60 },
      });
    }
    if (latest.close <= low60) {
      push(signals, {
        id: `chart:60봉저점이탈:${latest.time}`,
        kind: 'chart',
        name: '60봉 저점 이탈',
        occurredAt: timeToIso(latest.time),
        price: latest.close,
        barTime: latest.time,
        importance: '최근 60봉 최저가를 이탈해 하락 추세를 시사합니다.',
        meaningGeneral: '약세 추세의 단서입니다.',
        meaningHere: `종가가 60봉 저점(${Math.round(low60 * 100) / 100})을 이탈했습니다.`,
        confirmations: ['거래량 동반 및 이탈 유지 확인'],
        invalidation: ['저점 위로 재차 회복 시 속임수'],
        risk: '추가 하락 위험이 있습니다.',
        overlay: { type: 'level', level: low60 },
      });
    }
  }
}

function detectChartPatterns(bars: Bar[], signals: ChartSignal[]): void {
  const n = bars.length;
  if (n < 40) return;
  const window = bars.slice(-60);
  const highs = window.map((b) => b.high);
  const lows = window.map((b) => b.low);
  const closes = window.map((b) => b.close);
  const latest = bars[n - 1];
  const boxHigh = Math.max(...highs.slice(0, -1));
  const boxLow = Math.min(...lows.slice(0, -1));
  const boxRange = boxHigh - boxLow;
  if (boxRange <= 0) return;

  // 박스권 돌파 / 지지선 이탈 / 저항선 돌파
  if (latest.close > boxHigh) {
    push(signals, {
      id: `chart:박스권상단돌파:${latest.time}`,
      kind: 'chart',
      name: '박스권 상단 돌파',
      occurredAt: timeToIso(latest.time),
      price: latest.close,
      barTime: latest.time,
      importance: '오랜 횡보 박스 상단을 돌파해 추세 시작을 시사합니다.',
      meaningGeneral: '매물대 돌파는 상승 추세 전환의 단서입니다.',
      meaningHere: `종가가 박스 상단(${Math.round(boxHigh * 100) / 100})을 돌파했습니다.`,
      confirmations: ['거래량 동반과 돌파 유지 확인'],
      invalidation: ['박스 안으로 재진입 시 속임수'],
      risk: '가짜 돌파 위험이 있습니다.',
      overlay: { type: 'zone', level: boxLow, level2: boxHigh, fromTime: window[0].time, toTime: latest.time },
    });
  } else if (latest.close < boxLow) {
    push(signals, {
      id: `chart:지지선이탈:${latest.time}`,
      kind: 'chart',
      name: '지지선 이탈',
      occurredAt: timeToIso(latest.time),
      price: latest.close,
      barTime: latest.time,
      importance: '박스 하단(지지) 이탈로 하락 추세 확대를 시사합니다.',
      meaningGeneral: '지지 이탈은 추가 하락의 단서입니다.',
      meaningHere: `종가가 박스 하단(${Math.round(boxLow * 100) / 100})을 이탈했습니다.`,
      confirmations: ['거래량 동반과 이탈 유지 확인'],
      invalidation: ['박스 안으로 재진입 시 속임수'],
      risk: '패닉셀 후 반등 위험이 있습니다.',
      overlay: { type: 'zone', level: boxLow, level2: boxHigh, fromTime: window[0].time, toTime: latest.time },
    });
  }

  // 삼각수렴: 최근 고점 하락 + 저점 상승
  const halfN = Math.floor(window.length / 2);
  const firstHalfHigh = Math.max(...highs.slice(0, halfN));
  const secondHalfHigh = Math.max(...highs.slice(halfN));
  const firstHalfLow = Math.min(...lows.slice(0, halfN));
  const secondHalfLow = Math.min(...lows.slice(halfN));
  if (secondHalfHigh < firstHalfHigh * 0.99 && secondHalfLow > firstHalfLow * 1.01) {
    push(signals, {
      id: `chart:삼각수렴:${latest.time}`,
      kind: 'chart',
      name: '삼각수렴',
      occurredAt: timeToIso(latest.time),
      price: latest.close,
      barTime: latest.time,
      importance: '고점은 낮아지고 저점은 높아지며 변동성 축소, 방향 돌파 임박을 시사합니다.',
      meaningGeneral: '수렴 후 돌파 방향으로 추세가 나타나기 쉽습니다.',
      meaningHere: '최근 구간 고점 하락·저점 상승이 확인됩니다.',
      confirmations: ['수렴 꼭짓점 부근 돌파 방향 확인'],
      invalidation: ['범위 안 횡보 지속 시 판단 보류'],
      risk: '돌파 방향 예단 금지.',
      overlay: { type: 'zone', level: secondHalfLow, level2: secondHalfHigh, fromTime: window[0].time, toTime: latest.time },
    });
  }

  // 상승/하락 채널: 고점·저점이 함께 우상향 / 우하향
  if (secondHalfHigh > firstHalfHigh * 1.02 && secondHalfLow > firstHalfLow * 1.02) {
    push(signals, {
      id: `chart:상승채널:${latest.time}`,
      kind: 'chart',
      name: '상승 채널',
      occurredAt: timeToIso(latest.time),
      price: latest.close,
      barTime: latest.time,
      importance: '고점·저점이 함께 높아지는 상승 추세 채널입니다.',
      meaningGeneral: '추세 추종 관점에 유리한 구조입니다.',
      meaningHere: '최근 구간 고점·저점이 모두 상승했습니다.',
      confirmations: ['채널 하단 지지 확인'],
      invalidation: ['채널 하단 이탈 시 추세 훼손'],
      risk: '채널 상단 근처 과열 주의.',
      overlay: { type: 'zone', level: secondHalfLow, level2: secondHalfHigh, fromTime: window[0].time, toTime: latest.time },
    });
  } else if (secondHalfHigh < firstHalfHigh * 0.98 && secondHalfLow < firstHalfLow * 0.98) {
    push(signals, {
      id: `chart:하락채널:${latest.time}`,
      kind: 'chart',
      name: '하락 채널',
      occurredAt: timeToIso(latest.time),
      price: latest.close,
      barTime: latest.time,
      importance: '고점·저점이 함께 낮아지는 하락 추세 채널입니다.',
      meaningGeneral: '반등은 매도 관점이 우세합니다.',
      meaningHere: '최근 구간 고점·저점이 모두 하락했습니다.',
      confirmations: ['채널 상단 저항 확인'],
      invalidation: ['채널 상단 돌파 시 추세 전환'],
      risk: '낙폭과대 반등 주의.',
      overlay: { type: 'zone', level: secondHalfLow, level2: secondHalfHigh, fromTime: window[0].time, toTime: latest.time },
    });
  }

  // 이중바닥 / 이중천장 (근사): 두 개의 유사한 극단
  detectDoubleTopBottom(window, latest, signals);
}

function detectDoubleTopBottom(window: Bar[], latest: Bar, signals: ChartSignal[]): void {
  const lows = window.map((b) => b.low);
  const highs = window.map((b) => b.high);
  // 국소 저점 두 개 탐색
  const troughs: number[] = [];
  const peaks: number[] = [];
  for (let i = 2; i < window.length - 2; i += 1) {
    if (lows[i] <= lows[i - 1] && lows[i] <= lows[i - 2] && lows[i] <= lows[i + 1] && lows[i] <= lows[i + 2]) {
      troughs.push(i);
    }
    if (highs[i] >= highs[i - 1] && highs[i] >= highs[i - 2] && highs[i] >= highs[i + 1] && highs[i] >= highs[i + 2]) {
      peaks.push(i);
    }
  }
  if (troughs.length >= 2) {
    const a = troughs[troughs.length - 2];
    const b = troughs[troughs.length - 1];
    if (b - a >= 4 && Math.abs(lows[a] - lows[b]) <= lows[a] * 0.03) {
      push(signals, {
        id: `chart:이중바닥:${latest.time}`,
        kind: 'chart',
        name: '이중바닥',
        occurredAt: timeToIso(latest.time),
        price: latest.close,
        barTime: latest.time,
        importance: '유사한 저점 두 번 형성 후 반등 시 상승 반전(W형)을 시사합니다.',
        meaningGeneral: '바닥 다지기 후 반전 신호입니다.',
        meaningHere: '최근 구간에서 유사한 저점이 두 번 확인됩니다.',
        confirmations: ['목선(중간 고점) 돌파 확인'],
        invalidation: ['두 번째 저점 이탈 시 무효'],
        risk: '목선 돌파 전에는 미완성 패턴입니다.',
        overlay: { type: 'level', level: Math.min(lows[a], lows[b]) },
      });
    }
  }
  if (peaks.length >= 2) {
    const a = peaks[peaks.length - 2];
    const b = peaks[peaks.length - 1];
    if (b - a >= 4 && Math.abs(highs[a] - highs[b]) <= highs[a] * 0.03) {
      push(signals, {
        id: `chart:이중천장:${latest.time}`,
        kind: 'chart',
        name: '이중천장',
        occurredAt: timeToIso(latest.time),
        price: latest.close,
        barTime: latest.time,
        importance: '유사한 고점 두 번 형성 후 하락 시 하락 반전(M형)을 시사합니다.',
        meaningGeneral: '천장 형성 후 반전 신호입니다.',
        meaningHere: '최근 구간에서 유사한 고점이 두 번 확인됩니다.',
        confirmations: ['목선(중간 저점) 이탈 확인'],
        invalidation: ['두 번째 고점 돌파 시 무효'],
        risk: '목선 이탈 전에는 미완성 패턴입니다.',
        overlay: { type: 'level', level: Math.max(highs[a], highs[b]) },
      });
    }
  }
}

export async function getChartSignals(
  asset: 'stock' | 'coin',
  coinMarket: string,
  symbol: string,
  interval: string,
  options: { allowFutures?: boolean } = {},
  barsOverride?: Bar[],
): Promise<ChartSignalsResult> {
  const bars = barsOverride ?? await loadBars(asset, coinMarket, symbol, interval, options);
  const signals: ChartSignal[] = [];
  if (bars.length >= 30) {
    detectCandlePatterns(bars, signals);
    detectIndicators(bars, signals);
    detectChartPatterns(bars, signals);
  }
  return {
    ok: true,
    symbol,
    interval: interval || '1D',
    updatedAt: new Date().toISOString(),
    signals: signals.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1)),
  };
}
