/** Isolated Signal V3 public Yahoo repair: aggregate only actually
 * observed, contiguous lower-frequency candles in a verified regular-session
 * bucket. No synthetic missing bars, no private API, no order authority.
 * Native candles are NEVER overwritten; a conflicting overlap rejects repair.
 */
const MARKETS=Object.freeze({
  US_STOCK:{timeZone:'America/New_York',open:570,close:960},
  KR_STOCK:{timeZone:'Asia/Seoul',open:540,close:930},
});
const FRAME=Object.freeze({
  '15m':{source:'5m',target:15,lower:5},
  '60m':{source:'15m',target:60,lower:15},
});
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
const formatter=Object.freeze(Object.fromEntries(Object.entries(MARKETS).map(([key,m])=>
  [key,new Intl.DateTimeFormat('en-US',{timeZone:m.timeZone,
    hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',
    weekday:'short',hour:'2-digit',minute:'2-digit'})])));
function clock(at,market){
  const fmt=formatter[market],session=MARKETS[market];
  const p=Object.fromEntries(fmt.formatToParts(new Date(at))
    .filter(v=>v.type!=='literal').map(v=>[v.type,v.value]));
  const minute=Number(p.hour)*60+Number(p.minute);
  if(['Sat','Sun'].includes(p.weekday)||minute<session.open||minute>=session.close)
    return null;
  return {date:p.year+'-'+p.month+'-'+p.day,minute};
}
function validBar(bar,nowMs){
  const t=bar?.time;
  if(typeof t!=='string'||!ISO.test(t))return null;
  const at=Date.parse(t);
  if(!Number.isSafeInteger(at)||at<=0||at>nowMs+5000)return null;
  if(![bar.open,bar.high,bar.low,bar.close].every(v=>
    typeof v==='number'&&Number.isFinite(v)&&v>0)
    ||typeof bar.volume!=='number'||!Number.isFinite(bar.volume)
    ||bar.volume<0||bar.high<Math.max(bar.open,bar.low,bar.close)
    ||bar.low>Math.min(bar.open,bar.high,bar.close))return null;
  return at;
}
function parsedBars(rows,nowMs){
  if(!Array.isArray(rows)||rows.length>16000)throw Error('V3_PUBLIC_STOCK_SOURCE_BOUNDS');
  const out=new Map();
  for(const bar of rows){
    const at=validBar(bar,nowMs);
    if(at===null||out.has(at))throw Error('V3_PUBLIC_STOCK_SOURCE_INVALID');
    out.set(at,bar);
  }
  return out;
}
function mismatch(native,derived){
  // All sources are public Yahoo charts. An overlapping price discrepancy
  // rejects the entire recovery, not just the conflicting bar.
  for(const key of ['open','high','low','close']){
    const left=native[key],right=derived[key];
    if(Math.abs(left-right)/Math.max(Math.abs(left),Math.abs(right))>0.003)
      return true;
  }
  return false;
}
export function recoverV3CompletedPublicBars(native,lower,{
  market='US_STOCK',timeframe='15m',nowMs=Date.now(),
}={}){
  const session=MARKETS[market],profile=FRAME[timeframe];
  if(!session||!profile||!Number.isSafeInteger(nowMs)||nowMs<=0)
    throw Error('V3_PUBLIC_STOCK_RECOVERY_CONFIG_INVALID');
  const baseline=parsedBars(native,nowMs);
  const detail=parsedBars(lower,nowMs);
  const batches=new Map();
  for(const [at,bar] of detail){
    const t=clock(at,market);
    if(!t)continue;
    if((t.minute-session.open)%profile.lower!==0)continue;
    const offset=t.minute-session.open;
    const bucketIndex=Math.floor(offset/profile.target);
    const bucketStartMinute=session.open+bucketIndex*profile.target;
    if(bucketStartMinute+profile.target>session.close)continue;
    const bucketStartAt=at-(t.minute-bucketStartMinute)*60_000;
    if(bucketStartAt+profile.target*60_000>nowMs)continue;
    const key=t.date+':'+bucketIndex;
    const list=batches.get(key)??[];
    list.push({at,bar,bucketStartAt});
    batches.set(key,list);
  }
  const recovered=[];
  let overlapCount=0,completeBuckets=0;
  const size=profile.target/profile.lower;
  for(const values of batches.values()){
    if(values.length!==size)continue;
    values.sort((a,b)=>a.at-b.at);
    const at=values[0].bucketStartAt;
    if(values.some((v,i)=>v.bucketStartAt!==at||v.at!==at+i*profile.lower*60_000))
      continue;
    completeBuckets++;
    const first=values[0].bar,last=values.at(-1).bar;
    const bar={time:new Date(at).toISOString(),
      open:first.open,high:Math.max(...values.map(v=>v.bar.high)),
      low:Math.min(...values.map(v=>v.bar.low)),close:last.close,
      volume:values.reduce((sum,v)=>sum+v.bar.volume,0)};
    if(!validBar(bar,nowMs))throw Error('V3_PUBLIC_STOCK_RECOVERY_AGGREGATE_INVALID');
    const existing=baseline.get(at);
    if(existing){overlapCount++;if(mismatch(existing,bar))
      return Object.freeze({candles:native,added:0,completeBuckets,
        overlapCount,status:'CONFLICTING_PROVIDER_BARS',executionAuthority:'NONE'});
    }else recovered.push({at,bar});
  }
  const result=[...baseline.entries(),...recovered.map(x=>[x.at,x.bar])]
    .sort(([a],[b])=>a-b).map(([,bar])=>bar);
  return Object.freeze({candles:result,added:recovered.length,
    completeBuckets,overlapCount,
    status:recovered.length>0?'VERIFIED_LOWER_BARS_ADDED':'NO_COMPLETE_GAPS',
    executionAuthority:'NONE'});
}
