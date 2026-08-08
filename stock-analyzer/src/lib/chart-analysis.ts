export type ChartAnalysisStatus =
  | 'forming'
  | 'candidate'
  | 'confirmed'
  | 'weakened'
  | 'invalidated'
  | 'expired';

export type ChartAnalysisBias = 'bullish' | 'bearish' | 'neutral';

export type ChartAnalysisPoint = {
  time: number;
  price: number;
  role: string;
};

export type ChartAnalysisPriceLevel = {
  price: number;
  role: string;
};

export type ChartAnalysis = {
  id: string;
  type: string;
  subtype?: string;
  symbol: string;
  market: string;
  timeframe: string;
  status: ChartAnalysisStatus;
  bias: ChartAnalysisBias;
  confidence: number;
  createdAt: string;
  detectedAt: string;
  confirmedAt?: string;
  weakenedAt?: string;
  invalidatedAt?: string;
  expiredAt?: string;
  startTime?: number;
  endTime?: number;
  points: ChartAnalysisPoint[];
  priceLevels: ChartAnalysisPriceLevel[];
  title: string;
  summary: string;
  reasons: string[];
  confirmationConditions: string[];
  invalidationConditions: string[];
  relatedIndicators: Record<string, number | string | boolean | null>;
  source: string;
  engineVersion: string;
  transitionReason?: string;
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
  anchorTimes?: number[];
  anchorPoints?: ChartAnalysisPoint[];
  previousAnalysis?: ChartAnalysis | null;
  dataStatus?: string;
  engineVersion?: string;
};

type PatternDescriptor = {
  type: string;
  subtype: string;
  bias: ChartAnalysisBias;
};

const DEFAULT_ENGINE_VERSION = 'chart-analysis-v2';

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, finite(value)));
}

function normalizeToken(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9가-힣._:-]/g, '');
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function patternDescriptor(patterns: string[], trend: string): PatternDescriptor {
  const joined = patterns.join(' ').toLowerCase();
  if (/쌍봉|이중천장|m자|double[ -]?top/.test(joined)) {
    return { type: 'double-top', subtype: 'M자 · 이중천장', bias: 'bearish' };
  }
  if (/쌍바닥|이중바닥|w자|double[ -]?bottom/.test(joined)) {
    return { type: 'double-bottom', subtype: 'W자 · 이중바닥', bias: 'bullish' };
  }
  if (/하락 장악|유성형|하락 이탈|breakdown/.test(joined)) {
    return { type: 'bearish-pattern', subtype: patterns[0] ?? '하락 패턴', bias: 'bearish' };
  }
  if (/상승 장악|망치형|상승 돌파|breakout/.test(joined)) {
    return { type: 'bullish-pattern', subtype: patterns[0] ?? '상승 패턴', bias: 'bullish' };
  }
  const trendBias: ChartAnalysisBias = trend === '상승' ? 'bullish' : trend === '하락' ? 'bearish' : 'neutral';
  return {
    type: patterns[0] ? 'chart-pattern' : 'market-structure',
    subtype: patterns[0] ?? `${trend || '중립'} 구조`,
    bias: trendBias,
  };
}

function effectiveBias(input: ChartAnalysisInput, descriptor: PatternDescriptor): ChartAnalysisBias {
  if (descriptor.type === 'double-top' || descriptor.type === 'double-bottom') return descriptor.bias;
  if (input.signal === 'STOP' || input.signal === 'EXIT' || input.signal === 'TAKE_PROFIT') return 'bearish';
  if (input.signal === 'ENTER' || input.signal === 'HOLD') return 'bullish';
  return descriptor.bias;
}

export function createStableAnalysisId(input: {
  engineVersion: string;
  market: string;
  symbol: string;
  timeframe: string;
  type: string;
  subtype?: string;
  anchorTimes: number[];
  bias: ChartAnalysisBias;
}): string {
  const anchors = [...new Set(input.anchorTimes.filter(Number.isFinite).map(Math.trunc))].sort((a, b) => a - b);
  const canonical = [
    normalizeToken(input.engineVersion),
    normalizeToken(input.market),
    normalizeToken(input.symbol),
    normalizeToken(input.timeframe),
    normalizeToken(input.type),
    normalizeToken(input.subtype),
    anchors.join(','),
    input.bias,
  ].join('|');
  return `analysis:${stableHash(canonical)}`;
}

function deriveStatus(input: ChartAnalysisInput, descriptor: PatternDescriptor): ChartAnalysisStatus {
  if (!input.isClosedCandle) return 'forming';

  if (descriptor.type === 'double-top') {
    if (input.currentPrice < input.support) return 'confirmed';
    if (input.currentPrice > input.resistance) return 'invalidated';
    return 'candidate';
  }

  if (descriptor.type === 'double-bottom') {
    if (input.currentPrice > input.resistance) return 'confirmed';
    if (input.currentPrice < input.support) return 'invalidated';
    return 'candidate';
  }

  if (input.signal === 'STOP' || input.signal === 'EXIT') return 'invalidated';
  if (input.signal === 'WATCH') return 'candidate';
  return input.confidence >= 70 ? 'confirmed' : 'weakened';
}

function statusLabel(status: ChartAnalysisStatus): string {
  const labels: Record<ChartAnalysisStatus, string> = {
    forming: '형성 중',
    candidate: '후보',
    confirmed: '확정',
    weakened: '약화',
    invalidated: '무효화',
    expired: '만료',
  };
  return labels[status];
}

function transitionTargetLabel(status: ChartAnalysisStatus): string {
  const labels: Record<ChartAnalysisStatus, string> = {
    forming: '형성 중으로',
    candidate: '후보로',
    confirmed: '확정으로',
    weakened: '약화로',
    invalidated: '무효화로',
    expired: '만료로',
  };
  return labels[status];
}

function specializedCopy(
  input: ChartAnalysisInput,
  descriptor: PatternDescriptor,
  status: ChartAnalysisStatus,
): {
  title: string;
  summary: string;
  confirmationConditions: string[];
  invalidationConditions: string[];
} {
  if (descriptor.type === 'double-top') {
    return {
      title: `${descriptor.subtype} ${statusLabel(status)}`,
      summary:
        status === 'confirmed'
          ? `넥라인 ${input.support} 아래에서 ${input.timeframe} 확정봉이 마감해 하락 패턴이 확인됐습니다.`
          : status === 'invalidated'
            ? `기준 고점·저항 ${input.resistance} 위를 확정봉으로 회복해 이중천장 판단이 무효화됐습니다.`
            : `두 고점이 비슷한 가격대에서 형성됐지만 넥라인 이탈 전이므로 하락 후보로만 표시합니다.`,
      confirmationConditions: [
        `완료된 ${input.timeframe} 캔들이 넥라인 ${input.support} 아래에서 마감`,
        '두 번째 고점 이후 거래량과 모멘텀이 둔화',
      ],
      invalidationConditions: [
        `완료된 ${input.timeframe} 캔들이 기준 고점·저항 ${input.resistance} 위를 회복`,
      ],
    };
  }

  if (descriptor.type === 'double-bottom') {
    return {
      title: `${descriptor.subtype} ${statusLabel(status)}`,
      summary:
        status === 'confirmed'
          ? `넥라인 ${input.resistance} 위에서 ${input.timeframe} 확정봉이 마감해 상승 패턴이 확인됐습니다.`
          : status === 'invalidated'
            ? `기준 저점·지지 ${input.support} 아래에서 확정봉이 마감해 이중바닥 판단이 무효화됐습니다.`
            : `두 저점이 비슷한 가격대에서 형성됐지만 넥라인 돌파 전이므로 상승 후보로만 표시합니다.`,
      confirmationConditions: [
        `완료된 ${input.timeframe} 캔들이 넥라인 ${input.resistance} 위에서 마감`,
        '두 번째 저점 이후 거래량과 모멘텀이 개선',
      ],
      invalidationConditions: [
        `완료된 ${input.timeframe} 캔들이 기준 저점·지지 ${input.support} 아래에서 마감`,
      ],
    };
  }

  return {
    title: input.title,
    summary: input.summary,
    confirmationConditions: [
      `완료된 ${input.timeframe} 캔들이 저항 ${input.resistance} 위에서 마감`,
      '거래량과 추세 지표가 같은 방향을 유지',
    ],
    invalidationConditions: [
      `완료된 ${input.timeframe} 캔들이 지지 ${input.support} 아래에서 마감`,
      '반대 방향 구조 전환 신호 발생',
    ],
  };
}

function transitionReason(previous: ChartAnalysis | null | undefined, nextStatus: ChartAnalysisStatus): string {
  if (!previous) return `${statusLabel(nextStatus)} 상태로 최초 감지`;
  if (previous.status === nextStatus) return `${statusLabel(nextStatus)} 상태 유지`;
  return `${statusLabel(previous.status)}에서 ${transitionTargetLabel(nextStatus)} 변경`;
}

export function buildChartAnalysis(input: ChartAnalysisInput): ChartAnalysis {
  const descriptor = patternDescriptor(input.patterns, input.trend);
  const bias = effectiveBias(input, descriptor);
  const engineVersion = input.engineVersion ?? DEFAULT_ENGINE_VERSION;
  const status = deriveStatus(input, descriptor);
  const detectedAt = new Date(finite(input.latestTime) * 1000).toISOString();
  const anchorTimes = input.anchorTimes?.length ? input.anchorTimes : [input.latestTime];
  const id = createStableAnalysisId({
    engineVersion,
    market: input.market,
    symbol: input.symbol,
    timeframe: input.timeframe,
    type: descriptor.type,
    subtype: descriptor.subtype,
    anchorTimes,
    bias,
  });
  const previous = input.previousAnalysis?.id === id ? input.previousAnalysis : null;
  const copy = specializedCopy(input, descriptor, status);
  const reasons = [
    `가격 구조: ${input.trend || '중립'}`,
    `거래량 비율: ${clamp(input.volumeRatio, 0, 999).toFixed(2)}배`,
    input.rsi == null || !Number.isFinite(input.rsi) ? 'RSI: unavailable' : `RSI: ${input.rsi.toFixed(1)}`,
    input.macd == null || !Number.isFinite(input.macd) ? 'MACD: unavailable' : `MACD: ${input.macd.toFixed(3)}`,
    ...input.patterns.map((pattern) => `패턴 후보: ${pattern}`),
  ];
  if (input.dataStatus) reasons.push(`데이터 상태: ${input.dataStatus}`);

  const points = input.anchorPoints?.length
    ? input.anchorPoints.filter((point) => Number.isFinite(point.time) && Number.isFinite(point.price))
    : [{ time: input.latestTime, price: input.currentPrice, role: 'latest' }];

  return {
    id,
    type: descriptor.type,
    subtype: descriptor.subtype,
    symbol: input.symbol,
    market: input.market,
    timeframe: input.timeframe,
    status,
    bias,
    confidence: Math.round(clamp(input.confidence, 0, 100)),
    createdAt: previous?.createdAt ?? detectedAt,
    detectedAt,
    confirmedAt: status === 'confirmed' ? previous?.confirmedAt ?? detectedAt : previous?.confirmedAt,
    weakenedAt: status === 'weakened' ? previous?.weakenedAt ?? detectedAt : previous?.weakenedAt,
    invalidatedAt: status === 'invalidated' ? previous?.invalidatedAt ?? detectedAt : previous?.invalidatedAt,
    expiredAt: status === 'expired' ? previous?.expiredAt ?? detectedAt : previous?.expiredAt,
    startTime: Math.min(...anchorTimes.filter(Number.isFinite), input.latestTime),
    endTime: status === 'invalidated' || status === 'expired' ? input.latestTime : undefined,
    points,
    priceLevels: [
      { price: finite(input.support), role: 'support' },
      { price: finite(input.resistance), role: 'resistance' },
    ],
    title: copy.title,
    summary: copy.summary,
    reasons,
    confirmationConditions: copy.confirmationConditions,
    invalidationConditions: copy.invalidationConditions,
    relatedIndicators: {
      trend: input.trend,
      rsi: input.rsi,
      macd: input.macd,
      volumeRatio: finite(input.volumeRatio),
      previousClose: finite(input.previousClose),
      currentPrice: finite(input.currentPrice),
      closedCandle: input.isClosedCandle,
      dataStatus: input.dataStatus ?? null,
    },
    source: input.source,
    engineVersion,
    transitionReason: transitionReason(previous, status),
  };
}

function confidenceBucket(value: number): number {
  return Math.floor(clamp(value, 0, 100) / 10);
}

export function shouldAppendTimeline(previous: ChartAnalysis | null, next: ChartAnalysis): boolean {
  if (!previous) return true;
  if (previous.id !== next.id) return true;
  if (previous.status !== next.status) return true;
  if (previous.bias !== next.bias) return true;
  if (confidenceBucket(previous.confidence) !== confidenceBucket(next.confidence)) return true;
  return previous.reasons[0] !== next.reasons[0];
}

export function chartAnalysisTimelineKey(analysis: ChartAnalysis): string {
  return [
    analysis.id,
    analysis.status,
    analysis.bias,
    confidenceBucket(analysis.confidence),
    normalizeToken(analysis.transitionReason),
  ].join(':');
}
