#!/usr/bin/env node
import {open,lstat,unlink} from "node:fs/promises";
import {constants} from "node:fs";
import {dirname,isAbsolute,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {runFourMarketOriginalMinuteReplayV1} from
  "../src/four-market-original-minute-replay-v1.js";
import {planFourMarketPITReplayWorkV1} from
  "../src/four-market-pit-replay-work-queue-v1.js";
import {auditFourMarketOriginalMinuteOpportunityV1} from
  "../src/four-market-original-minute-opportunities-v1.js";
import {runFourMarketOriginalMinuteBatchV1} from
  "../src/four-market-original-minute-batch-v1.js";
import {runFourMarketOriginalMinutePeriodV1} from
  "../src/four-market-original-minute-period-v1.js";
import {runFourMarketOriginalMinuteSweepV1} from
  "../src/four-market-original-minute-sweep-v1.js";
import {importStockNativeMinuteOfflineV1} from
  "../src/stock-native-minute-offline-intake-v1.js";
import {publishResearchOriginalMinuteDiagnosticV1} from
  "../src/research-original-minute-diagnostic-publisher-v1.js";
import {reviewOriginalMinuteForCanonicalPaperV1} from
  "../src/four-market-original-minute-candidate-review-v1.js";

/**
 * ONE private local research job per invocation. No background timers,
 * no data-provider HTTP, no Paper orders, no LIVE execution, no DB.
 * PLAN / REPLAY / PERIOD / OPPORTUNITIES / BATCH / SWEEP remain READ-ONLY.
 * STOCK_IMPORT writes opted-in locally licensed original KR/US 1m to an
 * immutable private archive. PUBLISH explicitly publishes only a SANITIZED
 * completed PERIOD/SWEEP summary into an admin-configured 0700 report root;
 * replacement requires separate consent. Neither touches trading systems.
 * CANDIDATE_REVIEW invokes canonical Paper + unified profitability gates
 * with MISSING live/forward data to document blockers only. It never makes
 * a Paper candidate, real order, journal record, notification or promotion.
 * CLI audit result output is 0600, create-only, never overwritten.
 */
const fail=x=>{throw new TypeError(x);};
const PRIVATE_FILE_MAX=8*1024*1024,OUT_MAX=2*1024*1024;
async function checkParent(path){
  if(typeof path!=="string"||!isAbsolute(path)||resolve(path)!==path)
    fail("RESEARCH_REPLAY_ABSOLUTE_PATH_REQUIRED");
  const parent=dirname(path);
  const st=await lstat(parent);
  if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0)
    fail("RESEARCH_REPLAY_PRIVATE_DIRECTORY_REQUIRED");
  // Prevent a symlink inside any path ancestor, including the private root.
  let at=parent;
  while(at!==dirname(at)){
    const s=await lstat(at);
    if(s.isSymbolicLink()||!s.isDirectory())
      fail("RESEARCH_REPLAY_UNSAFE_PARENT");
    at=dirname(at);
  }
}
function refuseCredentials(value,depth=0){
  if(depth>10)fail("RESEARCH_REPLAY_TOO_DEEP");
  if(!value||typeof value!=="object")return;
  for(const [key,item] of Object.entries(value)){
    if(/(?:api.?key|password|secret|credential|authorization|access.?token|refresh.?token|bot.?token|private.?key)/iu.test(key))
      fail("RESEARCH_REPLAY_CREDENTIAL_FIELDS_FORBIDDEN");
    refuseCredentials(item,depth+1);
  }
}
async function readPrivate(path){
  await checkParent(path);
  let file;
  try{file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const st=await file.stat();
    if(!st.isFile()||st.nlink!==1||(st.mode&0o077)!==0
      ||st.size<8||st.size>PRIVATE_FILE_MAX)
      fail("RESEARCH_REPLAY_PRIVATE_INPUT_REQUIRED");
    const raw=await file.readFile("utf8");
    let data;
    try{data=JSON.parse(raw);}catch{fail("RESEARCH_REPLAY_INPUT_JSON_INVALID");}
    refuseCredentials(data);
    if(!data||typeof data!=="object"||Array.isArray(data)
      ||!["PLAN","REPLAY","PERIOD","OPPORTUNITIES","BATCH","SWEEP","STOCK_IMPORT","PUBLISH","CANDIDATE_REVIEW"].includes(data.mode))
      fail("RESEARCH_REPLAY_INPUT_MODE_INVALID");
    return data;
  }finally{await file?.close();}
}
async function reservePrivateOutput(path){
  await checkParent(path);
  // Reservation is FIRST, before any optional STOCK_IMPORT or PUBLISH
  // mutation. Repeated job outputs fail EEXIST without changing archives or
  // administrator reports. A crashed invocation leaves a 0600 sentinel
  // requiring manual review rather than invisible duplicate execution.
  return open(path,constants.O_WRONLY|constants.O_CREAT
    |constants.O_EXCL|constants.O_NOFOLLOW,0o600);
}
async function completeReservedOutput(file,value){
  const raw=JSON.stringify(value)+"\n";
  if(Buffer.byteLength(raw)>OUT_MAX)fail("RESEARCH_REPLAY_RESULT_TOO_LARGE");
  await file.writeFile(raw,"utf8");
  await file.sync();
}
export function parseOriginalReplayArgsV1(argv){
  if(!Array.isArray(argv)||argv.length!==4
    ||argv[0]!=="--input"||argv[2]!=="--output"
    ||argv[1]===argv[3])
    fail("RESEARCH_REPLAY_EXACT_INPUT_OUTPUT_ARGS_REQUIRED");
  return {input:argv[1],output:argv[3]};
}
export async function runOriginalReplayPrivateJobV1({input,output}={}){
  if(!input||!output||input===output)
    fail("RESEARCH_REPLAY_INPUT_OUTPUT_DISTINCT_REQUIRED");
  const job=await readPrivate(input);
  const {mode,...task}=job;
  const outputFile=await reservePrivateOutput(output);
  let completed=false;
  try{
    const result=mode==="PLAN"
      ?planFourMarketPITReplayWorkV1(task)
      :mode==="OPPORTUNITIES"
        ?await auditFourMarketOriginalMinuteOpportunityV1(task)
        :mode==="BATCH"
          ?await runFourMarketOriginalMinuteBatchV1(task)
          :mode==="PERIOD"
            ?await runFourMarketOriginalMinutePeriodV1(task)
            :mode==="SWEEP"
              ?await runFourMarketOriginalMinuteSweepV1(task)
              :mode==="STOCK_IMPORT"
                ?await importStockNativeMinuteOfflineV1(task)
                :mode==="PUBLISH"
                  ?await publishResearchOriginalMinuteDiagnosticV1(task)
                  :mode==="CANDIDATE_REVIEW"
                    ?reviewOriginalMinuteForCanonicalPaperV1(task)
                    :await runFourMarketOriginalMinuteReplayV1(task);
    if(result.executionAuthority!=="NONE"||result.profitabilityProven!==false
      ||result.realOrders!==false||result.actualFillCount!==null
      ||result.trueMarketWideRecall!==null)
      fail("RESEARCH_REPLAY_NO_TRADING_AUTHORITY_REQUIRED");
    await completeReservedOutput(outputFile,result);
    completed=true;
    return Object.freeze({
      mode,
      readOnly:mode!=="STOCK_IMPORT"&&mode!=="PUBLISH",
      localOnlyWrite:mode==="STOCK_IMPORT"
        ?result.physicalArchiveRetained===true
        :mode==="PUBLISH"?result.published===true:false,
      outputWritten:true,status:result.status,
      executionAuthority:"NONE",profitabilityProven:false,
      orderSubmitted:false,
    });
  }finally{
    await outputFile.close();
    if(!completed)await unlink(output).catch(()=>{});
  }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  runOriginalReplayPrivateJobV1(parseOriginalReplayArgsV1(process.argv.slice(2)))
    .then(result=>process.stdout.write(JSON.stringify(result)+"\n"))
    .catch(error=>{
      // No internal paths or source content echoed to terminal logs.
      process.stderr.write("RESEARCH_ORIGINAL_MINUTE_PRIVATE_JOB_BLOCKED\n");
      process.exitCode=1;
    });
}
