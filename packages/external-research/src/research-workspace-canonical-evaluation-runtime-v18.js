import { createHash } from 'node:crypto';

import { createVideoResearchCanonicalHandoffV1 } from '../../../market-prediction-lab/src/video-research-canonical-handoff-v1.js';
import { generateBoundedFormulaCandidatesV1 } from '../../../market-prediction-lab/src/autonomous-strategy-formula-generator-v1.js';
import {
  buildEvidenceBackedFormulaExecutionParametersV1,
  createEvidenceBackedFormulaSignalEvaluatorV1,
} from '../../../market-prediction-lab/src/evidence-backed-formula-entry-evaluator-v1.js';
import { runOnePassCandidateBacktestV1 } from '../../../market-prediction-lab/src/research-tournament-engine-v1.js';
import { adaptGlobalStatisticalFirewallToTournamentV1 } from '../../../market-prediction-lab/src/research-tournament-statistical-firewall-adapter-v1.js';

const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const sha40=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const canonical=x=>Array.isArray(x)?x.map(canonical):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const sha=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const fail=code=>{throw Object.assign(new Error(code),{code});};

function validateContext(context,currentSha,config){
  if(!object(context)||context.schemaVersion!=='research-canonical-evaluation-runtime-context-v18'
    ||!sha40(context.sourceSha)||context.sourceSha!==currentSha||!object(context.handoff)
    ||!object(context.generation)||!object(context.backtest))fail('CANONICAL_EVALUATION_RUNTIME_CONTEXT_INVALID');
  if(context.backtest?.period?.includeFinalHoldout!==false||context.generation?.search?.finalHoldoutAccess!==false)
    fail('FINAL_HOLDOUT_PREACCESS_FORBIDDEN');
  if(context.backtest?.finalHoldout===true||context.backtest?.selectionFeedbackAllowed===true)
    fail('FINAL_HOLDOUT_PREACCESS_FORBIDDEN');
  if(context.handoff?.videoHypothesis?.market!==config.market||context.handoff?.videoHypothesis?.side!==config.side
    ||context.handoff?.videoHypothesis?.timeframe!==config.timeframe)fail('CANONICAL_EVALUATION_RUNTIME_SCOPE_MISMATCH');
  return context;
}
function validateGeneratedScope(formula,generated,context,config){
  const expectedSide=config.side==='SHORT'?'short':'long';
  if(formula.market!==config.market||formula.direction!==config.side||formula.timeframe!==config.timeframe
    ||generated.formulaCandidateId!==formula.candidateId
    ||context.backtest.datasetIdentity!==generated.searchProvenance?.datasetIdentity
    ||context.backtest.backtestInput?.market!==config.market
    ||context.backtest.backtestInput?.timeframe!==config.timeframe
    ||context.backtest.backtestInput?.side!==expectedSide)fail('CANONICAL_EVALUATION_RUNTIME_SCOPE_MISMATCH');
}
function firewallResult(context,generated){
  const evidence=context.statisticalFirewall;
  if(evidence==null)return freeze({status:'MISSING_EVIDENCE',code:'STATISTICAL_EVIDENCE_MISSING',reason:'frozen statistical firewall evidence is missing'});
  if(!object(evidence)||!Array.isArray(evidence.trials)||evidence.trials.length<1
    ||evidence.selectedTrialId!==generated.generatedCandidateId
    ||!Number.isFinite(evidence.requiredAdjustedAlpha)||evidence.requiredAdjustedAlpha<=0||evidence.requiredAdjustedAlpha>1)
    fail('STATISTICAL_EVIDENCE_BINDING_INVALID');
  if(!evidence.trials.some(row=>row?.trialId===generated.generatedCandidateId))fail('STATISTICAL_EVIDENCE_BINDING_INVALID');
  return adaptGlobalStatisticalFirewallToTournamentV1({
    tournamentRequest:{canonicalOwner:'#547',candidateFamilySize:evidence.trials.length,
      requiredAdjustedAlpha:evidence.requiredAdjustedAlpha,finalHoldoutAccess:false},
    trials:evidence.trials,selectedTrialId:evidence.selectedTrialId,benchmarkReturns:evidence.benchmarkReturns??null,
    blockCount:evidence.blockCount??8,maxCombinations:evidence.maxCombinations??5000,
    realityCheckPolicy:evidence.realityCheckPolicy,decisionPolicy:evidence.decisionPolicy,
    stabilityEvidence:evidence.stabilityEvidence,
  });
}

export function createCanonicalEvaluationRuntimeV18(context,{currentSha,config}={}){
  const ctx=validateContext(context,currentSha,config),compiled=new Map();
  const compileCanonical=async()=>{
    const handoff=createVideoResearchCanonicalHandoffV1(ctx.handoff);
    if(handoff.status!=='AWAITING_FORMULA_EVALUATION'){
      return freeze({status:'REVIEW_REQUIRED',reason:handoff.reason??'CANONICAL_COMPILER_REVIEW_REQUIRED'});
    }
    if(!Array.isArray(handoff.candidates)||handoff.candidates.length!==1){
      return freeze({status:'REVIEW_REQUIRED',reason:'EXACTLY_ONE_FORMULA_CANDIDATE_REQUIRED'});
    }
    const formula=handoff.candidates[0];
    const generatedRows=generateBoundedFormulaCandidatesV1({
      formulaCandidates:[formula],
      budget:ctx.generation.budget,
      search:{...ctx.generation.search,requestedCandidates:1,finalHoldoutAccess:false},
    }).generatedCandidates;
    if(generatedRows.length!==1)return freeze({status:'REVIEW_REQUIRED',reason:'EXACTLY_ONE_GENERATED_CANDIDATE_REQUIRED'});
    const generated=generatedRows[0];validateGeneratedScope(formula,generated,ctx,config);
    const handoffDigest=sha({sourceSha:currentSha,formulaCandidateId:formula.candidateId,formulaHash:formula.formulaHash,
      generatedCandidateId:generated.generatedCandidateId,parameterIdentity:generated.parameterIdentity,datasetIdentity:ctx.backtest.datasetIdentity});
    compiled.set(handoffDigest,{formula,generated});
    return freeze({status:'READY',compiler:'#550',handoffDigest,formulaCandidateId:formula.candidateId,
      generatedCandidateId:generated.generatedCandidateId,reason:null});
  };
  const runBacktest=async({compiled:receipt}={})=>{
    const state=compiled.get(receipt?.handoffDigest);if(!state)return freeze({status:'REVIEW_REQUIRED',reason:'CANONICAL_BINDING_NOT_FOUND',backtesterCalls:0});
    const {formula,generated}=state;
    const executionParameters=buildEvidenceBackedFormulaExecutionParametersV1({formulaCandidate:formula,generatedCandidate:generated});
    const evaluator=createEvidenceBackedFormulaSignalEvaluatorV1({formulaCandidate:formula,generatedCandidate:generated});
    let raw;
    try{
      raw=runOnePassCandidateBacktestV1({
        formulaCandidate:formula,generatedCandidate:generated,datasetIdentity:ctx.backtest.datasetIdentity,
        backtestInput:ctx.backtest.backtestInput,executionParameters,...evaluator,period:ctx.backtest.period,
        finalHoldout:false,liquidityImpactEvidence:ctx.backtest.liquidityImpactEvidence??null,
      });
    }catch(error){
      return freeze({status:'REVIEW_REQUIRED',reason:error?.code??'CANONICAL_BACKTEST_FAILED',backtesterCalls:1});
    }
    if(raw?.status!=='PASS'||raw?.canonicalBacktestOwner!=='#690'||raw?.executionEquivalent!==true
      ||raw?.safety?.executionAuthority!=='NONE'||raw?.period?.includeFinalHoldout!==false){
      return freeze({status:'REVIEW_REQUIRED',reason:'CANONICAL_BACKTEST_RESULT_INVALID',backtesterCalls:1,resultDigest:sha(raw)});
    }
    let firewall;
    try{firewall=firewallResult(ctx,generated);}catch(error){
      return freeze({status:'REVIEW_REQUIRED',reason:error?.code??'STATISTICAL_FIREWALL_FAILED',backtesterCalls:1,resultDigest:sha(raw)});
    }
    const resultDigest=sha({backtest:raw,statisticalFirewall:firewall});
    if(firewall?.status!=='PASS'||firewall?.canonicalOwner!=='#547'||firewall?.executionAuthority!=='NONE'){
      return freeze({status:'REVIEW_REQUIRED',reason:firewall?.code??'STATISTICAL_EVIDENCE_MISSING',backtesterCalls:1,
        resultDigest,statisticalFirewallStatus:firewall?.status??null});
    }
    return freeze({status:'BACKTEST_RECORDED',reason:null,backtesterCalls:1,resultDigest,
      metrics:{netReturn:raw.metrics?.return??null,maxDrawdown:raw.metrics?.maximumDrawdown??null,
        tradeCount:raw.metrics?.trades??null,fullCostIncluded:true,statisticalFirewallPassed:true},
      executionAuthority:'NONE',profitabilityProven:false});
  };
  return freeze({compileCanonical,runBacktest,authority:{executionAuthority:'NONE',automaticAdoption:false,paperActivation:false,liveActivation:false}});
}
