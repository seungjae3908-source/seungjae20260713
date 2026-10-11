import test from 'node:test';
import assert from 'node:assert/strict';
import {suppressProvisionalKrResearchSignals} from '../src/public-kr-provisional-filter.mjs';
const roster={source:'krx-symbol-master',partial:true,entries:[
 {ticker:'005930',listingStatus:'LISTED'},
 {ticker:'0193W0',listingStatus:'UNKNOWN',publicResearchProvisional:true},
]};
test('public one-symbol history can never leak an action, alert or signal as a listed trade',()=>{
 const src={cards:[
   {symbol:'0193W0',signalId:'blocked',action:'BUY',signalGrade:'S'},
   {symbol:'005930',signalId:'allowed',action:'NO_TRADE'},
 ],alerts:[
   {signalId:'blocked',symbol:'0193W0',action:'BUY'},
   {signalId:'allowed',symbol:'005930',action:'NONE'},
 ],outcome:'CANDIDATES_AVAILABLE',orderSubmitted:false,exchangeRequestSent:false,
 universe:{partial:true},execution:{requestedCount:2,completedCount:2}};
 const filtered=suppressProvisionalKrResearchSignals(src,roster);
 assert.deepEqual(filtered.cards.map(x=>x.symbol),['005930']);
 assert.deepEqual(filtered.alerts.map(x=>x.signalId),['allowed']);
 assert.equal(filtered.provisionalResearchSignalsBlocked,1);
 assert.equal(filtered.provisionalResearchAlertsBlocked,1);
 assert.equal(filtered.memberOrLiveAuthority,false);
 assert.equal(src.cards.length,2);
 assert.equal(filtered.execution,src.execution);
 assert.equal(filtered.universe.partial,true);
 const only=suppressProvisionalKrResearchSignals({
   ...src,cards:src.cards.slice(0,1),alerts:src.alerts.slice(0,1)
 },roster);
 assert.equal(only.cards.length,0);
 assert.equal(only.alerts.length,0);
 assert.equal(only.outcome,'DATA_QUALITY_REJECT');
});
test('wrong shape cannot suppress alert sanitization by silently returning a candidate',()=>{
 assert.throws(()=>suppressProvisionalKrResearchSignals({cards:[],alerts:null},roster),/INVALID/);
});
