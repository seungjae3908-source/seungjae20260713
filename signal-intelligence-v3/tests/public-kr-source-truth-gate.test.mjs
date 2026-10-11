import test from 'node:test';
import assert from 'node:assert/strict';
import {assertBlockedKrPublicResearchCoverage} from '../src/public-kr-source-truth-gate.mjs';
const quality=()=>({
 version:'public-stock-source-audit-v1',symbolsRedacted:true,fullMarketVerified:false,
 executionAuthority:'NONE',quote:{errors:0},
 sanitizedProviderFailures:{HTTP_429:0,HTTP_4XX:0,HTTP_5XX:0,TIMEOUT:0,OTHER:0},
 candles:{
  '15m':{fetched:20,invalidOhlc:0,empty:0,shortLt20:0},
  '60m':{fetched:20,invalidOhlc:0,empty:0,shortLt20:0},
  '1D':{fetched:33,invalidOhlc:26,empty:0,shortLt20:0},
 },
});
function fixture(){
 const base={market:'KR_STOCK',rosterVerified:true,universePartial:true,
  universeStale:false,universeProviderErrors:0,totalUniverse:4010,
  providerErrors:0,timeouts:0,requestedCount:20,startedCount:20,completedCount:20,
  batchDeadlineExceeded:false,retainedFromBatch:0,scannedCards:0,
  lastGoodPreserved:true,publicStockSourceAudit:quality(),
  cursorBefore:0,
 };
 return {publicDataOnly:true,safety:{executionAuthority:'NONE'},coverage:[
  {...base,strategy:'SCALPING',timeframe:'15m',status:'BLOCKED_DATA',responseDataState:'untrusted',
   cursorAfter:20,cursorRotatedBlockedOnly:true,insufficientDataCount:0},
  {...base,strategy:'SWING',timeframe:'60m',status:'BLOCKED_DATA',responseDataState:'partial',
   cursorAfter:20,cursorRotatedBlockedOnly:true,insufficientDataCount:0},
  {...base,strategy:'MID_LONG',timeframe:'1D',status:'SEARCH_FAILURE',responseDataState:'partial',
   cursorAfter:0,cursorRotatedBlockedOnly:false,insufficientDataCount:13},
 ]};
}
test('real Yahoo KR partial roster + invalid daily candles are explicit blocked market data, never profitable PASS',()=>{
 const report=assertBlockedKrPublicResearchCoverage(fixture());
 assert.equal(report.releaseReady,false);
 assert.equal(report.krWholeUniverseVerified,false);
 assert.equal(report.verdict,'CODE_FAILCLOSED_WITH_MISSING_MARKET_DATA');
 assert.equal(report.lanes.find(x=>x.timeframe==='1D').result,'BAD_CANDLE_PAGE_HELD');
 assert.equal(report.lanes.find(x=>x.timeframe==='1D').invalidSourceBars,26);
 assert.equal(report.lanes.find(x=>x.timeframe==='1D').insufficientCount,13);
 assert.equal(report.tradingAuthority,'NONE');
});
test('a missing OHLC evidence, unsafe cursor advance, candidate promotion or provider errors FAIL the contract',()=>{
 const overrides=[
  r=>{r.coverage[2].status='CANDIDATES_AVAILABLE'},
  r=>{r.coverage[2].cursorAfter=20},
  r=>{r.coverage[2].publicStockSourceAudit.candles['1D'].invalidOhlc=0},
  r=>{r.coverage[2].insufficientDataCount=0},
  r=>{r.coverage[0].providerErrors=1},
  r=>{r.coverage[0].retainedFromBatch=1},
  r=>{r.coverage[1].cursorRotatedBlockedOnly=false},
  r=>{r.coverage[1].universePartial=false},
  r=>{r.safety.executionAuthority='LIVE'},
 ];
 for(const change of overrides){
  const report=fixture();change(report);
  assert.throws(()=>assertBlockedKrPublicResearchCoverage(report),/KR_PUBLIC_/);
 }
});

test('genuine bounded public provider failure remains SEARCH_FAILURE and cannot fabricate missing-market evidence',()=>{
 const report=fixture();
 for(const row of report.coverage.slice(0,2)){
  row.status='SEARCH_FAILURE';
  row.error='SCAN_PROVIDER_ERROR';
  row.rosterVerified=false;
  row.cursorAfter=row.cursorBefore;
  row.scannedCards=0;
  row.retainedFromBatch=0;
  row.requestedCount=null;
  row.startedCount=null;
  row.completedCount=null;
  row.providerErrors=10;
  row.timeouts=0;
  row.lastGoodPreserved=true;
  row.thrownProviderMetrics={
   completed:0,providerErrors:10,workerErrors:0,timeouts:0,started:10,
   sourceFailureConfirmed:true,fullMarketVerified:false,
  };
  delete row.publicStockSourceAudit;
  delete row.cursorRotatedBlockedOnly;
 }
 const result=assertBlockedKrPublicResearchCoverage(report);
 assert.equal(result.releaseReady,false);
 assert.equal(result.krWholeUniverseVerified,false);
 assert.equal(result.lanes[0].result,'PROVIDER_FAILED_CURSOR_HELD');
 assert.equal(result.lanes[1].sourceProviderErrors,10);
 assert.equal(result.lanes[2].result,'BAD_CANDLE_PAGE_HELD');
 assert.equal(result.lanes.every(l=>l.cursorHeld),true);
});
test('missing or altered provider failure evidence fails closed rather than passing green',()=>{
 const cases=[
  r=>{r.status='CANDIDATES_AVAILABLE'},
  r=>{r.cursorAfter=20},
  r=>{r.thrownProviderMetrics.sourceFailureConfirmed=false},
  r=>{r.thrownProviderMetrics.started=0},
  r=>{r.thrownProviderMetrics.fullMarketVerified=true},
  r=>{r.thrownProviderMetrics.providerErrors=1},
  r=>{r.thrownProviderMetrics.completed=1},
  r=>{r.lastGoodPreserved=false},
  r=>{r.requestedCount=20},
 ];
 for(const change of cases){
  const report=fixture();const row=report.coverage[0];
  Object.assign(row,{
   status:'SEARCH_FAILURE',error:'SCAN_PROVIDER_ERROR',rosterVerified:false,
   cursorAfter:0,requestedCount:null,startedCount:null,completedCount:null,
   providerErrors:10,timeouts:0,
   thrownProviderMetrics:{
    completed:0,providerErrors:10,workerErrors:0,timeouts:0,started:10,
    sourceFailureConfirmed:true,fullMarketVerified:false,
   },
  });
  delete row.publicStockSourceAudit;
  delete row.cursorRotatedBlockedOnly;
  change(row);
  assert.throws(()=>assertBlockedKrPublicResearchCoverage(report),/KR_PUBLIC_/);
 }
});
