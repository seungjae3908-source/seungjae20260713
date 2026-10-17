// Builds the stock-detail "AI 분석" payload from REAL inputs only: the live
// quote row and the daily candle series that the chart endpoint already uses.
// Signals (moving-average cross, volume surge, RSI) are computed from those
// candles; reasons that cannot be backed by data are omitted, never invented.
// Target/stop prices are intentionally not produced (no evidence source), so
// the UI shows its "근거 미수집" state instead of a made-up percentage.
import { deriveAnalysis } from '../lib/analysis';
import { computeSignals } from '../lib/signals';

export type AnalysisRating = 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL';

export interface StockAnalysisQuoteInput {
  price: number;
  changeAmount?: number;
  changePercent: number;
  updatedAt?: string;
}

export interface StockAnalysisCandleInput {
  time: string | number;
  close: number;
  volume: number;
}

export interface StockAnalysisPayload {
  ticker: string;
  opinion: AnalysisRating;
  opinionReason: string;
  confidence: number;
  score: number;
  buyReasons: string[];
  sellReasons: string[];
  shortTerm: string;
  midTerm: string;
  longTerm: string;
  conclusion: string;
  basis: {
    quote: boolean;
    candleCount: number;
    candleProvider: string | null;
    rsi: number | null;
  };
  generatedAt: string;
}

const RATING_KO: Record<AnalysisRating, string> = {
  STRONG_BUY: '적극 매수',
  BUY: '매수',
  HOLD: '관망',
  SELL: '매도',
  STRONG_SELL: '적극 매도',
};

export function scoreToAnalysisRating(score: number): AnalysisRating {
  if (score >= 75) return 'STRONG_BUY';
  if (score >= 60) return 'BUY';
  if (score > 40) return 'HOLD';
  if (score > 25) return 'SELL';
  return 'STRONG_SELL';
}

export function buildStockAnalysis(input: {
  ticker: string;
  quote: StockAnalysisQuoteInput | null;
  candles: StockAnalysisCandleInput[];
  candleProvider?: string | null;
  now?: Date;
}): StockAnalysisPayload | null {
  const quote =
    input.quote && Number.isFinite(input.quote.price) && input.quote.price > 0
      ? input.quote
      : null;
  const bars = input.candles
    .filter((c) => Number.isFinite(c.close) && c.close > 0)
    .map((c) => ({
      date: String(c.time),
      close: c.close,
      volume: Number.isFinite(c.volume) ? c.volume : 0,
    }));

  // Without a quote and without enough history there is nothing truthful to say.
  if (!quote && bars.length < 15) return null;

  const signals = bars.length >= 15 ? computeSignals(bars) : null;
  const changePercent = Number.isFinite(quote?.changePercent) ? Number(quote?.changePercent) : 0;
  const derived = deriveAnalysis({
    quote: quote
      ? {
          price: quote.price,
          changeAmount: quote.changeAmount ?? 0,
          changePercent,
          high: quote.price,
          low: quote.price,
          open: quote.price,
          previousClose: quote.price,
          updatedAt: quote.updatedAt ?? '',
        }
      : null,
    financials: null,
    signals,
  });

  const opinion = scoreToAnalysisRating(derived.score);
  // Confidence = how far the evidence pushes away from neutral, capped by how
  // much evidence exists. Never presented as a hit-rate.
  const evidenceCount = derived.buyReasons.length + derived.sellReasons.length;
  const distance = Math.abs(derived.score - 50) * 2;
  const confidence = Math.max(
    10,
    Math.min(90, Math.round(distance * 0.6 + Math.min(evidenceCount, 4) * 7.5)),
  );

  const rsiText =
    signals?.rsi != null ? ` RSI ${signals.rsi.toFixed(0)}` : '';
  const opinionReason = `실시간 시세(${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%)와 일봉 ${bars.length}개 기반 기술 지표${rsiText}를 종합한 결과 '${RATING_KO[opinion]}' 의견입니다. 재무 데이터는 이 의견에 반영되지 않았습니다.`;

  const conclusion =
    opinion === 'STRONG_BUY' || opinion === 'BUY'
      ? '기술 지표가 우호적이지만 단일 근거에 의존하지 말고 분할 접근과 손절 기준을 함께 정하세요.'
      : opinion === 'HOLD'
        ? '뚜렷한 방향 신호가 부족합니다. 추세 확인 전까지 관망이 적절합니다.'
        : '약세 신호가 우세합니다. 신규 진입은 보수적으로 판단하고 보유 중이면 위험 관리 기준을 점검하세요.';

  return {
    ticker: input.ticker,
    opinion,
    opinionReason,
    confidence,
    score: derived.score,
    buyReasons: derived.buyReasons,
    sellReasons: derived.sellReasons,
    shortTerm: derived.outlook.shortTerm,
    // deriveAnalysis's mid/long-term wording assumes financial inputs; this
    // payload has none, so describe only what the price evidence supports.
    midTerm:
      derived.score >= 60
        ? '중기적으로는 가격 지표가 우호적이나 실적 확인 전까지 추세 유지 여부를 지켜봐야 합니다.'
        : derived.score > 40
          ? '중기적으로는 뚜렷한 방향 신호가 없어 박스권 흐름 가능성이 있습니다.'
          : '중기적으로는 가격 지표가 약해 추가 조정 가능성에 유의해야 합니다.',
    longTerm: '장기 전망은 재무·실적 근거가 필요합니다. 재무 탭과 공시를 함께 확인하세요.',
    conclusion,
    basis: {
      quote: Boolean(quote),
      candleCount: bars.length,
      candleProvider: input.candleProvider ?? null,
      rsi: signals?.rsi ?? null,
    },
    generatedAt: (input.now ?? new Date()).toISOString(),
  };
}
