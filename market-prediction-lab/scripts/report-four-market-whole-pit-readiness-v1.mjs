#!/usr/bin/env node
/** 
 * Read-only, date-chunked whole-market PIT + native daily-bar readiness.
 * Zero input means BLOCKED; synthetic data and current ticker snapshots are
 * never treated as the historical 3-year universe. No API/secret/DB/orders.
 *
 * node report-four-market-whole-pit-readiness-v1.mjs [input.json] [output.json]
 * Input: {requestedTradingDaysByMarket:{MARKET:[utcDayStartMs...]},
 *         dailyReceiptsByMarket:{MARKET:{"<utcDayStartMs>":
 *           {manifest:{...},dailySource:{...}}}}}
 */
import {readFileSync,lstatSync,mkdirSync,writeFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {auditFourMarketHistoricalWholeUniverseV1,
 WHOLE_MARKET_BENCHMARK_WINDOW_V1}
 from "../src/four-market-whole-pit-price-coverage-v1.js";
import {selectedCryptoUtcDaysV1,resolveSelectedResearchWindowV1}
 from "../src/research-selected-window-v1.js";
// Exactly the fixed 3-year daily benchmark period used by the existing
// run-us-daily-opportunity-scanner-3y-v1.py, NOT the six-symbol 2026-10-09 QA.
// A UTC calendar date is not proof that every contract was live/tradable.
export const THREE_YEAR_UTC_DATE_SCOPE_V1=Object.freeze({
  startMs:WHOLE_MARKET_BENCHMARK_WINDOW_V1.startMs,
  endExclusiveMs:WHOLE_MARKET_BENCHMARK_WINDOW_V1.endExclusiveMs,
  originalDailyBenchmarkInclusiveEndDate:"2026-09-25",
});
export function fixedHistoricalCryptoUtcDatesV1(){
 const dates=selectedCryptoUtcDaysV1();
 if(dates.CRYPTO_SPOT.length!==
     WHOLE_MARKET_BENCHMARK_WINDOW_V1.expectedCryptoUtcDayCount)
   throw new Error("PIT_CRYPTO_HISTORY_DATE_COUNT_INVALID");
 return {CRYPTO_SPOT:[...dates.CRYPTO_SPOT],
   CRYPTO_FUTURES:[...dates.CRYPTO_FUTURES]};
}
export function selectedHistoricalCryptoUtcDatesV1(researchWindow){
 return selectedCryptoUtcDaysV1(researchWindow);
}
export function reportFourWholePITReadinessV1(raw=null){
 // Selected dates are user-controlled; null retains the old regression only.
 const selected=resolveSelectedResearchWindowV1(raw?.researchWindow??null);
 const fixed=selectedHistoricalCryptoUtcDatesV1(raw?.researchWindow??null);
 if(raw!=null&&(typeof raw!=="object"||Array.isArray(raw)))
   throw new TypeError("PIT_BENCHMARK_SOURCE_NOT_AN_OBJECT");
 const submitted=raw?.requestedTradingDaysByMarket??{};
 if(submitted===null||typeof submitted!=="object"||Array.isArray(submitted))
   throw new TypeError("PIT_BENCHMARK_CALENDAR_SCHEMA_INVALID");
 const overridden={};
 for(const market of ["CRYPTO_SPOT","CRYPTO_FUTURES"]){
   const dates=submitted[market];
   if(dates!=null&&!Array.isArray(dates))
     throw new TypeError("PIT_BENCHMARK_CRYPTO_DATE_SCOPE_INVALID");
   overridden[market]=dates!=null&&(
     dates.length!==fixed[market].length||
     dates.some((day,i)=>day!==fixed[market][i]));
 }
 const audit=auditFourMarketHistoricalWholeUniverseV1({
   requestedTradingDaysByMarket:{...submitted,...fixed},
   dailyReceiptsByMarket:raw?.dailyReceiptsByMarket??{},
   researchWindow:raw?.researchWindow??null,
 });
 return Object.freeze({...audit,
   selectedResearchStartUtc:selected.startDate,
   selectedResearchEndInclusiveUtc:selected.endDate,
   partialCallerCryptoCalendarIgnored:overridden,
 });
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const inputPath=process.argv[2]??null;
 const outputPath=resolve(process.argv[3]??
  "market-prediction-lab/docs/four-market-whole-pit-price-readiness-v1.json");
 let raw=null;
 if(inputPath){
  const path=resolve(inputPath);
  if(path===outputPath)
    throw new Error("PIT_PRIVATE_SOURCE_DESTINATION_IDENTICAL");
  const st=lstatSync(path);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1
    ||st.size<=0||st.size>64*1024*1024||(st.mode&0o077)!==0)
    throw new Error("PIT_CHUNK_PRIVATE_INPUT_UNSAFE");
  raw=JSON.parse(readFileSync(path,"utf8"));
 }
 const result=reportFourWholePITReadinessV1(raw);
 mkdirSync(dirname(outputPath),{recursive:true});
 writeFileSync(outputPath,JSON.stringify(result,null,2)+"\n",
   {mode:0o600,flag:"wx"});
 process.stdout.write(JSON.stringify({
  status:"TRUTH_BOUNDARY_RESEARCH_ONLY",scope:result.scope,
  markets:Object.fromEntries(Object.entries(result.markets).map(([m,x])=>[
    m,{status:x.status,reason:x.reason,requestedTradingDays:x.requestedTradingDays,
      sourceAttestedPriceJoinedDays:x.sourceAttestedPriceJoinedDays},
  ])),
  historicalFullMarketOpportunityDenominatorVerified:false,
  allMarketsFullBenchmarkPeriodSourceAttestedPriceJoined:
    result.allMarketsFullBenchmarkPeriodSourceAttestedPriceJoined,
  trueMarketWideRecall:null,profitabilityProven:false,executionAuthority:"NONE",
 })+"\n");
}
