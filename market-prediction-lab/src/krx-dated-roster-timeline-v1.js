import { createHash } from "node:crypto";

// KRX dated snapshots are read-only, retrospectively fetched source evidence.
// Disappearance != delisting; even 32 complete requested dates != full PIT 3Y.
const BOARDS = ["KOSPI", "KOSDAQ", "KONEX"];
const SHA = /^[a-f0-9]{64}$/;
const ISIN = /^[A-Z0-9]{12}$/;
const CODE = /^[A-Z0-9]{6}$/;
const SAFE = Object.freeze({
  independentlyVerifiedTradingCalendar:false,
  historicalFullMarketPITVerified:false,
  delistedMembershipHistoryVerified:false,
  confirmedDelistingCount:null,
  fullMarketOpportunityDenominatorVerified:false,
  trueMarketWideRecall:null, actualFillCount:null, netProfitPct:null,
  OOSPassCount:0, profitabilityProven:false,
  executionAuthority:"NONE", liveTrading:false, autoTrading:false,
  realOrders:false, privateAccountRequests:false,
});
function validDate(s) {
  if(typeof s!=="string"||!/^\d{8}$/.test(s)) return false;
  const d=new Date(Date.UTC(+s.slice(0,4),+s.slice(4,6)-1,+s.slice(6,8)));
  return d.toISOString().slice(0,10).replace(/-/g,"")===s;
}
function digest(v) { return createHash("sha256").update(JSON.stringify(v)).digest("hex"); }
function fail(dates, reason, details={}) {
  return Object.freeze({
    schemaVersion:"krx-dated-roster-transition-audit-v1",
    status:"BLOCKED_DATA", reason, requestedDates:dates,
    observedDateCount:null, missingRequestedDates:null,
    requestedSnapshotCoverage:null, dates:null, transitions:null,
    transitionCounts:null, ...SAFE, details,
  });
}
function validate(snapshot, dateYmd) {
  if(!snapshot || snapshot.schemaVersion!=="krx-public-dated-security-roster-v1"
    ||snapshot.status!=="OBSERVED_KRX_DAY_ROSTER_ONLY"
    ||snapshot.source!=="KRX_OPENAPI_ISSUE_BASE_INFO"
    ||snapshot.dateYmd!==dateYmd
    ||snapshot.executionAuthority!=="NONE"
    ||snapshot.realOrders!==false||snapshot.profitabilityProven!==false
    ||snapshot.delistedHistoryVerified!==false
    ||snapshot.entireDatePITUniverseProven!==false
    ||snapshot.fullMarketOpportunityDenominatorVerified!==false
    ||snapshot.trueMarketWideRecall!==null
    ||!Array.isArray(snapshot.symbols)||snapshot.symbols.length<3
    ||snapshot.symbols.length>30000
    ||!snapshot.markets||typeof snapshot.markets!=="object"
    ||Object.keys(snapshot.markets).length!==3
    ||BOARDS.some(b=>!Number.isSafeInteger(snapshot.markets[b])
      ||snapshot.markets[b]<1||snapshot.markets[b]>10000)
    ||snapshot.dateScopedSymbolCount!==snapshot.symbols.length
    ||!SHA.test(snapshot.sourceSha256??"")
    ||snapshot.sourceSha256!==digest({
      dateYmd:snapshot.dateYmd,markets:snapshot.markets,symbols:snapshot.symbols,
    })) return {error:"SNAPSHOT_SOURCE_OR_SHA_INVALID"};
  const byIsin=new Map(),byCode=new Map(),counts={KOSPI:0,KOSDAQ:0,KONEX:0};
  for(const [index,row] of snapshot.symbols.entries()) {
    if(!row||!BOARDS.includes(row.marketBoard)
      ||!ISIN.test(row.isin??"")||!CODE.test(row.shortCode??"")
      ||!validDate(row.listedYmd)||row.listedYmd>dateYmd
      ||byIsin.has(row.isin)||byCode.has(row.shortCode))
      return {error:"ISSUE_ID_DUPLICATE_OR_INVALID",index};
    byIsin.set(row.isin,row);
    byCode.set(row.shortCode,row.isin);
    counts[row.marketBoard]++;
  }
  if(BOARDS.some(b=>snapshot.markets[b]!==counts[b]))
    return {error:"MARKET_BOARD_COUNT_INCONSISTENT"};
  return {dateYmd,sourceSha256:snapshot.sourceSha256,
    symbolCount:snapshot.symbols.length,markets:counts,byIsin,byCode};
}
function diff(before,after,seenBefore) {
  const changes=[];
  for(const [isin,row] of before.byIsin) {
    if(!after.byIsin.has(isin)) changes.push({
      type:"NOT_RETURNED_NEXT_REQUESTED_DATE",isin,
      fromDate:before.dateYmd,toDate:after.dateYmd,
      shortCode:row.shortCode,confirmedDelisted:false,absenceReason:"UNKNOWN",
    });
  }
  for(const [isin,row] of after.byIsin) {
    const previous=before.byIsin.get(isin);
    if(!previous)changes.push({
      type:seenBefore.has(isin)?"REAPPEARED_AFTER_DATED_ABSENCE":"FIRST_SEEN_IN_REQUESTED_SERIES",
      isin,shortCode:row.shortCode,fromDate:before.dateYmd,toDate:after.dateYmd,
      confirmedNewListing:false,
    });
    else {
      if(previous.marketBoard!==row.marketBoard)changes.push({
        type:"SAME_ISIN_MARKET_BOARD_CHANGE",isin,
        fromDate:before.dateYmd,toDate:after.dateYmd,
        fromBoard:previous.marketBoard,toBoard:row.marketBoard,
        officiallyApprovedTransfer:null,
      });
      if(previous.shortCode!==row.shortCode)changes.push({
        type:"SAME_ISIN_SHORT_CODE_CHANGE",isin,
        fromDate:before.dateYmd,toDate:after.dateYmd,
        fromCode:previous.shortCode,toCode:row.shortCode,
      });
    }
    const oldIsin=before.byCode.get(row.shortCode);
    if(oldIsin&&oldIsin!==isin)changes.push({
      type:"SHORT_CODE_REUSED_DIFFERENT_ISIN",
      fromDate:before.dateYmd,toDate:after.dateYmd,
      code:row.shortCode,oldIsin,newIsin:isin,
      independentIdentityResolutionRequired:true,
    });
  }
  return changes;
}
export function auditKrxDatedRosterTimelineV1({
  requestedTradingDates=[],datedReceipts=[],
}={}) {
  if(!Array.isArray(requestedTradingDates)||requestedTradingDates.length<2
    ||requestedTradingDates.length>32
    ||requestedTradingDates.some(d=>!validDate(d)||d<"20130701")
    ||requestedTradingDates.some((d,i)=>i>0&&d<=requestedTradingDates[i-1]))
    throw new TypeError("REQUESTED_TRADING_DATE_SET_INVALID");
  const dates=Object.freeze([...requestedTradingDates]);
  if(!Array.isArray(datedReceipts)||datedReceipts.length>dates.length)
    throw new TypeError("DATED_RECEIPTS_INVALID");
  const provided=new Map();
  for(const item of datedReceipts) {
    if(!dates.includes(item?.dateYmd)||provided.has(item.dateYmd))
      return fail(dates,"DUPLICATE_OR_UNREQUESTED_DATED_SNAPSHOT");
    provided.set(item.dateYmd,item);
  }
  const missing=dates.filter(d=>!provided.has(d)),rows=[],corrupt=[];
  for(const d of dates) {
    if(!provided.has(d)){rows.push(null);continue;}
    const row=validate(provided.get(d),d);
    if(row.error)corrupt.push({dateYmd:d,reason:row.error});
    rows.push(row);
  }
  if(corrupt.length)return fail(dates,"KRX_DATED_SOURCE_INTEGRITY_FAILED",{
    corrupt:corrupt.slice(0,10),
  });
  const changes=[],seenBefore=new Set();
  for(let i=0;i<rows.length;i++){
    if(!rows[i])continue;
    if(i>0&&rows[i-1]) {
      const events=diff(rows[i-1],rows[i],seenBefore);
      if(changes.length+events.length>3000)
        return fail(dates,"TRANSITION_DIAGNOSTIC_CAP_EXCEEDED");
      changes.push(...events);
    }
    for(const isin of rows[i].byIsin.keys())seenBefore.add(isin);
  }
  const counts={};
  for(const event of changes)counts[event.type]=(counts[event.type]??0)+1;
  return Object.freeze({
    schemaVersion:"krx-dated-roster-transition-audit-v1",
    status:missing.length?"PARTIAL_REQUESTED_DATE_SNAPSHOTS":"OBSERVED_REQUESTED_DATES_ONLY",
    reason:missing.length?"REQUESTED_DATE_SOURCE_MISSING":
      "DATES_NOT_AUTHENTICATED_FULL_HISTORICAL_DELISTING_ARCHIVE",
    requestedDates:dates,observedDateCount:provided.size,
    missingRequestedDates:missing,requestedSnapshotCoverage:provided.size/dates.length,
    dates:rows.map((r,i)=>({
      dateYmd:dates[i],status:r?"OBSERVED_KRX_DATE":"MISSING_KRX_DATE",
      sourceSha256:r?.sourceSha256??null,observedRows:r?.symbolCount??null,
    })),
    transitions:changes,transitionCounts:counts,
    observedDisappearancesNotDelistings:counts.NOT_RETURNED_NEXT_REQUESTED_DATE??0,
    lastObservedDateCount:rows.at(-1)?.symbolCount??null,
    calendarDatesWereCallerSelected:true, ...SAFE,
  });
}
