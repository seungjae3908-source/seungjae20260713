const CASH_MARKETS = new Set(['KR_STOCK','US_STOCK','CRYPTO_SPOT']);
const STOCK_MARKETS = new Set(['KR_STOCK','US_STOCK']);
const MARKETS = new Set(['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES']);

function frozen(value){ return Object.freeze(value); }
function nonEmpty(value){ return typeof value==='string'&&value.trim().length>0; }
function sha(value,n){ return typeof value==='string'&&new RegExp(`^[0-9a-f]{${n}}$`,'iu').test(value); }
function finite(value){ return Number.isFinite(value); }
function mean(values){ return values.length?values.reduce((a,b)=>a+b,0)/values.length:null; }
function stdev(values){
  if(values.length<2) return null;
  const m=mean(values);
  const v=values.reduce((s,x)=>s+(x-m)**2,0)/(values.length-1);
  return Math.sqrt(v);
}
function directionGroup(value){
  const v=String(value??'').trim().toUpperCase();
  if(v==='LONG'||v==='BUY') return 'LONG';
  if(v==='SHORT'||v==='SELL') return 'SHORT';
  return null;
}
function resultDirection(result){
  const side=String(result?.side??'').toLowerCase();
  if(side==='long') return 'LONG';
  if(side==='short') return 'SHORT';
  return null;
}
function qualityMissing(reason,details={}){
  return frozen({
    schemaVersion:'move-hunter-scanner-quality-bridge/v1',
    status:'BLOCKED_DATA',
    reason,
    details:frozen(details),
    quality:frozen({status:'missing',source:'MOVE_HUNTER_CANONICAL_QUALITY_BRIDGE_V1'}),
    profitabilityClaimAllowed:false,
    automaticPromotionAuthority:false,
    activeLaneMutation:false,
    economicSampleCredit:0,
    executionAuthority:'NONE',
  });
}
function qualityInsufficient(reason,quality,details={}){
  return frozen({
    schemaVersion:'move-hunter-scanner-quality-bridge/v1',
    status:'INSUFFICIENT_SAMPLE',
    reason,
    details:frozen(details),
    quality:frozen({...quality,status:'insufficient'}),
    profitabilityClaimAllowed:false,
    automaticPromotionAuthority:false,
    activeLaneMutation:false,
    economicSampleCredit:0,
    executionAuthority:'NONE',
  });
}
function assertIdentity(identity){
  if(!identity||typeof identity!=='object') return 'IDENTITY_REQUIRED';
  if(!MARKETS.has(identity.market)) return 'MARKET_INVALID';
  if(!nonEmpty(identity.symbol)||!nonEmpty(identity.timeframe)) return 'SYMBOL_OR_TIMEFRAME_REQUIRED';
  if(!nonEmpty(identity.strategyProfileId)||!nonEmpty(identity.strategyVersion)) return 'SCANNER_STRATEGY_IDENTITY_REQUIRED';
  if(!sha(identity.parameterHash,64)) return 'PARAMETER_HASH_REQUIRED';
  if(!sha(identity.researchCodeSha,40)) return 'RESEARCH_CODE_SHA_REQUIRED';
  if(!sha(identity.datasetSnapshotHash,64)) return 'DATASET_SNAPSHOT_HASH_REQUIRED';
  const dir=directionGroup(identity.direction);
  if(!dir) return 'DIRECTION_REQUIRED';
  if(CASH_MARKETS.has(identity.market)&&dir!=='LONG') return 'CASH_MARKET_LONG_ONLY';
  return null;
}
function sameBinding(binding,identity){
  if(!binding||typeof binding!=='object') return false;
  for(const key of ['market','symbol','timeframe','strategyProfileId','strategyVersion','parameterHash','researchCodeSha','datasetSnapshotHash']){
    if(String(binding[key]??'')!==String(identity[key]??'')) return false;
  }
  return directionGroup(binding.direction)===directionGroup(identity.direction);
}
function validateResult(result,identity,label){
  const blockers=[];
  if(!result||typeof result!=='object'||result.ok!==true||result.mode!=='backtest-only') blockers.push(`${label}_RESULT_INVALID`);
  if(result?.market!==identity.market) blockers.push(`${label}_MARKET_MISMATCH`);
  if(result?.symbol!==identity.symbol) blockers.push(`${label}_SYMBOL_MISMATCH`);
  if(result?.timeframe!==identity.timeframe) blockers.push(`${label}_TIMEFRAME_MISMATCH`);
  if(resultDirection(result)!==directionGroup(identity.direction)) blockers.push(`${label}_DIRECTION_MISMATCH`);
  if(result?.orderSubmitted!==false||result?.privateAccountRequestAllowed!==false) blockers.push(`${label}_SAFETY_INVALID`);
  const safeguards=result?.safeguards??{};
  if(safeguards.signalUsesClosedCandle!==true) blockers.push(`${label}_CLOSED_CANDLE_GUARD_MISSING`);
  if(safeguards.entryUsesNextCandleOpen!==true) blockers.push(`${label}_NEXT_OPEN_GUARD_MISSING`);
  if(safeguards.stopFirstOnAmbiguousBar!==true) blockers.push(`${label}_INTRABAR_GUARD_MISSING`);
  if(safeguards.costsIncluded!==true) blockers.push(`${label}_COST_GUARD_MISSING`);
  if(!Array.isArray(result?.trades)) blockers.push(`${label}_TRADES_MISSING`);
  if(!finite(result?.period?.startTime)||!finite(result?.period?.effectiveEndTime)||result.period.effectiveEndTime<result.period.startTime){
    blockers.push(`${label}_PERIOD_INVALID`);
  }
  return blockers;
}
function tradeReturnPercent(trade){
  if(finite(trade?.netReturnOnMargin)) return trade.netReturnOnMargin*100;
  if(finite(trade?.netPnl)&&finite(trade?.entryNotional)&&trade.entryNotional>0) return trade.netPnl/trade.entryNotional*100;
  return null;
}
function summarizeTrades(rows){
  const ids=new Set();
  const returns=[];
  let grossProfit=0,grossLoss=0;
  let equity=1,peak=1,maxDd=0;
  for(const trade of rows){
    if(!trade||typeof trade!=='object') throw new TypeError('trade must be an object');
    const id=String(trade.id??'');
    if(!id) throw new Error('TRADE_ID_REQUIRED');
    if(ids.has(id)) throw new Error('DUPLICATE_TRADE_ID');
    ids.add(id);
    if(!finite(trade.netPnl)) throw new Error('TRADE_NET_PNL_REQUIRED');
    const r=tradeReturnPercent(trade);
    if(!finite(r)) throw new Error('TRADE_RETURN_REQUIRED');
    returns.push(r);
    if(trade.netPnl>0) grossProfit+=trade.netPnl;
    if(trade.netPnl<0) grossLoss+=Math.abs(trade.netPnl);
    equity*=1+r/100;
    peak=Math.max(peak,equity);
    if(peak>0) maxDd=Math.max(maxDd,1-equity/peak);
  }
  const wins=returns.filter(x=>x>0);
  const avg=mean(returns)??0;
  const sd=stdev(returns);
  return frozen({
    n:returns.length,
    winRate:returns.length?wins.length/returns.length*100:0,
    expectancyPercent:avg,
    profitFactor:grossLoss>0?grossProfit/grossLoss:(grossProfit>0?null:0),
    maxDrawdownPercent:maxDd*100,
    netReturnPercent:(equity-1)*100,
    sharpe:sd&&sd>0?avg/sd*Math.sqrt(returns.length):null,
  });
}
function exactFoldWindow(rows){
  if(!Array.isArray(rows)||rows.length===0) return null;
  const start=Math.min(...rows.map(x=>Number(x.anchorTimestamp)).filter(Number.isFinite));
  const end=Math.max(...rows.map(x=>Number(x.futureEndTimestamp)).filter(Number.isFinite));
  return finite(start)&&finite(end)&&end>=start?frozen({start,end}):null;
}
function resultCovers(result,window){
  return !!window&&result?.period?.startTime===window.start&&result?.period?.effectiveEndTime===window.end;
}
function costReady(costEvidence,market){
  if(!costEvidence||costEvidence.status!=='READY') return false;
  const required=['commission','spread','slippage','latency','liquidityImpact','partialFillImpact'];
  if(STOCK_MARKETS.has(market)) required.push('tax');
  if(market==='CRYPTO_FUTURES') required.push('funding');
  return required.every(key=>{
    const row=costEvidence[key];
    return row?.status==='READY'&&row.measuredOrDocumented===true&&finite(row.valuePercent)&&row.valuePercent>=0;
  });
}
function survivorshipReady(identity,datasetAudit,stockUniverseBiasAudit){
  if(datasetAudit?.eligible!==true) return false;
  if(datasetAudit?.safeguards?.lookaheadBlocked!==true) return false;
  if(datasetAudit?.safeguards?.survivorshipProtected!==true) return false;
  if(STOCK_MARKETS.has(identity.market)){
    return stockUniverseBiasAudit?.status==='point_in_time_bias_gate_passed'
      && stockUniverseBiasAudit?.safeguards?.currentConstituentListAloneCannotPass===true
      && stockUniverseBiasAudit?.safeguards?.missingHistoriesFailClosed===true;
  }
  return true;
}

export function buildScannerBacktestQualityFromCanonicalEvidence({
  identity,
  folds,
  foldResults,
  datasetAudit,
  stockUniverseBiasAudit=null,
  costEvidence,
  minimumTradeCount=40,
}={}){
  const identityError=assertIdentity(identity);
  if(identityError) return qualityMissing(identityError);
  if(!Array.isArray(folds)||folds.length===0) return qualityMissing('PURGED_WALK_FORWARD_FOLDS_REQUIRED');
  if(!Array.isArray(foldResults)||foldResults.length!==folds.length) return qualityMissing('FOLD_RESULT_COUNT_MISMATCH');
  if(!Number.isInteger(minimumTradeCount)||minimumTradeCount<1) return qualityMissing('MINIMUM_TRADE_COUNT_INVALID');

  if(!costReady(costEvidence,identity.market)) return qualityMissing('FULL_COST_EVIDENCE_NOT_READY');
  if(!survivorshipReady(identity,datasetAudit,stockUniverseBiasAudit)) return qualityMissing('LOOKAHEAD_OR_SURVIVORSHIP_GUARD_NOT_READY');

  const oosTrades=[];
  const walkForwardTrades=[];
  let researchFrom=Infinity,researchTo=-Infinity;

  for(let i=0;i<folds.length;i+=1){
    const fold=folds[i], packet=foldResults[i];
    if(packet?.fold!==fold?.fold) return qualityMissing('FOLD_ID_MISMATCH',{index:i});
    if(fold?.leakFree!==true) return qualityMissing('LEAK_FREE_FOLD_REQUIRED',{fold:fold?.fold??null});
    if(!sameBinding(packet?.binding,identity)) return qualityMissing('EVIDENCE_BINDING_MISMATCH',{fold:fold.fold});

    const oos=packet?.outOfSampleResult;
    const wf=packet?.walkForwardResult;
    const resultBlockers=[
      ...validateResult(oos,identity,`FOLD_${fold.fold}_OOS`),
      ...validateResult(wf,identity,`FOLD_${fold.fold}_WF`),
    ];
    if(resultBlockers.length) return qualityMissing('BACKTEST_RESULT_CONTRACT_INVALID',{blockers:frozen(resultBlockers)});

    const oosWindow=exactFoldWindow(fold.outOfSample);
    const wfWindow=exactFoldWindow(fold.walkForwardTest);
    if(!resultCovers(oos,oosWindow)) return qualityMissing('OOS_WINDOW_BINDING_MISMATCH',{fold:fold.fold});
    if(!resultCovers(wf,wfWindow)) return qualityMissing('WALK_FORWARD_WINDOW_BINDING_MISMATCH',{fold:fold.fold});

    researchFrom=Math.min(researchFrom,oosWindow.start,wfWindow.start);
    researchTo=Math.max(researchTo,oosWindow.end,wfWindow.end);
    oosTrades.push(...oos.trades);
    walkForwardTrades.push(...wf.trades);
  }

  let oosSummary,wfSummary;
  try{
    oosSummary=summarizeTrades(oosTrades);
    wfSummary=summarizeTrades(walkForwardTrades);
  }catch(error){
    return qualityMissing('TRADE_SUMMARY_INVALID',{message:error instanceof Error?error.message:String(error)});
  }

  const source=[
    'MOVE_HUNTER_CANONICAL_QUALITY_BRIDGE_V1',
    identity.strategyProfileId,
    identity.researchCodeSha,
    identity.datasetSnapshotHash,
  ].join(':');

  const quality={
    status:'verified',
    researchFrom:new Date(researchFrom).toISOString(),
    researchTo:new Date(researchTo).toISOString(),
    oosWinRate:oosSummary.winRate,
    walkForwardWinRate:wfSummary.winRate,
    expectancyPercent:wfSummary.expectancyPercent,
    profitFactor:wfSummary.profitFactor,
    maxDrawdownPercent:-Math.abs(wfSummary.maxDrawdownPercent),
    tradeCount:wfSummary.n,
    minimumTradeCount,
    sharpe:wfSummary.sharpe,
    netReturnPercent:wfSummary.netReturnPercent,
    regime:null,
    regimeScore:null,
    oosStabilityScore:null,
    costsIncluded:true,
    slippageIncluded:true,
    lookaheadGuarded:true,
    survivorshipGuarded:true,
    oos:true,
    walkForward:true,
    source,
  };

  if(wfSummary.n<minimumTradeCount){
    return qualityInsufficient('WALK_FORWARD_MINIMUM_TRADE_COUNT_NOT_MET',quality,{walkForwardTrades:wfSummary.n,minimumTradeCount});
  }

  return frozen({
    schemaVersion:'move-hunter-scanner-quality-bridge/v1',
    status:'VERIFIED_QUALITY_PACKET',
    reason:null,
    identity:frozen({...identity,direction:directionGroup(identity.direction)}),
    quality:frozen(quality),
    diagnostics:frozen({
      foldCount:folds.length,
      oosTrades:oosSummary.n,
      walkForwardTrades:wfSummary.n,
      oosSummary,
      walkForwardSummary:wfSummary,
    }),
    profitabilityClaimAllowed:false,
    automaticPromotionAuthority:false,
    activeLaneMutation:false,
    economicSampleCredit:0,
    executionAuthority:'NONE',
  });
}
