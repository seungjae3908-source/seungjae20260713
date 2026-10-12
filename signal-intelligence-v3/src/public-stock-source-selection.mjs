// Public stock-only research feed selectors. Provider Yahoo endpoint calls
// belong to the caller; this module never reads accounts, keys or order APIs.
// A resolved empty/invalid chart is NOT success and must not short-circuit
// an available *public* alternate symbol, but rate-limit denials are final.
const DURATIONS=Object.freeze({
  '1m':60000,'3m':180000,'5m':300000,'15m':900000,
  '30m':1800000,'60m':3600000,'4H':14400000,
});
// Public Yahoo 1D timestamps denote session start; never use today's bar
// before the exchange-local regular market close (DST-aware for US).
const DAILY_MARKETS=Object.freeze({KR_STOCK:{zone:'Asia/Seoul',close:930},US_STOCK:{zone:'America/New_York',close:960}});
const CLOCKS=Object.freeze(Object.fromEntries(Object.entries(DAILY_MARKETS).map(([k,v])=>
 [k,new Intl.DateTimeFormat('en-US',{timeZone:v.zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})])));
function localClock(at,market){
 const formatter=CLOCKS[market];if(!formatter)throw Error('PUBLIC_STOCK_MARKET_INVALID');
 const o=Object.fromEntries(formatter.formatToParts(new Date(at)).map(x=>[x.type,x.value]));
 return {day:Number(o.year+o.month+o.day),minutes:Number(o.hour)*60+Number(o.minute)};
}
function closedDaily(at,now,market){
 const start=localClock(at,market),current=localClock(now,market);
 // Early-close sessions are conservatively held until regular close.
 return start.day<current.day||(start.day===current.day&&current.minutes>=DAILY_MARKETS[market].close);
}
const validTime=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))
  ?Date.parse(x):null;
const NUM=x=>typeof x==='number'&&Number.isFinite(x);
function candidates(input){
  if(!Array.isArray(input)||input.length===0||input.length>2
    ||input.some(s=>typeof s!=='string'||!/^[A-Z0-9][A-Z0-9.\-]{0,24}$/u.test(s)))
    throw Error('PUBLIC_STOCK_CANDIDATE_SET_INVALID');
  return [...new Set(input)];
}
function refusedForRateLimit(error){
  const x=error instanceof Error?error.message:'';
  return /(?:HTTP_|HTTP-)(?:429|418)(?:[^0-9]|$)/u.test(x)
    ||/PUBLIC_STOCK_RATE_LIMIT/u.test(x);
}
export function inspectPublicStockCandles(rows,timeframe,now=Date.now(),market='US_STOCK'){
  if(!Array.isArray(rows)||rows.length>15000||!NUM(now)||now<=0)
    throw Error('PUBLIC_STOCK_SOURCE_SHAPE_INVALID');
  const duration=DURATIONS[timeframe]??null;
  let bad=0,duplicate=0,conflicting=0,unfinished=0;
  const map=new Map();
  for(const item of rows){
    const at=validTime(item?.time);
    const values=['open','high','low','close','volume'].map(k=>item?.[k]);
    if(at===null||at<=0||at>now+5*60000
      ||!values.every(NUM)||values.slice(0,4).some(x=>x<=0)
      ||values[4]<0||item.high<Math.max(item.open,item.close,item.low)
      ||item.low>Math.min(item.open,item.close,item.high)){
      bad++;continue;
    }
    if((timeframe==='1D'&&!closedDaily(at,now,market))||(duration!==null&&at+duration>now)){
      unfinished++;continue;
    }
    const row={time:new Date(at).toISOString(),open:item.open,high:item.high,
      low:item.low,close:item.close,volume:item.volume};
    const old=map.get(at);
    if(old){
      if(['open','high','low','close','volume'].every(k=>old[k]===row[k]))duplicate++;
      else conflicting++;
      continue;
    }
    map.set(at,row);
  }
  const rejected=bad>0||conflicting>0;
  const candles=rejected?[]:[...map.values()].sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
  return Object.freeze({
    candles:Object.freeze(candles.map(x=>Object.freeze(x))),
    rejected,malformedBars:bad,conflictingDuplicateBars:conflicting,
    identicalDuplicateBars:duplicate,incompleteBarsExcluded:unfinished,
    originalBars:rows.length,fullUniverseVerified:false,
    executionAuthority:'NONE',
  });
}
export async function choosePublicStockCandles({
  symbols,timeframe,market='US_STOCK',load,onSource=()=>{},onError=()=>{},
  now=Date.now(),preferAtLeast=20,
}={}){
  const list=candidates(symbols);
  if(typeof load!=='function'||typeof onSource!=='function'
    ||typeof onError!=='function'||!NUM(now)||now<=0
    ||!Number.isInteger(preferAtLeast)||preferAtLeast<1||preferAtLeast>200)
    throw Error('PUBLIC_STOCK_CANDLE_SELECTOR_INPUT_INVALID');
  let best=[],failures=0,observed=0;
  // At most one Yahoo call per candidate: the provider itself already hedges
  // two hosts. Avoid the old 3x repeated public 429/418 request storm.
  for(const symbol of list){
    let rows;
    try {rows=await load(symbol,timeframe);}
    catch(error){
      onError(error);failures++;
      if(refusedForRateLimit(error))
        throw Error('PUBLIC_STOCK_RATE_LIMIT_FAIL_CLOSED');
      continue;
    }
    if(!Array.isArray(rows)){onError(Error('PUBLIC_STOCK_BAD_SOURCE_SHAPE'));failures++;continue;}
    observed++;onSource(rows);
    const result=inspectPublicStockCandles(rows,timeframe,now,market);
    if(result.rejected)continue;
    if(result.candles.length>best.length)best=result.candles;
    if(best.length>=preferAtLeast)break;
  }
  // If the only observed source data was malformed, the scanner receives []
  // and records missing/insufficient candles, never a fabricated candidate.
  if(!observed&&failures)
    throw Error('PUBLIC_STOCK_PROVIDER_UNAVAILABLE');
  return best;
}
export async function choosePublicStockQuote({
  symbols,timeframe='1D',load,onSource=()=>{},onError=()=>{},now=Date.now(),
}={}){
  const list=candidates(symbols);
  if(typeof load!=='function'||typeof onSource!=='function'
    ||typeof onError!=='function'||!NUM(now)||now<=0)
    throw Error('PUBLIC_STOCK_QUOTE_SELECTOR_INPUT_INVALID');
  const maxQuoteAge=timeframe==='1D'?5*86400000:2*3600000;
  let errors=0,badPrices=0;
  for(const symbol of list){
    let quote;
    try{quote=await load(symbol);}
    catch(error){
      onError(error);errors++;
      if(refusedForRateLimit(error))
        throw Error('PUBLIC_STOCK_RATE_LIMIT_FAIL_CLOSED');
      continue;
    }
    onSource(quote);
    const price=quote?.price;
    const date=quote?.updatedAt==null?null:validTime(quote.updatedAt);
    if(NUM(price)&&price>0
      &&date!==null&&date<=now+300000&&now-date<=maxQuoteAge)
      return quote;
    badPrices++;
  }
  if(errors&&!badPrices)throw Error('PUBLIC_STOCK_QUOTE_PROVIDER_UNAVAILABLE');
  throw Error('PUBLIC_STOCK_QUOTE_UNTRUSTED');
}
