/** Only exchange quotation GETs, no account/order/private endpoints. */
const SPOT=new Map([
 ['/v1/market/all',new Set(['isDetails'])],
 ['/v1/ticker',new Set(['markets'])],
 ['/v1/orderbook',new Set(['markets','level'])],
 ['/v1/candles/days',new Set(['market','count'])],
]);
const FUTURES=new Map([
 ['/api/v2/mix/market/tickers',new Set(['productType'])],
 ['/api/v2/mix/market/contracts',new Set(['productType'])],
 ['/api/v2/mix/market/candles',new Set(['productType','symbol','granularity','limit'])],
]);
export function validV3PublicPriorityRequest(rawUrl,market,method='GET'){
 let url;
 try{url=new URL(rawUrl);}catch{return false;}
 if(method!=='GET'||!['spot','futures'].includes(market)
   ||url.protocol!=='https:'||url.port||url.username||url.password||url.hash
   ||url.hostname!==(market==='spot'?'api.upbit.com':'api.bitget.com'))
   return false;
 const allowed=market==='spot'?SPOT:FUTURES;
 const keys=market==='spot'
   &&/^\/v1\/candles\/minutes\/(?:1|3|5|15|60|240)$/u.test(url.pathname)
     ?new Set(['market','count']):allowed.get(url.pathname);
 if(!keys)return false;
 const params=[...url.searchParams.keys()];
 return params.length>0&&params.length<=keys.size
   &&new Set(params).size===params.length&&params.every(k=>keys.has(k))
   &&[...url.searchParams.values()].every(v=>v.length>0&&v.length<=2048);
}
