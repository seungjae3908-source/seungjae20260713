import { createHash } from 'node:crypto';
import { validateHumanRuleDigestDecisionV16 } from './research-workspace-one-shot-bind-v16.js';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const sha40=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(x);
const text=x=>typeof x==='string'&&x.trim().length>0&&x.length<=240;
const canonical=x=>Array.isArray(x)?x.map(canonical):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const sha=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const MARKETS=new Set(['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES']);
const SIDES=new Set(['LONG','SHORT']);
const BINDINGS=Object.freeze({
  stageCheckpointExecutor:{ownerRefs:['#551'],capability:'TOURNAMENT_STAGE_CHECKPOINT_RESUME_V1'},
  canonicalBundleSource:{ownerRefs:['#821','#833'],capability:'AUTHENTIC_CANONICAL_BUNDLE_SOURCE_V1'},
  formulaCompiler:{ownerRefs:['#550'],capability:'BOUNDED_FORMULA_COMPILER_V1'},
  canonicalBacktester:{ownerRefs:['#690'],capability:'ONE_PASS_EXECUTION_EQUIVALENT_BACKTESTER_V1'},
  statisticalFirewall:{ownerRefs:['#547'],capability:'CANONICAL_STATISTICAL_FIREWALL_V1'},
});
const DATA_KEYS=Object.freeze(['train','oos','purgedOos','walkForward','costStress','regimeStress','finalHoldout']);
const AUTH=Object.freeze({providerCalls:0,compilerRuns:0,backtestRuns:0,automaticAdoption:false,profitabilityProven:false,
  liveTrading:false,autoTrading:false,realOrderEnabled:false,privateTradingApiAllowed:false,executionAuthority:'NONE'});

function bindingValid(row,key,sourceSha){
  const requirement=BINDINGS[key];
  return exact(row,['status','ownerRefs','capability','sourceSha','evidenceId','properties'])
    &&row.status==='AVAILABLE'
    &&JSON.stringify(row.ownerRefs)===JSON.stringify(requirement.ownerRefs)
    &&row.capability===requirement.capability&&row.sourceSha===sourceSha&&text(row.evidenceId)
    &&exact(row.properties,['runtimeActivationAllowed','scheduleMutationAllowed','deploymentAllowed','finalHoldoutPreAccessAllowed','arbitraryExecutableCodeAllowed','profitabilityClaimAllowed','executionAuthority'])
    &&row.properties.runtimeActivationAllowed===false&&row.properties.scheduleMutationAllowed===false
    &&row.properties.deploymentAllowed===false&&row.properties.finalHoldoutPreAccessAllowed===false
    &&row.properties.arbitraryExecutableCodeAllowed===false&&row.properties.profitabilityClaimAllowed===false
    &&row.properties.executionAuthority==='NONE';
}
function datasetValid(row,key){
  return exact(row,['role','datasetIdentity','datasetDigest','frozen','selectionFeedbackAllowed'])
    &&row.role===key.toUpperCase().replace('PURGEDOOS','PURGED_OOS').replace('WALKFORWARD','WALK_FORWARD').replace('COSTSTRESS','COST_STRESS').replace('REGIMESTRESS','REGIME_STRESS').replace('FINALHOLDOUT','FINAL_HOLDOUT')
    &&text(row.datasetIdentity)&&digest(row.datasetDigest)&&row.frozen===true&&row.selectionFeedbackAllowed===false;
}
export function validateCanonicalEvaluationConfigV17(config,{currentSha,review,decision,now=new Date().toISOString()}={}){
  const reasons=[];
  if(!object(config)||!sha40(currentSha)||!iso(now)||!object(review)||!object(decision))return {ok:false,reasons:['EVALUATION_CONFIG_INPUT_INVALID']};
  const keys=['schemaVersion','configId','createdAt','sourceSha','manifestDigest','packageDigest','reviewedRuleDigest','market','side','timeframe',
    'strategyFamily','symbolScope','categories','crossValidation','canonicalCoreDigest','seedProfileId','templateSetDigest','compilerPolicyDigest',
    'tournamentPolicyDigest','datasets','runtimeBindings','authority','configDigest'];
  if(!exact(config,keys)||config.schemaVersion!=='research-canonical-evaluation-config-v17'||!id(config.configId)||!iso(config.createdAt)
    ||config.createdAt>now||config.sourceSha!==currentSha||config.manifestDigest!==review.manifestDigest||config.packageDigest!==review.packageDigest
    ||config.reviewedRuleDigest!==review.reviewedRuleDigestCandidate||!MARKETS.has(config.market)||!SIDES.has(config.side)||!text(config.timeframe)
    ||!text(config.strategyFamily)||!Array.isArray(config.symbolScope)||config.symbolScope.length>32||config.symbolScope.some(x=>!text(x))
    ||!Array.isArray(config.categories)||config.categories.length>32||config.categories.some(x=>!text(x))
    ||!digest(config.canonicalCoreDigest)||!id(config.seedProfileId)||!digest(config.templateSetDigest)||!digest(config.compilerPolicyDigest)
    ||!digest(config.tournamentPolicyDigest)||!object(config.crossValidation)||!object(config.datasets)||!object(config.runtimeBindings)
    ||!object(config.authority)||!digest(config.configDigest))reasons.push('EVALUATION_CONFIG_SHAPE_INVALID');
  if(reasons.length===0){
    const cross=config.crossValidation;
    if(!exact(cross,['supportingPaperBundleDigest','contradictoryPaperBundleDigest','officialSourceBundleDigest','supportingPaperCount','contradictoryPaperCount','allSourcesReviewed'])
      ||!digest(cross.supportingPaperBundleDigest)||!(cross.contradictoryPaperBundleDigest===null||digest(cross.contradictoryPaperBundleDigest))
      ||!(cross.officialSourceBundleDigest===null||digest(cross.officialSourceBundleDigest))
      ||!Number.isSafeInteger(cross.supportingPaperCount)||cross.supportingPaperCount<1
      ||!Number.isSafeInteger(cross.contradictoryPaperCount)||cross.contradictoryPaperCount<0||cross.allSourcesReviewed!==true)
      reasons.push('CROSS_VALIDATION_EVIDENCE_INCOMPLETE');
    if(Object.keys(config.datasets).sort().join(',')!==[...DATA_KEYS].sort().join(',')
      ||DATA_KEYS.some(k=>!datasetValid(config.datasets[k],k)))reasons.push('DATASET_BINDINGS_INCOMPLETE');
    if(Object.keys(config.runtimeBindings).sort().join(',')!==Object.keys(BINDINGS).sort().join(',')
      ||Object.keys(BINDINGS).some(k=>!bindingValid(config.runtimeBindings[k],k,currentSha)))reasons.push('CANONICAL_RUNTIME_BINDINGS_INCOMPLETE');
    if(!exact(config.authority,['providerCalls','compilerRuns','backtestRuns','automaticAdoption','profitabilityProven','liveTrading','autoTrading','realOrderEnabled','privateTradingApiAllowed','executionAuthority'])
      ||Object.keys(AUTH).some(k=>config.authority[k]!==AUTH[k]))reasons.push('EVALUATION_CONFIG_AUTHORITY_INVALID');
    const core=Object.fromEntries(Object.entries(config).filter(([k])=>k!=='configDigest'));
    if(config.configDigest!==sha(core))reasons.push('EVALUATION_CONFIG_DIGEST_MISMATCH');
  }
  if(!validateHumanRuleDigestDecisionV16(decision,review,{now}))reasons.push('HUMAN_RULE_DIGEST_DECISION_INVALID_OR_EXPIRED');
  return freeze({ok:reasons.length===0,reasons:[...new Set(reasons)].sort()});
}
export function assessCanonicalEvaluationReadinessV17({config,currentSha,review,decision,checkedAt=new Date().toISOString()}={}){
  if(!sha40(currentSha)||!iso(checkedAt))fail('CANONICAL_EVALUATION_PREFLIGHT_INPUT_INVALID');
  const validation=validateCanonicalEvaluationConfigV17(config,{currentSha,review,decision,now:checkedAt});
  return freeze({schemaVersion:'research-canonical-evaluation-readiness-v17',
    status:validation.ok?'READY_FOR_CANONICAL_EVALUATION_ONE_SHOT':'BLOCKED',
    checkedAt,currentSha,manifestDigest:review?.manifestDigest??null,packageDigest:review?.packageDigest??null,
    reviewedRuleDigest:review?.reviewedRuleDigestCandidate??null,decisionDigest:decision?.decisionDigest??null,
    configDigest:config?.configDigest??null,reasonCodes:validation.reasons,
    finalHoldoutPreAccess:false,selectionFeedbackToGenerator:false,...AUTH});
}
export const CANONICAL_EVALUATION_CONFIG_FILE_V17='canonical-evaluation-config-v17.json';
export const CANONICAL_EVALUATION_RUNTIME_BINDINGS_V17=BINDINGS;
