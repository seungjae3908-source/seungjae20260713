import {createHash} from "node:crypto";
import {resolveSelectedResearchWindowV1,UTC_DAY_MS_V1 as DAY} from "./research-selected-window-v1.js";
import {auditHistoricalPITVenueUniverseV1,digestPITMembershipRowsV1} from "./historical-pit-venue-universe-gate-v1.js";

/**
 * Exhaustive historic-roster / selected-window work pagination, not an
 * opportunity scanner. A current ticker catalog is never substituted for a
 * historically dated PIT archive (including delisted/relisted/halts).
 * Each call covers <=31 dates and <=20 WHOLE-ROSTER identities; retries
 * resume via (cursorDate,memberOffset). Actual 1m source loading belongs to
 * the PRIVATE replay reader and cannot be inferred from this planner.
 */
const MARKETS=Object.freeze({
  KR_STOCK:"KRX",US_STOCK:"US_SIP",
  CRYPTO_SPOT:"UPBIT_KRW",CRYPTO_FUTURES:"BITGET_USDT_FUTURES",
});
const STOCK=new Set(["KR_STOCK","US_STOCK"]);
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const SHA=/^[a-f0-9]{64}$/;
const SYMBOL=/^[A-Z0-9][A-Z0-9._:-]{0,39}$/;
const hash=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const utc=x=>new Date(x).toISOString().slice(0,10);
const fail=x=>{throw new TypeError(x);};
const safe=extra=>Object.freeze({
  schemaVersion:"four-market-pit-replay-work-queue-v1",
  status:"BLOCKED_DATA",reason:null,
  sourceOnlyPlanning:true,readOnly:true,providerGETCount:0,
  independentPITProviderAttestation:false,
  originalMarketMinuteSourceVerified:false,
  fullMarketOpportunityDenominatorVerified:false,
  actualMarketWideOpportunityCount:null,trueMarketWideRecall:null,
  originalHistoricalScannerAvailabilityVerified:false,
  actualFillCount:null,netProfitPct:null,OOSPassCount:0,
  profitabilityProven:false,executionAuthority:"NONE",
  liveTrading:false,autoTrading:false,realOrders:false,
  paperAdmissionAllowed:false,...extra,
});
function parseDay(value){
  if(typeof value!=="string"||!DATE.test(value))
    fail("PIT_REPLAY_DATE_INVALID");
  const ms=Date.parse(value+"T00:00:00Z");
  if(!Number.isSafeInteger(ms)||utc(ms)!==value)
    fail("PIT_REPLAY_DATE_INVALID");
  return ms;
}
function stockDateKeys(market,dates){
  if(!Array.isArray(dates)||dates.length>36600)
    fail("PIT_REPLAY_EXCHANGE_DATES_MISSING_OR_INVALID");
  let before=-Infinity;
  for(const date of dates){
    const ms=parseDay(date);
    if(ms<=before)fail("PIT_REPLAY_EXCHANGE_DATES_DUPLICATED_OR_UNSORTED");
    before=ms;
  }
  return dates;
}
function roster(market,manifest){
  if(!manifest||typeof manifest!=="object"||Array.isArray(manifest)
    ||manifest.schemaVersion!=="historical-venue-pit-roster-v1"
    ||manifest.market!==market||manifest.venue!==MARKETS[market]
    ||!["EXCHANGE_DATED_ARCHIVE","LICENSED_PIT_HISTORICAL_VENDOR","TEST_FIXTURE"].includes(manifest.sourceClass)
    ||!Array.isArray(manifest.memberships)||manifest.memberships.length>50000
    ||manifest.memberships.length===0
    ||!SHA.test(manifest.rawMembershipDigestSha256??"")
    ||digestPITMembershipRowsV1(manifest.memberships)!==manifest.rawMembershipDigestSha256)
    fail("PIT_REPLAY_HISTORIC_ROSTER_INVALID");
  const identities=manifest.memberships.map(row=>String(row?.symbol??"").trim().toUpperCase());
  if(identities.some(sym=>!SYMBOL.test(sym)))
    fail("PIT_REPLAY_ROSTER_IDENTITY_INVALID");
  // Retired then relisted ticker values need immutable security identities.
  // Do not count two instruments under the same ticker without a stable ID.
  if(new Set(identities).size!==identities.length)
    return {symbols:null,reason:"PIT_TICKER_REUSE_UNRESOLVED_STABLE_ID"};
  return {symbols:identities.sort(),reason:null};
}
export function planFourMarketPITReplayWorkV1({
  market,researchWindow,manifest=null,stockTradingDates=null,
  cursorDate=null,memberOffset=0,memberPageSize=20,chunkCalendarDays=31,
}={}){
  if(!Object.hasOwn(MARKETS,market)||!Number.isSafeInteger(memberOffset)
    ||memberOffset<0||!Number.isSafeInteger(memberPageSize)
    ||memberPageSize<1||memberPageSize>20
    ||!Number.isSafeInteger(chunkCalendarDays)
    ||chunkCalendarDays<1||chunkCalendarDays>31)
    fail("PIT_REPLAY_PLANNER_SCOPE_INVALID");
  const period=resolveSelectedResearchWindowV1(researchWindow);
  const first=cursorDate==null?period.startMs:parseDay(cursorDate);
  if(first<period.startMs||first>=period.endExclusiveMs)
    fail("PIT_REPLAY_CURSOR_OUTSIDE_SELECTED_WINDOW");
  const end=Math.min(period.endExclusiveMs,first+chunkCalendarDays*DAY);
  const dayKeys=STOCK.has(market)
    ?stockDateKeys(market,stockTradingDates).filter(d=>d>=utc(first)&&d<utc(end))
    :Array.from({length:(end-first)/DAY},(_,i)=>utc(first+i*DAY));
  const selection={market,selectedStartDate:period.startDate,
    selectedEndDate:period.endDate,inspectedStartDate:utc(first),
    inspectedEndDate:utc(end-DAY),
    requestedCalendarDays:period.requestedUtcDayCount,
    nextChunkCursorDate:end<period.endExclusiveMs?utc(end):null};
  if(!dayKeys.length)return safe({...selection,reason:"EXCHANGE_SESSIONS_NOT_INDEPENDENTLY_CONNECTED",
    historicRosterMemberCount:null,plannedMemberDays:null,
    candidateTasks:[],nextMemberOffset:null});
  const r=roster(market,manifest);
  if(r.symbols==null)return safe({...selection,reason:r.reason,
    historicRosterMemberCount:null,plannedMemberDays:null,
    candidateTasks:[],nextMemberOffset:null});
  if(memberOffset>=r.symbols.length)
    fail("PIT_REPLAY_MEMBER_CURSOR_OUTSIDE_ROSTER");
  // Validate EVERY requested historical day with the original strict
  // whole-PIT gate BEFORE counting any candidate or source task.
  const known=new Map();
  let totalActiveMemberDays=0;
  for(const date of dayKeys){
    const dayStart=Date.parse(date+"T00:00:00Z");
    const audit=auditHistoricalPITVenueUniverseV1({
      market,dayStartMs:dayStart,dayEndMs:dayStart+DAY,
      manifest,selectedRows:[],
    });
    if(!["TEST_FIXTURE_ONLY","SOURCE_ATTESTED_PIT_COHORT_ONLY"]
      .includes(audit.status))
      return safe({...selection,reason:"HISTORIC_PIT_DAY_INVALID_"+String(audit.reason??audit.status),
        blockedDay:date,historicRosterMemberCount:r.symbols.length,
        plannedMemberDays:null,candidateTasks:[],nextMemberOffset:null});
    totalActiveMemberDays+=audit.dayActiveArchivedMembers;
    known.set(date,audit.status);
  }
  const page=r.symbols.slice(memberOffset,memberOffset+memberPageSize);
  const index=new Map(manifest.memberships.map(row=>[
    String(row.symbol).trim().toUpperCase(),row,
  ]));
  const tasks=[];
  for(const date of dayKeys){
    const dayStart=Date.parse(date+"T00:00:00Z"),dayEnd=dayStart+DAY;
    for(const symbol of page){
      const row=index.get(symbol);
      if(!(row.listedAtMs<dayEnd&&(row.removedAtMs??Infinity)>dayStart))
        continue;
      const partial=row.listedAtMs>dayStart
        ||(row.removedAtMs??Infinity)<dayEnd
        ||row.halts.some(h=>h.startMs<dayEnd&&h.endMs>dayStart);
      tasks.push(Object.freeze({market,venue:MARKETS[market],
        date,symbol,
        status:partial?"BLOCKED_INTRADAY_LIFECYCLE":"SOURCE_COLLECTION_OR_REPLAY_REQUIRED",
        originalOneMinuteRowsVerified:false,
        retrospectivePricingNotScannerAvailable:true,
        paperCandidateEligible:false}));
    }
  }
  const nextOffset=memberOffset+page.length<r.symbols.length
    ?memberOffset+page.length:null;
  return safe({...selection,
    status:"SOURCE_ONLY_PIT_WORK_PAGINATED",
    reason:"WHOLE_HISTORIC_COHORT_SOURCE_AND_SCANNER_NOT_INDEPENDENTLY_VERIFIED",
    sourceClass:manifest.sourceClass,
    fixtureOnly:manifest.sourceClass==="TEST_FIXTURE",
    selfAttestedRosterDigestSha256:manifest.rawMembershipDigestSha256,
    historicRosterMemberCount:r.symbols.length,
    requestedTradingDates:dayKeys.length,
    historicRosterActiveMemberDaysSelfAttested:totalActiveMemberDays,
    selectedPageOffset:memberOffset,selectedPageMemberCount:page.length,
    selectedPageMembersDigestSha256:hash(page),
    candidateTaskCount:tasks.length,candidateTasks:tasks,
    nextMemberOffset:nextOffset,
    nextCursorDate:nextOffset===null
      ?selection.nextChunkCursorDate:utc(first),
    nextCursorMemberOffset:nextOffset??0,
    checkedPITDays:known.size,
    allHistoricalSymbolsWereInspectedForDayCounts:true,
    noInventedZeroOpportunity:true,
  });
}
