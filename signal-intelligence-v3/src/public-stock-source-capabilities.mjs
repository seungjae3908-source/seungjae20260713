// Read-only single-source capacity probing. This is NOT a streaming market
// feed, quote authorization, license certification, or full-universe proof.
// Fixed, allowlisted public URLs; no user input, credentials or account reads.
export const PUBLIC_SOURCE_CAPABILITY_SCHEMA='public-stock-source-capabilities-v1';
const TARGETS=Object.freeze([
  Object.freeze({id:'KR_ALPHA_PRICE',provider:'naver-public',timeframe:'QUOTE',
    url:'https://stock.naver.com/api/domestic/detail/0193W0/price'}),
  Object.freeze({id:'KR_ALPHA_DAILY',provider:'naver-public',timeframe:'DAY_VIEW',
    url:'https://stock.naver.com/api/securityService/chart/domestic/item/0193W0?periodType=day'}),
  Object.freeze({id:'KR_NUMERIC_DAILY',provider:'naver-public',timeframe:'DAY_VIEW',
    url:'https://stock.naver.com/api/securityService/chart/domestic/item/005930?periodType=day'}),
  Object.freeze({id:'KR_ALPHA_WEEK_VIEW',provider:'naver-public',timeframe:'WEEK_VIEW',
    url:'https://stock.naver.com/api/securityService/chart/domestic/item/0193W0?periodType=week'}),
  Object.freeze({id:'KR_ALPHA_MONTH_VIEW',provider:'naver-public',timeframe:'MONTH_VIEW',
    url:'https://stock.naver.com/api/securityService/chart/domestic/item/0193W0?periodType=month'}),
  Object.freeze({id:'KR_ALPHA_YEAR_VIEW',provider:'naver-public',timeframe:'YEAR_VIEW',
    url:'https://stock.naver.com/api/securityService/chart/domestic/item/0193W0?periodType=year'}),
  Object.freeze({id:'KR_ALPHA_DAILY_HISTORY',provider:'naver-public',timeframe:'HISTORICAL_DAILY',
    url:'https://stock.naver.com/api/stockSecurity/items/v2/domestic/0193W0/daily-prices?size=80'}),
  Object.freeze({id:'KR_ALPHA_DAY_CANDLE',provider:'naver-public',timeframe:'1D',
    url:'https://api.stock.naver.com/chart/domestic/item/0193W0?periodType=dayCandle'}),
  Object.freeze({id:'KR_NUMERIC_DAY_CANDLE',provider:'naver-public',timeframe:'1D',
    url:'https://api.stock.naver.com/chart/domestic/item/005930?periodType=dayCandle'}),
  Object.freeze({id:'US_AAPL_5M',provider:'yahoo-public',timeframe:'5m',
    url:'https://query2.finance.yahoo.com/v8/finance/chart/AAPL?range=1mo&interval=5m'}),
  Object.freeze({id:'US_AAPL_60M',provider:'yahoo-public',timeframe:'60m',
    url:'https://query2.finance.yahoo.com/v8/finance/chart/AAPL?range=3mo&interval=60m'}),
]);
function probeKeys(payload) {
  if(!payload||typeof payload!=='object'||Array.isArray(payload))return [];
  return Object.keys(payload).filter(x=>/^[A-Za-z][A-Za-z0-9_]{0,45}$/u.test(x)).slice(0,20).sort();
}
export function summarizePublicProbePayload(id,payload) {
  if(!TARGETS.some(x=>x.id===id))throw new Error('PUBLIC_SOURCE_PROBE_TARGET_UNLISTED');
  const obj=payload&&typeof payload==='object'&&!Array.isArray(payload)?payload:null;
  const quote=id==='KR_ALPHA_PRICE';
  const chart=['KR_ALPHA_DAILY','KR_NUMERIC_DAILY','KR_ALPHA_WEEK_VIEW','KR_ALPHA_MONTH_VIEW',
    'KR_ALPHA_YEAR_VIEW','KR_ALPHA_DAY_CANDLE','KR_NUMERIC_DAY_CANDLE'].includes(id);
  const yahoo=id.startsWith('US_');
  const infos=Array.isArray(obj?.priceInfos)?obj.priceInfos:null;
  const result=Array.isArray(obj?.chart?.result)?obj.chart.result[0]:null;
  const stamps=Array.isArray(result?.timestamp)?result.timestamp:[];
  const quotes=Array.isArray(result?.indicators?.quote)?result.indicators.quote[0]:null;
  const firstInfo=infos?.find(row=>row&&typeof row==='object'&&!Array.isArray(row))??null;
  const distinctTradingDates=chart&&infos
    ?new Set(infos.map(row=>String(row?.localDateTime??row?.localDate??'').slice(0,8))
      .filter(x=>/^[0-9]{8}$/u.test(x))).size:null;
  const closes=Array.isArray(quotes?.close)?quotes.close.filter(v=>Number.isFinite(v)&&v>0):[];
  const hasPrice=quote&&['nowPrice','closePrice','price'].some(k=>
    typeof obj?.[k]==='number'||(typeof obj?.[k]==='string'&&obj[k].length>0));
  const sufficient=chart?Boolean(infos&&infos.length>0):yahoo?stamps.length>0&&closes.length>0:hasPrice;
  const latest=stamps.length?Number(stamps.at(-1))*1000:null;
  return Object.freeze({
    id, payloadJsonObject:obj!==null,rootKeys:probeKeys(obj),
    firstDailyRowKeys:chart?probeKeys(firstInfo):[],
    distinctTradingDates,
    dailyTimestampFormat:chart?(typeof firstInfo?.localDateTime==='number'?'number'
      :typeof firstInfo?.localDateTime==='string'
        ? /^\d{8}$/u.test(firstInfo.localDateTime)?'yyyymmdd'
          : /^\d{12}$/u.test(firstInfo.localDateTime)?'yyyymmddhhmm'
          : /^\d{14}$/u.test(firstInfo.localDateTime)?'yyyymmddhhmmss'
          : /^\d{4}-\d{2}-\d{2}/u.test(firstInfo.localDateTime)?'iso_or_date'
          :'other_string'
        :'absent'):null,
    dailyValueTypes:chart&&firstInfo?Object.freeze(Object.fromEntries(
      ['currentPrice','openPrice','highPrice','lowPrice','accumulatedTradingVolume'].map(k=>[k,typeof firstInfo[k]])
    )):null,
    discoveredCount:chart?(infos?.length??null):yahoo?closes.length:null,
    hasPriceBoolean:quote?Boolean(hasPrice):null,
    latestTimestampValid:yahoo?Number.isFinite(latest)&&latest>0&&latest<=Date.now()+300000:null,
    hasRecognizableShape:Boolean(sufficient),
    // A publicly readable UI response does not give bulk-redistribution rights.
    licensedFullMarketAuthority:false,
  });
}
export async function probePublicStockSources({
  fetchImpl=(...args)=>globalThis.fetch(...args),
  timeoutMs=5000,
}={}) {
  if(typeof fetchImpl!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<500||timeoutMs>15000)
    throw new Error('PUBLIC_SOURCE_PROBE_INPUT_INVALID');
  const outcomes=[];
  for(const target of TARGETS){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(new Error('PUBLIC_SOURCE_PROBE_DEADLINE')),timeoutMs);
    try{
      const url=new URL(target.url);
      if(url.protocol!=='https:'||!['stock.naver.com','api.stock.naver.com','query2.finance.yahoo.com'].includes(url.hostname))
        throw new Error('PUBLIC_SOURCE_PROBE_UNSAFE_HOST');
      const response=await fetchImpl(target.url,{signal:controller.signal,headers:{Accept:'application/json'}});
      if(!response||typeof response.status!=='number')throw new Error('PUBLIC_SOURCE_RESPONSE_UNTRUSTED');
      if(!response.ok){
        outcomes.push({id:target.id,provider:target.provider,timeframe:target.timeframe,
          status:'BLOCKED_HTTP',httpStatus:response.status,licensedFullMarketAuthority:false});
        continue;
      }
      const contentType=response.headers?.get?.('content-type')??'';
      if(!contentType.toLowerCase().includes('json'))
        throw new Error('PUBLIC_SOURCE_NONJSON');
      const value=await response.json();
      const evidence=summarizePublicProbePayload(target.id,value);
      outcomes.push({id:target.id,provider:target.provider,timeframe:target.timeframe,
        status:evidence.hasRecognizableShape?'READABLE_SAMPLE_ONLY':'BLOCKED_SCHEMA',
        httpStatus:response.status,...evidence});
    }catch(e){
      const message=e instanceof Error?e.message:'UNKNOWN';
      const code=controller.signal.aborted?'TIMEOUT':
        message==='PUBLIC_SOURCE_NONJSON'?'NONJSON':
        message==='PUBLIC_SOURCE_RESPONSE_UNTRUSTED'?'RESPONSE_INVALID':
        message==='PUBLIC_SOURCE_PROBE_UNSAFE_HOST'?'HOST_INVALID':'NETWORK_ERROR';
      outcomes.push({id:target.id,provider:target.provider,timeframe:target.timeframe,
        status:'BLOCKED_'+code,httpStatus:null,licensedFullMarketAuthority:false});
    }finally{clearTimeout(timer);}
  }
  return Object.freeze({
    schemaVersion:PUBLIC_SOURCE_CAPABILITY_SCHEMA,
    publicOnly:true,executionAuthority:'NONE',
    fullMarketCoverageProven:false,licensedForPublicRedistribution:false,
    samples:Object.freeze(outcomes),
  });
}
