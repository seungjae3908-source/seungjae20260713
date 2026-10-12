#!/usr/bin/env node
/**
 * OFFLINE bounded source-gap planning from a COMPLETE PIT minute day ledger.
 * Does not GET provider data and NEVER schedules or executes a collection.
 *
 * node scripts/plan-four-market-pit-minute-gaps-v1.mjs
 *   --market CRYPTO_SPOT --day 2025-10-09
 *   --manifest /private/pit.json --page-index /private/pages-index.json
 *   --task-page-index 0 --output /private/gap-plan-0.json
 *
 * pages-index.json: {"pageReceiptFiles":["/private/page-0.json",...]}
 * For US/KR markets add --stock-calendar /private/sessions.json.
 * The plan does not authorize retroactive data licensing or redistributing
 * source rows. Upbit/Bitget GETs remain opt-in per single-symbol/day.
 */
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planPITNativeMinuteSourceGapsV1 } from
  "../src/four-market-pit-minute-gap-queue-v1.js";

const FIELDS = new Set(["--market","--day","--manifest","--page-index",
  "--task-page-index","--stock-calendar","--output"]);
const REQUIRED = ["--market","--day","--manifest","--page-index","--output"];
const absolute = value => typeof value==="string"
  && isAbsolute(value) && resolve(value)===value;
function rejectParentSymlinks(path) {
  let probe = dirname(path);
  while (true) {
    try {
      const st = lstatSync(probe);
      if (st.isSymbolicLink() || !st.isDirectory())
        throw new TypeError("PIT_GAP_PLAN_PARENT_SYMLINK_UNSAFE");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent=dirname(probe);
    if (parent===probe) break;
    probe=parent;
  }
}
function privateJson(path, maxBytes) {
  const st=lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink!==1
    || (st.mode&0o077)!==0 || st.size<2 || st.size>maxBytes)
    throw new TypeError("PIT_GAP_PLAN_PRIVATE_INPUT_REQUIRED");
  return JSON.parse(readFileSync(path,"utf8"));
}
export function parsePITMinuteGapPlanArgsV1(args=[]) {
  if (!Array.isArray(args) || args.length<10 || args.length>14
    || args.length%2!==0)
    throw new TypeError("PIT_GAP_PLAN_CLI_ARGUMENTS_INVALID");
  const v={};
  for(let i=0;i<args.length;i+=2) {
    const flag=args[i], value=args[i+1];
    if(!FIELDS.has(flag)||Object.hasOwn(v,flag)
      ||typeof value!=="string"||!value.trim()||value.startsWith("--"))
      throw new TypeError("PIT_GAP_PLAN_CLI_OPTION_INVALID");
    v[flag]=value;
  }
  if(!REQUIRED.every(flag=>Object.hasOwn(v,flag))
    ||![v["--manifest"],v["--page-index"],v["--output"],
      v["--stock-calendar"]].filter(Boolean).every(absolute)
    ||new Set([v["--manifest"],v["--page-index"],v["--output"],
      v["--stock-calendar"]].filter(Boolean)).size!==
       [v["--manifest"],v["--page-index"],v["--output"],
        v["--stock-calendar"]].filter(Boolean).length
    ||!/^(0|[1-9][0-9]{0,3})$/u.test(v["--task-page-index"]??"0"))
    throw new TypeError("PIT_GAP_PLAN_CLI_SCOPE_INVALID");
  return Object.freeze({
    market:v["--market"],day:v["--day"],
    manifestPath:v["--manifest"],pageIndexPath:v["--page-index"],
    stockCalendarPath:v["--stock-calendar"]??null,
    taskPageIndex:Number(v["--task-page-index"]??0),
    outputPath:v["--output"],
  });
}
export function runPITMinuteGapPlanCliV1(config) {
  if(!config||!absolute(config.manifestPath)
    ||!absolute(config.pageIndexPath)||!absolute(config.outputPath))
    throw new TypeError("PIT_GAP_PLAN_CLI_CONFIG_INVALID");
  try{
    lstatSync(config.outputPath);
    throw new TypeError("PIT_GAP_PLAN_OUTPUT_ALREADY_EXISTS");
  }catch(error){if(error?.code!=="ENOENT")throw error;}
  for(const path of [config.manifestPath,config.pageIndexPath,
    config.outputPath,config.stockCalendarPath].filter(Boolean))
    rejectParentSymlinks(path);
  const manifest=privateJson(config.manifestPath,64*1024*1024);
  const index=privateJson(config.pageIndexPath,2*1024*1024);
  if(!index||Object.keys(index).length!==1
    ||!Array.isArray(index.pageReceiptFiles)
    ||index.pageReceiptFiles.length<1||index.pageReceiptFiles.length>2500
    ||index.pageReceiptFiles.some(path=>!absolute(path)
      ||[config.manifestPath,config.pageIndexPath,config.outputPath,
        config.stockCalendarPath].includes(path))
    ||new Set(index.pageReceiptFiles).size!==index.pageReceiptFiles.length)
    throw new TypeError("PIT_GAP_PLAN_PAGE_INDEX_INVALID");
  const stockCalendar=config.stockCalendarPath==null?null
    :privateJson(config.stockCalendarPath,8*1024*1024);
  const pages=index.pageReceiptFiles.map(path=>{
    rejectParentSymlinks(path);
    return privateJson(path,512*1024);
  });
  const result=planPITNativeMinuteSourceGapsV1({
    market:config.market,day:config.day,manifest,stockCalendar,
    pages,taskPageIndex:config.taskPageIndex,
  });
  rejectParentSymlinks(config.outputPath);
  mkdirSync(dirname(config.outputPath),{recursive:true,mode:0o700});
  writeFileSync(config.outputPath,JSON.stringify(result,null,2)+"\n",
    {mode:0o600,flag:"wx"});
  return Object.freeze({
    status:result.status,reason:result.reason??null,
    market:config.market,tradingDate:config.day,
    taskPageIndex:result.taskPageIndex,
    nextTaskPageIndex:result.nextTaskPageIndex,
    proposedTasks:result.candidateTasks?.length??0,
    partialRetryReviewCount:result.partialRetryReviewCount??null,
    partialRetryCannotAutoExecute:true,
    totalMissingSourceSessions:result.totalMissingSourceSessions,
    autoExecuteAllowed:false,providerGETCount:0,
    trueMarketWideRecall:null,profitabilityProven:false,
    executionAuthority:"NONE",
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(
    runPITMinuteGapPlanCliV1(parsePITMinuteGapPlanArgsV1(process.argv.slice(2))))+"\n");
}
