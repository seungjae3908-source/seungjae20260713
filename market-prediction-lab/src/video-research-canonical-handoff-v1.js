import { assertResearchVideoSourceV1, assertVideoStrategyHypothesisV1 } from '../../packages/external-research/src/video-intelligence.js';
import { createHypothesisDecisionV1, createStrategyHypothesisV1 } from '../../packages/strategy-hypothesis/src/contract.js';
import { compileStrategyHypothesisToFormulaCandidatesV1 } from './autonomous-strategy-formula-generator-v1.js';

const MARKET_SCOPE=Object.freeze({KR_STOCK:'KR_STOCK',US_STOCK:'US_STOCK',CRYPTO_SPOT:'CRYPTO_SPOT',CRYPTO_FUTURES:'CRYPTO_FUTURES'});
const ASSET_CLASS=Object.freeze({KR_STOCK:'EQUITY',US_STOCK:'EQUITY',CRYPTO_SPOT:'CRYPTO_SPOT',CRYPTO_FUTURES:'CRYPTO_FUTURES'});
const DIRECTION=Object.freeze({LONG:'POSITIVE',SHORT:'NEGATIVE'});
function freeze(v){if(!v||typeof v!=='object'||Object.isFrozen(v))return v;Object.values(v).forEach(freeze);return Object.freeze(v);}
function provenance(source,hypothesis,crossValidationStatus=null){return source&&hypothesis?{sourceContract:'ResearchVideoSourceV1',sourceContractVersion:1,sourceId:source.sourceId,videoHypothesisId:hypothesis.hypothesisId,canonicalUrl:source.canonicalUrl,sourceStartSec:hypothesis.sourceStartSec,sourceEndSec:hypothesis.sourceEndSec,sourceQuoteHash:hypothesis.sourceQuoteHash,crossValidationStatus}:null;}
function blocked(reason,videoProvenance=null,details={}){return freeze({status:'COMPILER_BLOCKED',reason,details,canonicalHypothesis:null,decision:null,videoProvenance,researchOnly:true,economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE'});}
function required(v,code){if(v==null)throw new Error(code);return v;}

export function adaptVideoStrategyToCanonicalHypothesisV1({source,videoHypothesis,crossValidation,papers,canonicalCore,review}={}){
  let vp=null;
  try{
    assertResearchVideoSourceV1(source);assertVideoStrategyHypothesisV1(videoHypothesis);vp=provenance(source,videoHypothesis,crossValidation?.status??null);
    if(source.sourceId!==videoHypothesis.sourceId)return blocked('VIDEO_SOURCE_HYPOTHESIS_MISMATCH',vp);
    if(videoHypothesis.testabilityStatus!=='TESTABLE')return blocked('NON_TESTABLE_STRATEGY',vp,{testabilityStatus:videoHypothesis.testabilityStatus});
    if(!crossValidation||crossValidation.hypothesisId!==videoHypothesis.hypothesisId)return blocked('CROSS_VALIDATION_UNAVAILABLE',vp);
    if(crossValidation.status==='CONTRADICTED')return blocked('CROSS_VALIDATION_CONTRADICTED',vp);
    if(!['PARTIAL_SUPPORT','SUPPORTED'].includes(crossValidation.status))return blocked('CROSS_VALIDATION_UNAVAILABLE',vp);
    if(!Array.isArray(papers))return blocked('RESEARCH_PAPERS_REQUIRED',vp);
    const supportingPaperIds=[...(crossValidation.supportingPaperIds??[])].sort(); const contradictoryPaperIds=[...(crossValidation.contradictoryPaperIds??[])].sort();
    if(!supportingPaperIds.length)return blocked('ACADEMIC_SUPPORT_REQUIRED_FOR_CANONICAL_STRATEGY_HYPOTHESIS',vp);
    const marketScope=MARKET_SCOPE[videoHypothesis.market],assetClass=ASSET_CLASS[videoHypothesis.market],directionality=DIRECTION[videoHypothesis.side];
    if(!marketScope||!assetClass)return blocked('AMBIGUOUS_MARKET',vp); if(!directionality)return blocked('AMBIGUOUS_OR_BIDIRECTIONAL_SIDE',vp); if(!videoHypothesis.timeframe)return blocked('AMBIGUOUS_TIMEFRAME',vp);
    required(canonicalCore,'CANONICAL_CORE_REQUIRED');
    const canonicalHypothesis=createStrategyHypothesisV1({
      title:required(canonicalCore.title,'CANONICAL_TITLE_REQUIRED'),statement:required(canonicalCore.statement,'CANONICAL_STATEMENT_REQUIRED'),marketScope:[marketScope],assetClass,timeframeScope:[videoHypothesis.timeframe],directionality,
      rationale:required(canonicalCore.rationale,'CANONICAL_RATIONALE_REQUIRED'),supportingPaperIds,contradictoryPaperIds,evidenceStrength:required(canonicalCore.evidenceStrength,'CANONICAL_EVIDENCE_STRENGTH_REQUIRED'),expectedEffect:required(canonicalCore.expectedEffect,'CANONICAL_EXPECTED_EFFECT_REQUIRED'),falsificationCriteria:required(canonicalCore.falsificationCriteria,'CANONICAL_FALSIFICATION_REQUIRED'),requiredData:required(canonicalCore.requiredData,'CANONICAL_REQUIRED_DATA_REQUIRED'),knownLimitations:required(canonicalCore.knownLimitations,'CANONICAL_LIMITATIONS_REQUIRED'),createdAt:required(canonicalCore.createdAt,'CANONICAL_CREATED_AT_REQUIRED'),generator:required(canonicalCore.generator,'CANONICAL_GENERATOR_REQUIRED'),evidencePolicy:required(canonicalCore.evidencePolicy,'CANONICAL_EVIDENCE_POLICY_REQUIRED'),
    },papers);
    required(review,'CANONICAL_REVIEW_REQUIRED');
    const decision=createHypothesisDecisionV1({hypothesis:canonicalHypothesis,papers,verdict:'APPROVE_FOR_RESEARCH',rationale:required(review.rationale,'CANONICAL_REVIEW_RATIONALE_REQUIRED'),decidedAt:required(review.decidedAt,'CANONICAL_REVIEW_TIME_REQUIRED'),committee:required(review.committee,'CANONICAL_REVIEW_COMMITTEE_REQUIRED')});
    if(decision.evidenceAssessment.verdict!=='APPROVE_FOR_RESEARCH')return blocked('CANONICAL_EVIDENCE_NOT_APPROVED',vp,{verdict:decision.evidenceAssessment.verdict});
    return freeze({status:'CANONICAL_READY',reason:null,canonicalHypothesis,decision,videoProvenance:vp,researchOnly:true,economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE'});
  }catch(error){return blocked(error instanceof Error?error.message:'CANONICAL_ADAPTER_FAILED',vp);}
}

function result(status,reason,extra={}){return freeze({schemaVersion:'video-research-canonical-handoff-v1',status,reason,...extra,existingStrategyHypothesis:'packages/strategy-hypothesis',existingCompiler:'market-prediction-lab/autonomous-strategy-formula-generator-v1',existingBacktesterSeam:'market-prediction-lab/evidence-backed-formula-tournament-adapter-v1',researchOnly:true,economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE'});}
export function createVideoResearchCanonicalHandoffV1(input={}){
  const adapted=adaptVideoStrategyToCanonicalHypothesisV1(input);
  if(adapted.status!=='CANONICAL_READY')return result('COMPILER_BLOCKED',adapted.reason,{adapterStatus:adapted.status,videoProvenance:adapted.videoProvenance,candidates:[]});
  let candidates;try{candidates=compileStrategyHypothesisToFormulaCandidatesV1({hypothesis:adapted.canonicalHypothesis,decision:adapted.decision,templates:input.templates,policy:input.policy});}catch(error){return result('COMPILER_BLOCKED',error instanceof Error?error.message:'CANONICAL_COMPILER_FAILED',{adapterStatus:adapted.status,videoProvenance:adapted.videoProvenance,canonicalHypothesisId:adapted.canonicalHypothesis.hypothesisId,candidates:[]});}
  if(!Array.isArray(candidates)||!candidates.length)return result('COMPILER_BLOCKED','NO_CANONICAL_FORMULA_CANDIDATE',{adapterStatus:adapted.status,videoProvenance:adapted.videoProvenance,canonicalHypothesisId:adapted.canonicalHypothesis.hypothesisId,candidates:[]});
  if(candidates.some(c=>c.market==='CRYPTO_FUTURES'))return result('BACKTESTER_HANDOFF_BLOCKED','DERIVATIVES_FORMULA_EVALUATOR_NOT_ENABLED',{adapterStatus:adapted.status,videoProvenance:adapted.videoProvenance,canonicalHypothesisId:adapted.canonicalHypothesis.hypothesisId,decisionId:adapted.decision.decisionId,candidates,backtesterCandidateStatus:'BLOCKED_BEFORE_EVALUATION'});
  if(candidates.some(c=>c.evaluationStatus!=='NOT_EVALUATED'||c.formulaPassed!==false||c.safety?.executionAuthority!=='NONE'))return result('BACKTESTER_HANDOFF_BLOCKED','CANONICAL_CANDIDATE_SAFETY_INVARIANT_FAILED',{adapterStatus:adapted.status,videoProvenance:adapted.videoProvenance,canonicalHypothesisId:adapted.canonicalHypothesis.hypothesisId,candidates:[]});
  return result('AWAITING_FORMULA_EVALUATION',null,{adapterStatus:adapted.status,videoProvenance:adapted.videoProvenance,canonicalHypothesisId:adapted.canonicalHypothesis.hypothesisId,decisionId:adapted.decision.decisionId,candidates,backtesterCandidateStatus:'NOT_EVALUATED',requiredNextState:'FORMULA_EVALUATION_PASSED'});
}
