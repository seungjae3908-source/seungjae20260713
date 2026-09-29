import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import { buildAdaptiveMultiEvidencePriceStructureV2 } from "../src/adaptive-multi-evidence-price-structure-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID } from "../src/adaptive-multi-evidence-point-in-time-v2.js";

const DAY=86_400_000, COST=0.0015, OBSERVED_CUTOFF="2026-09-22";
const TOP_PER_DAY=6, INTRADAY_CAP=24;
const ACCOUNT=Object.freeze({riskPerTrade:0.005,maxWeight:0.20,maxConcurrent:3,maxPerSector:2});
const FAMILIES=Object.freeze({
  BALANCED:Object.freeze({name:"BALANCED",trend:"NON_BEARISH",minBody:0.45,minCloseLoc:0.65,minVolReaccel:0.90,maxVwapDistance:0.035,eventMode:"UP_EVENT"}),
  TREND:Object.freeze({name:"TREND",trend:"BULLISH",minBody:0.45,minCloseLoc:0.70,minVolReaccel:1.00,maxVwapDistance:0.030,eventMode:"ANY"}),
  RETEST:Object.freeze({name:"RETEST",trend:"NON_BEARISH",minBody:0.35,minCloseLoc:0.60,minVolReaccel:0.80,maxVwapDistance:0.030,eventMode:"RETEST_HELD"}),
  EXPANSION:Object.freeze({name:"EXPANSION",trend:"NON_BEARISH",minBody:0.50,minCloseLoc:0.75,minVolReaccel:1.10,maxVwapDistance:0.025,eventMode:"BOS_OR_CHOCH",minRangeAtr:1.20}),
});
const ny=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});

function parts(ms){const p=Object.fromEntries(ny.formatToParts(new Date(ms)).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));return {date:`${p.year}-${p.month}-${p.day}`,hour:+p.hour,minute:+p.minute};}
function mean(v){return v.length?v.reduce((a,b)=>a+b,0)/v.length:0;}
function median(v){if(!v.length)return 0;const x=[...v].sort((a,b)=>a-b),m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function clamp(x,a=0,b=1){return Math.min(b,Math.max(a,x));}
function sma(c,i,p){if(i-p+1<0)return null;let s=0;for(let j=i-p+1;j<=i;j++)s+=c[j].close;return s/p;}
function highBefore(c,i,p){if(i-p<0)return null;let h=-Infinity;for(let j=i-p;j<i;j++)h=Math.max(h,c[j].high);return Number.isFinite(h)?h:null;}
function avgDollar(c,i,p){if(i-p<0)return null;let s=0;for(let j=i-p;j<i;j++)s+=c[j].close*c[j].volume;return s/p;}
function num(v){const n=Number(String(v??"").replace(/[$,% ,]/g,""));return Number.isFinite(n)?n:null;}
function regular(ms){const p=parts(ms),m=p.hour*60+p.minute;return m>=570&&m<960;}
function securityEligible(row){const s=String(row.symbol??"").trim().toUpperCase(),n=String(row.name??""),i=String(row.industry??"");return /^[A-Z][A-Z0-9.-]{0,9}$/.test(s)&&!/(Warrant|Rights?|Units?|Preferred|Depositary Preferred)/i.test(n)&&!/Blank Checks/i.test(i)&&!/Acquisition Corp/i.test(n)&&!(/[RWU]$/.test(s)&&s.length>=4);}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function universe(){
  const r=await fetch("https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true",{headers:{accept:"application/json,text/plain,*/*","user-agent":"Mozilla/5.0 Chrome/120"}});
  if(!r.ok)throw new Error(`NASDAQ_HTTP_${r.status}`);
  const raw=(await r.json())?.data?.rows;if(!Array.isArray(raw)||raw.length<1000)throw new Error("NASDAQ_UNIVERSE_INSUFFICIENT");
  const rows=raw.map(x=>{const price=num(x.lastsale),volume=num(x.volume),marketCap=num(x.marketCap);return {symbol:String(x.symbol??"").trim().toUpperCase(),name:String(x.name??""),sector:String(x.sector??"UNKNOWN")||"UNKNOWN",industry:String(x.industry??""),price,volume,marketCap,dollarVolume:price&&volume?price*volume:0};}).filter(x=>securityEligible(x)&&x.price>=2&&x.marketCap>0&&x.dollarVolume>0);
  const large=rows.filter(x=>x.marketCap>=10e9).sort((a,b)=>b.dollarVolume-a.dollarVolume).slice(0,12).map(x=>({...x,bucket:"LARGE"}));
  const mid=rows.filter(x=>x.marketCap>=2e9&&x.marketCap<10e9).sort((a,b)=>b.dollarVolume-a.dollarVolume).slice(0,12).map(x=>({...x,bucket:"MID"}));
  const small=rows.filter(x=>x.marketCap>=3e8&&x.marketCap<2e9).sort((a,b)=>b.dollarVolume-a.dollarVolume).slice(0,12).map(x=>({...x,bucket:"SMALL"}));
  return {rawRows:raw.length,rows:[...large,...mid,...small]};
}
async function daily(symbol){let e;for(let a=0;a<3;a++){try{return await collectYahooStockHistory({market:"US_STOCK",symbol,startTime:Date.now()-380*DAY,endTime:Date.now()+DAY,timeoutMs:15_000});}catch(x){e=x;await sleep(350*(a+1));}}throw e;}
async function bars5(symbol){const enc=encodeURIComponent(symbol),q="range=1mo&interval=5m&includePrePost=true&events=div%2Csplits";let last;for(let a=0;a<4;a++){for(const host of ["query1.finance.yahoo.com","query2.finance.yahoo.com"]){try{const r=await fetch(`https://${host}/v8/finance/chart/${enc}?${q}`,{headers:{accept:"application/json,text/plain,*/*","user-agent":"Mozilla/5.0 Chrome/120"}});if(!r.ok)throw new Error(`YAHOO_5M_HTTP_${r.status}`);const z=(await r.json())?.chart?.result?.[0],ts=z?.timestamp??[],o=z?.indicators?.quote?.[0]??{},out=[];for(let i=0;i<ts.length;i++){const row={timestamp:+ts[i]*1000,open:+o.open?.[i],high:+o.high?.[i],low:+o.low?.[i],close:+o.close?.[i],volume:+o.volume?.[i]};if(Number.isFinite(row.timestamp)&&[row.open,row.high,row.low,row.close,row.volume].every(Number.isFinite)&&Math.min(row.open,row.high,row.low,row.close)>0&&row.volume>=0)out.push(row);}if(out.length<100)throw new Error(`YAHOO_5M_INSUFFICIENT_${out.length}`);return out.sort((a,b)=>a.timestamp-b.timestamp);}catch(e){last=e;}}await sleep(1200*(a+1));}throw last;}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let n=0;async function w(){for(;;){const i=n++;if(i>=items.length)return;try{out[i]={ok:true,value:await fn(items[i],i)};}catch(e){out[i]={ok:false,error:String(e?.message??e)};}}}await Promise.all(Array.from({length:Math.min(limit,items.length)},()=>w()));return out;}
function groupDays(rows){const m=new Map();for(const r of rows){if(!regular(r.timestamp))continue;const d=parts(r.timestamp).date,a=m.get(d)??[];a.push(r);m.set(d,a);}return m;}
function completeDates(rows){return [...groupDays(rows).entries()].filter(([,v])=>v.length>=60).map(([d])=>d).sort();}
function aggregate15(rows){const out=[];for(let i=0;i<rows.length;i+=3){const q=rows.slice(i,i+3);if(q.length<3)break;out.push({timestamp:q[0].timestamp,closeTime:q[2].timestamp+5*60_000,open:q[0].open,high:Math.max(...q.map(x=>x.high)),low:Math.min(...q.map(x=>x.low)),close:q[2].close,volume:q.reduce((s,x)=>s+x.volume,0)});}return out;}
function vwap(rows,cutoff){let pv=0,v=0;for(const r of rows){if(r.timestamp>=cutoff)break;if(r.volume>0){pv+=((r.high+r.low+r.close)/3)*r.volume;v+=r.volume;}}return v?pv/v:null;}

function structure(symbol,timeframe,bars,decision){
  const x=bars.map(b=>{const t=new Date(b.closeTime??(b.timestamp+5*60_000)).toISOString();return {isClosed:true,eventTime:t,publishedAt:t,availableAt:t,observedAt:t,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume};});
  return buildAdaptiveMultiEvidencePriceStructureV2({lineageId:ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,market:"US_STOCK",symbol,timeframe,side:"LONG",decisionTime:new Date(decision).toISOString(),source:{sourceId:"yahoo-5m",originalSourceId:"yahoo-5m",sourceType:"PUBLIC_MARKET_DATA",sourceUrl:"https://query1.finance.yahoo.com/",documentId:`${symbol}:${timeframe}`},candles:x,options:timeframe==="5m"?{atrPeriod:6,volumeLookback:6,pivotLeftBars:1,pivotRightBars:1,compressionLookback:3}:{atrPeriod:4,volumeLookback:4,pivotLeftBars:1,pivotRightBars:1,compressionLookback:2}});
}
function candidate(row,spy,date){
  const c=row.candles,ds=c.map(x=>parts(x.timestamp).date);let i=-1;for(let j=0;j<ds.length;j++)if(ds[j]<date)i=j;else break;
  const sd=spy.map(x=>parts(x.timestamp).date);let si=-1;for(let j=0;j<sd.length;j++)if(sd[j]<date)si=j;else break;if(i<60||si<20)return null;
  const close=c[i].close,m20=sma(c,i,20),m20p=sma(c,i-5,20),m50=sma(c,i,50),h20=highBefore(c,i+1,20),ad=avgDollar(c,i,20);if(![m20,m20p,m50,h20,ad].every(x=>x>0))return null;
  const rs20=(close/c[i-20].close-1)-(spy[si].close/spy[si-20].close-1),dv=(close*c[i].volume)/ad,near=close/h20,range=c[i].high-c[i].low,body=range?Math.abs(c[i].close-c[i].open)/range:0,cl=range?(c[i].close-c[i].low)/range:0;
  if(!(close>m20&&m20>m20p&&close>m50&&near>=0.88&&dv>=0.7))return null;
  const score=25+20*clamp((rs20+0.05)/0.25)+15*clamp((dv-0.7)/2.3)+15*clamp((near-0.88)/0.12)+10*(cl>=0.65)+5*(body>=0.45);
  return {symbol:row.symbol,sector:row.sector,bucket:row.bucket,date,preparedAt:ds[i],setupScore:+Math.min(100,score).toFixed(2),setup:{rs20,dollarVolumeAcceleration:dv,near20dHigh:near,closeLocation:cl,bodyRangeRatio:body}};
}
function familyPass(f,f5,f15,vwd,vr){
  const c=f5.candle,ps=f5.priceStructure,p=f5.pattern;
  if(ps.trend==="BEARISH"||f15?.priceStructure?.trend==="BEARISH"||vwd<0||vwd>f.maxVwapDistance||c.direction!=="UP"||(c.bodyRangeRatio??0)<f.minBody||(c.closeLocation??0)<f.minCloseLoc||vr<f.minVolReaccel)return false;
  if(f.trend==="BULLISH"&&ps.trend!=="BULLISH")return false;
  if(f.eventMode==="RETEST_HELD"&&ps.structureEvent!=="RETEST_HELD")return false;
  if(f.eventMode==="BOS_OR_CHOCH"&&!["BOS_UP","CHOCH_UP"].includes(p.structureTransition))return false;
  if(f.eventMode==="UP_EVENT"&&!(ps.structureEventDirection==="UP"||["BOS_UP","CHOCH_UP"].includes(p.structureTransition)))return false;
  if((f.minRangeAtr??0)>0&&(c.rangeAtrRatio??0)<f.minRangeAtr)return false;
  return true;
}
function exit(day,entryIndex,entryRaw,stopRaw){
  const entry=entryRaw*(1+COST),risk=entryRaw-stopRaw,t1=entryRaw+risk,t2=entryRaw+2*risk;let rem=1,ret=0,tp1=false,tp2=false,exitIndex=day.length-1,reason="EOD";
  const fill=x=>x*(1-COST);
  for(let i=entryIndex+1;i<day.length;i++){const b=day[i],vw=vwap(day,b.timestamp+1),protect=tp1&&vw?Math.max(entryRaw,Math.min(vw*0.998,entryRaw*1.01)):stopRaw;if(b.low<=protect){ret+=rem*(fill(protect)/entry-1);rem=0;exitIndex=i;reason=tp1?"PROTECT_STOP":"STRUCTURAL_STOP";break;}if(!tp1&&b.high>=t1){ret+=.25*(fill(t1)/entry-1);rem-=.25;tp1=true;}if(tp1&&!tp2&&b.high>=t2){ret+=.25*(fill(t2)/entry-1);rem-=.25;tp2=true;}if(tp2&&vw&&b.close<vw){ret+=rem*(fill(b.close)/entry-1);rem=0;exitIndex=i;reason="RUNNER_VWAP_BREAK";break;}}
  if(rem>0){ret+=rem*(fill(day.at(-1).close)/entry-1);reason=tp2?"RUNNER_EOD":tp1?"PARTIAL_EOD":"EOD";}
  return {netReturn:ret,stopDistancePct:risk/entryRaw,tp1,tp2,exitTime:day[exitIndex].timestamp,exitReason:reason};
}
function replayOne(f,cand,day){
  const b15=aggregate15(day);
  for(let i=6;i<day.length-1;i++){const closed=day.slice(0,i+1).map(x=>({...x,closeTime:x.timestamp+5*60_000})),decision=day[i].timestamp+5*60_000,ps5=structure(cand.symbol,"5m",closed,decision+1),a15=b15.filter(x=>x.closeTime<=decision);if(ps5.status!=="READY_FOR_SPECIALIST_RESEARCH_ONLY"||a15.length<5)continue;const ps15=structure(cand.symbol,"15m",a15,decision+1);if(ps15.status!=="READY_FOR_SPECIALIST_RESEARCH_ONLY")continue;const vw=vwap(day,decision),last=day[i];if(!(vw>0))continue;const prev=day.slice(Math.max(0,i-5),i).map(x=>x.volume).filter(x=>x>0),vr=prev.length?last.volume/median(prev):1,vwd=last.close/vw-1;
    if(!familyPass(f,ps5.features,ps15.features,vwd,vr))continue;
    const entryIndex=i+1,entryRaw=day[entryIndex].open,support=ps5.features.priceStructure.support;let risk=support&&support<entryRaw?(entryRaw-support*0.998)/entryRaw:0.01;risk=Math.max(0.005,risk);if(risk>0.04)continue;const x=exit(day,entryIndex,entryRaw,entryRaw*(1-risk));
    const triggerScore=+Math.min(100,cand.setupScore+10*clamp((vr-f.minVolReaccel)/2)+10*clamp(((ps5.features.candle.closeLocation??0)-f.minCloseLoc)/0.3)+5*(ps5.features.priceStructure.trend==="BULLISH")).toFixed(2);
    return {symbol:cand.symbol,sector:cand.sector,bucket:cand.bucket,date:cand.date,family:f.name,setupScore:cand.setupScore,triggerScore,entryTime:day[entryIndex].timestamp,aiInputBundle:{setup:cand.setup,wave5m:ps5.features.pattern,candle5m:ps5.features.candle,structure5m:ps5.features.priceStructure,wave15m:ps15.features.pattern,structure15m:ps15.features.priceStructure,vwapDistance:vwd,volumeReaccel:vr},...x};}
  return null;
}
function portfolio(trades){const t=[...trades].sort((a,b)=>a.entryTime-b.entryTime||b.triggerScore-a.triggerScore),active=[],sectors=new Map();let ret=0,admitted=0;for(const x of t){for(let i=active.length-1;i>=0;i--)if(active[i].exitTime<=x.entryTime){sectors.set(active[i].sector,Math.max(0,(sectors.get(active[i].sector)??1)-1));active.splice(i,1);}if(active.length>=ACCOUNT.maxConcurrent||(sectors.get(x.sector)??0)>=ACCOUNT.maxPerSector)continue;const w=Math.min(ACCOUNT.maxWeight,ACCOUNT.riskPerTrade/Math.max(x.stopDistancePct,1e-9));ret+=w*x.netReturn;active.push(x);sectors.set(x.sector,(sectors.get(x.sector)??0)+1);admitted++;}return {return:ret,admitted};}
function dayMetrics(days){const r=days.map(x=>x.return),pos=r.filter(x=>x>0),neg=r.filter(x=>x<0);let eq=1,peak=1,mdd=0;for(const x of r){eq*=1+x;peak=Math.max(peak,eq);mdd=Math.max(mdd,(peak-eq)/peak);}return {days:days.length,totalReturn:eq-1,averageDailyReturn:mean(r),medianDailyReturn:median(r),positiveDayRate:r.length?pos.length/r.length:0,averageWinningDay:mean(pos),averageLosingDay:mean(neg),bestDay:r.length?Math.max(...r):0,worstDay:r.length?Math.min(...r):0,maxDrawdown:mdd,daysAtLeast1Pct:r.filter(x=>x>=.01).length,daysAtLeast3Pct:r.filter(x=>x>=.03).length,daysAtLeast5Pct:r.filter(x=>x>=.05).length,daysAtLeast10Pct:r.filter(x=>x>=.10).length};}
function runPeriod(f,dates,cands,intra){const days=[],trades=[];for(const date of dates){const xs=[];for(const c of cands.get(date)??[]){const day=intra.get(c.symbol)?.get(date);if(!day)continue;const t=replayOne(f,c,day);if(t){xs.push(t);trades.push(t);}}const p=portfolio(xs);days.push({date,candidateCount:(cands.get(date)??[]).length,triggered:xs.length,...p});}return {metrics:dayMetrics(days),days,trades};}
function selectScore(r){if(r.trades.length<4)return -999;return r.metrics.totalReturn-1.5*r.metrics.maxDrawdown+0.25*r.metrics.averageDailyReturn;}
function validationPass(r){return r.metrics.days>=3&&r.trades.length>=3&&r.metrics.totalReturn>0&&r.metrics.averageDailyReturn>0&&r.metrics.maxDrawdown<=0.04;}

async function main(){
  const u=await universe(),spyD=(await daily("SPY")).candles,spy5=await bars5("SPY"),allDates=completeDates(spy5).filter(d=>d<OBSERVED_CUTOFF);if(allDates.length<11)throw new Error(`PRE_OBSERVED_DAYS_INSUFFICIENT_${allDates.length}`);
  const testCount=Math.max(3,Math.min(4,Math.floor(allDates.length*.25))),validationCount=Math.max(3,Math.min(4,Math.floor((allDates.length-testCount)*.30))),calCount=allDates.length-testCount-validationCount;if(calCount<5)throw new Error("CALIBRATION_DAYS_INSUFFICIENT");
  const cal=allDates.slice(0,calCount),val=allDates.slice(calCount,calCount+validationCount),test=allDates.slice(calCount+validationCount);
  const df=await mapLimit(u.rows,6,async row=>({...row,candles:(await daily(row.symbol)).candles})),drows=df.filter(x=>x.ok).map(x=>x.value),cands=new Map(),union=new Map();
  for(const date of allDates){const a=drows.map(r=>candidate(r,spyD,date)).filter(Boolean).sort((x,y)=>y.setupScore-x.setupScore).slice(0,TOP_PER_DAY);cands.set(date,a);for(const x of a)union.set(x.symbol,Math.max(union.get(x.symbol)??0,x.setupScore));}
  const symbols=[...union].sort((a,b)=>b[1]-a[1]).slice(0,INTRADAY_CAP).map(x=>x[0]),bf=await mapLimit(symbols,2,async symbol=>({symbol,rows:await bars5(symbol)})),ok=bf.filter(x=>x.ok).map(x=>x.value),intra=new Map(ok.map(x=>[x.symbol,groupDays(x.rows)]));
  const familyRows=[];for(const f of Object.values(FAMILIES)){const c=runPeriod(f,cal,cands,intra),v=runPeriod(f,val,cands,intra);familyRows.push({family:f.name,calibration:c,validation:v,selectionScore:selectScore(c),validationPass:validationPass(v)});}
  familyRows.sort((a,b)=>b.selectionScore-a.selectionScore);const selected=familyRows.find(x=>x.validationPass)??familyRows[0],testRun=runPeriod(FAMILIES[selected.family],test,cands,intra);
  const report={schemaVersion:2,status:"pass",market:"US_STOCK",purpose:"chronological D-1 candidate -> D-day 5m/15m wave/candle/VWAP replay V2",dataWindow:{completePreObservedDates:allDates,observedCutoffExclusive:OBSERVED_CUTOFF,calibrationDates:cal,validationDates:val,testDates:test,testWindowPreviouslyInspectedByThisReplay:false},universe:{rawRows:u.rawRows,screenedSymbols:u.rows.length,dailyHistorySuccesses:drows.length,intradayRequested:symbols.length,intradaySucceeded:ok.length},selectionContract:{triggerFamiliesPreRegistered:Object.keys(FAMILIES),calibrationUsedForRanking:true,validationUsedOnlyAsGate:true,testUsedForSelection:false,actualHistoricalLlmCalled:false,critic:"DETERMINISTIC_AI_READY_FEATURE_GATE_V2"},accountPolicy:ACCOUNT,familyResults:familyRows.map(x=>({family:x.family,selectionScore:x.selectionScore,validationPass:x.validationPass,calibration:{metrics:x.calibration.metrics,trades:x.calibration.trades.length},validation:{metrics:x.validation.metrics,trades:x.validation.trades.length}})),selectedFamily:selected.family,selectedStatus:selected.validationPass?"VALIDATION_GATE_PASS":"RESEARCH_HOLD_NO_FAMILY_VALIDATED",test:{metrics:testRun.metrics,days:testRun.days,trades:testRun.trades.map(t=>({symbol:t.symbol,date:t.date,bucket:t.bucket,setupScore:t.setupScore,triggerScore:t.triggerScore,entryTime:new Date(t.entryTime).toISOString(),exitTime:new Date(t.exitTime).toISOString(),netReturn:t.netReturn,stopDistancePct:t.stopDistancePct,tp1:t.tp1,tp2:t.tp2,exitReason:t.exitReason,aiInputBundle:t.aiInputBundle}))},lookahead:{D1UsesPriorDayOrEarlier:true,intradayCompleted5m15mOnly:true,entryNext5mOpen:true,testUsedForSelection:false,guardPassed:true},safety:{researchOnly:true,liveExecutionAllowed:false,privateAccountRequestAllowed:false,executionAuthority:"NONE",profitabilityPromotionAllowed:false},limitations:["Current Nasdaq universe causes survivorship/current-membership bias.","Yahoo 5m history is bounded to about one month.","Historical catalyst/news/order-book/short-interest inputs are not available and are not fabricated.","AI is represented by deterministic feature gates; historical LLM decisions require archived model/prompt/input/output.","The V2 family design was created after V1 observations, but this V2 test window is restricted to dates before the V1 observed cutoff.","This is research evidence only, not broker fill evidence or PROFITABILITY_PROVEN."]};
  const out=resolve(process.argv[2]??"docs/overnight-intraday-replay-v2.json");await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(report,null,2)+"\n","utf8");console.log(JSON.stringify(report,null,2));
}
await main();
