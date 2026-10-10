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
import {readFileSync,statSync,mkdirSync,writeFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {auditFourMarketHistoricalWholeUniverseV1}
 from "../src/four-market-whole-pit-price-coverage-v1.js";
// Exactly the fixed 3-year daily benchmark period used by the existing
// run-us-daily-opportunity-scanner-3y-v1.py, NOT the six-symbol 2026-10-09 QA.
// A UTC calendar date is not proof that every contract was live/tradable.
export const THREE_YEAR_UTC_DATE_SCOPE_V1=Object.freeze({
  startMs:Date.parse("2023-09-26T00:00:00.000Z"),
  endExclusiveMs:Date.parse("2026-09-26T00:00:00.000Z"),
  originalDailyBenchmarkInclusiveEndDate:"2026-09-25",
});
export function fixedHistoricalCryptoUtcDatesV1(){
 const days=[];
 for(let ts=THREE_YEAR_UTC_DATE_SCOPE_V1.startMs;
     ts<THREE_YEAR_UTC_DATE_SCOPE_V1.endExclusiveMs;ts+=86_400_000)
   days.push(ts);
 if(days.length>1100 || days.length<1090)
   throw new Error("PIT_CRYPTO_HISTORY_DATE_COUNT_INVALID");
 return {
   CRYPTO_SPOT:[...days],CRYPTO_FUTURES:[...days],
 };
}
export function reportFourWholePITReadinessV1(raw=null){
 // KR and US calendars require official historical venue sessions.
 // Crypto trades 24/7 but historic CONTRACT/PAIR membership remains UNKNOWN.
 // Supplying a historical archive overrides these source-free defaults.
 return auditFourMarketHistoricalWholeUniverseV1(raw??{
   requestedTradingDaysByMarket:fixedHistoricalCryptoUtcDatesV1(),
   dailyReceiptsByMarket:{},
 });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const inputPath=process.argv[2]??null;
 const outputPath=resolve(process.argv[3]??
  "market-prediction-lab/docs/four-market-whole-pit-price-readiness-v1.json");
 let raw=null;
 if(inputPath){
  const path=resolve(inputPath);
  if(statSync(path).size>8*1024*1024)
    throw new Error("PIT_CHUNK_SOURCE_FILE_TOO_LARGE");
  raw=JSON.parse(readFileSync(path,"utf8"));
 }
 const result=reportFourWholePITReadinessV1(raw);
 mkdirSync(dirname(outputPath),{recursive:true});
 writeFileSync(outputPath,JSON.stringify(result,null,2)+"\n",{mode:0o600});
 process.stdout.write(JSON.stringify({
  status:"TRUTH_BOUNDARY_RESEARCH_ONLY",scope:result.scope,
  markets:Object.fromEntries(Object.entries(result.markets).map(([m,x])=>[
    m,{status:x.status,reason:x.reason,requestedTradingDays:x.requestedTradingDays,
      sourceAttestedPriceJoinedDays:x.sourceAttestedPriceJoinedDays},
  ])),
  historicalFullMarketOpportunityDenominatorVerified:false,
  trueMarketWideRecall:null,profitabilityProven:false,executionAuthority:"NONE",
 })+"\n");
}
