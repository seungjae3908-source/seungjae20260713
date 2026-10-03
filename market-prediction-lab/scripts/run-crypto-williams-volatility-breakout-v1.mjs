import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectUpbitSpotHistory } from "../src/upbit-spot-history.js";

const START = Date.parse("2019-01-01T00:00:00.000Z");
const END = Date.parse("2026-09-30T00:00:00.000Z");
const SYMBOLS = Object.freeze(["BTC", "ETH", "XRP"]);
const COST_PER_SIDE = 0.0015;
const STRESS_COST_PER_SIDE = COST_PER_SIDE * 1.5;
const RULE = Object.freeze({
  id: "LARRY_WILLIAMS_VOLATILITY_BREAKOUT_K05_V1",
  k: 0.5,
  sessionBoundary: "KST_09:00_EQ_UTC_00:00",
  direction: "LONG_ONLY",
  exit: "SAME_SESSION_CLOSE",
});
const WINDOWS = Object.freeze({
  PRIOR: Object.freeze({ start: "2019-01-01", endExclusive: "2022-01-01" }),
  MID: Object.freeze({ start: "2022-01-01", endExclusive: "2025-01-01" }),
  RECENT: Object.freeze({ start: "2025-01-01", endExclusive: "2026-10-01" }),
});
const SOURCE_BOOK = "Larry Williams, Long-Term Secrets to Short-Term Trading";
const SOURCE_REFERENCE = "https://plutux.ai/resources/trading-systems/volatility-breakout-larry-williams";

function mean(values){return values.length?values.reduce((s,v)=>s+v,0)/values.length:null;}
function median(values){if(!values.length)return null;const a=[...values].sort((x,y)=>x-y);const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}
function dateOf(ms){return new Date(ms).toISOString().slice(0,10);}
function inWindow(date, w){return date>=w.start&&date<w.endExclusive;}

function aggregateDaily(candles){
  const byDate=new Map();
  for(const c of candles){
    const date=dateOf(c.timestamp);
    const rows=byDate.get(date)??[];
    rows.push(c); byDate.set(date,rows);
  }
  const out=[];
  for(const [date,rows] of [...byDate.entries()].sort(([a],[b])=>a.localeCompare(b))){
    rows.sort((a,b)=>a.timestamp-b.timestamp);
    if(rows.length!==6) continue;
    const expected=[0,4,8,12,16,20];
    const hours=rows.map(r=>new Date(r.timestamp).getUTCHours());
    if(hours.some((h,i)=>h!==expected[i])) continue;
    out.push({
      date,
      open:rows[0].open,
      high:Math.max(...rows.map(r=>r.high)),
      low:Math.min(...rows.map(r=>r.low)),
      close:rows.at(-1).close,
      rows,
    });
  }
  return out;
}
function summarize(trades){
  if(!trades.length)return{trades:0,meanNetReturn:null,medianNetReturn:null,winRate:null,profitFactor:null,compound:null,maxDrawdown:null,tradeDayRate:null};
  const ret=trades.map(t=>t.netReturn);
  const gains=ret.filter(v=>v>0).reduce((s,v)=>s+v,0);
  const losses=-ret.filter(v=>v<0).reduce((s,v)=>s+v,0);
  let eq=1,peak=1,dd=0;
  for(const r of ret){eq*=1+r;peak=Math.max(peak,eq);dd=Math.max(dd,(peak-eq)/peak);}
  return{trades:trades.length,meanNetReturn:mean(ret),medianNetReturn:median(ret),winRate:ret.filter(v=>v>0).length/ret.length,profitFactor:losses>0?gains/losses:(gains>0?null:0),compound:eq-1,maxDrawdown:dd};
}
function replay(symbol,daily,window,cost){
  const trades=[];
  let eligibleDays=0;
  for(let i=1;i<daily.length;i+=1){
    const day=daily[i],prev=daily[i-1];
    if(!inWindow(day.date,window))continue;
    eligibleDays+=1;
    const range=prev.high-prev.low;
    if(!(range>0))continue;
    const trigger=day.open+RULE.k*range;
    if(day.high<trigger)continue;
    let entry=null,entryBar=null;
    for(const bar of day.rows){
      if(bar.high<trigger)continue;
      entry=Math.max(trigger,bar.open);
      entryBar=bar;
      break;
    }
    if(!(entry>0)||!entryBar)continue;
    const rawExit=day.close;
    const gross=rawExit/entry-1;
    const net=rawExit*(1-cost)/(entry*(1+cost))-1;
    trades.push({symbol,date:day.date,previousRange:range,dayOpen:day.open,trigger,entry,entryBarUtcHour:new Date(entryBar.timestamp).getUTCHours(),rawExit,grossReturn:gross,netReturn:net});
  }
  const metrics=summarize(trades);
  metrics.tradeDayRate=eligibleDays?trades.length/eligibleDays:null;
  return{metrics,trades,eligibleDays};
}
function buyHold(daily,window,cost){
  const rows=daily.filter(d=>inWindow(d.date,window));
  if(rows.length<2)return null;
  return rows.at(-1).close*(1-cost)/(rows[0].open*(1+cost))-1;
}
function selfTest(){
  const rows=[];
  for(let d=0;d<3;d+=1){
    for(const h of [0,4,8,12,16,20]){
      const p=100+d*2+h/100;
      rows.push({timestamp:Date.UTC(2024,0,1+d,h),open:p,high:p+1,low:p-1,close:p+0.2,volume:1});
    }
  }
  const daily=aggregateDaily(rows);
  if(daily.length!==3)throw new Error("SELFTEST_DAILY");
  const trigger=daily[1].open+0.5*(daily[0].high-daily[0].low);
  if(!(trigger>daily[1].open))throw new Error("SELFTEST_TRIGGER");
  console.log("WILLIAMS_VOLATILITY_BREAKOUT_SELF_TEST_OK");
}
async function main(){
  if(process.argv.includes("--self-test")){selfTest();return;}
  const datasets=[];
  for(const symbol of SYMBOLS){
    const data=await collectUpbitSpotHistory({
      symbol,
      timeframe:"4h",
      startTime:START,
      endTime:END,
      maxPages:100,
      minIntervalMs:110,
    });
    const daily=aggregateDaily(data.candles);
    if(daily.length<1800)throw new Error(`${symbol}_DAILY_HISTORY_INSUFFICIENT_${daily.length}`);
    datasets.push({symbol,daily,report:{symbol,source:data.source,candles4h:data.candleCount,dailySessions:daily.length,firstDate:daily[0].date,lastDate:daily.at(-1).date}});
  }
  const results={};
  for(const {symbol,daily} of datasets){
    results[symbol]={};
    for(const [name,window] of Object.entries(WINDOWS)){
      results[symbol][name]={
        normal:replay(symbol,daily,window,COST_PER_SIDE),
        stress15x:replay(symbol,daily,window,STRESS_COST_PER_SIDE),
        priceOnlyBuyHold:buyHold(daily,window,COST_PER_SIDE),
      };
    }
  }
  const aggregate={};
  for(const name of Object.keys(WINDOWS)){
    const normal=SYMBOLS.map(s=>results[s][name].normal.metrics);
    const stress=SYMBOLS.map(s=>results[s][name].stress15x.metrics);
    aggregate[name]={
      symbolsPositiveNormal:normal.filter(m=>m.compound>0).length,
      symbolsPositiveStress:stress.filter(m=>m.compound>0).length,
      meanCompoundNormal:mean(normal.map(m=>m.compound)),
      meanCompoundStress:mean(stress.map(m=>m.compound)),
      meanProfitFactorNormal:mean(normal.map(m=>m.profitFactor).filter(Number.isFinite)),
      meanMaxDrawdownNormal:mean(normal.map(m=>m.maxDrawdown)),
      meanTradeDayRate:mean(normal.map(m=>m.tradeDayRate)),
      meanPriceOnlyBuyHold:mean(SYMBOLS.map(s=>results[s][name].priceOnlyBuyHold)),
    };
  }
  const transferPassed=Object.values(aggregate).every(row=>row.symbolsPositiveStress===SYMBOLS.length);
  const report={
    schemaVersion:1,status:"pass",recipeId:RULE.id,market:"CRYPTO_SPOT",
    purpose:"source-faithful Larry Williams volatility breakout baseline before local filters or optimization",
    source:{
      book:SOURCE_BOOK,secondaryRuleReference:SOURCE_REFERENCE,
      rules:{trigger:"today open + 0.5 * prior session (high-low)",entry:"buy stop when session trades through trigger",exit:"same synthetic KST day close"},
    },
    implementation:{
      parameterSearch:false,ruleRetuning:false,k:RULE.k,
      session:"KST 09:00 to next KST 09:00 aggregated from six Upbit 4h candles",
      entryFill:"max(pre-known trigger, crossing 4h bar open)",
      costPerSide:COST_PER_SIDE,stressCostPerSide:STRESS_COST_PER_SIDE,
      stopLossAdded:false,trendFilterAdded:false,aiOverlayAdded:false,
    },
    data:{provider:"Upbit public 4h candles",datasets:datasets.map(d=>d.report),symbols:SYMBOLS},
    windows:WINDOWS,results,aggregate,
    promotionAssessment:{
      status:transferPassed?"REFERENCE_CANDIDATE_REQUIRES_FUTURE_OOS":"RESEARCH_HOLD_CROSS_SYMBOL_OR_WINDOW_GENERALIZATION_FAILED",
      crossSymbolWindowStressPassed:transferPassed,
      automaticPromotionAllowed:false,economicSampleCredit:0,profitabilityClaimAllowed:false,
      kOptimizationAllowedAfterObservation:false,symbolSelectionAllowedAfterObservation:false,
    },
    safeguards:{researchOnly:true,publicDataOnly:true,privateAccountRequestAllowed:false,actualOrders:0,orderRouteCalled:false,executionAuthority:"NONE",liveExecutionAllowed:false},
    limitations:[
      "K=0.5 is a fixed commonly published variant; Larry Williams variants use different multipliers, so this run must not optimize K after seeing the result.",
      "A synthetic crypto day is defined as KST 09:00 to 09:00; this is a translation of a session-based strategy to a 24/7 market.",
      "4h candle highs prove trigger touch but not tick-level queue position; entry uses a pre-known stop level plus explicit research costs.",
      "No stop, trend filter, noise ratio, moving average, weekday filter, or AI is added to the baseline.",
      "Historical replay cannot prove future profitability or change PROFITABILITY_PROVEN.",
    ],
  };
  const out=resolve(process.argv[2]??"docs/crypto-williams-volatility-breakout-v1.json");
  await mkdir(dirname(out),{recursive:true});
  await writeFile(out,JSON.stringify(report,null,2)+"\n","utf8");
  console.log(JSON.stringify({status:report.status,promotionStatus:report.promotionAssessment.status,prior:aggregate.PRIOR,mid:aggregate.MID,recent:aggregate.RECENT}));
}
await main();
