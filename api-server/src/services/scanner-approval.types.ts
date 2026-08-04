export type ScannerAssetType = 'stock' | 'coin_spot' | 'coin_futures';
export type ScannerMarket = 'KR' | 'US' | 'UPBIT' | 'BITGET';
export type ScannerDirection = 'LONG' | 'SHORT' | 'WATCH';
export type ScannerRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKED';
export type ScannerSignalState =
  | 'DETECTED'
  | 'WATCHING'
  | 'READY_FOR_APPROVAL'
  | 'APPROVAL_SENT'
  | 'APPROVED'
  | 'WEAKENED'
  | 'INVALIDATED'
  | 'EXPIRED'
  | 'REJECTED';

export type ScannerScoreBreakdown = {
  trend: number;
  volume: number;
  liquidity: number;
  technical: number;
  market: number;
  news: number;
  financial: number;
  riskPenalty: number;
};

export type ScannerEntryLeg = {
  sequence: 1 | 2 | 3;
  price: number;
  allocationRate: number;
  status: 'PLANNED' | 'ACTIVE' | 'CANCELLED' | 'FILLED';
};

export type ScannerSignalTransition = {
  from: ScannerSignalState | null;
  to: ScannerSignalState;
  changedAt: string;
  currentPrice: number;
  previousScore: number | null;
  currentScore: number;
  reason: string;
  changedConditions: string[];
  dataTimestamp: string;
};

export type ScannerTradingSignal = {
  id: string;
  assetType: ScannerAssetType;
  market: ScannerMarket;
  symbol: string;
  displayName: string;
  direction: ScannerDirection;
  timeframe: string;
  score: number;
  confidence: number;
  riskLevel: ScannerRiskLevel;
  scoreBreakdown: ScannerScoreBreakdown;
  selectedConditions: string[];
  matchedSignals: string[];
  reasons: string[];
  warnings: string[];
  currentPrice: number;
  entryPlan: { legs: ScannerEntryLeg[] };
  targets: Array<{ price: number; exitRate: number }>;
  stopLoss: number | null;
  expectedRiskReward: number | null;
  estimatedMaxLoss: number | null;
  state: ScannerSignalState;
  transitions: ScannerSignalTransition[];
  generatedAt: string;
  expiresAt: string;
  dataTimestamp: string;
};

export type ScannerMarketSnapshotInput = {
  observedAt?: string;
  dataDelayMs?: number;
  oneMinuteMovePercent?: number;
  spreadPercent?: number;
  orderbookGapPercent?: number;
  halted?: boolean;
};

export type ScannerSignalCandidate = {
  market: 'KR' | 'US';
  symbol: string;
  displayName?: string;
  timeframe?: string;
  currentPrice: number;
  score?: number;
  confidence?: number;
  riskScore?: number;
  riskLevel?: string;
  selectedConditions?: string[];
  matchedSignals?: string[];
  reasons?: string[];
  warnings?: string[];
  scoreBreakdown?: Partial<Record<keyof ScannerScoreBreakdown, unknown>>;
  entryPrices?: number[];
  targetPrices?: number[];
  stopLoss?: number;
  expectedRiskReward?: number;
  estimatedMaxLoss?: number;
  dataTimestamp?: string;
  expiresAt?: string;
  marketSnapshot?: ScannerMarketSnapshotInput;
};

export type ScannerApprovalPolicy = {
  minimumScore: number;
  minimumConfidence: number;
  maximumRiskScore: number;
  maximumOrderKrw: number;
  accountValueKrw: number;
  maximumDataAgeMs: number;
  maximumDataDelayMs: number;
  maximumSpreadPercent: number;
  maximumOneMinuteDropPercent: number;
  minimumRiskReward: number;
};

export type ScannerApprovalGuard = {
  enabled: boolean;
  reasons: string[];
  checkedAt: string;
};
