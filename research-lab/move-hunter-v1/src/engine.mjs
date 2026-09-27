export const DIRECTIONS = Object.freeze({ LONG: 'LONG', SHORT: 'SHORT' });

export const RUNNER_RESEARCH_PRESETS = Object.freeze({
  TIGHT_DEFAULT: Object.freeze({
    atrStopMult: 1.2, minStopPct: 0.003, maxStopPct: 0.025,
    breakEvenAtR: 1.0, trailActivateAtR: 2.0, trailAtrMult: 2.0, maxBars: 120,
  }),
  LONG_RUNNER_3ATR: Object.freeze({
    atrStopMult: 1.2, minStopPct: 0.003, maxStopPct: 0.025,
    breakEvenAtR: 1.0, trailActivateAtR: 2.0, trailAtrMult: 3.0, maxBars: 120,
  }),
  DELAYED_BE_TRAIL: Object.freeze({
    atrStopMult: 1.2, minStopPct: 0.003, maxStopPct: 0.025,
    breakEvenAtR: 2.0, trailActivateAtR: 3.0, trailAtrMult: 3.0, maxBars: 120,
  }),
  NO_BE_TRAIL_3ATR: Object.freeze({
    atrStopMult: 1.2, minStopPct: 0.003, maxStopPct: 0.025,
    breakEvenAtR: 999.0, trailActivateAtR: 2.0, trailAtrMult: 3.0, maxBars: 120,
  }),
});

function finite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}
function mean(values) { return values.length ? values.reduce((a,b)=>a+b,0)/values.length : 0; }
function clamp(value,min,max){ return Math.max(min,Math.min(max,value)); }
function normalizeDirection(value){
  const v=String(value??'').trim().toUpperCase();
  if(v==='LONG'||v==='BUY') return DIRECTIONS.LONG;
  if(v==='SHORT'||v==='SELL') return DIRECTIONS.SHORT;
  throw new TypeError('direction must be LONG/BUY or SHORT/SELL');
}
function directionalReturn(entry,price,direction){
  return direction===DIRECTIONS.LONG ? (price/entry)-1 : (entry-price)/entry;
}
function stopHit(bar,stop,direction){ return direction===DIRECTIONS.LONG ? bar.low<=stop : bar.high>=stop; }
function worseStopFill(bar,stop,direction){ return direction===DIRECTIONS.LONG ? Math.min(bar.open,stop) : Math.max(bar.open,stop); }

export function validateCandles(candles){
  if(!Array.isArray(candles)) throw new TypeError('candles must be an array');
  let previous=-Infinity;
  candles.forEach((c,i)=>{
    for(const k of ['ts','open','high','low','close','volume']) finite(c[k],`candle[${i}].${k}`);
    if(c.ts<=previous) throw new RangeError('candles must be strictly time-sorted');
    if(c.open<=0||c.high<=0||c.low<=0||c.close<=0||c.volume<0) throw new RangeError(`invalid candle at index ${i}`);
    if(c.high<Math.max(c.open,c.close,c.low)||c.low>Math.min(c.open,c.close,c.high)) throw new RangeError(`inconsistent OHLC at index ${i}`);
    previous=c.ts;
  });
  return candles;
}

export function candlesAtOrBefore(candles,asOf){
  validateCandles(candles); finite(asOf,'asOf');
  let lo=0,hi=candles.length;
  while(lo<hi){ const mid=(lo+hi)>>>1; if(candles[mid].ts<=asOf) lo=mid+1; else hi=mid; }
  return candles.slice(0,lo);
}

export function trueRange(current,previousClose){
  return Math.max(current.high-current.low,Math.abs(current.high-previousClose),Math.abs(current.low-previousClose));
}
export function atr(candles,period=14){
  validateCandles(candles); if(candles.length<2) return 0;
  const start=Math.max(1,candles.length-period), ranges=[];
  for(let i=start;i<candles.length;i+=1) ranges.push(trueRange(candles[i],candles[i-1].close));
  return mean(ranges);
}
function initialStop({past,entry,direction,atrStopMult,structureLookback,minStopPct,maxStopPct}){
  const a=atr(past,14);
  const recent=past.slice(-structureLookback);
  let candidate;
  let structure;
  if(direction===DIRECTIONS.LONG){
    structure=Math.min(...recent.map(c=>c.low));
    const atrStop=a>0?entry-a*atrStopMult:entry*(1-maxStopPct);
    candidate=Math.max(atrStop,structure);
    const distance=clamp(entry-candidate,entry*minStopPct,entry*maxStopPct);
    return {stop:entry-distance,atr:a,structure};
  }
  structure=Math.max(...recent.map(c=>c.high));
  const atrStop=a>0?entry+a*atrStopMult:entry*(1+maxStopPct);
  candidate=Math.min(atrStop,structure);
  const distance=clamp(candidate-entry,entry*minStopPct,entry*maxStopPct);
  return {stop:entry+distance,atr:a,structure};
}
function roundTripCostRate({feeBps=0,slippageBps=0,spreadBps=0}={}){
  return ((feeBps*2)+(slippageBps*2)+spreadBps)/10000;
}

export function simulateRunner({
  candles, signalAtMs, direction='LONG', maxBars=120,
  profitMilestones=[0.03,0.05,0.10,0.20,0.30,0.50,1.00],
  atrStopMult=1.2, structureLookback=10, minStopPct=.003, maxStopPct=.025,
  breakEvenAtR=1, trailActivateAtR=2, trailAtrMult=2,
  sameBarPolicy='STOP_FIRST', costs={},
}={}){
  const side=normalizeDirection(direction);
  validateCandles(candles);
  if(sameBarPolicy!=='STOP_FIRST') throw new RangeError('only STOP_FIRST is supported');
  const past=candlesAtOrBefore(candles,signalAtMs);
  if(past.length<Math.max(30,structureLookback)) throw new RangeError('insufficient past-only candles');
  const entryIndex=past.length;
  if(entryIndex>=candles.length) throw new RangeError('no next-bar entry available');
  const entryBar=candles[entryIndex], entry=entryBar.open;
  const init=initialStop({past,entry,direction:side,atrStopMult,structureLookback,minStopPct,maxStopPct});
  const riskDistance=Math.abs(entry-init.stop);
  if(!(riskDistance>0)) throw new RangeError('invalid initial risk');

  if(!Array.isArray(profitMilestones)||profitMilestones.some(v=>!Number.isFinite(v)||v<=0)) throw new TypeError('profitMilestones must be positive finite returns');
  const milestones=[...new Set(profitMilestones)].sort((a,b)=>a-b);
  let stop=init.stop;
  let best=entry;
  let mfe=0,mae=0,maxR=0,exitPrice=null,exitTs=null,exitReason=null,ambiguousBars=0;
  const milestoneHitTs=Object.fromEntries(milestones.map(v=>[String(v),null]));
  const stopHistory=[{ts:entryBar.ts,stop,reason:'INITIAL'}];
  const endIndex=Math.min(candles.length-1,entryIndex+maxBars-1);

  for(let i=entryIndex;i<=endIndex;i+=1){
    const bar=candles[i], activeStop=stop;
    if(stopHit(bar,activeStop,side)){
      const favorableExtreme=side===DIRECTIONS.LONG?bar.high:bar.low;
      if(directionalReturn(entry,favorableExtreme,side)>=.03) ambiguousBars+=1;
      exitPrice=worseStopFill(bar,activeStop,side); exitTs=bar.ts;
      exitReason=activeStop===init.stop?'INITIAL_STOP':'TRAIL_STOP';
      mae=Math.min(mae,directionalReturn(entry,exitPrice,side));
      break;
    }

    const favorableExtreme=side===DIRECTIONS.LONG?bar.high:bar.low;
    const adverseExtreme=side===DIRECTIONS.LONG?bar.low:bar.high;
    best=side===DIRECTIONS.LONG?Math.max(best,favorableExtreme):Math.min(best,favorableExtreme);
    mfe=Math.max(mfe,directionalReturn(entry,favorableExtreme,side));
    mae=Math.min(mae,directionalReturn(entry,adverseExtreme,side));
    maxR=Math.max(maxR,(mfe*entry)/riskDistance);
    const favorableReturn=directionalReturn(entry,favorableExtreme,side);
    for(const milestone of milestones){
      const key=String(milestone);
      if(milestoneHitTs[key]===null&&favorableReturn>=milestone) milestoneHitTs[key]=bar.ts;
    }

    const currentR=(directionalReturn(entry,best,side)*entry)/riskDistance;
    let nextStop=stop,reason=null;
    if(currentR>=breakEvenAtR){
      if((side===DIRECTIONS.LONG&&entry>nextStop)||(side===DIRECTIONS.SHORT&&entry<nextStop)){ nextStop=entry; reason='BREAKEVEN'; }
    }
    if(currentR>=trailActivateAtR){
      const rollingAtr=atr(candles.slice(0,i+1),14)||init.atr;
      const trail=side===DIRECTIONS.LONG ? best-rollingAtr*trailAtrMult : best+rollingAtr*trailAtrMult;
      if((side===DIRECTIONS.LONG&&trail>nextStop)||(side===DIRECTIONS.SHORT&&trail<nextStop)){ nextStop=trail; reason='ATR_TRAIL'; }
    }
    if(side===DIRECTIONS.LONG) nextStop=Math.min(nextStop,bar.close*.999999);
    else nextStop=Math.max(nextStop,bar.close*1.000001);
    if((side===DIRECTIONS.LONG&&nextStop>stop)||(side===DIRECTIONS.SHORT&&nextStop<stop)){
      stop=nextStop; stopHistory.push({ts:bar.ts,stop,reason});
    }
  }

  if(exitPrice===null){ const last=candles[endIndex]; exitPrice=last.close; exitTs=last.ts; exitReason='TIME_EXIT'; }
  const grossReturn=directionalReturn(entry,exitPrice,side);
  const netReturn=grossReturn-roundTripCostRate(costs);
  const grossCaptureRatio=mfe>0?clamp(Math.max(0,grossReturn)/mfe,0,1):0;
  const netCaptureRatio=mfe>0?clamp(Math.max(0,netReturn)/mfe,0,1):0;
  const givebackFromPeak=Math.max(0,mfe-Math.max(0,grossReturn));
  return {
    signalAtMs,direction:side,entryTs:entryBar.ts,entry,initialStop:init.stop,initialRiskPct:riskDistance/entry,
    structure:init.structure,discoveryAtr:init.atr,exitTs,exitPrice,exitReason,grossReturn,netReturn,
    netR:netReturn/(riskDistance/entry),mfe,mae,maxR,
    peakReturn:mfe,milestoneHitTs,grossCaptureRatio,netCaptureRatio,givebackFromPeak,
    targetHitTs:{pct3:milestoneHitTs['0.03']??null,pct5:milestoneHitTs['0.05']??null,pct10:milestoneHitTs['0.1']??null},
    finalStop:stop,stopHistory,
    ambiguousBars,sameBarPolicy,barsObserved:Math.max(1,candles.findIndex(c=>c.ts===exitTs)-entryIndex+1),
  };
}

export function summarizeRunnerTrials(trials=[]){
  const settled=trials.filter(t=>Number.isFinite(t?.netReturn)), n=settled.length;
  if(!n) return {n:0,winRate:0,avgNetReturn:0,avgNetR:0,profitFactor:0,maxDrawdown:0};
  const wins=settled.filter(t=>t.netReturn>0), losses=settled.filter(t=>t.netReturn<0);
  const gain=wins.reduce((s,t)=>s+t.netReturn,0), loss=-losses.reduce((s,t)=>s+t.netReturn,0);
  let equity=1,peak=1,maxDrawdown=0;
  for(const t of settled){ equity*=1+t.netReturn; peak=Math.max(peak,equity); maxDrawdown=Math.max(maxDrawdown,1-equity/peak); }
  return {
    n,winRate:wins.length/n,avgNetReturn:mean(settled.map(t=>t.netReturn)),avgNetR:mean(settled.map(t=>t.netR)),
    profitFactor:loss>0?gain/loss:(gain>0?Infinity:0),maxDrawdown,
    pct3HitRate:settled.filter(t=>t.targetHitTs?.pct3!==null).length/n,
    pct5HitRate:settled.filter(t=>t.targetHitTs?.pct5!==null).length/n,
    pct10HitRate:settled.filter(t=>t.targetHitTs?.pct10!==null).length/n,
    pct20HitRate:settled.filter(t=>t.milestoneHitTs?.['0.2']!==null&&t.milestoneHitTs?.['0.2']!==undefined).length/n,
    pct50HitRate:settled.filter(t=>t.milestoneHitTs?.['0.5']!==null&&t.milestoneHitTs?.['0.5']!==undefined).length/n,
    pct100HitRate:settled.filter(t=>t.milestoneHitTs?.['1']!==null&&t.milestoneHitTs?.['1']!==undefined).length/n,
    avgMfe:mean(settled.map(t=>t.mfe)),avgMae:mean(settled.map(t=>t.mae)),
    maxMfe:Math.max(...settled.map(t=>t.mfe)),maxNetReturn:Math.max(...settled.map(t=>t.netReturn)),
    avgGrossCaptureRatio:mean(settled.map(t=>t.grossCaptureRatio??0)),avgNetCaptureRatio:mean(settled.map(t=>t.netCaptureRatio??0)),
    avgGivebackFromPeak:mean(settled.map(t=>t.givebackFromPeak??0)),
  };
}
