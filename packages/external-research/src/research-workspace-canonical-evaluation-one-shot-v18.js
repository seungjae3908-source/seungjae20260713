import { createHash } from 'node:crypto';
import { validateCanonicalEvaluationConfigV17 } from './research-workspace-canonical-evaluation-readiness-v17.js';

const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const sha40=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(x);
const canonical=x=>Array.isArray(x)?x.map(canonical):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const sha=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};

const AUTH=Object.freeze({
  providerCalls:0,compilerRuns:0,backtestRuns:0,maxCompilerRuns:1,maxBacktestRuns:1,
  finalHoldoutPreAccess:false,selectionFeedbackToGenerator:false,replayAllowed:false,
  automaticAdoption:false,paperActivation:false,liveActivation:false,profitabilityProven:false,
  liveTrading:false,autoTrading:false,realOrderEnabled:false,privateTradingApiAllowed:false,executionAuthority:'NONE',
});
const DEPENDENCIES=Object.freeze({
  formulaCompiler:Object.freeze({
    ownerRef:'#550',capability:'BOUNDED_FORMULA_COMPILER_V1',
    implementationPath:'market-prediction-lab/src/autonomous-strategy-formula-generator-v1.js',
    missingCode:'BOUNDED_FORMULA_COMPILER_NOT_PRESENT_ON_CURRENT_SHA',
  }),
  canonicalBacktester:Object.freeze({
    ownerRef:'#690',capability:'ONE_PASS_EXECUTION_EQUIVALENT_BACKTESTER_V1',
    implementationPath:'market-prediction-lab/src/independent-strategy-backtest.js',
    missingCode:'CANONICAL_BACKTESTER_NOT_PRESENT_ON_CURRENT_SHA',
  }),
  statisticalFirewall:Object.freeze({
    ownerRef:'#547',capability:'CANONICAL_STATISTICAL_FIREWALL_V1',
    implementationPath:'market-prediction-lab/src/global-strategy-statistical-firewall-v1.js',
    missingCode:'CANONICAL_STATISTICAL_FIREWALL_NOT_PRESENT_ON_CURRENT_SHA',
  }),
});
const COMPILER=DEPENDENCIES.formulaCompiler;
const BACKTESTER=DEPENDENCIES.canonicalBacktester;
const FIREWALL=DEPENDENCIES.statisticalFirewall;
const RESULT=Object.freeze({
  disposition:'RESEARCH_EVIDENCE_ONLY',automaticAdoption:false,paperActivation:false,liveActivation:false,profitabilityClaimAllowed:false,
});

function validPreflight(preflight,{currentSha,config,decision,review,now}){
  return object(preflight)&&iso(now)&&iso(preflight.checkedAt)
    &&Date.parse(preflight.checkedAt)<=Date.parse(now)
    &&Date.parse(now)-Date.parse(preflight.checkedAt)<=10*60_000
    &&preflight.schemaVersion==='research-canonical-evaluation-readiness-v17'
    &&preflight.status==='READY_FOR_CANONICAL_EVALUATION_ONE_SHOT'
    &&preflight.currentSha===currentSha
    &&preflight.manifestDigest===review?.manifestDigest
    &&preflight.packageDigest===review?.packageDigest
    &&preflight.reviewedRuleDigest===review?.reviewedRuleDigestCandidate
    &&preflight.configDigest===config?.configDigest
    &&preflight.decisionDigest===decision?.decisionDigest
    &&Array.isArray(preflight.reasonCodes)&&preflight.reasonCodes.length===0
    &&preflight.providerCalls===0&&preflight.compilerRuns===0&&preflight.backtestRuns===0
    &&preflight.finalHoldoutPreAccess===false&&preflight.selectionFeedbackToGenerator===false
    &&preflight.automaticAdoption===false&&preflight.profitabilityProven===false
    &&preflight.executionAuthority==='NONE';
}
function validCompiler(value){
  return exact(value,['ownerRef','capability','maxRuns','finalHoldoutAccessAllowed','arbitraryExecutableCodeAllowed'])
    &&value.ownerRef===COMPILER.ownerRef&&value.capability===COMPILER.capability&&value.maxRuns===1
    &&value.finalHoldoutAccessAllowed===false&&value.arbitraryExecutableCodeAllowed===false;
}
function validBacktester(value){
  return exact(value,['ownerRef','capability','maxRuns','executionEquivalentRequired','finalHoldoutAccessPolicy','selectionFeedbackAllowed'])
    &&value.ownerRef===BACKTESTER.ownerRef&&value.capability===BACKTESTER.capability&&value.maxRuns===1
    &&value.executionEquivalentRequired===true&&value.finalHoldoutAccessPolicy==='FINAL_ONLY_AFTER_SELECTION_FREEZE'
    &&value.selectionFeedbackAllowed===false;
}
function validFirewall(value){
  return exact(value,['ownerRef','capability','required','bypassAllowed'])
    &&value.ownerRef===FIREWALL.ownerRef&&value.capability===FIREWALL.capability&&value.required===true&&value.bypassAllowed===false;
}
function validateRuntimeDependencyProofV18(proof,{currentSha,now}={}){
  const reasons=[];
  if(!object(proof)||!sha40(currentSha)||!iso(now)
    ||!exact(proof,['schemaVersion','sourceSha','verifiedAt','dependencies','proofDigest'])
    ||proof.schemaVersion!=='research-canonical-evaluation-runtime-proof-v18'||proof.sourceSha!==currentSha
    ||!iso(proof.verifiedAt)||Date.parse(proof.verifiedAt)>Date.parse(now)
    ||Date.parse(now)-Date.parse(proof.verifiedAt)>10*60_000||!object(proof.dependencies)||!digest(proof.proofDigest)){
    return freeze({ok:false,reasons:['RUNTIME_DEPENDENCY_PROOF_INVALID']});
  }
  if(Object.keys(proof.dependencies).sort().join(',')!==Object.keys(DEPENDENCIES).sort().join(','))reasons.push('RUNTIME_DEPENDENCY_PROOF_INVALID');
  for(const [key,expected] of Object.entries(DEPENDENCIES)){
    const row=proof.dependencies[key];
    if(!exact(row,['status','ownerRef','capability','implementationPath','implementationBlobSha'])
      ||!['PRESENT','MISSING'].includes(row.status)||row.ownerRef!==expected.ownerRef||row.capability!==expected.capability
      ||row.implementationPath!==expected.implementationPath
      ||!(row.implementationBlobSha===null||sha40(row.implementationBlobSha))){
      reasons.push('RUNTIME_DEPENDENCY_PROOF_INVALID');continue;
    }
    if(row.status!=='PRESENT'||!sha40(row.implementationBlobSha))reasons.push(expected.missingCode);
  }
  const core=Object.fromEntries(Object.entries(proof).filter(([k])=>k!=='proofDigest'));
  if(proof.proofDigest!==sha(core))reasons.push('RUNTIME_DEPENDENCY_PROOF_DIGEST_MISMATCH');
  return freeze({ok:reasons.length===0,reasons:[...new Set(reasons)].sort()});
}

export function canonicalEvaluationRequestDigestV18(value){return sha(value);}

export function validateCanonicalEvaluationExecutionRequestV18(request,{currentSha,review,decision,config,preflight,runtimeProof,now=new Date().toISOString()}={}){
  const reasons=[];
  if(!object(request)||!sha40(currentSha)||!iso(now)||!object(review)||!object(decision)||!object(config)||!object(preflight)||!object(runtimeProof))
    return freeze({ok:false,reasons:['CANONICAL_EVALUATION_V18_INPUT_INVALID']});

  const configValidation=validateCanonicalEvaluationConfigV17(config,{currentSha,review,decision,now});
  if(!configValidation.ok)reasons.push(...configValidation.reasons.map(code=>'V17_'+code));
  if(!validPreflight(preflight,{currentSha,config,decision,review,now}))reasons.push('FRESH_PHASE17_READY_RECEIPT_REQUIRED');
  const dependencyValidation=validateRuntimeDependencyProofV18(runtimeProof,{currentSha,now});
  if(!dependencyValidation.ok)reasons.push(...dependencyValidation.reasons);

  const phase17ReceiptDigest=sha(preflight);
  const keys=['schemaVersion','evaluationId','requestedAt','expiresAt','sourceSha','decisionDigest','configDigest','phase17ReceiptDigest',
    'runtimeProofDigest','oneShotReservationId','compiler','backtester','statisticalFirewall','resultPolicy','authority','requestDigest'];
  if(!exact(request,keys)||request.schemaVersion!=='research-canonical-evaluation-one-shot-request-v18'||!id(request.evaluationId)
    ||!iso(request.requestedAt)||!iso(request.expiresAt)||request.requestedAt>now||now>=request.expiresAt
    ||Date.parse(request.expiresAt)-Date.parse(request.requestedAt)<=0
    ||Date.parse(request.expiresAt)-Date.parse(request.requestedAt)>20*60_000
    ||request.sourceSha!==currentSha||request.decisionDigest!==decision.decisionDigest||request.configDigest!==config.configDigest
    ||request.phase17ReceiptDigest!==phase17ReceiptDigest||request.runtimeProofDigest!==runtimeProof.proofDigest
    ||!digest(request.oneShotReservationId)||!validCompiler(request.compiler)||!validBacktester(request.backtester)
    ||!validFirewall(request.statisticalFirewall)
    ||!exact(request.resultPolicy,Object.keys(RESULT))||Object.keys(RESULT).some(k=>request.resultPolicy[k]!==RESULT[k])
    ||!exact(request.authority,Object.keys(AUTH))||Object.keys(AUTH).some(k=>request.authority[k]!==AUTH[k])
    ||!digest(request.requestDigest))reasons.push('CANONICAL_EVALUATION_V18_REQUEST_SHAPE_INVALID');

  if(reasons.length===0){
    const reservationExpected=sha({
      schemaVersion:'research-canonical-evaluation-one-shot-reservation-v18',evaluationId:request.evaluationId,sourceSha:currentSha,
      decisionDigest:decision.decisionDigest,configDigest:config.configDigest,phase17ReceiptDigest,runtimeProofDigest:runtimeProof.proofDigest,
    });
    if(request.oneShotReservationId!==reservationExpected)reasons.push('CANONICAL_EVALUATION_V18_RESERVATION_MISMATCH');
    const core=Object.fromEntries(Object.entries(request).filter(([k])=>k!=='requestDigest'));
    if(request.requestDigest!==sha(core))reasons.push('CANONICAL_EVALUATION_V18_REQUEST_DIGEST_MISMATCH');
  }
  return freeze({ok:reasons.length===0,reasons:[...new Set(reasons)].sort()});
}

export function assessCanonicalEvaluationExecutionContractV18(input={}){
  const checkedAt=input.checkedAt??new Date().toISOString();
  const validation=validateCanonicalEvaluationExecutionRequestV18(input.request,{
    currentSha:input.currentSha,review:input.review,decision:input.decision,config:input.config,preflight:input.preflight,
    runtimeProof:input.runtimeProof,now:checkedAt,
  });
  return freeze({
    schemaVersion:'research-canonical-evaluation-execution-contract-v18',
    status:validation.ok?'READY_FOR_BOUNDED_COMPILER_BACKTEST_ONE_SHOT':'BLOCKED',
    checkedAt,currentSha:input.currentSha??null,decisionDigest:input.decision?.decisionDigest??null,
    configDigest:input.config?.configDigest??null,phase17ReceiptDigest:input.request?.phase17ReceiptDigest??null,
    runtimeProofDigest:input.runtimeProof?.proofDigest??null,requestDigest:input.request?.requestDigest??null,
    oneShotReservationId:input.request?.oneShotReservationId??null,reasonCodes:validation.reasons,
    resultDisposition:'RESEARCH_EVIDENCE_ONLY',...AUTH,
  });
}

export const CANONICAL_EVALUATION_REQUEST_FILE_V18='canonical-evaluation-request-v18.json';
export const CANONICAL_EVALUATION_EXECUTION_AUTHORITY_V18=AUTH;
export const CANONICAL_EVALUATION_RUNTIME_DEPENDENCIES_V18=DEPENDENCIES;
