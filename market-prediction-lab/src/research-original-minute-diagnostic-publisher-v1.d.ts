import type {ResearchOriginalMinuteMarket} from
  './research-original-minute-diagnostic-readonly-v1.js';

export type ResearchOriginalMinutePublisherResult={
  schemaVersion:'research-original-minute-diagnostic-publisher-v1';
  market:ResearchOriginalMinuteMarket|null;
  status:string;reason:string;
  published:boolean;reportReplaced:boolean;
  privateReportRootExposed:false;sourceSensitiveDataPublished:false;
  providerGETCount:0;financialMutationCount:0;
  executionAuthority:'NONE';profitabilityProven:false;
  OOSPassCount:0;actualFillCount:null;trueMarketWideRecall:null;
  paperAdmissionAllowed:false;orderSubmitted:false;
  realOrders:false;liveTrading:false;autoTrading:false;
  sourceResultDigestSha256?:string;
  sourceModelDigestSha256?:string;
  reportPublishedAtMs?:number;
  reportMarket?:ResearchOriginalMinuteMarket;
};
export function publishResearchOriginalMinuteDiagnosticV1(input:{
  sourceResultPath:string;
  reportRoot:string;
  market:ResearchOriginalMinuteMarket;
  allowLocalReportPublish?:boolean;
  allowReplaceExisting?:boolean;
  nowImpl?:()=>number;
}):Promise<ResearchOriginalMinutePublisherResult>;
