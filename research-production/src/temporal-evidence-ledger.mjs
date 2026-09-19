import { createHash } from 'node:crypto';

export const TEMPORAL_EVIDENCE_LEDGER_SCHEMA='research-temporal-evidence-ledger-v1';
const MARKETS=new Set(['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES']);
const FEATURE=/^[A-Za-z][A-Za-z0-9._-]{0,79}$/;
const SYMBOL=/^[A-Za-z0-9._:-]{1,64}$/;
const SOURCE=/^[A-Za-z0-9._:/-]{1,160}$/;
const SHA40=/^[0-9a-f]{40}$/i;

function canonical(value){
  if(Array.isArray(value)) return value.map(canonical);
  if(!value||typeof value!=='object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
}
function digest(value){return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
function timestamp(value,name){
  if(!Number.isSafeInteger(value)||value<=0) throw new TypeError(`${name} must be a positive millisecond timestamp`);
  return value;
}
function finite(value,name){
  if(typeof value!=='number'||!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return Object.is(value,-0)?0:value;
}
function normalizeObservation(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)) throw new TypeError('observation must be an object');
  if(!MARKETS.has(raw.market)) throw new TypeError('observation market unsupported');
  if(typeof raw.feature!=='string'||!FEATURE.test(raw.feature)) throw new TypeError('observation feature invalid');
  if(typeof raw.symbol!=='string'||!SYMBOL.test(raw.symbol)) throw new TypeError('observation symbol invalid');
  if(typeof raw.source!=='string'||!SOURCE.test(raw.source)) throw new TypeError('observation source invalid');
  const producerSha=String(raw.producerSha??'').toLowerCase();
  if(!SHA40.test(producerSha)) throw new TypeError('observation producerSha invalid');
  const observedAt=timestamp(raw.observedAt,'observedAt');
  const availableAt=timestamp(raw.availableAt??observedAt,'availableAt');
  const recordedAt=timestamp(raw.recordedAt??availableAt,'recordedAt');
  if(availableAt<observedAt) throw new Error('availableAt cannot precede observedAt');
  if(recordedAt<availableAt) throw new Error('recordedAt cannot precede availableAt');
  if(raw.synthetic===true||raw.replay===true||raw.backfill===true||raw.manual===true){
    throw new Error('temporal evidence ledger accepts genuine observations only');
  }
  const core={
    market:raw.market,
    symbol:raw.symbol,
    feature:raw.feature,
    value:finite(raw.value,'value'),
    observedAt,
    availableAt,
    recordedAt,
    source:raw.source,
    producerSha,
    publicDataOnly:raw.publicDataOnly===true,
    synthetic:false,
    replay:false,
    backfill:false,
    manual:false,
  };
  return Object.freeze({
    ...core,
    observationId:`temporal:sha256:${digest({
      market:core.market,symbol:core.symbol,feature:core.feature,observedAt:core.observedAt,source:core.source,producerSha:core.producerSha,
    })}`,
    evidenceDigest:digest(core),
  });
}

function sortRows(rows){
  return [...rows].sort((a,b)=>a.availableAt-b.availableAt||a.observedAt-b.observedAt||a.observationId.localeCompare(b.observationId));
}

export function createTemporalEvidenceLedgerV1({researchSha}={}){
  if(typeof researchSha!=='string'||!SHA40.test(researchSha)) throw new TypeError('researchSha must be exact SHA');
  const core={schemaVersion:TEMPORAL_EVIDENCE_LEDGER_SCHEMA,createdByResearchSha:researchSha.toLowerCase(),observations:[]};
  return Object.freeze({...core,ledgerDigest:digest(core),executionAuthority:'NONE'});
}

export function appendTemporalEvidenceV1(ledger,rawObservation){
  if(!ledger||ledger.schemaVersion!==TEMPORAL_EVIDENCE_LEDGER_SCHEMA) throw new TypeError('valid temporal ledger required');
  const observation=normalizeObservation(rawObservation);
  const existing=ledger.observations.find(row=>row.observationId===observation.observationId);
  if(existing){
    if(existing.evidenceDigest!==observation.evidenceDigest) throw new Error('conflicting temporal observation identity');
    return ledger;
  }
  const observations=Object.freeze(sortRows([...ledger.observations,observation]));
  const core={schemaVersion:TEMPORAL_EVIDENCE_LEDGER_SCHEMA,createdByResearchSha:ledger.createdByResearchSha,observations};
  return Object.freeze({...core,ledgerDigest:digest(core),executionAuthority:'NONE'});
}

export function appendTemporalEvidenceBatchV1(ledger,observations=[]){
  if(!Array.isArray(observations)) throw new TypeError('observations must be an array');
  let current=ledger;
  for(const observation of observations) current=appendTemporalEvidenceV1(current,observation);
  return current;
}

function latestAdmissible(rows,anchorTimestamp,maxAgeMs){
  let selected=null;
  for(const row of rows){
    if(row.observedAt>anchorTimestamp||row.availableAt>anchorTimestamp) continue;
    if(anchorTimestamp-row.observedAt>maxAgeMs) continue;
    if(!selected||row.observedAt>selected.observedAt||(row.observedAt===selected.observedAt&&row.availableAt>selected.availableAt)) selected=row;
  }
  return selected;
}

export function readTemporalFeatureAtV1(ledger,{market,symbol,feature,anchorTimestamp,maxAgeMs}={}){
  if(!ledger||ledger.schemaVersion!==TEMPORAL_EVIDENCE_LEDGER_SCHEMA) throw new TypeError('valid temporal ledger required');
  if(!MARKETS.has(market)||typeof symbol!=='string'||!SYMBOL.test(symbol)||typeof feature!=='string'||!FEATURE.test(feature)){
    throw new TypeError('temporal feature query invalid');
  }
  timestamp(anchorTimestamp,'anchorTimestamp');
  if(!Number.isSafeInteger(maxAgeMs)||maxAgeMs<=0) throw new TypeError('maxAgeMs must be positive');
  const rows=ledger.observations.filter(row=>row.market===market&&row.symbol===symbol&&row.feature===feature);
  const row=latestAdmissible(rows,anchorTimestamp,maxAgeMs);
  return row?Object.freeze({
    status:'PRESENT',
    value:row.value,
    observationId:row.observationId,
    evidenceDigest:row.evidenceDigest,
    observedAt:row.observedAt,
    availableAt:row.availableAt,
    ageMs:anchorTimestamp-row.observedAt,
    source:row.source,
    producerSha:row.producerSha,
  }):Object.freeze({status:'MISSING',value:null,observationId:null,evidenceDigest:null,observedAt:null,availableAt:null,ageMs:null,source:null});
}

export function summarizeTemporalFeatureCoverageV1(ledger,{market,symbol,feature,anchors,maxAgeMs}={}){
  if(!Array.isArray(anchors)||anchors.some(value=>!Number.isSafeInteger(value)||value<=0)) throw new TypeError('anchors must be positive timestamps');
  const unique=[...new Set(anchors)].sort((a,b)=>a-b);
  const records=unique.map(anchorTimestamp=>({
    anchorTimestamp,
    ...readTemporalFeatureAtV1(ledger,{market,symbol,feature,anchorTimestamp,maxAgeMs}),
  }));
  const present=records.filter(row=>row.status==='PRESENT').length;
  const coverage=unique.length===0?0:present/unique.length;
  const core={
    market,symbol,feature,maxAgeMs,
    anchorCount:unique.length,presentCount:present,coverage,
    records:records.map(row=>({
      anchorTimestamp:row.anchorTimestamp,status:row.status,observationId:row.observationId,evidenceDigest:row.evidenceDigest,
    })),
  };
  return Object.freeze({...core,coverageDigest:digest(core)});
}

export function projectTemporalFeatureProviderV1(ledger,{market,symbol,featureMap}={}){
  if(!featureMap||typeof featureMap!=='object'||Array.isArray(featureMap)) throw new TypeError('featureMap is required');
  return ({anchorTimestamp})=>{
    const values={};
    const featureAvailability={};
    for(const [feature,maxAgeMs] of Object.entries(featureMap)){
      const row=readTemporalFeatureAtV1(ledger,{market,symbol,feature,anchorTimestamp,maxAgeMs});
      if(row.status==='PRESENT') values[feature]=row.value;
      featureAvailability[`${feature}Known`]=row.status==='PRESENT';
      featureAvailability[`${feature}ObservationId`]=row.observationId;
      featureAvailability[`${feature}ObservedAt`]=row.observedAt;
      featureAvailability[`${feature}AgeMs`]=row.ageMs;
    }
    return Object.freeze({values:Object.freeze(values),featureAvailability:Object.freeze(featureAvailability)});
  };
}
