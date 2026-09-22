import { createHash } from "node:crypto";

export const STOCK_CORPORATE_ACTIONS_EVIDENCE_CONTRACT_V1 =
  "stock-corporate-actions-evidence/v1";

const MARKETS=new Set(["KR_STOCK","US_STOCK"]);
const ACTIONS=new Set([
  "STOCK_SPLIT",
  "REVERSE_SPLIT",
  "CASH_DIVIDEND",
  "STOCK_DIVIDEND",
  "RIGHTS_ISSUE",
  "SPINOFF",
  "MERGER",
  "DEMERGER",
  "SYMBOL_CHANGE",
  "CAPITAL_REDUCTION",
]);
const HASH64=/^[0-9a-f]{64}$/i;
const SAFE_ID=/^[A-Za-z0-9._:/#-]{1,240}$/;
const SYMBOL=/^[A-Z0-9._:-]{1,64}$/;
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
function canonicalIso(value,name){
  const text=String(value??"");
  if(!ISO.test(text)||!Number.isFinite(Date.parse(text))||new Date(text).toISOString()!==text){
    throw new TypeError(`${name}_INVALID`);
  }
  return text;
}
function safeId(value,name){
  const text=String(value??"").trim();
  if(!SAFE_ID.test(text)) throw new TypeError(`${name}_INVALID`);
  return text;
}
function exactKeys(value,wanted,code){
  const keys=Object.keys(value).sort();
  const expected=[...wanted].sort();
  if(keys.length!==expected.length||keys.some((key,index)=>key!==expected[index])){
    throw new Error(code);
  }
}

export function createStockCorporateActionsEvidenceV1(raw={}){
  const market=String(raw.market??"").trim().toUpperCase();
  if(!MARKETS.has(market)) throw new TypeError("STOCK_CORPORATE_ACTIONS_MARKET_INVALID");
  if(raw.sourceKind!=="OFFICIAL_CORPORATE_ACTION_HISTORY"){
    throw new Error("OFFICIAL_CORPORATE_ACTION_HISTORY_SOURCE_REQUIRED");
  }
  const sourceId=safeId(raw.sourceId,"CORPORATE_ACTION_SOURCE_ID");
  const sourceDigest=String(raw.sourceDigest??"").trim().toLowerCase();
  if(!HASH64.test(sourceDigest)) throw new TypeError("CORPORATE_ACTION_SOURCE_DIGEST_INVALID");
  const observedAt=canonicalIso(raw.observedAt,"OBSERVED_AT");
  const coverageStartTime=positiveTimestamp(raw.coverageStartTime,"COVERAGE_START_TIME");
  const coverageEndTime=positiveTimestamp(raw.coverageEndTime,"COVERAGE_END_TIME");
  if(coverageEndTime<=coverageStartTime) throw new Error("CORPORATE_ACTION_COVERAGE_RANGE_INVALID");
  if(coverageEndTime>Date.parse(observedAt)) throw new Error("CORPORATE_ACTION_FUTURE_COVERAGE_FORBIDDEN");
  if(raw.complete!==true) throw new Error("CORPORATE_ACTION_COMPLETENESS_REQUIRED");
  if(raw.pointInTimeMode!=="EVENT_TIME_ONLY") throw new Error("CORPORATE_ACTION_POINT_IN_TIME_MODE_REQUIRED");
  if(!Array.isArray(raw.symbols)||raw.symbols.length===0){
    throw new TypeError("CORPORATE_ACTION_SYMBOLS_INVALID");
  }

  const normalizedSymbols=[];
  let previousSymbol=null;
  for(const rawSymbol of raw.symbols){
    if(!rawSymbol||typeof rawSymbol!=="object"||Array.isArray(rawSymbol)){
      throw new TypeError("CORPORATE_ACTION_SYMBOL_ROW_INVALID");
    }
    exactKeys(rawSymbol,["symbol","sourceId","complete","coverageStartTime","coverageEndTime","events"],
      "CORPORATE_ACTION_SYMBOL_ROW_SHAPE_INVALID");
    const symbol=String(rawSymbol.symbol??"").trim().toUpperCase();
    if(!SYMBOL.test(symbol)) throw new TypeError("CORPORATE_ACTION_SYMBOL_INVALID");
    if(previousSymbol!==null&&symbol<=previousSymbol) throw new Error("CORPORATE_ACTION_SYMBOL_ORDER_INVALID");
    previousSymbol=symbol;
    if(rawSymbol.sourceId!==sourceId) throw new Error("CORPORATE_ACTION_SYMBOL_SOURCE_MISMATCH");
    if(rawSymbol.complete!==true) throw new Error("CORPORATE_ACTION_SYMBOL_COMPLETENESS_REQUIRED");
    const symbolStart=positiveTimestamp(rawSymbol.coverageStartTime,"SYMBOL_COVERAGE_START_TIME");
    const symbolEnd=positiveTimestamp(rawSymbol.coverageEndTime,"SYMBOL_COVERAGE_END_TIME");
    if(symbolStart!==coverageStartTime||symbolEnd!==coverageEndTime){
      throw new Error("CORPORATE_ACTION_SYMBOL_COVERAGE_MISMATCH");
    }
    if(!Array.isArray(rawSymbol.events)) throw new TypeError("CORPORATE_ACTION_EVENTS_INVALID");

    const events=[];
    let previousEventKey=null;
    const ids=new Set();
    for(const rawEvent of rawSymbol.events){
      if(!rawEvent||typeof rawEvent!=="object"||Array.isArray(rawEvent)){
        throw new TypeError("CORPORATE_ACTION_EVENT_INVALID");
      }
      exactKeys(rawEvent,[
        "actionId","symbol","actionType","knownAt","effectiveTime","eventDigest","sourceId",
      ],"CORPORATE_ACTION_EVENT_SHAPE_INVALID");
      const actionId=safeId(rawEvent.actionId,"CORPORATE_ACTION_ID");
      if(ids.has(actionId)) throw new Error("CORPORATE_ACTION_EVENT_DUPLICATE_ID");
      ids.add(actionId);
      if(String(rawEvent.symbol??"").trim().toUpperCase()!==symbol){
        throw new Error("CORPORATE_ACTION_EVENT_SYMBOL_MISMATCH");
      }
      if(rawEvent.sourceId!==sourceId) throw new Error("CORPORATE_ACTION_EVENT_SOURCE_MISMATCH");
      const actionType=String(rawEvent.actionType??"").trim().toUpperCase();
      if(!ACTIONS.has(actionType)) throw new Error("CORPORATE_ACTION_TYPE_INVALID");
      const knownAt=positiveTimestamp(rawEvent.knownAt,"CORPORATE_ACTION_KNOWN_AT");
      const effectiveTime=positiveTimestamp(rawEvent.effectiveTime,"CORPORATE_ACTION_EFFECTIVE_TIME");
      if(effectiveTime<coverageStartTime||effectiveTime>coverageEndTime){
        throw new Error("CORPORATE_ACTION_EVENT_OUTSIDE_COVERAGE");
      }
      if(knownAt>effectiveTime) throw new Error("CORPORATE_ACTION_FUTURE_KNOWLEDGE_FORBIDDEN");
      const eventDigest=String(rawEvent.eventDigest??"").trim().toLowerCase();
      if(!HASH64.test(eventDigest)) throw new TypeError("CORPORATE_ACTION_EVENT_DIGEST_INVALID");
      const eventKey=`${String(effectiveTime).padStart(16,"0")}|${actionId}`;
      if(previousEventKey!==null&&eventKey<=previousEventKey){
        throw new Error("CORPORATE_ACTION_EVENT_ORDER_INVALID");
      }
      previousEventKey=eventKey;
      events.push(Object.freeze({
        actionId,
        symbol,
        actionType,
        knownAt,
        effectiveTime,
        eventDigest,
        sourceId,
      }));
    }
    normalizedSymbols.push(Object.freeze({
      symbol,
      sourceId,
      complete:true,
      coverageStartTime,
      coverageEndTime,
      events:Object.freeze(events),
    }));
  }

  const core={
    schemaVersion:1,
    contract:STOCK_CORPORATE_ACTIONS_EVIDENCE_CONTRACT_V1,
    market,
    sourceKind:"OFFICIAL_CORPORATE_ACTION_HISTORY",
    sourceId,
    sourceDigest,
    observedAt,
    coverageStartTime,
    coverageEndTime,
    complete:true,
    pointInTimeMode:"EVENT_TIME_ONLY",
    symbols:Object.freeze(normalizedSymbols),
    safeguards:Object.freeze({
      generatedCorporateActionsAllowed:false,
      missingSymbolAssumptionAllowed:false,
      futureActionBackAdjustmentAllowed:false,
      currentSnapshotOnlyAllowed:false,
      syntheticCorporateActionsAllowed:false,
      liveTradingAllowed:false,
      privateAccountRequestAllowed:false,
      executionAuthority:"NONE",
    }),
  };
  return Object.freeze({...core,evidenceDigest:digest(core)});
}
