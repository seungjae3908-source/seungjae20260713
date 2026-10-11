import {createHash} from "node:crypto";
import {isAbsolute,resolve} from "node:path";
import {setImmediate as yieldImmediate} from "node:timers/promises";
import {resolveSelectedResearchWindowV1,UTC_DAY_MS_V1 as DAY} from "./research-selected-window-v1.js";
import {deriveArchivedResearchTimeframesV1} from "./research-minute-archive-v1.js";
import {validateResearchStockSessionsForDateV1} from "./research-minute-archive-window-v1.js";
import {auditHistoricalPITVenueUniverseV1,digestPITMembershipRowsV1} from "./historical-pit-venue-universe-gate-v1.js";
import {validatePublicNativeCryptoRosterCaptureV1} from "./public-native-crypto-roster-v1.js";

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
const QUOTE_CURRENCY=Object.freeze({KR_STOCK:"KRW",US_STOCK:"USD",
  CRYPTO_SPOT:"KRW",CRYPTO_FUTURES:"USDT"});
const HORIZONS=Object.freeze([
  ["1d",1],["1w",7],["1m",30],["3m",90],["6m",180],
  ["1y",365],["3y",1095],["5y",1825],["10y",3650],
]);
const DATES=/^\d{4}-\d{2}-\d{2}$/;
const SHA=/^[a-f0-9]{64}$/;
const SYMBOL=/^[A-Z0-9][A-Z0-9._:-]{0,39}$/;
const CURRENT_SCOPE="CURRENT_PROVIDER_ROSTER_SOURCE_ONLY";
const PIT_SCOPE="HISTORICAL_PIT_ROSTER";
const CURRENT_SOURCE_IDS=Object.freeze({
  CRYPTO_SPOT:"UPBIT_PUBLIC_REST_RETROSPECTIVE_1M",
  CRYPTO_FUTURES:"BITGET_PUBLIC_V2_RETROSPECTIVE_1M",
});
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

/** Server-owned execution controls, shared with the private session index. */
export function validateOriginalMinuteExecutionControlV1(input={}){
  if((input.signal!=null&&!(input.signal instanceof AbortSignal))
    ||(input.deadlineMs!=null&&!integer(input.deadlineMs,1,8_640_000_000_000_000)))
    fail("PRIVATE_REPLAY_EXECUTION_CONTROL_INVALID");
}
export function originalMinuteReplayInterruptionReasonV1(input={}){
  if(input.signal?.aborted)return "ORIGINAL_MINUTE_REPLAY_CANCELLED";
  if(input.deadlineMs!=null&&Date.now()>=input.deadlineMs)
    return "ORIGINAL_MINUTE_REPLAY_TIME_BUDGET_EXCEEDED";
  return null;
}
/**
 * Current membership selects a source-only research cohort. It is never
 * transformed into historical listings, delistings, halts or PIT evidence.
 * A missing scope retains the original historical-PIT input contract.
 */
export function resolveOriginalMinuteEvidenceScopeV1(input={}){
  const evidenceScope=input.evidenceScope===undefined?PIT_SCOPE:input.evidenceScope;
  if(![PIT_SCOPE,CURRENT_SCOPE].includes(evidenceScope))
    fail("PRIVATE_REPLAY_EVIDENCE_SCOPE_INVALID");
  if(evidenceScope===PIT_SCOPE){
    if(input.currentRosterCapture!=null||input.expectedCurrentRosterDigestSha256!=null)
      fail("PRIVATE_REPLAY_CURRENT_ROSTER_REQUIRES_EXPLICIT_SOURCE_SCOPE");
    return Object.freeze({evidenceScope,sourceOnlyMode:false,
      currentRosterDigestSha256:null,currentRosterObservedAtMs:null});
  }
  if(!Object.hasOwn(CURRENT_SOURCE_IDS,input.market)
    ||input.manifest!=null||input.stockCalendar!=null
    ||typeof input.symbol!=="string"
    ||!(input.market==="CRYPTO_SPOT"
      ?/^KRW-[A-Z0-9]{1,32}$/u.test(input.symbol)
      :/^[A-Z0-9\p{Script=Han}]{1,36}USDT$/u.test(input.symbol))
    ||!SHA.test(input.expectedCurrentRosterDigestSha256??""))
    fail("PRIVATE_REPLAY_CURRENT_SOURCE_SCOPE_INVALID");
  const checked=validatePublicNativeCryptoRosterCaptureV1(
    input.currentRosterCapture,input.expectedCurrentRosterDigestSha256);
  const roster=input.currentRosterCapture?.roster;
  if(checked.ok!==true||roster.market!==input.market
    ||roster.venue!==VENUES[input.market]||!roster.symbols.includes(input.symbol)
    ||!integer(input.asOfMs,1,8_000_000_000_000)
    ||roster.observedAtMs>input.asOfMs)
    fail("PRIVATE_REPLAY_CURRENT_ROSTER_CAPTURE_OR_MEMBER_INVALID");
  return Object.freeze({evidenceScope,sourceOnlyMode:true,
    currentRosterDigestSha256:checked.rosterDigestSha256,
    currentRosterObservedAtMs:roster.observedAtMs});
}

function normalize(input){
  if(!input||typeof input!=="object"||Array.isArray(input))fail("PRIVATE_REPLAY_ARGS_REQUIRED");
  validateOriginalMinuteExecutionControlV1(input);
  const evidence=resolveOriginalMinuteEvidenceScopeV1(input);
  const {root,market,symbol,stockCalendar=null,manifest,sessionSources=[],
    researchWindow,timeframe="5m",direction="LONG",asOfMs,
    strategy={},costModel={},initialCapitalKRW=1_000_000,
    leverage=1,riskFraction=0.01,
    fxRateKRWPerQuote=null} = input;
  if(typeof root!=="string"||!isAbsolute(root)||resolve(root)!==root
    ||!Object.hasOwn(VENUES,market)||typeof symbol!=="string"
    ||(!evidence.sourceOnlyMode&&!SYMBOL.test(symbol))||!FRAMES.has(timeframe)
    ||(timeframe==="1d"&&market.endsWith("STOCK"))
    ||!["LONG","SHORT"].includes(direction)
    ||(market!=="CRYPTO_FUTURES"&&direction!=="LONG")
    ||!integer(leverage,1,market==="CRYPTO_FUTURES"?7:1)
    ||typeof initialCapitalKRW!=="number"||!Number.isFinite(initialCapitalKRW)
    ||initialCapitalKRW<=0||typeof riskFraction!=="number"||!Number.isFinite(riskFraction)||riskFraction<=0
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
  if(!evidence.sourceOnlyMode&&(!manifest||typeof manifest!=="object"||Array.isArray(manifest)
    ||manifest.schemaVersion!=="historical-venue-pit-roster-v1"
    ||manifest.market!==market||manifest.venue!==VENUES[market]
    ||!["TEST_FIXTURE","EXCHANGE_DATED_ARCHIVE","LICENSED_PIT_HISTORICAL_VENDOR"].includes(manifest.sourceClass)
    ||!Array.isArray(manifest.memberships)
    ||!SHA.test(manifest.rawMembershipDigestSha256??"")
    ||digestPITMembershipRowsV1(manifest.memberships)!==manifest.rawMembershipDigestSha256))
    fail("PRIVATE_REPLAY_HISTORIC_PIT_ROSTER_REQUIRED");
  const period=resolveSelectedResearchWindowV1(researchWindow);
  const calendar=evidence.sourceOnlyMode
    ?validateCurrentSourceSessions(period,sessionSources)
    :validateSessions(market,symbol,manifest,period,stockCalendar,sessionSources);
  const quote=QUOTE_CURRENCY[market];
  const needsFX=quote!=="KRW";
  if(fxRateKRWPerQuote!=null
    &&(typeof fxRateKRWPerQuote!=="number"
      ||!Number.isFinite(fxRateKRWPerQuote)
      ||fxRateKRWPerQuote<=0||fxRateKRWPerQuote>10000))
    fail("PRIVATE_REPLAY_MODELED_FX_RATE_INVALID");
  const fx=needsFX?fxRateKRWPerQuote:1;
  return {root,market,symbol,manifest,period,calendar,timeframe,direction,asOfMs,
    ...evidence,signal:input.signal??null,deadlineMs:input.deadlineMs??null,
    strategy:{kind:"EMA_TREND",fast,slow,stopPercent,targetPercent},
    costs,leverage,riskFraction,initialCapitalKRW,quote,
    fxMissing:needsFX&&fx==null,fxRateKRWPerQuote:fx};
}
function validateCurrentSourceSessions(period,sources){
  // Require every selected UTC date. No invented lifecycle can excuse a
  // missing day, and a current listing never attests historical tradability.
  const required=Array.from({length:period.requestedUtcDayCount},
    (_,i)=>utc(period.startMs+i*DAY));
  let previousStart=-1;
  const events=[];
  for(const row of sources){
    if(!row||typeof row!=="object"||Array.isArray(row)
      ||typeof row.date!=="string"||!DATES.test(row.date)
      ||!Number.isSafeInteger(row.startMs)||row.startMs<=previousStart
      ||row.startMs%DAY!==0||row.startMs!==Date.parse(row.date+"T00:00:00Z")
      ||utc(row.startMs)!==row.date||row.endMs!==row.startMs+DAY
      ||row.kind!=="UTC_24H"||row.zone!=="UTC"
      ||!SHA.test(row.sourceDigestSha256??""))
      fail("PRIVATE_REPLAY_CURRENT_SOURCE_SESSION_INVALID");
    previousStart=row.startMs;
    if(row.date>=period.startDate&&row.date<=period.endDate)events.push(row);
  }
  const found=new Set(events.map(row=>row.date));
  return {required,events,missing:required.filter(date=>!found.has(date)),
    missingSessions:0,requestedSessionCount:required.length,
    historicalLifecycleExcludedTradingDates:null,
    // Internal selection eligibility only; output never calls this a
    // historically active or PIT-verified symbol.
    symbolActiveInSelectedPeriod:true};
}
function validateSessions(market,symbol,manifest,period,stockCalendar,sources){
  const stock=market.endsWith("STOCK");
  if(stock){
    if(!stockCalendar||stockCalendar.market!==market
      ||!Array.isArray(stockCalendar.tradingDates)
      ||!Array.isArray(stockCalendar.sessions)
      ||stockCalendar.tradingDates.length>36600
      ||stockCalendar.sessions.length>50000)
      fail("PRIVATE_REPLAY_OFFICIAL_STOCK_DATE_COVERAGE_UNAVAILABLE");
    let prev="";
    for(const date of stockCalendar.tradingDates){
      if(typeof date!=="string"||!DATES.test(date)
        ||utc(Date.parse(date+"T00:00:00Z"))!==date||date<=prev)
        fail("PRIVATE_REPLAY_STOCK_TRADING_DATES_INVALID");
      prev=date;
    }
  }else if(stockCalendar!=null)
    fail("PRIVATE_REPLAY_CRYPTO_STOCK_CALENDAR_FORBIDDEN");

  // Ticker reuse must be accompanied by an immutable security identity.
  // This format only contains symbols: NEVER silently mix two different
  // instruments with the same trading code across delisting/relisting.
  const members=manifest.memberships.filter(row=>
    String(row?.symbol??"").trim().toUpperCase()===symbol);
  if(members.length!==1)
    fail("PRIVATE_REPLAY_SYMBOL_LIFECYCLE_MISSING_OR_AMBIGUOUS");
  const member=members[0],removed=member.removedAtMs??Infinity;
  if(!Number.isSafeInteger(member.listedAtMs)||member.listedAtMs<=0
    ||removed!==Infinity&&(!Number.isSafeInteger(removed)
      ||removed<=member.listedAtMs)
    ||!Array.isArray(member.halts))
    fail("PRIVATE_REPLAY_SYMBOL_LIFECYCLE_INVALID");
  const coveredSession=(start,end)=>{
    if(member.listedAtMs>=end||removed<=start)return false;
    // Intraday listing/delisting/halts need independently dated bars and a
    // narrower trading session. Do not pretend a full old-market session.
    if(member.listedAtMs>start||removed<end)
      fail("PRIVATE_REPLAY_INTRADAY_LISTING_OR_DELISTING_UNVERIFIED");
    if(member.halts.some(row=>row.startMs<end&&row.endMs>start))
      fail("PRIVATE_REPLAY_HALT_INTERVAL_SOURCE_REQUIRED");
    return true;
  };

  const selectedDates=stock
    ?stockCalendar.tradingDates.filter(date=>
      date>=period.startDate&&date<=period.endDate)
    :Array.from({length:period.requestedUtcDayCount},
      (_,i)=>utc(period.startMs+i*DAY));
  const expectedAll=stock
    ?validateResearchStockSessionsForDateV1(market,stockCalendar,
      period.startDate,period.endDate)
    :[];
  const eligibleExpected=stock
    ?expectedAll.filter(session=>
      coveredSession(session.startMs,session.endMs))
    :[];
  const hasCalendarDate=new Set(expectedAll.map(x=>x.tradingDateLocal));
  const activeCalendarDate=new Set(eligibleExpected.map(x=>x.tradingDateLocal));
  const required=stock
    ?selectedDates.filter(date=>{
      // If a supposedly open day has no dated session evidence, a member
      // active through its UTC day must remain BLOCKED, not "zero candles".
      const start=Date.parse(date+"T00:00:00Z");
      return activeCalendarDate.has(date)
        ||!hasCalendarDate.has(date)
          &&member.listedAtMs<start+DAY&&removed>start;
    })
    :selectedDates.filter(date=>{
      const start=Date.parse(date+"T00:00:00Z");
      return coveredSession(start,start+DAY);
    });
  if(!required.length)
    return {required,events:[],missing:[],missingSessions:0,
      requestedSessionCount:0,
      historicalLifecycleExcludedTradingDates:selectedDates.length,
      symbolActiveInSelectedPeriod:false};
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
      ||row.endMs!==row.startMs+DAY))
      fail("PRIVATE_REPLAY_CRYPTO_UTC_DAY_INVALID");
    if(row.date<period.startDate||row.date>period.endDate)continue;
    if(!coveredSession(row.startMs,row.endMs))
      fail("PRIVATE_REPLAY_SOURCE_OUTSIDE_HISTORIC_LISTING");
    events.push(row);
  }
  if(stock){
    const validated=validateResearchStockSessionsForDateV1(market,{
      market,sessions:events.map(x=>({
        tradingDateLocal:x.date,startMs:x.startMs,endMs:x.endMs,
        kind:x.kind,timeZone:x.zone,
      })),
    },period.startDate,period.endDate);
    if(validated.length!==events.length)
      fail("PRIVATE_REPLAY_STOCK_CALENDAR_SESSION_MISMATCH");
  }
  const found=new Set(events.map(x=>x.date));
  const valid=new Set(required);
  if(events.some(x=>!valid.has(x.date)))
    fail("PRIVATE_REPLAY_UNEXPECTED_TRADING_DATE");
  const missing=required.filter(x=>!found.has(x));
  let missingSessions=0;
  if(stock){
    const key=x=>[x.tradingDateLocal??x.date,
      x.startMs,x.endMs,x.kind].join(":");
    const expectedSet=new Set(eligibleExpected.map(key));
    const suppliedSet=new Set(events.map(key));
    if(suppliedSet.size!==events.length
      ||events.some(x=>!expectedSet.has(key(x))))
      fail("PRIVATE_REPLAY_UNEXPECTED_OR_DUPLICATE_STOCK_SESSION");
    missingSessions=eligibleExpected.filter(x=>
      !suppliedSet.has(key(x))).length;
    if(eligibleExpected.some(x=>!valid.has(x.tradingDateLocal)))
      fail("PRIVATE_REPLAY_CALENDAR_SESSION_DATE_NOT_SELECTED");
    const expectedDates=new Set(eligibleExpected.map(x=>x.tradingDateLocal));
    missingSessions+=required.filter(date=>!expectedDates.has(date)).length;
  }
  return {required,events,missing,missingSessions,
    requestedSessionCount:stock?eligibleExpected.length:required.length,
    historicalLifecycleExcludedTradingDates:
      selectedDates.length-required.length,
    symbolActiveInSelectedPeriod:true};
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
    splitModels:Object.fromEntries(["train","validation","test"].map(name=>[
      name,{modeledTradeCount:0,modeledWinCount:0,modeledLossCount:0,
        modeledNetPnlKRW:0,modeledTotalCostKRW:0},
    ])),
    previousEndMs:-1,lossesByDate:new Map(),
    horizons:Object.fromEntries(HORIZONS.map(([key])=>[key,{
      modeledTradeCount:0,modeledNetPnlKRW:0,modeledTotalCostKRW:0,
    }]))};
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
  for(const [key,days] of HORIZONS){
    const cutoff=config.period.endExclusiveMs-days*DAY;
    if(b.endMs>cutoff){
      const group=state.horizons[key];
      group.modeledTradeCount+=1;
      group.modeledNetPnlKRW+=net;
      group.modeledTotalCostKRW+=cost;
    }
  }
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
  // All modeled PnL is allocated to the time of the CLOSED signal.
  // This is a retrospective diagnostics partition, not independent OOS:
  // the model and cost inputs are neither frozen before the holdout nor
  // independently authenticated by an as-of provider receipt.
  const stage=state.splitModels[split];
  stage.modeledTradeCount++;
  stage.modeledWinCount+=Number(net>0);
  stage.modeledLossCount+=Number(net<0);
  stage.modeledNetPnlKRW+=net;
  stage.modeledTotalCostKRW+=cost;
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
    evidenceScope:cfg.evidenceScope,sourceOnlyMode:cfg.sourceOnlyMode,
    currentRosterDigestSha256:cfg.currentRosterDigestSha256,
    currentRosterObservedAtMs:cfg.currentRosterObservedAtMs,
    historicalPITRosterChecked:false,
    sessionClosePolicy:"CLOSE_EACH_SOURCE_SESSION",
    historicalTradingAvailabilityVerified:false,
    quoteCurrency:cfg.quote,modeledFxRateKRWPerQuote:cfg.fxRateKRWPerQuote,
    fxEvidenceStatus:"STATIC_FX_MODEL_ONLY_NOT_HISTORICAL",
    requestedTradingDays:cfg.sourceOnlyMode?null:cfg.calendar.required.length,
    requestedUtcDayCount:cfg.period.requestedUtcDayCount,
    historicalLifecycleExcludedTradingDates:
      cfg.calendar.historicalLifecycleExcludedTradingDates,
    historicalMemberLifespanSelfAttestedNotIndependentlyVerified:!cfg.sourceOnlyMode,
    expectedSessions:cfg.calendar.requestedSessionCount,
    providedSessions:cfg.calendar.events.length,
    missingExpectedStockSessions:cfg.calendar.missingSessions,
    tradingCalendarIndependentProof:false,
    modeledReplayOnly:true,modeledCostsNotVerified:true,
    originalSourceAvailabilityNotVerified:true,
    sourceDaysRead:0,sourceSessionsRead:0,sourceMinuteRowsRead:0,
    derivedBarsRead:0,retrospectiveUnavailableRows:0,
    missingSourceDays:cfg.calendar.missing.length,
    ignoredOutOfWindowSourceDays:(input.sessionSources??[]).length-cfg.calendar.events.length};
  const interrupted=()=>{
    const reason=originalMinuteReplayInterruptionReasonV1(cfg);
    return reason?safe({...response,reason,
      modeledTradeCount:null,modeledWinCount:null,modeledLossCount:null,
      modeledNetPnlKRW:null,modeledReturnPercent:null,modeledCostKRW:null,
      modeledMaximumDrawdownPercent:null,modeledTradePreview:null,
      modeledTrainValidationTestDiagnostics:null,
      paperReserveModeledKRW:null,paperCapitalModeledKRW:null,
      sourceDigestChainSha256:null,sourceLineageSha256:null,
      sourceModelDigestSha256:null}):null;
  };
  let stopped=interrupted();if(stopped)return stopped;
  await yieldImmediate();
  stopped=interrupted();if(stopped)return stopped;
  if(!cfg.calendar.symbolActiveInSelectedPeriod)
    return safe({...response,
      reason:"HISTORIC_SYMBOL_NOT_ACTIVE_IN_SELECTED_PERIOD",
      modeledTradeCount:null,modeledReturnPercent:null,
      modeledNetPnlKRW:null});
  if(cfg.fxMissing)return safe({...response,
    reason:"HISTORICAL_QUOTE_TO_KRW_FX_MISSING",
    modeledTradeCount:null,modeledReturnPercent:null,
    modeledNetPnlKRW:null});
  if(cfg.calendar.missingSessions>0)
    return safe({...response,reason:"STOCK_EXPECTED_ORIGINAL_SESSION_MISSING",
      modeledTradeCount:null,modeledReturnPercent:null,
      modeledNetPnlKRW:null,missingExpectedStockSessions:cfg.calendar.missingSessions});
  if(cfg.calendar.missing.length||!cfg.calendar.events.length)
    return safe({...response,reason:cfg.sourceOnlyMode
      ?"CURRENT_SOURCE_SELECTED_UTC_DATES_MISSING":"PIT_SESSION_OR_CALENDAR_DATES_MISSING",
      modeledTradeCount:null,modeledReturnPercent:null,
      modeledNetPnlKRW:null,blockedDatesPreview:cfg.calendar.missing.slice(0,30)});
  const state=createReplay(cfg.initialCapitalKRW);
  let fixtureOnly=false,prevDate="",last=null,sourceDigestChain=[];
  for(const session of cfg.calendar.events){
    stopped=interrupted();if(stopped)return stopped;
    await yieldImmediate();
    stopped=interrupted();if(stopped)return stopped;
    cfg.sessionDate=session.date;
    if(session.date!==prevDate){
      response.sourceDaysRead++;
      prevDate=session.date;
    }
    if(!cfg.sourceOnlyMode){
      const pit=historicPITDay({
        manifest:cfg.manifest,market:cfg.market,symbol:cfg.symbol,date:session.date,
        startMs:session.startMs,endMs:session.endMs,
      });
      response.historicalPITRosterChecked=true;
      if(!pit.ok)return safe({...response,reason:pit.reason,modeledTradeCount:null,
        modeledReturnPercent:null,modeledNetPnlKRW:null});
      fixtureOnly ||=pit.fixture;
    }
    stopped=interrupted();if(stopped)return stopped;
    const data=await deriveArchivedResearchTimeframesV1({
      root:cfg.root,market:cfg.market,symbol:cfg.symbol,
      sessionStartMs:session.startMs,sourceDigestSha256:session.sourceDigestSha256??null,
      asOfMs:cfg.asOfMs,timeframes:[cfg.timeframe],
    });
    stopped=interrupted();if(stopped)return stopped;
    if(data.status==="BLOCKED_DATA"||data.sourceMinuteIntegrityVerified!==true
      ||data.archiveSessionEndMs!==session.endMs
      ||data.sessionTimeZone!==session.zone||data.sessionKind!==session.kind)
      return safe({...response,reason:"PRIVATE_ARCHIVE_MISSING_TAMPERED_OR_MISMATCHED",
        archiveReason:String(data.reason??data.status).slice(0,120),
        modeledTradeCount:null,modeledReturnPercent:null,modeledNetPnlKRW:null});
    if(cfg.sourceOnlyMode&&(data.market!==cfg.market||data.symbol!==cfg.symbol
      ||data.venue!==VENUES[cfg.market]
      ||data.sourceId!==CURRENT_SOURCE_IDS[cfg.market]))
      return safe({...response,reason:"CURRENT_SOURCE_NATIVE_PROVIDER_OR_VENUE_MISMATCH",
        modeledTradeCount:null,modeledReturnPercent:null,modeledNetPnlKRW:null});
    const frame=data.intervalData?.[cfg.timeframe];
    if(!frame||!frame.sourceSessionCoverageComplete||frame.completeBarCount<1
      ||(cfg.sourceOnlyMode&&data.sourceMinuteRows!==1440))
      return safe({...response,reason:"ORIGINAL_ONE_MINUTE_SESSION_PARTIAL_OR_UNAVAILABLE",
        modeledTradeCount:null,modeledReturnPercent:null,modeledNetPnlKRW:null});
    // Convert quote amounts for the KRW-denominated model using an explicitly
    // supplied STATIC FX assumption. This is NOT time-series official FX proof.
    const bars=frame.bars;
    response.sourceMinuteRowsRead+=data.sourceMinuteRows;
    for(const [index,b] of bars.entries()){
      // Yield inside a long session so request cancellation and deadline
      // timers can fire; never race an HTTP timeout against ongoing work.
      if(index>0&&index%256===0)await yieldImmediate();
      stopped=interrupted();if(stopped)return stopped;
      if(b.availableAtMs>b.endMs)response.retrospectiveUnavailableRows++;
      const value=cfg.fxRateKRWPerQuote===1?b:{
        ...b,open:b.open*cfg.fxRateKRWPerQuote,
        high:b.high*cfg.fxRateKRWPerQuote,
        low:b.low*cfg.fxRateKRWPerQuote,
        close:b.close*cfg.fxRateKRWPerQuote,
      };
      consumeBar(state,value,cfg);
      response.derivedBarsRead++;
      last=value;
    }
    stopped=interrupted();if(stopped)return stopped;
    endSession(state,last,cfg);
    response.sourceSessionsRead++;
    sourceDigestChain.push([session.date,session.startMs,data.archiveSourceDigestSha256]);
  }
  stopped=interrupted();if(stopped)return stopped;
  // Preserve the original PIT-chain format, but bind the explicitly new
  // current-cohort scope and snapshot SHA to its different source lineage.
  const sourceDigestChainSha256=checksum(cfg.sourceOnlyMode?{
    evidenceScope:cfg.evidenceScope,currentRosterDigestSha256:cfg.currentRosterDigestSha256,
    sessions:sourceDigestChain,
  }:sourceDigestChain);
  const sourceModelDigestSha256=checksum({
    schemaVersion:"original-minute-ema-model-v1",evidenceScope:cfg.evidenceScope,
    currentRosterDigestSha256:cfg.currentRosterDigestSha256,
    historicalRosterDigestSha256:cfg.manifest?.rawMembershipDigestSha256??null,
    sourceDigestChainSha256,market:cfg.market,symbol:cfg.symbol,
    selectedPeriod:[cfg.period.startDate,cfg.period.endDate],asOfMs:cfg.asOfMs,
    timeframe:cfg.timeframe,direction:cfg.direction,strategy:cfg.strategy,
    costs:cfg.costs,fxRateKRWPerQuote:cfg.fxRateKRWPerQuote,
    initialCapitalKRW:cfg.initialCapitalKRW,leverage:cfg.leverage,riskFraction:cfg.riskFraction,
    sessionClosePolicy:"CLOSE_EACH_SOURCE_SESSION",
  });
  // No OOS certification: the archive only checks local file consistency,
  // self-attested calendar/PIT and retrospective source publication times.
  return safe({...response,status:STATUS.source,reason:
      "LOCAL_ORIGINAL_MINUTE_REPLAY_NOT_CAUSAL_SCANNER_OR_OOS_PROOF",
    fixtureOnly,sourceDigestChainSha256,sourceLineageSha256:sourceDigestChainSha256,
    sourceModelDigestSha256,
    modeledTradeCount:state.trades,modeledWinCount:state.wins,
    modeledLossCount:state.losses,modeledCostKRW:state.modeledCostKRW,
    modeledNetPnlKRW:state.modeledNetPnlKRW,
    modeledReturnPercent:100*((state.equity+state.reserve)/cfg.initialCapitalKRW-1),
    paperReserveModeledKRW:state.reserve,
    paperCapitalModeledKRW:state.equity,
    modeledMaximumDrawdownPercent:state.maxDrawdownPercent,
    modeledTradePreview:state.detail,
    modeledTrainValidationTestTradeCounts:state.bySplit,
    modeledTrainValidationTestDiagnostics:Object.fromEntries(
      ["train","validation","test"].map(name=>{
        const item=state.splitModels[name];
        return [name,{
          ...item,
          modeledReturnPercent:100*item.modeledNetPnlKRW/cfg.initialCapitalKRW,
          modeledWinRatePercent:item.modeledTradeCount
            ?100*item.modeledWinCount/item.modeledTradeCount:null,
          sourceAndHistoricalPITIndependentlyVerified:false,
          independentlyFrozenHoldoutParametersVerified:false,
          timeStampedFullCostAndFillEvidenceVerified:false,
          independentOOSProven:false,
          paperCandidatePASS:false,
          executionAuthority:"NONE",
        }];
      }),
    ),
    modeledSplitContract:{
      ratio:[60,20,20],stageMembershipBy:"SIGNAL_CLOSE_TIME",
      modeledOnly:true,historicalDataAvailabilityNotIndependent:true,
      independentlyProvenOOS:false,profitabilityProven:false,
      paperAdmissionAllowed:false,
    },
    modeledPeriodReturns:Object.fromEntries(HORIZONS.map(([key,days])=>{
      const value=state.horizons[key];
      const supported=cfg.period.requestedUtcDayCount>=days;
      return [key,supported?{
        modeledTradeCount:value.modeledTradeCount,
        modeledNetPnlKRW:value.modeledNetPnlKRW,
        modeledReturnPercent:100*value.modeledNetPnlKRW/cfg.initialCapitalKRW,
        modeledTotalCostKRW:value.modeledTotalCostKRW,
        independentOOSProven:false,
      }:{
        modeledTradeCount:null,modeledNetPnlKRW:null,
        modeledReturnPercent:null,modeledTotalCostKRW:null,
        reason:"SELECTED_WINDOW_SHORTER_THAN_HORIZON",
      }];
    })),
    candidateStatus:"RESEARCH_ONLY_NO_ADOPTION",
  });
}
