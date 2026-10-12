import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setImmediate as scheduleImmediate,clearImmediate} from "node:timers";
import {setImmediate as yieldImmediate} from "node:timers/promises";
import {persistResearchMinuteSessionV1 as save} from "../src/research-minute-archive-v1.js";
import {normalizePublicNativeCryptoRosterV1} from "../src/public-native-crypto-roster-v1.js";
import {digestPITMembershipRowsV1} from "../src/historical-pit-venue-universe-gate-v1.js";
import {runFourMarketOriginalMinuteReplayV1 as replay} from "../src/four-market-original-minute-replay-v1.js";
import { importPublicMinutePrewireIntoNativeArchiveV1 as importPrewire }
  from "../src/research-public-minute-prewire-bridge-v1.js";
import {runFourMarketOriginalMinutePeriodV1 as period} from "../src/four-market-original-minute-period-v1.js";
import {reviewOriginalMinuteForCanonicalPaperV1 as review} from "../src/four-market-original-minute-candidate-review-v1.js";

const DAY=86_400_000,MIN=60_000,D=Date.parse("2025-01-01T00:00:00Z");
const OBSERVED=D+40*DAY,ASOF=D+50*DAY;
const CURRENT="CURRENT_PROVIDER_ROSTER_SOURCE_ONLY";
const POLICIES={
  CRYPTO_SPOT:{venue:"UPBIT_KRW",symbol:"KRW-BTC",sourceId:"UPBIT_PUBLIC_REST_RETROSPECTIVE_1M"},
  CRYPTO_FUTURES:{venue:"BITGET_USDT_FUTURES",symbol:"BTCUSDT",sourceId:"BITGET_PUBLIC_V2_RETROSPECTIVE_1M"},
};
const hash=value=>createHash("sha256").update(value).digest("hex");
const date=ms=>new Date(ms).toISOString().slice(0,10);
let networkCalls=0;
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{networkCalls++;throw new Error("CURRENT_SOURCE_TEST_NETWORK_FORBIDDEN");};
test.after(()=>{globalThis.fetch=originalFetch;assert.equal(networkCalls,0);});
async function temporary(t){
  const root=await mkdtemp(join(tmpdir(),"original-minute-current-source-"));
  t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
function capture(market="CRYPTO_FUTURES",symbols=[POLICIES[market].symbol]){
  const payload=market==="CRYPTO_SPOT"
    ?symbols.map(symbol=>({market:symbol,market_event:{warning:false,caution:{}}}))
    :{code:"00000",data:symbols.map(symbol=>({symbol,baseCoin:symbol.slice(0,-4),
      quoteCoin:"USDT",symbolStatus:"normal",symbolType:"perpetual",isRwa:"NO"}))};
  const rawResponseText=JSON.stringify(payload),rawResponseSha256=hash(rawResponseText);
  const roster=normalizePublicNativeCryptoRosterV1({market,payload,
    observedAtMs:OBSERVED,rawResponseSha256});
  return {status:"CURRENT_SOURCE_ROSTER_CAPTURED_ONLY",roster,
    rawResponseText,rawResponseSha256,requestStartedAtMs:OBSERVED-10,
    responseReceivedAtMs:OBSERVED,httpStatus:200};
}
function source(market="CRYPTO_FUTURES",symbol=POLICIES[market].symbol,
  dayIndex=0,{missing=false,sourceId=POLICIES[market].sourceId}={}){
  const start=D+dayIndex*DAY,venue=POLICIES[market].venue;
  const minuteBars=Array.from({length:1440},(_,i)=>{
    const globalIndex=dayIndex*1440+i;
    const open=100+0.004*globalIndex+1.2*Math.sin(globalIndex/17);
    const close=100+0.004*(globalIndex+1)+1.2*Math.sin((globalIndex+1)/17);
    return {market,venue,symbol,sourceId,timestampMs:start+i*MIN,
      availableAtMs:OBSERVED,open,close,high:Math.max(open,close)+0.03,
      low:Math.min(open,close)-0.03,volume:100+i};
  });
  if(missing)minuteBars.splice(17,1);
  return {market,venue,symbol,sourceId,
    session:{startMs:start,endMs:start+DAY,kind:"UTC_24H",timeZone:"UTC",
      calendarSourceId:"RETROSPECTIVE_UTC_DAY_NOT_INDEPENDENT_PIT_PROOF"},
    minuteBars,sourceMinuteRowsSha256:hash(JSON.stringify(minuteBars)),asOfMs:ASOF};
}
function request(root,market="CRYPTO_FUTURES",symbol=POLICIES[market].symbol,extra={}){
  const currentRosterCapture=capture(market,[symbol]);
  return {root,market,symbol,evidenceScope:CURRENT,currentRosterCapture,
    expectedCurrentRosterDigestSha256:currentRosterCapture.roster.rosterDigestSha256,
    researchWindow:{startDate:date(D),endDate:date(D)},asOfMs:ASOF,
    timeframe:"5m",direction:"LONG",initialCapitalKRW:1_000_000,
    leverage:market==="CRYPTO_FUTURES"?3:1,riskFraction:0.01,
    fxRateKRWPerQuote:market==="CRYPTO_FUTURES"?1300:null,
    strategy:{kind:"EMA_TREND",fast:3,slow:9,stopPercent:0.8,targetPercent:1.4},
    costModel:{entryFeeRate:0.0001,exitFeeRate:0.0001,spreadRate:0.0001,
      slippageRate:0.0001,latencyRate:0,taxRate:0,fundingRatePerSession:0},
    ...extra};
}
async function retain(root,native){
  const stored=await save({root,source:native});
  return {date:date(native.session.startMs),startMs:native.session.startMs,
    endMs:native.session.endMs,kind:"UTC_24H",zone:"UTC",
    sourceDigestSha256:stored.sourceDigestSha256};
}
function pitManifest(market,symbol){
  const memberships=[{symbol,listedAtMs:D-100*DAY,removedAtMs:null,halts:[],
    sourceId:"TEST_EXPLICIT_HISTORICAL_ROSTER",evidenceSha256:"a".repeat(64)},
  {symbol:"DELISTED",listedAtMs:D-300*DAY,removedAtMs:D-200*DAY,halts:[],
    sourceId:"TEST_EXPLICIT_HISTORICAL_ROSTER",evidenceSha256:"a".repeat(64)}];
  return {schemaVersion:"historical-venue-pit-roster-v1",market,
    venue:POLICIES[market].venue,sourceClass:"TEST_FIXTURE",testOnly:true,
    sourceId:"TEST_EXPLICIT_HISTORICAL_ROSTER",coverageStartMs:D-400*DAY,
    coverageEndMs:D+30*DAY,retrievedAtMs:ASOF,
    allListedAndRemovedAttested:true,suspensionsAttested:true,
    relistedIdentifiersResolved:true,memberships,
    rawMembershipDigestSha256:digestPITMembershipRowsV1(memberships)};
}
function assertNoAuthority(value){
  assert.equal(value.profitabilityProven,false);
  assert.equal(value.executionAuthority,"NONE");
  assert.equal(value.paperAdmissionAllowed,false);
  assert.equal(value.actualFillCount,null);
  assert.equal(value.netProfitPct,null);
  assert.equal(value.trueMarketWideRecall,null);
  assert.equal(value.OOSPassCount,0);
  assert.equal(value.realOrders,false);
}
function assertCurrent(value,input){
  assertNoAuthority(value);
  assert.equal(value.evidenceScope,CURRENT);
  assert.equal(value.sourceOnlyMode,true);
  assert.equal(value.currentRosterDigestSha256,input.expectedCurrentRosterDigestSha256);
  assert.equal(value.currentRosterObservedAtMs,OBSERVED);
  assert.equal(value.historicalPITRosterChecked,false);
  assert.equal(value.historicalMemberLifespanSelfAttestedNotIndependentlyVerified,false);
  assert.equal(value.historicalTradingAvailabilityVerified,false);
  assert.equal(value.sessionClosePolicy,"CLOSE_EACH_SOURCE_SESSION");
}

test("current captures cannot replace default historical PIT evidence for ASCII or Han identities",async t=>{
  const root=await temporary(t),input=request(root);
  await assert.rejects(replay({...input,evidenceScope:undefined}),
    /CURRENT_ROSTER_REQUIRES_EXPLICIT_SOURCE_SCOPE/);
  const {currentRosterCapture,expectedCurrentRosterDigestSha256,evidenceScope,...legacy}=input;
  await assert.rejects(replay({...legacy,manifest:currentRosterCapture.roster}),
    /PRIVATE_REPLAY_HISTORIC_PIT_ROSTER_REQUIRED/);
  await assert.rejects(replay({...legacy,manifest:undefined}),
    /PRIVATE_REPLAY_HISTORIC_PIT_ROSTER_REQUIRED/);
  await assert.rejects(replay({...legacy,symbol:"龙虾USDT",manifest:currentRosterCapture.roster}),
    /PRIVATE_REPLAY_HISTORIC_PIT_ROSTER_REQUIRED/);
  const historicHan=await replay({...legacy,symbol:"龙虾USDT",
    manifest:pitManifest("CRYPTO_FUTURES","龙虾USDT")});
  assert.equal(historicHan.status,"BLOCKED_DATA");
  assert.equal(historicHan.evidenceScope,"HISTORICAL_PIT_ROSTER");
  assert.equal(historicHan.sourceOnlyMode,false);
  assert.equal(historicHan.sourceMinuteRowsRead,0);
  assert.equal(historicHan.modeledReturnPercent,null);
  assertNoAuthority(historicHan);
  await assert.rejects(period({...input,evidenceScope:"SOURCE_ATTESTED_PIT_COHORT_ONLY"}),
    /PRIVATE_REPLAY_EVIDENCE_SCOPE_INVALID/);
});

test("dated historical Han fixture replays exact native archive but cannot establish real PIT or OOS",async t=>{
  const root=await temporary(t),market="CRYPTO_FUTURES",symbol="龙虾USDT";
  const session=await retain(root,source(market,symbol));
  const {currentRosterCapture,expectedCurrentRosterDigestSha256,evidenceScope,...legacy}=
    request(root,market,symbol);
  const result=await replay({...legacy,manifest:pitManifest(market,symbol),sessionSources:[session]});
  assert.equal(result.status,"RETROSPECTIVE_SOURCE_ONLY_STRATEGY_DIAGNOSTIC");
  assert.equal(result.symbol,symbol);
  assert.equal(result.evidenceScope,"HISTORICAL_PIT_ROSTER");
  assert.equal(result.fixtureOnly,true);
  assert.equal(result.sourceMinuteRowsRead,1440);
  assert.equal(result.originalHistoricalScannerAvailabilityVerified,false);
  assertNoAuthority(result);
});

test("complete current crypto archives reuse LONG/SHORT replay and preserve all Han contract names",async t=>{
  const root=await temporary(t);
  for(const [market,symbol,direction] of [
    ["CRYPTO_SPOT","KRW-BTC","LONG"],
    ["CRYPTO_FUTURES","BTCUSDT","LONG"],
    ["CRYPTO_FUTURES","BTCUSDT","SHORT"],
    ["CRYPTO_FUTURES","龙虾USDT","LONG"],
    ["CRYPTO_FUTURES","牛来USDT","SHORT"],
    ["CRYPTO_FUTURES","哈基米USDT","LONG"],
  ]){
    const session=await retain(root,source(market,symbol));
    const input=request(root,market,symbol,{direction});
    const raw=await replay({...input,sessionSources:[session]});
    const result=await period(input);
    assert.equal(raw.status,"RETROSPECTIVE_SOURCE_ONLY_STRATEGY_DIAGNOSTIC");
    assert.equal(result.status,"SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY");
    assertCurrent(result,input);
    assert.equal(result.symbol,symbol);
    assert.equal(result.modeledNetPnlKRW,raw.modeledNetPnlKRW);
    assert.equal(result.sourceMinuteRowsRead,1440);
    assert.equal(result.verifiedNativeMinuteSessions,1);
    assert.ok(result.modeledTradeCount>0);
    assert.equal(result.fixtureOnly,false);
    assert.equal(result.historicalLifecycleExcludedTradingDates,null);
    assert.match(result.sourceSessionIndexDigestSha256,/^[0-9a-f]{64}$/u);
    assert.match(result.sourceModelDigestSha256,/^[0-9a-f]{64}$/u);
  }
  const cashShort=await period(request(root,"CRYPTO_SPOT","KRW-BTC",{direction:"SHORT"}));
  assert.equal(cashShort.status,"BLOCKED_DATA");
  assert.equal(cashShort.modeledReturnPercent,null);
  await assert.rejects(replay(request(root,"CRYPTO_FUTURES","BTCUSDT",
    {riskFraction:Number.NaN})),/PRIVATE_REPLAY_MARKET_OR_RISK_POLICY_INVALID/);
});

test("current scope rejects mixed historical claims, stock modes, changed SHA and forged envelopes",async t=>{
  const root=await temporary(t),input=request(root);
  const altered=structuredClone(input.currentRosterCapture);
  altered.rawResponseText="[]";
  const wrongVenue=structuredClone(input.currentRosterCapture);
  wrongVenue.roster.venue="UPBIT_KRW";
  const unknownMember={...input,symbol:"ETHUSDT"};
  for(const override of [
    {manifest:pitManifest("CRYPTO_FUTURES","BTCUSDT")},
    {stockCalendar:{market:"CRYPTO_FUTURES",tradingDates:[]}},
    {market:"KR_STOCK",symbol:"005930"},
    {market:"US_STOCK",symbol:"AAPL"},
    {expectedCurrentRosterDigestSha256:"0".repeat(64)},
    {currentRosterCapture:altered},{currentRosterCapture:wrongVenue},
    {currentRosterCapture:input.currentRosterCapture.roster},
    {asOfMs:OBSERVED-1},unknownMember,
  ])await assert.rejects(period({...input,...override}),/PRIVATE_REPLAY_CURRENT_/);
  await assert.rejects(period({...input,evidenceScope:null}),/EVIDENCE_SCOPE_INVALID/);
  await assert.rejects(replay({...input,symbol:"BTCUSDT/../ETHUSDT"}),/CURRENT_SOURCE_SCOPE_INVALID/);
});

test("current source lineage rejects a different native provider even with valid OHLCV and archive hashes",async t=>{
  const root=await temporary(t),input=request(root);
  const session=await retain(root,source("CRYPTO_FUTURES","BTCUSDT",0,
    {sourceId:"UNVERIFIED_OTHER_CANDLE_PROVIDER"}));
  const raw=await replay({...input,sessionSources:[session]});
  const result=await period(input);
  assert.equal(raw.reason,"CURRENT_SOURCE_NATIVE_PROVIDER_OR_VENUE_MISMATCH");
  assert.equal(result.reason,raw.reason);
  assert.equal(result.status,"BLOCKED_DATA");
  assert.equal(result.modeledNetPnlKRW,null);
  assertCurrent(result,input);
});

test("partial minutes and missing selected dates remain blockers, including a ten-year request",async t=>{
  const partialRoot=await temporary(t);
  const partialInput=request(partialRoot,"CRYPTO_SPOT");
  const session=await retain(partialRoot,source("CRYPTO_SPOT","KRW-BTC",0,{missing:true}));
  const incomplete=await period(partialInput);
  assert.equal(incomplete.reason,"ORIGINAL_PERIOD_SOURCE_HAS_UNVERIFIED_MINUTE_GAPS");
  assert.equal(incomplete.blockedDate,date(D));
  assert.equal(incomplete.modeledReturnPercent,null);
  assert.equal((await replay({...partialInput,sessionSources:[session]})).reason,
    "ORIGINAL_ONE_MINUTE_SESSION_PARTIAL_OR_UNAVAILABLE");
  const root=await temporary(t),input=request(root);
  await retain(root,source());
  for(const researchWindow of [
    {startDate:date(D),endDate:date(D+DAY)},
    {startDate:"2015-01-01",endDate:date(D)},
  ]){
    const result=await period({...input,researchWindow});
    const days=(Date.parse(researchWindow.endDate+"T00:00:00Z")
      -Date.parse(researchWindow.startDate+"T00:00:00Z"))/DAY+1;
    assert.equal(result.status,"BLOCKED_DATA");
    assert.equal(result.reason,"CURRENT_SOURCE_SELECTED_UTC_DATES_MISSING");
    assert.equal(result.missingSourceDays,days-1);
    assert.equal(result.requestedUtcDayCount,days);
    assert.equal(result.blockedDatesPreview.length,Math.min(30,days-1));
    assert.equal(result.selectedStartDate,researchWindow.startDate);
    assert.equal(result.selectedEndDate,researchWindow.endDate);
    assert.equal(result.modeledTradeCount,null);
    assert.equal(result.modeledNetPnlKRW,null);
    assertCurrent(result,input);
  }
});

test("source and model fingerprints bind the current roster snapshot while canonical review stays closed",async t=>{
  const root=await temporary(t),input=request(root);
  await retain(root,source());
  const first=await period(input);
  const revisedCapture=capture("CRYPTO_FUTURES",["BTCUSDT","ETHUSDT"]);
  const second=await period({...input,currentRosterCapture:revisedCapture,
    expectedCurrentRosterDigestSha256:revisedCapture.roster.rosterDigestSha256});
  assert.equal(first.modeledNetPnlKRW,second.modeledNetPnlKRW);
  for(const key of ["sourceSessionIndexDigestSha256","sourceDigestChainSha256",
    "sourceLineageSha256","sourceModelDigestSha256"])
    assert.notEqual(first[key],second[key],key);
  const verdict=review({market:"CRYPTO_FUTURES",symbol:"BTCUSDT",periodResult:first,nowMs:ASOF});
  assert.equal(verdict.status,"RESEARCH_HOLD");
  assert.equal(verdict.paperCandidate,null);
  assert.equal(verdict.paperAdmissionAllowed,false);
  assert.equal(verdict.profitabilityProven,false);
});

test("over 20000 native minutes preserve one EMA/capital state across fifteen sessions",async t=>{
  const root=await temporary(t),sessions=[];
  for(let i=0;i<15;i++)sessions.push(await retain(root,source("CRYPTO_FUTURES","BTCUSDT",i)));
  const input=request(root,"CRYPTO_FUTURES","BTCUSDT",{
    timeframe:"1m",researchWindow:{startDate:date(D),endDate:date(D+14*DAY)},
  });
  const whole=await period(input);
  const direct=await replay({...input,sessionSources:sessions});
  const {evidenceScope,currentRosterCapture,expectedCurrentRosterDigestSha256,...legacy}=input;
  const oldPath=await replay({...legacy,sessionSources:sessions,
    manifest:pitManifest("CRYPTO_FUTURES","BTCUSDT")});
  assert.equal(whole.status,"SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY");
  assert.equal(whole.sourceMinuteRowsRead,21_600);
  assert.equal(whole.derivedBarsRead,21_600);
  assert.equal(whole.sourceSessionsRead,15);
  assert.equal(whole.verifiedNativeMinuteSessions,15);
  for(const key of ["modeledTradeCount","modeledNetPnlKRW","modeledCostKRW",
    "modeledMaximumDrawdownPercent","paperReserveModeledKRW","paperCapitalModeledKRW"]){
    assert.equal(whole[key],direct[key],key);
    assert.equal(whole[key],oldPath[key],key);
  }
  assert.ok(whole.paperReserveModeledKRW>0);
  assert.equal(oldPath.historicalPITRosterChecked,true);
  assert.equal(oldPath.historicalMemberLifespanSelfAttestedNotIndependentlyVerified,true);
  let dailyResetPnl=0;
  for(const session of sessions){
    const single=await replay({...input,sessionSources:[session],
      researchWindow:{startDate:session.date,endDate:session.date}});
    dailyResetPnl+=single.modeledNetPnlKRW;
  }
  assert.ok(Math.abs(dailyResetPnl-whole.modeledNetPnlKRW)>1,
    "a whole-period state must not become a sum of independently reset daily models");
  assertCurrent(whole,input);
});

test("cancelled or expired index/replay requests return null models and retain their exact stop reason",async t=>{
  const root=await temporary(t),input=request(root);
  const controller=new AbortController();controller.abort(new Error("DO_NOT_REFLECT_ABORT_DETAIL"));
  for(const run of [period,replay]){
    const cancelled=await run({...input,signal:controller.signal});
    assert.equal(cancelled.reason,"ORIGINAL_MINUTE_REPLAY_CANCELLED");
    assert.equal(cancelled.modeledTradeCount,null);
    assert.equal(cancelled.modeledCostKRW,null);
    assertCurrent(cancelled,input);
    const expired=await run({...input,deadlineMs:Date.now()-1});
    assert.equal(expired.reason,"ORIGINAL_MINUTE_REPLAY_TIME_BUDGET_EXCEEDED");
    assert.equal(expired.modeledReturnPercent,null);
  }
  await assert.rejects(period({...input,signal:{aborted:false}}),/EXECUTION_CONTROL_INVALID/);
  await assert.rejects(period({...input,deadlineMs:Infinity}),/EXECUTION_CONTROL_INVALID/);
});

test("an abort queued during a long bar loop runs at its cooperative yield and leaves no continuing replay",async t=>{
  const root=await temporary(t),session=await retain(root,source());
  const controller=new AbortController();let polls=0,scheduled;
  const readAborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,"aborted").get;
  Object.defineProperty(controller.signal,"aborted",{get(){
    polls++;
    if(polls===100)scheduled=scheduleImmediate(()=>controller.abort());
    return readAborted.call(this);
  }});
  t.after(()=>clearImmediate(scheduled));
  const result=await replay(request(root,"CRYPTO_FUTURES","BTCUSDT",{
    timeframe:"1m",sessionSources:[session],signal:controller.signal,
  }));
  assert.equal(result.reason,"ORIGINAL_MINUTE_REPLAY_CANCELLED");
  assert.ok(result.derivedBarsRead>0&&result.derivedBarsRead<=256);
  assert.equal(result.sourceSessionsRead,0);
  assert.equal(result.modeledTradeCount,null);
  assert.equal(result.paperCapitalModeledKRW,null);
  const stoppedAt=polls;
  await yieldImmediate();await yieldImmediate();
  assert.equal(polls,stoppedAt,"returning a cancellation must stop the underlying bar loop");
});

test("a deadline reached inside replay stops the computation and the period preserves deadline reasons",async t=>{
  const root=await temporary(t),session=await retain(root,source());
  const startNow=Date.now();let clockReads=0;
  t.mock.method(Date,"now",()=>startNow+(++clockReads>=100?2:0));
  const result=await replay(request(root,"CRYPTO_FUTURES","BTCUSDT",{
    timeframe:"1m",sessionSources:[session],deadlineMs:startNow+1,
  }));
  assert.equal(result.reason,"ORIGINAL_MINUTE_REPLAY_TIME_BUDGET_EXCEEDED");
  assert.ok(result.derivedBarsRead>0&&result.derivedBarsRead<256);
  assert.equal(result.modeledTradeCount,null);
  assert.equal(result.modeledNetPnlKRW,null);
  clockReads=0;
  const wrapped=await period(request(root,"CRYPTO_FUTURES","BTCUSDT",{
    timeframe:"1m",deadlineMs:startNow+1,
  }));
  assert.equal(wrapped.reason,"ORIGINAL_MINUTE_REPLAY_TIME_BUDGET_EXCEEDED");
  assert.equal(wrapped.modeledTradeCount,null);
  assert.equal(wrapped.modeledNetPnlKRW,null);
});

test("sealed #1859 Upbit BTC collector source replays against verified KRW-BTC current roster without alias price rewrite", async t => {
  const root = await temporary(t);
  const market = "CRYPTO_SPOT", collectorSymbol = "BTC";
  const native = source(market, collectorSymbol, 0,
    { sourceId: "UPBIT_PUBLIC_1M" });
  native.session = { ...native.session,
    calendarSourceId: "CRYPTO_UTC_DAY_SOURCE_ONLY" };
  const pinnedSha = "a".repeat(40);
  const prewire = {
    contract: "research-original-minute-backtester-prewire/v1",
    status: "RETROSPECTIVE_RESEARCH_MODEL_INPUT_ONLY",
    market, symbol: collectorSymbol, day: date(D),
    modelInput: native, sourceMinuteDigest: native.sourceMinuteRowsSha256,
    sourceMinuteRows: 1440,
    oldestActualReceiptMs: OBSERVED, newestActualReceiptMs: OBSERVED,
    sourceArchiveDigests: Array.from({length:12}, (_, i) => hash("fixture-source-page-"+i)),
    sourceArchiveProducerShas: [pinnedSha],
    metadata: { sourceMinutePages: 12, missingOneMinuteSlots: 0,
      allSourceSlotsObserved: true, sourceDigestMatchesCanonicalModel: true,
      retrospectiveTimeCannotBeUsedAsScannerTime: true,
      independentMarketLicenseOrPITProven: false },
    executionAuthority: "NONE", providerGETCount: 0, archiveFilesWritten: 0,
    profitabilityProven: false, historicalPITProven: false,
    independentOosProven: false, fullCostProfitabilityProven: false,
    paperAdmissionAllowed: false,
  };
  const imported = await importPrewire({ enabled: true, operatorApproved: true,
    prewire, archiveRoot: root, expectedResearchSha: pinnedSha });
  assert.equal(imported.status, "IMPORTED_RETROSPECTIVE_SOURCE_ONLY");
  assert.equal(imported.nativeArchivedMinuteRows, 1440);
  const input = request(root, market, "KRW-BTC");
  const replayInput = { ...input, symbol: collectorSymbol,
    sessionSources: [{ date: date(D), startMs:D, endMs:D+DAY,
      kind:"UTC_24H", zone:"UTC", sourceDigestSha256:imported.nativeImmutableArchiveDigest }] };
  const result = await replay(replayInput);
  assert.equal(result.status, "RETROSPECTIVE_SOURCE_ONLY_STRATEGY_DIAGNOSTIC");
  assert.equal(result.sourceMinuteRowsRead, 1440);
  assert.equal(result.symbol, "BTC");
  assertNoAuthority(result);
  const fullPeriod = await period({ ...input, symbol: collectorSymbol });
  assert.equal(fullPeriod.status, "SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY");
  assert.equal(fullPeriod.verifiedNativeMinuteSessions, 1);
  assert.equal(fullPeriod.sourceMinuteRowsRead, 1440);
  assertNoAuthority(fullPeriod);
  await assert.rejects(replay({ ...replayInput, symbol:"ETH" }),
    /CURRENT_ROSTER_CAPTURE_OR_MEMBER_INVALID/);
});

test("sealed #1859 Bitget BTCUSDT collector source remains original identity in current-source replay", async t => {
  const root = await temporary(t);
  const market = "CRYPTO_FUTURES", symbol = "BTCUSDT";
  const native = source(market, symbol, 0,
    {sourceId:"BITGET_PUBLIC_FUTURES_1M"});
  native.session = { ...native.session,
    calendarSourceId:"CRYPTO_UTC_DAY_SOURCE_ONLY" };
  const pinnedSha="a".repeat(40);
  const prewire={
    contract:"research-original-minute-backtester-prewire/v1",
    status:"RETROSPECTIVE_RESEARCH_MODEL_INPUT_ONLY",
    market,symbol,day:date(D),modelInput:native,
    sourceMinuteDigest:native.sourceMinuteRowsSha256,sourceMinuteRows:1440,
    oldestActualReceiptMs:OBSERVED,newestActualReceiptMs:OBSERVED,
    sourceArchiveDigests:Array.from({length:12},(_,i)=>hash("bitget-source-page-"+i)),
    sourceArchiveProducerShas:[pinnedSha],
    metadata:{sourceMinutePages:12,missingOneMinuteSlots:0,
      allSourceSlotsObserved:true,sourceDigestMatchesCanonicalModel:true,
      retrospectiveTimeCannotBeUsedAsScannerTime:true,
      independentMarketLicenseOrPITProven:false},
    executionAuthority:"NONE",providerGETCount:0,archiveFilesWritten:0,
    profitabilityProven:false,historicalPITProven:false,
    independentOosProven:false,fullCostProfitabilityProven:false,
    paperAdmissionAllowed:false,
  };
  const imported=await importPrewire({enabled:true,operatorApproved:true,
    prewire,archiveRoot:root,expectedResearchSha:pinnedSha});
  assert.equal(imported.status,"IMPORTED_RETROSPECTIVE_SOURCE_ONLY");
  const current=request(root,market,symbol,{direction:"SHORT"});
  const result=await replay({...current,sessionSources:[{
    date:date(D),startMs:D,endMs:D+DAY,kind:"UTC_24H",zone:"UTC",
    sourceDigestSha256:imported.nativeImmutableArchiveDigest,
  }]});
  assert.equal(result.status,"RETROSPECTIVE_SOURCE_ONLY_STRATEGY_DIAGNOSTIC");
  assert.equal(result.sourceMinuteRowsRead,1440);
  assert.equal(result.direction,"SHORT");
  assertNoAuthority(result);
});
