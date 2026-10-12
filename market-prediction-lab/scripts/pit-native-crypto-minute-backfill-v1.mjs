#!/usr/bin/env node
/**
 * Explicitly gated PUBLIC-GET-only, one PIT crypto pair/day backfill to a
 * private immutable 1m file archive. No scheduled runs, private API, orders.
 *
 * DRY RUN (no GET):
 * node scripts/pit-native-crypto-minute-backfill-v1.mjs
 *   --market CRYPTO_SPOT --symbol KRW-BTC --day 2026-09-18
 *   --manifest /private/pit-roster.json --expected-roster-sha <sha256>
 *   --root /private/minute-archive --output /private/receipts/day-audit.json
 *
 * Only if allowed to read public native 1m data for private research:
 *   add --read-public. To retry a retained partial source, additionally add
 *   --retry-partial --expected-existing-sha <SHA256-of-reviewed-revision>.
 *   Omit --read-public for a ZERO-network private preflight; an authorized
 *   historical GET still requires --read-public explicitly.
 *   A retry never overwrites the prior original, requires the exact reviewed
 *   prior digest and only stores an unchanged-price superseding 1m inventory.
 *   Multiple revisions require explicit read selection; no auto promotion.
 *   Replit/DB/Production/Paper/LIVE/order paths are absent.
 */
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSelectedResearchWindowV1 } from "../src/research-selected-window-v1.js";
import {
  collectPITNativeCryptoMinuteSourceV1,
} from "../src/pit-native-crypto-minute-backfill-v1.js";

const FLAGS=new Set(["--market","--symbol","--day","--manifest",
  "--expected-roster-sha","--root","--output","--expected-existing-sha"]);
const REQUIRED=[...FLAGS].filter(key=>key!=="--expected-existing-sha");
function abs(value) {
  return typeof value==="string"&&isAbsolute(value)&&resolve(value)===value;
}
function privateInput(path) {
  const st=lstatSync(path);
  if (!st.isFile()||st.isSymbolicLink()||st.nlink!==1
    ||st.size<2||st.size>64*1024*1024||(st.mode&0o077)!==0)
    throw new TypeError("PIT_NATIVE_MINUTE_CLI_PRIVATE_INPUT_REQUIRED");
  return JSON.parse(readFileSync(path,"utf8"));
}
function noSymlinkAncestors(path) {
  let probe=dirname(path);
  while(true){
    try{
      const st=lstatSync(probe);
      if(!st.isDirectory()||st.isSymbolicLink())
        throw new TypeError("PIT_NATIVE_MINUTE_CLI_SYMLINK_PATH_FORBIDDEN");
    }catch(error){if(error?.code!=="ENOENT")throw error;}
    const parent=dirname(probe);
    if(parent===probe)break;
    probe=parent;
  }
}
export function parsePITNativeMinuteBackfillArgsV1(args=[]) {
  if(!Array.isArray(args)||args.length<14||args.length>18)
    throw new TypeError("PIT_NATIVE_MINUTE_CLI_ARGUMENTS_INVALID");
  const fields={};
  let allowPublicReadOnlyFetch=false,retryPartialSource=false;
  for(let i=0;i<args.length;i++){
    if(args[i]==="--read-public"){
      if(allowPublicReadOnlyFetch)throw new TypeError("PIT_NATIVE_MINUTE_CLI_DUPLICATE_FLAG");
      allowPublicReadOnlyFetch=true;continue;
    }
    if(args[i]==="--retry-partial"){
      if(retryPartialSource)throw new TypeError("PIT_NATIVE_MINUTE_CLI_DUPLICATE_FLAG");
      retryPartialSource=true;continue;
    }
    const key=args[i],value=args[++i];
    if(!FLAGS.has(key)||Object.hasOwn(fields,key)
      ||typeof value!=="string"||!value.trim()||value.startsWith("--"))
      throw new TypeError("PIT_NATIVE_MINUTE_CLI_OPTION_INVALID");
    fields[key]=value;
  }
  if(!REQUIRED.every(key=>Object.hasOwn(fields,key))
    ||(retryPartialSource
      ?!/^[0-9a-f]{64}$/u.test(fields["--expected-existing-sha"]??"")
      :Object.hasOwn(fields,"--expected-existing-sha"))
    ||!abs(fields["--root"])||!abs(fields["--manifest"])
    ||!abs(fields["--output"])
    ||new Set([fields["--root"],fields["--manifest"],fields["--output"]]).size!==3
    ||!/^[0-9a-f]{64}$/u.test(fields["--expected-roster-sha"]))
    throw new TypeError("PIT_NATIVE_MINUTE_CLI_SCOPE_INVALID");
  const window=resolveSelectedResearchWindowV1({
    startDate:fields["--day"],endDate:fields["--day"],
  });
  return Object.freeze({
    root:fields["--root"],market:fields["--market"],
    symbol:fields["--symbol"],dayStartMs:window.startMs,
    manifestPath:fields["--manifest"],
    expectedRosterDigestSha256:fields["--expected-roster-sha"],
    outputPath:fields["--output"],
    allowPublicReadOnlyFetch,retryPartialSource,
    expectedExistingSourceDigestSha256:fields["--expected-existing-sha"]??null,
  });
}
export async function runPITNativeMinuteBackfillCliV1(
  config, dependencies={},
) {
  if(!config||!abs(config.manifestPath)||!abs(config.outputPath)
    ||!abs(config.root))throw new TypeError("PIT_NATIVE_MINUTE_CLI_CONFIG_INVALID");
  try{
    lstatSync(config.outputPath);
    throw new TypeError("PIT_NATIVE_MINUTE_CLI_OUTPUT_EXISTS");
  }catch(error){if(error?.code!=="ENOENT")throw error;}
  noSymlinkAncestors(config.outputPath);
  noSymlinkAncestors(config.manifestPath);
  const manifest=privateInput(config.manifestPath);
  const result=await collectPITNativeCryptoMinuteSourceV1({
    root:config.root,market:config.market,symbol:config.symbol,
    dayStartMs:config.dayStartMs,
    expectedRosterDigestSha256:config.expectedRosterDigestSha256,
    manifest,allowPublicReadOnlyFetch:config.allowPublicReadOnlyFetch,
    retryPartialSource:config.retryPartialSource,
    expectedExistingSourceDigestSha256:
      config.expectedExistingSourceDigestSha256??null,
    ...(dependencies.nowImpl?{nowImpl:dependencies.nowImpl}:{}),
    ...(dependencies.upbitFetchImpl?{upbitFetchImpl:dependencies.upbitFetchImpl}:{}),
    ...(dependencies.bitgetClient?{bitgetClient:dependencies.bitgetClient}:{}),
  });
  mkdirSync(dirname(config.outputPath),{recursive:true,mode:0o700});
  noSymlinkAncestors(config.outputPath);
  writeFileSync(config.outputPath,JSON.stringify(result,null,2)+"\n",
    {encoding:"utf8",mode:0o600,flag:"wx"});
  return Object.freeze({
    status:result.status,reason:result.reason??null,
    market:config.market,symbol:config.symbol,
    sourceMinuteCount:result.sourceMinuteCount??null,
    archiveSourceDigestSha256:result.archiveSourceDigestSha256??null,
    priorSourceDigestSha256:result.priorSourceDigestSha256??null,
    sourceRevisionAutoSelected:false,
    historicalFullMarketPITUniverseVerified:false,
    actualMarketWideOpportunityCount:null,trueMarketWideRecall:null,
    profitabilityProven:false,executionAuthority:"NONE",
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const config=parsePITNativeMinuteBackfillArgsV1(process.argv.slice(2));
  process.stdout.write(JSON.stringify(await runPITNativeMinuteBackfillCliV1(config))+"\n");
}
