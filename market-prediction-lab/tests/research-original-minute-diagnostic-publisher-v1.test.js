import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,
  statSync,chmodSync,symlinkSync,linkSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {publishResearchOriginalMinuteDiagnosticV1 as publish} from
  "../src/research-original-minute-diagnostic-publisher-v1.js";
import {readResearchOriginalMinuteDiagnosticV1 as read}
  from "../src/research-original-minute-diagnostic-readonly-v1.js";

const MARKETS=["KR_STOCK","US_STOCK","CRYPTO_SPOT","CRYPTO_FUTURES"];
const symbols={KR_STOCK:"005930",US_STOCK:"AAPL",
  CRYPTO_SPOT:"KRW-BTC",CRYPTO_FUTURES:"BTCUSDT"};
const dir=()=>mkdtempSync(join(tmpdir(),"original-private-publisher-"));
const period=market=>({
  schemaVersion:"four-market-original-minute-period-v1",
  market,symbol:symbols[market],timeframe:"5m",
  selectedStartDate:"2025-10-01",selectedEndDate:"2026-09-30",
  status:"SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY",
  reason:"PRIVATE_ORIGINAL_1M_MULTI_SESSION_RESEARCH_ONLY_NOT_OOS",
  indexedPrivateSessions:350,verifiedNativeMinuteSessions:350,
  modeledTradeCount:12,modeledReturnPercent:3.25,
  modeledNetPnlKRW:32500,
  executionAuthority:"NONE",profitabilityProven:false,
  OOSPassCount:0,actualFillCount:null,trueMarketWideRecall:null,
  actualMarketWideOpportunityCount:null,netProfitPct:null,
  fullMarketOpportunityDenominatorVerified:false,
  paperAdmissionAllowed:false,realOrders:false,
  liveTrading:false,autoTrading:false,
});
const sweep=market=>({
  schemaVersion:"four-market-original-minute-sweep-v1",
  market,status:"LOCAL_HISTORIC_SOURCE_PAGES_TRAVERSED_RESEARCH_ONLY",
  reason:"RETROSPECTIVE_LOCAL_PAGES_NOT_INDEPENDENT_PIT_OOS_OR_FILL",
  selectedStartDate:"2025-10-01",selectedEndDate:"2026-09-30",
  pageCountSelfAttested:45,sourceOnlyCompletePages:45,
  sourceBlockedPages:0,sourceTasksSelfAttested:180,
  sourceOnlyObservedPriceEventLabels:123,
  localPageTraversalReachedEnd:true,
  executionAuthority:"NONE",profitabilityProven:false,
  OOSPassCount:0,actualFillCount:null,trueMarketWideRecall:null,
  actualMarketWideOpportunityCount:null,netProfitPct:null,
  fullMarketOpportunityDenominatorVerified:false,
  paperAdmissionAllowed:false,realOrders:false,
  liveTrading:false,autoTrading:false,
});
function setup(){
  const base=dir(),privateDir=join(base,"jobs"),
    reportRoot=join(base,"admin");
  mkdirSync(privateDir,{mode:0o700});
  mkdirSync(reportRoot,{mode:0o700});
  return {base,privateDir,reportRoot};
}
function source(folder,value,filename="private-source-result.json"){
  const file=join(folder,filename);
  writeFileSync(file,JSON.stringify(value),{mode:0o600});
  chmodSync(file,0o600);
  return file;
}
test("4 markets publish ONLY a sanitized 0600 market DTO and the admin readback sees it",async()=>{
  const env=setup();
  try{
    for(const market of MARKETS){
      const raw={...period(market),
        apiKey:"CANNOT_APPEAR_IN_ADMIN_RESULT",
        privateRoot:"/root/super-private-candles",
        rawOneMinuteCandles:[{high:1,close:2}],
        privateStrategy:{stopLoss:0.3},orderInstructions:["FORBIDDEN"],
      };
      const input=source(env.privateDir,raw,market+".original.json");
      const reply=await publish({
        sourceResultPath:input,reportRoot:env.reportRoot,market,
        allowLocalReportPublish:true,
      });
      assert.equal(reply.published,true,market);
      assert.equal(reply.reportReplaced,false,market);
      assert.equal(reply.executionAuthority,"NONE");
      assert.equal(reply.profitabilityProven,false);
      assert.equal(reply.actualFillCount,null);
      assert.equal(reply.providerGETCount,0);
      const path=join(env.reportRoot,market+".json");
      assert.equal(statSync(path).mode&0o077,0);
      const privateBytes=readFileSync(path,"utf8");
      assert.doesNotMatch(privateBytes,
        /CANNOT_APPEAR|super-private|rawOneMinuteCandles|privateStrategy|orderInstructions/);
      const admin=await read({root:env.reportRoot,market});
      assert.equal(admin.available,true,market);
      assert.equal(admin.report.kind,"PERIOD",market);
      assert.equal(admin.report.symbol,symbols[market]);
      assert.equal(admin.report.modeledReturnPercent,3.25);
      assert.equal(admin.publicationAgeStatus,"LOCAL_PUBLICATION_ONLY");
      assert.ok(Number.isSafeInteger(admin.reportPublishedAtMs));
      assert.equal(admin.publicationTimeIndependentlyAttested,false);
      assert.equal(admin.trueMarketWideRecall,null);
      assert.equal(admin.actualFillCount,null);
      assert.equal(admin.paperAdmissionAllowed,false);
      assert.equal(admin.profitabilityProven,false);
    }
  }finally{rmSync(env.base,{recursive:true,force:true});}
});
test("no explicit permission or overwrite approval means NO mutation, and replacing is atomic/monotonic",async()=>{
  const env=setup(),market="US_STOCK";
  try{
    const file=source(env.privateDir,period(market));
    const denied=await publish({sourceResultPath:file,
      reportRoot:env.reportRoot,market});
    assert.equal(denied.status,"BLOCKED_DATA");
    assert.equal(denied.published,false);
    assert.equal(existsSync(join(env.reportRoot,market+".json")),false);
    const ts=Date.now()-120_000;
    const first=await publish({sourceResultPath:file,reportRoot:env.reportRoot,
      market,allowLocalReportPublish:true,nowImpl:()=>ts});
    assert.equal(first.published,true);
    const before=readFileSync(join(env.reportRoot,market+".json"),"utf8");
    const noReplace=await publish({sourceResultPath:file,
      reportRoot:env.reportRoot,market,allowLocalReportPublish:true});
    assert.equal(noReplace.reason,"EXPLICIT_EXISTING_MARKET_REPORT_REPLACEMENT_REQUIRED");
    assert.equal(readFileSync(join(env.reportRoot,market+".json"),"utf8"),before);
    const outdated=await publish({sourceResultPath:file,
      reportRoot:env.reportRoot,market,
      allowLocalReportPublish:true,allowReplaceExisting:true,
      nowImpl:()=>ts});
    assert.equal(outdated.reason,"STALE_OR_DUPLICATED_REPORT_PUBLICATION_TIME");
    assert.equal(readFileSync(join(env.reportRoot,market+".json"),"utf8"),before);
    const updated=await publish({sourceResultPath:file,
      reportRoot:env.reportRoot,market,
      allowLocalReportPublish:true,allowReplaceExisting:true,
      nowImpl:()=>ts+1});
    assert.equal(updated.published,true);
    assert.equal(updated.reportReplaced,true);
    const now=JSON.parse(readFileSync(join(env.reportRoot,market+".json"),"utf8"));
    assert.equal(now.reportPublishedAtMs,ts+1);
    assert.equal(now.executionAuthority,"NONE");
    assert.equal(existsSync(join(env.reportRoot,"."+market+".publish.lock")),false);
  }finally{rmSync(env.base,{recursive:true,force:true});}
});
test("the same private publisher can migrate an explicitly approved legacy direct report",async()=>{
  const env=setup(),market="CRYPTO_SPOT";
  try{
    source(env.reportRoot,period(market),market+".json");
    const file=source(env.privateDir,sweep(market));
    const pub=await publish({sourceResultPath:file,
      reportRoot:env.reportRoot,market,
      allowLocalReportPublish:true,allowReplaceExisting:true});
    assert.equal(pub.reportReplaced,true);
    const got=await read({root:env.reportRoot,market});
    assert.equal(got.report.kind,"SWEEP");
    assert.equal(got.report.sourceOnlyObservedPriceEventLabels,123);
    assert.equal(got.actualMarketWideOpportunityCount,null);
    assert.equal(got.profitabilityProven,false);
  }finally{rmSync(env.base,{recursive:true,force:true});}
});
test("new BLOCKED source may explicitly replace a stale positive model so the UI cannot show stale profits",async()=>{
  const env=setup(),market="CRYPTO_FUTURES";
  try{
    const first=source(env.privateDir,period(market),"first.json");
    await publish({sourceResultPath:first,reportRoot:env.reportRoot,
      market,allowLocalReportPublish:true,nowImpl:()=>Date.now()-2_000});
    const blocked={...period(market),status:"BLOCKED_DATA",
      reason:"MISSING_CRITICAL_NATIVE_SOURCE",
      modeledTradeCount:null,modeledReturnPercent:null,
      modeledNetPnlKRW:null,indexedPrivateSessions:null,
      verifiedNativeMinuteSessions:null};
    const next=source(env.privateDir,blocked,"second.json");
    const result=await publish({sourceResultPath:next,reportRoot:env.reportRoot,
      market,allowLocalReportPublish:true,allowReplaceExisting:true});
    assert.equal(result.published,true);
    const admin=await read({root:env.reportRoot,market});
    assert.equal(admin.available,false);
    assert.equal(admin.report,null);
    assert.equal(admin.status,"BLOCKED_DATA");
    assert.equal(admin.profitabilityProven,false);
    assert.equal(admin.actualFillCount,null);
  }finally{rmSync(env.base,{recursive:true,force:true});}
});
test("symlink, hard-link, unsafe modes, wrong market, fake orders/OOS and existing target symlink fail closed",async()=>{
  const env=setup(),market="KR_STOCK";
  try{
    const file=source(env.privateDir,period(market));
    const args={sourceResultPath:file,reportRoot:env.reportRoot,
      market,allowLocalReportPublish:true};
    for(const dangerous of [
      {...period(market),executionAuthority:"LIVE"},
      {...period(market),actualFillCount:3},
      {...period(market),profitabilityProven:true},
      {...period(market),fullMarketOpportunityDenominatorVerified:true},
      {...period(market),market:"US_STOCK"},
      {...period(market),reportPublishedAtMs:"broken"},
    ]){
      source(env.privateDir,dangerous);
      await assert.rejects(()=>publish(args));
      assert.equal(existsSync(join(env.reportRoot,market+".json")),false);
    }
    source(env.privateDir,period(market));
    chmodSync(file,0o644);
    await assert.rejects(()=>publish(args),/RESEARCH_PUBLISH_PRIVATE_SOURCE_REQUIRED/);
    chmodSync(file,0o600);
    const hard=join(env.privateDir,"hard-source.json");
    linkSync(file,hard);
    await assert.rejects(()=>publish(args),/RESEARCH_PUBLISH_PRIVATE_SOURCE_REQUIRED/);
    rmSync(hard);
    const symlink=join(env.privateDir,"linked.json");
    symlinkSync(file,symlink);
    await assert.rejects(()=>publish({...args,sourceResultPath:symlink}));
    rmSync(symlink);
    const target=join(env.reportRoot,market+".json");
    symlinkSync(file,target);
    await assert.rejects(()=>publish({...args,allowReplaceExisting:true}));
    assert.equal(existsSync(file),true);
    assert.equal(existsSync(join(env.reportRoot,"."+market+".publish.lock")),false);
  }finally{rmSync(env.base,{recursive:true,force:true});}
});
test("old local publication stays visibly stale, not passed off as recent market proof",async()=>{
  const env=setup(),market="US_STOCK";
  try{
    const file=source(env.privateDir,period(market));
    const ts=Date.now()-8*86_400_000;
    await publish({sourceResultPath:file,reportRoot:env.reportRoot,
      market,allowLocalReportPublish:true,nowImpl:()=>ts});
    const r=await read({root:env.reportRoot,market});
    assert.equal(r.available,true);
    assert.equal(r.publicationAgeStatus,"OLDER_THAN_7_DAYS");
    assert.equal(r.publicationTimeIndependentlyAttested,false);
    assert.equal(r.reportPublishedAtMs,ts);
    assert.equal(r.profitabilityProven,false);
    assert.equal(r.executionAuthority,"NONE");
  }finally{rmSync(env.base,{recursive:true,force:true});}
});
