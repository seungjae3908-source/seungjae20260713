import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,writeFileSync,readFileSync,statSync,chmodSync,
 existsSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {parseStockTwoDatedSourceArgsV1 as parse,
 collectStockTwoDatedSourceCliV1 as run}
 from "../scripts/collect-stock-two-dated-source-v1.mjs";
import {prepareStockSourceLimitedDailyEvidenceV1 as prepare}
 from "../src/stock-source-limited-daily-evidence-v1.js";

const KR_PRIOR="20250207",KR_NOW="20250210";
const US_PRIOR="2025-01-31",US_NOW="2025-02-03";
const KEY="MOCK-APPROVED-PUBLIC-DATA-KEY";
const KRX={
 KOSPI:{ISU_CD:"KR7005930003",ISU_SRT_CD:"005930",LIST_DD:"19880101"},
 KOSDAQ:{ISU_CD:"KR7035420009",ISU_SRT_CD:"035420",LIST_DD:"20020101"},
 KONEX:{ISU_CD:"KR7278990005",ISU_SRT_CD:"278990",LIST_DD:"20180101"},
};
const callArgs=(market,output,keyFile=null)=>({
 market,prior:market==="KR_STOCK"?KR_PRIOR:US_PRIOR,
 date:market==="KR_STOCK"?KR_NOW:US_NOW,
 output,readPublic:keyFile!==null,approvedKeyFile:keyFile,
});
async function temp(fn){
 const folder=mkdtempSync(join(tmpdir(),"two-stock-source-"));
 try{return await fn(folder);}finally{rmSync(folder,{recursive:true,force:true});}
}
const keyFile=folder=>{
 const p=join(folder,"mock-read-public-key.txt");
 writeFileSync(p,KEY+"\n",{mode:0o600});
 return p;
};

function krxFake(){
 let calls=0;
 const fetchImpl=async(url,opts)=>{
  calls++;
  const u=new URL(url),day=u.searchParams.get("basDd");
  const board=u.pathname.includes("/stk_")?"KOSPI":
    u.pathname.includes("/ksq_")?"KOSDAQ":"KONEX";
  assert.equal(u.hostname,"data-dbg.krx.co.kr");
  assert.equal(opts.headers.AUTH_KEY,KEY);
  assert.equal(opts.method,"GET");
  assert.ok([KR_PRIOR,KR_NOW].includes(day));
  const item=KRX[board];
  if(u.pathname.includes("_isu_base_info"))
    return {ok:true,status:200,async json(){return {
      OutBlock_1:[{...item,MKT_TP_NM:board,SECUGRP_NM:"STOCK"}],
    }}};
  assert.ok(u.pathname.includes("_bydd_trd"));
  const today=day===KR_NOW;
  return {ok:true,status:200,async json(){return {
   OutBlock_1:[{
    BAS_DD:day,ISU_CD:item.ISU_CD,
    TDD_OPNPRC:today?"10,000":"9,000",
    TDD_HGPRC:today?"11,000":"9,800",
    TDD_LWPRC:"8,900",TDD_CLSPRC:today?"10,500":"9,400",
    ACC_TRDVOL:"1,000",ACC_TRDVAL:"9,500,000",
   }],
  }}};
 };
 return {fetchImpl,getCalls:()=>calls};
}
function usFake({omitLastPrior=false}={}){
 let calls=0;
 const fetchImpl=async(url,opts)=>{
  calls++;
  const u=new URL(url),roster=u.pathname==="/v3/reference/tickers";
  const day=roster?u.searchParams.get("date"):u.pathname.split("/").at(-1);
  assert.equal(u.hostname,"api.massive.com");
  assert.equal(opts.headers.Authorization,"Bearer "+KEY);
  assert.equal(opts.method,"GET");
  assert.equal(u.searchParams.has("apiKey"),false);
  assert.ok([US_PRIOR,US_NOW].includes(day));
  const names=day===US_NOW?["AAA","BBB"]:omitLastPrior?["AAA"]:["AAA","BBB"];
  if(roster)return {ok:true,status:200,async json(){return {
    status:"OK",results:names.map((ticker,i)=>({
      ticker,active:true,market:"stocks",locale:"us",
      primary_exchange:"XNYS",type:"CS",
      share_class_figi:ticker==="AAA"?"BBG000000001":"BBG000000002",
    })),
  }}};
  assert.equal(u.searchParams.get("adjusted"),"false");
  const ts=Date.parse(day+"T05:00:00Z");
  return {ok:true,status:200,async json(){return {
   status:"OK",adjusted:false,
   results:names.map((ticker,i)=>({
     T:ticker,t:ts,o:100,h:115,l:95,c:105,v:1000,
   })),
  }}};
 };
 return {fetchImpl,getCalls:()=>calls};
}
test("default KR/US source CLI is no-key offline, zero GET and BLOCKED",async()=>{
 await temp(async folder=>{
  for(const market of ["KR_STOCK","US_STOCK"]){
   let calls=0;
   const p=join(folder,market+"-blocked.json");
   const config=callArgs(market,p);
   const r=await run(config,{fetchImpl:async()=>{calls++;throw Error("GET_UNSAFE");}});
   assert.equal(calls,0);
   assert.equal(r.providerReadOnlyGETs,0);
   assert.equal(r.executionAuthority,"NONE");
   assert.equal(r.actualMarketWideOpportunityCount,null);
   const stored=JSON.parse(readFileSync(p,"utf8"));
   assert.equal(stored.status,market==="KR_STOCK"?
     "BLOCKED_MARKET_DATA_ENTITLEMENT":"BLOCKED_DATA");
   assert.equal(stored.trueMarketWideRecall,null);
   assert.equal(statSync(p).mode&0o077,0);
  }
 });
});
test("authorized KRX two dated three-board GETs save a reusable local source receipt",async()=>{
 await temp(async folder=>{
  const auth=keyFile(folder),out=join(folder,"kr.json"),mock=krxFake();
  const cfg=parse([
   "--market","KR_STOCK","--prior",KR_PRIOR,"--date",KR_NOW,
   "--read-public","--approved-key-file",auth,"--output",out,
  ]);
  const r=await run(cfg,{fetchImpl:mock.fetchImpl,sleepImpl:async()=>{}});
  assert.equal(mock.getCalls(),12);
  assert.equal(r.status,"SOURCE_LIMITED_TWO_KRX_DATES_JOINED_ONLY");
  assert.equal(r.sourceAttestedNameCount,3);
  const source=JSON.parse(readFileSync(out,"utf8"));
  assert.equal(source.records.length,3);
  assert.equal(source.joinedSourceRowsSha256,
    createHash("sha256").update(JSON.stringify(source.records)).digest("hex"));
  assert.deepEqual(source.requestedTradingDates,[KR_PRIOR,KR_NOW]);
  assert.equal(source.officialAdjacentTradingSessionCalendarVerified,false);
  assert.equal(source.fullMarketHistoricDelistedUniverseVerified,false);
  assert.equal(source.trueMarketWideRecall,null);
  assert.equal(prepare({market:"KR_STOCK",source}).status,
    "SOURCE_ATTESTED_TWO_DATED_STOCK_PRICE_BARS_ONLY");
  assert.equal(JSON.stringify(source).includes(KEY),false);
  assert.equal(statSync(out).mode&0o077,0);
 });
});
test("authorized US two dated as-of roster with ET bars saves full provider cohort",async()=>{
 await temp(async folder=>{
  const out=join(folder,"us.json"),cfg=callArgs("US_STOCK",out,keyFile(folder));
  const mock=usFake();
  const r=await run(cfg,{fetchImpl:mock.fetchImpl,sleepImpl:async()=>{}});
  assert.equal(mock.getCalls(),4);
  assert.equal(r.status,"SOURCE_LIMITED_TWO_US_ASOF_DATES_JOINED_ONLY");
  assert.equal(r.sourceAttestedNameCount,2);
  const stored=JSON.parse(readFileSync(out,"utf8"));
  assert.deepEqual(stored.rows.map(row=>row.symbol),["AAA","BBB"]);
  assert.equal(stored.joinedSourceRowsSha256,
    createHash("sha256").update(JSON.stringify(stored.rows)).digest("hex"));
  assert.equal(stored.adjacentStockTradingSessionsAuthenticated,false);
  assert.equal(stored.actualMarketWideOpportunityCount,null);
  assert.equal(prepare({market:"US_STOCK",source:stored}).status,
    "SOURCE_ATTESTED_TWO_DATED_STOCK_PRICE_BARS_ONLY");
  assert.equal(JSON.stringify(stored).includes(KEY),false);
  assert.equal(statSync(out).mode&0o077,0);
 });
});
test("newly listed stock without prior bar remains PARTIAL, never an invented zero",async()=>{
 await temp(async folder=>{
  const p=join(folder,"us-missing.json"),cfg=callArgs("US_STOCK",p,keyFile(folder));
  const mock=usFake({omitLastPrior:true});
  const r=await run(cfg,{fetchImpl:mock.fetchImpl,sleepImpl:async()=>{}});
  assert.equal(mock.getCalls(),4);
  assert.equal(r.status,"PARTIAL_US_PRIOR_PRICE_OR_LIFECYCLE_BLOCKED");
  const receipt=JSON.parse(readFileSync(p,"utf8"));
  assert.equal(receipt.missingPriorPriceOrIdentityCount,1);
  assert.equal(receipt.actualMarketWideOpportunityCount,null);
  assert.equal(prepare({market:"US_STOCK",source:receipt}).status,"BLOCKED_DATA");
 });
});
test("preexisting output prevents licensed API calls; read-only key never leaks",async()=>{
 await temp(async folder=>{
  const out=join(folder,"existing.json"),key=keyFile(folder);
  writeFileSync(out,"{}",{mode:0o600});
  let calls=0;
  await assert.rejects(run(callArgs("US_STOCK",out,key),{
    fetchImpl:async()=>{calls++;throw Error("SHOULD_NOT_GET");},
  }),/STOCK_TWO_DATED_OUTPUT_ALREADY_EXISTS/);
  assert.equal(calls,0);
  assert.equal(readFileSync(out,"utf8"),"{}");
  chmodSync(key,0o644);
  const other=join(folder,"new.json");
  await assert.rejects(run(callArgs("US_STOCK",other,key)),
    /STOCK_TWO_DATED_APPROVED_KEY_FILE_UNSAFE/);
  assert.equal(existsSync(other),false);
 });
});
test("invalid market/dates or half-authorized CLI input fails closed",()=>{
 const base=["--market","US_STOCK","--prior",US_PRIOR,
  "--date",US_NOW,"--output","/tmp/source.json"];
 assert.throws(()=>parse([...base,"--read-public"]),
   /STOCK_TWO_DATED_APPROVED_READ_AND_KEY_REQUIRED/);
 assert.throws(()=>parse([...base,"--approved-key-file","/tmp/key.txt"]),
   /STOCK_TWO_DATED_APPROVED_READ_AND_KEY_REQUIRED/);
 assert.throws(()=>parse(["--market","CRYPTO_SPOT",...base.slice(2)]),
   /STOCK_TWO_DATED_REQUIRED_MARKET_DATES_OUTPUT/);
 assert.throws(()=>parse(["--market","US_STOCK","--prior","2025-02-31",
   "--date",US_NOW,"--output","/tmp/out.json"]),
   /STOCK_TWO_DATED_REQUIRED_MARKET_DATES_OUTPUT/);
 assert.throws(()=>parse([...base,"--output","/tmp/another"]),
   /STOCK_TWO_DATED_INVALID_CLI_OPTION/);
});
