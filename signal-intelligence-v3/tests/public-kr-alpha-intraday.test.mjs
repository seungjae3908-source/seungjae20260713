import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePublicKrAlphaOneSession,createPublicKrAlphaOneSessionFeed,inspectPublicKrAlphaSessionShape} from '../src/public-kr-alpha-intraday.mjs';
const NOW=Date.parse('2026-10-11T05:00:00Z');
function oneDay(){
 const list=[];
 for(let m=0;m<=390;m++){
  const minute=9*60+m;
  const time='20261009'+String(Math.floor(minute/60)).padStart(2,'0')+
    String(minute%60).padStart(2,'0')+'00';
  const price=100+Math.floor(m/5),acc=Math.min(m+1,390)*100;
  list.push({localDateTime:time,openPrice:price,highPrice:price+1,
   lowPrice:price-1,currentPrice:price,accumulatedTradingVolume:acc});
 }
 return {code:'0193W0',priceInfos:list};
}
test('Naver day-view proves one 390-minute session, not 391 daily bars',()=>{
 const p=parsePublicKrAlphaOneSession(oneDay(),'0193W0',NOW);
 assert.equal(p.oneMinute.length,380);
 assert.equal(p.fiveMinute.length,76);
 assert.equal(p.fiveMinute[0].volume,500);
 assert.equal(p.fiveMinute.at(-1).volume,500);
 assert.equal(p.fiveMinute.reduce((n,x)=>n+x.volume,0),38000);
 assert.equal(p.sourceCloseMarkerPresent,true);
 assert.equal(p.sourceConstituentCoverageVerified,false);
 assert.equal(p.executionAuthority,'NONE');
});
test('missing slots, overwritten bars, nonmonotonic volume, ambiguous closing marker all fail closed',()=>{
 const original=oneDay();
 const noSlot={...original,priceInfos:original.priceInfos.filter(x=>x.localDateTime!=='20261009090500')};
 assert.throws(()=>parsePublicKrAlphaOneSession(noSlot,'0193W0',NOW),/INCOMPLETE_CONTINUOUS_SESSION/);
 const conflict=oneDay();conflict.priceInfos.push({...conflict.priceInfos[1],currentPrice:101});
 assert.throws(()=>parsePublicKrAlphaOneSession(conflict,'0193W0',NOW),/CONFLICTING_BAR/);
 const volume=oneDay();volume.priceInfos[15].accumulatedTradingVolume=1;
 assert.throws(()=>parsePublicKrAlphaOneSession(volume,'0193W0',NOW),/CUMULATIVE_VOLUME_NONMONOTONIC/);
 const closing=oneDay();closing.priceInfos.at(-1).accumulatedTradingVolume=1;
 assert.throws(()=>parsePublicKrAlphaOneSession(closing,'0193W0',NOW),/CLOSING_VOLUME_UNVERIFIED/);
 assert.throws(()=>parsePublicKrAlphaOneSession(original,'005930',NOW),/CODE_UNSAFE/);
 const tomorrow=oneDay();tomorrow.priceInfos[0].localDateTime='20261012090000';
 assert.throws(()=>parsePublicKrAlphaOneSession(tomorrow,'0193W0',NOW),/FUTURE_BAR/);
});
test('standalone public source cannot query unsupported timeframes or trade endpoints',async()=>{
 let calls=0;
 const feed=createPublicKrAlphaOneSessionFeed({now:()=>NOW,fetchImpl:async url=>{
  calls++;assert.equal(url,'https://stock.naver.com/api/securityService/chart/domestic/item/0193W0?periodType=day');
  return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>oneDay()};
 }});
 await assert.rejects(feed.getCandles('0193W0','1D'),/TIMEFRAME_UNSUPPORTED/);
 assert.equal(calls,0);
 const minute=await feed.getCandles('0193W0','5m');
 assert.equal(minute.length,76);
 assert.equal(calls,1);
 assert.equal(feed.fullMarketReady,false);
});

test('sanitized minute feed inspection classifies timestamps without exposing quotes or identifiers',()=>{
 const original=oneDay();
 const corrupted=[...original.priceInfos];
 corrupted[0]={...corrupted[0],localDateTime:'20261009090035'};
 corrupted[1]={...corrupted[1],localDateTime:'20261009083000'};
 corrupted[2]={...corrupted[2],localDateTime:'bad'};
 const evidence=inspectPublicKrAlphaSessionShape({priceInfos:corrupted});
 assert.equal(evidence.classifications.nonzeroSeconds,1);
 assert.equal(evidence.classifications.outsideSession,1);
 assert.equal(evidence.classifications.invalidLength,1);
 assert.equal(evidence.missingRegularMinutes,3);
 assert.equal(evidence.executionAuthority,'NONE');
 assert.equal(evidence.fullMarketSupported,false);
 assert.equal(evidence.sourcePricesRedacted,true);
 assert.equal(JSON.stringify(evidence).includes('accumulatedTradingVolume'),false);
});

test('KRX closing auction 15:20–15:29 is accounted for separately from genuinely missing continuous 1m history',()=>{
 const day=oneDay();
 const rows=day.priceInfos.filter(v=>{
   const hhmm=Number(v.localDateTime.slice(8,12));
   return hhmm<1520 || hhmm>=1530;
 });
 for(let minute=31;minute<=40;minute++)rows.push({
   ...rows.at(-1),
   localDateTime:'2026100915'+String(minute).padStart(2,'0')+'00',
 });
 const e=inspectPublicKrAlphaSessionShape({priceInfos:rows});
 assert.equal(e.totalRows,391);
 assert.equal(e.missingRegularMinutes,10);
 assert.equal(e.missingContinuousTradingMinutes,0);
 assert.equal(e.missingClosingAuctionMinutes,10);
 assert.equal(e.outsideAfterClose,10);
 assert.equal(e.outsideBeforeOpen,0);
 assert.equal(e.closingAt1530Present,true);
 assert.equal(e.sourcePricesRedacted,true);
});

test('observed KRX 15:20-15:29 call-auction gap and 15:31-15:40 excluded after-hours cannot create artificial 1m/5m bars',()=>{
 const day=oneDay();
 const source=day.priceInfos.filter(row=>{
   const clock=Number(row.localDateTime.slice(8,12));
   return clock<1520||clock>=1530;
 });
 for(let minute=31;minute<=40;minute++)source.push({
  ...source.at(-1),
  localDateTime:'2026100915'+String(minute).padStart(2,'0')+'00',
 });
 const parsed=parsePublicKrAlphaOneSession({code:'0193W0',priceInfos:source},'0193W0',NOW);
 assert.equal(parsed.oneMinute.length,380);
 assert.equal(parsed.fiveMinute.length,76);
 assert.equal(parsed.closingAuctionMinutesAbsent,10);
 assert.equal(parsed.excludedAfterCloseRows,10);
 assert.equal(parsed.excludedClosingAuctionMinutes,0);
 assert.equal(parsed.full390MinuteContinuousTrading,false);
 assert.equal(parsed.closingAuctionNotUsedForIntradaySignals,true);
 assert.equal(parsed.sourceSessionContinuityVerified,true);
 assert.equal(parsed.sourceConstituentCoverageVerified,false);
});
