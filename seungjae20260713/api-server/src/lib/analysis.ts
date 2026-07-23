// Derives per-stock buy/sell reasoning and multi-horizon outlook from REAL
// fetched data (quote, fundamentals, technical signals). Because the inputs are
// live and stock-specific, the output differs per stock. Reasons reference the
// actual retrieved figures; if a provider is unavailable, that reasoning line is
// simply omitted rather than fabricated.
import type { Quote } from '../providers/finnhub';
import type { Financials } from '../providers/alphavantage';
import type { SignalResult } from './signals';

export interface AnalysisInputs {
  quote: Quote | null;
  financials: Financials | null;
  signals: SignalResult | null;
}

export interface Analysis {
  buyReasons: string[];
  sellReasons: string[];
  outlook: { shortTerm: string; midTerm: string; longTerm: string };
  score: number; // 0-100 derived from real inputs
}

interface Candidate {
  when: boolean;
  text: string;
  weight: number;
}

function pick(cands: Candidate[]): string[] {
  return cands
    .filter((c) => c.when)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((c) => c.text);
}

export function deriveAnalysis(inputs: AnalysisInputs): Analysis {
  const { quote, financials, signals } = inputs;
  const dp = quote?.changePercent ?? 0;

  const margin =
    financials && financials.revenue && financials.operatingProfit
      ? financials.operatingProfit / financials.revenue
      : null;
  const netMargin =
    financials && financials.revenue && financials.netProfit
      ? financials.netProfit / financials.revenue
      : null;
  const debtRatio =
    financials && financials.revenue && financials.debt
      ? financials.debt / financials.revenue
      : null;
  const rsi = signals?.rsi ?? null;

  const buyCandidates: Candidate[] = [
    {
      when: dp > 1,
      text: `당일 주가가 ${dp.toFixed(2)}% 상승하며 단기 모멘텀이 강합니다.`,
      weight: 6,
    },
    {
      when: Boolean(signals?.goldenCross),
      text: '골든크로스가 발생해 추세 전환 기대감이 있습니다.',
      weight: 9,
    },
    {
      when: Boolean(signals?.volumeSurge),
      text: '거래량이 급증하며 매수세가 유입되고 있습니다.',
      weight: 5,
    },
    {
      when: margin !== null && margin > 0.15,
      text: `영업이익률이 ${((margin ?? 0) * 100).toFixed(1)}%로 수익성이 우수합니다.`,
      weight: 8,
    },
    {
      when: netMargin !== null && netMargin > 0.1,
      text: `순이익률이 ${((netMargin ?? 0) * 100).toFixed(1)}%로 견조합니다.`,
      weight: 7,
    },
    {
      when: debtRatio !== null && debtRatio < 0.5,
      text: '부채 규모가 매출 대비 낮아 재무 안정성이 높습니다.',
      weight: 6,
    },
    {
      when: rsi !== null && rsi <= 30,
      text: `RSI ${(rsi ?? 0).toFixed(0)}로 과매도 구간이어서 반등 여지가 있습니다.`,
      weight: 4,
    },
  ];

  const sellCandidates: Candidate[] = [
    {
      when: dp < -1,
      text: `당일 주가가 ${Math.abs(dp).toFixed(2)}% 하락하며 약세를 보이고 있습니다.`,
      weight: 6,
    },
    {
      when: Boolean(signals?.deadCross),
      text: '데드크로스가 발생해 하락 추세 전환이 우려됩니다.',
      weight: 9,
    },
    {
      when: margin !== null && margin < 0.05,
      text: `영업이익률이 ${((margin ?? 0) * 100).toFixed(1)}%로 수익성이 낮습니다.`,
      weight: 8,
    },
    {
      when: netMargin !== null && netMargin < 0,
      text: '순손실 상태로 실적 부담이 큽니다.',
      weight: 9,
    },
    {
      when: debtRatio !== null && debtRatio > 1,
      text: '부채가 매출을 초과해 재무 리스크가 있습니다.',
      weight: 7,
    },
    {
      when: rsi !== null && rsi >= 70,
      text: `RSI ${(rsi ?? 0).toFixed(0)}로 과매수 구간이어서 조정 가능성이 있습니다.`,
      weight: 5,
    },
  ];

  const buyReasons = pick(buyCandidates);
  const sellReasons = pick(sellCandidates);

  // Score: start neutral, adjust by real signals.
  let score = 50;
  score += Math.max(-10, Math.min(10, dp));
  if (margin !== null) score += margin > 0.15 ? 12 : margin < 0.05 ? -12 : 0;
  if (netMargin !== null) score += netMargin > 0.1 ? 8 : netMargin < 0 ? -12 : 0;
  if (debtRatio !== null) score += debtRatio < 0.5 ? 6 : debtRatio > 1 ? -8 : 0;
  if (signals?.goldenCross) score += 8;
  if (signals?.deadCross) score -= 8;
  if (rsi !== null) score += rsi <= 30 ? 4 : rsi >= 70 ? -4 : 0;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const up = dp >= 0;
  const outlook = {
    shortTerm: up
      ? `단기적으로는 ${dp.toFixed(2)}% 상승 흐름과 최근 수급을 고려할 때 강세가 이어질 수 있으나 변동성에 유의해야 합니다.`
      : `단기적으로는 ${Math.abs(dp).toFixed(2)}% 하락 등 조정 압력이 우세하여 지지선 확인 전까지 보수적 접근이 필요합니다.`,
    midTerm:
      score >= 65
        ? '중기적으로는 실적과 재무 지표가 양호해 안정적인 우상향이 기대됩니다.'
        : score >= 45
        ? '중기적으로는 실적 방향성에 따라 박스권 흐름이 예상됩니다.'
        : '중기적으로는 실적·재무 불확실성으로 변동성 확대가 우려됩니다.',
    longTerm:
      score >= 65
        ? '장기적으로는 경쟁 우위를 바탕으로 기업가치 상승이 기대됩니다.'
        : score >= 45
        ? '장기적으로는 신성장 동력 확보 여부가 관건입니다.'
        : '장기적으로는 사업·재무 구조 개선 확인 후 접근이 바람직합니다.',
  };

  return { buyReasons, sellReasons, outlook, score };
}
