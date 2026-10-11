export type ResearchOriginalMinuteMarket =
  'KR_STOCK'|'US_STOCK'|'CRYPTO_SPOT'|'CRYPTO_FUTURES';
export type ResearchOriginalMinuteDiagnosticSummary = {
  kind:'PERIOD'|'SWEEP';
  status:string;
  selectedStartDate:string;
  selectedEndDate:string;
  executionAuthority:'NONE';
  profitabilityProven:false;
  paperCandidatePASS:false;
  actualFillCount:null;
  independentOOSProven:false;
  independentFullCostProven:false;
  originalHistoricalSignalVerified:false;
  symbol?:string;
  timeframe?:string|null;
  modeledTradeCount?:number|null;
  modeledReturnPercent?:number|null;
  modeledNetPnlKRW?:number|null;
  sourceSessionsVerified?:number|null;
  pageCountSelfAttested?:number;
  sourceTasksSelfAttested?:number|null;
  sourceOnlyObservedPriceEventLabels?:number;
  actualMarketWideOpportunityCount?:null;
  fullMarketOpportunityDenominatorVerified?:false;
};
export type ResearchOriginalMinuteDiagnosticResponse={
  schemaVersion:'research-original-minute-diagnostic-readonly-v1';
  market:ResearchOriginalMinuteMarket;
  available:boolean;
  status:string;
  reason:string;
  report:ResearchOriginalMinuteDiagnosticSummary|null;
  readOnly:true;
  privateSourcePathsDisclosed:false;
  providerGETCount:0;
  financialMutationCount:0;
  fullMarketOpportunityDenominatorVerified:false;
  actualMarketWideOpportunityCount:null;
  trueMarketWideRecall:null;
  actualFillCount:null;
  netProfitPct:null;
  OOSPassCount:0;
  historicalAsOfScannerSignalVerified:false;
  independentOOSAndFullCostProven:false;
  profitabilityProven:false;
  executionAuthority:'NONE';
  paperAdmissionAllowed:false;
  orderSubmitted:false;
  realOrders:false;
  reportPublishedAtMs:number|null;
  publicationAgeStatus:'UNKNOWN'|'LOCAL_PUBLICATION_ONLY'|'OLDER_THAN_7_DAYS';
  publicationTimeIndependentlyAttested:false;
};
export function readResearchOriginalMinuteDiagnosticV1(input:{
  root:string;market:ResearchOriginalMinuteMarket;
}):Promise<ResearchOriginalMinuteDiagnosticResponse>;

export function validateAndSanitizeOriginalMinuteDiagnosticV1(
  raw:Record<string,unknown>,
  market:ResearchOriginalMinuteMarket,
):ResearchOriginalMinuteDiagnosticSummary|null;
