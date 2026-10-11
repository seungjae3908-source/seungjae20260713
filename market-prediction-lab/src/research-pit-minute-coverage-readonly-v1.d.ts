export type ResearchPITMarket =
  | 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
export type ResearchPITMinuteCoverageInput = {
  root: string;
  market: ResearchPITMarket;
  startDate: string;
  endDate: string;
  cursorDate?: string | null;
  chunkDays?: number;
};
export type ResearchPITMinuteCoverageOutput = Readonly<{
  schemaVersion: 'research-pit-minute-coverage-readonly-v1';
  available: boolean;
  status: string;
  reason?: string | null;
  market: ResearchPITMarket;
  report: null | Readonly<Record<string, unknown>>;
  privateSourceFileCount: number;
  providerGETCount: 0;
  financialMutationCount: 0;
  originalScannerAsOfAvailabilityVerified: false;
  historicalPITUniverseIndependentlyAuthenticated: false;
  fullMarketOpportunityDenominatorVerified: false;
  trueMarketWideRecall: null;
  actualFillCount: null;
  netProfitPct: null;
  profitabilityProven: false;
  executionAuthority: 'NONE';
  liveTrading: false;
  autoTrading: false;
  realOrders: false;
}>;
export function readResearchPITMinuteCoverageV1(
  input: ResearchPITMinuteCoverageInput,
): Promise<ResearchPITMinuteCoverageOutput>;
