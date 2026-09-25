// Pure research-only accounting. No network, orders, application imports or environment writes.
export const START = Date.parse('2026-03-25T00:00:00Z');
export const END = Date.parse('2026-09-25T00:00:00Z');
export const ARMS = Object.freeze(['BASELINE_ACCOUNTING', 'STRUCTURAL_RISK_CAP', 'QUALITY_RISK_TIME']);
export const POLICY = Object.freeze({
  id: 'selective-opportunity-matched-audit-v2', interval: [START, END],
  candidateStream: 'V1_FIXED_MATCHED_ENTRIES_NO_NEW_REENTRY', historicalStatus: 'POST_SELECTION_EXPLORATORY',
  symbolCap: .20, themeCap: .40, maxGrossExposure: 1, maxPositions: 5, riskFraction: .005,
  aggregateInitialRiskCap: .02, minimumCoverage: .80, leaderWindow: 5, minimumLeaderDays: 3,
  breadthLookback: 5, volumeReacceleration: 1.2, minimumAtrDistance: 1, structuralBufferAtr: .25,
  stockStopCap: .08, cryptoStopCap: .10, explosionStopCap: .08, maxEntryGapAtr: 1,
  timeStopStock: 5, timeStopCrypto: 18, timeStopExplosion: 3, minimumProgressR: .5,
  costStressMultiplier: 1.5, actualOrders: 0, executionAuthority: 'NONE',
  probability: null, expectedFutureValue: null, calibration: 'NOT_ESTIMATED',
  profitabilityProven: false, paperActivationAllowed: false,
});
const avg = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null;
export const isCrypto = lane => lane === 'CRYPTO_SPOT';
export const isExplosion = lane => lane === 'US_EXPLOSION_DAILY_PROXY';
export const duration = lane => isCrypto(lane) ? 4*3600000 : 6.5*3600000;
export function meanClose(rows,i,n) { return i-n+1<0 ? null : avg(rows.slice(i-n+1,i+1).map(r=>r.close)); }
export function atr(rows,i,n=14) {
  if(i<n) return null;
  return avg(rows.slice(i-n+1,i+1).map((r,j)=>{ const p=rows[i-n+j].close; return Math.max(r.high-r.low,Math.abs(r.high-p),Math.abs(r.low-p)); }));
}
export function validateCandles(rows,lane) {
  if(!Array.isArray(rows)||!rows.length) throw new Error('EMPTY_CANDLES');
  let previous=-Infinity;
  for(const r of rows) {
    if(!Number.isFinite(r.timestamp)||r.timestamp<=previous) throw new Error('CANDLE_TIME_DUPLICATE_OR_UNSORTED');
    if(!['open','high','low','close','volume'].every(k=>typeof r[k]==='number'&&Number.isFinite(r[k]))) throw new Error('CANDLE_VALUE_INVALID');
    if(Math.min(r.open,r.high,r.low,r.close)<=0||r.volume<0||r.high<Math.max(r.open,r.close)||r.low>Math.min(r.open,r.close)||r.high<r.low) throw new Error('CANDLE_OHLC_INVALID');
    if(r.timestamp+duration(lane)>END) throw new Error('UNCLOSED_OR_OUT_OF_WINDOW_CANDLE');
    previous=r.timestamp;
  }
  return {first:rows[0].timestamp,last:rows.at(-1).timestamp,count:rows.length};
}
function rowAt(rows,t) { const i=rows.findIndex(r=>r.timestamp===t); return i<0?null:{r:rows[i],i}; }
function themeSnapshot(data,theme,t,lane) {
  const fast=isCrypto(lane)?30:20, slow=isCrypto(lane)?120:60;
  const mom=isCrypto(lane)?30:20, longMom=isCrypto(lane)?90:60;
  const members=[];
  for(const symbol of theme.symbols) {
    const rows=data.get(symbol), a=rows&&rowAt(rows,t);
    if(!a||a.i<slow) continue;
    const s=meanClose(rows,a.i,fast), rf=a.r.close/rows[a.i-mom].close-1, rl=a.r.close/rows[a.i-longMom].close-1;
    members.push({symbol,above:a.r.close>s,rankValue:.65*rf+.35*rl});
  }
  if(members.length<3||members.length/theme.symbols.length<POLICY.minimumCoverage) return null;
  members.sort((a,b)=>b.rankValue-a.rankValue||a.symbol.localeCompare(b.symbol));
  return {breadth:members.filter(x=>x.above).length/members.length, leaders:members.slice(0,2).map(x=>x.symbol), memberCount:members.length};
}
export function qualityEvidence(candidate,rows,data,themes) {
  const i=candidate.signalIndex, lane=candidate.lane, reasons=[];
  const contraction=avg(rows.slice(i-3,i).map(r=>r.volume));
  if(!(contraction>0&&rows[i].volume>=contraction*POLICY.volumeReacceleration)) reasons.push('VOLUME_REACCELERATION_MISSING');
  const priorPeakVolume=Math.max(...rows.slice(Math.max(0,i-20),Math.max(0,i-3)).map(r=>r.volume));
  if(!(contraction>0&&priorPeakVolume>contraction)) reasons.push('PULLBACK_VOLUME_CONTRACTION_MISSING');
  if(isExplosion(lane)) {
    const previous=rows[i-1];
    if(!(rows[i].low>previous.low&&rows[i].close>previous.close)) reasons.push('SURVIVAL_HIGHER_LOW_MISSING');
    return {reasons,leaderDays:null,breadthNow:null,breadthBefore:null};
  }
  const theme=themes.find(x=>x.key===candidate.theme);
  if(!theme) return {reasons:[...reasons,'THEME_IDENTITY_MISSING']};
  const snapshots=[];
  for(let j=i-POLICY.leaderWindow+1;j<=i;j++) {
    if(j<0) return {reasons:[...reasons,'LEADER_HISTORY_MISSING']};
    snapshots.push(themeSnapshot(data,theme,rows[j].timestamp,lane));
  }
  const old=i>=POLICY.breadthLookback?themeSnapshot(data,theme,rows[i-POLICY.breadthLookback].timestamp,lane):null;
  if(snapshots.some(x=>!x)||!old) return {reasons:[...reasons,'THEME_PIT_PRICE_COVERAGE_MISSING']};
  const now=snapshots.at(-1), leaderDays=snapshots.filter(x=>x.leaders.includes(candidate.symbol)).length;
  if(leaderDays<POLICY.minimumLeaderDays) reasons.push('LEADER_PERSISTENCE_INSUFFICIENT');
  if(now.breadth<old.breadth) reasons.push('BREADTH_DECELERATING');
  return {reasons,leaderDays,breadthNow:now.breadth,breadthBefore:old.breadth};
}
export function planTrade(candidate,rows,arm,{data=new Map(),themes=[]}={}) {
  if(!ARMS.includes(arm)) throw new Error('UNKNOWN_ARM');
  const i=candidate.signalIndex, next=rows[i+1], s=rows[i], lane=candidate.lane;
  if(!s||!next||s.timestamp!==candidate.signalTimestamp||next.timestamp!==candidate.entryTimestamp) return {blockers:['CANDIDATE_SOURCE_IDENTITY_MISMATCH']};
  if(next.timestamp<START||next.timestamp>=END||s.timestamp+duration(lane)>next.timestamp) return {blockers:['ENTRY_NOT_AFTER_CLOSED_SIGNAL']};
  const a=atr(rows,i); if(!(a>0)) return {blockers:['ATR_MISSING']};
  const factor=isExplosion(lane)?2:isCrypto(lane)?2.7:2.5;
  let stop=next.open-a*factor;
  const blockers=[]; let quality=null;
  if(arm!=='BASELINE_ACCOUNTING') {
    // A stop must remain below the observed structure AND at least one ATR away.
    // Never pull it inside that structure merely to make a risk cap pass.
    const structure=Math.min(...rows.slice(Math.max(0,i-4),i+1).map(r=>r.low))-a*POLICY.structuralBufferAtr;
    stop=Math.min(structure,next.open-a*POLICY.minimumAtrDistance);
    const cap=isExplosion(lane)?POLICY.explosionStopCap:isCrypto(lane)?POLICY.cryptoStopCap:POLICY.stockStopCap;
    if((next.open-stop)/next.open>cap) blockers.push('STRUCTURAL_STOP_TOO_WIDE');
    if(Math.abs(next.open-s.close)>a*POLICY.maxEntryGapAtr) blockers.push('ENTRY_GAP_TOO_LARGE');
  }
  if(!(stop>0&&stop<next.open)) blockers.push('INVALID_STOP');
  if(arm==='QUALITY_RISK_TIME') { quality=qualityEvidence(candidate,rows,data,themes); blockers.push(...quality.reasons); }
  return {blockers,quality,stop,atr:a,arm};
}
export function simulateTrade(candidate,rows,plan) {
  if(plan.blockers.length) return null;
  const lane=candidate.lane, ei=candidate.signalIndex+1, entry=rows[ei], risk=entry.open-plan.stop;
  const target1=entry.open+risk*(isExplosion(lane)?1.5:2), target2=entry.open+risk*(isExplosion(lane)?3:4);
  const maxHold=isExplosion(lane)?10:isCrypto(lane)?90:40;
  const timeBars=isExplosion(lane)?POLICY.timeStopExplosion:isCrypto(lane)?POLICY.timeStopCrypto:POLICY.timeStopStock;
  const trail=isCrypto(lane)?3.2:isExplosion(lane)?2.5:3;
  let remaining=1,stop=plan.stop,highClose=entry.open,t1=false,t2=false,pendingTime=false;
  const fills=[];
  const fill=(i,weight,price,reason,atOpen=false)=>{
    const ts=rows[i].timestamp+(atOpen?0:duration(lane));
    fills.push({timestamp:ts,phase:atOpen?3:0,weight,price,reason,barIndex:i}); remaining-=weight;
  };
  for(let i=ei;i<rows.length&&i<ei+maxHold;i++) {
    const c=rows[i];
    if(c.timestamp+duration(lane)>END) throw new Error('TRADE_USES_UNCLOSED_BAR');
    if(c.open<=stop) { fill(i,remaining,c.open,'STOP_GAP',true);break; }
    if(pendingTime) { fill(i,remaining,c.open,'TIME_STOP_NEXT_OPEN',true);break; }
    if(c.low<=stop) { fill(i,remaining,stop,'STOP_FIRST_CONSERVATIVE');break; }
    if(!t1&&c.high>=target1) {fill(i,1/3,target1,'TARGET_1');t1=true;}
    if(!t2&&c.high>=target2) {fill(i,1/3,target2,'TARGET_2');t2=true;}
    highClose=Math.max(highClose,c.close);
    if(t1) stop=Math.max(stop,entry.open,highClose-(atr(rows,i)??plan.atr)*trail);
    // A time stop detected with this close may only execute at a subsequent open.
    if(plan.arm==='QUALITY_RISK_TIME'&&i-ei+1>=timeBars&&(c.close-entry.open)/risk<POLICY.minimumProgressR) pendingTime=true;
    if(i===rows.length-1||i===ei+maxHold-1) {fill(i,remaining,c.close,i===rows.length-1?'WINDOW_END_MARKED_LIQUIDATION':'MAX_HOLD_CLOSE');break;}
  }
  if(Math.abs(remaining)>1e-8||!fills.length) throw new Error('EXIT_WEIGHT_NOT_CONSERVED');
  return {...candidate,id:`${lane}:${candidate.symbol}:${candidate.entryTimestamp}:${candidate.theme??'explosion'}`,
    arm:plan.arm,initialStop:plan.stop,entryPrice:entry.open,stopPercent:risk/entry.open,
    entryTimestamp:entry.timestamp,exitTimestamp:fills.at(-1).timestamp,fills,target1,target2,target1Done:t1,target2Done:t2,
    weightedExitPrice:fills.reduce((v,f)=>v+f.weight*f.price,0),quality:plan.quality};
}
export function metricSummary(ledger) {
  const r=ledger.map(x=>x.netReturn), wins=ledger.filter(x=>x.pnl>0), losses=ledger.filter(x=>x.pnl<0);
  const gain=wins.reduce((a,x)=>a+x.pnl,0), loss=-losses.reduce((a,x)=>a+x.pnl,0);
  return {trades:ledger.length,wins:wins.length,losses:losses.length,winRate:ledger.length?wins.length/ledger.length:null,
    meanTradeReturn:avg(r),profitFactor:loss>0?gain/loss:null,profitFactorStatus:loss>0?'DEFINED':ledger.length?'NO_LOSS_SAMPLE':'NO_TRADES',
    bestTrade:r.length?Math.max(...r):null,worstTrade:r.length?Math.min(...r):null};
}
export function simulatePortfolio(trades,data,lane,cost,{initialCapital=isCrypto(lane)||lane==='KR_STOCK'?10000000:10000,
  maxPositions=isExplosion(lane)?3:POLICY.maxPositions,symbolCap=isExplosion(lane)?.1:POLICY.symbolCap,
  themeCap=POLICY.themeCap,riskFraction=isExplosion(lane)?.0025:POLICY.riskFraction,
  maxGross=POLICY.maxGrossExposure,aggregateRisk=POLICY.aggregateInitialRiskCap,wholeShares=!isCrypto(lane)}={}) {
  if(!Number.isFinite(cost)||cost<0||cost>=.05) throw new Error('INVALID_COST');
  const events=[];
  // Market marks use only observed opens and CLOSED bars. No later high/low leaks into sizing.
  for(const [symbol,rows] of data) for(const r of rows) {
    if(r.timestamp<START||r.timestamp>=END) continue;
    events.push({timestamp:r.timestamp,phase:2,type:'MARK',symbol,price:r.open});
    events.push({timestamp:r.timestamp+duration(lane),phase:1,type:'MARK',symbol,price:r.close});
  }
  for(const trade of trades) {
    events.push({timestamp:trade.entryTimestamp,phase:4,type:'ENTRY',trade,symbol:trade.symbol});
    for(const fill of trade.fills) events.push({...fill,type:'EXIT',trade,symbol:trade.symbol});
  }
  events.sort((a,b)=>a.timestamp-b.timestamp||a.phase-b.phase||a.symbol.localeCompare(b.symbol)||String(a.trade?.id??'').localeCompare(String(b.trade?.id??'')));
  let cash=initialCapital,peak=initialCapital,mdd=0,maxGrossObserved=0,minCash=initialCapital,totalFees=0;
  const active=new Map(),prices=new Map(),accepted=new Map(),ledger=[],rejections=[],curve=[];
  const equity=()=>cash+[...active.values()].reduce((s,p)=>s+p.remaining*(prices.get(p.trade.symbol)??p.trade.entryPrice),0);
  function observe(timestamp,phase) {
    const e=equity(); peak=Math.max(peak,e);mdd=Math.max(mdd,peak>0?1-e/peak:0);
    maxGrossObserved=Math.max(maxGrossObserved,e>0?(e-cash)/e:0);minCash=Math.min(minCash,cash);
    curve.push({timestamp,phase,equity:e,cash,positions:active.size});
    if(cash<-.000001) throw new Error('NEGATIVE_CASH');
  }
  let lastTime=null,lastPhase=null;
  for(const event of events) {
    if(lastTime!==null&&(event.timestamp!==lastTime||event.phase!==lastPhase)) observe(lastTime,lastPhase);
    lastTime=event.timestamp;lastPhase=event.phase;
    if(event.type==='MARK') {prices.set(event.symbol,event.price);continue;}
    if(event.type==='ENTRY') {
      const t=event.trade, e=equity();
      let reject=null;
      if(active.has(t.symbol)) reject='SYMBOL_ALREADY_OPEN';
      else if(active.size>=maxPositions) reject='POSITION_CAP';
      if(reject) {rejections.push({id:t.id,reason:reject});continue;}
      const gross=e-cash, themeGross=[...active.values()].filter(p=>p.trade.theme===t.theme).reduce((s,p)=>s+p.remaining*(prices.get(p.trade.symbol)??p.trade.entryPrice),0);
      const existingRisk=[...active.values()].reduce((s,p)=>s+p.initialRisk,0);
      // Model both entry and stressed stop exit costs in the sizing risk, not just raw stop distance.
      const riskUnit=t.entryPrice*(1+cost)-t.initialStop*(1-cost);
      let q=Math.min(e*riskFraction/riskUnit,Math.max(0,e*aggregateRisk-existingRisk)/riskUnit,
        e*symbolCap/(t.entryPrice*(1+cost)),Math.max(0,e*themeCap-themeGross)/(t.entryPrice*(1+cost)),
        Math.max(0,e*maxGross-gross)/(t.entryPrice*(1+cost)),cash/(t.entryPrice*(1+cost)));
      q=wholeShares?Math.floor(q):Math.floor(q*1e8)/1e8;
      if(!(q>0)) {rejections.push({id:t.id,reason:'CASH_RISK_OR_LOT_CAP'});continue;}
      const spent=q*t.entryPrice*(1+cost),fee=q*t.entryPrice*cost;
      cash-=spent;totalFees+=fee;prices.set(t.symbol,t.entryPrice);
      const p={trade:t,quantity:q,remaining:q,spent,received:0,fees:fee,initialRisk:q*riskUnit};
      active.set(t.symbol,p);accepted.set(t.id,p);
    } else {
      const p=accepted.get(event.trade.id);
      if(!p||active.get(event.symbol)!==p) continue;
      const units=Math.min(p.remaining,p.quantity*event.weight),received=units*event.price*(1-cost),fee=units*event.price*cost;
      p.remaining-=units;p.received+=received;p.fees+=fee;cash+=received;totalFees+=fee;
      if(p.remaining<=Math.max(1e-8,p.quantity*1e-10)) {
        const pnl=p.received-p.spent;
        ledger.push({id:p.trade.id,symbol:p.trade.symbol,theme:p.trade.theme??'explosion',entryTimestamp:p.trade.entryTimestamp,
          exitTimestamp:event.timestamp,spent:p.spent,received:p.received,fees:p.fees,pnl,netReturn:pnl/p.spent,
          quantity:p.quantity,exitReason:event.reason}); active.delete(event.symbol);
      }
    }
  }
  if(lastTime!==null) observe(lastTime,lastPhase);
  if(active.size) throw new Error('UNSETTLED_RESEARCH_POSITIONS');
  const endEquity=equity();
  const monthly=[];let prior=initialCapital;
  for(let m=2;m<=8;m++) {
    const from=Math.max(START,Date.UTC(2026,m,1)),to=Math.min(END,Date.UTC(2026,m+1,1));
    if(from>=to) continue;
    const rows=curve.filter(r=>r.timestamp>=from&&(r.timestamp<to||(r.timestamp===to&&r.phase<=1)));
    const final=rows.at(-1)?.equity??prior;
    monthly.push({period:`2026-${String(m+1).padStart(2,'0')}`,partial:m===2||m===8,netReturn:final/prior-1});prior=final;
  }
  return {initialCapital,finalEquity:endEquity,netReturn:endEquity/initialCapital-1,barSampledMtmMaxDrawdown:mdd,
    maxGrossObserved,minCash,totalFees,candidateTrades:trades.length,acceptedTrades:ledger.length,rejectedTrades:rejections.length,
    metrics:metricSummary(ledger),monthly,ledger,rejections,equityCurve:curve,
    assumptions:{wholeShares,partialShareExitsModeled:true,fxConversion:false,borrowedCapital:false,
      cashSettlement:'SALE_PROCEEDS_REUSED_AFTER_MODELED_FILL_NO_REGULATORY_SETTLEMENT_MODEL',
      drawdown:'BAR_OPEN_AND_CLOSE_MTM_NOT_INTRABAR_MAXIMUM',costRatePerSide:cost}};
}
export function evaluateArm(candidates,data,themes,lane,arm,cost) {
  const plans=[],trades=[],blocked=[];
  for(const c of candidates) {
    const rows=data.get(c.symbol);if(!rows){blocked.push({symbol:c.symbol,blockers:['SOURCE_MISSING']});continue;}
    const plan=planTrade(c,rows,arm,{data,themes});plans.push({id:`${c.symbol}:${c.entryTimestamp}`,plan});
    if(plan.blockers.length){blocked.push({symbol:c.symbol,blockers:plan.blockers});continue;}
    const trade=simulateTrade(c,rows,plan);if(trade)trades.push(trade);
  }
  const blockers={};for(const row of blocked)for(const b of row.blockers)blockers[b]=(blockers[b]??0)+1;
  const normal=simulatePortfolio(trades,data,lane,cost),stress=simulatePortfolio(trades,data,lane,cost*POLICY.costStressMultiplier);
  const groups={};for(const r of normal.ledger){const key=r.theme;groups[key]??=[];groups[key].push(r);}
  return {arm,lane,fixedCandidateCount:candidates.length,eligibleCandidates:trades.length,blockers,normal,stress,
    byTheme:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,metricSummary(v)])),trades,plans,
    evidence:{status:'POST_SELECTION_MATCHED_DIAGNOSTIC_ONLY',probability:null,expectedFutureValue:null,
      independentOos:false,profitabilityProven:false,canonicalSampleDelta:0,executionAuthority:'NONE'}};
}
