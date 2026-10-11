#!/usr/bin/env node
/**
 * Read-only US whole-market historical day readiness / optional licensed intake.
 *
 * No API key, no network:
 * node market-prediction-lab/scripts/run-us-asof-grouped-source-v1.mjs \
 *  --date 2025-02-03 --output /private/us-2025-02-03-readiness.json
 *
 * ONLY with an explicitly authorized licensed vendor key in a private
 * 0600 file (not in argv, environment variables, CI or the repo):
 * node ... --date 2025-02-03 --read-public \
 *  --approved-key-file /private/vendor-key.txt \
 *  --output /private/us-2025-02-03-observed.json
 *
 * Neither path orders trades or asserts full PIT history/early scanner recall.
 * Outputs are local create-only 0600; never upload raw vendor data to GitHub.
 */
import {
  lstatSync,readFileSync,mkdirSync,writeFileSync,
} from "node:fs";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {
  collectUSAsOfActiveGroupedDailyV1,
} from "../src/us-asof-all-stock-grouped-daily-v1.js";

export function parseUSAsOfIntakeArgsV1(argv=[]){
  if(!Array.isArray(argv)||argv.length>12)
    throw new TypeError("US_ASOF_CLI_ARGS_INVALID");
  const allowed=new Set(["--date","--output","--approved-key-file"]);
  const options={};let readPublic=false;
  for(let i=0;i<argv.length;i++){
    const name=argv[i];
    if(name==="--read-public"){
      if(readPublic)throw new TypeError("US_ASOF_CLI_DUPLICATE_FLAG");
      readPublic=true;continue;
    }
    if(!allowed.has(name)||Object.hasOwn(options,name)
       ||typeof argv[i+1]!=="string"
       ||!argv[i+1].trim()||argv[i+1].startsWith("--"))
      throw new TypeError("US_ASOF_CLI_OPTION_INVALID");
    options[name]=argv[++i];
  }
  if(!options["--date"]||!options["--output"])
    throw new TypeError("US_ASOF_CLI_DATE_AND_PRIVATE_OUTPUT_REQUIRED");
  if(readPublic!==Boolean(options["--approved-key-file"]))
    throw new TypeError("US_ASOF_CLI_EXPLICIT_READ_AND_KEY_REQUIRED");
  return Object.freeze({
    date:options["--date"],output:options["--output"],
    approvedKeyFile:options["--approved-key-file"]??null,readPublic,
  });
}
function readExplicitApprovedKey(path){
  const abs=resolve(path),st=lstatSync(abs);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1
     ||st.size<1||st.size>512||(st.mode&0o077)!==0)
    throw new TypeError("US_ASOF_APPROVED_KEY_FILE_UNSAFE");
  const key=readFileSync(abs,"utf8").trim();
  if(!key||key.length>256||/\s/.test(key))
    throw new TypeError("US_ASOF_APPROVED_KEY_CONTENT_INVALID");
  return key;
}
export async function runUSAsOfSourceCliV1(config,{
  fetchImpl=globalThis.fetch,sleepImpl,
}={}){
  const apiKey=config.readPublic?readExplicitApprovedKey(config.approvedKeyFile):null;
  const receipt=await collectUSAsOfActiveGroupedDailyV1({
    date:config.date,apiKey,fetchImpl,...(sleepImpl?{sleepImpl}:{}),
  });
  const file=resolve(config.output);
  mkdirSync(dirname(file),{recursive:true});
  writeFileSync(file,JSON.stringify({
    schemaVersion:"us-historical-whole-date-private-source-readiness-v1",
    dataUsage:"RESEARCH_ONLY_NO_VENDOR_REDISTRIBUTION_LICENSE_ATTESTED",
    createdAt:new Date().toISOString(),
    vendorAuthorizationHeaderOnly:true,apiKeyInSavedFile:false,
    historicalWholeMarketProfitabilityProven:false,
    executionAuthority:"NONE",source:receipt,
  },null,2)+"\n",{mode:0o600,flag:"wx"});
  return Object.freeze({
    market:"US_STOCK",date:config.date,status:receipt.status,
    reason:receipt.reason,
    providerReadOnlyGETs:receipt.providerReadOnlyGETs,
    asOfProviderTickerCount:receipt.asOfProviderTickerCount,
    groupedDailyBarsMatched:receipt.groupedDailyBarsMatched,
    sourceIndependentHistoricalPopulationProven:false,
    trueMarketWideRecall:null,profitabilityProven:false,
    executionAuthority:"NONE",
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const output=await runUSAsOfSourceCliV1(
    parseUSAsOfIntakeArgsV1(process.argv.slice(2)));
  process.stdout.write(JSON.stringify(output)+"\n");
}
