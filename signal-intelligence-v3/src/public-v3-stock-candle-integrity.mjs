/**
 * Pure, public-only V3 Yahoo candle source verification.
 * Only bounded issue codes cross the diagnostic boundary; never disclose
 * provider payloads, tickers, OHLCV, URLs, user data or raw errors.
 * No synthetic bars or weakening of downstream gap, OOS or cost gates.
 */
const ISO_WITH_OFFSET=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
const positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;
const outcome=(valid,reason)=>Object.freeze({valid,reason});
export const V3_PUBLIC_YAHOO_SOURCE_REASONS=Object.freeze([
 'NOT_ARRAY','EMPTY_PAGE','PAGE_TOO_LARGE','CLOCK_INVALID',
 'BAR_INVALID','TIMESTAMP_FORMAT','TIMESTAMP_INVALID',
 'TIMESTAMP_DUPLICATE','TIMESTAMP_REVERSED','FUTURE_TIMESTAMP',
 'PRICE_INVALID','OHLC_INCONSISTENT','VOLUME_INVALID',
]);
export function inspectV3PublicYahooCandlePage(rows,{nowMs=Date.now()}={}){
 if(!Array.isArray(rows))return outcome(false,'NOT_ARRAY');
 if(rows.length<1)return outcome(false,'EMPTY_PAGE');
 if(rows.length>16000)return outcome(false,'PAGE_TOO_LARGE');
 if(!Number.isSafeInteger(nowMs)||nowMs<=0)return outcome(false,'CLOCK_INVALID');
 let previous=0;
 for(const bar of rows){
  if(!bar||typeof bar!=='object'||Array.isArray(bar))
   return outcome(false,'BAR_INVALID');
  if(typeof bar.time!=='string'||!ISO_WITH_OFFSET.test(bar.time))
   return outcome(false,'TIMESTAMP_FORMAT');
  const at=Date.parse(bar.time);
  if(!Number.isSafeInteger(at)||at<=0)
   return outcome(false,'TIMESTAMP_INVALID');
  if(at===previous)return outcome(false,'TIMESTAMP_DUPLICATE');
  if(at<previous)return outcome(false,'TIMESTAMP_REVERSED');
  if(at>nowMs+5000)return outcome(false,'FUTURE_TIMESTAMP');
  const {open,high,low,close,volume}=bar;
  if(![open,high,low,close].every(positive))
   return outcome(false,'PRICE_INVALID');
  if(high<Math.max(open,low,close)||low>Math.min(open,high,close))
   return outcome(false,'OHLC_INCONSISTENT');
  if(typeof volume!=='number'||!Number.isFinite(volume)||volume<0)
   return outcome(false,'VOLUME_INVALID');
  previous=at;
 }
 return outcome(true,'READY');
}
export function validV3PublicYahooCandlePage(rows,options={}){
 return inspectV3PublicYahooCandlePage(rows,options).valid;
}
