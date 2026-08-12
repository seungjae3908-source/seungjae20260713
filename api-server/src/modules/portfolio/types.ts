export type PortfolioMarket = 'KR' | 'US' | 'UPBIT' | 'BITGET';
export type RiskProfile = 'conservative' | 'balanced' | 'aggressive';
export type InvestmentHorizon = 'short' | 'medium' | 'long' | string;

export type Metric<T> =
  | { status: 'available'; value: T }
  | { status: 'insufficient'; reason: string; missing?: string[] };

export type Position = {
  assetId: string;
  market: PortfolioMarket;
  symbol: string;
  quantity: number;
  averageCost: number | null;
  currentPrice: number | null;
  currency: string;
  sector?: string | null;
};

export type PortfolioInput = {
  positions: Position[];
  cash: number;
  baseCurrency: string;
  investmentBudget?: number;
  investmentHorizon?: InvestmentHorizon;
  riskProfile?: RiskProfile;
  markets?: PortfolioMarket[];
  requiredSymbols?: string[];
  excludedSymbols?: string[];
};

export type CorrelationPair = {
  leftAssetId: string;
  rightAssetId: string;
  correlation: number;
};

export type RiskEvidence = {
  annualizedVolatilityByAssetId?: Record<string, number | null | undefined>;
  correlations?: CorrelationPair[];
};

export type RiskScoreBand = {
  maxVolatilityPercent: number;
  score: number;
};

export type RiskScorePolicy = {
  bands: RiskScoreBand[];
};

export type PortfolioAnalyticsInput = PortfolioInput & {
  riskEvidence?: RiskEvidence;
  riskScorePolicy?: RiskScorePolicy;
};

export type PositionAnalytics = {
  assetId: string;
  symbol: string;
  marketValue: Metric<number>;
  weight: Metric<number>;
  unrealizedPnl: Metric<number>;
  returnPercent: Metric<number>;
  riskContributionPercent: Metric<number>;
};

export type PortfolioAnalyticsResult = {
  totalValue: Metric<number>;
  knownValue: number;
  cashValue: number;
  cashWeight: Metric<number>;
  marketExposure: Metric<Record<string, number>>;
  sectorExposure: Metric<Record<string, number>>;
  currencyExposure: Metric<Record<string, number>>;
  concentration: Metric<number>;
  unrealizedPnl: Metric<number>;
  returnPercent: Metric<number>;
  volatilityPercent: Metric<number>;
  correlation: Metric<number>;
  portfolioRiskScore: Metric<number>;
  positions: PositionAnalytics[];
  missing: string[];
};

export type EvidenceStatus = 'verified' | 'partial' | 'insufficient';

export type ProposalCandidate = {
  assetId: string;
  market: PortfolioMarket;
  symbol: string;
  price: number | null;
  currency: string;
  role?: string;
  dataQuality: 'pass' | 'fail' | 'unknown';
  liquidity: 'pass' | 'fail' | 'unknown';
  scannerEvidence: EvidenceStatus;
  backtestEvidence: EvidenceStatus;
  risk: 'pass' | 'fail' | 'unknown';
  correlation: 'pass' | 'fail' | 'unknown';
  rationale?: string[];
};

export type AllocationPolicy = {
  maxPositions: number;
  maxPositionWeight: number;
  minCashWeight: number;
  requireVerifiedBacktest: boolean;
  requireScannerEvidence: boolean;
  requireKnownCorrelation: boolean;
};

export type PortfolioProposalInput = {
  investmentBudget: number;
  investmentHorizon: InvestmentHorizon;
  riskProfile: RiskProfile;
  markets: PortfolioMarket[];
  requiredSymbols: string[];
  excludedSymbols: string[];
  candidates: ProposalCandidate[];
  allocationPolicy?: AllocationPolicy;
};

export type PortfolioAllocation = {
  assetId: string | null;
  symbol: string;
  weight: number;
  budget: number;
  role: string;
  riskContribution: null;
  rationale: string[];
  evidenceStatus: EvidenceStatus;
};

export type PortfolioProposalResult = {
  status: 'READY' | 'INSUFFICIENT_POLICY' | 'INSUFFICIENT_CANDIDATES';
  allocations: PortfolioAllocation[];
  rejected: Array<{ symbol: string; reasons: string[] }>;
  requiredMissing: string[];
  notes: string[];
};

export type BacktestScenarioEvidence = {
  strategyVersion: string;
  sampleSize: number | null;
  oosPassed: boolean | null;
  walkForwardPassed: boolean | null;
  maxDrawdownPercent: number | null;
  expectancy: number | null;
  profitFactor: number | null;
  confidence: number | null;
  costStressPassed: boolean | null;
  validatedScenarioReturnsPercent?: {
    bear: number;
    base: number;
    bull: number;
  } | null;
};

export type ScenarioEvidencePolicy = {
  minSampleSize: number;
  requireOos: boolean;
  requireWalkForward: boolean;
  requireCostStress: boolean;
  minProfitFactor?: number;
  minConfidence?: number;
};

export type PortfolioScenarioResult = {
  returnScenarioStatus:
    | 'INSUFFICIENT_EVIDENCE'
    | 'EVIDENCE_SUFFICIENT_NO_RETURN_ESTIMATE'
    | 'VALIDATED_SCENARIOS_AVAILABLE';
  evidence: BacktestScenarioEvidence;
  missingOrFailed: string[];
  scenarios: {
    bear: { returnPercent: number | null; basis: string };
    base: { returnPercent: number | null; basis: string };
    bull: { returnPercent: number | null; basis: string };
  };
};

export type InformationAdvisorContext = {
  assetIdentity?: unknown;
  quote?: unknown;
  market?: unknown;
  technical?: unknown;
  scanner?: unknown;
  pricePlan?: unknown;
  patterns?: unknown;
  financials?: unknown;
  news?: unknown;
  filings?: unknown;
  backtestEvidence?: unknown;
  freshness?: unknown;
  missing: string[];
};

export type PortfolioAdvisorContext = {
  portfolioSummary: PortfolioAnalyticsResult;
  holdings: Position[];
  averageCost: Array<{ assetId: string; averageCost: number | null }>;
  weights: Array<{ assetId: string; weight: Metric<number> }>;
  cash: number;
  risk: {
    concentration: Metric<number>;
    volatilityPercent: Metric<number>;
    portfolioRiskScore: Metric<number>;
  };
  correlation: Metric<number>;
  holdingAnalysis: PositionAnalytics[];
  scannerEvidence?: unknown;
  backtestEvidence?: unknown;
  marketContext?: unknown;
  missing: string[];
};

export type AdvisorEnvelope<T> = {
  context: T;
  deterministicAnalysisAvailable: true;
  aiExplanationAvailable: boolean;
  orderAuthority: 'none';
};
