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
