// AI analysis + overview reasoning. Reasons reference the same sample figures
// used elsewhere (ROE, growth, signals, RSI) so the narrative is consistent.
import { getCatalogEntry } from '../data/catalog';
import { scoreToRating } from './rating';
import { computeScores } from './scores';
import { getQuote } from './market';
import { getFinancials } from './financials';
import { getRisk } from './risk';
import type { AiAnalysis, AiStrategy, Candle, Rating } from './types';

const RATING_KO: Record<Rating, string> = {
  STRONG_BUY: '적극 매수',
  BUY: '매수',
  HOLD: '보통',
  SELL: '매도',
  STRONG_SELL: '적극 매도',
};

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

export function buildReasons(ticker: string): { buyReasons: string[]; sellReasons: string[] } {
  const fin = getFinancials(ticker);
  const { signals } = computeScores(ticker);
  const active = new Set(signals.filter((s) => s.active).map((s) => s.key));
  const buy: string[] = [];
  const sell: string[] = [];

  if (fin) {
    const revG = Math.round(avg(fin.growth.revenue) * 10) / 10;
    if (fin.ratios.roe > 12) buy.push(`자기자본이익률(ROE) ${fin.ratios.roe}%로 수익성이 우수합니다.`);
    if (revG > 8) buy.push(`매출이 연평균 약 ${revG}% 성장하고 있습니다.`);
    if (fin.health.level === 'STRONG') buy.push('재무 건전성이 양호합니다.');
    if (fin.ratios.per > 0 && fin.ratios.per < 15) buy.push(`PER ${fin.ratios.per}배로 밸류에이션 부담이 낮습니다.`);

    if (fin.ratios.roe < 0) sell.push('자기자본이익률이 마이너스로 수익성이 부진합니다.');
    if (revG < 0) sell.push(`매출이 연평균 약 ${revG}% 감소하고 있습니다.`);
    if (fin.ratios.debtRatio > 120) sell.push(`부채비율이 ${fin.ratios.debtRatio}%로 높은 편입니다.`);
    if (fin.cashBurn.survivalQuarters !== null)
      sell.push(`현금 소진이 진행 중이며 추정 존속 분기는 약 ${fin.cashBurn.survivalQuarters}분기입니다.`);
  }

  if (active.has('golden_cross')) buy.push('20일선이 60일선을 상향 돌파한 골든크로스가 발생했습니다.');
  if (active.has('macd_buy')) buy.push('MACD 매수 신호가 나타났습니다.');
  if (active.has('volume_surge')) buy.push('거래량이 급증하며 매수세가 유입되고 있습니다.');
  if (active.has('dead_cross')) sell.push('20일선이 60일선을 하향 돌파한 데드크로스가 발생했습니다.');
  if (active.has('macd_sell')) sell.push('MACD 매도 신호가 나타났습니다.');
  if (active.has('rsi_overbought')) sell.push('RSI가 과매수 구간에 진입했습니다.');
  if (active.has('rsi_oversold')) buy.push('RSI가 과매도 구간으로 기술적 반등 여지가 있습니다.');

  const buyPad = ['업황 개선 기대감이 유효합니다.', '중장기 성장 스토리가 살아 있습니다.', '주주환원 정책이 우호적입니다.'];
  const sellPad = ['단기 변동성 확대에 유의가 필요합니다.', '경쟁 심화로 마진 압박 가능성이 있습니다.', '거시 환경 불확실성이 상존합니다.'];
  let bi = 0;
  let si = 0;
  while (buy.length < 3) buy.push(buyPad[bi++ % buyPad.length]);
  while (sell.length < 3) sell.push(sellPad[si++ % sellPad.length]);

  return { buyReasons: buy.slice(0, 4), sellReasons: sell.slice(0, 4) };
}

export function computeAnalysis(ticker: string): AiAnalysis | null {
  const entry = getCatalogEntry(ticker);
  if (!entry) return null;
  const quote = getQuote(ticker);
  if (!quote) return null;
  const { overall } = computeScores(ticker);
  const { rating, confidence } = scoreToRating(overall);
  const { buyReasons, sellReasons } = buildReasons(ticker);
  const risk = getRisk(ticker);

  const upside = Math.max(-0.3, Math.min(0.4, ((overall - 50) / 50) * 0.4));
  const targetPrice = Math.round(quote.price * (1 + upside) * 100) / 100;
  const stopLossPrice = Math.round(quote.price * (1 - (0.1 + (100 - overall) / 1000)) * 100) / 100;

  const ratingKo = RATING_KO[rating];
  const trend = overall >= 60 ? '상승' : overall >= 40 ? '횡보' : '하락';
  const shortTerm = `단기적으로 기술적 지표는 ${trend} 흐름을 시사합니다. 주요 지지·저항 구간을 확인하며 대응이 필요합니다.`;
  const midTerm = `중기적으로 실적 및 수급 흐름을 고려할 때 ${overall >= 55 ? '점진적 우상향' : '박스권 등락'}이 예상됩니다.`;
  const longTerm = `장기적으로 ${entry.name}의 산업 내 경쟁력과 재무 체력이 방향을 좌우할 전망입니다.`;
  const conclusion = `종합 점수 ${overall}점으로 '${ratingKo}' 의견입니다. 목표가 대비 상승 여력과 ${
    risk ? `위험도(${risk.overallScore}점)` : '리스크'
  }를 함께 고려한 분할 접근을 권장합니다.`;

  // 의견 근거: 특히 '보류/중립'일 때 왜 관망인지 명확히 설명 (요구사항 #2)
  const topBuy = buyReasons[0] ?? '뚜렷한 매수 근거가 제한적입니다.';
  const topSell = sellReasons[0] ?? '뚜렷한 매도 근거가 제한적입니다.';
  let opinionReason: string;

  if (rating === 'STRONG_BUY' || rating === 'BUY') {
    opinionReason = `종합점수 ${overall}점으로 매수 신호가 우위입니다. 핵심 근거: ${topBuy} 다만 "${topSell}" 점은 유의하며 분할 매수로 접근하세요.`;
  } else if (rating === 'SELL' || rating === 'STRONG_SELL') {
    opinionReason = `종합점수 ${overall}점으로 매도·관망 신호가 우위입니다. 핵심 근거: ${topSell} 반등 시 비중을 줄이는 편이 유리합니다.`;
  } else {
    opinionReason = `종합점수 ${overall}점으로 매수와 매도 근거가 팽팽해 '보류(중립)' 의견입니다. 매수 근거는 "${topBuy}", 매도 근거는 "${topSell}"로, 방향성이 뚜렷해질 때까지 관망을 권합니다.`;
  }

  return {
    opinion: rating,
    opinionReason,
    confidence,
    buyReasons: buyReasons.slice(0, 3),
    sellReasons: sellReasons.slice(0, 3),
    shortTerm,
    midTerm,
    longTerm,
    targetPrice,
    stopLossPrice,
    conclusion,
    score: overall,
  };
}

function fmtNum(v: number, currency: string): string {
  if (currency === 'USD') {
    return `${(Math.round(v * 100) / 100).toLocaleString('en-US')}`;
  }
  return `${Math.round(v).toLocaleString('ko-KR')}원`;
}

function roundPrice(v: number, currency: string): number {
  if (currency === 'USD') return Math.round(v * 100) / 100;
  return Math.round(v / 10) * 10; // 원화는 10원 단위로 근사
}

export interface StrategyInput {
  price: number;
  candles: Candle[];
  overall: number;
  currency: string;
}

// 매매 전략(1차/2차 진입·목표가·손절가)을 실제 일봉의 지지/저항(20일선, 최근 저점·고점)과
// 종합점수 기반 상승여력으로 산출하고, 각 가격에 '왜'를 붙인다 (요구사항 #3). 가격은 항상
// 라이브 시세 기준이라 화면에 표시되는 현재가와 일관된다.
export function buildStrategy(input: StrategyInput): AiStrategy {
  const { price, candles, overall, currency } = input;
  const recent = candles.slice(-20).filter((c) => Number.isFinite(c.close));
  const hasData = recent.length >= 10 && price > 0;

  const closes = recent.map((c) => c.close);
  const ma20 = closes.length
    ? closes.reduce((a, b) => a + b, 0) / closes.length
    : price;
  const recentLow = recent.length
    ? Math.min(...recent.map((c) => c.low))
    : price * 0.94;
  const recentHigh = recent.length
    ? Math.max(...recent.map((c) => c.high))
    : price * 1.1;
  const upside = Math.max(0.05, Math.min(0.4, ((overall - 50) / 50) * 0.4));

  let entry1 = hasData
    ? price > ma20 && ma20 > 0
      ? ma20
      : recentLow
    : price * 0.98;
  entry1 = Math.min(entry1, price * 0.995);

  let entry2 = hasData ? Math.min(recentLow, entry1 * 0.95) : price * 0.94;
  entry2 = Math.min(entry2, entry1 * 0.97);

  let target = hasData
    ? Math.max(recentHigh, price * (1 + upside))
    : price * (1 + upside);
  target = Math.max(target, price * 1.03);

  let stop = hasData ? Math.min(recentLow * 0.94, entry2 * 0.95) : entry2 * 0.95;
  stop = Math.min(stop, entry2 * 0.97);

  entry1 = roundPrice(entry1, currency);
  entry2 = roundPrice(entry2, currency);
  target = roundPrice(target, currency);
  stop = roundPrice(stop, currency);

  // 반올림(원화 10원 단위) 이후에도 진입/손절/목표 순서가 반드시 유지되도록 보정한다.
  // 저가 원화주에서 반올림으로 가격대가 겹쳐 "1차=2차" 같은 무의미한 사다리가 나오는 것을 방지.
  const step = currency === 'USD' ? 0.01 : 10;
  if (entry2 >= entry1) entry2 = roundPrice(entry1 - step, currency);
  if (stop >= entry2) stop = roundPrice(entry2 - step, currency);
  if (stop <= 0) stop = step;
  if (entry2 <= stop) entry2 = roundPrice(stop + step, currency);
  if (entry1 <= entry2) entry1 = roundPrice(entry2 + step, currency);
  if (target <= price) {
    target = roundPrice(price + Math.max(step, price * 0.03), currency);
  }

  const dataNote = hasData
    ? ''
    : ' (차트 데이터가 제한적이어서 가격대 비율로 산출했습니다.)';
  const upsidePct = Math.round(((target - price) / price) * 100);
  const riskPct = Math.round(((price - stop) / price) * 100);

  return {
    entry1: {
      price: entry1,
      reason:
        hasData && price > ma20
          ? `20일 이동평균선(약 ${fmtNum(ma20, currency)}) 부근의 1차 지지 구간입니다. 눌림목에서 분할 매수하기 좋은 자리입니다.${dataNote}`
          : `최근 20거래일 지지선(약 ${fmtNum(entry1, currency)}) 부근에서 1차로 분할 매수하는 구간입니다.${dataNote}`,
    },
    entry2: {
      price: entry2,
      reason: `최근 저점권(약 ${fmtNum(entry2, currency)})까지 추가 조정 시 평균 단가를 낮추는 2차 매수 구간입니다.${dataNote}`,
    },
    target: {
      price: target,
      reason: `최근 고점 저항선과 종합점수(${overall}점) 기반 상승 여력(약 +${upsidePct}%)을 반영한 목표가입니다.${dataNote}`,
    },
    stop: {
      price: stop,
      reason: `2차 진입가 아래 지지선이 무너지는 자리로, 약 -${riskPct}% 손실에서 리스크를 제한하는 손절 라인입니다.${dataNote}`,
    },
  };
}

export { RATING_KO };
