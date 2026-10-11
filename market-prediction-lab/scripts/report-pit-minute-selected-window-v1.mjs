#!/usr/bin/env node
/**
 * OFFLINE read-only 1-31-date PIT+native 1m source inventory chunk.
 *
 * node market-prediction-lab/scripts/report-pit-minute-selected-window-v1.mjs
 *   --market CRYPTO_SPOT --start-date 2020-01-01 --end-date 2026-10-01
 *   --day-index /private/window/day-files.json
 *   --chunk-days 7 --output /private/window/report-2020-01-01.json
 *
 * Resume with --cursor-date <nextCursorDate> and a DIFFERENT new output.
 * Stock dates are exchange-local and require --stock-dates
 * /private/official-schedule-input.json (caller supplied, not verified).
 * day-files: {"dateSources":[{"date":"2020-01-01","market":"CRYPTO_SPOT",
 *  "manifestPath":"/private/manifest.json",
 *  "pageIndexPath":"/private/pages-index.json"}]}
 * pages-index: {"pageReceiptFiles":["/private/day-page-0.json",...]}
 *
 * Does NOT authenticate licensing, fetch a provider, write DB, activate a
 * cron/worker, create orders, deploy or supply true PIT/OOS returns.
 */
import { lstatSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditPITMinuteSelectedWindowChunkV1 } from
  "../src/four-market-pit-minute-selected-window-v1.js";

const FLAGS = new Set(["--market","--start-date","--end-date",
  "--cursor-date","--chunk-days","--day-index","--stock-dates","--output"]);
const REQUIRED = ["--market","--start-date","--end-date","--day-index","--output"];
const MAX_TOTAL_PAGES = 256;
const abs = v => typeof v==="string" && isAbsolute(v) && resolve(v)===v;
function parentSafe(path) {
  let p=dirname(path);
  while(true) {
    try {
      const st=lstatSync(p);
      if(st.isSymbolicLink()||!st.isDirectory())
        throw new TypeError("PIT_MINUTE_WINDOW_CLI_UNSAFE_PARENT");
    } catch(e) { if(e?.code!=="ENOENT")throw e; }
    const next=dirname(p);
    if(next===p)break;
    p=next;
  }
}
function readPrivate(path, maxBytes) {
  parentSafe(path);
  const st=lstatSync(path);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1
    ||(st.mode&0o077)!==0 || st.size<2 || st.size>maxBytes)
    throw new TypeError("PIT_MINUTE_WINDOW_CLI_PRIVATE_FILE_REQUIRED");
  return JSON.parse(readFileSync(path,"utf8"));
}
export function parsePITMinuteWindowArgsV1(args=[]) {
  if(!Array.isArray(args)||args.length<10||args.length>16
    ||args.length%2!==0)
    throw new TypeError("PIT_MINUTE_WINDOW_CLI_ARGS_INVALID");
  const input={};
  for(let i=0;i<args.length;i+=2){
    const key=args[i], value=args[i+1];
    if(!FLAGS.has(key)||Object.hasOwn(input,key)
      ||typeof value!=="string"||!value.trim()||value.startsWith("--"))
      throw new TypeError("PIT_MINUTE_WINDOW_CLI_OPTION_INVALID");
    input[key]=value;
  }
  if(!REQUIRED.every(k=>Object.hasOwn(input,k))
    ||![input["--day-index"],input["--output"],
      input["--stock-dates"]].filter(Boolean).every(abs)
    ||new Set([input["--day-index"],input["--output"],
      input["--stock-dates"]].filter(Boolean)).size !==
      [input["--day-index"],input["--output"],
        input["--stock-dates"]].filter(Boolean).length
    ||!/^(?:[1-9]|[12][0-9]|3[01])$/u.test(input["--chunk-days"]??"7"))
    throw new TypeError("PIT_MINUTE_WINDOW_CLI_SCOPE_INVALID");
  return Object.freeze({
    market:input["--market"],
    researchWindow:{startDate:input["--start-date"],
      endDate:input["--end-date"]},
    cursorDate:input["--cursor-date"]??null,
    chunkCalendarDays:Number(input["--chunk-days"]??"7"),
    dayIndexPath:input["--day-index"],
    stockDatesPath:input["--stock-dates"]??null,
    outputPath:input["--output"],
  });
}
export function runPITMinuteWindowCliV1(config) {
  if(!config||!abs(config.outputPath)||!abs(config.dayIndexPath))
    throw new TypeError("PIT_MINUTE_WINDOW_CLI_CONFIG_INVALID");
  try { lstatSync(config.outputPath);
    throw new TypeError("PIT_MINUTE_WINDOW_CLI_OUTPUT_ALREADY_EXISTS");
  } catch(e) { if(e?.code!=="ENOENT")throw e; }
  parentSafe(config.outputPath);
  const index=readPrivate(config.dayIndexPath,4*1024*1024);
  if(!index||Object.keys(index).length!==1
    ||!Array.isArray(index.dateSources)||index.dateSources.length>31)
    throw new TypeError("PIT_MINUTE_WINDOW_CLI_DAY_INDEX_INVALID");
  const stockDates=config.stockDatesPath===null?null:
    readPrivate(config.stockDatesPath,2*1024*1024);
  if(stockDates!==null&&(stockDates.market!==config.market
    ||!Array.isArray(stockDates.tradingDates)
    ||Object.keys(stockDates).length!==2))
    throw new TypeError("PIT_MINUTE_WINDOW_CLI_STOCK_CALENDAR_INVALID");
  const dateSources=[], pathRoles=new Map(
    [config.dayIndexPath,config.stockDatesPath,config.outputPath]
      .filter(Boolean).map(path=>[path,"reserved"]));
  const claim=(path,role,mayRepeat=false)=>{
    const existing=pathRoles.get(path);
    if(existing && (existing!==role || !mayRepeat))
      throw new TypeError("PIT_MINUTE_WINDOW_CLI_DUPLICATE_FILE_PATH");
    pathRoles.set(path,role);
  };
  let pageCount=0;
  for(const record of index.dateSources){
    if(!record||typeof record!=="object"
      ||!["date","market","manifestPath","pageIndexPath",
        "stockCalendarPath"].every(k=>Object.keys(record).includes(k)
          ||k==="stockCalendarPath")
      ||Object.keys(record).some(k=>!["date","market","manifestPath",
        "pageIndexPath","stockCalendarPath"].includes(k))
      ||record.market!==config.market
      ||!abs(record.manifestPath)||!abs(record.pageIndexPath)
      ||(record.stockCalendarPath!=null&&!abs(record.stockCalendarPath)))
      throw new TypeError("PIT_MINUTE_WINDOW_CLI_DAY_SOURCE_INVALID");
    // The historical PIT membership source is commonly one FULL-WINDOW
    // archive, intentionally reused by many days. Page-index / receipt
    // files must remain unique; different input roles cannot alias files.
    claim(record.manifestPath,"pit-manifest",true);
    claim(record.pageIndexPath,"page-index");
    if(record.stockCalendarPath)
      claim(record.stockCalendarPath,"stock-calendar",true);
    const manifest=readPrivate(record.manifestPath,64*1024*1024);
    const pagelist=readPrivate(record.pageIndexPath,2*1024*1024);
    if(!pagelist||Object.keys(pagelist).length!==1
      ||!Array.isArray(pagelist.pageReceiptFiles)
      ||pagelist.pageReceiptFiles.length<1
      ||pagelist.pageReceiptFiles.length>2500)
      throw new TypeError("PIT_MINUTE_WINDOW_CLI_PAGE_INDEX_INVALID");
    pageCount+=pagelist.pageReceiptFiles.length;
    if(pageCount>MAX_TOTAL_PAGES)
      throw new TypeError("PIT_MINUTE_WINDOW_CLI_PAGE_BUDGET_EXCEEDED");
    if(pagelist.pageReceiptFiles.some(p=>!abs(p))
      ||new Set(pagelist.pageReceiptFiles).size!==pagelist.pageReceiptFiles.length)
      throw new TypeError("PIT_MINUTE_WINDOW_CLI_PAGE_FILE_INVALID");
    pagelist.pageReceiptFiles.forEach(p=>claim(p,"minute-page"));
    const pages=pagelist.pageReceiptFiles.map(p=>readPrivate(p,512*1024));
    const stockCalendar=record.stockCalendarPath==null?null:
      readPrivate(record.stockCalendarPath,8*1024*1024);
    dateSources.push({date:record.date,market:record.market,
      manifest,pages,stockCalendar});
  }
  const result=auditPITMinuteSelectedWindowChunkV1({
    market:config.market,researchWindow:config.researchWindow,
    cursorDate:config.cursorDate,chunkCalendarDays:config.chunkCalendarDays,
    stockTradingDates:stockDates?.tradingDates??null,dateSources,
  });
  parentSafe(config.outputPath);
  mkdirSync(dirname(config.outputPath),{recursive:true,mode:0o700});
  writeFileSync(config.outputPath,JSON.stringify(result,null,2)+"\n",
    {encoding:"utf8",mode:0o600,flag:"wx"});
  return Object.freeze({
    status:result.status,reason:result.reason??null,
    market:config.market,inspectedStartDate:result.inspectedStartDate,
    inspectedEndDate:result.inspectedEndDate,
    nextCursorDate:result.nextCursorDate,
    requestedTradingDays:result.requestedTradingDays??null,
    locallyCompleteMinuteSourceDays:result.locallyCompleteMinuteSourceDays??0,
    missingDaySourceCount:result.missingDaySourceCount??null,
    sourceMinuteRows:result.totals?.sourceMinuteRows??null,
    fullMarketOpportunityDenominatorVerified:false,
    trueMarketWideRecall:null,profitabilityProven:false,
    executionAuthority:"NONE",
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const a=parsePITMinuteWindowArgsV1(process.argv.slice(2));
  process.stdout.write(JSON.stringify(runPITMinuteWindowCliV1(a))+"\n");
}
