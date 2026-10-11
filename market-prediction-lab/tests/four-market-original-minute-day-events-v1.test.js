import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {persistResearchMinuteSessionV1 as save} from
  "../src/research-minute-archive-v1.js";
import {digestPITMembershipRowsV1} from
  "../src/historical-pit-venue-universe-gate-v1.js";
import {auditFourMarketOriginalMinuteOpportunityV1 as sessionAudit,
  auditFourMarketOriginalMinuteOpportunityDayV1 as dayAudit}
  from "../src/four-market-original-minute-opportunities-v1.js";
import {runFourMarketOriginalMinuteBatchV1 as batch}
  from "../src/four-market-original-minute-batch-v1.js";

const MIN=60_000,DAY=86_400_000,D=Date.parse("2026-09-18T00:00:00Z");
const HASH=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const ROOT=()=>mkdtempSync(join(tmpdir(),"original-dated-event-"));
const P={
  KR_STOCK:{venue:"KRX",symbol:"005930",zone:"Asia/Seoul",
    pre:D-30*MIN,regular:D+10*MIN},
  US_STOCK:{venue:"US_SIP",symbol:"AAPL",zone:"America/New_York",
    pre:Date.parse("2026-09-18T12:30:00Z"),
    regular:Date.parse("2026-09-18T13:40:00Z")},
};
function native(market,kind,start,burst=false){
  const pol=P[market],sourceId="TEST_NATIVE_DATED_PRE_REGULAR_1M";
  const minuteBars=Array.from({length:30},(_,i)=>{
    const baseline=burst?110:100;
    const peak=burst&&i===0?111:baseline;
    return {market,venue:pol.venue,symbol:pol.symbol,sourceId,
      timestampMs:start+i*MIN,availableAtMs:start+(i+1)*MIN,
      open:baseline,high:Math.max(baseline,peak)+0.1,
      low:baseline-0.1,close:peak,volume:100};
  });
  return {market,venue:pol.venue,symbol:pol.symbol,sourceId,
    session:{startMs:start,endMs:start+30*MIN,kind,
      timeZone:pol.zone,
      calendarSourceId:"TEST_SESSIONS_CANNOT_PROVE_OFFICIAL_MARKET_COMPLETENESS"},
    minuteBars,sourceMinuteRowsSha256:HASH(minuteBars),
    asOfMs:start+30*MIN};
}
function context(market,root){
  const pol=P[market];
  const pre=native(market,"PREMARKET",pol.pre,false);
  const regular=native(market,"REGULAR",pol.regular,true);
  const memberships=[
    {symbol:pol.symbol,listedAtMs:D-200*DAY,
      removedAtMs:null,halts:[],sourceId:"TEST_DATED_PIT",
      evidenceSha256:"a".repeat(64)},
    {symbol:"DELISTED",listedAtMs:D-300*DAY,
      removedAtMs:D-150*DAY,halts:[],sourceId:"TEST_DATED_PIT",
      evidenceSha256:"a".repeat(64)},
  ];
  const manifest={schemaVersion:"historical-venue-pit-roster-v1",
    sourceClass:"TEST_FIXTURE",testOnly:true,
    market,venue:pol.venue,
    coverageStartMs:D-400*DAY,coverageEndMs:D+40*DAY,
    retrievedAtMs:D+41*DAY,sourceId:"TEST_DATED_PIT",
    allListedAndRemovedAttested:true,suspensionsAttested:true,
    relistedIdentifiersResolved:true,memberships,
    rawMembershipDigestSha256:digestPITMembershipRowsV1(memberships)};
  const sessions=[pre,regular].map(s=>({
    date:"2026-09-18",startMs:s.session.startMs,
    endMs:s.session.endMs,kind:s.session.kind,
    zone:s.session.timeZone,
  }));
  const stockCalendar={market,
    tradingDates:["2015-01-05","2026-09-18","2028-01-03"],
    sessions:sessions.map(s=>({
      tradingDateLocal:s.date,startMs:s.startMs,endMs:s.endMs,
      kind:s.kind,timeZone:s.zone,
    }))};
  const args={root,market,symbol:pol.symbol,day:"2026-09-18",
    sessions,stockCalendar,manifest,
    asOfMs:D+5*DAY,side:"LONG",thresholdPercents:[3,5,10]};
  return {pre,regular,args,stockCalendar,manifest,sessions};
}
test("KR and US day-wide first crossing uses premarket open, not a reset at regular open",async()=>{
  const root=ROOT();
  try{
    for(const market of Object.keys(P)){
      const c=context(market,root);
      await save({root,source:c.pre});
      await save({root,source:c.regular});
      const whole=await dayAudit(c.args);
      assert.equal(whole.status,"SOURCE_ONLY_OBSERVED_PRICE_EVENTS",market);
      assert.equal(whole.sourceSessionsInspected,2,market);
      assert.equal(whole.sourceMinuteRows,60,market);
      assert.equal(whole.retrospectiveEventCount,3,market);
      assert.equal(whole.sourceDigestChainSha256.length,64);
      const first=whole.observedPriceEvents[0];
      assert.equal(first.firstObservedCrossingMinuteStartMs,P[market].regular);
      assert.equal(first.thresholdPercent,3);
      assert.equal(first.snapshots["T-0"].lastClosedMinuteEndMs,
        c.pre.session.endMs);
      const expectedGap=(P[market].regular-c.pre.session.endMs)/MIN;
      assert.equal(first.snapshots["T-0"].minutesBetweenEvidenceAnchorAndLastClosedBar,
        expectedGap);
      assert.equal(first.snapshots["T-0"].closeToAnchorWithoutGap,false);
      assert.ok(first.snapshots["T-5"].lastClosedMinuteEndMs
        <=P[market].regular-5*MIN);
      assert.equal(first.tickCrossingTime,null);
      const regularOnly=await sessionAudit({
        root,market,symbol:c.args.symbol,day:"2026-09-18",
        sessionStartMs:c.regular.session.startMs,
        sessionEndMs:c.regular.session.endMs,
        sessionKind:"REGULAR",sessionTimeZone:P[market].zone,
        manifest:c.manifest,asOfMs:D+5*DAY,
        side:"LONG",thresholdPercents:[3,5,10],
      });
      assert.equal(regularOnly.retrospectiveEventCount,0,
        "old per-session baseline misses regular opening gap");
      const page=await batch({
        root,market,manifest:c.manifest,stockCalendar:c.stockCalendar,
        stockTradingDates:c.stockCalendar.tradingDates,
        researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"},
        sourceSessions:c.sessions.map(s=>({market,symbol:P[market].symbol,...s})),
        asOfMs:D+5*DAY,direction:"LONG",timeframe:"5m",
        fxRateKRWPerQuote:market==="US_STOCK"?1300:null,
      });
      assert.equal(page.status,"SOURCE_ONLY_REPLAY_PAGE_INSPECTED",market);
      assert.equal(page.sourceOnlyEventLabels,3,market);
      assert.equal(page.fullMarketOpportunityDenominatorVerified,false);
      assert.equal(page.trueMarketWideRecall,null);
      assert.equal(page.actualFillCount,null);
      assert.equal(page.executionAuthority,"NONE");
      assert.equal(page.paperAdmissionAllowed,false);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("whole-day price labels fail closed if a declared stock session is omitted or the 1m archive is partial",async()=>{
  const root=ROOT();
  try{
    const c=context("KR_STOCK",root);
    await save({root,source:c.pre});
    const absent=await dayAudit(c.args);
    assert.equal(absent.status,"BLOCKED_DATA");
    assert.equal(absent.reason,"EXCHANGE_DAY_ORIGINAL_1M_SOURCE_PARTIAL_OR_MISSING");
    assert.equal(absent.retrospectiveEventCount,null);
    assert.equal(absent.actualMarketWideOpportunityCount,null);
    assert.equal(absent.profitabilityProven,false);
    const sessionOmitted=await dayAudit({...c.args,sessions:[c.sessions[0]]});
    assert.equal(sessionOmitted.reason,"MISSING_OR_EXTRA_EXCHANGE_DAY_SESSIONS");
    assert.equal(sessionOmitted.observedPriceEvents.length,0);
    assert.equal(sessionOmitted.trueMarketWideRecall,null);
  }finally{rmSync(root,{recursive:true,force:true});}
});
