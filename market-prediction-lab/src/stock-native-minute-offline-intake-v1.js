import {createHash} from "node:crypto";
import {isAbsolute,resolve} from "node:path";
import {auditHistoricalPITVenueUniverseV1,digestPITMembershipRowsV1}
  from "./historical-pit-venue-universe-gate-v1.js";
import {validateResearchStockSessionsForDateV1}
  from "./research-minute-archive-window-v1.js";
import {persistResearchMinuteSessionV1,
  inspectArchivedResearchMinuteSessionV1}
  from "./research-minute-archive-v1.js";

/**
 * Offline licensed-stock ORIGINAL 1m importer.
 *
 * No vendor API, network, account, trading, DB or Production action.
 * A source organization must deliver legally obtained original 1m OHLCV
 * plus dated PIT member, official exchange session and local retention
 * rights. All these are CALLER-ATTESTED until independently verified.
 * Refusal to import/partial minute slots NEVER means there were zero trades.
 *
 * Immutable archive writer handles content SHA-256, private permissions,
 * gzip, revision conflict and financial-order authority NONE.
 */
const MARKETS=Object.freeze({KR_STOCK:{
  venue:"KRX",zone:"Asia/Seoul",
},US_STOCK:{venue:"US_SIP",zone:"America/New_York"}});
const DATE=/^\d{4}-\d{2}-\d{2}$/u;
const SHA=/^[0-9a-f]{64}$/u;
const SYMBOL=/^[A-Z0-9][A-Z0-9._:-]{0,39}$/u;
const MIN=60_000,DAY=86_400_000;
const LICENSE_VERSION="stock-native-minute-local-license-attestation-v1";
const hash=v=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const fail=s=>{throw new TypeError(s);};
const safe=values=>Object.freeze({
  schemaVersion:"stock-native-minute-offline-intake-v1",
  status:"BLOCKED_DATA",reason:null,
  readOnlyProviderGETs:0,privateTradingApiCalls:0,
  financialMutationCount:0,orderSubmitted:false,
  offlineOriginalArchiveWriteAllowed:false,
  stockVenueOfficialSourceIndependentlyAuthenticated:false,
  historicalPITAndOfficialCalendarIndependentlyAuthenticated:false,
  licensedOriginalMinuteRedistributionAllowed:false,
  originalMinuteHistoricalScannerAvailabilityProven:false,
  completeWholeMarketOriginalSourceProven:false,
  fullMarketOpportunityDenominatorVerified:false,
  trueMarketWideRecall:null,actualMarketWideOpportunityCount:null,
  OOSPassCount:0,actualFillCount:null,netProfitPct:null,
  profitabilityProven:false,executionAuthority:"NONE",
  paperAdmissionAllowed:false,liveTrading:false,
  autoTrading:false,realOrders:false,...values,
});
const dateIsValid=v=>typeof v==="string"&&DATE.test(v)
  &&Number.isFinite(Date.parse(v+"T00:00:00Z"))
  &&new Date(v+"T00:00:00Z").toISOString().slice(0,10)===v;
function localDate(ms,zone){
  const value=Object.fromEntries(new Intl.DateTimeFormat("en-US",{
    timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",
  }).formatToParts(new Date(ms)).map(p=>[p.type,p.value]));
  return value.year+"-"+value.month+"-"+value.day;
}
function sourceHasUnsafeFields(value){
  if(!value||typeof value!=="object"||Array.isArray(value))return true;
  return Object.keys(value).some(key=>
    /(?:password|secret|api.?key|token|authorization|private.?key|account)/iu.test(key));
}
function validate(input){
  if(!input||typeof input!=="object"||Array.isArray(input))
    fail("STOCK_NATIVE_MINUTE_INPUT_REQUIRED");
  const {root,market,source,manifest,stockCalendar,license,
    tradingDateLocal,allowLocalOfflineImport=false}=input;
  if(typeof root!=="string"||!isAbsolute(root)||resolve(root)!==root
    ||!Object.hasOwn(MARKETS,market)||!source||typeof source!=="object"
    ||Array.isArray(source)||sourceHasUnsafeFields(source)
    ||source.market!==market||source.venue!==MARKETS[market].venue
    ||typeof source.symbol!=="string"||!SYMBOL.test(source.symbol)
    ||!source.session||typeof source.session!=="object"
    ||source.session.timeZone!==MARKETS[market].zone
    ||!["PREMARKET","REGULAR","AFTERMARKET"].includes(source.session.kind)
    ||!Number.isSafeInteger(source.session.startMs)
    ||!Number.isSafeInteger(source.session.endMs)
    ||source.session.endMs<=source.session.startMs
    ||source.session.endMs-source.session.startMs>DAY
    ||source.session.startMs%MIN!==0||source.session.endMs%MIN!==0
    ||!dateIsValid(tradingDateLocal)
    ||localDate(source.session.startMs,MARKETS[market].zone)!==tradingDateLocal
    ||!Array.isArray(source.minuteBars)||source.minuteBars.length<1
    ||source.minuteBars.length>1440
    ||!SHA.test(source.sourceMinuteRowsSha256??"")
    ||hash(source.minuteBars)!==source.sourceMinuteRowsSha256)
    fail("STOCK_NATIVE_MINUTE_IDENTITY_OR_ROWS_INVALID");
  if(!stockCalendar||stockCalendar.market!==market
    ||!Array.isArray(stockCalendar.sessions))
    fail("STOCK_NATIVE_MINUTE_EXCHANGE_SESSIONS_REQUIRED");
  const expected=validateResearchStockSessionsForDateV1(
    market,stockCalendar,tradingDateLocal,tradingDateLocal);
  const matches=expected.filter(s=>s.startMs===source.session.startMs
    &&s.endMs===source.session.endMs&&s.kind===source.session.kind
    &&s.timeZone===source.session.timeZone);
  if(matches.length!==1)
    fail("STOCK_NATIVE_MINUTE_SESSION_CALENDAR_IDENTITY_UNVERIFIED");
  if(!manifest||manifest.market!==market
    ||manifest.venue!==MARKETS[market].venue
    ||!Array.isArray(manifest.memberships)
    ||digestPITMembershipRowsV1(manifest.memberships)
       !==manifest.rawMembershipDigestSha256)
    fail("STOCK_NATIVE_MINUTE_HISTORIC_PIT_ROSTER_INVALID");
  const startDateMs=Date.parse(tradingDateLocal+"T00:00:00Z");
  const pit=auditHistoricalPITVenueUniverseV1({
    market,dayStartMs:startDateMs,dayEndMs:startDateMs+DAY,
    selectedRows:[],manifest,
  });
  if(!["TEST_FIXTURE_ONLY","SOURCE_ATTESTED_PIT_COHORT_ONLY"]
    .includes(pit.status))
    fail("STOCK_NATIVE_MINUTE_HISTORIC_PIT_GATE_BLOCKED");
  const rows=manifest.memberships.filter(x=>
    String(x.symbol??"").trim().toUpperCase()===source.symbol
    &&x.listedAtMs<=source.session.startMs
    &&(x.removedAtMs??Infinity)>=source.session.endMs);
  if(rows.length!==1||rows[0].halts.some(h=>
    h.startMs<source.session.endMs&&h.endMs>source.session.startMs))
    fail("STOCK_NATIVE_MINUTE_LISTED_OR_HALT_SOURCE_UNVERIFIED");
  if(!license||sourceHasUnsafeFields(license)
    ||license.schemaVersion!==LICENSE_VERSION
    ||license.sourceId!==source.sourceId
    ||license.originalRowsSha256!==source.sourceMinuteRowsSha256
    ||typeof license.localRetentionRightsRef!=="string"
    ||license.localRetentionRightsRef.length<5
    ||license.localRetentionRightsRef.length>160)
    fail("STOCK_NATIVE_MINUTE_LICENSE_METADATA_INVALID");
  const metadataVerified=license.historicalReadRightsAcknowledged===true
    &&license.localImmutableArchiveRetentionAcknowledged===true
    &&license.originalPriceRowsUnmodifiedAcknowledged===true
    &&license.privateRedistributionNotAllowed===true
    &&allowLocalOfflineImport===true;
  return {root,market,source,tradingDateLocal,manifest,license,
    metadataVerified,
    pitStatus:pit.status,
    stockCalendarDigestSha256:hash(expected),
    licenseAttestationDigestSha256:hash(license)};
}
export async function importStockNativeMinuteOfflineV1(input={}){
  const cfg=validate(input);
  const base={
    market:cfg.market,symbol:cfg.source.symbol,
    tradingDateLocal:cfg.tradingDateLocal,
    sourceSessionStartMs:cfg.source.session.startMs,
    sourceSessionEndMs:cfg.source.session.endMs,
    sourceVenue:cfg.source.venue,
    PITSourceClass:cfg.manifest.sourceClass,
    observedOriginalMinuteRows:cfg.source.minuteBars.length,
    expectedSessionMinuteSlots:
      (cfg.source.session.endMs-cfg.source.session.startMs)/MIN,
    originalMinuteRowsDigestSha256:cfg.source.sourceMinuteRowsSha256,
    stockCalendarDigestSha256:cfg.stockCalendarDigestSha256,
    legalRetentionSelfAttestationSha256:cfg.licenseAttestationDigestSha256,
    sourceHistoricalPublicationTimeIndependentlyVerified:false,
    importedDataLegalRightsIndependentlyVerified:false,
    PITWholeVenueCoverageIndependent:false,
  };
  if(!cfg.metadataVerified)
    return safe({...base,
      status:"BLOCKED_DATA",
      reason:"EXPLICIT_LOCAL_LICENSED_SOURCE_IMPORT_CONSENT_REQUIRED",
      originalArchiveDigestSha256:null,
      physicalArchiveRetained:false});
  const source=cfg.source;
  const storage=await persistResearchMinuteSessionV1({
    root:cfg.root,source,
  });
  const audit=await inspectArchivedResearchMinuteSessionV1({
    root:cfg.root,market:cfg.market,symbol:source.symbol,
    sessionStartMs:source.session.startMs,
    sourceDigestSha256:storage.sourceDigestSha256,
  });
  if(audit.sourceMinuteIntegrityVerified!==true
    ||audit.sourceMinuteRows!==source.minuteBars.length)
    fail("STOCK_NATIVE_MINUTE_IMMUTABLE_ARCHIVE_AFTER_WRITE_MISMATCH");
  const complete=audit.nativeMinuteSlotInventoryComplete===true;
  return safe({...base,status:complete
      ?"RETROSPECTIVE_STOCK_NATIVE_MINUTE_ARCHIVE_RETAINED_ONLY"
      :"PARTIAL_NATIVE_STOCK_MINUTE_ARCHIVE_RETAINED_NOT_COMPLETE",
    reason:complete
      ?"NATIVE_1M_SOURCE_SLOT_PRESENCE_NOT_ORIGINAL_SIGNAL_OOS_OR_LICENSE_PROOF"
      :"ORIGINAL_STOCK_MINUTE_GAPS_CANNOT_BE_FILLED_OR_ZEROED",
    offlineOriginalArchiveWriteAllowed:true,
    physicalArchiveRetained:true,
    sourceMinuteRowsVerified:audit.sourceMinuteRows,
    missingUnverifiedSourceMinuteSlots:
      audit.missingUnverifiedSourceMinuteSlots,
    originalArchiveDigestSha256:storage.sourceDigestSha256,
    licenseAndProviderHistoricalAuthenticityIndependent:false,
  });
}
