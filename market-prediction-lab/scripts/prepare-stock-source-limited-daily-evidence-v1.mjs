#!/usr/bin/env node
/**
 * Local/offline translation from archived same-provider whole-as-of-stock
 * two-session receipt -> canonical retrospective daily-event scorer input.
 *
 * node market-prediction-lab/scripts/prepare-stock-source-limited-daily-evidence-v1.mjs \
 *   --market US_STOCK --input /private/us-two-days.json \
 *   --output /private/us-daily-event-input.json
 * python market-prediction-lab/scripts/report-stock-source-limited-daily-opportunity-v1.py \
 *   --input /private/us-daily-event-input.json \
 *   --output /private/us-daily-price-events.json
 *
 * No internet, key, environment read, GitHub artifact, DB/order API, or
 * positive profitability claim. Input and output require local private
 * 0600 regular files. Source license may further restrict redistribution.
 */
import {readFileSync,lstatSync,writeFileSync,mkdirSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {prepareStockSourceLimitedDailyEvidenceV1}
 from "../src/stock-source-limited-daily-evidence-v1.js";

export function parseStockDailyEvidenceArgsV1(args=[]){
 if(!Array.isArray(args)||args.length>9)
   throw new TypeError("STOCK_EVIDENCE_CLI_ARGS_INVALID");
 const fields=new Set(["--market","--input","--output"]);
 const values={};let fixture=false;
 for(let i=0;i<args.length;i++){
   if(args[i]==="--test-fixture"){
     if(fixture)throw new TypeError("STOCK_EVIDENCE_CLI_DUPLICATE_FIXTURE");
     fixture=true;continue;
   }
   const k=args[i];
   if(!fields.has(k)||Object.hasOwn(values,k)||
      typeof args[i+1]!=="string"||!args[i+1].trim()
      ||args[i+1].startsWith("--"))
     throw new TypeError("STOCK_EVIDENCE_CLI_OPTION_INVALID");
   values[k]=args[++i];
 }
 if(!["KR_STOCK","US_STOCK"].includes(values["--market"])
    ||!values["--input"]||!values["--output"])
    throw new TypeError("STOCK_EVIDENCE_CLI_PRIVATE_INPUT_OUTPUT_REQUIRED");
 if(resolve(values["--input"])===resolve(values["--output"]))
    throw new TypeError("STOCK_EVIDENCE_CLI_SOURCE_DESTINATION_IDENTICAL");
 return Object.freeze({market:values["--market"],
   input:values["--input"],output:values["--output"],
   testFixtureOnly:fixture});
}
function loadPrivateSource(path){
 const file=resolve(path),st=lstatSync(file);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1
    ||st.size<=0||st.size>64*1024*1024||(st.mode&0o077)!==0)
   throw new TypeError("STOCK_EVIDENCE_PRIVATE_INPUT_UNSAFE");
 return JSON.parse(readFileSync(file,"utf8"));
}
export function runStockSourceLimitedDailyInputCliV1(config){
 const original=loadPrivateSource(config.input);
 const evidence=prepareStockSourceLimitedDailyEvidenceV1({
   market:config.market,source:original,
   testFixtureOnly:config.testFixtureOnly===true,
 });
 const filename=resolve(config.output);
 mkdirSync(dirname(filename),{recursive:true});
 writeFileSync(filename,JSON.stringify(evidence,null,2)+"\n",{
   mode:0o600,flag:"wx",
 });
 return Object.freeze({market:config.market,
   status:evidence.status,reason:evidence.reason,
   sourceAttestedNameCount:evidence.sourceAttestedNameCount,
   sourceObservedDailyEvents:null,
   fullMarketOpportunityDenominatorVerified:false,
   trueMarketWideRecall:null,profitabilityProven:false,
   executionAuthority:"NONE"});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const report=runStockSourceLimitedDailyInputCliV1(
   parseStockDailyEvidenceArgsV1(process.argv.slice(2)));
 process.stdout.write(JSON.stringify(report)+"\n");
}
