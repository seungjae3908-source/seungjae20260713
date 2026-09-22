import { createHash } from "node:crypto";

export const STOCK_SESSION_CALENDAR_EVIDENCE_CONTRACT_V1 =
  "stock-session-calendar-evidence/v1";

const MARKETS=Object.freeze({
  KR_STOCK:Object.freeze({timeZone:"Asia/Seoul"}),
  US_STOCK:Object.freeze({timeZone:"America/New_York"}),
});
const HASH64=/^[0-9a-f]{64}$/i;
const SAFE_ID=/^[A-Za-z0-9._:/#-]{1,240}$/;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function canonical(value){
  if(Array.isArray(value)) return value.map(canonical);
  if(value===null||typeof value!=="object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
}
function digest(value){return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");}
function positiveTimestamp(value,name){
  if(!Number.isSafeInteger(value)||value<=0) throw new TypeError(`${name}_INVALID`);
  return value;
}
function canonicalIso(value){
  const text=String(value??"");
  if(!ISO.test(text)||!Number.isFinite(Date.parse(text))||new Date(text).toISOString()!==text){
    throw new TypeError("OBSERVED_AT_INVALID");
  }
  return text;
}
function canonicalDate(value,name){
  const text=String(value??"");
  const date=new Date(`${text}T00:00:00Z`);
  if(!DATE.test(text)
    ||!Number.isFinite(date.getTime())
    ||date.toISOString().slice(0,10)!==text){
    throw new TypeError(`${name}_INVALID`);
  }
  return text;
}
function dateRange(start,end){
  const rows=[];
  let cursor=Date.parse(`${start}T00:00:00Z`);
  const last=Date.parse(`${end}T00:00:00Z`);
  while(cursor<=last){
    rows.push(new Date(cursor).toISOString().slice(0,10));
    cursor+=24*60*60*1000;
  }
  return rows;
}
function weekday(date){
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}
function localDate(timestamp,timeZone){
  const parts=new Intl.DateTimeFormat("en-US",{
    timeZone,year:"numeric",month:"2-digit",day:"2-digit",
  }).formatToParts(new Date(timestamp));
  const map=Object.fromEntries(parts.filter(row=>row.type!=="literal").map(row=>[row.type,row.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export function createStockSessionCalendarEvidenceV1(raw={}){
  const market=String(raw.market??"").trim().toUpperCase();
  const definition=MARKETS[market];
  if(!definition) throw new TypeError("STOCK_SESSION_CALENDAR_MARKET_INVALID");
  if(raw.sourceKind!=="OFFICIAL_EXCHANGE_CALENDAR"){
    throw new Error("OFFICIAL_EXCHANGE_CALENDAR_SOURCE_REQUIRED");
  }
  const sourceId=String(raw.sourceId??"").trim();
  if(!SAFE_ID.test(sourceId)) throw new TypeError("SESSION_CALENDAR_SOURCE_ID_INVALID");
  const sourceDigest=String(raw.sourceDigest??"").trim().toLowerCase();
  if(!HASH64.test(sourceDigest)) throw new TypeError("SESSION_CALENDAR_SOURCE_DIGEST_INVALID");
  const observedAt=canonicalIso(raw.observedAt);
  const coverageStartTime=positiveTimestamp(raw.coverageStartTime,"COVERAGE_START_TIME");
  const coverageEndTime=positiveTimestamp(raw.coverageEndTime,"COVERAGE_END_TIME");
  if(coverageEndTime<=coverageStartTime) throw new Error("SESSION_CALENDAR_COVERAGE_RANGE_INVALID");
  if(coverageEndTime>Date.parse(observedAt)) throw new Error("SESSION_CALENDAR_FUTURE_COVERAGE_FORBIDDEN");
  const coverageStartDate=canonicalDate(raw.coverageStartDate,"COVERAGE_START_DATE");
  const coverageEndDate=canonicalDate(raw.coverageEndDate,"COVERAGE_END_DATE");
  if(localDate(coverageStartTime,definition.timeZone)!==coverageStartDate
    ||localDate(coverageEndTime,definition.timeZone)!==coverageEndDate){
    throw new Error("SESSION_CALENDAR_COVERAGE_DATE_MISMATCH");
  }
  if(raw.complete!==true) throw new Error("SESSION_CALENDAR_COMPLETENESS_REQUIRED");
  if(!Array.isArray(raw.days)) throw new TypeError("SESSION_CALENDAR_DAYS_INVALID");

  const expectedDates=dateRange(coverageStartDate,coverageEndDate);
  if(raw.days.length!==expectedDates.length) throw new Error("SESSION_CALENDAR_DAY_COVERAGE_INCOMPLETE");
  const normalized=[];
  for(let index=0;index<expectedDates.length;index+=1){
    const row=raw.days[index];
    if(!row||typeof row!=="object"||Array.isArray(row)) throw new TypeError("SESSION_CALENDAR_DAY_INVALID");
    const keys=Object.keys(row).sort();
    const wanted=["closeTime","date","openTime","sourceId","status"].sort();
    if(keys.length!==wanted.length||keys.some((key,i)=>key!==wanted[i])){
      throw new Error("SESSION_CALENDAR_DAY_SHAPE_INVALID");
    }
    const date=canonicalDate(row.date,"SESSION_DATE");
    if(date!==expectedDates[index]) throw new Error("SESSION_CALENDAR_DAY_SEQUENCE_INVALID");
    if(row.sourceId!==sourceId) throw new Error("SESSION_CALENDAR_DAY_SOURCE_MISMATCH");
    const day=weekday(date);
    const weekend=day===0||day===6;
    const status=String(row.status??"").trim().toUpperCase();
    if(!new Set(["OPEN","HOLIDAY","WEEKEND"]).has(status)) throw new Error("SESSION_CALENDAR_STATUS_INVALID");
    if(weekend&&status!=="WEEKEND") throw new Error("SESSION_CALENDAR_WEEKEND_STATUS_INVALID");
    if(!weekend&&status==="WEEKEND") throw new Error("SESSION_CALENDAR_WEEKDAY_STATUS_INVALID");

    let openTime=null,closeTime=null;
    if(status==="OPEN"){
      openTime=positiveTimestamp(row.openTime,"SESSION_OPEN_TIME");
      closeTime=positiveTimestamp(row.closeTime,"SESSION_CLOSE_TIME");
      if(closeTime<=openTime) throw new Error("SESSION_CALENDAR_OPEN_CLOSE_INVALID");
      if(localDate(openTime,definition.timeZone)!==date||localDate(closeTime,definition.timeZone)!==date){
        throw new Error("SESSION_CALENDAR_LOCAL_DATE_MISMATCH");
      }
      if(openTime<coverageStartTime||closeTime>coverageEndTime){
        throw new Error("SESSION_CALENDAR_SESSION_OUTSIDE_COVERAGE");
      }
    }else if(row.openTime!==null||row.closeTime!==null){
      throw new Error("SESSION_CALENDAR_CLOSED_DAY_MUST_HAVE_NULL_TIMES");
    }
    normalized.push(Object.freeze({date,status,openTime,closeTime,sourceId}));
  }

  const core={
    schemaVersion:1,
    contract:STOCK_SESSION_CALENDAR_EVIDENCE_CONTRACT_V1,
    market,
    timeZone:definition.timeZone,
    sourceKind:"OFFICIAL_EXCHANGE_CALENDAR",
    sourceId,
    sourceDigest,
    observedAt,
    coverageStartTime,
    coverageEndTime,
    coverageStartDate,
    coverageEndDate,
    complete:true,
    days:Object.freeze(normalized),
    safeguards:Object.freeze({
      generatedHolidayAssumptionsAllowed:false,
      missingDayInterpolationAllowed:false,
      weekendTradingAssumptionAllowed:false,
      syntheticCalendarAllowed:false,
      liveTradingAllowed:false,
      privateAccountRequestAllowed:false,
      executionAuthority:"NONE",
    }),
  };
  return Object.freeze({...core,evidenceDigest:digest(core)});
}
