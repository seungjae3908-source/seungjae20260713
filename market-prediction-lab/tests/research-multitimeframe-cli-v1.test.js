import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,readFileSync,writeFileSync,statSync,chmodSync,rmSync,existsSync}
 from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {parseResearchMultiTimeframeArgsV1 as parse,
 runResearchMultiTimeframeCliV1 as run}
 from "../scripts/build-research-multitimeframe-v1.mjs";
const d=Date.parse("2026-09-18T00:00:00Z"),M=60_000;
const digest=r=>createHash("sha256").update(JSON.stringify(r)).digest("hex");
function receipt(){
 const market="CRYPTO_SPOT",venue="UPBIT_KRW",symbol="KRW-ABC";
 const sourceId="OFFLINE_MOCK_MINUTE_SOURCE";
 const minuteBars=Array.from({length:10},(_,i)=>({
  market,venue,symbol,sourceId,timestampMs:d+i*M,
  availableAtMs:d+(i+1)*M,
  open:100+i,high:103+i,low:99+i,close:101+i,volume:20,
 }));
 return {market,venue,symbol,sourceId,
  session:{startMs:d,endMs:d+86_400_000,
   kind:"UTC_24H",timeZone:"UTC",calendarSourceId:"PRIVATE_MOCK_CALENDAR"},
  asOfMs:d+10*M,minuteBars,sourceMinuteRowsSha256:digest(minuteBars)};
}
function config(input,output,args=[]){
 return parse(["--market","CRYPTO_SPOT","--timeframes","3m,5m",
  "--input",input,"--output",output,...args]);
}
test("offline private 1m input creates complete 3m and 5m bars with UTC as-of",()=>{
 const folder=mkdtempSync(join(tmpdir(),"research-multi-cli-"));
 try{
  const input=join(folder,"1m.json"),output=join(folder,"multiframe.json");
  writeFileSync(input,JSON.stringify(receipt()),{mode:0o600});
  const a=config(input,output,["--as-of","2026-09-18T00:10:00Z"]);
  const r=run(a);
  assert.equal(r.status,"SOURCE_LIMITED_DERIVED_MULTI_TIMEFRAME_BARS_ONLY");
  assert.equal(r.derivedCandleCount,5);
  const saved=JSON.parse(readFileSync(output,"utf8"));
  assert.equal(saved.intervalData["3m"].completeBarCount,3);
  assert.equal(saved.intervalData["5m"].completeBarCount,2);
  assert.equal(saved.intervalData["5m"].bars[0].open,100);
  assert.equal(saved.intervalData["5m"].bars[0].close,105);
  assert.equal(saved.sourceMinuteIntegrityVerified,true);
  assert.equal(saved.actualFillCount,null);
  assert.equal(saved.netProfitPct,null);
  assert.equal(saved.trueMarketWideRecall,null);
  assert.equal(saved.profitabilityProven,false);
  assert.equal(saved.executionAuthority,"NONE");
  assert.equal(statSync(output).mode&0o077,0);
  assert.throws(()=>run(a),/RESEARCH_MULTI_OUTPUT_ALREADY_EXISTS/);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("private input with group access or modified source digest cannot qualify",()=>{
 const folder=mkdtempSync(join(tmpdir(),"research-multi-unsafe-"));
 try{
  const input=join(folder,"raw.json"),output=join(folder,"derived.json");
  const original=receipt();
  writeFileSync(input,JSON.stringify(original),{mode:0o600});
  chmodSync(input,0o644);
  assert.throws(()=>run(config(input,output)),
   /RESEARCH_MULTI_PRIVATE_ONE_MINUTE_FILE_REQUIRED/);
  assert.equal(existsSync(output),false);
  chmodSync(input,0o600);
  original.minuteBars[0].high=998;
  writeFileSync(input,JSON.stringify(original),{mode:0o600,flag:"w"});
  const blocked=run(config(input,output));
  assert.equal(blocked.status,"BLOCKED_DATA");
  const record=JSON.parse(readFileSync(output,"utf8"));
  assert.equal(record.reason,"MULTITIMEFRAME_MINUTE_ROWS_MISSING_OR_DIGEST_CHANGED");
  assert.equal(record.actualMarketWideOpportunityCount,null);
  assert.equal(record.executionAuthority,"NONE");
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("invalid or omitted required timeframe selection and mismatched market stop",()=>{
 const folder=mkdtempSync(join(tmpdir(),"research-multi-market-"));
 try{
  const input=join(folder,"raw.json"),output=join(folder,"derived.json");
  writeFileSync(input,JSON.stringify(receipt()),{mode:0o600});
  assert.throws(()=>parse(["--market","US_STOCK","--timeframes","5m",
   "--input",input]),/RESEARCH_MULTI_CLI_ARGS_INVALID/);
  assert.throws(()=>parse(["--market","CRYPTO_SPOT","--timeframes","5m",
   "--input",input,"--output",output,
   "--as-of","2026-09-18T09:20:00"]),/RESEARCH_MULTI_ASOF_UTC_REQUIRED/);
  assert.throws(()=>run(parse(["--market","US_STOCK","--timeframes","5m",
   "--input",input,"--output",output])),
   /RESEARCH_MULTI_SOURCE_MARKET_OR_CUTOFF_INVALID/);
  assert.equal(existsSync(output),false);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
