import {createHash} from "node:crypto";
import {isAbsolute,resolve} from "node:path";
import {resolveSelectedResearchWindowV1,UTC_DAY_MS_V1 as DAY} from "./research-selected-window-v1.js";
import {deriveArchivedResearchTimeframesV1} from "./research-minute-archive-v1.js";
import {validateResearchStockSessionsForDateV1} from "./research-minute-archive-window-v1.js";
import {auditHistoricalPITVenueUniverseV1,digestPITMembershipRowsV1} from "./historical-pit-venue-universe-gate-v1.js";

/**
 * Bounded-memory, OFFLINE historical source -> diagnostic strategy replay.
 * Reads only the existing immutable private original 1m archive, ONE session
 * at a time. No network, API keys, account access, orders or Paper callbacks.
 * Replay PnL is a MODELED sanity check, never PASS, confirmed OOS or fills.
 *
 * Importantly, original bars retrieved after the historical signal are NOT
 * retroactively certified as scanner-time available.
 */
const VENUES=Object.freeze({
  KR_STOCK:"KRX",US_STOCK:"US_SIP",
  CRYPTO_SPOT:"UPBIT_KRW",CRYPTO_FUTURES:"BITGET_USDT_FUTURES",
});
const ZONES=Object.freeze({KR_STOCK:"Asia/Seoul",US_STOCK:"America/New_York",
  CRYPTO_SPOT:"UTC",CRYPTO_FUTURES:"UTC"});
const DATES=/^\d{4}-\d{2}-\d{2}$/;
const SHA=/^[a-f0-9]{64}$/;
const SYMBOL=/^[A-Z0-9][A-Z0-9._:-]{0,39}$/;
const FRAMES=new Set(["1m","3m","5m","15m","30m","1h","4h","1d"]);
const STATUS=Object.freeze({
  blocked:"BLOCKED_DATA",source:"RETROSPECTIVE_SOURCE_ONLY_STRATEGY_DIAGNOSTIC",
});
const checksum=v=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const utc=ms=>new Date(ms).toISOString().slice(0,10);
const validCounter=x=>Number.isSafeInteger(x)&&x>=0;
const fail=msg=>{throw new TypeError(msg);};
const safe=extra=>Object.freeze({
  schemaVersion:"four-market-original-minute-replay-v1",
  status:STATUS.blocked,reason:null,
  sourceInventoryOnly:true,
  originalHistoricalScannerAvailabilityVerified:false,
  historicalFullMarketPopulationIndependentlyVerified:false,
  historicalPITUniverseIndependentlyVerified:false,
  officialStockCalendarIndependentlyVerified:false,
  trueMarketWideRecall:null,actualMarketWideOpportunityCount:null,
  actualFillCount:null,netProfitPct:null,OOSPassCount:0,
  paperAdmissionAllowed:false,automaticPaperExecution:false,
  orderSubmitted:false,realOrders:false,privateAccountAPIAllowed:false,
  profitabilityProven:false,executionAuthority:"NONE",
  liveTrading:false,autoTrading:false,...extra,
});
const nonNegRate=x=>typeof x==="number"&&Number.isFinite(x)&&x>=0&&x<0.2;
const integer=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
function normalize(input){
  if(!input||typeof input!=="object"||Array.isArray(input))fail("PRIVATE_REPLAY_ARGS_REQUIRED");
  const {root,market,symbol,stockCalendar=null,manifest,sessionSources=[],
    researchWindow,timeframe="5m",direction="LONG",asOfMs,
    strategy={},costModel={},initialCapitalKRW=1_000_000,
    leverage=1,riskFraction=0.01} = input;
  if(typeof root!=="string"||!isAbsolute(root)||resolve(root)!==root
    ||!Object.hasOwn(VENUES,market)||typeof symbol!=="string"
    ||!SYMBOL.test(symbol)||!FRAMES.has(timeframe)
    ||(timeframe==="1d"&&market.endsWith("STOCK"))
    ||!["LONG","SHORT"].includes(direction)
    ||(market!=="CRYPTO_FUTURES"&&direction!=="LONG")
    ||!integer(leverage,1,market==="CRYPTO_FUTURES"?7:1)
    ||typeof initialCapitalKRW!=="number"||!Number.isFinite(initialCapitalKRW)
    ||initialCapitalKRW<=0||typeof riskFraction!=="number"||riskFraction<=0
    ||riskFraction>0.1||!integer(asOfMs,1,8_000_000_000_000))
    fail("PRIVATE_REPLAY_MARKET_OR_RISK_POLICY_INVALID");
  if(!Array.isArray(sessionSources)||sessionSources.length>40000)
    fail("PRIVATE_REPLAY_SOURCE_SESSIONS_INVALID");
  if(!strategy||typeof strategy!=="object"||Array.isArray(strategy)
    ||!["EMA_TREND"].includes(strategy.kind??"EMA_TREND"))
    fail("PRIVATE_REPLAY_STRATEGY_UNSUPPORTED");
  const fast=strategy.fast??4,slow=strategy.slow??12;
  const stopPercent=strategy.stopPercent??1.0,targetPercent=strategy.targetPercent??2.0;
  if(!integer(fast,2,100)||!integer(slow,fast+1,250)
    ||!Number.isFinite(stopPercent)||stopPercent<=0||stopPercent>20
    ||!Number.isFinite(targetPercent)||targetPercent<=0||targetPercent>100)
    fail("PRIVATE_REPLAY_STRATEGY_PARAMETERS_INVALID");
  const costKeys=["entryFeeRate","exitFeeRate","spreadRate","slippageRate",
    "taxRate","latencyRate","fundingRatePerSession"];
  if(costKeys.some(k=>!nonNegRate(costModel[k]??0))
    ||(market!=="CRYPTO_FUTURES"&&(costModel.fundingRatePerSession??0)!==0))
    fail("PRIVATE_REPLAY_COST_RATES_INVALID");
  const costs=Object.fromEntries(costKeys.map(k=>[k,costModel[k]??0]));
  if(!manifest||typeof manifest!=="object"||Array.isArray(manifest)
    ||manifest.schemaVersion!=="historical-venue-pit-roster-v1"
    ||manifest.market!==market||manifest.venue!==VENUES[market]
    ||!["TEST_FIXTURE","EXCHANGE_DATED_ARCHIVE","LICENSED_PIT_HISTORICAL_VENDOR"].includes(manifest.sourceClass)
    ||!Array.isArray(manifest.memberships)
    ||!SHA.test(manifest.rawMembershipDigestSha256??"")
    ||digestPITMembershipRowsV1(manifest.memberships)!==manifest.rawMembershipDigestSha256)
    fail("PRIVATE_REPLAY_HISTORIC_PIT_ROSTER_REQUIRED");
  const period=resolveSelectedResearchWindowV1(researchWindow);
  const calendar=validateSessions(market,period,stockCalendar,sessionSources);
  return {root,market,symbol,manifest,period,calendar,timeframe,direction,asOfMs,
    strategy:{kind:"EMA_TREND",fast,slow,stopPercent,targetPercent},
    costs,leverage,riskFraction,initialCapitalKRW};
}
function validateSessions(market,period,stockCalendar,sources){
  const stock=market.endsWith("STOCK");
  if(stock){
    if(!stockCalendar||stockCalendar.market!==market
      ||!Array.isArray(stockCalendar.tradingDates)
      ||stockCalendar.tradingDates.length>36600)
      fail("PRIVATE_REPLAY_OFFICIAL_STOCK_DATE_COVERAGE_UNAVAILABLE");
    let prev="";
    for(const date of stockCalendar.tradingDates){
      if(typeof date!=="string"||!DATES.test(date)
        ||utc(Date.parse(date+"T00:00:00Z"))!==date||date<=prev)
        fail("PRIVATE_REPLAY_STOCK_TRADING_DATES_INVALID");
      prev=date;
    }
  }else if(stockCalendar!=null)fail("PRIVATE_REPLAY_CRYPTO_STOCK_CALENDAR_FORBIDDEN");
  const required=stock
    ?stockCalendar.tradingDates.filter(d=>d>=period.startDate&&d<=period.endDate)
    :Array.from({length:period.requestedUtcDayCount},
      (_,i)=>utc(period.startMs+i*DAY));
  if(!required.length)return {required,events:[],missing:required};
  let prevStart=-1;
  const events=[];
  for(const row of sources){
    if(!row||typeof row!=="object"||Array.isArray(row)
      ||typeof row.date!=="string"||!DATES.test(row.date)
      ||!Number.isSafeInteger(row.startMs)||row.startMs<=prevStart
      ||!Number.isSafeInteger(row.endMs)||row.endMs<=row.startMs
      ||row.endMs-row.startMs>DAY
      ||row.zone!==ZONES[market]
      ||typeof row.kind!=="string"
      ||!(stock?["PREMARKET","REGULAR","AFTERMARKET"].includes(row.kind)
        :row.kind==="UTC_24H")
      ||(row.sourceDigestSha256!=null&&!SHA.test(row.sourceDigestSha256)))
      fail("PRIVATE_REPLAY_SOURCE_SESSION_INVALID");
    prevStart=row.startMs;
    if(!stock&&(row.startMs!==Date.parse(row.date+"T00:00:00Z")
      ||row.endMs!==row.startMs+DAY))fail("PRIVATE_REPLAY_CRYPTO_UTC_DAY_INVALID");
    if(row.date<period.startDate||row.date>period.endDate)continue;
    events.push(row);
  }
  if(stock){
    const validated=validateResearchStockSessionsForDateV1(market,{
      market,sessions:events.map(x=>({
        tradingDateLocal:x.date,startMs:x.startMs,endMs:x.endMs,
        kind:x.kind,timeZone:x.zone,
      })),
    },period.startDate,period.endDate);
    if(validated.length!==events.length)fail("PRIVATE_REPLAY_STOCK_CALENDAR_SESSION_MISMATCH");
  }
  const found=new Set(events.map(x=>x.date));
  const valid=new Set(required);
  if(events.some(x=>!valid.has(x.date)))fail("PRIVATE_REPLAY_UNEXPECTED_TRADING_DATE");
  const missing=required.filter(x=>!found.has(x));
  return {required,events,missing};
}
function historicPITDay({manifest,market,symbol,date,startMs,endMs}){
  // Whole-date membership is validated, including relistings and halts.
  const utcDayMs=Date.parse(date+"T00:00:00Z");
  const report=auditHistoricalPITVenueUniverseV1({
    market,dayStartMs:utcDayMs,dayEndMs:utcDayMs+DAY,manifest,selectedRows:[],
  });
  if(!["TEST_FIXTURE_ONLY","SOURCE_ATTESTED_PIT_COHORT_ONLY"].includes(report.status))
    return {ok:false,reason:"PIT_"+String(report.reason??report.status)};
  const eligible=manifest.memberships.filter(row=>
    String(row.symbol).trim().toUpperCase()===symbol
    &&row.listedAtMs<endMs&&(row.removedAtMs??Infinity)>startMs);
  if(eligible.length!==1)return {ok:false,reason:"PIT_SYMBOL_MEMBERSHIP_MISSING_OR_REUSED"};
  const m=eligible[0];
  if(m.listedAtMs>startMs||(m.removedAtMs??Infinity)<endMs
    ||m.halts.some(h=>h.startMs<endMs&&h.endMs>startMs))
    return {ok:false,reason:"PIT_INTRADAY_LIFECYCLE_OR_HALT_NEEDS_PROOF"};
  return {ok:true,fixture:report.status==="TEST_FIXTURE_ONLY"};
}
function createReplay(initialCapitalKRW){
  return {equity:initialCapitalKRW,reserve:0,peak:initialCapitalKRW,
    maxDrawdownPercent:0,emaFast:null,emaSlow:null,
    previousClose:null,observations:0,position:null,pending:null,
    trades:0,wins:0,losses:0,modeledCostKRW:0,
    modeledNetPnlKRW:0,detail:[],days:[],bySplit:{train:0,validation:0,test:0},
    previousEndMs:-1,lossesByDate:new Map()};
}
function recordClose(state,p,b,price,reason,config){
  const spread=(config.costs.spreadRate??0)/2;
  const out=price*(p.side==="LONG"?1-spread:1+spread);
  const qty=p.quantity;
  const gross=(out-p.entryPrice)*qty*(p.side==="LONG"?1:-1);
  // Half-spread is already represented in filled entry/exit prices above.
  // Do not deduct it twice. Include it in modeled cost DISCLOSURE only.
  const entryCost=p.entryPrice*qty*(config.costs.entryFeeRate
    +config.costs.slippageRate+config.costs.latencyRate);
  const exitCost=out*qty*(config.costs.exitFeeRate+config.costs.slippageRate
    +config.costs.latencyRate+config.costs.taxRate);
  const funding=config.market==="CRYPTO_FUTURES"
    ?p.entryPrice*qty*config.costs.fundingRatePerSession:0;
  const net=gross-entryCost-exitCost-funding;
  const modeledSpreadCost=(p.entryPrice+out)*qty*spread;
  const cost=entryCost+exitCost+funding+modeledSpreadCost;
  state.trades++;state.wins+=Number(net>0);state.losses+=Number(net<0);
  if(net<0)state.lossesByDate.set(p.sessionDate,
    (state.lossesByDate.get(p.sessionDate)??0)+1);
  state.modeledCostKRW+=cost;state.modeledNetPnlKRW+=net;
  if(net>0){state.equity+=net/2;state.reserve+=net/2;}
  else state.equity=Math.max(0,state.equity+net);
  const total=state.equity+state.reserve;
  state.peak=Math.max(state.peak,total);
  state.maxDrawdownPercent=Math.max(state.maxDrawdownPercent,
    state.peak>0?100*(state.peak-total)/state.peak:0);
  const fraction=(p.signalMs-config.period.startMs)/
    (config.period.endExclusiveMs-config.period.startMs);
  const split=fraction<0.6?"train":fraction<0.8?"validation":"test";
  state.bySplit[split]++;
  if(state.detail.length<100)state.detail.push(Object.freeze({
    side:p.side,signalMs:p.signalMs,entryMs:p.entryMs,
    exitMs:b.endMs,exitReason:reason,
    modeledNetPnlKRW:net,modeledTotalCostKRW:cost,split,
    originalSignalAvailabilityVerified:false,actualFillVerified:false,
  }));
  state.position=null;
}
function consumeBar(state,b,config){
  if(b.startMs<=state.previousEndMs)fail("PRIVATE_REPLAY_DUPLICATE_OR_OVERLAPPING_BARS");
  state.previousEndMs=b.endMs-1;
  const {strategy}=config;
  const side=config.direction;
  const spread=config.costs.spreadRate/2;
  if(state.pending&&state.equity>0){
    const buy=side==="LONG";
    const entry=b.open*(buy?1+spread:1-spread);
    const riskDistance=entry*strategy.stopPercent/100;
    const riskBudget=state.equity*config.riskFraction;
    const qty=Math.min(riskBudget/riskDistance,
      state.equity*config.leverage/entry);
    if(qty>0&&Number.isFinite(qty))
      state.position={side,entryPrice:entry,quantity:qty,
        entryMs:b.startMs,signalMs:state.pending,sessionDate:config.sessionDate};
    state.pending=null;
  }
  if(state.position){
    const p=state.position,long=p.side==="LONG";
    const stop=p.entryPrice*(long?1-strategy.stopPercent/100:1+strategy.stopPercent/100);
    const target=p.entryPrice*(long?1+strategy.targetPercent/100:1-strategy.targetPercent/100);
    const stopped=long?b.low<=stop:b.high>=stop;
    const reached=long?b.high>=target:b.low<=target;
    if(stopped)recordClose(state,p,b,stop,"stop_first",config);
    else if(reached)recordClose(state,p,b,target,"target",config);
  }
  const alphaFast=2/(strategy.fast+1),alphaSlow=2/(strategy.slow+1);
  const previousFast=state.emaFast;
  state.emaFast=state.emaFast==null?b.close:
    alphaFast*b.close+(1-alphaFast)*state.emaFast;
  state.emaSlow=state.emaSlow==null?b.close:
    alphaSlow*b.close+(1-alphaSlow)*state.emaSlow;
  state.observations++;
  const trend=side==="LONG"
    ?state.emaFast>state.emaSlow&&b.close>state.emaFast
    :state.emaFast<state.emaSlow&&b.close<state.emaFast;
  if(!state.position&&!state.pending
    &&(state.lossesByDate.get(config.sessionDate)??0)<5
    &&state.observations>=strategy.slow+1
    &&previousFast!==null&&trend&&state.previousClose!=null
    &&(side==="LONG"?b.close>state.previousClose:b.close<state.previousClose))
    state.pending=b.endMs;
  state.previousClose=b.close;
}
function endSession(state,lastBar,config){
  if(state.position)recordClose(state,state.position,lastBar,lastBar.close,
    "session_close_source_boundary",config);
  state.pending=null;
}
/**
 * One symbol, one market, any requested range (bounded to 36,600 calendar days).
 * Streams independently verified LOCAL source files; retains at most 100 trade
 * previews. No assumed exchange full-member PIT, no fabricated provider data.
 */
export async function runFourMarketOriginalMinuteReplayV1(input={}){
  const cfg=normalize(input);
  const response={market:cfg.market,symbol:cfg.symbol,timeframe:cfg.timeframe,
    direction:cfg.direction,selectedStartDate:cfg.period.startDate,
    selectedEndDate:cfg.period.endDate,
    requestedTradingDays:cfg.calendar.required.length,
    expectedSessions:cfg.calendar.events.length,
    tradingCalendarIndependentProof:false,
    modeledReplayOnly:true,modeledCostsNotVerified:true,
    originalSourceAvailabilityNotVerified:true,
    sourceDaysRead:0,sourceSessionsRead:0,retrospectiveUnavailableRows:0,
    missingSourceDays:cfg.calendar.missing.length,
    ignoredOutOfWindowSourceDays:input.sessionSources.length-cfg.calendar.events.length};
  if(cfg.calendar.missing.length||!cfg.calendar.events.length)
    return safe({...response,reason:"PIT_SESSION_OR_CALENDAR_DATES_MISSING",
      modeledTradeCount:null,modeledReturnPercent:null,
      modeledNetPnlKRW:null,blockedDatesPreview:cfg.calendar.missing.slice(0,30)});
  const state=createReplay(cfg.initialCapitalKRW);
  let fixtureOnly=false,prevDate="",last=null,sourceDigestChain=[];
  for(const session of cfg.calendar.events){
    cfg.sessionDate=session.date;
    if(session.date!==prevDate){
      response.sourceDaysRead++;
      prevDate=session.date;
    }
    const pit=historicPITDay({
      manifest:cfg.manifest,market:cfg.market,symbol:cfg.symbol,date:session.date,
      startMs:session.startMs,endMs:session.endMs,
    });
    if(!pit.ok)return safe({...response,reason:pit.reason,modeledTradeCount:null,
      modeledReturnPercent:null,modeledNetPnlKRW:null});
    fixtureOnly ||=pit.fixture;
    const data=await deriveArchivedResearchTimeframesV1({
      root:cfg.root,market:cfg.market,symbol:cfg.symbol,
      sessionStartMs:session.startMs,sourceDigestSha256:session.sourceDigestSha256??null,
      asOfMs:cfg.asOfMs,timeframes:[cfg.timeframe],
    });
    if(data.status==="BLOCKED_DATA"||data.sourceMinuteIntegrityVerified!==true
      ||data.archiveSessionEndMs!==session.endMs
      ||data.sessionTimeZone!==session.zone||data.sessionKind!==session.kind)
      return safe({...response,reason:"PRIVATE_ARCHIVE_MISSING_TAMPERED_OR_MISMATCHED",
        archiveReason:String(data.reason??data.status).slice(0,120),
        modeledTradeCount:null,modeledReturnPercent:null,modeledNetPnlKRW:null});
    const frame=data.intervalData?.[cfg.timeframe];
    if(!frame||!frame.sourceSessionCoverageComplete||frame.completeBarCount<1)
      return safe({...response,reason:"ORIGINAL_ONE_MINUTE_SESSION_PARTIAL_OR_UNAVAILABLE",
        modeledTradeCount:null,modeledReturnPercent:null,modeledNetPnlKRW:null});
    const bars=frame.bars;
    for(const b of bars){
      if(b.availableAtMs>b.endMs)response.retrospectiveUnavailableRows++;
      consumeBar(state,b,cfg);
    }
    last=bars.at(-1);
    endSession(state,last,cfg);
    response.sourceSessionsRead++;
    sourceDigestChain.push([session.date,session.startMs,data.archiveSourceDigestSha256]);
  }
  // No OOS certification: the archive only checks local file consistency,
  // self-attested calendar/PIT and retrospective source publication times.
  return safe({...response,status:STATUS.source,reason:
      "LOCAL_ORIGINAL_MINUTE_REPLAY_NOT_CAUSAL_SCANNER_OR_OOS_PROOF",
    fixtureOnly,sourceDigestChainSha256:checksum(sourceDigestChain),
    modeledTradeCount:state.trades,modeledWinCount:state.wins,
    modeledLossCount:state.losses,modeledCostKRW:state.modeledCostKRW,
    modeledNetPnlKRW:state.modeledNetPnlKRW,
    modeledReturnPercent:100*((state.equity+state.reserve)/cfg.initialCapitalKRW-1),
    paperReserveModeledKRW:state.reserve,
    paperCapitalModeledKRW:state.equity,
    modeledMaximumDrawdownPercent:state.maxDrawdownPercent,
    modeledTradePreview:state.detail,
    modeledTrainValidationTestTradeCounts:state.bySplit,
    candidateStatus:"RESEARCH_ONLY_NO_ADOPTION",
  });
}
