#!/usr/bin/env node
/**
 * Two-date WHOLE as-of-date stock daily market-data collector, using existing
 * bounded KRX / Massive public read-only source adapters.
 *
 * OFFLINE DEFAULT (no entitlement file, NO network):
 * node market-prediction-lab/scripts/collect-stock-two-dated-source-v1.mjs \
 *   --market KR_STOCK --prior 20250207 --date 20250210 \
 *   --output /private/kr-20250210-source.json
 *
 * Authorized optional market-data GET only:
 * node market-prediction-lab/scripts/collect-stock-two-dated-source-v1.mjs \
 *   --market US_STOCK --prior 2025-01-31 --date 2025-02-03 \
 *   --read-public --approved-key-file /private/massive-key.txt \
 *   --output /private/us-20250203-source.json
 *
 * Saved JSON is the NATIVE raw receipt consumed directly by existing
 * prepare-stock-source-limited-daily-evidence-v1.mjs --input.
 * Neither two supplied days nor a successful data-provider response
 * authenticate 3y historical PIT+delistings, exchange calendar,
 * original scanner watch/recall, corporate actions, 1-minute crossing,
 * execution or profitability. NEVER send raw licensed data to public CI.
 * No .env / secret store / private brokerage API / orders / Replit.
 */
import {lstatSync,readFileSync,mkdirSync,writeFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {collectKrxTwoDatedFullStockDailySourcesV1}
 from "../src/krx-two-dated-all-stock-sources-v1.js";
import {collectUSTwoDatedAsOfAllStockPricesV1}
 from "../src/us-two-dated-all-stock-source-v1.js";

const MARKETS=new Set(["KR_STOCK","US_STOCK"]);
const DATE_PATTERNS={
 KR_STOCK:/^\d{8}$/,US_STOCK:/^\d{4}-\d{2}-\d{2}$/,
};
const MAX_SOURCE_BYTES=64*1024*1024;
const safeDate=(s,market)=>{
 if(typeof s!=="string"||!DATE_PATTERNS[market].test(s))return false;
 const iso=market==="KR_STOCK"?
   s.slice(0,4)+"-"+s.slice(4,6)+"-"+s.slice(6):s;
 const ts=Date.parse(iso+"T00:00:00.000Z");
 return Number.isSafeInteger(ts)&&new Date(ts).toISOString().slice(0,10)===iso;
};

export function parseStockTwoDatedSourceArgsV1(argv=[]){
 if(!Array.isArray(argv)||argv.length>11)
   throw new TypeError("STOCK_TWO_DATED_CLI_ARGS_INVALID");
 const options=new Set(["--market","--prior","--date",
   "--output","--approved-key-file"]);
 const result={};let readPublic=false;
 for(let i=0;i<argv.length;i++){
  const arg=argv[i];
  if(arg==="--read-public"){
    if(readPublic)throw new TypeError("STOCK_TWO_DATED_DUPLICATE_READ_FLAG");
    readPublic=true;continue;
  }
  if(!options.has(arg)||Object.hasOwn(result,arg)||
     typeof argv[i+1]!=="string"||!argv[i+1].trim()||
     argv[i+1].startsWith("--"))
    throw new TypeError("STOCK_TWO_DATED_INVALID_CLI_OPTION");
  result[arg]=argv[++i];
 }
 const market=result["--market"];
 if(!MARKETS.has(market)||!result["--output"]||
    !safeDate(result["--prior"],market)||
    !safeDate(result["--date"],market)||
    result["--prior"]>=result["--date"])
   throw new TypeError("STOCK_TWO_DATED_REQUIRED_MARKET_DATES_OUTPUT");
 const keyFile=result["--approved-key-file"]??null;
 if(readPublic!==(keyFile!==null))
   throw new TypeError("STOCK_TWO_DATED_APPROVED_READ_AND_KEY_REQUIRED");
 if(keyFile&&resolve(keyFile)===resolve(result["--output"]))
   throw new TypeError("STOCK_TWO_DATED_KEY_AND_OUTPUT_IDENTICAL");
 return Object.freeze({
  market,prior:result["--prior"],date:result["--date"],
  output:result["--output"],approvedKeyFile:keyFile,readPublic,
 });
}

function readApprovedKey(path){
 const st=lstatSync(resolve(path));
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||
    st.size<1||st.size>512||(st.mode&0o077)!==0)
   throw new TypeError("STOCK_TWO_DATED_APPROVED_KEY_FILE_UNSAFE");
 const apiKey=readFileSync(resolve(path),"utf8").trim();
 if(!apiKey||apiKey.length>256||/\s/.test(apiKey))
   throw new TypeError("STOCK_TWO_DATED_APPROVED_KEY_CONTENT_INVALID");
 return apiKey;
}

export async function collectStockTwoDatedSourceCliV1(config,{
 fetchImpl=globalThis.fetch,sleepImpl,
}={}){
 if(!config||!MARKETS.has(config.market)||!config.output||
    !safeDate(config.prior,config.market)||
    !safeDate(config.date,config.market)||config.prior>=config.date||
    config.readPublic!==(typeof config.approvedKeyFile==="string"&&
      config.approvedKeyFile.length>0))
   throw new TypeError("STOCK_TWO_DATED_EXECUTION_CONFIG_INVALID");
 const output=resolve(config.output);
 // Detect occupied destination before incurring licensed/provider GETs.
 try{
  lstatSync(output);
  throw new TypeError("STOCK_TWO_DATED_OUTPUT_ALREADY_EXISTS");
 }catch(error){
  if(error?.code!=="ENOENT")throw error;
 }
 const apiKey=config.readPublic?readApprovedKey(config.approvedKeyFile):null;
 const extra={fetchImpl,...(sleepImpl?{sleepImpl}:{})};
 const source=config.market==="KR_STOCK"
   ?await collectKrxTwoDatedFullStockDailySourcesV1({
      currentDateYmd:config.date,priorTradingDateYmd:config.prior,
      authKey:apiKey,...extra,
    })
   :await collectUSTwoDatedAsOfAllStockPricesV1({
      currentDate:config.date,priorCandidateTradingDate:config.prior,
      apiKey,...extra,
    });
 if(source.market!==config.market||source.executionAuthority!=="NONE"||
    source.profitabilityProven!==false||
    source.trueMarketWideRecall!==null||
    source.actualMarketWideOpportunityCount!==null)
   throw new TypeError("STOCK_TWO_DATED_SOURCE_SAFETY_CONTRACT_INVALID");
 const body=JSON.stringify(source,null,2)+"\n";
 if(Buffer.byteLength(body,"utf8")>MAX_SOURCE_BYTES)
   throw new TypeError("STOCK_TWO_DATED_SOURCE_LOCAL_FILE_TOO_LARGE");
 mkdirSync(dirname(output),{recursive:true});
 writeFileSync(output,body,{mode:0o600,flag:"wx"});
 return Object.freeze({
  market:config.market,prior:config.prior,date:config.date,
  status:source.status,reason:source.reason,
  providerReadOnlyGETs:config.market==="KR_STOCK"?
    source.authorizedKRXDailyGETs:source.readOnlyProviderGETs,
  sourceAttestedNameCount:config.market==="KR_STOCK"?
    source.observedCurrentSymbols:source.observedCurrentAsOfTickerCount,
  outputContainsPrivateApiKey:false,fullMarketOpportunityDenominatorVerified:false,
  actualMarketWideOpportunityCount:null,trueMarketWideRecall:null,
  profitabilityProven:false,executionAuthority:"NONE",
 });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const result=await collectStockTwoDatedSourceCliV1(
   parseStockTwoDatedSourceArgsV1(process.argv.slice(2)));
 process.stdout.write(JSON.stringify(result)+"\n");
}
