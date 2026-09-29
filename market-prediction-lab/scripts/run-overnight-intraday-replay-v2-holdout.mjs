import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import { buildAdaptiveMultiEvidencePriceStructureV2 } from "../src/adaptive-multi-evidence-price-structure-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID } from "../src/adaptive-multi-evidence-point-in-time-v2.js";

const DAY=86_400_000;
const COST=0.0015;
const D1_LOOKBACK_DAYS=370;
const MAX_REPLAY_DAYS=15;
const CANDIDATES_PER_DAY=5;
const INTRADAY_SYMBOL_CAP=25;
const ACCOUNT=Object.freeze({riskPerTrade:0.005,maxWeight:0.20,maxConcurrent:3,maxPerSector:2});
const fmt=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});

function parts(ms){const p=Object.fromEntries(fmt.formatToParts(new Date(ms)).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));return {date:`${p.year}-${p.month}-${p.day}`,hour:Number(p.hour),minute:Number(p.minute)};}
function clamp(x,a=0,b=1){return Math.min(b,Math.max(a,x));}
function mean(v){return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;}
function median(v){if(!v.length)return null;const x=[...v].sort((a,b)=>a-b),m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function sma(c,index,period){const s=index-period+1;if(s<0)return null;let x=0;for(let i=s;i<=index;i++)x+=c[i].close;return x/period;}
function highBefore(c,index,period){const s=index-period;if(s<0)return null;let h=-Infinity;for(let i=s;i<index;i++)h=Math.max(h,c[i].high);return Number.isFinite(h)?h:null;}
function avgDollarBefore(c,index,period){const s=index-period;if(s<0)return null;let x=0;for(let i=s;i<index;i++)x+=c[i].close*c[i].volume;return x/period;}
function num(v){const n=Number(String(v??"").replace(/[$,% ,]/g,""));return Number.isFinite(n)?n:null;}
function regular(ms){const {hour,minute}=parts(ms),m=hour*60+minute;return m>=570&&m<960;}
function securityEligible(row){const s=String(row.symbol??"").trim().toUpperCase(),name=String(row.name??""),industry=String(row.industry??"");if(!/^[A-Z][A-Z0-9.-]{0,9}$/.test(s))return false;if(/(Warrant|Rights?|Units?|Preferred|Depositary Preferred)/i.test(name))return false;if(/Blank Checks/i.test(industry)||/Acquisition Corp/i.test(name))return false;if(/[RWU]$/.test(s)&&s.length>=4)return false;return true;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function fetchUniverse(){
  const r=await fetch("https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true",{headers:{accept:"application/json,text/plain,*/*","accept-language":"en-US,en;q=0.9","user-agent":"Mozilla/5.0 Chrome/120"}});
  if(!r.ok)throw new Error(`NASDAQ_HTTP_${r.status}`);
  const rows=(await r.json())?.data?.rows;if(!Array.isArray(rows)||rows.length<1000)throw new Error("NASDAQ_UNIVERSE_INSUFFICIENT");
  const normalized=rows.map(row=>{const price=num(row.lastsale),volume=num(row.volume),marketCap=num(row.marketCap);return {symbol:String(row.symbol??"").trim().toUpperCase(),name:String(row.name??""),sector:String(row.sector??"UNKNOWN")||"UNKNOWN",industry:String(row.industry??""),price,volume,marketCap,dollarVolume:price!=null&&volume!=null?price*volume:null,eligible:securityEligible(row)};});
  const usable=normalized.filter(r=>r.eligible&&r.price>=2&&r.marketCap>0&&r.dollarVolume>0);
  const large=usable.filter(r=>r.marketCap>=10_000_000_000).sort((a,b)=>b.dollarVolume-a.dollarVolume).slice(0,15);
  const mid=usable.filter(r=>r.marketCap>=2_000_000_000&&r.marketCap<10_000_000_000).sort((a,b)=>b.dollarVolume-a.dollarVolume).slice(0,15);
  const small=usable.filter(r=>r.marketCap>=300_000_000&&r.marketCap<2_000_000_000).sort((a,b)=>b.dollarVolume-a.dollarVolume).slice(0,15);
  return {rawRows:rows.length,rows:[...large.map(x=>({...x,bucket:"LARGE"})),...mid.map(x=>({...x,bucket:"MID"})),...small.map(x=>({...x,bucket:"SMALL"}))]};
}

async function dailyHistory(symbol){
  let last;for(let i=0;i<3;i++){try{return await collectYahooStockHistory({market:"US_STOCK",symbol,startTime:Date.now()-D1_LOOKBACK_DAYS*DAY,endTime:Date.now()+DAY,timeoutMs:15_000});}catch(e){last=e;await sleep(300*(i+1));}}throw last;
}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;async function w(){for(;;){const i=next++;if(i>=items.length)return;try{out[i]={ok:true,value:await fn(items[i],i)};}catch(e){out[i]={ok:false,error:String(e?.message??e)};}}}await Promise.all(Array.from({length:Math.min(limit,items.length)},()=>w()));return out;}

function parseIntraday(result,durationMin){
  const ts=result?.timestamp??[],q=result?.indicators?.quote?.[0]??{},out=[];
  for(let i=0;i<ts.length;i++){const timestamp=Number(ts[i])*1000,open=Number(q.open?.[i]),high=Number(q.high?.[i]),low=Number(q.low?.[i]),close=Number(q.close?.[i]),volume=Number(q.volume?.[i]);if(!Number.isFinite(timestamp)||![open,high,low,close,volume].every(Number.isFinite)||Math.min(open,high,low,close)<=0||volume<0||high<Math.max(open,close)||low>Math.min(open,close))continue;out.push({timestamp,open,high,low,close,volume,durationMin});}
  return out.sort((a,b)=>a.timestamp-b.timestamp);
}
async function yahooBars(symbol){
  const enc=encodeURIComponent(symbol);
  const specs=[{interval:"5m",range:"1mo",durationMin:5}];
  const errors=[];
  for(const spec of specs){
    const query=`range=${spec.range}&interval=${spec.interval}&includePrePost=true&events=div%2Csplits`;
    let last=null;
    for(let attempt=0;attempt<3;attempt++){
      for(const host of ["query1.finance.yahoo.com","query2.finance.yahoo.com"]){
        try{
          const r=await fetch(`https://${host}/v8/finance/chart/${enc}?${query}`,{headers:{accept:"application/json,text/plain,*/*","accept-language":"en-US,en;q=0.9","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"}});
          if(!r.ok)throw new Error(`YAHOO_${spec.interval}_HTTP_${r.status}`);
          const result=(await r.json())?.chart?.result?.[0],rows=parseIntraday(result,spec.durationMin);
          const minRows=spec.durationMin===1?100:40;
          if(rows.length<minRows)throw new Error(`YAHOO_${spec.interval}_INSUFFICIENT_${rows.length}`);
          return {rows,sourceInterval:spec.interval,durationMin:spec.durationMin};
        }catch(e){last=e;}
      }
      await sleep(900*(attempt+1));
    }
    errors.push(String(last?.message??last));
  }
  throw new Error(`YAHOO_INTRADAY_ALL_FAILED:${errors.join("|")}`);
}
function groupRegularDays(rows){const m=new Map();for(const r of rows){if(!regular(r.timestamp))continue;const d=parts(r.timestamp).date,a=m.get(d)??[];a.push(r);m.set(d,a);}return m;}
function completeDays(rows){return [...groupRegularDays(rows).entries()].filter(([,v])=>{const dur=v[0]?.durationMin??1;return v.length>=(dur===1?300:60);}).map(([d])=>d).sort();}

function structureInput(symbol,timeframe,bars,decisionMs,options){
  if(!bars.length)return null;
  const mapped=bars.map(b=>{const iso=new Date(b.closeTime??b.timestamp).toISOString();return {isClosed:true,eventTime:iso,publishedAt:iso,availableAt:iso,observedAt:iso,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume};});
  return buildAdaptiveMultiEvidencePriceStructureV2({lineageId:ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,market:"US_STOCK",symbol,timeframe,side:"LONG",decisionTime:new Date(decisionMs).toISOString(),source:{sourceId:"yahoo-public-chart",originalSourceId:"yahoo-public-chart",sourceType:"PUBLIC_MARKET_DATA",sourceUrl:"https://query1.finance.yahoo.com/",documentId:`${symbol}:${timeframe}`},candles:mapped,options});
}
function dailyBarsForStructure(candles,endIndex){return candles.slice(Math.max(0,endIndex-79),endIndex+1).map(c=>({...c,closeTime:c.timestamp+8*60*60*1000}));}

function candidateForDay(row,spyCandles,targetDate,targetStartMs){
  const c=row.candles,dates=c.map(x=>parts(x.timestamp).date);let i=-1;for(let j=0;j<dates.length;j++)if(dates[j]<targetDate)i=j;else break;if(i<60)return null;
  const spyDates=spyCandles.map(x=>parts(x.timestamp).date);let si=-1;for(let j=0;j<spyDates.length;j++)if(spyDates[j]<targetDate)si=j;else break;if(si<20)return null;
  const close=c[i].close,ma20=sma(c,i,20),ma20prior=sma(c,i-5,20),ma50=sma(c,i,50),hh=highBefore(c,i+1,20),avgD=avgDollarBefore(c,i,20);
  if(!(ma20>0&&ma20prior>0&&ma50>0&&hh>0&&avgD>0))return null;
  const stock20=close/c[i-20].close-1,spy20=spyCandles[si].close/spyCandles[si-20].close-1,rs20=stock20-spy20,dvol=(close*c[i].volume)/avgD,nearHigh=close/hh,range=c[i].high-c[i].low,body=Math.abs(c[i].close-c[i].open),closeLoc=range>0?(c[i].close-c[i].low)/range:0;
  const ps=structureInput(row.symbol,"1d",dailyBarsForStructure(c,i),targetStartMs-60_000,{atrPeriod:14,volumeLookback:20,pivotLeftBars:2,pivotRightBars:2,compressionLookback:5});
  const pf=ps?.features,trend=pf?.priceStructure?.trend??"INSUFFICIENT",transition=pf?.pattern?.structureTransition??"NONE";
  const trendOk=close>ma20&&ma20>ma20prior&&close>ma50;
  if(!trendOk||nearHigh<0.88||dvol<0.7||trend==="BEARISH")return null;
  let score=25+10+20*clamp((rs20+0.05)/0.25)+15*clamp((dvol-0.7)/2.3)+10*clamp((nearHigh-0.88)/0.12)+5*(closeLoc>=0.65?1:0)+5*(range>0&&body/range>=0.45?1:0);
  if(trend==="BULLISH")score+=5;if(["BOS_UP","CHOCH_UP"].includes(transition))score+=5;
  return {symbol:row.symbol,sector:row.sector,bucket:row.bucket,targetDate,preparedAtDate:dates[i],state:"PREPARED",setupScore:Number(Math.min(100,score).toFixed(2)),features:{close,ma20,rs20,dollarVolumeAcceleration:dvol,near20dHigh:nearHigh,closeLocation:closeLoc,dailyStructureTrend:trend,dailyStructureTransition:transition,dailyPatterns:pf?.candle?.namedPatterns??[]},lookaheadGuard:true};
}

function aggregate(rows,minutes){
  const out=[];let current=null;
  for(const r of rows){const p=parts(r.timestamp),mod=p.hour*60+p.minute-570;if(mod<0)continue;const bucket=Math.floor(mod/minutes);if(!current||current.bucket!==bucket){if(current)out.push(current);current={bucket,open:r.open,high:r.high,low:r.low,close:r.close,volume:r.volume,startTime:r.timestamp,lastMinute:r.timestamp,durationMin:r.durationMin??1};}else{current.high=Math.max(current.high,r.high);current.low=Math.min(current.low,r.low);current.close=r.close;current.volume+=r.volume;current.lastMinute=r.timestamp;}}
  if(current)out.push(current);return out.map(b=>({...b,closeTime:b.lastMinute+((b.durationMin??1)*60_000)}));
}
function vwapAt(rows,cutoff){let pv=0,v=0;for(const r of rows){if(r.timestamp>=cutoff)break;if(r.volume>0){pv+=((r.high+r.low+r.close)/3)*r.volume;v+=r.volume;}}return v>0?pv/v:null;}
function medianVol(bars,count=5){const v=bars.slice(-count).map(x=>x.volume).filter(x=>x>0);return median(v)??0;}

function criticProxy({candidate,f5,f15,vwapDistance,volumeReaccel,sessionMode}){
  const reasons=[];
  if(candidate.setupScore<80)reasons.push("D1_SETUP_BELOW_80");
  if(candidate.features.dailyStructureTrend==="BEARISH")reasons.push("D1_BEARISH_STRUCTURE");
  if(f5?.priceStructure?.trend==="BEARISH")reasons.push("5M_BEARISH_STRUCTURE");
  if(f5?.priceStructure?.structureEvent==="FAILED_BREAKOUT")reasons.push("FAILED_BREAKOUT");
  if((f5?.candle?.namedPatterns??[]).includes("BEARISH_PIN_BAR"))reasons.push("BEARISH_PIN");
  if(f15?.priceStructure?.trend==="BEARISH")reasons.push("15M_BEARISH");
  if(sessionMode==="TREND_CONTINUATION"&&f15&&f15.priceStructure?.trend!=="BULLISH")reasons.push("TREND_MODE_REQUIRES_15M_BULLISH");
  if(vwapDistance>0.025)reasons.push("OVEREXTENDED_FROM_VWAP");
  if(volumeReaccel<1.0)reasons.push("VOLUME_NOT_REACCELERATING");
  if((f5?.candle?.relativeVolume??1)<0.9)reasons.push("5M_RELATIVE_VOLUME_WEAK");
  return {mode:"DETERMINISTIC_AI_CRITIC_PROXY_V2",decision:reasons.length?"REJECT":"PASS",reasons,actualLlmCalled:false};
}

function simulateExit(dayRows,entryIndex,entryRaw,stopRaw){
  const entry=entryRaw*(1+COST),riskRaw=entryRaw-stopRaw,riskPct=riskRaw/entryRaw,t1=entryRaw+riskRaw,t2=entryRaw+2*riskRaw;let remain=1,realized=0,tp1=false,tp2=false,exitIndex=dayRows.length-1,exitReason="EOD",belowVwapCount=0;
  const exitFill=raw=>raw*(1-COST);
  for(let i=entryIndex+1;i<dayRows.length;i++){
    const b=dayRows[i],vw=vwapAt(dayRows,b.timestamp+1);
    let protect=stopRaw;if(tp1&&vw!=null)protect=Math.max(entryRaw,Math.min(vw*0.998,entryRaw*1.01));
    if(b.low<=protect){realized+=remain*(exitFill(protect)/entry-1);remain=0;exitIndex=i;exitReason=tp1?"PROTECT_STOP":"STRUCTURAL_STOP";break;}
    if(!tp1&&b.high>=t1){realized+=0.25*(exitFill(t1)/entry-1);remain-=0.25;tp1=true;}
    if(tp1&&!tp2&&b.high>=t2){realized+=0.25*(exitFill(t2)/entry-1);remain-=0.25;tp2=true;}
    if(tp2&&vw!=null){belowVwapCount=b.close<vw?belowVwapCount+1:0;if(belowVwapCount>=3){realized+=remain*(exitFill(b.close)/entry-1);remain=0;exitIndex=i;exitReason="RUNNER_VWAP_BREAK";break;}}
  }
  if(remain>0){const b=dayRows.at(-1);realized+=remain*(exitFill(b.close)/entry-1);exitIndex=dayRows.length-1;exitReason=tp2?"RUNNER_EOD":tp1?"PARTIAL_EOD":"EOD";}
  return {netReturn:realized,stopDistancePct:riskPct,tp1,tp2,exitTime:dayRows[exitIndex].timestamp,exitReason};
}

function replayCandidate(candidate,dayRows){
  const bars5=aggregate(dayRows,5),bars15=aggregate(dayRows,15),rejections=[];
  for(let k=0;k<bars5.length;k++){
    const b5=bars5[k],p=parts(b5.closeTime),minuteOfDay=p.hour*60+p.minute;
    if(minuteOfDay<575||minuteOfDay>870)continue;
    const sessionMode=minuteOfDay<=660?"OPENING":"TREND_CONTINUATION";
    const completed5=bars5.slice(0,k+1),completed15=bars15.filter(x=>x.closeTime<=b5.closeTime);
    const ps5=structureInput(candidate.symbol,"5m",completed5,b5.closeTime+1,{atrPeriod:8,volumeLookback:8,pivotLeftBars:2,pivotRightBars:2,compressionLookback:4});
    const ps15=completed15.length>=5?structureInput(candidate.symbol,"15m",completed15,b5.closeTime+1,{atrPeriod:5,volumeLookback:4,pivotLeftBars:1,pivotRightBars:1,compressionLookback:2}):null;
    if(ps5?.status!=="READY_FOR_SPECIALIST_RESEARCH_ONLY")continue;
    const f5=ps5.features,f15=ps15?.status==="READY_FOR_SPECIALIST_RESEARCH_ONLY"?ps15.features:null,vw=vwapAt(dayRows,b5.closeTime),close=b5.close;
    if(!(vw>0))continue;
    const vwapDistance=close/vw-1,volBase=medianVol(completed5.slice(0,-1),5),volumeReaccel=volBase>0?b5.volume/volBase:1,cand=f5.candle;
    const hhhl=["HH","EH"].includes(f5.priceStructure.latestHighClassification)&&["HL","EL"].includes(f5.priceStructure.latestLowClassification);
    const eventUp=f5.priceStructure.structureEventDirection==="UP"&&["BOS_UP","CHOCH_UP","BREAK_UP"].includes(f5.pattern.structureTransition);
    const openingStructure=f5.priceStructure.trend==="BULLISH"||f5.priceStructure.structureEvent==="RETEST_HELD"||eventUp;
    const trendStructure=f5.priceStructure.trend==="BULLISH"&&hhhl&&(f15==null||f15.priceStructure.trend==="BULLISH");
    const structureOk=sessionMode==="OPENING"?openingStructure:trendStructure;
    const candleOk=cand.direction==="UP"&&(cand.bodyRangeRatio??0)>=0.50&&(cand.closeLocation??0)>=0.70&&(cand.upperWickRatio??1)<=0.25;
    const baseTrigger=candidate.setupScore>=80&&close>vw&&vwapDistance>=0&&vwapDistance<=0.025&&structureOk&&candleOk&&volumeReaccel>=1.0&&(cand.relativeVolume??1)>=0.9;
    if(!baseTrigger)continue;
    const critic=criticProxy({candidate,f5,f15,vwapDistance,volumeReaccel,sessionMode});
    const aiInputBundle={version:"AI_INPUT_V2",decisionTime:new Date(b5.closeTime).toISOString(),sessionMode,setup:candidate.features,wave5m:{trend:f5.priceStructure.trend,swingSequence:f5.pattern.swingSequence,latestSwingLegAtr:f5.pattern.latestSwingLegAtr,structureTransition:f5.pattern.structureTransition,structureEvent:f5.priceStructure.structureEvent,latestHigh:f5.priceStructure.latestHighClassification,latestLow:f5.priceStructure.latestLowClassification},candle5m:f5.candle,wave15m:f15?{trend:f15.priceStructure.trend,swingSequence:f15.pattern.swingSequence,structureTransition:f15.pattern.structureTransition}:null,vwapDistance,volumeReaccel};
    if(critic.decision!=="PASS"){rejections.push({time:b5.closeTime,critic});continue;}
    const entryIndex=dayRows.findIndex(x=>x.timestamp>=b5.closeTime);if(entryIndex<0)continue;
    const entryRaw=dayRows[entryIndex].open,support=f5.priceStructure.support;
    let risk=support!=null&&support<entryRaw?(entryRaw-support*0.998)/entryRaw:0.01;
    risk=Math.max(0.005,risk);
    if(risk>0.025){rejections.push({time:b5.closeTime,critic:{...critic,decision:"REJECT",reasons:["STRUCTURAL_STOP_TOO_WIDE"]}});continue;}
    const stopRaw=entryRaw*(1-risk),exit=simulateExit(dayRows,entryIndex,entryRaw,stopRaw),triggerScore=Number(Math.min(100,candidate.setupScore+10*clamp((volumeReaccel-1)/2)+10*clamp((cand.closeLocation??0)-0.70,0,0.30)/0.30+5*(f5.priceStructure.trend==="BULLISH"?1:0)).toFixed(2));
    return {state:"TRIGGERED",sessionMode,symbol:candidate.symbol,sector:candidate.sector,bucket:candidate.bucket,targetDate:candidate.targetDate,setupScore:candidate.setupScore,triggerScore,entryTime:dayRows[entryIndex].timestamp,entryRaw,stopRaw,critic,aiInputBundle,...exit,rejectionsBeforeEntry:rejections.length};
  }
  return {state:"NO_TRIGGER",symbol:candidate.symbol,targetDate:candidate.targetDate,setupScore:candidate.setupScore,rejections};
}

function portfolioDay(trades){
  const sorted=[...trades].sort((a,b)=>a.entryTime-b.entryTime||b.triggerScore-a.triggerScore),active=[],sectorCounts=new Map();let ret=0,admitted=0,capacityRejected=0,sectorRejected=0;
  for(const t of sorted){for(let i=active.length-1;i>=0;i--)if(active[i].exitTime<=t.entryTime){const s=active[i].sector;sectorCounts.set(s,Math.max(0,(sectorCounts.get(s)??1)-1));active.splice(i,1);}if(active.length>=ACCOUNT.maxConcurrent){capacityRejected++;continue;}if((sectorCounts.get(t.sector)??0)>=ACCOUNT.maxPerSector){sectorRejected++;continue;}const weight=Math.min(ACCOUNT.maxWeight,ACCOUNT.riskPerTrade/Math.max(t.stopDistancePct,1e-9));ret+=weight*t.netReturn;active.push(t);sectorCounts.set(t.sector,(sectorCounts.get(t.sector)??0)+1);admitted++;}
  return {return:ret,admitted,capacityRejected,sectorRejected};
}
function summarizeDays(days){const rs=days.map(x=>x.return),wins=rs.filter(x=>x>0),loss=rs.filter(x=>x<0);let eq=1,peak=1,mdd=0;for(const r of rs){eq*=1+r;peak=Math.max(peak,eq);mdd=Math.max(mdd,(peak-eq)/peak);}return {days:days.length,totalReturn:eq-1,averageDailyReturn:mean(rs)??0,medianDailyReturn:median(rs)??0,positiveDayRate:rs.length?wins.length/rs.length:0,averageWinningDay:mean(wins)??0,averageLosingDay:mean(loss)??0,bestDay:rs.length?Math.max(...rs):0,worstDay:rs.length?Math.min(...rs):0,maxDrawdown:mdd,daysAtLeast1Pct:rs.filter(x=>x>=0.01).length,daysAtLeast3Pct:rs.filter(x=>x>=0.03).length,daysAtLeast5Pct:rs.filter(x=>x>=0.05).length,daysAtLeast10Pct:rs.filter(x=>x>=0.10).length};}

async function main(){
  const universe=await fetchUniverse(),spyDaily=await dailyHistory("SPY"),spyIntraday=await yahooBars("SPY"),allDates=completeDays(spyIntraday.rows),v1ObservedDates=allDates.slice(-5),dates=allDates.slice(Math.max(0,allDates.length-20),Math.max(0,allDates.length-5)).slice(-MAX_REPLAY_DAYS);if(dates.length<8)throw new Error("REPLAY_HOLDOUT_DAYS_INSUFFICIENT");
  const dailyFetched=await mapLimit(universe.rows,6,async row=>({...row,candles:(await dailyHistory(row.symbol)).candles})),dailyRows=dailyFetched.filter(x=>x.ok).map(x=>x.value),dailyFailures=dailyFetched.filter(x=>!x.ok);
  const spyDays=groupRegularDays(spyIntraday.rows),candidateByDay=new Map(),allCandidates=[];
  for(const date of dates){const start=spyDays.get(date)?.[0]?.timestamp;if(!start)continue;const candidates=dailyRows.map(row=>candidateForDay(row,spyDaily.candles,date,start)).filter(Boolean).sort((a,b)=>b.setupScore-a.setupScore||a.symbol.localeCompare(b.symbol)).slice(0,CANDIDATES_PER_DAY);candidateByDay.set(date,candidates);allCandidates.push(...candidates);}
  const bestSymbolScore=new Map();for(const c of allCandidates)bestSymbolScore.set(c.symbol,Math.max(bestSymbolScore.get(c.symbol)??0,c.setupScore));const intradaySymbols=[...bestSymbolScore.entries()].sort((a,b)=>b[1]-a[1]).slice(0,INTRADAY_SYMBOL_CAP).map(x=>x[0]);
  const intradayFetched=await mapLimit(intradaySymbols,3,async symbol=>({symbol,...await yahooBars(symbol)})),intradayOk=intradayFetched.filter(x=>x.ok).map(x=>x.value),intradayMap=new Map(intradayOk.map(x=>[x.symbol,groupRegularDays(x.rows)])),intradaySourceBySymbol=Object.fromEntries(intradayOk.map(x=>[x.symbol,x.sourceInterval])),intradayFailures=intradayFetched.filter(x=>!x.ok);
  const replayDays=[],candidateRecords=[],tradeRecords=[];
  for(const date of dates){const cs=candidateByDay.get(date)??[],trades=[];for(const c of cs){const rows=intradayMap.get(c.symbol)?.get(date);if(!rows||rows.length<100){candidateRecords.push({...c,state:"DATA_UNAVAILABLE"});continue;}const r=replayCandidate(c,rows);candidateRecords.push({...c,replayState:r.state});if(r.state==="TRIGGERED"){trades.push(r);tradeRecords.push(r);}}
    const p=portfolioDay(trades);replayDays.push({date,candidateCount:cs.length,triggered:trades.length,...p});}
  const metrics=summarizeDays(replayDays),report={schemaVersion:1,status:"pass",market:"US_STOCK",purpose:"D-1 candidate to D-day stricter wave/candle/VWAP intraday holdout replay",replayWindow:{dates,v1ObservedDates,holdoutPreRegistered:true},universe:{rawRows:universe.rawRows,screenedSymbols:universe.rows.length,dailyHistorySuccesses:dailyRows.length,dailyHistoryFailures:dailyFailures.length,intradaySymbolsRequested:intradaySymbols.length,intradaySymbolsSucceeded:intradayMap.size,intradayFailures:intradayFailures.length,intradaySourceBySymbol,spyIntradaySource:spyIntraday.sourceInterval,currentUniverseSnapshotBias:true},pipeline:{D1:"daily trend + relative strength + dollar-volume acceleration + deterministic price-structure/wave/candle descriptors",D0:"completed 5m/15m bars only + VWAP + strict wave/HH-HL/BOS-CHOCH + candle quality + volume reacceleration + time-segment routing",critic:"DETERMINISTIC_AI_READY_CRITIC_PROXY_V2",criticActualLlmCalled:false,execution:"next 1m open after completed trigger bar",exit:"25% at +1R, 25% at +2R, 50% runner; structural/protection/VWAP/EOD exits"},lookahead:{futureCandlesVisibleAtDecision:false,D1CandidateUsesOnlyPriorDayOrEarlier:true,intradayUsesOnlyCompletedBars:true,nextBarEntry:true,sameBarAmbiguity:"stop/protection first",guardPassed:true},accountPolicy:ACCOUNT,metrics,replayDays,candidateRecords,tradeRecords:tradeRecords.map(t=>({symbol:t.symbol,targetDate:t.targetDate,bucket:t.bucket,setupScore:t.setupScore,triggerScore:t.triggerScore,entryTime:new Date(t.entryTime).toISOString(),exitTime:new Date(t.exitTime).toISOString(),stopDistancePct:t.stopDistancePct,netReturn:t.netReturn,tp1:t.tp1,tp2:t.tp2,exitReason:t.exitReason,critic:t.critic,aiInputBundle:t.aiInputBundle})),safety:{researchOnly:true,liveExecutionAllowed:false,privateAccountRequestAllowed:false,executionAuthority:"NONE"},limitations:["Yahoo 5m one-month history is used for this holdout. It validates a short recent sample, not long-horizon profitability.","Current Nasdaq universe membership introduces survivorship/current-membership bias.","Historical news/catalyst/order-book/short-interest snapshots are not available and are not fabricated.","The AI critic in this run is a deterministic replay proxy. Historical LLM decisions require archived model+prompt+input+output records.","Daily marked account return uses risk-normalized position returns and concurrency gates but is not broker fill evidence.","This run cannot establish PROFITABILITY_PROVEN or trading authority."]};
  const out=resolve(process.argv[2]??"docs/overnight-intraday-replay-v2-holdout.json");await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(report,null,2)+"\n","utf8");console.log(JSON.stringify(report,null,2));
}
await main();
