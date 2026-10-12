import { validateCanonicalEvaluationExecutionRequestV18 } from './research-workspace-canonical-evaluation-one-shot-v18.js';

const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const safeCode=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{2,95}$/.test(value)?value:'CANONICAL_EVALUATION_RUNTIME_ERROR';
const AUTH=Object.freeze({
  providerCalls:0,maxCompilerRuns:1,maxBacktestRuns:1,automaticAdoption:false,paperActivation:false,liveActivation:false,
  profitabilityProven:false,liveTrading:false,autoTrading:false,realOrderEnabled:false,privateTradingApiAllowed:false,
  executionAuthority:'NONE',
});

function resultBase(input,status,reason,counts={},extra={}){
  return freeze({
    schemaVersion:'research-canonical-evaluation-execution-result-v18',
    status,reason,
    evaluationId:input?.request?.evaluationId??null,
    sourceSha:input?.currentSha??null,
    requestDigest:input?.request?.requestDigest??null,
    reservationId:input?.request?.oneShotReservationId??null,
    decisionDigest:input?.decision?.decisionDigest??null,
    configDigest:input?.config?.configDigest??null,
    compilerRuns:counts.compilerRuns??0,
    backtestRuns:counts.backtestRuns??0,
    statisticalFirewallRequired:true,
    finalHoldoutPreAccess:false,
    selectionFeedbackToGenerator:false,
    resultDisposition:'RESEARCH_EVIDENCE_ONLY',
    ...AUTH,
    ...extra,
  });
}

export async function executeCanonicalEvaluationOneShotV18(input={},dependencies={}){
  const validation=validateCanonicalEvaluationExecutionRequestV18(input.request,{
    currentSha:input.currentSha,review:input.review,decision:input.decision,config:input.config,
    preflight:input.preflight,runtimeProof:input.runtimeProof,now:input.checkedAt,
  });
  if(!validation.ok){
    return resultBase(input,'BLOCKED','EXECUTION_CONTRACT_INVALID',{},{
      reasonCodes:validation.reasons,
    });
  }
  const {reserve,compileCanonical,runBacktest,persistResult}=dependencies;
  if([reserve,compileCanonical,runBacktest,persistResult].some(fn=>typeof fn!=='function')){
    return resultBase(input,'BLOCKED','EXECUTOR_DEPENDENCIES_INVALID');
  }

  let reservation;
  try{
    reservation=await reserve(freeze({
      schemaVersion:'research-canonical-evaluation-execution-reservation-v18',
      reservationId:input.request.oneShotReservationId,
      requestDigest:input.request.requestDigest,
      sourceSha:input.currentSha,
      decisionDigest:input.decision.decisionDigest,
      configDigest:input.config.configDigest,
      executionAuthority:'NONE',
    }));
  }catch(error){
    return resultBase(input,'BLOCKED','RESERVATION_PERSISTENCE_UNAVAILABLE',{},{
      detail:safeCode(error?.code??error?.message),
    });
  }
  if(!reservation||reservation.acquired!==true){
    return resultBase(input,'BLOCKED','ONE_SHOT_REPLAY_FORBIDDEN');
  }

  let compilerRuns=0;
  let backtestRuns=0;
  let result;
  try{
    compilerRuns=1;
    const compiled=await compileCanonical(freeze({
      request:input.request,
      currentSha:input.currentSha,
      review:input.review,
      decision:input.decision,
      config:input.config,
      executionContext:input.executionContext??null,
    }));
    if(!compiled||!['READY','REVIEW_REQUIRED'].includes(compiled.status)){
      result=resultBase(input,'REVIEW_REQUIRED','COMPILER_RESULT_INVALID',{compilerRuns,backtestRuns});
    }else if(compiled.status!=='READY'){
      result=resultBase(input,'REVIEW_REQUIRED',safeCode(compiled.reason??'COMPILER_REVIEW_REQUIRED'),{compilerRuns,backtestRuns},{
        compilerStatus:compiled.status,
      });
    }else{
      const backtest=await runBacktest(freeze({
        request:input.request,
        currentSha:input.currentSha,
        config:input.config,
        compiled,
        executionContext:input.executionContext??null,
      }));
      backtestRuns=Number.isSafeInteger(backtest?.backtesterCalls)?backtest.backtesterCalls:0;
      if(backtestRuns<0||backtestRuns>1){
        result=resultBase(input,'BLOCKED','BACKTEST_RUN_BOUND_VIOLATION',{compilerRuns,backtestRuns:0});
      }else if(backtest?.status==='BACKTEST_RECORDED'&&backtestRuns===1){
        result=resultBase(input,'RESEARCH_EVIDENCE_RECORDED',null,{compilerRuns,backtestRuns},{
          compilerDigest:compiled.handoffDigest??null,
          backtestResultDigest:backtest.resultDigest??null,
          metrics:backtest.metrics??null,
          profitabilityProven:false,
        });
      }else{
        result=resultBase(input,'REVIEW_REQUIRED',safeCode(backtest?.reason??'BACKTEST_REVIEW_REQUIRED'),{compilerRuns,backtestRuns},{
          compilerDigest:compiled.handoffDigest??null,
          backtestStatus:backtest?.status??null,
          backtestResultDigest:backtest?.resultDigest??null,
        });
      }
    }
  }catch(error){
    result=resultBase(input,'REVIEW_REQUIRED',safeCode(error?.code??error?.message),{compilerRuns,backtestRuns});
  }

  try{
    const stored=await persistResult(result);
    if(!stored||stored.stored!==true||stored.requestDigest!==input.request.requestDigest){
      return resultBase(input,'BLOCKED','EXECUTION_RESULT_PERSISTENCE_UNCONFIRMED',{compilerRuns,backtestRuns});
    }
  }catch{
    return resultBase(input,'BLOCKED','EXECUTION_RESULT_PERSISTENCE_UNCONFIRMED',{compilerRuns,backtestRuns});
  }
  return result;
}

export const CANONICAL_EVALUATION_EXECUTOR_AUTHORITY_V18=AUTH;
