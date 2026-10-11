#!/usr/bin/env node
/**
 * Offline-only research conversion of locally retained original 1-minute
 * data into 3m/5m/15m/30m/1h/4h, custom-minute intervals and crypto 1d.
 *
 * One PRIVATE per-venue, per-symbol, per-session JSON source at a time:
 * {market,venue,symbol,sourceId,session,asOfMs,
 *  minuteBars:[{market,venue,symbol,sourceId,timestampMs,availableAtMs,
 *              open,high,low,close,volume},...],
 *  sourceMinuteRowsSha256:"sha256-of-JSON-minuteBars"}.
 *
 * node .../build-research-multitimeframe-v1.mjs
 *   --market CRYPTO_SPOT
 *   --timeframes 1m,3m,5m,15m,30m,1h,4h
 *   --input /private/one-session-source-1m.json
 *   --output /private/derived-multitimeframe.json
 *
 * Never sends licensed original rows to public CI/app artifacts; this
 * research-only tool does not invoke provider GETs, accounts, orders, DB,
 * Replit or production deployments. Source integrity != independent PIT.
 */
import {lstatSync,readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {resolve,isAbsolute,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {deriveResearchTimeframesFromMinuteSourceV1}
 from "../src/research-minute-to-multiframe-v1.js";
import {FOUR_MARKET_WHOLE_SCOPE_V1}
 from "../src/four-market-whole-pit-price-coverage-v1.js";

const MARKETS=FOUR_MARKET_WHOLE_SCOPE_V1;
export function parseResearchMultiTimeframeArgsV1(args=[]){
 if(!Array.isArray(args)||args.length<8||args.length>10
   ||args.length%2!==0)throw new TypeError("RESEARCH_MULTI_CLI_ARGS_INVALID");
 const wanted=new Set(["--market","--input","--output","--timeframes","--as-of"]);
 const fields={};
 for(let i=0;i<args.length;i+=2){
  const name=args[i],value=args[i+1];
  if(!wanted.has(name)||Object.prototype.hasOwnProperty.call(fields,name)
    ||typeof value!=="string"||!value.trim()||value.startsWith("--"))
   throw new TypeError("RESEARCH_MULTI_CLI_OPTION_INVALID");
  fields[name]=value;
 }
 const market=fields["--market"];
 const input=fields["--input"],output=fields["--output"];
 const names=fields["--timeframes"]?.split(",")??[];
 if(!Object.prototype.hasOwnProperty.call(MARKETS,market)
   ||!isAbsolute(input??"")||!isAbsolute(output??"")
   ||resolve(input)===resolve(output)
   ||names.length<1||names.length>16
   ||new Set(names).size!==names.length||names.some(x=>!x.trim()))
   throw new TypeError("RESEARCH_MULTI_CLI_SCOPE_INVALID");
 let asOfMs=null;
 if(fields["--as-of"]){
  const iso=fields["--as-of"];
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(iso))
   throw new TypeError("RESEARCH_MULTI_ASOF_UTC_REQUIRED");
  asOfMs=Date.parse(iso);
  if(!Number.isSafeInteger(asOfMs)||asOfMs<=0||
    new Date(asOfMs).toISOString()!==(iso.includes(".")?
      iso:iso.replace("Z",".000Z")))
   throw new TypeError("RESEARCH_MULTI_ASOF_UTC_REQUIRED");
 }
 return Object.freeze({
  market,inputPath:resolve(input),outputPath:resolve(output),
  timeframes:names,asOfMs,
 });
}
function readPrivate(path){
 const st=lstatSync(path);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1
   ||st.size<2||st.size>64*1024*1024||(st.mode&0o077)!==0)
  throw new TypeError("RESEARCH_MULTI_PRIVATE_ONE_MINUTE_FILE_REQUIRED");
 return JSON.parse(readFileSync(path,"utf8"));
}
export function runResearchMultiTimeframeCliV1(config){
 if(!config||!Object.prototype.hasOwnProperty.call(MARKETS,config.market)
   ||!isAbsolute(config.inputPath??"")
   ||!isAbsolute(config.outputPath??"")
   ||config.inputPath===config.outputPath
   ||!Array.isArray(config.timeframes))
  throw new TypeError("RESEARCH_MULTI_CLI_CONFIG_INVALID");
 // Detect an occupied target before accessing the licensed source at all.
 try{
  lstatSync(config.outputPath);
  throw new TypeError("RESEARCH_MULTI_OUTPUT_ALREADY_EXISTS");
 }catch(e){
  if(e?.code!=="ENOENT")throw e;
 }
 const original=readPrivate(config.inputPath);
 if(original?.market!==config.market||!Number.isSafeInteger(
   config.asOfMs??original?.asOfMs))
  throw new TypeError("RESEARCH_MULTI_SOURCE_MARKET_OR_CUTOFF_INVALID");
 const result=deriveResearchTimeframesFromMinuteSourceV1({
  ...original,
  asOfMs:config.asOfMs??original.asOfMs,
  timeframes:config.timeframes,
 });
 mkdirSync(dirname(config.outputPath),{recursive:true});
 writeFileSync(config.outputPath,JSON.stringify(result,null,2)+"\n",
   {mode:0o600,flag:"wx"});
 return Object.freeze({
  status:result.status,reason:result.reason,
  market:config.market,symbol:result.symbol??null,
  derivedCandleCount:result.derivedCandleCount??0,
  intervalsRequested:config.timeframes,
  actualMarketWideOpportunityCount:null,trueMarketWideRecall:null,
  profitabilityProven:false,executionAuthority:"NONE",
 });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const config=parseResearchMultiTimeframeArgsV1(process.argv.slice(2));
 process.stdout.write(JSON.stringify(runResearchMultiTimeframeCliV1(config))+"\n");
}
