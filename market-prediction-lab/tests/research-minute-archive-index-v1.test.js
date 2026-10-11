import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,rmSync,symlinkSync,chmodSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {persistResearchMinuteSessionV1 as store,
  listArchivedResearchMinuteSessionsV1 as list}
  from "../src/research-minute-archive-v1.js";

const MIN=60_000;
const D=Date.parse("2026-09-18T00:00:00Z");
const hash=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const temp=()=>mkdtempSync(join(tmpdir(),"private-minutes-index-"));
function source({market="KR_STOCK",symbol="005930",
  start=D,minutes=30,kind="REGULAR",sourceId="TEST_PRIVATE_1M_INDEX"}={}){
  const venue=market==="KR_STOCK"?"KRX":market==="US_STOCK"
    ?"US_SIP":market==="CRYPTO_SPOT"?"UPBIT_KRW"
    :"BITGET_USDT_FUTURES";
  const zone=market==="KR_STOCK"?"Asia/Seoul"
    :market==="US_STOCK"?"America/New_York":"UTC";
  const bars=Array.from({length:minutes},(_,i)=>({
    market,venue,symbol,sourceId,timestampMs:start+i*MIN,
    availableAtMs:start+(i+1)*MIN,open:100,high:101,
    low:99,close:100,volume:1,
  }));
  return {market,venue,symbol,sourceId,session:{
    startMs:start,endMs:kind==="UTC_24H"?start+86_400_000:start+minutes*MIN,
    kind,timeZone:zone,
    calendarSourceId:"TEST_LOCAL_MARKET_DATE_NOT_AUTHENTICATED",
  },minuteBars:bars,sourceMinuteRowsSha256:hash(bars),
    asOfMs:start+minutes*MIN};
}
test("KR preceding UTC date premarket and regular session appear on correct local date, resumably",async()=>{
  const root=temp(),pre=source({start:D-30*MIN,kind:"PREMARKET"}),
    regular=source();
  try{
    const a=await store({root,source:pre});
    const b=await store({root,source:regular});
    const req={root,market:"KR_STOCK",symbol:"005930",
      researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"},
      maxSessions:1};
    const first=await list(req);
    assert.equal(first.status,"LOCAL_ORIGINAL_SESSION_INDEX_PAGE_ONLY");
    assert.equal(first.sourceSessions.length,1);
    assert.equal(first.sourceSessions[0].date,"2026-09-18");
    assert.equal(first.sourceSessions[0].startMs,D-30*MIN);
    assert.equal(first.sourceSessions[0].kind,"PREMARKET");
    assert.equal(first.sourceSessions[0].sourceDigestSha256,a.sourceDigestSha256);
    assert.equal(first.nextCursorStartMs,D);
    assert.equal(first.providerGETCount,0);
    assert.equal(first.profitabilityProven,false);
    assert.equal(first.executionAuthority,"NONE");
    const second=await list({...req,cursorStartMs:first.nextCursorStartMs});
    assert.equal(second.sourceSessions.length,1);
    assert.equal(second.sourceSessions[0].date,"2026-09-18");
    assert.equal(second.sourceSessions[0].startMs,D);
    assert.equal(second.sourceSessions[0].kind,"REGULAR");
    assert.equal(second.sourceSessions[0].sourceDigestSha256,b.sourceDigestSha256);
    assert.equal(second.sourceSessions[0].nativeMinuteSlotInventoryComplete,true);
    assert.equal(second.nextCursorStartMs,null);
    assert.equal(second.historicalMarketSourceComplete,false);
    assert.equal(second.independentPITAndSourceAuthentication,false);
    const both=await list({...req,maxSessions:16});
    assert.deepEqual(both.sourceSessions.map(x=>x.kind),["PREMARKET","REGULAR"]);
    assert.equal(both.sessionCount,2);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("US DST-specific UTC starts are indexed by New York local market date, not forced UTC day",async()=>{
  const root=temp();
  try{
    const a=source({market:"US_STOCK",symbol:"AAPL",
      start:Date.parse("2026-01-12T14:30:00Z")});
    const b=source({market:"US_STOCK",symbol:"AAPL",
      start:Date.parse("2026-09-18T13:30:00Z")});
    await store({root,source:a});
    await store({root,source:b});
    const result=await list({root,market:"US_STOCK",symbol:"AAPL",
      researchWindow:{startDate:"2026-01-01",endDate:"2026-09-30"}});
    assert.equal(result.status,"LOCAL_ORIGINAL_SESSION_INDEX_PAGE_ONLY");
    assert.deepEqual(result.sourceSessions.map(x=>x.date),
      ["2026-01-12","2026-09-18"]);
    assert.equal(result.providerGETCount,0);
    assert.equal(result.fullMarketOpportunityDenominatorVerified,false);
    assert.equal(result.trueMarketWideRecall,null);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("absent, conflicting revised, insecure and symlinked archive sources block",async()=>{
  const root=temp();
  try{
    const x=source({market:"CRYPTO_SPOT",symbol:"KRW-BTC",
      start:D,minutes:10,kind:"UTC_24H"});
    // Archive is absent; a date without files is NOT a zero-opportunity day.
    const input={root,market:"CRYPTO_SPOT",symbol:"KRW-BTC",
      researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"}};
    const missing=await list(input);
    assert.equal(missing.status,"BLOCKED_DATA");
    assert.equal(missing.sessionCount,null);
    assert.equal(missing.actualMarketWideOpportunityCount,null);
    await store({root,source:x});
    const alternative=structuredClone(x);
    alternative.minuteBars[0].volume+=3;
    alternative.sourceMinuteRowsSha256=hash(alternative.minuteBars);
    await store({root,source:alternative});
    const ambiguous=await list(input);
    assert.equal(ambiguous.status,"BLOCKED_DATA");
    assert.equal(ambiguous.reason,
      "PRIVATE_ORIGINAL_SESSION_REVISION_OR_INTEGRITY_UNVERIFIED");
    assert.equal(ambiguous.sourceSessions.length,0);
    const linked=join(tmpdir(),"private-index-symlink-"+Date.now());
    symlinkSync(root,linked,"dir");
    try{
      await assert.rejects(()=>list({...input,root:linked}),
        /MINUTE_ARCHIVE_SYMLINK_OR_PARENT_INVALID/);
    }finally{rmSync(linked,{force:true});}
  }finally{rmSync(root,{recursive:true,force:true});}
});
