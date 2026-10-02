import {
  sha256Canonical as hash,
} from '../../market-prediction-lab/src/research-cache-provenance.js';

export const RESEARCH_FROZEN_EVALUATION_POLICY_CONTRACT_V1 =
  'research-frozen-evaluation-policy/v1';

const SHA40=/^[0-9a-f]{40}$/u;
const DIGEST64=/^[0-9a-f]{64}$/u;
const SAFE_TEXT=/^[A-Za-z0-9._:/#-]{1,240}$/u;

function plain(value,name){
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}
function exactKeys(value,keys,code){
  plain(value,code);
  const actual=Object.keys(value).sort();
  const expected=[...keys].sort();
  if(actual.length!==expected.length||actual.some((key,index)=>key!==expected[index])) throw new Error(code);
}
function text(value,name){
  const normalized=String(value??'').trim();
  if(!SAFE_TEXT.test(normalized)) throw new TypeError(`${name} invalid`);
  return normalized;
}
function sha(value,name){
  const normalized=String(value??'').trim().toLowerCase();
  if(!SHA40.test(normalized)) throw new TypeError(`${name} must be exact SHA`);
  return normalized;
}
function digest(value,name){
  const normalized=String(value??'').trim().toLowerCase();
  if(!DIGEST64.test(normalized)) throw new TypeError(`${name} invalid`);
  return normalized;
}
function positiveTime(value,name){
  if(!Number.isSafeInteger(value)||value<=0) throw new TypeError(`${name} must be positive timestamp`);
  return value;
}
function times(values,name){
  if(!Array.isArray(values)||values.length===0) throw new TypeError(`${name} must be non-empty timestamps`);
  const rows=values.map((value,index)=>positiveTime(value,`${name}[${index}]`));
  for(let index=1;index<rows.length;index+=1){
    if(rows[index]<=rows[index-1]) throw new Error(`${name} must be strictly increasing`);
  }
  return Object.freeze(rows);
}
function scope(raw){
  exactKeys(raw,['datasetId','datasetDigest','market','symbol','timeframe','researchCodeSha'],'EVALUATION_SCOPE_SHAPE_INVALID');
  return Object.freeze({
    datasetId:text(raw.datasetId,'scope.datasetId'),
    datasetDigest:digest(raw.datasetDigest,'scope.datasetDigest'),
    market:text(raw.market,'scope.market').toUpperCase(),
    symbol:text(raw.symbol,'scope.symbol').toUpperCase(),
    timeframe:text(raw.timeframe,'scope.timeframe').toLowerCase(),
    researchCodeSha:sha(raw.researchCodeSha,'scope.researchCodeSha'),
  });
}
function seal(id,payload){
  const frozen=structuredClone(payload);
  return Object.freeze({id:text(id,'seal.id'),payload:Object.freeze(frozen),digest:hash(frozen)});
}
function disjoint(...groups){
  const seen=new Set();
  for(const group of groups){
    for(const value of group){
      if(seen.has(value)) return false;
      seen.add(value);
    }
  }
  return true;
}
function exactPartition(all,train,validation,oos){
  if(!disjoint(train,validation,oos)) return false;
  const combined=[...train,...validation,...oos].sort((a,b)=>a-b);
  if(combined.length!==all.length) return false;
  return combined.every((value,index)=>value===all[index]);
}
function requireBefore(left,right,code){
  if(!(left<right)) throw new Error(code);
}

export function buildFrozenResearchEvaluationPoliciesV1(raw={}){
  exactKeys(raw,[
    'scope','datasetTimestamps','trainAssignments','validationAssignments','oosAssignments',
    'splitPolicyId','splitReceiptId','splitFrozenAtMs','firstOutcomeObservedAtMs','splitObservedAtMs',
    'oosPolicyId','oosFrozenAtMs','oosStartTime','oosEndTime',
    'wfPolicyId','wfFrozenAtMs','wfWindows',
    'holdoutPolicyId','holdoutFrozenAtMs','holdoutDatasetId','holdoutFirewallIdentity',
    'holdoutAssignments','holdoutStartTime','holdoutEndTime',
  ],'FROZEN_EVALUATION_POLICY_INPUT_SHAPE_INVALID');

  const s=scope(raw.scope);
  const all=times(raw.datasetTimestamps,'datasetTimestamps');
  const train=times(raw.trainAssignments,'trainAssignments');
  const validation=times(raw.validationAssignments,'validationAssignments');
  const oos=times(raw.oosAssignments,'oosAssignments');
  if(!exactPartition(all,train,validation,oos)) throw new Error('FROZEN_SPLIT_NOT_EXACT_DATASET_PARTITION');
  requireBefore(train.at(-1),validation[0],'TRAIN_VALIDATION_OVERLAP');
  requireBefore(validation.at(-1),oos[0],'VALIDATION_OOS_OVERLAP');

  const splitFrozenAtMs=positiveTime(raw.splitFrozenAtMs,'splitFrozenAtMs');
  const firstOutcomeObservedAtMs=positiveTime(raw.firstOutcomeObservedAtMs,'firstOutcomeObservedAtMs');
  const splitObservedAtMs=positiveTime(raw.splitObservedAtMs,'splitObservedAtMs');
  requireBefore(splitFrozenAtMs,firstOutcomeObservedAtMs,'SPLIT_NOT_FROZEN_BEFORE_OUTCOME');
  if(splitObservedAtMs<splitFrozenAtMs) throw new Error('SPLIT_RECEIPT_OBSERVED_BEFORE_SPLIT_FREEZE');
  if(splitObservedAtMs>firstOutcomeObservedAtMs) throw new Error('SPLIT_RECEIPT_OBSERVED_AFTER_FIRST_OUTCOME');

  const assignments=Object.freeze({TRAIN:train,VALIDATION:validation,OOS:oos});
  const splitPolicy=seal(raw.splitPolicyId,Object.freeze({
    ...s,
    frozenAtMs:splitFrozenAtMs,
    firstOutcomeObservedAtMs,
    assignments,
  }));
  const splitReceipt=seal(raw.splitReceiptId,Object.freeze({
    ...s,
    policyDigest:splitPolicy.digest,
    assignments,
    observedAtMs:splitObservedAtMs,
    untouchedOos:true,
  }));

  const oosFrozenAtMs=positiveTime(raw.oosFrozenAtMs,'oosFrozenAtMs');
  if(oosFrozenAtMs>splitFrozenAtMs) throw new Error('OOS_POLICY_FROZEN_AFTER_SPLIT_FREEZE');
  requireBefore(oosFrozenAtMs,firstOutcomeObservedAtMs,'OOS_POLICY_NOT_FROZEN_BEFORE_OUTCOME');
  const oosStartTime=positiveTime(raw.oosStartTime,'oosStartTime');
  const oosEndTime=positiveTime(raw.oosEndTime,'oosEndTime');
  if(oosStartTime!==oos[0]||oosEndTime!==oos.at(-1)) throw new Error('OOS_POLICY_RANGE_MISMATCH');
  const oosPolicy=seal(raw.oosPolicyId,Object.freeze({
    ...s,
    frozenAtMs:oosFrozenAtMs,
    splitReceiptDigest:splitReceipt.digest,
    startTime:oosStartTime,
    endTime:oosEndTime,
    untouched:true,
  }));

  const wfFrozenAtMs=positiveTime(raw.wfFrozenAtMs,'wfFrozenAtMs');
  if(wfFrozenAtMs>splitFrozenAtMs) throw new Error('WF_POLICY_FROZEN_AFTER_SPLIT_FREEZE');
  requireBefore(wfFrozenAtMs,firstOutcomeObservedAtMs,'WF_POLICY_NOT_FROZEN_BEFORE_OUTCOME');
  if(!Array.isArray(raw.wfWindows)||raw.wfWindows.length===0||raw.wfWindows.length>512){
    throw new TypeError('wfWindows must be non-empty and bounded');
  }
  const trainSet=new Set(train),validationSet=new Set(validation);
  const wfWindows=Object.freeze(raw.wfWindows.map((window,index)=>{
    exactKeys(window,['train','validation'],'WF_WINDOW_SHAPE_INVALID');
    const wt=times(window.train,`wfWindows[${index}].train`);
    const wv=times(window.validation,`wfWindows[${index}].validation`);
    if(wt.some(value=>!trainSet.has(value))||wv.some(value=>!validationSet.has(value))){
      throw new Error('WF_WINDOW_OUTSIDE_FROZEN_SPLIT');
    }
    requireBefore(wt.at(-1),wv[0],'WF_WINDOW_TRAIN_VALIDATION_OVERLAP');
    return Object.freeze({train:wt,validation:wv});
  }));
  const wfPolicy=seal(raw.wfPolicyId,Object.freeze({
    ...s,
    frozenAtMs:wfFrozenAtMs,
    windows:wfWindows,
  }));

  const holdoutFrozenAtMs=positiveTime(raw.holdoutFrozenAtMs,'holdoutFrozenAtMs');
  if(holdoutFrozenAtMs>splitFrozenAtMs) throw new Error('HOLDOUT_POLICY_FROZEN_AFTER_SPLIT_FREEZE');
  requireBefore(holdoutFrozenAtMs,firstOutcomeObservedAtMs,'HOLDOUT_POLICY_NOT_FROZEN_BEFORE_OUTCOME');
  const holdoutAssignments=times(raw.holdoutAssignments,'holdoutAssignments');
  const used=new Set(all);
  if(holdoutAssignments.some(value=>used.has(value))) throw new Error('HOLDOUT_OVERLAPS_RESEARCH_DATASET');
  requireBefore(all.at(-1),holdoutAssignments[0],'HOLDOUT_NOT_AFTER_RESEARCH_DATA');
  const holdoutStartTime=positiveTime(raw.holdoutStartTime,'holdoutStartTime');
  const holdoutEndTime=positiveTime(raw.holdoutEndTime,'holdoutEndTime');
  if(holdoutStartTime!==holdoutAssignments[0]||holdoutEndTime!==holdoutAssignments.at(-1)){
    throw new Error('HOLDOUT_POLICY_RANGE_MISMATCH');
  }
  const holdoutDatasetId=text(raw.holdoutDatasetId,'holdoutDatasetId');
  if(holdoutDatasetId===s.datasetId) throw new Error('HOLDOUT_DATASET_MUST_BE_DISTINCT');
  const holdoutPolicy=seal(raw.holdoutPolicyId,Object.freeze({
    market:s.market,
    symbol:s.symbol,
    timeframe:s.timeframe,
    researchCodeSha:s.researchCodeSha,
    frozenAtMs:holdoutFrozenAtMs,
    firewallIdentity:text(raw.holdoutFirewallIdentity,'holdoutFirewallIdentity'),
    datasetId:holdoutDatasetId,
    assignments:holdoutAssignments,
    startTime:holdoutStartTime,
    endTime:holdoutEndTime,
    locked:true,
  }));

  const core=Object.freeze({
    schemaVersion:1,
    contract:RESEARCH_FROZEN_EVALUATION_POLICY_CONTRACT_V1,
    scope:s,
    splitPolicy,
    splitReceipt,
    oosPolicy,
    wfPolicy,
    holdoutPolicy,
    safety:Object.freeze({
      explicitInputsOnly:true,
      automaticSplitRatioAllowed:false,
      timingInferenceAllowed:false,
      finalHoldoutOutcomeAccessAllowed:false,
      holdoutRetuningAllowed:false,
      selectionAllowed:false,
      liveTrading:false,
      autoTrading:false,
      privateTradingApi:false,
      realOrder:false,
      executionAuthority:'NONE',
    }),
  });
  return Object.freeze({...core,policySetDigest:hash(core)});
}
