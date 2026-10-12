/** Isolated, pure Upbit Signal V3 candle adapter.
 * candle_date_time_utc is UTC bar START; timestamp is last-trade tick.
 * No public HTTP call, shared-member/Paper code edit or order authority.
 */
const spans=Object.freeze({'1m':60000,'3m':180000,'5m':300000,
  '15m':900000,'60m':3600000,'4H':14400000,'1D':86400000});
const utc=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u;
const symbolPattern=/^[A-Z0-9._-]{1,64}$/u;
const price=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;
const quantity=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
export function normalizeV3UpbitCandles(rows,{symbol,timeframe,nowMs}={}){
  const width=spans[timeframe];
  if(!Array.isArray(rows)||rows.length>200
    ||!symbolPattern.test(symbol??'')||!width
    ||!Number.isSafeInteger(nowMs)||nowMs<=0)
    throw Error('V3_UPBIT_INVALID_INPUT');
  const seen=new Set(),candles=[];
  for(const row of rows){
    if(!row||row.market!=='KRW-'+symbol
      ||typeof row.candle_date_time_utc!=='string'
      ||!utc.test(row.candle_date_time_utc))
      throw Error('V3_UPBIT_INVALID_IDENTITY');
    const ms=Date.parse(row.candle_date_time_utc+'Z');
    if(!Number.isSafeInteger(ms)||ms<=0||ms>nowMs||ms%width!==0
      ||new Date(ms).toISOString().slice(0,19)!==row.candle_date_time_utc
      ||seen.has(ms))
      throw Error('V3_UPBIT_INVALID_CANDLE_TIME');
    seen.add(ms);
    const o=row.opening_price,h=row.high_price,l=row.low_price,c=row.trade_price;
    const vol=row.candle_acc_trade_volume,q=row.candle_acc_trade_price;
    if(![o,h,l,c].every(price)||h<Math.max(o,l,c)||l>Math.min(o,h,c)
      ||!quantity(vol)||!(q==null||quantity(q)))
      throw Error('V3_UPBIT_INVALID_OHLC');
    // Never treat an actively forming candle as finalized evidence.
    if(ms+width>nowMs)continue;
    candles.push({time:ms,open:o,high:h,low:l,close:c,
      volume:vol,quoteVolume:q??null});
  }
  return candles.sort((a,b)=>a.time-b.time);
}
