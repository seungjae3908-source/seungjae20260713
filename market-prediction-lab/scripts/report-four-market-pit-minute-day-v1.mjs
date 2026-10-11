#!/usr/bin/env node
/**
 * OFFLINE aggregate of all 20-member PIT->minute source audit pages.
 *
 * node scripts/report-four-market-pit-minute-day-v1.mjs \
 * --market CRYPTO_SPOT --day 2025-10-09 \
 * --manifest /private/historic-pit.json \
 * --page-index /private/page-index.json \
 * --output /private/report-2025-10-09.json
 *
 * Page index: {"pageReceiptFiles":["/private/offset-0.json",...]}.
 * For stock date-sessions supply --stock-calendar /private/sessions.json.
 * Does not fetch prices, access secrets or DB, deploy, or trade.
 */
import { lstatSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeHistoricalPITMinuteDayPagesV1 } from
  "../src/four-market-pit-minute-day-ledger-v1.js";

const FIELDS=new Set(["--market","--day","--manifest","--page-index",
  "--stock-calendar","--output"]);
const REQUIRED=["--market","--day","--manifest","--page-index","--output"];
function absolute(path) {
  return typeof path==="string" && isAbsolute(path) && resolve(path)===path;
}
function privateInput(path, limit) {
  const st=lstatSync(path);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1
    ||(st.mode&0o077)!==0||st.size<2||st.size>limit)
    throw new TypeError("PIT_MINUTE_DAY_PRIVATE_INPUT_REQUIRED");
  return JSON.parse(readFileSync(path,"utf8"));
}
function rejectSymlinkParents(path) {
  let current=dirname(path);
  while(true) {
    try{
      const st=lstatSync(current);
      if(st.isSymbolicLink()||!st.isDirectory())
        throw new TypeError("PIT_MINUTE_DAY_UNSAFE_PARENT");
    }catch(error){if(error?.code!=="ENOENT")throw error;}
    const next=dirname(current);
    if(current===next)break;
    current=next;
  }
}
export function parsePITMinuteDayArgsV1(args=[]) {
  if(!Array.isArray(args)||args.length<10||args.length>12
    ||args.length%2!==0)
    throw new TypeError("PIT_MINUTE_DAY_CLI_ARGUMENTS_INVALID");
  const x={};
  for(let i=0;i<args.length;i+=2) {
    if(!FIELDS.has(args[i])||Object.hasOwn(x,args[i])
      ||typeof args[i+1]!=="string"||!args[i+1].trim()
      ||args[i+1].startsWith("--"))
      throw new TypeError("PIT_MINUTE_DAY_CLI_OPTION_INVALID");
    x[args[i]]=args[i+1];
  }
  if(!REQUIRED.every(k=>Object.hasOwn(x,k))
    ||!absolute(x["--manifest"])||!absolute(x["--page-index"])
    ||!absolute(x["--output"])
    ||(x["--stock-calendar"]!=null&&!absolute(x["--stock-calendar"]))
    ||new Set([x["--manifest"],x["--page-index"],x["--output"],
      x["--stock-calendar"]].filter(Boolean)).size
      !==[x["--manifest"],x["--page-index"],x["--output"],
      x["--stock-calendar"]].filter(Boolean).length)
    throw new TypeError("PIT_MINUTE_DAY_CLI_PATHS_INVALID");
  return Object.freeze({
    market:x["--market"],day:x["--day"],manifestPath:x["--manifest"],
    pageIndexPath:x["--page-index"],
    stockCalendarPath:x["--stock-calendar"]??null,
    outputPath:x["--output"],
  });
}
export function runPITMinuteDayCliV1(config) {
  if(!config||!absolute(config.outputPath)
    ||!absolute(config.manifestPath)||!absolute(config.pageIndexPath))
    throw new TypeError("PIT_MINUTE_DAY_CLI_CONFIG_INVALID");
  try{lstatSync(config.outputPath);throw new TypeError("PIT_MINUTE_DAY_OUTPUT_ALREADY_EXISTS");}
  catch(e){if(e?.code!=="ENOENT")throw e;}
  for(const p of [config.outputPath,config.manifestPath,config.pageIndexPath,
    config.stockCalendarPath].filter(Boolean))rejectSymlinkParents(p);
  const manifest=privateInput(config.manifestPath,64*1024*1024);
  const index=privateInput(config.pageIndexPath,2*1024*1024);
  if(!index||Object.keys(index).length!==1
    ||!Array.isArray(index.pageReceiptFiles)
    ||index.pageReceiptFiles.length<1||index.pageReceiptFiles.length>2500
    ||index.pageReceiptFiles.some(p=>!absolute(p)
      ||p===config.outputPath||p===config.manifestPath
      ||p===config.pageIndexPath||p===config.stockCalendarPath)
    ||new Set(index.pageReceiptFiles).size!==index.pageReceiptFiles.length)
    throw new TypeError("PIT_MINUTE_DAY_PAGE_INDEX_INVALID");
  const stockCalendar=config.stockCalendarPath
    ?privateInput(config.stockCalendarPath,8*1024*1024):null;
  const pages=index.pageReceiptFiles.map(path=>{
    rejectSymlinkParents(path);
    return privateInput(path,512*1024);
  });
  const result=summarizeHistoricalPITMinuteDayPagesV1({
    market:config.market,day:config.day,manifest,stockCalendar,pages,
  });
  rejectSymlinkParents(config.outputPath);
  mkdirSync(dirname(config.outputPath),{recursive:true,mode:0o700});
  writeFileSync(config.outputPath,JSON.stringify(result,null,2)+"\n",
    {mode:0o600,flag:"wx"});
  return Object.freeze({
    status:result.status,reason:result.reason??null,
    market:config.market,tradingDate:config.day,
    completeDayPageAudit:result.completeDayPageAudit??false,
    inspectedPITMemberCount:result.inspectedPITMemberCount??null,
    missingSourceMembers:result.missingSourceMembers??null,
    archiveReceiptPageCount:result.archiveReceiptPageCount??null,
    fullMarketOpportunityDenominatorVerified:false,
    trueMarketWideRecall:null,profitabilityProven:false,
    executionAuthority:"NONE",
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  process.stdout.write(JSON.stringify(
    runPITMinuteDayCliV1(parsePITMinuteDayArgsV1(process.argv.slice(2))))+"\n");
}
