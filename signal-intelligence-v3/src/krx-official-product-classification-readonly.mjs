/**
 * Optional KRX-approved official ETP daily subtype lookup.
 * NEVER invoked by current public scanner; explicit enabled=true AND a
 * per-service approved AUTH_KEY are needed before this makes 3 GETs.
 * Public classification only, no private brokerage, account or order API.
 */
const ROOT='https://data-dbg.krx.co.kr/svc/apis/etp/';
const SERVICES=Object.freeze([
  ['ETF','etf_bydd_trd'],['ETN','etn_bydd_trd'],['ELW','elw_bydd_trd'],
]);
const CODE=/^[A-Z0-9]{6}$/u;
const DAY=/^\d{8}$/u;
const ISSUES=Object.freeze(['ETF','ETN','ELW']);
function safeResult(status,date,counts,lookup=null){
  const publicResult={status,date,source:'KRX_OFFICIAL_OPENAPI',
    marketsCovered:['ETF','ETN','ELW'],
    counts:Object.freeze({...counts}),
    subtypeProofScope:'ONE_APPROVED_TRADING_DATE_ONLY',
    dataIsIntraday:false,fullKrxRosterVerified:false,
    economicAuthority:'NONE',providerRequestsAdded:status==='DATE_EVIDENCE_READY'?3:0,
  };
  // In-memory closure: returned JSON must never expose issuer names,
  // listing codes or credential headers in downstream sanitized reports.
  return Object.freeze({...publicResult,
    classify(ticker){
      const token=String(ticker??'').trim().toUpperCase();
      return CODE.test(token)?lookup?.get(token)??'UNKNOWN':'UNKNOWN';
    },
  });
}
function emptyCounts(){return {ETF:0,ETN:0,ELW:0,CONFLICT:0,UNSUPPORTED_CODE:0};}
function isApprovedDate(day){
  if(typeof day!=='string'||!DAY.test(day))return false;
  const y=Number(day.slice(0,4)),m=Number(day.slice(4,6)),d=Number(day.slice(6,8));
  const check=new Date(Date.UTC(y,m-1,d));
  return y>=2010&&y<=2100&&check.getUTCFullYear()===y
    &&check.getUTCMonth()===m-1&&check.getUTCDate()===d;
}
export async function readApprovedKrxEtpSubtypes({
  enabled=false,date,authKey,fetchImpl=fetch,
  maxResponseBytes=2_000_000,
}={}){
  const counts=emptyCounts();
  if(enabled!==true)return safeResult('DISABLED',null,counts);
  if(!isApprovedDate(date))return safeResult('INVALID_DATE',null,counts);
  if(typeof authKey!=='string'||!/^[a-zA-Z0-9]{20,128}$/u.test(authKey))
    return safeResult('AUTHORIZATION_REQUIRED',date,counts);
  if(typeof fetchImpl!=='function'||!Number.isSafeInteger(maxResponseBytes)
    ||maxResponseBytes<1000||maxResponseBytes>4_000_000)
    return safeResult('INVALID_READONLY_CONFIGURATION',date,counts);
  const classifications=new Map();
  for(const [category,apiId] of SERVICES){
    const ctrl=new AbortController();
    const timeout=setTimeout(()=>ctrl.abort(),7000);
    try{
      const response=await fetchImpl(ROOT+apiId+'?basDd='+date,{
        method:'GET',redirect:'error',signal:ctrl.signal,
        headers:{'AUTH_KEY':authKey,'Accept':'application/json'},
      });
      if(response?.ok!==true)return safeResult('PROVIDER_HTTP_ERROR',date,emptyCounts());
      // text+length bound, and not res.json, to avoid unbounded bodies.
      const declared=Number(response.headers?.get?.('content-length')??0);
      if(!Number.isFinite(declared)||declared>maxResponseBytes)
        return safeResult('PROVIDER_DATA_INVALID',date,emptyCounts());
      const data=await response.text();
      if(typeof data!=='string'||data.length>maxResponseBytes)
        return safeResult('PROVIDER_DATA_INVALID',date,emptyCounts());
      let envelope;
      try{envelope=JSON.parse(data);}catch{
        return safeResult('PROVIDER_DATA_INVALID',date,emptyCounts());
      }
      if(!Array.isArray(envelope?.OutBlock_1)||envelope.OutBlock_1.length>30000)
        return safeResult('PROVIDER_DATA_INVALID',date,emptyCounts());
      const pageCodes=new Set();
      for(const row of envelope.OutBlock_1){
        const code=String(row?.ISU_CD??'').trim().toUpperCase();
        if(!CODE.test(code)){counts.UNSUPPORTED_CODE+=1;continue;}
        if(row?.BAS_DD!==date||pageCodes.has(code))
          return safeResult('PROVIDER_DATA_INVALID',date,emptyCounts());
        pageCodes.add(code);
        const prior=classifications.get(code);
        if(prior && prior!==category){
          counts.CONFLICT+=1;classifications.set(code,'CONFLICT');
        }else if(!prior){
          counts[category]+=1;classifications.set(code,category);
        }
      }
    }catch{
      return safeResult('PROVIDER_REQUEST_FAILED',date,emptyCounts());
    }finally{clearTimeout(timeout);}
  }
  return safeResult('DATE_EVIDENCE_READY',date,counts,classifications);
}
/** Reconcile publicly listed but scanner-excluded products with ONE dated
 * official snapshot. Nonmatches are not delisted, supported or tradable.
 */
export function reconcileExcludedKrxProducts(exclusions,evidence){
  const rows=Array.isArray(exclusions)?exclusions:[];
  const counts={ETF:0,ETN:0,ELW:0,UNKNOWN:0,CONFLICT:0,STOCK_FINDER:0};
  for(const row of rows){
    if(row?.exchange!=='ETF·ETN'){counts.STOCK_FINDER+=1;continue;}
    const kind=evidence?.status==='DATE_EVIDENCE_READY'
      ?evidence.classify(row?.ticker):'UNKNOWN';
    if(ISSUES.includes(kind))counts[kind]+=1;
    else if(kind==='CONFLICT')counts.CONFLICT+=1;
    else counts.UNKNOWN+=1;
  }
  return Object.freeze({status:evidence?.status==='DATE_EVIDENCE_READY'
    ?'DATE_ONLY_NOT_TRADING_PROOF':'AUTHORIZATION_OR_EVIDENCE_MISSING',
    counts:Object.freeze(counts),rosterComplete:false,
    realTimeFeedAuthorized:false,sourceAuthorityForOrders:'NONE'});
}
