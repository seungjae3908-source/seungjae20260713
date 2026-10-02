import { createHash } from 'node:crypto';
import { requiredInferenceEvidenceFeatures } from '../../market-prediction-lab/src/engine.js';

export const RESEARCH_DATA_FEATURE_STATES = Object.freeze([
  'HISTORICAL_READY',
  'DERIVABLE_HISTORICAL',
  'FORWARD_ACCUMULATING',
  'SOURCE_REQUIRED',
  'BLOCKED_DATA',
]);

const HASH64=/^[0-9a-f]{64}$/i;
const MARKETS=new Set(['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES']);

const CATALOG=Object.freeze({
  benchmarkReturn:Object.freeze({
    mode:'DERIVABLE_HISTORICAL',
    owner:'market-prediction-lab/public-benchmark-candles',
    publicOnly:true,
    requires:['benchmarkDatasetDigest'],
  }),
  fundingRate:Object.freeze({
    mode:'HISTORICAL_READY',
    owner:'market-prediction-lab/derivatives-history.collectFundingRateHistory',
    publicOnly:true,
    requires:['fundingHistoryDigest','fundingCoverage'],
  }),
  longShortBias:Object.freeze({
    mode:'FORWARD_ACCUMULATING',
    owner:'market-prediction-lab/derivatives-history.collectLongShortRatioHistory',
    publicOnly:true,
    requires:['longShortHistoryDigest','longShortCoverage','longShortTrainingParityConfirmed'],
  }),
  openInterestChange:Object.freeze({
    mode:'FORWARD_ACCUMULATING',
    owner:'market-prediction-lab/derivatives-history.createTemporalDerivativesProvider',
    publicOnly:true,
    requires:['openInterestHistoryDigest','openInterestCoverage','openInterestTrainingParityConfirmed'],
  }),
  sentimentScore:Object.freeze({
    mode:'FORWARD_ACCUMULATING',
    owner:'api-server/news-sentiment + research temporal archive',
    publicOnly:true,
    requires:['sentimentHistoryDigest','sentimentCoverage','sentimentTemporalParityConfirmed'],
  }),
  foreignNetRatio:Object.freeze({
    mode:'SOURCE_REQUIRED',
    owner:'research-data-factory/stock-flow-producer',
    publicOnly:true,
    requires:['foreignFlowHistoryDigest','foreignFlowCoverage','foreignFlowTemporalParityConfirmed'],
  }),
  institutionNetRatio:Object.freeze({
    mode:'SOURCE_REQUIRED',
    owner:'research-data-factory/stock-flow-producer',
    publicOnly:true,
    requires:['institutionFlowHistoryDigest','institutionFlowCoverage','institutionFlowTemporalParityConfirmed'],
  }),
});

function canonical(value){
  if(Array.isArray(value)) return value.map(canonical);
  if(!value||typeof value!=='object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
}
function digest(value){return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
function finiteCoverage(value){return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;}
function validDigest(value){return typeof value==='string'&&HASH64.test(value);}
function featureEvidenceReady(feature, evidence={}){
  switch(feature){
    case 'benchmarkReturn':
      return validDigest(evidence.benchmarkDatasetDigest);
    case 'fundingRate':
      return validDigest(evidence.fundingHistoryDigest)&&finiteCoverage(evidence.fundingCoverage)&&evidence.fundingCoverage>=0.9;
    case 'longShortBias':
      return evidence.longShortTrainingParityConfirmed===true
        &&validDigest(evidence.longShortHistoryDigest)&&finiteCoverage(evidence.longShortCoverage)&&evidence.longShortCoverage>=0.9;
    case 'openInterestChange':
      return evidence.openInterestTrainingParityConfirmed===true
        &&validDigest(evidence.openInterestHistoryDigest)&&finiteCoverage(evidence.openInterestCoverage)&&evidence.openInterestCoverage>=0.9;
    case 'sentimentScore':
      return evidence.sentimentTemporalParityConfirmed===true
        &&validDigest(evidence.sentimentHistoryDigest)&&finiteCoverage(evidence.sentimentCoverage)&&evidence.sentimentCoverage>=0.9;
    case 'foreignNetRatio':
      return evidence.foreignFlowTemporalParityConfirmed===true
        &&validDigest(evidence.foreignFlowHistoryDigest)&&finiteCoverage(evidence.foreignFlowCoverage)&&evidence.foreignFlowCoverage>=0.9;
    case 'institutionNetRatio':
      return evidence.institutionFlowTemporalParityConfirmed===true
        &&validDigest(evidence.institutionFlowHistoryDigest)&&finiteCoverage(evidence.institutionFlowCoverage)&&evidence.institutionFlowCoverage>=0.9;
    default:return false;
  }
}
function statusFor(feature,evidence){
  const entry=CATALOG[feature];
  if(!entry) return {state:'SOURCE_REQUIRED',reason:'CANONICAL_TEMPORAL_PRODUCER_UNREGISTERED',owner:null};
  if(featureEvidenceReady(feature,evidence)){
    return {state:entry.mode==='DERIVABLE_HISTORICAL'?'DERIVABLE_HISTORICAL':'HISTORICAL_READY',reason:null,owner:entry.owner};
  }
  if(entry.mode==='FORWARD_ACCUMULATING') return {state:'FORWARD_ACCUMULATING',reason:'TEMPORAL_COVERAGE_OR_PARITY_INSUFFICIENT',owner:entry.owner};
  if(entry.mode==='SOURCE_REQUIRED') return {state:'SOURCE_REQUIRED',reason:'CANONICAL_TIME_ALIGNED_SOURCE_REQUIRED',owner:entry.owner};
  if(entry.mode==='DERIVABLE_HISTORICAL') return {state:'BLOCKED_DATA',reason:'BENCHMARK_DATASET_EVIDENCE_MISSING',owner:entry.owner};
  return {state:'BLOCKED_DATA',reason:'HISTORICAL_EVIDENCE_INCOMPLETE',owner:entry.owner};
}

export function buildResearchDataReadinessV1({market,evidence={}}={}){
  if(!MARKETS.has(market)) throw new TypeError('unsupported research market');
  if(!evidence||typeof evidence!=='object'||Array.isArray(evidence)) throw new TypeError('evidence must be an object');
  const required=[...requiredInferenceEvidenceFeatures(market)];
  const features=required.map(feature=>{
    const entry=CATALOG[feature]??null;
    const status=statusFor(feature,evidence);
    return Object.freeze({
      feature,
      state:status.state,
      reason:status.reason,
      owner:status.owner,
      publicOnly:entry?.publicOnly===true,
      requiredEvidence:Object.freeze([...(entry?.requires??[])]),
      syntheticAllowed:false,
      replayCreditAllowed:false,
      backfillCreditAllowed:false,
    });
  });
  const ready=features.every(row=>['HISTORICAL_READY','DERIVABLE_HISTORICAL'].includes(row.state));
  const blockers=features.filter(row=>!['HISTORICAL_READY','DERIVABLE_HISTORICAL'].includes(row.state))
    .map(row=>Object.freeze({feature:row.feature,state:row.state,reason:row.reason,owner:row.owner}));
  const evidenceIdentity={
    market,
    required,
    evidence:Object.fromEntries(Object.entries(evidence).filter(([key,value])=>
      /Digest$/.test(key)||/Coverage$/.test(key)||/ParityConfirmed$/.test(key)
    )),
  };
  const evidenceDigest=digest(evidenceIdentity);
  const datasetSnapshotHash=ready?digest({market,evidenceDigest,required,featureStates:features.map(row=>[row.feature,row.state])}):null;
  return Object.freeze({
    schemaVersion:'research-data-readiness-v1',
    market,
    ready,
    requiredFeatures:Object.freeze(required),
    features:Object.freeze(features),
    blockers:Object.freeze(blockers),
    evidenceDigest,
    datasetSnapshotHash,
    safety:Object.freeze({
      publicDataOnly:true,
      syntheticImputation:false,
      zeroImputation:false,
      currentValueHistoricalBackfill:false,
      futureLeakage:false,
      economicCredit:false,
      executionAuthority:'NONE',
    }),
  });
}

export function buildResearchDataFactoryOverviewV1({evidenceByMarket={}}={}){
  const markets={};
  for(const market of MARKETS) markets[market]=buildResearchDataReadinessV1({market,evidence:evidenceByMarket[market]??{}});
  return Object.freeze({
    schemaVersion:'research-data-factory-overview-v1',
    markets:Object.freeze(markets),
    readyMarketCount:Object.values(markets).filter(row=>row.ready).length,
    blockedMarketCount:Object.values(markets).filter(row=>!row.ready).length,
    executionAuthority:'NONE',
  });
}
