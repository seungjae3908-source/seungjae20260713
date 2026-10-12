#!/usr/bin/env node
/**
 * Run at most ONE source-gap task, using a freshly validated full day PIT
 * receipt and exact reviewed candidate-page digest. DRY-RUN by default.
 *
 * node scripts/run-pit-minute-gap-task-v1.mjs
 *   --market CRYPTO_SPOT --day 2026-09-18
 *   --manifest /private/pit.json --page-index /private/receipt-index.json
 *   --root /private/minute-archive --task-page-index 0 --task-index 0
 *   --expected-task-digest <64-hex-from-offline-gap-plan>
 *   --output /private/receipts/pit-task-0.json
 *
 * To explicitly permit only public historical native 1m GET, add
 * --read-public. To retry a PARTIAL existing immutable archive, use
 * --retry-partial --expected-existing-sha <reviewed-archive-sha256>.
 * For a retry, --expected-task-digest MUST be the exact reviewed
 * partialRetryReviewDigestSha256, NOT candidateTaskDigestSha256 from the
 * absent-source list. Both are recalculated against the full PIT day pages.
 * A safe superset is stored as a NEW revision requiring explicit selection;
 * no automatic deployment, promotion, scheduling, Paper or LIVE/orders.
 */
import { lstatSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runPlannedPITMinuteSourceTaskV1 } from
  "../src/pit-minute-source-task-executor-v1.js";

const OPTIONS=new Set(["--market","--day","--manifest","--page-index",
  "--root","--task-page-index","--task-index","--expected-task-digest",
  "--output","--max-local-mib","--min-free-mib",
  "--expected-existing-sha"]);
const REQUIRED=["--market","--day","--manifest","--page-index","--root",
  "--task-page-index","--task-index","--expected-task-digest","--output"];
const abs = path => typeof path==="string" && isAbsolute(path)
  && resolve(path)===path;
function safeParents(path) {
  let p=dirname(path);
  while(true) {
    try {
      const st=lstatSync(p);
      if(!st.isDirectory()||st.isSymbolicLink())
        throw new TypeError("PIT_MINUTE_TASK_CLI_UNSAFE_PARENT_PATH");
    }catch(e){if(e?.code!=="ENOENT")throw e;}
    const next=dirname(p);
    if(next===p)break;
    p=next;
  }
}
function readPrivateJson(path,maxBytes) {
  const st=lstatSync(path);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1
    ||(st.mode&0o077)!==0||st.size<2||st.size>maxBytes)
    throw new TypeError("PIT_MINUTE_TASK_CLI_PRIVATE_FILE_REQUIRED");
  return JSON.parse(readFileSync(path,"utf8"));
}
export function parsePITMinuteTaskArgsV1(args=[]) {
  if(!Array.isArray(args)||args.length<18||args.length>26)
    throw new TypeError("PIT_MINUTE_TASK_CLI_ARGUMENTS_INVALID");
  const o={};let readPublic=false,retryPartial=false;
  for(let i=0;i<args.length;i++){
    if(args[i]==="--read-public"){
      if(readPublic)throw new TypeError("PIT_MINUTE_TASK_CLI_DUPLICATE_READ_FLAG");
      readPublic=true;continue;
    }
    if(args[i]==="--retry-partial"){
      if(retryPartial)throw new TypeError("PIT_MINUTE_TASK_CLI_DUPLICATE_RETRY_FLAG");
      retryPartial=true;continue;
    }
    const key=args[i], val=args[++i];
    if(!OPTIONS.has(key)||Object.hasOwn(o,key)
      ||typeof val!=="string"||!val.trim()||val.startsWith("--"))
      throw new TypeError("PIT_MINUTE_TASK_CLI_OPTION_INVALID");
    o[key]=val;
  }
  if(!REQUIRED.every(key=>Object.hasOwn(o,key))
    ||![o["--manifest"],o["--page-index"],o["--root"],
      o["--output"]].every(abs)
    ||new Set([o["--manifest"],o["--page-index"],o["--root"],
      o["--output"]]).size!==4
    ||!/^(0|[1-9][0-9]{0,3})$/u.test(o["--task-page-index"])
    ||!/^(?:[0-9]|1[0-9])$/u.test(o["--task-index"])
    ||!/^[0-9a-f]{64}$/u.test(o["--expected-task-digest"]??"")
    ||(retryPartial
      ?!readPublic||!/^[0-9a-f]{64}$/u.test(o["--expected-existing-sha"]??"")
      :Object.hasOwn(o,"--expected-existing-sha"))
    ||!/^(?:[3-9]|[1-9][0-9]{1,4})$/u.test(o["--max-local-mib"]??"2048")
    ||!/^(?:0|[1-9][0-9]{0,5})$/u.test(o["--min-free-mib"]??"2048")) {
    throw new TypeError("PIT_MINUTE_TASK_CLI_SCOPE_INVALID");
  }
  return Object.freeze({
    market:o["--market"],day:o["--day"],root:o["--root"],
    manifestPath:o["--manifest"],pageIndexPath:o["--page-index"],
    outputPath:o["--output"],
    taskPageIndex:Number(o["--task-page-index"]),
    taskIndex:Number(o["--task-index"]),
    expectedTaskDigestSha256:o["--expected-task-digest"],
    maxLocalBytes:Number(o["--max-local-mib"]??2048)*1024*1024,
    minFreeBytes:Number(o["--min-free-mib"]??2048)*1024*1024,
    allowPublicReadOnlyFetch:readPublic,
    retryPartialSource:retryPartial,
    expectedExistingSourceDigestSha256:o["--expected-existing-sha"]??null,
  });
}
export async function runPITMinuteTaskCliV1(config,dependencies={}) {
  if(!config||!abs(config.outputPath)||!abs(config.manifestPath)
    ||!abs(config.pageIndexPath)||!abs(config.root))
    throw new TypeError("PIT_MINUTE_TASK_CLI_CONFIG_INVALID");
  try {
    lstatSync(config.outputPath);
    throw new TypeError("PIT_MINUTE_TASK_CLI_OUTPUT_EXISTS");
  }catch(e){if(e?.code!=="ENOENT")throw e;}
  for(const path of [config.manifestPath,config.pageIndexPath,
    config.outputPath])safeParents(path);
  const manifest=readPrivateJson(config.manifestPath,64*1024*1024);
  const index=readPrivateJson(config.pageIndexPath,2*1024*1024);
  if(!index||Object.keys(index).length!==1
    ||!Array.isArray(index.pageReceiptFiles)
    ||index.pageReceiptFiles.length<1
    ||index.pageReceiptFiles.length>2500
    ||index.pageReceiptFiles.some(p=>!abs(p)
      ||[config.manifestPath,config.pageIndexPath,
        config.outputPath,config.root].includes(p))
    ||new Set(index.pageReceiptFiles).size!==index.pageReceiptFiles.length)
    throw new TypeError("PIT_MINUTE_TASK_CLI_PAGE_INDEX_INVALID");
  const pages=index.pageReceiptFiles.map(path=>{
    safeParents(path);
    return readPrivateJson(path,512*1024);
  });
  const result=await runPlannedPITMinuteSourceTaskV1({
    root:config.root,market:config.market,day:config.day,
    manifest,pages,
    taskPageIndex:config.taskPageIndex,taskIndex:config.taskIndex,
    expectedTaskDigestSha256:config.expectedTaskDigestSha256,
    allowPublicReadOnlyFetch:config.allowPublicReadOnlyFetch,
    retryPartialSource:config.retryPartialSource??false,
    expectedExistingSourceDigestSha256:
      config.expectedExistingSourceDigestSha256??null,
    maxLocalBytes:config.maxLocalBytes,minFreeBytes:config.minFreeBytes,
    ...(dependencies.nowImpl?{nowImpl:dependencies.nowImpl}:{}),
    ...(dependencies.statfsImpl?{statfsImpl:dependencies.statfsImpl}:{}),
    ...(dependencies.upbitFetchImpl?{upbitFetchImpl:dependencies.upbitFetchImpl}:{}),
    ...(dependencies.bitgetClient?{bitgetClient:dependencies.bitgetClient}:{}),
  });
  safeParents(config.outputPath);
  mkdirSync(dirname(config.outputPath),{recursive:true,mode:0o700});
  writeFileSync(config.outputPath,JSON.stringify(result,null,2)+"\n",
    {mode:0o600,flag:"wx"});
  return Object.freeze({
    status:result.status,reason:result.reason??null,
    market:config.market,day:config.day,
    taskPageIndex:config.taskPageIndex,taskIndex:config.taskIndex,
    sourceMinuteCount:result.retainedMinuteRows??null,
    selectedTaskKind:result.selectedTaskKind??null,
    proposedNewSourceDigestSha256:result.retainedSourceDigestSha256??null,
    priorSourceDigestSha256:result.priorSourceDigestSha256??null,
    sourceRevisionAutoSelected:false,
    readPublicExplicitlyRequested:config.allowPublicReadOnlyFetch,
    fullMarketOpportunityDenominatorVerified:false,
    trueMarketWideRecall:null,profitabilityProven:false,
    executionAuthority:"NONE",
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const config=parsePITMinuteTaskArgsV1(process.argv.slice(2));
  process.stdout.write(JSON.stringify(await runPITMinuteTaskCliV1(config))+"\n");
}
