#!/usr/bin/env node
/**
 * OFFLINE & read-only research operations (no original provider GET):
 *
 * First, seal an already STRICTLY validated full-PIT day report:
 * node scripts/report-pit-minute-compact-period-v1.mjs --mode seal
 *   --market CRYPTO_SPOT --day 2026-09-18
 *   --day-report /private/day-2026-09-18.json
 *   --manifest /private/pit-historic.json
 *   --output /private/compact-day-2026-09-18.json
 *
 * Next, read up to 31 COMPACT days (not raw 20-symbol page receipts):
 * node scripts/report-pit-minute-compact-period-v1.mjs --mode window
 *   --market CRYPTO_SPOT --start-date 2016-01-01 --end-date 2026-09-30
 *   --day-index /private/compact-index.json --chunk-days 31
 *   --output /private/window-2016-01-01.json
 *
 * Repeat with --cursor-date from the returned nextCursorDate.
 * Index format: {"compactDayReceiptFiles":["/private/day1.json", ...]}.
 * Stock markets also require caller supplied --stock-dates calendar JSON:
 * {"market":"KR_STOCK","tradingDates":["2026-09-18",...]}.
 *
 * SHA-256 catches local accidental modifications, NOT forged publisher data,
 * license authenticity, contemporaneous scanner signals, profits or fills.
 */
import { lstatSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sealPITMinuteDayCompactReceiptV1,
  auditCompactPITMinuteSelectedWindowChunkV1,
} from "../src/four-market-pit-minute-compact-selected-window-v1.js";

const FIELDS=new Set(["--mode","--market","--day","--day-report",
  "--manifest","--start-date","--end-date","--cursor-date","--chunk-days",
  "--day-index","--stock-dates","--output"]);
const abs=value=>typeof value==="string"&&isAbsolute(value)
  &&resolve(value)===value;
function checkParents(path){
  let at=dirname(path);
  while(true) {
    try {
      const st=lstatSync(at);
      if(st.isSymbolicLink()||!st.isDirectory())
        throw new TypeError("PIT_COMPACT_CLI_SYMLINKED_OR_INVALID_PARENT");
    }catch(error){if(error?.code!=="ENOENT")throw error;}
    const next=dirname(at);if(next===at)break;at=next;
  }
}
function readPrivate(path,max){
  checkParents(path);
  const st=lstatSync(path);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1
    ||(st.mode&0o077)!==0||st.size<2||st.size>max)
    throw new TypeError("PIT_COMPACT_CLI_PRIVATE_INPUT_REQUIRED");
  return JSON.parse(readFileSync(path,"utf8"));
}
export function parsePITMinuteCompactArgsV1(args=[]){
  if(!Array.isArray(args)||args.length<10||args.length>18
    ||args.length%2!==0)
    throw new TypeError("PIT_COMPACT_CLI_ARGUMENTS_INVALID");
  const opts={};
  for(let i=0;i<args.length;i+=2){
    const key=args[i],value=args[i+1];
    if(!FIELDS.has(key)||Object.hasOwn(opts,key)
      ||typeof value!=="string"||!value.trim()||value.startsWith("--"))
      throw new TypeError("PIT_COMPACT_CLI_OPTION_INVALID");
    opts[key]=value;
  }
  const mode=opts["--mode"],market=opts["--market"],
    outputPath=opts["--output"];
  if(!["seal","window"].includes(mode)||!market||!abs(outputPath))
    throw new TypeError("PIT_COMPACT_CLI_SCOPE_INVALID");
  if(mode==="seal"){
    const required=["--mode","--market","--day","--day-report",
      "--manifest","--output"];
    if(Object.keys(opts).length!==required.length
      ||!required.every(x=>Object.hasOwn(opts,x))
      ||!abs(opts["--day-report"])||!abs(opts["--manifest"])
      ||new Set([opts["--day-report"],opts["--manifest"],
        outputPath]).size!==3)
      throw new TypeError("PIT_COMPACT_CLI_SEAL_SCOPE_INVALID");
    return Object.freeze({mode,market,day:opts["--day"],
      dayReportPath:opts["--day-report"],
      manifestPath:opts["--manifest"],outputPath});
  }
  const allowed=["--mode","--market","--start-date","--end-date",
    "--cursor-date","--chunk-days","--day-index","--stock-dates","--output"];
  const required=["--mode","--market","--start-date","--end-date",
    "--day-index","--output"];
  if(Object.keys(opts).some(x=>!allowed.includes(x))
    ||!required.every(x=>Object.hasOwn(opts,x))
    ||!abs(opts["--day-index"])
    ||(opts["--stock-dates"]!=null&&!abs(opts["--stock-dates"]))
    ||new Set([opts["--day-index"],opts["--stock-dates"],
      outputPath].filter(Boolean)).size !==
      [opts["--day-index"],opts["--stock-dates"],
        outputPath].filter(Boolean).length
    ||!/^(?:[1-9]|[12][0-9]|3[01])$/u.test(opts["--chunk-days"]??"7"))
    throw new TypeError("PIT_COMPACT_CLI_WINDOW_SCOPE_INVALID");
  return Object.freeze({mode,market,
    researchWindow:{startDate:opts["--start-date"],
      endDate:opts["--end-date"]},
    cursorDate:opts["--cursor-date"]??null,
    chunkCalendarDays:Number(opts["--chunk-days"]??"7"),
    dayIndexPath:opts["--day-index"],
    stockDatesPath:opts["--stock-dates"]??null,
    outputPath});
}
export function runPITMinuteCompactCliV1(config){
  if(!config||!abs(config.outputPath)
    ||!["seal","window"].includes(config.mode))
    throw new TypeError("PIT_COMPACT_CLI_CONFIG_INVALID");
  try{
    lstatSync(config.outputPath);
    throw new TypeError("PIT_COMPACT_CLI_OUTPUT_ALREADY_EXISTS");
  }catch(error){if(error?.code!=="ENOENT")throw error;}
  checkParents(config.outputPath);
  let result;
  if(config.mode==="seal"){
    const summary=readPrivate(config.dayReportPath,2*1024*1024);
    const manifest=readPrivate(config.manifestPath,64*1024*1024);
    if(summary.market!==config.market||summary.tradingDate!==config.day)
      throw new TypeError("PIT_COMPACT_CLI_DAY_IDENTITY_INVALID");
    result=sealPITMinuteDayCompactReceiptV1({summary,manifest});
  }else{
    const index=readPrivate(config.dayIndexPath,2*1024*1024);
    if(!index||Object.keys(index).length!==1
      ||!Array.isArray(index.compactDayReceiptFiles)
      ||index.compactDayReceiptFiles.length>31
      ||index.compactDayReceiptFiles.some(p=>!abs(p)
        ||p===config.dayIndexPath||p===config.outputPath
        ||p===config.stockDatesPath)
      ||new Set(index.compactDayReceiptFiles).size
        !==index.compactDayReceiptFiles.length)
      throw new TypeError("PIT_COMPACT_CLI_DAY_INDEX_INVALID");
    const stock= config.stockDatesPath==null
      ?null:readPrivate(config.stockDatesPath,2*1024*1024);
    if(stock!==null&&(stock.market!==config.market
      ||!Array.isArray(stock.tradingDates)
      ||Object.keys(stock).length!==2))
      throw new TypeError("PIT_COMPACT_CLI_STOCK_DATES_INVALID");
    const dayReceipts=index.compactDayReceiptFiles
      .map(p=>readPrivate(p,128*1024));
    result=auditCompactPITMinuteSelectedWindowChunkV1({
      market:config.market,researchWindow:config.researchWindow,
      cursorDate:config.cursorDate,
      chunkCalendarDays:config.chunkCalendarDays,
      stockTradingDates:stock?.tradingDates??null,dayReceipts,
    });
  }
  checkParents(config.outputPath);
  mkdirSync(dirname(config.outputPath),{recursive:true,mode:0o700});
  writeFileSync(config.outputPath,JSON.stringify(result,null,2)+"\n",
    {encoding:"utf8",mode:0o600,flag:"wx"});
  return Object.freeze({
    status:result.status??"COMPACT_DAY_RECEIPT_SEALED_ONLY",
    market:config.market,
    mode:config.mode,
    inspectedStartDate:result.inspectedStartDate??config.day??null,
    inspectedEndDate:result.inspectedEndDate??config.day??null,
    nextCursorDate:result.nextCursorDate??null,
    expectedHistoricalTradingDays:result.expectedHistoricalTradingDays??null,
    missingSourceDays:result.missingSourceDays??null,
    loadedSourcePageReceiptsAtPeriodLevel:0,
    historicalPITUniverseIndependentlyAuthenticated:false,
    fullMarketOpportunityDenominatorVerified:false,
    trueMarketWideRecall:null,actualFillCount:null,
    profitabilityProven:false,executionAuthority:"NONE",
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  process.stdout.write(JSON.stringify(runPITMinuteCompactCliV1(
    parsePITMinuteCompactArgsV1(process.argv.slice(2))))+"\n");
}
