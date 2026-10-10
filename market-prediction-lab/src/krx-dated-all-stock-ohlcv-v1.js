import {createHash} from "node:crypto";

/**
 * KRX authorized (NOT brokerage/private order) date-scoped equity OHLCV
 * adapter for KOSPI, KOSDAQ and KONEX on the same historical trading date.
 *
 * Reuses the output of collectKrxDatedRosterV1. It does NOT promote an
 * arbitrary/current stock catalog, dated provider OHLC, or a synthetic
 * previous day into full-market PIT returns. All issued symbol IDs (not
 * merely preselected winner names) are cross-checked before any scoring.
 *
 * Access requires a caller-supplied approved KRX market-data AUTH_KEY.
 * The key is never read from process.env, retained, or echoed in reports.
 * KRX prior trading session and unadjusted corporate actions are not yet
 * canonicalized. No key => zero network calls.
 */
const BOARDS=Object.freeze({
  KOSPI:"/svc/apis/sto/stk_bydd_trd",
  KOSDAQ:"/svc/apis/sto/ksq_bydd_trd",
  KONEX:"/svc/apis/sto/knx_bydd_trd",
});
const BOARD_NAMES=Object.keys(BOARDS);
const SHA=/^[a-f0-9]{64}$/;
const SHORT=/^[A-Z0-9]{6}$/;
const ISIN=/^[A-Z0-9]{12}$/;
const YMD=/^\d{8}$/;
const dayValid=d=>{
  if(typeof d!=="string"||!YMD.test(d))return false;
  const t=Date.parse(d.slice(0,4)+"-"+d.slice(4,6)+"-"+d.slice(6)+"T00:00:00.000Z");
  return Number.isSafeInteger(t)&&new Date(t).toISOString().slice(0,10).replace(/-/g,"")===d;
};
const digest=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const parseNum=value=>{
  const str=String(value??"").trim();
  if(!/^(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?$/.test(str))return null;
  const n=Number(str.replaceAll(",",""));
  return Number.isFinite(n)&&n>=0?n:null;
};
const safe=(dateYmd,reason,extra={})=>Object.freeze({
  schemaVersion:"krx-authorized-full-three-board-date-ohlcv-v1",
  market:"KR_STOCK",venue:"KRX",dateYmd,
  status:"BLOCKED_DATA",reason,marketDataGETOnly:true,
  sourceKeyPersisted:false,sourceKeyInMemoryOnly:true,
  requestedMarketBoards:Object.freeze([...BOARD_NAMES]),
  requestedBoardQuoteGETs:0,
  observedDatedRosterSymbols:null,
  observedQuoteRows:null,observedUsableDailyBars:null,
  rows:null,missingRosterSymbols:null,untradedSymbols:null,
  sourceDailyRowsSha256:null,datedRosterSha256:null,
  predecessorTradingSessionVerified:false,
  corporateActionsAdjustedAndVerified:false,
  independentlyCompleteHistoricalPITPopulationVerified:false,
  fullMarketOpportunityDenominatorVerified:false,
  historicalScannerAsOfCaptureVerified:false,
  trueMarketWideRecall:null,actualMarketWideOpportunityCount:null,
  actualFillCount:null,netProfitPct:null,
  OOSPassCount:0,profitabilityProven:false,
  executionAuthority:"NONE",liveTrading:false,autoTrading:false,
  realOrders:false,privateBrokerAPI:false,
  ...extra,
});
const blocked=(date,reason,extra={})=>safe(date,reason,extra);
export const KRX_DATED_ALL_STOCK_PRICE_POLICY_V1=Object.freeze({
  boards:Object.freeze([...BOARD_NAMES]),
  maxRequests:3,minGapMs:150,maxSourceRowsPerBoard:10000,
  noReadOnlyKeyNoRequests:true,
  priorTradingSessionVerified:false,
  corpActionsVerified:false,
});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function rosterOk(source,date){
  if(source?.schemaVersion!=="krx-public-dated-security-roster-v1"
     ||source?.status!=="OBSERVED_KRX_DAY_ROSTER_ONLY"
     ||source.dateYmd!==date||source.executionAuthority!=="NONE"
     ||source.delistedHistoryVerified!==false
     ||source.entireDatePITUniverseProven!==false
     ||source.realOrders!==false
     ||!SHA.test(source.sourceSha256??"")
     ||!Array.isArray(source.symbols)||source.symbols.length<3
     ||source.symbols.length>30000
     ||source.dateScopedSymbolCount!==source.symbols.length
     ||!source.markets||Object.keys(source.markets).length!==3
     ||BOARD_NAMES.some(x=>!Number.isSafeInteger(source.markets[x])
       ||source.markets[x]<1)
     ||BOARD_NAMES.reduce((s,x)=>s+source.markets[x],0)!==source.symbols.length
     ||source.sourceSha256!==digest({
        dateYmd:date,markets:source.markets,symbols:source.symbols,
       }))
    return false;
  const short=new Set(),isin=new Set(),counts={KOSPI:0,KOSDAQ:0,KONEX:0};
  for(const row of source.symbols){
    if(!BOARD_NAMES.includes(row?.marketBoard)||!SHORT.test(row.shortCode??"")
       ||!ISIN.test(row.isin??"")||short.has(row.shortCode)
       ||isin.has(row.isin)||!dayValid(row.listedYmd)||row.listedYmd>date)
      return false;
    short.add(row.shortCode);isin.add(row.isin);counts[row.marketBoard]++;
  }
  return BOARD_NAMES.every(b=>counts[b]===source.markets[b]);
}
export async function collectKrxThreeBoardDatedOHLCV1({
  dateYmd,datedRoster=null,authKey=null,
  fetchImpl=globalThis.fetch,sleepImpl=sleep,minGapMs=150,
}={}){
  if(!dayValid(dateYmd)||dateYmd<"20130701")
    throw new TypeError("KRX_OHLC_DATE_INVALID");
  if(typeof fetchImpl!=="function"||typeof sleepImpl!=="function"
     ||!Number.isInteger(minGapMs)||minGapMs<150||minGapMs>2000)
    throw new TypeError("KRX_OHLC_IO_POLICY_INVALID");
  if(!rosterOk(datedRoster,dateYmd))
    return blocked(dateYmd,"KRX_DATED_THREE_BOARD_ROSTER_NOT_ATTESTED");
  if(typeof authKey!=="string"||!authKey.trim())
    return blocked(dateYmd,"KRX_OHLC_MARKET_DATA_AUTH_REQUIRED");
  if(authKey.length>256)throw new TypeError("KRX_OHLC_AUTH_KEY_INVALID");
  const rosterByBoard=new Map(BOARD_NAMES.map(b=>[b,new Map()]));
  const rosterByISIN=new Map(BOARD_NAMES.map(b=>[b,new Map()]));
  for(const r of datedRoster.symbols){
    rosterByBoard.get(r.marketBoard).set(r.shortCode,r);
    rosterByISIN.get(r.marketBoard).set(r.isin,r);
  }
  const rows=[],untraded=[],orphan=[],duplicates=[],seen=new Set();
  const boardReceived={};let calls=0;
  for(const board of BOARD_NAMES){
    if(calls>0)await sleepImpl(minGapMs);
    const url="https://data-dbg.krx.co.kr"+BOARDS[board]+"?basDd="+dateYmd;
    let response,json;
    calls++;
    try{
      response=await fetchImpl(url,{
        method:"GET",
        headers:{AUTH_KEY:authKey.trim(),Accept:"application/json"},
        signal:AbortSignal.timeout(12000),
      });
      if(!response?.ok)
        return blocked(dateYmd,"KRX_DAILY_QUOTE_HTTP_BLOCKED",{
          requestedBoardQuoteGETs:calls,
          blockedBoard:board,httpStatus:Number.isInteger(response?.status)?
            response.status:null,
        });
      json=await response.json();
    }catch{
      return blocked(dateYmd,"KRX_DAILY_QUOTE_SOURCE_UNAVAILABLE",{
        requestedBoardQuoteGETs:calls,blockedBoard:board,
      });
    }
    const data=json?.OutBlock_1;
    if(!Array.isArray(data)||data.length<1||data.length>10000)
      return blocked(dateYmd,"KRX_DAILY_QUOTE_BOARD_ROWS_INVALID",{
        requestedBoardQuoteGETs:calls,blockedBoard:board,
      });
    boardReceived[board]=data.length;
    for(const [index,r] of data.entries()){
      const rawCode=String(r?.ISU_CD??"").trim().toUpperCase();
      const record=rosterByBoard.get(board).get(rawCode)
        ??rosterByISIN.get(board).get(rawCode);
      const day=String(r?.BAS_DD??"").trim();
      if(day!==dateYmd||(!SHORT.test(rawCode)&&!ISIN.test(rawCode)))
        return blocked(dateYmd,"KRX_DAILY_QUOTE_DATE_OR_CODE_INVALID",{
          requestedBoardQuoteGETs:calls,blockedBoard:board,
          badRowIndex:index,
        });
      if(!record){orphan.push({board,code:rawCode});continue;}
      const unique=record.shortCode;
      if(seen.has(unique)){duplicates.push(unique);continue;}
      seen.add(unique);
      const open=parseNum(r.TDD_OPNPRC),
        high=parseNum(r.TDD_HGPRC),low=parseNum(r.TDD_LWPRC),
        close=parseNum(r.TDD_CLSPRC),volume=parseNum(r.ACC_TRDVOL),
        turnover=parseNum(r.ACC_TRDVAL);
      if(open==null||high==null||low==null||close==null
         ||volume==null||volume===0||turnover==null
         ||open===0||high===0||low===0||close===0){
        untraded.push(unique);continue;
      }
      if(high<Math.max(open,close)||low>Math.min(open,close)||high<low)
        return blocked(dateYmd,"KRX_DAILY_QUOTE_OHLC_INVALID",{
          requestedBoardQuoteGETs:calls,blockedBoard:board,
          badRowIndex:index,
        });
      rows.push(Object.freeze({
        market:"KR_STOCK",venue:"KRX",dateYmd,
        marketBoard:board,symbol:unique,isin:record.isin,
        open,high,low,close,volume,turnover,
        priceSource:"KRX_OFFICIAL_DATED_TRADING_INFO",
      }));
    }
  }
  if(orphan.length||duplicates.length)
    return blocked(dateYmd,"KRX_DATED_ROSTER_AND_QUOTES_IDENTITY_CONFLICT",{
      requestedBoardQuoteGETs:calls,
      orphanQuoteSymbolsPreview:orphan.slice(0,12),
      duplicateQuoteSymbolsPreview:duplicates.slice(0,12),
      sourceKeyPersisted:false,
    });
  const missing=datedRoster.symbols.filter(r=>!seen.has(r.shortCode))
    .map(r=>r.shortCode);
  const complete=missing.length===0&&untraded.length===0
    &&rows.length===datedRoster.symbols.length;
  rows.sort((a,b)=>a.symbol.localeCompare(b.symbol));
  const body={
    dateYmd,rosterSha256:datedRoster.sourceSha256,
    boardReceived,rows,
  };
  return safe(dateYmd,complete?"DATED_ROSTER_AND_OHLCV_MATCHED_NO_HISTORIC_PIT_PROOF":
    "MISSING_LISTED_QUOTE_OR_NONTRADED_SECURITY",{
    status:complete?"SOURCE_LIMITED_DATED_QUOTES_MATCHED_ONLY":
      "PARTIAL_DATED_QUOTES_BLOCKED",
    requestedBoardQuoteGETs:calls,
    observedDatedRosterSymbols:datedRoster.symbols.length,
    observedQuoteRows:Object.values(boardReceived).reduce((s,x)=>s+x,0),
    observedUsableDailyBars:rows.length,
    boardsReturnedRows:boardReceived,rows:Object.freeze(rows),
    untradedSymbols:Object.freeze(untraded.sort()),
    missingRosterSymbols:Object.freeze(missing.sort()),
    sourceDailyRowsSha256:digest(body),
    datedRosterSha256:datedRoster.sourceSha256,
    // This daily KRX OHLC is NOT an authenticated previous-trading-session
    // price or a corporate-action-adjusted return, and is NOT a prospective
    // scanner watchlist captured at that historical moment.
    independentlyCompleteHistoricalPITPopulationVerified:false,
    predecessorTradingSessionVerified:false,
    corporateActionsAdjustedAndVerified:false,
    fullMarketOpportunityDenominatorVerified:false,
    trueMarketWideRecall:null,
    profitabilityProven:false,
  });
}
