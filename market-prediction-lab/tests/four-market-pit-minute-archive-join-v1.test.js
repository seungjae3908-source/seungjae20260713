import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync,
  statSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  digestPITMembershipRowsV1 as rosterDigest,
} from "../src/historical-pit-venue-universe-gate-v1.js";
import {
  persistResearchMinuteSessionV1 as store,
} from "../src/research-minute-archive-v1.js";
import {
  auditHistoricalPITMinuteArchiveChunkV1 as audit,
} from "../src/four-market-pit-minute-archive-join-v1.js";
import {
  parsePITMinuteJoinArgsV1 as parseCli,
  runPITMinuteJoinCliV1 as runCli,
} from "../scripts/audit-four-market-pit-minute-archive-v1.mjs";

const D = 86_400_000, M = 60_000;
const START = Date.parse("2026-09-18T00:00:00Z");
const SHA = "a".repeat(64);
const DETAILS = Object.freeze({
  KR_STOCK: { venue: "KRX", symbols: ["000660", "005930"],
    zone: "Asia/Seoul" },
  US_STOCK: { venue: "US_SIP", symbols: ["AAPL", "MSFT"],
    zone: "America/New_York" },
  CRYPTO_SPOT: { venue: "UPBIT_KRW", symbols: ["KRW-A", "KRW-B"],
    zone: "UTC" },
  CRYPTO_FUTURES: { venue: "BITGET_USDT_FUTURES",
    symbols: ["AAAUSDT", "BBBUSDT"], zone: "UTC" },
});
const hash = rows => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
const temp = () => mkdtempSync(join(tmpdir(), "pit-minute-join-"));
const day = ms => new Date(ms).toISOString().slice(0, 10);
const active = (market, dateMs, symbol, opts = {}) => ({
  symbol, listedAtMs: opts.listedAtMs ?? dateMs - 100 * D,
  removedAtMs: opts.removedAtMs ?? null, halts: opts.halts ?? [],
  sourceId: "TEST_HISTORICAL_PIT_ARCHIVE_ONLY", evidenceSha256: SHA,
});
function fixture(market, dateMs = START) {
  const [a,b] = DETAILS[market].symbols;
  const memberships = [
    active(market,dateMs,a),
    active(market,dateMs,b,{ removedAtMs:dateMs+20*D }),
    active(market,dateMs,"DELISTED",{
      listedAtMs:dateMs-300*D, removedAtMs:dateMs-10*D,
    }),
  ];
  return {
    schemaVersion: "historical-venue-pit-roster-v1",
    sourceClass: "TEST_FIXTURE", testOnly: true,
    market, venue: DETAILS[market].venue,
    coverageStartMs: dateMs-400*D,
    coverageEndMs: dateMs+40*D,
    retrievedAtMs: dateMs+41*D,
    sourceId: "TEST_HISTORICAL_PIT_ARCHIVE_ONLY",
    allListedAndRemovedAttested: true, suspensionsAttested: true,
    relistedIdentifiersResolved: true,
    memberships, rawMembershipDigestSha256: rosterDigest(memberships),
  };
}
function update(f, rows) {
  return { ...f, memberships: rows,
    rawMembershipDigestSha256: rosterDigest(rows) };
}
function source(market, symbol, sessionStart, kind = null, count = 10) {
  const d = DETAILS[market], crypto = market.startsWith("CRYPTO_");
  const sourceId = "TEST_NATIVE_ORIGINAL_1M_SOURCE_ONLY";
  const minuteBars = Array.from({length:count},(_,i)=>({
    market, venue:d.venue, symbol, sourceId,
    timestampMs:sessionStart+i*M,
    availableAtMs:sessionStart+(i+1)*M,
    open:100+i, high:102+i, low:99+i,
    close:101+i, volume:10+i,
  }));
  return {
    market, venue:d.venue, symbol, sourceId,
    session:{
      startMs:sessionStart, endMs:sessionStart+(crypto?D:30*M),
      kind:kind ?? (crypto?"UTC_24H":"REGULAR"),
      timeZone:d.zone, calendarSourceId:"TEST_UNVERIFIED_DATED_SESSION",
    },
    minuteBars, sourceMinuteRowsSha256:hash(minuteBars),
    asOfMs:sessionStart+count*M,
  };
}
function calendar(market, sessions, tradingDate) {
  return { market, sessions:sessions.map(s=>({
    tradingDateLocal: tradingDate,
    startMs:s.session.startMs, endMs:s.session.endMs,
    kind:s.session.kind, timeZone:s.session.timeZone,
  })) };
}
function req(root, market, manifest, more = {}) {
  return {
    root, market, day:"2026-09-18", manifest,
    expectedRosterDigestSha256: manifest.rawMembershipDigestSha256,
    ...more,
  };
}

test("four venue PIT membership joins 1m source per symbol, never fills missing", async () => {
  for (const market of Object.keys(DETAILS)) {
    const root=temp(), manifest=fixture(market);
    try {
      const [a,b] = DETAILS[market].symbols;
      const s = market === "US_STOCK"
        ? Date.parse("2026-09-18T13:30:00Z") : START;
      const first=source(market,a,s);
      await store({root,source:first});
      const cal = market.endsWith("STOCK")
        ? calendar(market,[first],"2026-09-18") : null;
      const r=await audit(req(root,market,manifest,{stockCalendar:cal}));
      assert.equal(r.pitGateStatus,"TEST_FIXTURE_ONLY");
      assert.equal(r.sourceStatus,"TEST_FIXTURE_ONLY");
      assert.equal(r.expectedHistoricalActiveMembers,2);
      assert.equal(r.inspectedMemberCount,2);
      assert.equal(r.nextOffset,null);
      assert.equal(r.archivedMembers,1);
      assert.equal(r.missingSourceMembers,1);
      assert.equal(r.sourceLimitedMembers,1);
      assert.equal(r.sourceMinuteRows,10);
      assert.equal(r.missingSourcePlan.length,1);
      assert.equal(r.missingSourcePlan[0].symbol,b);
      assert.equal(r.missingSourcePlan[0].market,market);
      assert.equal(r.memberSourceStatuses[0].symbol,a);
      assert.equal(r.memberSourceStatuses[1].symbol,b);
      assert.equal(r.memberSourceStatuses[1].status,"MISSING_ORIGINAL_MINUTE_ARCHIVE");
      assert.equal(r.fullMarketOpportunityDenominatorVerified,false);
      assert.equal(r.actualMarketWideOpportunityCount,null);
      assert.equal(r.trueMarketWideRecall,null);
      assert.equal(r.actualFillCount,null);
      assert.equal(r.profitabilityProven,false);
      assert.equal(r.executionAuthority,"NONE");
      assert.equal(r.liveTrading,false);
    } finally { rmSync(root,{recursive:true,force:true}); }
  }
});

test("pagination audits every historical active member, never only a six-coin list",async()=>{
  const root=temp(), m=fixture("CRYPTO_SPOT");
  try{
    const [a,b]=DETAILS.CRYPTO_SPOT.symbols;
    await store({root,source:source("CRYPTO_SPOT",a,START)});
    const first=await audit(req(root,"CRYPTO_SPOT",m,{offset:0,limit:1}));
    assert.equal(first.inspectedMemberCount,1);
    assert.equal(first.nextOffset,1);
    assert.equal(first.completeRequestedMarketDayChecked,false);
    assert.equal(first.archivedMembers,1);
    const next=await audit(req(root,"CRYPTO_SPOT",m,{offset:1,limit:1}));
    assert.equal(next.inspectedMemberCount,1);
    assert.equal(next.nextOffset,null);
    assert.equal(next.expectedHistoricalActiveMembers,2);
    assert.equal(next.completeRequestedMarketDayChecked,false);
    assert.deepEqual(next.missingSourcePlan.map(x=>x.symbol),[b]);
    const full=await audit(req(root,"CRYPTO_SPOT",m,{offset:0,limit:20}));
    assert.equal(full.completeRequestedMarketDayChecked,true);
    assert.equal(full.status,"INCOMPLETE_PIT_MINUTE_SOURCE_CHUNK");
    const outside=await audit(req(root,"CRYPTO_SPOT",m,{offset:2}));
    assert.equal(outside.reason,"PIT_ACTIVE_MEMBER_CURSOR_OUT_OF_BOUNDS");
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("no roster, wrong digest, current survivorship and incorrect venue block",async()=>{
  const root=temp(),m=fixture("CRYPTO_FUTURES");
  try{
    const failed=await audit({
      root,market:"CRYPTO_FUTURES",day:"2026-09-18",
      expectedRosterDigestSha256:m.rawMembershipDigestSha256,
    });
    assert.equal(failed.status,"BLOCKED_DATA");
    assert.equal(failed.reason,"PIT_ROSTER_DIGEST_LEASE_MISMATCH");
    const lease=await audit(req(root,"CRYPTO_FUTURES",m,{
      expectedRosterDigestSha256:"f".repeat(64),
    }));
    assert.equal(lease.reason,"PIT_ROSTER_DIGEST_LEASE_MISMATCH");
    const survivor=await audit(req(root,"CRYPTO_FUTURES",{
      ...m,sourceClass:"CURRENT_SNAPSHOT",
    }));
    assert.equal(survivor.reason,"PIT_CURRENT_SURVIVOR_LIST_NOT_HISTORICAL_PIT");
    const invalidVenue=await audit(req(root,"CRYPTO_FUTURES",{
      ...m,venue:"BINANCE_USDT",
    }));
    assert.equal(invalidVenue.reason,"PIT_PIT_ARCHIVE_SOURCE_ATTESTATION_INVALID");
    await assert.rejects(()=>audit(req(root,"CRYPTO_FUTURES",m,{
      limit:21,
    })),/PIT_MINUTE_JOIN_ARGUMENT_INVALID/);
    await assert.rejects(()=>audit(req(root,"CRYPTO_FUTURES",m,{
      day:"2026-02-30",
    })),/RESEARCH_WINDOW_DATES_INVALID/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("same ticker removed/relisted within date is blocked, not collapsed",async()=>{
  const root=temp(),m=fixture("CRYPTO_SPOT");
  try{
    const first={...m.memberships[0],removedAtMs:START+2*M};
    const second={...m.memberships[0],
      listedAtMs:START+3*M,removedAtMs:START+D-2*M};
    const changed=update(m,[first,second,...m.memberships.slice(1)]);
    const r=await audit(req(root,"CRYPTO_SPOT",changed));
    assert.equal(r.reason,"PIT_SAME_DAY_TICKER_REUSE_NEEDS_STABLE_ID");
    assert.equal(r.trueMarketWideRecall,null);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("intraday listing/removal or historical halt blocks session, not zero event",async()=>{
  const root=temp(),m=fixture("CRYPTO_SPOT");
  try{
    const fresh={...m.memberships[0],listedAtMs:START+3*M};
    const stop1=update(m,[fresh,...m.memberships.slice(1)]);
    const r=await audit(req(root,"CRYPTO_SPOT",stop1));
    assert.equal(r.lifecycleBlockedMembers,1);
    assert.equal(r.memberSourceStatuses[0].status,"BLOCKED_PIT_PARTIAL_LIFECYCLE");
    assert.equal(r.memberSourceStatuses[0].reason,"PIT_LISTING_OR_DELISTING_CROSSES_SESSION");
    assert.equal(r.missingSourceMembers,1);
    const halted={...m.memberships[0],halts:[{
      startMs:START+5*M,endMs:START+10*M,reason:"EXCHANGE_HALT",
    }]};
    const stop2=update(m,[halted,...m.memberships.slice(1)]);
    const h=await audit(req(root,"CRYPTO_SPOT",stop2));
    assert.equal(h.lifecycleBlockedMembers,1);
    assert.equal(h.memberSourceStatuses[0].reason,"PIT_HALT_CROSSES_SESSION");
    assert.equal(h.actualMarketWideOpportunityCount,null);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("KR 08:30 premarket at UTC previous date and 09:00 regular stay separate",async()=>{
  const root=temp(),m=fixture("KR_STOCK");
  try{
    const symbol=DETAILS.KR_STOCK.symbols[0];
    const pre=source("KR_STOCK",symbol,START-30*M,"PREMARKET");
    const reg=source("KR_STOCK",symbol,START,"REGULAR");
    await store({root,source:pre});
    await store({root,source:reg});
    const r=await audit(req(root,"KR_STOCK",m,{
      stockCalendar:calendar("KR_STOCK",[pre,reg],"2026-09-18"),
    }));
    assert.equal(r.dateBasis,"EXCHANGE_LOCAL_TRADING_DATE");
    assert.equal(r.archivedMembers,1);
    assert.equal(r.sourceSessionsCovered,2);
    assert.equal(r.missingSourceMembers,1);
    assert.equal(r.sourceMinuteRows,20);
    assert.equal(r.expectedHistoricalActiveMembers,2);
    assert.equal(r.historicalPITAndMinuteSourcesIndependentlyAuthenticated,false);
    const badCal={market:"KR_STOCK",sessions:[{
      tradingDateLocal:"2026-09-17",startMs:pre.session.startMs,
      endMs:pre.session.endMs,kind:"PREMARKET",timeZone:"Asia/Seoul",
    }]};
    await assert.rejects(()=>audit(req(root,"KR_STOCK",m,{
      stockCalendar:badCal,
    })),/MINUTE_WINDOW_STOCK_CALENDAR_INVALID/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("US 09:30 winter EST / summer EDT date-specific session evidence",async()=>{
  const root=temp();
  try{
    const dates=[
      ["2026-01-12",Date.parse("2026-01-12T14:30:00Z")],
      ["2026-09-18",Date.parse("2026-09-18T13:30:00Z")],
    ];
    for(const [local,at] of dates){
      const d=Date.parse(local+"T00:00:00Z");
      const m=fixture("US_STOCK",d);
      const s=source("US_STOCK","AAPL",at);
      await store({root,source:s});
      const r=await audit(req(root,"US_STOCK",m,{
        day:local,stockCalendar:calendar("US_STOCK",[s],local),
      }));
      assert.equal(r.expectedHistoricalActiveMembers,2);
      assert.equal(r.archivedMembers,1);
      assert.equal(r.sourceMinuteRows,10);
      assert.equal(r.dateBasis,"EXCHANGE_LOCAL_TRADING_DATE");
      assert.equal(r.trueMarketWideRecall,null);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("stock cannot pretend sessions exist and crypto rejects stock calendar",async()=>{
  const root=temp(),m=fixture("KR_STOCK");
  try{
    const absent=await audit(req(root,"KR_STOCK",m));
    assert.equal(absent.reason,"STOCK_DATED_SESSION_CALENDAR_REQUIRED");
    const empty=await audit(req(root,"KR_STOCK",m,{
      stockCalendar:{market:"KR_STOCK",sessions:[]},
    }));
    assert.equal(empty.reason,"STOCK_DATED_SESSION_CALENDAR_EMPTY");
    const spot=fixture("CRYPTO_SPOT");
    const bad=await audit(req(root,"CRYPTO_SPOT",spot,{
      stockCalendar:{market:"CRYPTO_SPOT",sessions:[]},
    }));
    assert.equal(bad.reason,"CRYPTO_STOCK_CALENDAR_UNEXPECTED");
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("two native source revisions don't silently choose a convenient price",async()=>{
  const root=temp(),m=fixture("CRYPTO_FUTURES"),symbol="AAAUSDT";
  try{
    const a=source("CRYPTO_FUTURES",symbol,START);
    const b=structuredClone(a);b.minuteBars[0].high=500;
    b.sourceMinuteRowsSha256=hash(b.minuteBars);
    await store({root,source:a});await store({root,source:b});
    const r=await audit(req(root,"CRYPTO_FUTURES",m));
    assert.equal(r.revisedSourceMembers,1);
    assert.equal(r.archivedMembers,0);
    assert.equal(r.missingSourcePlan.length,1); // only the other missing symbol
    assert.equal(r.memberSourceStatuses[0].status,"SOURCE_REVISION_CONFLICT");
    assert.equal(r.trueMarketWideRecall,null);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("private file CLI creates one bounded report, rejects overwrites and symlinks",async()=>{
  const root=temp(),m=fixture("CRYPTO_SPOT");
  try{
    const manifestPath=join(root,"source-manifest.json"),
      output=join(root,"coverage-0.json");
    writeFileSync(manifestPath,JSON.stringify(m),{mode:0o600});
    const params=["--market","CRYPTO_SPOT","--day","2026-09-18",
      "--manifest",manifestPath,"--expected-roster-sha",
      m.rawMembershipDigestSha256,"--root",root,
      "--offset","0","--limit","1","--output",output];
    const r=await runCli(parseCli(params));
    assert.equal(r.inspectedMemberCount,1);
    assert.equal(r.nextOffset,1);
    assert.equal(r.executionAuthority,"NONE");
    assert.equal(statSync(output).mode&0o077,0);
    const saved=JSON.parse(readFileSync(output,"utf8"));
    assert.equal(saved.memberSourceStatuses.length,1);
    assert.equal(saved.fullMarketOpportunityDenominatorVerified,false);
    await assert.rejects(()=>runCli(parseCli(params)),
      /PIT_MINUTE_OUTPUT_ALREADY_EXISTS/);
    assert.throws(()=>parseCli([...params,"--limit","1"]),
      /PIT_MINUTE_CLI_OPTION_INVALID/);
    const link=root+"-link";
    symlinkSync(root,link,"dir");
    try{
      const dangerous=params.map(x=>x===output?join(link,"leak.json"):x);
      await assert.rejects(()=>runCli(parseCli(dangerous)),
        /PIT_MINUTE_SYMLINK_PARENT_FORBIDDEN/);
    }finally{rmSync(link,{force:true});}
  }finally{rmSync(root,{recursive:true,force:true});}
});


test("PIT minute join accepts multi-year stock sessions without mixing another local date",async()=>{
  for(const market of ["KR_STOCK","US_STOCK"]){
    const root=temp(),m=fixture(market);
    try{
      const start=market==="KR_STOCK"?START:Date.parse("2026-09-18T13:30:00Z");
      const original=source(market,DETAILS[market].symbols[0],start);
      const cal=calendar(market,[original],"2026-09-18");
      const extra=(date,iso)=>{
        const startMs=Date.parse(iso);
        return {tradingDateLocal:date,startMs,endMs:startMs+30*M,
          kind:"REGULAR",timeZone:DETAILS[market].zone};
      };
      cal.sessions.unshift(extra("2015-01-05",
        market==="KR_STOCK"?"2015-01-05T00:00:00Z":"2015-01-05T14:30:00Z"));
      cal.sessions.push(extra("2028-01-03",
        market==="KR_STOCK"?"2028-01-03T00:00:00Z":"2028-01-03T14:30:00Z"));
      const result=await audit(req(root,market,m,{stockCalendar:cal}));
      assert.equal(result.inspectedMemberCount,2);
      assert.equal(result.expectedHistoricalActiveMembers,2);
      assert.equal(result.memberSourceStatuses[0].sourceSessionCount,1);
      assert.equal(result.executionAuthority,"NONE");
    }finally{rmSync(root,{recursive:true,force:true});}
  }
});
