import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";

const DAY=86_400_000;
const DATA_START=Date.parse("2025-01-01T00:00:00.000Z");
const TEST_START=Date.parse("2026-03-29T00:00:00.000Z");
const TEST_END=Date.parse("2026-09-29T00:00:00.000Z");
const NORMAL_COST=0.0015;
const STRESS_COST=NORMAL_COST*1.5;
const PORTFOLIO=Object.freeze({maxPositions:5,maxPerSector:2,riskBudgetPerTrade:0.005,maxWeightPerPosition:0.20});
const LARGE=Object.freeze({minCap:10_000_000_000,minDollarVolume:10_000_000,skip:80,limit:80});
const SMALL=Object.freeze({minCap:300_000_000,maxCap:2_000_000_000,minDollarVolume:2_000_000,skip:120,limit:120});
const LARGE_PARAMS=Object.freeze({trendMaPeriod:200,slopeLookback:5,pullbackLookback:5,minPullbackAtr:0.5,maxPullbackAtr:2.5,atrStopMultiplier:2.5,rewardRisk:2,maxHoldBars:10,minRelativeVolume:1,maxGapPercent:4});
const SMALL_PARAMS=Object.freeze({breakoutLookback:20,maPeriod:20,atrPeriod:14,atrStopMultiplier:2.5,rewardRisk:2,maxHoldBars:10,relativeVolumePeriod:20,minRelativeVolume:2,maxGapPercent:10,rsLookback:20,minExcessReturn:0.20,minDollarVolumeAcceleration:3});

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
function num(v){const n=Number(String(v??"").replace(/[$,% ,]/g,""));return Number.isFinite(n)?n:null;}
function mean(v){return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;}
function sma(c,index,period){const s=index-period+1;if(s<0)return null;let x=0;for(let i=s;i<=index;i++)x+=c[i].close;return x/period;}
function avgVol(c,index,period){const s=index-period;if(s<0)return null;let x=0;for(let i=s;i<index;i++)x+=c[i].volume;return x/period;}
function avgDollar(c,index,period){const s=index-period;if(s<0)return null;let x=0;for(let i=s;i<index;i++)x+=c[i].close*c[i].volume;return x/period;}
function highBefore(c,index,period){const s=index-period;if(s<0)return null;let h=-Infinity;for(let i=s;i<index;i++)h=Math.max(h,c[i].high);return Number.isFinite(h)?h:null;}
function tr(c,p){return Math.max(c.high-c.low,Math.abs(c.high-p),Math.abs(c.low-p));}
function atr(c,index,period=14){if(index<period)return null;let x=0;for(let i=index-period+1;i<=index;i++){if(i<=0)return null;x+=tr(c[i],c[i-1].close);}return x/period;}
function securityEligible(row){
  const symbol=String(row.symbol??"").trim().toUpperCase(),name=String(row.name??""),industry=String(row.industry??"");
  if(!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol))return false;
  if(/(Warrant|Rights?|Units?|Preferred|Depositary Preferred)/i.test(name))return false;
  if(/Blank Checks/i.test(industry)||/Acquisition Corp/i.test(name))return false;
  if(/[RWU]$/.test(symbol)&&symbol.length>=4)return false;
  return true;
}
async function fetchUniverse(){
  const url="https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true";
  const r=await fetch(url,{headers:{accept:"application/json,text/plain,*/*","accept-language":"en-US,en;q=0.9","user-agent":"Mozilla/5.0 Chrome/120"}});
  if(!r.ok)throw new Error(`NASDAQ_HTTP_${r.status}`);
  const rows=(await r.json())?.data?.rows;
  if(!Array.isArray(rows)||rows.length<1000)throw new Error("NASDAQ_UNIVERSE_INSUFFICIENT");
  return rows.map(row=>{
    const price=num(row.lastsale),volume=num(row.volume),marketCap=num(row.marketCap);
    return {symbol:String(row.symbol??"").trim().toUpperCase(),name:String(row.name??""),sector:String(row.sector??"UNKNOWN")||"UNKNOWN",industry:String(row.industry??""),price,volume,marketCap,dollarVolume:price!=null&&volume!=null?price*volume:null,securityEligible:securityEligible(row)};
  });
}
function selectHoldouts(rows){
  const eligible=rows.filter(r=>r.securityEligible&&r.price>=2&&r.marketCap>0&&r.dollarVolume>=0);
  const large=eligible.filter(r=>r.marketCap>=LARGE.minCap&&r.dollarVolume>=LARGE.minDollarVolume)
    .sort((a,b)=>b.dollarVolume-a.dollarVolume||b.marketCap-a.marketCap||a.symbol.localeCompare(b.symbol))
    .slice(LARGE.skip,LARGE.skip+LARGE.limit);
  const small=eligible.filter(r=>r.marketCap>=SMALL.minCap&&r.marketCap<SMALL.maxCap&&r.dollarVolume>=SMALL.minDollarVolume)
    .sort((a,b)=>b.dollarVolume-a.dollarVolume||b.marketCap-a.marketCap||a.symbol.localeCompare(b.symbol))
    .slice(SMALL.skip,SMALL.skip+SMALL.limit);
  return {large,small,diagnostics:{rawRows:rows.length,eligibleRows:eligible.length,largeHoldoutCount:large.length,smallHoldoutCount:small.length}};
}
async function hist(symbol){
  let last;
  for(let i=0;i<3;i++){try{return await collectYahooStockHistory({market:"US_STOCK",symbol,startTime:DATA_START,endTime:TEST_END,timeoutMs:15_000});}
    catch(e){last=e;await sleep(350*(i+1));}}
  throw last;
}
async function mapLimit(items,limit,fn){
  const out=new Array(items.length);let next=0;
  async function w(){for(;;){const i=next++;if(i>=items.length)return;try{out[i]={ok:true,value:await fn(items[i])};}catch(e){out[i]={ok:false,error:String(e?.message??e)};}}}
  await Promise.all(Array.from({length:Math.min(limit,items.length)},()=>w()));return out;
}
function benchmarkMap(candles){return new Map(candles.map((c,i)=>[c.timestamp,{close:c.close,index:i}]));}
function rsExcess(c,index,bm,lookback){
  if(index<lookback)return null;
  const now=bm.get(c[index].timestamp),past=bm.get(c[index-lookback].timestamp);
  if(!now||!past)return null;
  return (c[index].close/c[index-lookback].close-1)-(now.close/past.close-1);
}
function testBounds(c){const s=c.findIndex(x=>x.timestamp>=TEST_START);let e=c.length-1;while(e>=0&&c[e].timestamp>=TEST_END)e--;return s>=0&&e>s?{s,e}:null;}
function completeTrade({row,c,signalIndex,entryIndex,signalAtr,stopMult,rr,maxHold,gapMax,cost,features}){
  const entry=c[entryIndex]; const signal=c[signalIndex];
  const gap=Math.abs(entry.open/signal.close-1)*100;if(gap>gapMax)return null;
  const stopDistance=signalAtr*stopMult,stop=entry.open-stopDistance,target=entry.open+stopDistance*rr;
  if(!(stop>0&&target>entry.open))return null;
  const last=Math.min(c.length-1,entryIndex+maxHold-1);
  let exitIndex=last,rawExit=c[last].close,exitReason="time";
  for(let i=entryIndex;i<=last;i++){
    const x=c[i],sh=x.low<=stop,th=x.high>=target;
    if(sh&&th){exitIndex=i;rawExit=stop;exitReason="stop_same_bar_conservative";break;}
    if(sh){exitIndex=i;rawExit=stop;exitReason="stop";break;}
    if(th){exitIndex=i;rawExit=target;exitReason="target";break;}
  }
  const entryPrice=entry.open*(1+cost),exitPrice=rawExit*(1-cost);
  return {bucket:row.bucket,symbol:row.symbol,sector:row.sector,signalTimestamp:signal.timestamp,entryTimestamp:entry.timestamp,exitTimestamp:c[exitIndex].timestamp,entryPrice,exitPrice,rawEntryOpen:entry.open,stopPrice:stop,stopDistancePct:stopDistance/entry.open,netReturn:exitPrice/entryPrice-1,exitReason,...features};
}
function largeTrades(row,bm,cost){
  const c=row.candles,b=testBounds(c);if(!b)return[];
  const out=[];let i=Math.max(b.s,206);
  while(i<b.e){
    const signal=c[i],prev=c[i-1],ma=sma(c,i,200),prior=sma(c,i-5,200),a=atr(c,i,14),h=highBefore(c,i,5),av=avgVol(c,i,20),ad=avgDollar(c,i,20);
    const rvol=av&&av>0?signal.volume/av:null,pb=h!=null&&a&&a>0?(h-signal.close)/a:null,rs=rsExcess(c,i,bm,20),dacc=ad&&ad>0?(signal.close*signal.volume)/ad:null;
    const ok=ma!=null&&prior!=null&&a!=null&&a>0&&h!=null&&rvol!=null&&pb!=null&&signal.close>ma&&ma>prior&&pb>=0.5&&pb<=2.5&&signal.close>signal.open&&signal.close>prev.close&&rvol>=1;
    if(!ok){i++;continue;}
    const t=completeTrade({row,c,signalIndex:i,entryIndex:i+1,signalAtr:a,stopMult:2.5,rr:2,maxHold:10,gapMax:4,cost,features:{relativeStrengthExcess:rs??-999,dollarVolumeAcceleration:dacc??0,relativeVolume:rvol,pullbackAtr:pb}});
    if(t){out.push(t);i=c.findIndex(x=>x.timestamp===t.exitTimestamp)+1;}else i++;
  }
  return out;
}
function smallTrades(row,bm,cost){
  const c=row.candles,b=testBounds(c);if(!b)return[];
  const out=[];let i=Math.max(b.s,25);
  while(i<b.e){
    const signal=c[i],res=highBefore(c,i,20),ma=sma(c,i,20),a=atr(c,i,14),av=avgVol(c,i,20),ad=avgDollar(c,i,20);
    const rvol=av&&av>0?signal.volume/av:null,rs=rsExcess(c,i,bm,20),dacc=ad&&ad>0?(signal.close*signal.volume)/ad:null;
    const ok=res!=null&&ma!=null&&a!=null&&a>0&&rvol!=null&&rs!=null&&dacc!=null&&signal.close>res&&signal.close>ma&&rvol>=2&&rs>=0.20&&dacc>=3;
    if(!ok){i++;continue;}
    const t=completeTrade({row,c,signalIndex:i,entryIndex:i+1,signalAtr:a,stopMult:2.5,rr:2,maxHold:10,gapMax:10,cost,features:{relativeStrengthExcess:rs,dollarVolumeAcceleration:dacc,relativeVolume:rvol,pullbackAtr:null}});
    if(t){out.push(t);i=c.findIndex(x=>x.timestamp===t.exitTimestamp)+1;}else i++;
  }
  return out;
}
function pctRank(values,value){
  if(!values.length)return 0;
  const sorted=[...values].sort((a,b)=>a-b);let n=0;for(const x of sorted)if(x<=value)n++;
  return n/sorted.length;
}
function rankTrades(trades){
  const groups=new Map();
  for(const t of trades){const arr=groups.get(t.entryTimestamp)??[];arr.push(t);groups.set(t.entryTimestamp,arr);}
  for(const arr of groups.values()){
    const rs=arr.map(t=>t.relativeStrengthExcess),dv=arr.map(t=>t.dollarVolumeAcceleration),rv=arr.map(t=>t.relativeVolume);
    for(const t of arr)t.rankScore=0.45*pctRank(rs,t.relativeStrengthExcess)+0.35*pctRank(dv,t.dollarVolumeAcceleration)+0.20*pctRank(rv,t.relativeVolume);
  }
  return trades;
}
function summarizeTrades(trades){
  const r=trades.map(t=>t.netReturn),wins=r.filter(x=>x>0),losses=r.filter(x=>x<0),gp=wins.reduce((a,b)=>a+b,0),gl=Math.abs(losses.reduce((a,b)=>a+b,0));
  return {tradeCount:r.length,winRate:r.length?wins.length/r.length:0,expectancy:r.length?mean(r):0,profitFactor:gl>0?gp/gl:gp>0?999:null};
}
function simulatePortfolio(trades,rows,benchmarkCandles){
  rankTrades(trades);
  const byEntry=new Map(),byExit=new Map();
  for(const t of trades){(byEntry.get(t.entryTimestamp)??byEntry.set(t.entryTimestamp,[]).get(t.entryTimestamp)).push(t);(byExit.get(t.exitTimestamp)??byExit.set(t.exitTimestamp,[]).get(t.exitTimestamp)).push(t);}
  const closeMaps=new Map(rows.map(r=>[r.symbol,new Map(r.candles.map(c=>[c.timestamp,c.close]))]));
  const days=benchmarkCandles.filter(c=>c.timestamp>=TEST_START&&c.timestamp<TEST_END).map(c=>c.timestamp);
  let cash=1,equity=1,peak=1,maxDD=0,maxCommitted=0,positionDays=0;
  const positions=new Map();let selected=0,capacityRejected=0,sectorRejected=0;
  const curve=[];
  for(const day of days){
    const startEquity=equity;
    const candidates=[...(byEntry.get(day)??[])].sort((a,b)=>b.rankScore-a.rankScore||b.relativeStrengthExcess-a.relativeStrengthExcess);
    const sectorCounts=new Map();
    for(const p of positions.values())sectorCounts.set(p.trade.sector,(sectorCounts.get(p.trade.sector)??0)+1);
    for(const trade of candidates){
      if(positions.size>=PORTFOLIO.maxPositions){capacityRejected++;continue;}
      const sec=trade.sector||"UNKNOWN";if((sectorCounts.get(sec)??0)>=PORTFOLIO.maxPerSector){sectorRejected++;continue;}
      const risk=trade.stopDistancePct;if(!(risk>0)){continue;}
      const weight=Math.min(PORTFOLIO.maxWeightPerPosition,PORTFOLIO.riskBudgetPerTrade/risk);
      const targetNotional=startEquity*weight;const notional=Math.min(targetNotional,cash);
      if(notional<startEquity*0.005)continue;
      const shares=notional/trade.entryPrice;cash-=notional;
      positions.set(trade.symbol+"|"+trade.entryTimestamp,{trade,shares});
      sectorCounts.set(sec,(sectorCounts.get(sec)??0)+1);selected++;
    }
    const exits=byExit.get(day)??[];
    for(const trade of exits){
      const key=trade.symbol+"|"+trade.entryTimestamp,p=positions.get(key);
      if(!p)continue;
      cash+=p.shares*trade.exitPrice;positions.delete(key);
    }
    let mtm=cash,committed=0;
    for(const p of positions.values()){
      const close=closeMaps.get(p.trade.symbol)?.get(day);
      const px=Number.isFinite(close)?close:p.trade.rawEntryOpen;
      mtm+=p.shares*px;committed+=p.shares*px;
    }
    equity=mtm;peak=Math.max(peak,equity);maxDD=Math.max(maxDD,(peak-equity)/peak);maxCommitted=Math.max(maxCommitted,equity>0?committed/equity:0);positionDays+=positions.size;
    curve.push({timestamp:day,equity,positions:positions.size});
  }
  return {endingEquity:equity,totalReturn:equity-1,maxDrawdown:maxDD,maxCapitalCommitted:maxCommitted,selectedTrades:selected,candidateTrades:trades.length,capacityRejected,sectorRejected,averageOpenPositions:days.length?positionDays/days.length:0,curve};
}
async function run(cost){
  const universe=selectHoldouts(await fetchUniverse());
  const flat=[...universe.large.map(r=>({...r,bucket:"LARGE"})),...universe.small.map(r=>({...r,bucket:"SMALL"}))];
  const fetched=await mapLimit(flat,5,async row=>{const h=await hist(row.symbol);return {...row,candles:h.candles};});
  const ok=fetched.filter(x=>x.ok).map(x=>x.value),bad=fetched.filter(x=>!x.ok);
  const large=ok.filter(x=>x.bucket==="LARGE"),small=ok.filter(x=>x.bucket==="SMALL");
  const spy=await hist("SPY"),bm=benchmarkMap(spy.candles);
  const lt=large.flatMap(r=>largeTrades(r,bm,cost)),st=small.flatMap(r=>smallTrades(r,bm,cost)),all=[...lt,...st];
  return {universe:universe.diagnostics,history:{attempts:flat.length,successes:ok.length,failures:bad.length},large:{symbols:large.length,metrics:summarizeTrades(lt)},small:{symbols:small.length,metrics:summarizeTrades(st)},largeOnlyPortfolio:simulatePortfolio([...lt],ok,spy.candles),smallOnlyPortfolio:simulatePortfolio([...st],ok,spy.candles),combinedPortfolio:simulatePortfolio(all,ok,spy.candles)};
}
const normal=await run(NORMAL_COST),stressed=await run(STRESS_COST);
const report={schemaVersion:1,status:"pass",market:"US_STOCK",purpose:"unseen-symbol holdout cross-sectional portfolio diagnostic",holdoutPolicy:{large:"current liquid LARGE ranks 81-160, excluding prior top-80 research universe",small:"current liquid SMALL ranks 121-240, excluding prior top-120 research universe",testWindow:[new Date(TEST_START).toISOString(),new Date(TEST_END).toISOString()]},frozenStrategies:{large:LARGE_PARAMS,small:SMALL_PARAMS},portfolioPolicy:PORTFOLIO,rankingPolicy:{relativeStrengthPercentileWeight:0.45,dollarVolumeAccelerationPercentileWeight:0.35,relativeVolumePercentileWeight:0.20,weightsRetunedOnHoldout:false},normalCost:{perSide:NORMAL_COST,...normal},stressedCost:{perSide:STRESS_COST,...stressed},safety:{researchOnly:true,liveExecutionAllowed:false,privateAccountRequestAllowed:false,executionAuthority:"NONE"},limitations:["Universe membership and liquidity ranks use a current snapshot, so point-in-time survivorship/selection bias remains.","The six-month calendar period has been observed in earlier research, but these holdout symbols were outside the prior top-ranked universes.","Portfolio equity is marked to daily close; intraday portfolio drawdown can be worse.","Same-day exits are not recycled into same-open entries, a conservative capital-use assumption.","SEC catalyst/float/dilution data is not used in V4 because SEC was unavailable from GitHub Actions and missing evidence is not fabricated.","This diagnostic cannot establish profitability or grant trading authority."]};
const out=resolve(process.argv[2]??"docs/us-equity-cross-sectional-holdout-v4.json");await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(report,null,2)+"\n","utf8");console.log(JSON.stringify(report,null,2));
