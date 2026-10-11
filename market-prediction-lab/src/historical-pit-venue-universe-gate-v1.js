import {createHash} from "node:crypto";

/**
 * Date-scoped PIT venue roster evidence gate. This validates a separate
 * historically dated (including removed and halted symbols) ARCHIVAL roster;
 * contemporary / surviving ticker lists or price-candle existence are NEVER
 * promoted into full-market historical opportunity denominators.
 *
 * Source attestations and SHA of supplied rows are integrity checks, NOT proof
 * that the provider or historical roster was independently authenticated.
 * No live orders, Paper, OMS, secrets, network calls, PnL, or AI admission.
 */
const VENUES=Object.freeze({
  KR_STOCK:"KRX",US_STOCK:"US_SIP",
  CRYPTO_SPOT:"UPBIT_KRW",CRYPTO_FUTURES:"BITGET_USDT_FUTURES",
});
const UTC_DAY=86_400_000;
const SHA256=/^[a-f0-9]{64}$/;
const SYMBOL=/^[A-Z0-9][A-Z0-9._:-]{0,39}$/;
const SOURCE_CLASSES=new Set(["EXCHANGE_DATED_ARCHIVE","LICENSED_PIT_HISTORICAL_VENDOR","TEST_FIXTURE"]);
const ACCESS_RESTRICTIONS=Object.freeze({
  realOrders:false,privateApiRequests:false,productionPromotion:false,
  OOSPassCount:0,profitabilityProven:false,executionAuthority:"NONE",
});
const validTime=n=>Number.isSafeInteger(n)&&n>0;
const isRecord=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const norm=x=>String(x??"").trim().toUpperCase();
function canonical(x){
  if(Array.isArray(x))return "["+x.map(canonical).join(",")+"]";
  if(isRecord(x))return "{"+Object.keys(x).sort()
    .map(k=>JSON.stringify(k)+":"+canonical(x[k])).join(",")+"}";
  return JSON.stringify(x);
}
export function digestPITMembershipRowsV1(rows){
  if(!Array.isArray(rows))throw new TypeError("PIT_MEMBERSHIPS_ARRAY_REQUIRED");
  return createHash("sha256").update(canonical(rows)).digest("hex");
}
function blocked(market,venue,reason,extra={}){
  return Object.freeze({
    market,venue,status:"BLOCKED_PIT_UNIVERSE",
    reason,sourceClass:null,archivedActiveAtDate:null,
    dateExitedSymbolsInArchive:null,sourceSelectedObserved:null,
    verifiedHistoricalMarketDenominator:null,
    pointInTimeMemberCount:null,selectedObservedInRoster:null,
    survivorBiasExcluded:false,originalScannerAvailabilityVerified:false,
    fullMarketOpportunityDenominatorVerified:false,
    trueMarketWideRecall:null,actualFillCount:null,netProfitPct:null,
    ...ACCESS_RESTRICTIONS,...extra,
  });
}
function inspectMemberships(rows,start,end){
  if(!Array.isArray(rows)||!rows.length||rows.length>50000)
    return {error:"PIT_MEMBERSHIP_ROWS_INVALID"};
  const seen=new Map(),dayActive=new Set(),suspended=new Set(),
    endedBeforeDay=new Set(),endedHistorical=new Set(),allSymbols=new Set();
  for(const [index,row] of rows.entries()){
    const sym=norm(row?.symbol);
    if(!SYMBOL.test(sym)||!validTime(row?.listedAtMs)
      ||row.removedAtMs!=null&&(!validTime(row.removedAtMs)||row.removedAtMs<=row.listedAtMs)
      ||!Array.isArray(row.halts)
      ||typeof row.sourceId!=="string"||!row.sourceId.trim()
      ||typeof row.evidenceSha256!=="string"||!SHA256.test(row.evidenceSha256))
      return {error:"PIT_LIFECYCLE_ROW_INVALID",index};
    const prior=seen.get(sym);
    // Sorting on input order is insufficient. Check same-symbol intervals
    // after sorting by listedAtMs to avoid interleaved-symbol masking.
    const spans=prior??[];
    spans.push({from:row.listedAtMs,to:row.removedAtMs??Infinity});
    seen.set(sym,spans);
    allSymbols.add(sym);
    let lastHaltEnd=0;
    for(const halt of row.halts){
      if(!validTime(halt?.startMs)||!validTime(halt?.endMs)
        ||halt.endMs<=halt.startMs
        ||halt.startMs<row.listedAtMs
        ||row.removedAtMs!=null&&halt.endMs>row.removedAtMs
        ||halt.startMs<lastHaltEnd
        ||!["EXCHANGE_HALT","SUSPENDED"].includes(halt.reason))
        return {error:"PIT_HALTS_INVALID",index};
      lastHaltEnd=halt.endMs;
    }
    if(row.removedAtMs!=null&&row.removedAtMs<=start)endedBeforeDay.add(sym);
    if(row.removedAtMs!=null&&row.removedAtMs>start-3*365*UTC_DAY
      &&row.removedAtMs<=end)endedHistorical.add(sym);
    if(row.listedAtMs<end&&(row.removedAtMs??Infinity)>start){
      dayActive.add(sym);
      if(row.halts.some(h=>h.startMs<end&&h.endMs>start))
        suspended.add(sym);
    }
  }
  for(const [sym,spans] of seen.entries()){
    spans.sort((a,b)=>a.from-b.from||a.to-b.to);
    for(let i=1;i<spans.length;i++)
      if(spans[i].from<spans[i-1].to)
        return {error:"PIT_OVERLAPPING_SAME_SYMBOL_INTERVALS",symbol:sym};
  }
  return {dayActive,suspended,endedBeforeDay,endedHistorical,allSymbols,rows};
}
export function auditHistoricalPITVenueUniverseV1({
  market,dayStartMs,dayEndMs,selectedRows=[],manifest=null,
}={}){
  if(!Object.hasOwn(VENUES,market))throw new TypeError("PIT_MARKET_INVALID");
  const venue=VENUES[market];
  if(!validTime(dayStartMs)||!validTime(dayEndMs)||dayStartMs%UTC_DAY!==0
    ||dayEndMs-dayStartMs!==UTC_DAY)
    throw new TypeError("PIT_DAY_WINDOW_INVALID");
  if(!Array.isArray(selectedRows)||selectedRows.length>1000)
    throw new TypeError("PIT_SELECTED_ROWS_INVALID");
  const selected=new Set(),observed=new Set();
  for(const row of selectedRows){
    const sym=norm(row?.symbol);
    if(!SYMBOL.test(sym)||selected.has(sym)
      ||!["OBSERVED_SELECTED_SYMBOL_DAY","BLOCKED_DATA"].includes(row?.status)
      ||(row.market!=null&&row.market!==market)
      ||(row.venue!=null&&row.venue!==venue)){
      return blocked(market,venue,"SELECTED_SOURCE_COHORT_CONTRACT_INVALID");
    }
    selected.add(sym);
    if(row.status==="OBSERVED_SELECTED_SYMBOL_DAY")observed.add(sym);
  }
  const known=Object.freeze({
    observedSelectedSourceSymbolDays:observed.size,
    selectedSymbolDays:selected.size,
    selectedHistoricOpportunityCount:selectedRows.some(r=>r.status==="BLOCKED_DATA")
      ?null:selectedRows.reduce((n,r)=>n+r.observedDayCrossingCount,0),
    currentSelectedDataIsNotHistoricalPIT:true,
  });
  if(manifest==null)return blocked(market,venue,
    "DATED_HISTORICAL_PIT_ROSTER_NOT_CONNECTED",known);
  if(!isRecord(manifest))return blocked(market,venue,
    "PIT_MANIFEST_INVALID",known);
  const cls=manifest.sourceClass;
  if(cls==="CURRENT_SNAPSHOT"||cls==="CANDLE_PRESENCE_INFERRED"){
    return blocked(market,venue,cls==="CURRENT_SNAPSHOT"
      ?"CURRENT_SURVIVOR_LIST_NOT_HISTORICAL_PIT":"CANDLE_EXISTENCE_NOT_FULL_LISTING",
      {...known,sourceClass:cls,survivorBiasExcluded:true});
  }
  if(!SOURCE_CLASSES.has(cls)
     ||manifest.schemaVersion!=="historical-venue-pit-roster-v1"
     ||manifest.market!==market||manifest.venue!==venue
     ||manifest.coverageStartMs>dayStartMs||manifest.coverageEndMs<dayEndMs
     ||!validTime(manifest.coverageStartMs)||!validTime(manifest.coverageEndMs)
     ||!validTime(manifest.retrievedAtMs)
     // A retrospective complete-through date cannot be archived before it
     // happened. This never certifies that a provider snapshot was available
     // to a contemporaneous scanner.
     ||manifest.retrievedAtMs<manifest.coverageEndMs
     ||typeof manifest.sourceId!=="string"||!manifest.sourceId.trim()
     ||manifest.allListedAndRemovedAttested!==true
     ||manifest.suspensionsAttested!==true
     ||manifest.relistedIdentifiersResolved!==true
     ||!SHA256.test(manifest.rawMembershipDigestSha256??"")
     ||!Array.isArray(manifest.memberships)
     ||manifest.rawMembershipDigestSha256!==digestPITMembershipRowsV1(manifest.memberships)
     ||(cls==="TEST_FIXTURE"&&manifest.testOnly!==true))
    return blocked(market,venue,"PIT_ARCHIVE_SOURCE_ATTESTATION_INVALID",
      {...known,sourceClass:cls});
  const parsed=inspectMemberships(manifest.memberships,dayStartMs,dayEndMs);
  if(parsed.error)return blocked(market,venue,parsed.error,{
    ...known,sourceClass:cls,errorSymbol:parsed.symbol??null,
    errorIndex:parsed.index??null,
  });
  // Delistings later in the archive must not invalidate *earlier* 2023
  // sessions when their as-of delisting count was genuinely still zero.
  // Require that the supplied full lifecycle source includes actual removed
  // membership rows over its archived span (not merely an asserted flag).
  // This is self-attested archive scope, NOT independently proven full-market
  // survivorship correctness.
  const archivedRemovals=parsed.rows.filter(row=>
    row.removedAtMs!=null
    &&row.removedAtMs>=manifest.coverageStartMs
    &&row.removedAtMs<=manifest.coverageEndMs).length;
  if(archivedRemovals===0)
    return blocked(market,venue,"PIT_REMOVED_NAMES_EVIDENCE_MISSING",
      {...known,sourceClass:cls});
  const missing=[...observed].filter(sym=>!parsed.dayActive.has(sym));
  if(missing.length)return blocked(market,venue,
    "HISTORIC_PRICE_BARS_OUTSIDE_LISTED_MEMBERSHIP",
    {...known,sourceClass:cls,conflictingSymbols:missing.slice(0,20)});
  const suspending=[...observed].filter(sym=>parsed.suspended.has(sym));
  if(suspending.length)return blocked(market,venue,
    "OBSERVED_FULL_DAY_TRADES_DURING_REPORTED_HALT",
    {...known,sourceClass:cls,conflictingSymbols:suspending.slice(0,20)});
  const listedOnlyPartDay=[...observed].filter(sym=>
    manifest.memberships.some(x=>norm(x.symbol)===sym
      &&x.listedAtMs<dayEndMs&&x.listedAtMs>dayStartMs
      &&(x.removedAtMs??Infinity)>dayStartMs));
  if(listedOnlyPartDay.length)return blocked(market,venue,
    "FULL_DAY_BARS_BEFORE_LISTING",
    {...known,sourceClass:cls,conflictingSymbols:listedOnlyPartDay.slice(0,20)});
  const removedDuring=[...observed].filter(sym=>
    manifest.memberships.some(x=>norm(x.symbol)===sym
      &&x.removedAtMs!=null&&x.removedAtMs<dayEndMs
      &&x.removedAtMs>dayStartMs));
  if(removedDuring.length)return blocked(market,venue,
    "FULL_DAY_BARS_AFTER_DELISTING",
    {...known,sourceClass:cls,conflictingSymbols:removedDuring.slice(0,20)});
  const unobserved=[...parsed.dayActive].filter(sym=>!observed.has(sym));
  return Object.freeze({
    ...known,market,venue,
    status:cls==="TEST_FIXTURE"?"TEST_FIXTURE_ONLY":"SOURCE_ATTESTED_PIT_COHORT_ONLY",
    reason:cls==="TEST_FIXTURE"?"CONTRACT_TEST_ONLY":"NO_INDEPENDENT_FULL_ARCHIVE_AUTHENTICITY_PROOF",
    sourceClass:cls,sourceId:manifest.sourceId,
    rawMembershipDigestSha256:manifest.rawMembershipDigestSha256,
    dayActiveArchivedMembers:parsed.dayActive.size,
    archivedEndedInThreeYears:parsed.endedHistorical.size,
    archivedRemovedAcrossSourceWindow:archivedRemovals,
    archivedSuspendedToday:parsed.suspended.size,
    observedSelectedRosterMatched:observed.size,
    archivedMembersNotInSelectedCandleCohort:unobserved.length,
    archivedMembersWithoutPriceNotAssumedZero:true,
    archiveRetrospectiveNotScannerAvailableAt:manifest.retrievedAtMs>dayStartMs,
    independentlyAuthenticArchiveVerified:false,
    fullMarketOpportunityDenominatorVerified:false,
    verifiedHistoricalMarketDenominator:null,
    trueMarketWideRecall:null,actualFillCount:null,netProfitPct:null,
    ...ACCESS_RESTRICTIONS,
  });
}
export function reportFourMarketPITRosterReadinessV1({
  nativeSelectedSummary,manifests={},
}={}){
  if(!isRecord(nativeSelectedSummary)
    ||nativeSelectedSummary.schemaVersion!=="native-selected-historical-utc-day-1m-pilot-v1"
    ||nativeSelectedSummary.executionAuthority!=="NONE"
    ||nativeSelectedSummary.profitabilityProven!==false
    ||nativeSelectedSummary.historicalPointInTimeUniverseVerified!==false
    ||nativeSelectedSummary.trueMarketWideRecall!==null
    ||!isRecord(nativeSelectedSummary.markets)
    ||!isRecord(nativeSelectedSummary.sample)
    ||!isRecord(manifests))
    throw new TypeError("PIT_SOURCE_RECEIPT_INVALID");
  const dayEndMs=nativeSelectedSummary.sample.endMs;
  const dayStartMs=dayEndMs-UTC_DAY;
  const markets=Object.fromEntries(Object.keys(VENUES).map(market=>{
    const fromSource=nativeSelectedSummary.markets[market];
    const selectedRows=Array.isArray(fromSource)?fromSource:[];
    return [market,auditHistoricalPITVenueUniverseV1({
      market,dayStartMs,dayEndMs,selectedRows,
      manifest:manifests[market]??null,
    })];
  }));
  return Object.freeze({
    schemaVersion:"four-market-historical-pit-universe-readiness-v1",
    status:"RESEARCH_DATA_READINESS_ONLY",dayStartMs,dayEndMs,markets,
    observedSelectedSymbolDays:Object.values(markets)
      .reduce((sum,x)=>sum+(x.observedSelectedSourceSymbolDays??0),0),
    datedCompleteUniverseEvidenceAvailable:Object.values(markets)
      .some(x=>x.status==="SOURCE_ATTESTED_PIT_COHORT_ONLY"),
    historicUniverseMarketWideProven:false,
    totalHistoricActiveMarketSymbols:null,
    fullMarketOpportunityDenominatorVerified:false,
    trueMarketWideRecall:null,actualFillCount:null,netProfitPct:null,
    ...ACCESS_RESTRICTIONS,
  });
}
