import { createHash } from 'node:crypto';

import {
  ADAPTIVE_MULTI_MARKET_PROFILES_V1,
} from '../../market-prediction-lab/src/adaptive-multi-market-tournament-orchestrator-v1.js';
import {
  auditStockUniverseBias,
} from '../../market-prediction-lab/src/stock-universe-bias-audit.js';
import {
  BITGET_TIMEFRAME_MS,
} from '../../market-prediction-lab/src/bitget-candle-collector.js';
import {
  evaluateTransactionCostEvidence,
} from '../../market-intelligence-sidecar/src/transaction-cost-evidence.mjs';
import {
  createAdaptiveEvidenceReceiptV1,
} from './research-adaptive-evidence-catalog.mjs';
import {
  assertResearchDatasetSnapshotManifestV1,
} from './research-dataset-snapshot-store.mjs';

export const RESEARCH_CANONICAL_RECEIPT_PRODUCERS_CONTRACT_V1 =
  'research-canonical-receipt-producers/v1';

const HORIZON_BY_TIMEFRAME=Object.freeze({
  '15m':'SHORT',
  '1h':'SWING',
  '1d':'POSITION',
});

function canonical(value){
  if(Array.isArray(value)) return value.map(canonical);
  if(!value||typeof value!=='object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
}
function digest(value){return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
function exactIso(value,name){
  const text=String(value??'');
  const date=new Date(text);
  if(!Number.isFinite(date.getTime())) throw new TypeError(`${name} invalid`);
  return date.toISOString();
}
function profilesForMarket(market){
  return ADAPTIVE_MULTI_MARKET_PROFILES_V1.filter(row=>row.market===market);
}

export function buildStockUniverseAdaptiveReceiptsV1({
  datasetManifest,
  auditInput,
  observedAt,
}={}){
  assertResearchDatasetSnapshotManifestV1(datasetManifest);
  if(!['KR_STOCK','US_STOCK'].includes(datasetManifest.market)){
    throw new Error('STOCK_UNIVERSE_RECEIPT_MARKET_INVALID');
  }
  const audit=auditStockUniverseBias(auditInput);
  if(audit.market!==datasetManifest.market) throw new Error('STOCK_UNIVERSE_AUDIT_MARKET_MISMATCH');
  if(audit.status!=='point_in_time_bias_gate_passed'
    ||audit.gates?.pointInTimeMembershipsPresent!==true
    ||audit.gates?.removedNamesPresent!==true
    ||audit.gates?.membershipHistoryCoveragePassed!==true
    ||audit.gates?.removedNameHistoryCoveragePassed!==true
    ||audit.safeguards?.currentConstituentListAloneCannotPass!==true
    ||audit.safeguards?.missingHistoriesFailClosed!==true
    ||audit.safeguards?.liveExecutionAllowed!==false
    ||audit.safeguards?.privateAccountRequestAllowed!==false
    ||audit.safeguards?.actualOrders!==0){
    const error=new Error('STOCK_UNIVERSE_AUDIT_NOT_READY');
    error.reasons=audit.reasons;
    throw error;
  }
  const at=exactIso(observedAt,'observedAt');
  const sourceDigest=digest(audit);
  const receipts=[];
  for(const profile of profilesForMarket(datasetManifest.market)){
    for(const requirement of ['POINT_IN_TIME_UNIVERSE','DELISTED_UNIVERSE_INCLUDED']){
      if(!profile.requiredEvidence.includes(requirement)) continue;
      receipts.push(createAdaptiveEvidenceReceiptV1({
        profileId:profile.profileId,
        requirement,
        evidenceId:`stock-universe-audit:${audit.manifestSha256}:${requirement}`,
        observedAt:at,
        datasetSnapshotHash:datasetManifest.datasetSnapshotHash,
        sourceDigest,
      }));
    }
  }
  return Object.freeze({
    schemaVersion:1,
    contract:RESEARCH_CANONICAL_RECEIPT_PRODUCERS_CONTRACT_V1,
    kind:'STOCK_UNIVERSE_BIAS_AUDIT',
    sourceDigest,
    receiptCount:receipts.length,
    receipts:Object.freeze(receipts),
    executionAuthority:'NONE',
  });
}

function validateClosedCandleCollection(collection){
  if(!collection||typeof collection!=='object'||Array.isArray(collection)
    ||collection.schemaVersion!==1
    ||collection.provider!=='bitget-public-v2'
    ||!['CRYPTO_SPOT','CRYPTO_FUTURES'].includes(collection.market)
    ||typeof collection.symbol!=='string'||!/^[A-Z0-9]{3,30}$/.test(collection.symbol)
    ||!HORIZON_BY_TIMEFRAME[collection.timeframe]
    ||!Number.isSafeInteger(collection.collectedAt)||collection.collectedAt<=0
    ||!Array.isArray(collection.candles)||collection.candles.length<60){
    throw new Error('CLOSED_CANDLE_COLLECTION_INVALID');
  }
  const interval=BITGET_TIMEFRAME_MS[collection.timeframe];
  let previous=null;
  for(const row of collection.candles){
    if(!row||typeof row!=='object'||Array.isArray(row)
      ||!Number.isSafeInteger(row.timestamp)||row.timestamp<=0
      ||row.timestamp%interval!==0
      ||![row.open,row.high,row.low,row.close,row.volume].every(Number.isFinite)
      ||row.open<=0||row.high<=0||row.low<=0||row.close<=0||row.volume<0
      ||row.high<Math.max(row.open,row.close)
      ||row.low>Math.min(row.open,row.close)
      ||row.high<row.low){
      throw new Error('CLOSED_CANDLE_ROW_INVALID');
    }
    if(previous!=null&&row.timestamp<=previous) throw new Error('CLOSED_CANDLE_ORDER_INVALID');
    if(row.timestamp+interval>collection.collectedAt) throw new Error('OPEN_CANDLE_EVIDENCE_FORBIDDEN');
    previous=row.timestamp;
  }
  return collection;
}

export function buildTransactionCostPolicyAdaptiveReceiptsV1({
  datasetManifest,
  costEvidenceInput,
  policyInput={},
}={}){
  assertResearchDatasetSnapshotManifestV1(datasetManifest);
  const evaluated=evaluateTransactionCostEvidence(costEvidenceInput,policyInput);
  if(evaluated.market!==datasetManifest.market) throw new Error('TRANSACTION_COST_DATASET_MARKET_MISMATCH');
  if(evaluated.status!=='READY'
    ||evaluated.readyForNetAlpha!==true
    ||evaluated.safety?.executionAuthority!=='NONE'
    ||evaluated.safety?.numericalAuthority!=='EVIDENCE_NORMALIZATION_ONLY'
    ||evaluated.safety?.promotionAuthority!==false
    ||evaluated.safety?.liveTradingAuthority!==false
    ||evaluated.safety?.orderAllowed!==false
    ||evaluated.safety?.privateTradingApiAllowed!==false){
    const error=new Error('TRANSACTION_COST_EVIDENCE_NOT_READY');
    error.reasons=evaluated.reasons;
    throw error;
  }
  if(!evaluated.policy?.version||typeof evaluated.policy.version!=='string'){
    throw new Error('TRANSACTION_COST_POLICY_VERSION_MISSING');
  }
  const at=evaluated.newestEvidenceAt==null
    ? datasetManifest.createdAt
    : new Date(evaluated.newestEvidenceAt).toISOString();
  const sourceDigest=digest(evaluated);
  const receipts=[];
  for(const profile of profilesForMarket(datasetManifest.market)){
    if(!profile.requiredEvidence.includes('COST_POLICY_IDENTITY')) continue;
    receipts.push(createAdaptiveEvidenceReceiptV1({
      profileId:profile.profileId,
      requirement:'COST_POLICY_IDENTITY',
      evidenceId:`transaction-cost-policy:${evaluated.policy.version}:${evaluated.evidenceSetVersion}:${sourceDigest}`,
      observedAt:at,
      datasetSnapshotHash:datasetManifest.datasetSnapshotHash,
      sourceDigest,
    }));
  }
  return Object.freeze({
    schemaVersion:1,
    contract:RESEARCH_CANONICAL_RECEIPT_PRODUCERS_CONTRACT_V1,
    kind:'TRANSACTION_COST_POLICY',
    policyVersion:evaluated.policy.version,
    evidenceSetVersion:evaluated.evidenceSetVersion,
    sourceDigest,
    receiptCount:receipts.length,
    receipts:Object.freeze(receipts),
    executionAuthority:'NONE',
  });
}

export function buildClosedCandleAdaptiveReceiptV1({
  datasetManifest,
  candleCollection,
}={}){
  assertResearchDatasetSnapshotManifestV1(datasetManifest);
  const collection=validateClosedCandleCollection(candleCollection);
  if(collection.market!==datasetManifest.market) throw new Error('CANDLE_DATASET_MARKET_MISMATCH');
  const horizon=HORIZON_BY_TIMEFRAME[collection.timeframe];
  const profile=ADAPTIVE_MULTI_MARKET_PROFILES_V1.find(
    row=>row.market===collection.market&&row.horizon===horizon,
  );
  if(!profile||!profile.requiredEvidence.includes('EXACT_TIMEFRAME_CLOSED_OHLCV')){
    throw new Error('CANDLE_ADAPTIVE_PROFILE_UNSUPPORTED');
  }
  const sourceDigest=digest({
    schemaVersion:collection.schemaVersion,
    provider:collection.provider,
    market:collection.market,
    symbol:collection.symbol,
    timeframe:collection.timeframe,
    productType:collection.productType??null,
    candles:collection.candles,
  });
  const receipt=createAdaptiveEvidenceReceiptV1({
    profileId:profile.profileId,
    requirement:'EXACT_TIMEFRAME_CLOSED_OHLCV',
    evidenceId:`bitget-closed-ohlcv:${sourceDigest}`,
    observedAt:new Date(collection.collectedAt).toISOString(),
    datasetSnapshotHash:datasetManifest.datasetSnapshotHash,
    sourceDigest,
  });
  return Object.freeze({
    schemaVersion:1,
    contract:RESEARCH_CANONICAL_RECEIPT_PRODUCERS_CONTRACT_V1,
    kind:'BITGET_CLOSED_OHLCV',
    sourceDigest,
    receipt,
    executionAuthority:'NONE',
  });
}
