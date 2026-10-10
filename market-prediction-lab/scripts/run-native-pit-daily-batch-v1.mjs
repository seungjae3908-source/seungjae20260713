#!/usr/bin/env node
/**
 * OFFLINE-DEFAULT research entrypoint for a historically dated, all-name PIT
 * security/contract roster and native day OHLCV. Not a trading system.
 *
 * 1. Validate roster without network:
 * node run-native-pit-daily-batch-v1.mjs --mode plan --market CRYPTO_SPOT
 *   --day 2025-10-09 --manifest /private/pit.json --output /private/plan.json
 * 2. Fetch public native day data only with explicit --read-public:
 * node ... --mode fetch --market CRYPTO_SPOT --day 2025-10-09
 *   --manifest /private/pit.json --offset 0 --limit 20
 *   --expected-pit-sha <SHA_FROM_PLAN> --read-public
 *   --output /private/chunk-0.json
 * 3. Assemble all chunks from the SAME PIT roster:
 * node ... --mode assemble --market CRYPTO_SPOT --day 2025-10-09
 *   --manifest /private/pit.json --chunks /private/chunk-0.json,/private/chunk-20.json
 *   --emit-private-day-rows --output /private/day-audit.json
 * python market-prediction-lab/scripts/report-native-pit-daily-opportunity-v1.py
 *   --input /private/day-audit.json --output /private/event-labels.json
 *
 * An archive downloaded from today's Upbit supported pairs, current Bitget
 * instrument list, or today's stock catalog is NOT a historical complete
 * PIT roster. Commercial reuse rights of Upbit downloads are NOT established.
 * No Replit, secrets, private APIs, DB changes, orders or deployment.
 */
import {readFileSync,lstatSync,writeFileSync,mkdirSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {BitgetPublicClient} from "../src/bitget-public-client.js";
import {
  collectNativeHistoricalPITDayChunkV1,
  assembleHistoricalPITDayChunksV1,
} from "../src/venue-native-pit-daily-intake-v1.js";

const FIELDS=new Set(["--mode","--market","--day","--manifest",
  "--offset","--limit","--output","--chunks","--expected-pit-sha"]);
const SHA=/^[0-9a-f]{64}$/;
const names=new Set(["KR_STOCK","US_STOCK","CRYPTO_SPOT","CRYPTO_FUTURES"]);
export function parseNativePITBatchArgsV1(args=[]){
  if(!Array.isArray(args)||args.length>30)
    throw new TypeError("PIT_CLI_ARGS_INVALID");
  const kv={};
  let allowPublicReadOnlyFetch=false,emitPrivateDayRows=false;
  for(let i=0;i<args.length;i++){
    const key=args[i];
    if(key==="--read-public"){
      if(allowPublicReadOnlyFetch)throw new TypeError("PIT_CLI_DUPLICATE_FLAG");
      allowPublicReadOnlyFetch=true;continue;
    }
    if(key==="--emit-private-day-rows"){
      if(emitPrivateDayRows)throw new TypeError("PIT_CLI_DUPLICATE_FLAG");
      emitPrivateDayRows=true;continue;
    }
    if(!FIELDS.has(key)||Object.hasOwn(kv,key)||!args[i+1]
       ||String(args[i+1]).startsWith("--"))
      throw new TypeError("PIT_CLI_OPTION_INVALID");
    kv[key]=args[++i];
  }
  const mode=kv["--mode"]??"plan",market=kv["--market"],day=kv["--day"];
  if(!["plan","fetch","assemble"].includes(mode)||!names.has(market)
     ||typeof day!=="string"||!/^20\d{2}-\d{2}-\d{2}$/.test(day)
     ||!Number.isFinite(Date.parse(day+"T00:00:00.000Z"))
     ||new Date(day+"T00:00:00.000Z").toISOString().slice(0,10)!==day
     ||typeof kv["--output"]!=="string"||!kv["--output"].trim())
    throw new TypeError("PIT_CLI_REQUIRED_ARGS_INVALID");
  const offset=Number(kv["--offset"]??0),limit=Number(kv["--limit"]??20);
  if(!Number.isSafeInteger(offset)||offset<0
     ||!Number.isSafeInteger(limit)||limit<1||limit>20)
    throw new TypeError("PIT_CLI_BUDGET_INVALID");
  if(allowPublicReadOnlyFetch&&mode!=="fetch"
     ||mode==="fetch"&&!allowPublicReadOnlyFetch
     ||emitPrivateDayRows&&mode!=="assemble"
     ||mode!=="assemble"&&kv["--chunks"]!=null
     ||mode==="assemble"&&(kv["--chunks"]==null||kv["--manifest"]==null))
    throw new TypeError("PIT_CLI_SOURCE_AUTHORITY_INVALID");
  const expectedSHA=kv["--expected-pit-sha"]??null;
  if(expectedSHA!=null&&!SHA.test(expectedSHA))
    throw new TypeError("PIT_CLI_SOURCE_SHA_INVALID");
  // Never start or resume a historical all-name fetch without the exact
  // previously inspected PIT manifest digest (optimistic read lease).
  if(mode==="fetch" && (!kv["--manifest"]||expectedSHA==null))
    throw new TypeError("PIT_CLI_FETCH_ROSTER_AND_SHA_REQUIRED");
  const chunks=kv["--chunks"]==null?[]:kv["--chunks"].split(",");
  if(chunks.length>5000||chunks.some(x=>!x.trim())
     ||new Set(chunks).size!==chunks.length)
    throw new TypeError("PIT_CLI_CHUNK_INPUT_INVALID");
  return Object.freeze({
    mode,market,dayStartMs:Date.parse(day+"T00:00:00.000Z"),
    manifestPath:kv["--manifest"]??null,outputPath:kv["--output"],
    offset,limit,expectedSHA,chunks,allowPublicReadOnlyFetch,
    emitPrivateDayRows,
  });
}
export function verifyNativePITChunkEnvelopeV1(
  raw,{market,dayStartMs,expectedRosterDigestSha256}={}
){
  const piece=raw?.result;
  const expectedVenue={
    KR_STOCK:"KRX",US_STOCK:"US_SIP",
    CRYPTO_SPOT:"UPBIT_KRW",CRYPTO_FUTURES:"BITGET_USDT_FUTURES",
  }[market];
  if(raw?.schemaVersion!=="native-historic-pit-day-read-only-cli-v1"
     ||raw?.executionAuthority!=="NONE"
     ||raw?.provenanceIndependentAuthentication!==false
     ||raw?.dataUsage!=="RESEARCH_ONLY_NO_COMMERCIAL_REPUBLICATION_AUTHORIZED"
     ||piece?.status!=="PIT_NATIVE_DAY_CHUNK_OBSERVED"
     ||piece?.chunkComplete!==true
     ||piece?.executionAuthority!=="NONE"
     ||piece?.profitabilityProven!==false
     ||piece?.realOrders!==false
     ||piece?.market!==market||piece?.venue!==expectedVenue
     ||piece?.dayStartMs!==dayStartMs
     ||piece?.dayEndMs!==dayStartMs+86_400_000
     ||!SHA.test(piece?.rosterDigestSha256??"")
     ||piece?.rosterDigestSha256!==expectedRosterDigestSha256
     ||!Number.isSafeInteger(piece?.chunkOffset)||piece.chunkOffset<0
     ||!Number.isSafeInteger(piece?.requestedHistoricalActiveMembers)
     ||piece.requestedHistoricalActiveMembers<1
     ||!Number.isSafeInteger(piece?.requestedChunkCount)
     ||piece.requestedChunkCount<1||piece.requestedChunkCount>20
     ||!Array.isArray(piece?.rows)
     ||piece.rows.length!==piece.requestedChunkCount
     ||!Array.isArray(piece?.requestedSymbolIds)
     ||piece.requestedSymbolIds.length!==piece.rows.length
     ||piece?.sourceAttestedPriceRows!==piece.rows.length
     ||piece?.requestsPerformed!==piece.rows.length
     ||piece?.fullMarketPITUniverseVerified!==false
     ||piece?.actualMarketWideOpportunityCount!==null
     ||piece?.trueMarketWideRecall!==null)
    throw new TypeError("PIT_CLI_CHUNK_ENVELOPE_OR_PROVENANCE_INVALID");
  // Never feed a saved CLI envelope directly to the raw-chunk assembler.
  return piece;
}
function readBoundedJson(file){
  const p=resolve(file),stat=lstatSync(p);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1
     ||stat.size<=0||stat.size>8*1024*1024)
    throw new Error("PIT_CLI_UNSAFE_OR_OVERSIZED_INPUT");
  return JSON.parse(readFileSync(p,"utf8"));
}
export async function runNativePITBatchCliV1(config,{
  upbitFetch=globalThis.fetch,bitgetClient=null,sleepImpl=null,
}={}){
  const manifest=config.manifestPath?readBoundedJson(config.manifestPath):null;
  let report;
  if(config.mode==="assemble"){
    // The saved files have a strict CLI envelope {result:{...}}.
    // Validate that each file belongs to exactly this market/day/PIT SHA
    // before passing only its raw result to the existing assembler.
    const digest=manifest?.rawMembershipDigestSha256;
    if(!SHA.test(digest??""))
      throw new TypeError("PIT_CLI_ASSEMBLY_ROSTER_DIGEST_REQUIRED");
    if(config.expectedSHA!=null && config.expectedSHA!==digest)
      throw new TypeError("PIT_CLI_ASSEMBLY_ROSTER_CHANGED");
    const chunks=config.chunks.map(file=>
      verifyNativePITChunkEnvelopeV1(readBoundedJson(file),{
        market:config.market,dayStartMs:config.dayStartMs,
        expectedRosterDigestSha256:digest,
      }));
    report=assembleHistoricalPITDayChunksV1({
      market:config.market,dayStartMs:config.dayStartMs,
      manifest,chunks,
      includePrivateNativeDayRows:config.emitPrivateDayRows===true,
    });
  }else{
    report=await collectNativeHistoricalPITDayChunkV1({
      market:config.market,dayStartMs:config.dayStartMs,
      manifest,offset:config.offset,limit:config.limit,
      allowPublicReadOnlyFetch:config.allowPublicReadOnlyFetch,
      expectedRosterDigestSha256:config.expectedSHA,
      upbitFetch,
      bitgetClient:config.allowPublicReadOnlyFetch
        ?(bitgetClient??new BitgetPublicClient({
          maxRetries:1,minIntervalMs:220,timeoutMs:12_000,
        })):null,
      ...(sleepImpl?{sleepImpl}:{}),
      minBetweenSymbolsMs:220,
    });
  }
  const output=resolve(config.outputPath);
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify({
    schemaVersion:"native-historic-pit-day-read-only-cli-v1",
    createdAt:new Date().toISOString(),
    dataUsage:"RESEARCH_ONLY_NO_COMMERCIAL_REPUBLICATION_AUTHORIZED",
    provenanceIndependentAuthentication:false,
    executionAuthority:"NONE",
    result:report,
  },null,2)+"\n",{encoding:"utf8",mode:0o600,flag:"wx"});
  return Object.freeze({
    status:report.status,reason:report.reason??null,
    market:config.market,
    requestedHistoricalActiveMembers:
      report.requestedHistoricalActiveMembers??null,
    sourceAttestedFullSymbolDayPriceJoin:
      report.sourceAttestedFullSymbolDayPriceJoin??false,
    privateNativeDayRowsEmitted:report.privateNativeDayRowsEmitted??false,
    nextOffset:report.nextOffset??null,
    rosterDigestSha256:report.rosterDigestSha256??null,
    fullMarketOpportunityDenominatorVerified:false,
    trueMarketWideRecall:null,profitabilityProven:false,
    executionAuthority:"NONE",
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=await runNativePITBatchCliV1(
    parseNativePITBatchArgsV1(process.argv.slice(2)));
  process.stdout.write(JSON.stringify(result)+"\n");
}
