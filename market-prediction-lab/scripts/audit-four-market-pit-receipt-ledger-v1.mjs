#!/usr/bin/env node
/**
 * OFFLINE/READ-ONLY bounded PIT source inventory. Processes ONE original
 * whole-market PIT + native-day-price receipt at a time, then summarizes
 * compact private receipts. No exchange GETs, keys, DB or trading operations.
 *
 * 1. node .../audit-four-market-pit-receipt-ledger-v1.mjs
 *    --mode day --market CRYPTO_SPOT --day 2025-10-09
 *    --input /private/2025-10-09-pit-native.json
 *    --output /private/2025-10-09-compact.json
 * For a native PIT fetch/assemble output from run-native-pit-daily-batch-v1.mjs:
 *   --mode day --market CRYPTO_SPOT --day 2025-10-09
 *   --manifest /private/authoritative-pit-archive.json
 *   --input /private/native-assembled-day.json
 *   --output /private/compact-day.json
 * 2. node ... --mode ledger --market CRYPTO_SPOT
 *    --input /private/compact-file-index.json
 *    --output /private/historical-coverage-ledger.json
 *
 * compact-file-index.json holds private absolute paths:
 * {"dayReceiptFiles":["/private/day1-compact.json",...]}
 * For KR/US may also supply {"expectedStockDays":[UTC-day-start-ms,...]}.
 * Such a caller date set is NOT independently an official venue calendar.
 *
 * Hashes prove local integrity ONLY; retrospectively constructed receipts
 * never prove actual market-wide denominators, scanner recall, 1m crossings,
 * profitable fills or data vendor authentication. Keep all originals local.
 */
import {lstatSync,readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {resolve,isAbsolute,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {
 auditOnePITDayIntoCompactReceiptV1,
 auditCompactPITReceiptLedgerV1,
} from "../src/four-market-pit-daily-ledger-v1.js";
import {FOUR_MARKET_WHOLE_SCOPE_V1}
 from "../src/four-market-whole-pit-price-coverage-v1.js";

const DAY=86_400_000;
function isDay(s){
 if(typeof s!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;
 const x=Date.parse(s+"T00:00:00.000Z");
 return Number.isSafeInteger(x)&&new Date(x).toISOString().slice(0,10)===s;
}
export function parsePITLedgerCliArgsV1(args=[]){
 if(!Array.isArray(args)||args.length<6||args.length>12)
   throw new TypeError("PIT_LEDGER_CLI_ARGS_INVALID");
 const allowed=new Set(["--mode","--market","--day","--input","--output","--manifest"]);
 const v={};
 for(let i=0;i<args.length;i++){
  const flag=args[i],value=args[++i];
  if(!allowed.has(flag)||Object.hasOwn(v,flag)||
    typeof value!=="string"||!value.trim()||value.startsWith("--"))
   throw new TypeError("PIT_LEDGER_CLI_INVALID_OPTION");
  v[flag]=value;
 }
 if(!["day","ledger"].includes(v["--mode"])
   ||!Object.prototype.hasOwnProperty.call(FOUR_MARKET_WHOLE_SCOPE_V1,v["--market"])
   ||!isAbsolute(v["--input"]??"")||!isAbsolute(v["--output"]??"")
   ||resolve(v["--input"])===resolve(v["--output"])
   ||(v["--manifest"]!=null&&(
      !isAbsolute(v["--manifest"])
      ||resolve(v["--manifest"])===resolve(v["--input"])
      ||resolve(v["--manifest"])===resolve(v["--output"])))
   ||(v["--mode"]==="day"&&!isDay(v["--day"]))
   ||(v["--mode"]==="ledger"&&(v["--day"]!=null||v["--manifest"]!=null)))
   throw new TypeError("PIT_LEDGER_CLI_INPUT_OR_SCOPE_INVALID");
 return Object.freeze({
  mode:v["--mode"],market:v["--market"],
  dayStartMs:v["--day"]?Date.parse(v["--day"]+"T00:00:00.000Z"):null,
  inputPath:resolve(v["--input"]),outputPath:resolve(v["--output"]),
  manifestPath:v["--manifest"]?resolve(v["--manifest"]):null,
 });
}
function readPrivateJSON(path,maxBytes){
 const absolute=resolve(path),st=lstatSync(absolute);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||
    st.size<=0||st.size>maxBytes||(st.mode&0o077)!==0)
   throw new TypeError("PIT_LEDGER_PRIVATE_SOURCE_FILE_REQUIRED");
 return JSON.parse(readFileSync(absolute,"utf8"));
}
export function runPITLedgerCliV1(config){
 if(!config||!["day","ledger"].includes(config.mode)
   ||!Object.prototype.hasOwnProperty.call(FOUR_MARKET_WHOLE_SCOPE_V1,config.market)
   ||!isAbsolute(config.inputPath??"")
   ||!isAbsolute(config.outputPath??"")
   ||config.inputPath===config.outputPath
   ||(config.manifestPath!=null&&(
     !isAbsolute(config.manifestPath)
     ||config.manifestPath===config.inputPath
     ||config.manifestPath===config.outputPath))
   ||(config.mode==="ledger"&&config.manifestPath!=null))
   throw new TypeError("PIT_LEDGER_CLI_CONFIG_INVALID");
 // Fail before parsing multi-megabyte licensed data if the destination exists.
 try{
  lstatSync(config.outputPath);
  throw new TypeError("PIT_LEDGER_DESTINATION_ALREADY_EXISTS");
 }catch(err){if(err?.code!=="ENOENT")throw err;}
 let result;
 if(config.mode==="day"){
  const data=readPrivateJSON(config.inputPath,64*1024*1024);
  if(!data||typeof data!=="object"||Array.isArray(data))
   throw new TypeError("PIT_LEDGER_DAY_SOURCE_OBJECT_REQUIRED");
  let manifest=data.manifest??null;
  let dailySource=data.dailySource??null;
  if(data.schemaVersion==="native-historic-pit-day-read-only-cli-v1"){
   // Genuine native chunk assembler source format; do not need to reshape
   // private OHLC manually. Re-run the canonical PIT/price gate below.
   if(!config.manifestPath)
    throw new TypeError("PIT_LEDGER_NATIVE_ASSEMBLY_REQUIRES_PIT_MANIFEST");
   manifest=readPrivateJSON(config.manifestPath,64*1024*1024);
   const r=data.result,source=r?.privateNativeDaySource;
   if(data.executionAuthority!=="NONE"
     ||data.provenanceIndependentAuthentication!==false
     ||data.dataUsage!=="RESEARCH_ONLY_NO_COMMERCIAL_REPUBLICATION_AUTHORIZED"
     ||!["TEST_FIXTURE_FULL_NAME_DAILY_JOIN_ONLY",
       "SOURCE_ATTESTED_FULL_NAME_DAILY_JOIN_ONLY"].includes(r?.status)
     ||r?.market!==config.market||r?.executionAuthority!=="NONE"
     ||r?.profitabilityProven!==false||r?.fullMarketPITUniverseVerified!==false
     ||r?.trueMarketWideRecall!==null||r?.actualMarketWideOpportunityCount!==null
     ||r?.privateNativeDayRowsEmitted!==true
     ||r?.sourceAttestedFullSymbolDayPriceJoin!==true
     ||!source||source.rowsSha256!==r.nativeRowsSha256
     ||source.dayStartMs!==config.dayStartMs
     ||source.sourceId!==
       [config.market,config.dayStartMs,manifest?.rawMembershipDigestSha256].join(":"))
    throw new TypeError("PIT_LEDGER_NATIVE_ASSEMBLY_PROVENANCE_INVALID");
   dailySource=source;
  }else if(config.manifestPath!=null){
   throw new TypeError("PIT_LEDGER_DIRECT_SOURCE_MANIFEST_MUST_BE_EMBEDDED");
  }
  result=auditOnePITDayIntoCompactReceiptV1({
   market:config.market,dayStartMs:config.dayStartMs,
   manifest,dailySource,
  });
 }else{
  const list=readPrivateJSON(config.inputPath,1024*1024);
  if(!Array.isArray(list?.dayReceiptFiles)||list.dayReceiptFiles.length>1100
     ||list.dayReceiptFiles.some(f=>typeof f!=="string"||!isAbsolute(f))
     ||new Set(list.dayReceiptFiles).size!==list.dayReceiptFiles.length)
   throw new TypeError("PIT_LEDGER_DAY_RECEIPT_FILE_LIST_INVALID");
  const receipts=list.dayReceiptFiles.map(file=>readPrivateJSON(file,64*1024));
  result=auditCompactPITReceiptLedgerV1({
   market:config.market,dayReceipts:receipts,
   expectedStockDays:list.expectedStockDays??null,
  });
 }
 const data=JSON.stringify(result,null,2)+"\n";
 mkdirSync(dirname(config.outputPath),{recursive:true});
 writeFileSync(config.outputPath,data,{mode:0o600,flag:"wx"});
 return Object.freeze({
  status:result.status,reason:result.reason??null,market:config.market,
  sourceAttestedPriceJoinedDays:result.sourceAttestedPriceJoinedDays??null,
  requestedTradingDays:result.requestedTradingDays??null,
  fullMarketOpportunityDenominatorVerified:false,
  actualMarketWideOpportunityCount:null,trueMarketWideRecall:null,
  profitabilityProven:false,executionAuthority:"NONE",
 });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const config=parsePITLedgerCliArgsV1(process.argv.slice(2));
 const summary=runPITLedgerCliV1(config);
 process.stdout.write(JSON.stringify(summary)+"\n");
}
