import { evaluateMomentumGuardForwardV1 } from './momentum-guard.mjs';

function frozen(value){ return Object.freeze(value); }
function finiteOrNull(value){ return Number.isFinite(value) ? value : null; }
function mean(values){ return values.length ? values.reduce((a,b)=>a+b,0)/values.length : null; }
function directionGroup(value){
  const v=String(value??'').trim().toUpperCase();
  if(v==='BUY'||v==='LONG') return 'LONG';
  if(v==='SELL'||v==='SHORT') return 'SHORT';
  return null;
}
function blocked(reason, details={}){
  return frozen({
    schemaVersion:'move-hunter-forward-momentum-guard-record/v1',
    status:'BLOCKED_DATA',
    reason,
    details:frozen(details),
    economicSampleCredit:0,
    profitabilityClaimAllowed:false,
    automaticPromotionAuthority:false,
    executionAuthority:'NONE',
  });
}
function canonicalMomentumIdentity(snapshot){
  const identity=snapshot?.evidence?.momentum?.evidence?.identity;
  return identity&&typeof identity==='object'?identity:null;
}

export function buildMomentumGuardForwardRecord({
  observation,
  featureSnapshot,
}={}){
  if(!observation||typeof observation!=='object') return blocked('FORWARD_OBSERVATION_REQUIRED');
  if(
    observation.schemaVersion!=='forward-recommendation-observation-v2'
    || observation.source!=='LIVE_RECOMMENDATION'
    || observation.publicDataOnly!==true
    || observation.simulatedOnly!==true
    || observation.executionAuthority!=='NONE'
    || observation.financialMutationAllowed!==false
    || observation.liveOrderAllowed!==false
    || observation.privateTradingApiAllowed!==false
    || observation.orderSubmitted!==false
    || observation.exchangeRequestSent!==false
    || observation.profitabilityClaimAllowed!==false
  ) return blocked('FORWARD_OBSERVATION_SAFETY_ENVELOPE_INVALID');

  const identity=observation.identity;
  const signal=observation.snapshot;
  if(!identity||!signal) return blocked('FORWARD_IDENTITY_OR_SNAPSHOT_MISSING');
  const evidenceIdentity=canonicalMomentumIdentity(featureSnapshot);
  if(!evidenceIdentity) return blocked('CANONICAL_MOMENTUM_EVIDENCE_IDENTITY_MISSING');
  if(featureSnapshot?.executionAuthority!=='NONE'||featureSnapshot?.decisionAuthority!=='EVIDENCE_ONLY'){
    return blocked('CANONICAL_MARKET_FEATURE_AUTHORITY_INVALID');
  }

  const mismatches=[];
  if(evidenceIdentity.market!==identity.market) mismatches.push('MARKET');
  if(evidenceIdentity.symbol!==identity.symbol) mismatches.push('SYMBOL');
  if(evidenceIdentity.timeframe!==identity.timeframe) mismatches.push('TIMEFRAME');
  if(directionGroup(evidenceIdentity.side)!==directionGroup(identity.direction)) mismatches.push('DIRECTION');
  if(evidenceIdentity.temporal?.decisionTime!==signal.timestamp) mismatches.push('DECISION_TIME');
  if(signal.market!==identity.market) mismatches.push('SNAPSHOT_MARKET');
  if(signal.symbol!==identity.symbol) mismatches.push('SNAPSHOT_SYMBOL');
  if(directionGroup(signal.direction)!==directionGroup(identity.direction)) mismatches.push('SNAPSHOT_DIRECTION');
  if(mismatches.length) return blocked('FORWARD_FEATURE_IDENTITY_MISMATCH',{mismatches:frozen(mismatches)});

  const guard=evaluateMomentumGuardForwardV1(featureSnapshot);
  if(guard.status==='BLOCKED_DATA') return blocked('MOMENTUM_GUARD_BLOCKED',{guardReason:guard.reason});

  const settled=observation.status==='SETTLED'&&observation.outcome!=null;
  const pending=observation.status==='PENDING'&&observation.outcome==null;
  if(!settled&&!pending) return blocked('FORWARD_SETTLEMENT_STATE_INVALID');

  const outcome=observation.outcome;
  return frozen({
    schemaVersion:'move-hunter-forward-momentum-guard-record/v1',
    status:settled?'SETTLED':'PENDING',
    observationId:observation.observationId,
    identity:frozen({
      strategyId:identity.strategyId,
      strategyVersion:identity.strategyVersion,
      parameterHash:identity.parameterHash,
      researchCodeSha:identity.researchCodeSha,
      market:identity.market,
      symbol:identity.symbol,
      timeframe:identity.timeframe,
      horizon:identity.horizon,
      direction:identity.direction,
    }),
    signalTimestamp:signal.timestamp,
    dataTimestamp:observation.dataTimestamp,
    settledAt:observation.settledAt,
    guardEligible:guard.eligible,
    guardChecks:guard.checks,
    outcome:settled?frozen({
      classification:outcome.outcome,
      returnPercent:finiteOrNull(outcome.returnPercent),
      mfePercent:finiteOrNull(outcome.mfePercent),
      maePercent:finiteOrNull(outcome.maePercent),
      target1Hit:outcome.target1Hit===true,
      target2Hit:outcome.target2Hit===true,
      stopLossHit:outcome.stopLossHit===true,
      timeToTargetMs:finiteOrNull(outcome.timeToTargetMs),
      timeToStopMs:finiteOrNull(outcome.timeToStopMs),
      conservativeIntrabarConflict:outcome.conservativeIntrabarConflict===true,
    }):null,
    prospectiveOnly:true,
    observedHistoryMayCountAsOos:false,
    economicSampleCredit:0,
    profitabilityClaimAllowed:false,
    automaticPromotionAuthority:false,
    executionAuthority:'NONE',
  });
}

export function summarizeMomentumGuardForwardRecords(records=[]){
  if(!Array.isArray(records)) throw new TypeError('records must be an array');
  const settled=records.filter(row=>row?.status==='SETTLED'&&row.outcome);
  const summarize=(rows)=>{
    const returns=rows.map(row=>row.outcome.returnPercent).filter(Number.isFinite);
    const mfe=rows.map(row=>row.outcome.mfePercent).filter(Number.isFinite);
    const mae=rows.map(row=>row.outcome.maePercent).filter(Number.isFinite);
    return frozen({
      n:rows.length,
      averageReturnPercent:mean(returns),
      averageMfePercent:mean(mfe),
      averageMaePercent:mean(mae),
      winCount:rows.filter(row=>row.outcome.classification==='WIN').length,
      lossCount:rows.filter(row=>row.outcome.classification==='LOSS').length,
      expiredCount:rows.filter(row=>row.outcome.classification==='EXPIRED').length,
      target1HitCount:rows.filter(row=>row.outcome.target1Hit).length,
      stopHitCount:rows.filter(row=>row.outcome.stopLossHit).length,
    });
  };
  return frozen({
    schemaVersion:'move-hunter-forward-momentum-guard-summary/v1',
    settledN:settled.length,
    guardEligible:summarize(settled.filter(row=>row.guardEligible===true)),
    guardIneligible:summarize(settled.filter(row=>row.guardEligible===false)),
    pendingN:records.filter(row=>row?.status==='PENDING').length,
    selectionThresholdInvented:false,
    profitabilityClaimAllowed:false,
    automaticPromotionAuthority:false,
    economicSampleCredit:0,
    executionAuthority:'NONE',
  });
}
