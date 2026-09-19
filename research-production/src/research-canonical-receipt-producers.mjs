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
function profileForManifest(manifest){
  assertResearchDatasetSnapshotManifestV1(manifest);
  const profile=ADAPTIVE_MULTI_MARKET_PROFILES_V1.find(row=>row.profileId===manifest.profileId);
  if(!profile||profile.market!==manifest.market||profile.timeframe!==manifest.scope?.timeframe){
    throw new Error('DATASET_MANIFEST_ADAPTIVE_PROFILE_MISMATCH');
  }
  return profile;
}

export function buildStockUniverseAdaptiveReceiptsV1({
  datasetManifest,
  auditInput,
  observedAt,
}={}){
  const profile=profileForManifest(datasetManifest);
  if(!['KR_STOCK','US_STOCK'].includes(profile.market)){
    throw new Error('STOCK_UNIVERSE_RECEIPT_MARKET_INVALID');
  }
  const audit=auditStockUniverseBias(auditInput);
  if(audit.market!==profile.market) throw new Error('STOCK_UNIVERSE_AUDIT_MARKET_MISMATCH');
  if(audit.evaluationStartTime!==datasetManifest.scope.startTime
    ||audit.evaluationEndTime!==datasetManifest.scope.endTime){
    throw new Error('STOCK_UNIVERSE_AUDIT_RANGE_MISMATCH');
  }
  if(datasetManifest.scope.universeDigest!==audit.manifestSha256){
    throw new Error('STOCK_UNIVERSE_DIGEST_MISMATCH');
  }
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
  const receipts=['POINT_IN_TIME_UNIVERSE','DELISTED_UNIVERSE_INCLUDED']
    .filter(requirement=>profile.requiredEvidence.includes(requirement))
    .map(requirement=>createAdaptiveEvidenceReceiptV1({
      profileId:profile.profileId,
      requirement,
      evidenceId:`stock-universe-audit:${audit.manifestSha256}:${requirement}`,
      observedAt:at,
      datasetSnapshotHash:datasetManifest.datasetSnapshotHash,
      sourceDigest,
    }));
  return Object.freeze({
    schemaVersion:1,
    contract:RESEARCH_CANONICAL_RECEIPT_PRODUCERS_CONTRACT_V1,
    kind:'STOCK_UNIVERSE_BIAS_AUDIT',
    profileId:profile.profileId,
    sourceDigest,
    receiptCount:receipts.length,
    receipts:Object.freeze(receipts),
    executionAuthority:'NONE',
  });
}

export function buildTransactionCostPolicyAdaptiveReceiptV1({
  datasetManifest,
  costEvidenceInput,
  policyInput={},
}={}){
  const profile=profileForManifest(datasetManifest);
  const evaluated=evaluateTransactionCostEvidence(costEvidenceInput,policyInput);
  if(evaluated.market!==profile.market) throw new Error('TRANSACTION_COST_DATASET_MARKET_MISMATCH');
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
  if(!profile.requiredEvidence.includes('COST_POLICY_IDENTITY')){
    throw new Error('TRANSACTION_COST_POLICY_NOT_REQUIRED_FOR_PROFILE');
  }
  if(!evaluated.policy?.version||typeof evaluated.policy.version!=='string'){
    throw new Error('TRANSACTION_COST_POLICY_VERSION_MISSING');
  }
  const at=evaluated.newestEvidenceAt==null
    ? datasetManifest.createdAt
    : new Date(evaluated.newestEvidenceAt).toISOString();
  const sourceDigest=digest(evaluated);
  const receipt=createAdaptiveEvidenceReceiptV1({
    profileId:profile.profileId,
    requirement:'COST_POLICY_IDENTITY',
    evidenceId:`transaction-cost-policy:${evaluated.policy.version}:${evaluated.evidenceSetVersion}:${sourceDigest}`,
    observedAt:at,
    datasetSnapshotHash:datasetManifest.datasetSnapshotHash,
    sourceDigest,
  });
  return Object.freeze({
    schemaVersion:1,
    contract:RESEARCH_CANONICAL_RECEIPT_PRODUCERS_CONTRACT_V1,
    kind:'TRANSACTION_COST_POLICY',
    profileId:profile.profileId,
    policyVersion:evaluated.policy.version,
    evidenceSetVersion:evaluated.evidenceSetVersion,
    sourceDigest,
    receipt,
    executionAuthority:'NONE',
  });
}

function validateClosedCandleCollection(collection,manifest,profile){
  if(!collection||typeof collection!=='object'||Array.isArray(collection)
    ||collection.schemaVersion!==1
    ||collection.provider!=='bitget-public-v2'
    ||collection.market!==profile.market
    ||!['CRYPTO_SPOT','CRYPTO_FUTURES'].includes(collection.market)
    ||typeof collection.symbol!=='string'||!/^[A-Z0-9]{3,30}$/.test(collection.symbol)
    ||collection.timeframe!==manifest.scope.timeframe
    ||!Number.isSafeInteger(collection.collectedAt)||collection.collectedAt<manifest.scope.endTime
    ||!Array.isArray(collection.candles)){
    throw new Error('CLOSED_CANDLE_COLLECTION_INVALID');
  }
  if(!manifest.scope.symbols.includes(collection.symbol)){
    throw new Error('CLOSED_CANDLE_SYMBOL_OUTSIDE_SNAPSHOT');
  }
  const interval=BITGET_TIMEFRAME_MS[collection.timeframe];
  if(!Number.isSafeInteger(interval)||interval<=0
    ||(manifest.scope.endTime-manifest.scope.startTime)%interval!==0){
    throw new Error('CLOSED_CANDLE_SCOPE_INTERVAL_INVALID');
  }
  const expectedCount=(manifest.scope.endTime-manifest.scope.startTime)/interval;
  if(collection.candles.length!==expectedCount||expectedCount<60){
    throw new Error('CLOSED_CANDLE_SCOPE_COVERAGE_INCOMPLETE');
  }
  for(let index=0;index<collection.candles.length;index+=1){
    const row=collection.candles[index];
    const expectedTimestamp=manifest.scope.startTime+index*interval;
    if(!row||typeof row!=='object'||Array.isArray(row)
      ||row.timestamp!==expectedTimestamp
      ||![row.open,row.high,row.low,row.close,row.volume].every(Number.isFinite)
      ||row.open<=0||row.high<=0||row.low<=0||row.close<=0||row.volume<0
      ||row.high<Math.max(row.open,row.close)
      ||row.low>Math.min(row.open,row.close)
      ||row.high<row.low){
      throw new Error('CLOSED_CANDLE_ROW_INVALID');
    }
  }
  return collection;
}

export function buildClosedCandleAdaptiveReceiptV1({
  datasetManifest,
  candleCollections=[],
}={}){
  const profile=profileForManifest(datasetManifest);
  if(!['CRYPTO_SPOT','CRYPTO_FUTURES'].includes(profile.market)){
    throw new Error('CANDLE_ADAPTIVE_PROFILE_UNSUPPORTED');
  }
  if(!profile.requiredEvidence.includes('EXACT_TIMEFRAME_CLOSED_OHLCV')){
    throw new Error('CANDLE_ADAPTIVE_PROFILE_UNSUPPORTED');
  }
  if(!Array.isArray(candleCollections)) throw new TypeError('candleCollections must be an array');
  const bySymbol=new Map();
  for(const raw of candleCollections){
    const collection=validateClosedCandleCollection(raw,datasetManifest,profile);
    if(bySymbol.has(collection.symbol)) throw new Error('CLOSED_CANDLE_DUPLICATE_SYMBOL');
    bySymbol.set(collection.symbol,collection);
  }
  const missing=datasetManifest.scope.symbols.filter(symbol=>!bySymbol.has(symbol));
  const extra=[...bySymbol.keys()].filter(symbol=>!datasetManifest.scope.symbols.includes(symbol));
  if(missing.length||extra.length||bySymbol.size!==datasetManifest.scope.symbols.length){
    throw new Error('CLOSED_CANDLE_SNAPSHOT_SYMBOL_COVERAGE_INCOMPLETE');
  }
  const normalized=datasetManifest.scope.symbols.map(symbol=>bySymbol.get(symbol));
  const sourceDigest=digest(normalized.map(collection=>({
    schemaVersion:collection.schemaVersion,
    provider:collection.provider,
    market:collection.market,
    symbol:collection.symbol,
    timeframe:collection.timeframe,
    productType:collection.productType??null,
    candles:collection.candles,
  })));
  const observedAt=new Date(Math.max(...normalized.map(row=>row.collectedAt))).toISOString();
  const receipt=createAdaptiveEvidenceReceiptV1({
    profileId:profile.profileId,
    requirement:'EXACT_TIMEFRAME_CLOSED_OHLCV',
    evidenceId:`bitget-closed-ohlcv:${sourceDigest}`,
    observedAt,
    datasetSnapshotHash:datasetManifest.datasetSnapshotHash,
    sourceDigest,
  });
  return Object.freeze({
    schemaVersion:1,
    contract:RESEARCH_CANONICAL_RECEIPT_PRODUCERS_CONTRACT_V1,
    kind:'BITGET_CLOSED_OHLCV',
    profileId:profile.profileId,
    sourceDigest,
    symbolCount:normalized.length,
    receipt,
    executionAuthority:'NONE',
  });
}
