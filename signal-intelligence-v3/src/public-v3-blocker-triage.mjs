/**
 * Cause-oriented V3 diagnosis from the SAME genuine current public source
 * page and already-adapted research rows. Not an eligibility/quality override.
 * Aggregate only: no symbols, OHLCV, user IDs, API URLs, or raw errors.
 */
const MARKET_IDS=Object.freeze({
  KR_STOCK:'KR',US_STOCK:'US',CRYPTO_SPOT:'SPOT',CRYPTO_FUTURES:'FUTURES',
});
const LANES=Object.freeze(Object.entries(MARKET_IDS).flatMap(([market,prefix])=>
  [['SCALPING','15m'],['SWING','60m'],['MID_LONG','1D']].map(([strategy,timeframe])=>({
    market,strategy,timeframe,id:prefix+'_'+strategy+'_'+timeframe.toUpperCase(),
  }))));
const PASS=new Set(['CANDIDATES_AVAILABLE','VALID_NO_TRADE']);
const STATUS=new Set([...PASS,'SEARCH_FAILURE','BLOCKED_DATA']);
const LIMIT=1_000_000;
const count=x=>Number.isSafeInteger(x)&&x>=0&&x<=LIMIT?x:0;
const subcount=(issues,name)=>count(issues?.[name+':blocking']);
function stockMissing(row){
  return subcount(row?.publicStockQualityDiagnostic?.issueCounts,'MISSING_CANDLE');
}
function cryptoMissing(row){
  return subcount(row?.publicCryptoQualityDiagnostic?.qualityIssues,'MISSING_CANDLE');
}
function blank(){return{
  lanes:0,sourceReadyLanes:0,sourceBlockedLanes:0,
  rosterPartialLanes:0,rosterExcludedKnown:0,
  providerErrorLanes:0,missingCandleLanes:0,
  missingCandleBlockingCards:0,untrustedQualityLanes:0,
  proofInputs:0,canonicalProfitMissing:0,backtestIdentityMissing:0,
  backtestQualityMissing:0,backtestOosMissing:0,
  fullCostIncomplete:0,
};}
export function summarizeV3BlockerTriage(coverage,economicReadiness){
  if(!Array.isArray(coverage)||coverage.length!==LANES.length
    ||economicReadiness?.schemaVersion!=='public-v3-economic-readiness-v1'
    ||!Number.isSafeInteger(economicReadiness?.totalRows)
    ||economicReadiness.totalRows<0
    ||!economicReadiness.byMarket)
    throw Error('V3_BLOCKER_TRIAGE_INPUT_INVALID');
  const byMarket=Object.fromEntries(Object.keys(MARKET_IDS).map(m=>[m,blank()]));
  const seen=new Set();
  for(const lane of coverage){
    const expected=LANES.find(l=>l.id===lane?.laneId);
    if(!expected||seen.has(expected.id)||lane.market!==expected.market
      ||lane.strategy!==expected.strategy||lane.timeframe!==expected.timeframe
      ||!STATUS.has(lane.status))throw Error('V3_BLOCKER_TRIAGE_LANE_INVALID');
    seen.add(expected.id);
    const target=byMarket[lane.market];
    target.lanes+=1;
    const complete=PASS.has(lane.status)
      &&lane.lastGoodPreserved===false&&lane.cursorRotatedBlockedOnly!==true
      &&lane.universePartial===false&&lane.universeStale===false
      &&lane.responseDataState==='complete'
      &&lane.providerErrors===0&&lane.timeouts===0
      &&lane.universeProviderErrors===0;
    if(complete)target.sourceReadyLanes+=1;
    else target.sourceBlockedLanes+=1;
    if(lane.universePartial===true){
      target.rosterPartialLanes+=1;
      // The same 2496 excluded Korean codes appear in 3 timeframes;
      // take a max, never triple-count an instrument as three listings.
      target.rosterExcludedKnown=Math.max(target.rosterExcludedKnown,
        count(lane.universeExplainedExcludedCount));
    }
    if(count(lane.providerErrors)>0||count(lane.timeouts)>0
      ||count(lane.universeProviderErrors)>0)target.providerErrorLanes+=1;
    const blocked=stockMissing(lane)+cryptoMissing(lane);
    if(blocked){
      target.missingCandleLanes+=1;
      target.missingCandleBlockingCards+=blocked;
    }
    const untrusted=count(lane.publicStockQualityDiagnostic?.stateCounts?.DATA_UNTRUSTED)
      +count(lane.publicCryptoQualityDiagnostic?.qualityStates?.DATA_UNTRUSTED);
    if(untrusted>0)target.untrustedQualityLanes+=1;
  }
  const economics=economicReadiness.byMarket;
  for(const market of Object.keys(MARKET_IDS)){
    const row=economics[market];
    if(!row||!Number.isSafeInteger(row.examined)||row.examined<0
      ||row.examined>economicReadiness.totalRows)
      throw Error('V3_BLOCKER_TRIAGE_ECONOMIC_INVALID');
    const target=byMarket[market];
    target.proofInputs=row.examined;
    target.canonicalProfitMissing=count(row.canonicalProofAbsent);
    target.backtestIdentityMissing=count(row.backtestIdentityMissing);
    target.backtestQualityMissing=count(row.backtestEvidenceMissing);
    target.backtestOosMissing=count(row.backtestOosOrWalkForwardMissing);
    target.fullCostIncomplete=count(row.backtestFullCostIncomplete);
  }
  return Object.freeze({
    schemaVersion:'public-v3-blocker-triage-v1',
    scope:'CURRENT_PUBLIC_PAGES_AND_RETAINED_RESEARCH_ONLY',
    sourceLanes:12,
    sourceReadyLanes:Object.values(byMarket).reduce((n,x)=>n+x.sourceReadyLanes,0),
    sourceBlockedLanes:Object.values(byMarket).reduce((n,x)=>n+x.sourceBlockedLanes,0),
    researchRows:economicReadiness.totalRows,
    byMarket:Object.freeze(Object.fromEntries(
      Object.entries(byMarket).map(([k,v])=>[k,Object.freeze(v)]))),
    claims:Object.freeze({
      eligibleCursorPassIsAllSymbolCoverage:false,
      independentOosPassProven:false,
      fullCostProfitabilityProven:false,
      publisherAuthorized:false,
    }),
    includedInstrumentIdentity:false,
    includedCandleSamples:false,
    addedProviderRequests:0,
    economicAuthority:'NONE',
  });
}
