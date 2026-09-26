import { createHash } from 'node:crypto';
import {
  assertResearchVideoSourceV1, createVideoStrategyHypothesisV1, crossValidateVideoHypothesisV1,
} from './video-intelligence.js';
import { adaptVideoStrategyToCanonicalHypothesisV1 } from '../../../market-prediction-lab/src/video-research-canonical-handoff-v1.js';
import { runEvidenceBackedFormulaTournamentAdapterV1 } from '../../../market-prediction-lab/src/evidence-backed-formula-tournament-adapter-v1.js';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const canonical=x=>Array.isArray(x)?x.map(canonical):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const sha=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const SAFE=Object.freeze({executionAuthority:'NONE',automaticActivation:false,automaticAdoption:false,profitabilityProven:false});
const REQUIRED=['ENTRY','EXIT','STOP_LOSS','POSITION_SIZING','EXECUTION_ASSUMPTION'];

function acceptedClaims(geminiReceipt,groqReview){
  if(!Array.isArray(geminiReceipt?.observations)||!Array.isArray(groqReview?.findings))fail('RUNTIME_BINDING_EVIDENCE_INVALID');
  const findings=new Map(groqReview.findings.map(x=>[x.observationIndex,x]));
  return geminiReceipt.observations.map((o,index)=>({o,index,f:findings.get(index)}))
    .filter(x=>x.f?.verdict==='ACCEPT_AS_CLAIM')
    .map(x=>({observationIndex:x.index,atSec:x.o.atSec,kind:x.o.kind,description:x.o.description}));
}
export function researchRuntimeRuleDigestV11(geminiReceipt,groqReview){
  const claims=acceptedClaims(geminiReceipt,groqReview);
  return sha({schemaVersion:'research-runtime-reviewed-rules-v11',claims});
}
function ruleMap(claims,kind){return claims.filter(x=>x.kind===kind).map(x=>x.description);}
function requireConfig(config){
  if(!object(config)||!object(config.trustedContext)||!object(config.crossValidation)||!object(config.canonicalCore)||
    !object(config.committeeReview)||!object(config.seedProfile)||!Array.isArray(config.templates)||!object(config.catalogSafety)||
    !object(config.compilerPolicy)||!object(config.tournament)||!Number.isSafeInteger(config.candidatesPerFormula)||config.candidatesPerFormula<1)fail('RUNTIME_BINDING_CONFIG_INVALID');
  assertResearchVideoSourceV1(config.source);
  if(!digest(config.trustedContext.reviewedRuleDigest))fail('RUNTIME_BINDING_REVIEW_DIGEST_REQUIRED');
  if(config.catalogSafety.executionAuthority!=='NONE'||config.catalogSafety.profitabilityClaimAllowed!==false)fail('RUNTIME_BINDING_SAFETY_INVALID');
  return config;
}
function bindTemplates(templates,hypothesis,decision){
  const binding={hypothesisId:hypothesis.hypothesisId,hypothesisConfigHash:hypothesis.configHash,decisionId:decision.decisionId,decisionHash:decision.decisionHash};
  return templates.map(t=>freeze({...structuredClone(t),hypothesisBinding:binding}));
}
function tournamentSummary(plan,result){
  const survivors=result?.tournament?.candidates?.filter(x=>x?.researchSurvivor===true&&x?.failure===null)??[];
  if(survivors.length!==1)return {status:'REVIEW_REQUIRED',reason:survivors.length?'MULTIPLE_RESEARCH_SURVIVORS_REQUIRE_REVIEW':'NO_RESEARCH_SURVIVOR'};
  const row=survivors[0],by=Object.fromEntries((row.stageRecords??[]).map(x=>[x.stage,x]));
  const metrics=by.HISTORICAL_BACKTEST?.evidence?.metrics;
  if(!metrics||by.COST_STRESS?.status!=='PASS'||!Number.isFinite(metrics.return)||!Number.isFinite(metrics.maximumDrawdown)||!Number.isSafeInteger(metrics.trades))
    return {status:'REVIEW_REQUIRED',reason:'BACKTEST_EVIDENCE_INCOMPLETE'};
  return {status:'BACKTEST_RECORDED',backtester:'evidence-backed-formula-tournament-adapter-v1',market:plan.market,
    resultDigest:sha(result),metrics:{netReturn:metrics.return,maxDrawdown:metrics.maximumDrawdown,tradeCount:metrics.trades,fullCostIncluded:true},reason:null};
}

export function createResearchRuntimeBindingV11(rawConfig,{backtestDependencies={}}={}){
  const config=requireConfig(rawConfig),compiled=new Map();
  const compileCanonical=async({plan,geminiReceipt,groqReview,ruleAssessment})=>{
    if(ruleAssessment?.status!=='COMPLETE')return {status:'REVIEW_REQUIRED',reason:'RULE_COMPLETENESS_REQUIRED'};
    const claims=acceptedClaims(geminiReceipt,groqReview),observedKinds=new Set(claims.map(x=>x.kind));
    if(REQUIRED.some(k=>!observedKinds.has(k)))return {status:'REVIEW_REQUIRED',reason:'ACCEPTED_RULES_INCOMPLETE'};
    const reviewedDigest=researchRuntimeRuleDigestV11(geminiReceipt,groqReview);
    if(reviewedDigest!==config.trustedContext.reviewedRuleDigest)return {status:'REVIEW_REQUIRED',reason:'RULE_REVIEW_DIGEST_MISMATCH'};
    const min=Math.min(...claims.map(x=>x.atSec)),max=Math.max(...claims.map(x=>x.atSec));
    const videoHypothesis=createVideoStrategyHypothesisV1({
      source:config.source,market:config.trustedContext.market,side:config.trustedContext.side,timeframe:config.trustedContext.timeframe,
      strategyFamily:config.trustedContext.strategyFamily??null,categories:config.trustedContext.categories??[],symbolScope:config.trustedContext.symbolScope??[],
      sourceStartSec:min,sourceEndSec:max,entryRules:ruleMap(claims,'ENTRY'),exitRules:ruleMap(claims,'EXIT'),
      stopLossRules:ruleMap(claims,'STOP_LOSS'),positionSizingRules:ruleMap(claims,'POSITION_SIZING'),
      extractedInferences:ruleMap(claims,'EXECUTION_ASSUMPTION'),uncertainties:geminiReceipt.limitations??[],
    });
    if(videoHypothesis.testabilityStatus!=='TESTABLE')return {status:'REVIEW_REQUIRED',reason:videoHypothesis.testabilityStatus};
    const crossValidation=crossValidateVideoHypothesisV1({hypothesis:videoHypothesis,...config.crossValidation});
    const papers=[...(config.crossValidation.supportingPapers??[]),...(config.crossValidation.contradictoryPapers??[])];
    const adapted=adaptVideoStrategyToCanonicalHypothesisV1({source:config.source,videoHypothesis,crossValidation,papers,
      canonicalCore:config.canonicalCore,review:config.committeeReview});
    if(adapted.status!=='CANONICAL_READY')return {status:'REVIEW_REQUIRED',reason:adapted.reason??'CANONICAL_REVIEW_REQUIRED'};
    const templates=bindTemplates(config.templates,adapted.canonicalHypothesis,adapted.decision);
    const handoffDigest=sha({planDigest:plan.planDigest,canonicalHypothesisId:adapted.canonicalHypothesis.hypothesisId,
      decisionId:adapted.decision.decisionId,templateIds:templates.map(x=>x.templateId)});
    compiled.set(handoffDigest,{hypothesis:adapted.canonicalHypothesis,decision:adapted.decision,templates});
    return {status:'READY',compiler:'video-research-canonical-handoff-v1',handoffDigest,hypothesisId:adapted.canonicalHypothesis.hypothesisId,reason:null};
  };
  const runBacktest=async({plan,compiled:receipt})=>{
    const state=compiled.get(receipt?.handoffDigest);if(!state)return {status:'REVIEW_REQUIRED',reason:'CANONICAL_BINDING_NOT_FOUND'};
    const profile=structuredClone(config.seedProfile),templates=state.templates;
    const catalog={schemaVersion:1,contract:'evidence-backed-formula-seed-catalog/v1',profiles:[profile],
      families:[...new Set(templates.map(x=>x.strategyFamily))],safety:structuredClone(config.catalogSafety)};
    const seedResult={status:profile.status,profile,templates:profile.status==='READY'?templates:[],blockers:profile.blockers??[],safety:structuredClone(config.catalogSafety)};
    const result=await runEvidenceBackedFormulaTournamentAdapterV1({catalog,seedResult,hypothesis:state.hypothesis,decision:state.decision,
      compilerPolicy:config.compilerPolicy,candidatesPerFormula:config.candidatesPerFormula,tournament:config.tournament},backtestDependencies);
    return freeze(tournamentSummary(plan,result));
  };
  return freeze({compileCanonical,runBacktest,authority:SAFE});
}
