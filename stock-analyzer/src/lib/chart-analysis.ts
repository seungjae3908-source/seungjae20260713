export type ChartAnalysisStatus =
  | 'forming'
  | 'candidate'
  | 'confirmed'
  | 'weakened'
  | 'invalidated'
  | 'expired';

export type ChartAnalysis = {
  id: string;
  type: string;
  symbol: string;
  market: string;
  timeframe: string;
  status: ChartAnalysisStatus;
  bias: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  createdAt: string;
  detectedAt: string;
  confirmedAt?: string;
  invalidatedAt?: string;
  points: Array<{ time: number; price: number; role: string }>;
  priceLevels: Array<{ price: number; role: string }>;
  title: string;
  summary: string;
  reasons: string[];
  confirmationConditions: string[];
  invalidationConditions: string[];
  relatedIndicators: Record<string, number | string | null>;
  source: string;
  engineVersion: string;
};

export type ChartAnalysisInput = {
  symbol: string;
  market: string;
  timeframe: string;
  latestTime: number;
  currentPrice: number;
  previousClose: number;
  trend: string;
  rsi: number | null;
  macd: number | null;
  volumeRatio: number;
  support: number;
  resistance: number;
  signal: 'ENTER' | 'WATCH' | 'HOLD' | 'TAKE_PROFIT' | 'EXIT' | 'STOP';
  confidence: number;
  title: string;
  summary: string;
  patterns: string[];
  source: string;
  isClosedCandle: boolean;
};

export function buildChartAnalysis(input: ChartAnalysisInput): ChartAnalysis {
  const bearish = input.signal === 'STOP' || input.signal === 'EXIT' || input.signal === 'TAKE_PROFIT';
  const bullish = input.signal === 'ENTER' || input.signal === 'HOLD';
  const status: ChartAnalysisStatus = !input.isClosedCandle
    ? 'forming'
    : input.signal === 'STOP' || input.signal === 'EXIT'
      ? 'invalidated'
      : input.signal === 'WATCH'
        ? 'candidate'
        : input.confidence >= 70
          ? 'confirmed'
          : 'weakened';
  const detectedAt = new Date(input.latestTime * 1000).toISOString();
  const reasons = [
    `가격 구조: ${input.trend}`,
    `거래량 비율: ${input.volumeRatio.toFixed(2)}배`,
    input.rsi == null ? 'RSI: unavailable' : `RSI: ${input.rsi.toFixed(1)}`,
    input.macd == null ? 'MACD: unavailable' : `MACD: ${input.macd.toFixed(3)}`,
    ...input.patterns.map((pattern) => `패턴 후보: ${pattern}`),
  ];
  return {
    id: [input.symbol, input.timeframe, input.patterns[0] ?? 'market-structure', input.signal].join(':'),
    type: input.patterns[0] ?? 'market-structure',
    symbol: input.symbol,
    market: input.market,
    timeframe: input.timeframe,
    status,
    bias: bullish ? 'bullish' : bearish ? 'bearish' : 'neutral',
    confidence: Math.max(0, Math.min(100, Math.round(input.confidence))),
    createdAt: new Date().toISOString(),
    detectedAt,
    confirmedAt: status === 'confirmed' ? detectedAt : undefined,
    invalidatedAt: status === 'invalidated' ? detectedAt : undefined,
    points: [{ time: input.latestTime, price: input.currentPrice, role: 'latest' }],
    priceLevels: [
      { price: input.support, role: 'support' },
      { price: input.resistance, role: 'resistance' },
    ],
    title: input.title,
    summary: input.summary,
    reasons,
    confirmationConditions: [
      `완료된 ${input.timeframe} 캔들이 저항 ${input.resistance} 위에서 마감`,
      '거래량과 추세 지표가 같은 방향을 유지',
    ],
    invalidationConditions: [
      `완료된 ${input.timeframe} 캔들이 지지 ${input.support} 아래에서 마감`,
      '반대 방향 구조 전환 신호 발생',
    ],
    relatedIndicators: {
      trend: input.trend,
      rsi: input.rsi,
      macd: input.macd,
      volumeRatio: input.volumeRatio,
      previousClose: input.previousClose,
    },
    source: input.source,
    engineVersion: 'chart-analysis-v1',
  };
}

export function shouldAppendTimeline(previous: ChartAnalysis | null, next: ChartAnalysis): boolean {
  if (!previous) return true;
  return previous.id !== next.id || previous.status !== next.status;
}
