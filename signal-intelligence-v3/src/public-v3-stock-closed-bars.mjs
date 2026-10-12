/**
 * Signal V3 public Yahoo *closed bar* selector. Strict source check must run
 * AFTER this operation; no fake OHLCV or missing-interval interpolation.
 * Remove only an actual trailing in-progress bar from a listed stock.
 */
const SETTINGS=Object.freeze({
  KR_STOCK:{zone:'Asia/Seoul',regularClose:15*60+30},
  US_STOCK:{zone:'America/New_York',regularClose:16*60},
});
const INTRADAY=Object.freeze({'1m':60000,'3m':180000,'5m':300000,
  '15m':900000,'30m':1800000,'60m':3600000,'1H':3600000});
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
const locale=Object.fromEntries(Object.entries(SETTINGS).map(([m,c])=>[m,
 new Intl.DateTimeFormat('en-US',{timeZone:c.zone,hourCycle:'h23',
  year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})]));
function clock(when,market){
 const pieces=Object.fromEntries(locale[market].formatToParts(new Date(when))
   .filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
 return {day:[pieces.year,pieces.month,pieces.day].join('-'),
  minute:Number(pieces.hour)*60+Number(pieces.minute)};
}
export function selectClosedV3PublicStockBars(rows,{
 market,timeframe,nowMs=Date.now(),
}={}){
 if(!SETTINGS[market]||!Number.isSafeInteger(nowMs)||nowMs<=0)
   throw Error('V3_PUBLIC_STOCK_CLOSED_BAR_CONFIG_INVALID');
 if(!Array.isArray(rows)||rows.length===0)return rows;
 if(rows.length>16000)return rows; // validator must reject oversized source
 let last=rows.length;
 const current=timeframe==='1D'?clock(nowMs,market):null;
 while(last>0){
   const bar=rows[last-1],stamp=bar?.time;
   if(typeof stamp!=='string'||!ISO.test(stamp))break;
   const ms=Date.parse(stamp);
   if(!Number.isSafeInteger(ms)||ms<=0||ms>nowMs+5000)break;
   if(timeframe==='1D'){
     const observed=clock(ms,market);
     if(observed.day===current.day
       &&current.minute<SETTINGS[market].regularClose){last--;continue;}
   }else if(INTRADAY[timeframe]!=null){
     if(ms+INTRADAY[timeframe]>nowMs){last--;continue;}
   }
   break;
 }
 return last===rows.length?rows:rows.slice(0,last);
}
