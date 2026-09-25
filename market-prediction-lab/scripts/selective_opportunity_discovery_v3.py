#!/usr/bin/env python3
"""Offline, post-selection research on one checksum-pinned V2 snapshot.

Three causal discovery families, one independently toggled theme condition,
separate portfolios, integer stock exits, and complete admission diagnostics.
Never connects to markets, brokers, Telegram, a database, or live execution.
"""
from __future__ import annotations
import argparse
import collections
import copy
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
from typing import Any

START = 1774396800000  # 2026-03-25T00:00:00Z
END = 1790294400000    # 2026-09-25T00:00:00Z (exclusive bar open)
SNAPSHOT_SHA = 'fabcae6eabe257f0e02bfd1af1f9dabb0b5e1e79494768dd08cb589166a13702'
FAMILIES = ('BREAKOUT20', 'FIRST_RETEST', 'EXPLOSION_CONTINUATION')
POLICY = {
    'id': 'selective-opportunity-independent-discovery-v3',
    'window': [START, END], 'status': 'POST_SELECTION_EXPLORATORY',
    'snapshotSha256': SNAPSHOT_SHA, 'families': list(FAMILIES),
    'breakout': {'lookback': 20, 'minimumRelativeVolume': 1.2, 'firstCrossOnly': True},
    'retest': {'maxBarsStock': 10, 'maxBarsCrypto': 18, 'touchAboveLevelAtr': .5,
               'lowestBelowLevelAtr': 1, 'minimumRelativeVolume': 1, 'oneSetupPerBreakout': True},
    'explosion': {'minimumReturn': .08, 'minimumRelativeVolume': 2.5,
                  'minimumCloseLocation': .65, 'maxContinuationBars': 5,
                  'continuationVolumeRatioMax': .9,
                  'usExplosionGapRange': [.08, .5], 'usExplosionPreviousPriceRange': [1, 80],
                  'minimumTurnover': {'KR': 10_000_000_000, 'US': 20_000_000, 'CRYPTO': 1_000_000_000}},
    'theme': {'minimumBreadth': .6, 'minimumCoverage': .8, 'minimumMembers': 3,
              'primaryAssignment': 'LEXICOGRAPHIC_STATIC_NOT_POINT_IN_TIME'},
    'risk': {'structureLookback': 5, 'structureBufferAtr': .25, 'minimumDistanceAtr': 1,
             'stopCapStock': .08, 'stopCapCrypto': .10, 'entryGapCapAtr': 1,
             'riskFraction': .005, 'explosionRiskFraction': .0025,
             'symbolCap': .2, 'explosionSymbolCap': .1, 'themeCap': .4,
             'grossCap': 1, 'aggregateInitialRiskCap': .02,
             'maxPositions': 5, 'explosionMaxPositions': 3},
    'exit': {'targetR': [2, 4], 'explosionTargetR': [1.5, 3], 'trailAtr': 3,
             'maxBarsStock': 40, 'maxBarsCrypto': 90, 'maxBarsExplosion': 10,
             'stockTranches': 'FLOOR_INITIAL_QUANTITY_DIVIDED_BY_3_REMAINDER_LAST',
             'sameBarAmbiguity': 'STOP_FIRST', 'trailEffective': 'NEXT_BAR_ONLY'},
    'costPerSide': {'KR_THEME': .0025, 'US_THEME': .0015, 'US_EXPLOSION_PROXY': .005, 'CRYPTO_THEME': .0015},
    'stressMultiplier': 1.5,
    'initialCapital': {'KR_THEME': 10_000_000, 'US_THEME': 10_000, 'US_EXPLOSION_PROXY': 10_000, 'CRYPTO_THEME': 10_000_000},
    'radar': {'returnTrigger': .05, 'rvolTrigger': 2, 'episodeCooldownBars': 5,
              'detectionHorizonBars': 5, 'outcomeHorizonBars': 20},
    'candidatePriority': 'SIGNAL_TIME_THEN_RELATIVE_VOLUME_DESC_THEN_SYMBOL',
    'canonicalSampleDelta': 0, 'executionAuthority': 'NONE', 'profitabilityProven': False,
    'paperActivation': False, 'telegramSent': 0, 'actualOrders': 0,
    'futureProbability': None, 'futureExpectedValue': None, 'independentOos': False,
}
THEMES = {
 'KR': {
  'kr_semiconductor_ai': ['005930','000660','042700','000990','058470'],
  'kr_defense': ['012450','047810','064350','272210'],
  'kr_nuclear_power': ['034020','052690','051600','015760','001440'],
  'kr_battery_ev': ['373220','006400','051910','003670','247540'],
  'kr_bio': ['207940','068270','000100','128940','326030'],
  'kr_robot': ['277810','454910','090360','108490'],
 },
 'US': {
  'us_ai_semis': ['NVDA','AMD','AVGO','TSM','ARM','MU'],
  'us_quantum': ['IONQ','RGTI','QBTS','QUBT'],
  'us_nuclear_power': ['CEG','VST','OKLO','SMR','CCJ'],
  'us_defense_drones': ['PLTR','AVAV','KTOS','LMT','RTX'],
  'us_space': ['RKLB','LUNR','ASTS','RDW'],
  'us_ai_software': ['PLTR','SOUN','BBAI','AI','SNOW'],
 },
 'CRYPTO': {
  'crypto_l1': ['BTC','ETH','SOL','ADA','AVAX','SUI','APT','NEAR'],
  'crypto_ai': ['FET','RENDER','ARKM','WLD','GRT'],
  'crypto_defi': ['UNI','AAVE','LINK','LDO','PENDLE'],
  'crypto_meme': ['DOGE','SHIB','PEPE','BONK'],
  'crypto_payments': ['XRP','XLM','HBAR'],
 },
}


def digest(value: Any) -> str:
    raw = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    return hashlib.sha256(raw).hexdigest()


def average(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def bar_ms(market: str) -> int:
    return 4 * 3_600_000 if market == 'CRYPTO' else 23_400_000


def validate_rows(rows: list[dict], market: str) -> list[dict]:
    if not rows:
        raise ValueError('EMPTY_SOURCE')
    previous = -1
    warnings = []
    for i, r in enumerate(rows):
        if not all(type(r.get(k)) in (int, float) and math.isfinite(r[k]) for k in ('timestamp','open','high','low','close','volume')):
            raise ValueError('NONFINITE_OR_MISSING_CANDLE')
        if r['timestamp'] <= previous:
            raise ValueError('NONMONOTONIC_CANDLE')
        if min(r['open'],r['high'],r['low'],r['close']) <= 0 or r['volume'] < 0 or r['high'] < max(r['open'],r['close']) or r['low'] > min(r['open'],r['close']):
            raise ValueError('INVALID_OHLC')
        if r['timestamp'] + bar_ms(market) > END:
            raise ValueError('UNCLOSED_WINDOW_BAR')
        if market == 'CRYPTO' and i and r['timestamp'] - previous != bar_ms(market):
            raise ValueError('MISSING_CRYPTO_PATH_NO_SYNTHETIC_BARS')
        if i and not .2 < r['open'] / rows[i-1]['close'] < 5:
            warnings.append({'index':i,'code':'CORPORATE_ACTION_OR_SCALE_UNVERIFIED'})
        previous = r['timestamp']
    if rows[0]['timestamp'] > START or rows[-1]['timestamp'] < END - 4*86_400_000:
        raise ValueError('EVALUATION_COVERAGE_MISSING')
    return warnings


def indicators(rows: list[dict]) -> list[dict]:
    result = []
    for i, r in enumerate(rows):
        if i < 60:
            result.append({}); continue
        prior = rows[i-20:i]
        tr = [max(rows[j]['high']-rows[j]['low'], abs(rows[j]['high']-rows[j-1]['close']), abs(rows[j]['low']-rows[j-1]['close'])) for j in range(i-13,i+1)]
        vol = average([x['volume'] for x in prior])
        previous_level = max(x['high'] for x in rows[i-21:i-1])
        result.append({'atr':average(tr), 'level':max(x['high'] for x in prior),
                       'priorLevel':previous_level,
                       'rvol':r['volume']/vol if vol and vol>0 else 0,
                       'ma20':average([x['close'] for x in rows[i-19:i+1]]),
                       'ma30':average([x['close'] for x in rows[i-29:i+1]]),
                       'return':r['close']/rows[i-1]['close']-1,
                       'gap':r['open']/rows[i-1]['close']-1,
                       'location':(r['close']-r['low'])/(r['high']-r['low']) if r['high']>r['low'] else .5})
    return result


def discover(rows: list[dict], symbol: str, market: str, lane: str) -> tuple[list[dict],list[dict]]:
    """Only closed-bar information enters discovery. Portfolio exits are unknown here."""
    ind = indicators(rows); signals = []; radar = []
    retest = None; explosion = None; last_radar = -999
    family_set = ('EXPLOSION_CONTINUATION',) if lane == 'US_EXPLOSION_PROXY' else FAMILIES
    for i in range(60, len(rows)):
        r = rows[i]; p = rows[i-1]; x = ind[i]
        if r['timestamp'] >= END: break
        known = r['timestamp'] + bar_ms(market)
        in_window = START <= r['timestamp'] < END
        breakout = r['close'] > x['level'] and p['close'] <= x['priorLevel'] and x['rvol'] >= 1.2
        raw_explosion = x['return'] >= .08 and x['rvol'] >= 2.5 and x['location'] >= .65 and r['close']*r['volume'] >= POLICY['explosion']['minimumTurnover'][market]
        if lane == 'US_EXPLOSION_PROXY':
            raw_explosion = raw_explosion and .08 <= x['gap'] <= .5 and 1 <= p['close'] <= 80
        setups = []
        if retest:
            age = i-retest['index']; level = retest['level']; a = retest['atr']
            if age > (18 if market=='CRYPTO' else 10) or r['close'] < level-a:
                retest = None
            elif age > 0 and level-a <= r['low'] <= level+.5*a and r['close'] >= level and r['close']>r['open'] and r['close']>p['close'] and x['rvol']>=1:
                setups.append(('FIRST_RETEST', retest['index'])); retest=None
        if explosion:
            age=i-explosion['index']
            if age>5 or r['close']<explosion['open']:
                explosion=None
            elif age>0 and r['low']>p['low'] and r['close']>p['close'] and r['close']>r['open'] and r['volume']<=explosion['volume']*.9:
                setups.append(('EXPLOSION_CONTINUATION',explosion['index']));explosion=None
        if breakout:
            setups.append(('BREAKOUT20',i))
            # Keep the first still-valid breakout episode, not the most profitable later one.
            if retest is None: retest={'index':i,'level':x['level'],'atr':x['atr']}
        if raw_explosion and explosion is None: explosion={'index':i,'open':r['open'],'volume':r['volume']}
        if in_window:
            for family,origin in setups:
                if family not in family_set:continue
                signals.append({'id':f'{lane}:{symbol}:{family}:{int(r["timestamp"])}', 'lane':lane,'market':market,
                                'symbol':symbol,'family':family,'signalIndex':i,'signalTimestamp':r['timestamp'],
                                'knownAt':known,'originIndex':origin,'atr':x['atr'],'rvol':x['rvol']})
            wide_event = r['close']>x['level'] or x['return']>=.05 or x['rvol']>=2
            if wide_event and i-last_radar>=5:
                radar.append({'symbol':symbol,'index':i,'timestamp':r['timestamp'],'knownAt':known,
                              'returnAtDetection':x['return'],'rvolAtDetection':x['rvol']})
                last_radar=i
    return signals,radar


def theme_context(candidate: dict, all_data: dict, all_ind: dict, indexes: dict) -> dict:
    market = candidate['market']; symbol=candidate['symbol']; t=candidate['signalTimestamp']
    groups=sorted(k for k,v in THEMES[market].items() if symbol in v)
    if not groups:return {'groups':[], 'primary':None,'passed':False,'reason':'THEME_UNCLASSIFIED','breadth':None}
    primary=groups[0]; members=THEMES[market][primary]; observations=[]
    for s in members:
        i=indexes.get(s,{}).get(t)
        if i is None or not all_ind[s][i]:continue
        metric='ma30' if market=='CRYPTO' else 'ma20'
        observations.append(all_data[s][i]['close']>all_ind[s][i][metric])
    coverage=len(observations)/len(members)
    breadth=sum(observations)/len(observations) if observations else None
    reason='THEME_COVERAGE_MISSING' if coverage<.8 or len(observations)<3 else 'THEME_BREADTH_LOW' if breadth<.6 else None
    return {'groups':groups,'primary':primary,'coverage':coverage,'observedMembers':len(observations),
            'totalMembers':len(members),'breadth':breadth,'passed':reason is None,'reason':reason}


def make_plan(c: dict, rows: list[dict]) -> dict:
    i=c['signalIndex']; a=c['atr']; blockers=[]
    if i+1>=len(rows):return {'candidate':c,'blockers':['END_BOUNDARY_NO_NEXT_BAR']}
    e=rows[i+1]
    if e['timestamp'] < c['knownAt'] or e['timestamp'] >= END:return {'candidate':c,'blockers':['NEXT_BAR_NOT_CAUSAL']}
    stop=min(min(r['low'] for r in rows[i-4:i+1])-.25*a,e['open']-a)
    if not 0<stop<e['open']:blockers.append('INVALID_STOP')
    if (e['open']-stop)/e['open'] > (.10 if c['market']=='CRYPTO' else .08):blockers.append('STRUCTURAL_STOP_TOO_WIDE')
    if abs(e['open']-rows[i]['close'])>a:blockers.append('ENTRY_GAP_TOO_LARGE')
    return {'candidate':c,'entryTimestamp':e['timestamp'],'entryIndex':i+1,'entryPrice':e['open'],
            'initialStop':stop,'stopPercent':(e['open']-stop)/e['open'],'blockers':blockers}


def price_path(plan: dict, rows: list[dict], ind: list[dict] | None = None) -> list[dict]:
    """Unit price triggers, not position quantities. Unused by discovery/ranking/sizing."""
    if 'entryIndex' not in plan or not 0<plan['initialStop']<plan['entryPrice']:return []
    c=plan['candidate']; market=c['market']; exp=c['lane']=='US_EXPLOSION_PROXY'
    start=plan['entryIndex']; entry=plan['entryPrice']; risk=entry-plan['initialStop'];stop=plan['initialStop']
    rs=[1.5,3] if exp else [2,4];target1=entry+rs[0]*risk;target2=entry+rs[1]*risk
    max_bars=10 if exp else 90 if market=='CRYPTO' else 40
    last=min(len(rows)-1,start+max_bars-1);done1=done2=False;highest=entry;events=[]
    ind=indicators(rows) if ind is None else ind
    for i in range(start,last+1):
        r=rows[i]; close_t=r['timestamp']+bar_ms(market)
        if r['open']<=stop:
            events.append({'timestamp':r['timestamp'],'phase':2,'kind':'FINAL','price':r['open'],'reason':'STOP_GAP'});break
        if r['low']<=stop:
            events.append({'timestamp':close_t,'phase':0,'kind':'FINAL','price':stop,'reason':'STOP_FIRST'});break
        if not done1 and r['high']>=target1:
            events.append({'timestamp':close_t,'phase':0,'kind':'T1','price':target1,'reason':'TARGET_1'});done1=True
        if not done2 and r['high']>=target2:
            events.append({'timestamp':close_t,'phase':0,'kind':'T2','price':target2,'reason':'TARGET_2'});done2=True
        highest=max(highest,r['close'])
        if done1:stop=max(stop,entry,highest-3*ind[i]['atr'])
        if i==last:
            events.append({'timestamp':close_t,'phase':0,'kind':'FINAL','price':r['close'],
                           'reason':'END_MARKED_LIQUIDATION' if i==len(rows)-1 else 'MAX_HOLD'});break
    assert events and events[-1]['kind']=='FINAL'
    return events


def stats(ledger: list[dict]) -> dict:
    wins=[r for r in ledger if r['pnl']>0];losses=[r for r in ledger if r['pnl']<0]
    gain=sum(r['pnl'] for r in wins);loss=-sum(r['pnl'] for r in losses)
    best=max(ledger,key=lambda r:r['pnl']) if ledger else None
    return {'trades':len(ledger),'wins':len(wins),'losses':len(losses),
            'winRate':len(wins)/len(ledger) if ledger else None,
            'meanTradeReturn':average([r['netReturn'] for r in ledger]),
            'profitFactor':gain/loss if loss else None,
            'bestTrade':{'id':best['id'],'symbol':best['symbol'],'pnl':best['pnl']} if best else None,
            'pnlExcludingBestFixedLedger':sum(r['pnl'] for r in ledger)-(best['pnl'] if best else 0)}


def replay(plans: list[dict], paths: dict, data: dict, lane: str, theme_on: bool, cost: float, *, capital: float | None=None) -> dict:
    exp=lane=='US_EXPLOSION_PROXY';market='CRYPTO' if lane=='CRYPTO_THEME' else 'KR' if lane=='KR_THEME' else 'US'
    initial=POLICY['initialCapital'][lane] if capital is None else capital
    risk_fraction=.0025 if exp else .005; cap=.1 if exp else .2; max_positions=3 if exp else 5
    whole=market!='CRYPTO'; cash=initial;active={};prices={};ledger=[];audit=[]; fills=[];curve=[]
    peak=initial;mdd=0;min_cash=initial;gross_peak=0;positions_peak=0;last_t=None;events=[]
    # Marks at previous candle close precede this candle's opening. Intrabar fills settle at close.
    for symbol,rows in data.items():
        for r in rows:
            if not START<=r['timestamp']<END:continue
            events.append((r['timestamp'],1,0,symbol,'MARK',r['open']))
            events.append((r['timestamp']+bar_ms(market),0,1,symbol,'MARK',r['close']))
    for p in plans:
        c=p['candidate'];pid=c['id']
        if 'entryTimestamp' not in p:
            audit.append({'id':pid,'symbol':c['symbol'],'stage':'PLAN','reason':p['blockers'][0]});continue
        events.append((p['entryTimestamp'],3,(c['signalTimestamp'],-c['rvol']),c['symbol'],'ENTRY',p))
        for j,f in enumerate(paths.get(pid,[])):
            events.append((f['timestamp'],f['phase'],.01+j*.001,c['symbol'],'EXIT',(p,f)))
    events.sort(key=lambda e:(e[0],e[1],e[2],e[3]))
    def equity():return cash+sum(p['remaining']*prices.get(s,p['entryPrice']) for s,p in active.items())
    def observe(t,phase):
        nonlocal peak,mdd,min_cash,gross_peak,positions_peak
        e=equity();peak=max(peak,e);mdd=max(mdd,1-e/peak if peak>0 else 0)
        min_cash=min(min_cash,cash);gross_peak=max(gross_peak,(e-cash)/e if e>0 else 0);positions_peak=max(positions_peak,len(active))
        if cash < -1e-5:raise AssertionError('NEGATIVE_CASH')
        curve.append({'timestamp':t,'phase':phase,'equity':e,'cash':cash,'positions':len(active)})
    last_phase=None
    for t,phase,priority,s,kind,obj in events:
        if last_t is not None and (t,phase)!=(last_t,last_phase):observe(last_t,last_phase)
        last_t,last_phase=t,phase
        if kind=='MARK':prices[s]=obj;continue
        if kind=='ENTRY':
            p=obj;c=p['candidate'];pid=c['id'];why=None;stage='PLAN'
            if p['blockers']:why=p['blockers'][0]
            elif theme_on and not c['theme']['passed']:why=c['theme']['reason'];stage='FILTER'
            elif s in active:why='SYMBOL_ALREADY_OPEN';stage='CAPACITY'
            elif len(active)>=max_positions:why='POSITION_CAP';stage='CAPACITY'
            if why:
                audit.append({'id':pid,'symbol':s,'stage':stage,'reason':why});continue
            e=equity();unit=p['entryPrice']*(1+cost);risk_unit=unit-p['initialStop']*(1-cost)
            current_risk=sum(x['riskCommitted'] for x in active.values())
            groups=c['theme']['groups'] or ['unclassified:'+s]
            theme_room=[]
            for group in groups:
                committed=sum(x['remaining']*prices.get(ss,x['entryPrice']) for ss,x in active.items() if group in x['groups'])
                theme_room.append(max(0,.4*e-committed)/unit)
            limits={'PER_TRADE_RISK':risk_fraction*e/risk_unit,
                    'AGGREGATE_RISK':max(0,.02*e-current_risk)/risk_unit,
                    'SYMBOL_NOTIONAL':cap*e/unit,'THEME_NOTIONAL':min(theme_room),
                    'GROSS_NOTIONAL':max(0,e-(e-cash))/unit,'CASH':cash/unit}
            limiting=min(limits,key=limits.get);raw=min(limits.values())
            q=math.floor(raw) if whole else math.floor(raw*1e8)/1e8
            if q<=0:
                audit.append({'id':pid,'symbol':s,'stage':'SIZING','reason':'LOT_'+limiting,
                              'riskPerOneUnit':risk_unit,'riskBudget':risk_fraction*e,'rawUnits':raw});continue
            spent=q*unit;fee=q*p['entryPrice']*cost;cash-=spent
            position={'id':pid,'symbol':s,'groups':groups,'quantity':q,'remaining':q,'entryPrice':p['entryPrice'],
                      'entryTimestamp':t,'spent':spent,'received':0,'fees':fee,'costTurnover':q*p['entryPrice'],
                      'riskCommitted':q*risk_unit,'entryIndex':p['entryIndex'],'fills':[], 'plan':p}
            active[s]=position;prices[s]=p['entryPrice']
            fills.append({'id':pid,'timestamp':t,'side':'BUY','quantity':q,'price':p['entryPrice'],'fee':fee})
            audit.append({'id':pid,'symbol':s,'stage':'ACCEPTED','reason':'ACCEPTED','quantity':q})
        else:
            p,f=obj;pos=active.get(s)
            if not pos or pos['id']!=p['candidate']['id']:continue
            q=pos['remaining'] if f['kind']=='FINAL' else math.floor(pos['quantity']/3) if whole else pos['quantity']/3
            q=min(q,pos['remaining'])
            if q<=0:continue
            gross=q*f['price'];fee=gross*cost;cash+=gross-fee
            pos['remaining']-=q;pos['received']+=gross-fee;pos['fees']+=fee;pos['costTurnover']+=gross
            row={'id':pos['id'],'timestamp':t,'side':'SELL','quantity':q,'price':f['price'],'fee':fee,'reason':f['reason']}
            pos['fills'].append(row);fills.append(row)
            # Conservative original-risk reservation releases only as actual units are sold.
            pos['riskCommitted']*=pos['remaining']/(pos['remaining']+q)
            if pos['remaining']<=max(1e-10,pos['quantity']*1e-12):
                pnl=pos['received']-pos['spent']
                ledger.append({k:pos[k] for k in ('id','symbol','groups','quantity','entryTimestamp','entryPrice','spent','received','fees','costTurnover','fills')} | {
                    'exitTimestamp':t,'exitReason':f['reason'],'pnl':pnl,'netReturn':pnl/pos['spent']})
                del active[s]
    if last_t is not None:observe(last_t,last_phase)
    if active:raise AssertionError('UNSETTLED_POSITIONS')
    if abs(cash-initial-sum(r['pnl'] for r in ledger))>max(.0001,initial*1e-9):raise AssertionError('CASH_RECONCILIATION_FAILED')
    if whole and any(not float(f['quantity']).is_integer() for f in fills):raise AssertionError('FRACTIONAL_STOCK_FILL')
    if len(audit)!=len(plans):raise AssertionError('CANDIDATE_NOT_ACCOUNTED_FOR')
    monthly=[];prev=initial
    for m in range(3,10):
        boundary=min(END,int(dt.datetime(2026,m+1,1,tzinfo=dt.timezone.utc).timestamp()*1000))
        subset=[r for r in curve if r['timestamp']<boundary or (r['timestamp']==boundary and r['phase']==0)]
        end_value=subset[-1]['equity'] if subset else prev
        monthly.append({'month':f'2026-{m:02d}','partial':m in (3,9),'return':end_value/prev-1});prev=end_value
    return {'initialCapital':initial,'finalEquity':cash,'netReturn':cash/initial-1,'barSampledMtmMdd':mdd,
            'minCash':min_cash,'maxGrossObserved':gross_peak,'maxPositionsObserved':positions_peak,
            'costPerSide':cost,'metrics':stats(ledger),'monthly':monthly,'ledger':ledger,'audit':audit,
            'reasons':dict(collections.Counter(x['reason'] for x in audit)),
            'equityCurve':curve,'fills':fills,'integerStockFills':whole,
            'assumptions':{'fx':False,'settlementLag':False,'fillDepth':False,'limitHalts':False,'tickRounding':False,
                           'actualFills':False,'regularSessionDurationAssumedHours':None if market=='CRYPTO' else 6.5}}


def label_radar(radar: list[dict], candidates: list[dict], data: dict) -> list[dict]:
    """Ex-post outcome fields are segregated and NEVER passed back to discovery."""
    result=[];by_symbol=collections.defaultdict(list)
    for c in candidates:by_symbol[c['symbol']].append(c)
    for r in radar:
        rows=data[r['symbol']];i=r['index'];follow=[c for c in by_symbol[r['symbol']] if i<=c['signalIndex']<=i+5]
        first=min((c['signalIndex']-i for c in follow),default=None)
        detection_censored=first is None and i+5>=len(rows)
        detection='SAME_BAR' if first==0 else 'DELAYED_1_TO_5_BARS' if first is not None else 'DETECTION_WINDOW_CENSORED' if detection_censored else 'NO_SETUP_WITHIN_5_BARS'
        full=i+20<len(rows)
        result.append(r | {'detection':detection,'detectionCensored':detection_censored,'firstSetupDelayBars':first,'setupIds':[c['id'] for c in follow],
                           'outcomeCensored':not full,'outcome20BarCloseReturn':rows[i+20]['close']/rows[i]['close']-1 if full else None,
                           'max20BarHighExcursion':max(x['high'] for x in rows[i+1:i+21])/rows[i]['close']-1 if full else None,
                           'exPostOnly':True})
    return result


def fixed_position_stress(portfolio: dict, multiplier: float = 1.5) -> dict:
    if type(multiplier) not in (int, float) or not math.isfinite(multiplier) or multiplier < 1:
        raise ValueError('INVALID_COST_MULTIPLIER')
    increment = portfolio['costPerSide'] * (multiplier - 1)
    pnl = sum(r['pnl'] - r['costTurnover'] * increment for r in portfolio['ledger'])
    return {'netReturn':pnl / portfolio['initialCapital'], 'tradeCount':len(portfolio['ledger']),
            'sameQuantities':True, 'sameFills':True, 'feasibilityRechecked':False,
            'interpretation':'PURE_COST_REPRICING_NOT_A_NEW_EXECUTABLE_PORTFOLIO'}


def compact(p: dict) -> dict:
    return {k:p[k] for k in ('netReturn','barSampledMtmMdd','metrics','monthly','reasons','minCash','maxGrossObserved','initialCapital')}


def run(snapshot_path: Path, output: Path) -> dict:
    raw=snapshot_path.read_bytes()
    if digest(raw)!=SNAPSHOT_SHA:raise ValueError('PINNED_SNAPSHOT_HASH_MISMATCH')
    snap=json.loads(raw)
    if snap['window']!=[START,END]:raise ValueError('WINDOW_IDENTITY_MISMATCH')
    output.mkdir(parents=True,exist_ok=True)
    # Persist policy before evaluating any new strategy outcomes. Historical interval already seen.
    policy=copy.deepcopy(POLICY)
    (output/'frozen-policy.json').write_text(json.dumps(policy,indent=2)+'\n')
    spec=[('KR_THEME','KR','kr','069500'),('US_THEME','US','us','SPY'),
          ('US_EXPLOSION_PROXY','US','us','SPY'),('CRYPTO_THEME','CRYPTO','crypto',None)]
    summaries=[];all_detail=[];radar_report={};coverage={};loss_report=[]
    for lane,market,key,benchmark in spec:
        data={};blocked=[];warnings=[]
        for symbol,rows in snap['lanes'][key]['data'].items():
            try:
                ws=validate_rows(rows,market)
                if ws:blocked.append({'symbol':symbol,'reason':'PRICE_SCALE_REVIEW_REQUIRED','warnings':ws});continue
                data[symbol]=rows
            except ValueError as e:blocked.append({'symbol':symbol,'reason':str(e)})
        coverage[lane]={'sourceCount':len(snap['lanes'][key]['data']),'acceptedCount':len(data),'requestedCount':len(snap['requested'][key]),
                        'providerFailures':snap['lanes'][key]['failures'],'blocked':blocked,'allMarketCoverage':False}
        inds={s:indicators(r) for s,r in data.items()};indexes={s:{r['timestamp']:i for i,r in enumerate(rs)} for s,rs in data.items()}
        candidates=[];radar=[]
        for symbol,rows in sorted(data.items()):
            if symbol==benchmark:continue
            cs,rs=discover(rows,symbol,market,lane)
            for c in cs:c['theme']=theme_context(c,data,inds,indexes)
            candidates.extend(cs);radar.extend(rs)
        # No historical winner selection; save all causal candidates before attaching labels.
        (output/f'{lane}-candidates.json').write_text(json.dumps(candidates,separators=(',',':')))
        labeled=label_radar(radar,candidates,data)
        radar_report[lane]={'events':labeled,'episodeCounts':dict(collections.Counter(x['detection'] for x in labeled)),
                            'interpretation':'BOUNDED_RADAR_EPISODES_OVERLAP_NOT_INDEPENDENT_OPPORTUNITIES'}
        families=('EXPLOSION_CONTINUATION',) if lane=='US_EXPLOSION_PROXY' else FAMILIES
        for family in families:
            cs=[c for c in candidates if c['family']==family]
            plans=[make_plan(c,data[c['symbol']]) for c in cs]
            paths={p['candidate']['id']:price_path(p,data[p['candidate']['symbol']],inds[p['candidate']['symbol']]) for p in plans}
            cost=POLICY['costPerSide'][lane]
            for theme_on in (False,True):
                normal=replay(plans,paths,data,lane,theme_on,cost)
                resized=replay(plans,paths,data,lane,theme_on,cost*1.5)
                fixed=fixed_position_stress(normal)
                assert fixed['netReturn']<=normal['netReturn']+1e-9
                summary={'lane':lane,'family':family,'themeFilter':theme_on,'rawCandidates':len(cs),
                         'riskEligible':sum(not p['blockers'] for p in plans), 'normal':compact(normal),
                         'fixedPositionStress':fixed,'policyResizedStress':compact(resized)}
                summaries.append(summary)
                all_detail.append({'lane':lane,'family':family,'themeFilter':theme_on,'normal':normal,'policyResizedStress':resized})
                byid={p['candidate']['id']:p for p in plans}
                byledger={r['id']:r for r in normal['ledger']}
                for a in normal['audit']:
                    p=byid[a['id']];rs=data[p['candidate']['symbol']];i=p['candidate']['signalIndex']
                    end=i+20;valid=end<len(rs)
                    loss_report.append({'lane':lane,'family':family,'themeFilter':theme_on,**a,
                        'netPnl':byledger.get(a['id'],{}).get('pnl'),
                        'exitReason':byledger.get(a['id'],{}).get('exitReason'),
                        'forward20CloseReturn':rs[end]['close']/rs[i]['close']-1 if valid else None,
                        'forwardOutcomeCensored':not valid,'exPostDiagnosisOnly':True})
    result={'schemaVersion':3,'policy':policy,'policySha256':digest(policy),'sourceSnapshotSha256':digest(raw),
            'summary':summaries,'coverage':coverage,'radarCounts':{k:v['episodeCounts'] for k,v in radar_report.items()},
            'combinedReturn':None,'decision':'RESEARCH_HOLD_POST_SELECTION_NO_INDEPENDENT_OOS',
            'executionAuthority':'NONE','actualOrders':0,'canonicalSampleDelta':0,'profitabilityProven':False,
            'limitations':['STATIC_SURVIVOR_BIASED_UNIVERSE','NO_PIT_NEWS_FLOAT_DILUTION','NO_INDEPENDENT_OOS',
                'NO_ORDERBOOK_HALT_FILL_LATENCY','NO_EXCHANGE_TICK_ROUNDING','NO_CASH_SETTLEMENT_DELAY',
                'BAR_SAMPLED_NOT_INTRABAR_MDD','NO_FX_COMBINED_PORTFOLIO','DAY_PROXY_NOT_US_MICROCAP_1M',
                'OVERLAPPING_RADAR_LABELS_NOT_INDEPENDENT_SAMPLES']}
    for name,value in [('result.json',result),('portfolio-ledgers.json',all_detail),('radar-diagnosis.json',radar_report),('admission-diagnosis.json',loss_report)]:
        (output/name).write_text(json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n')
    lines=['# Independent Discovery V3 — exploratory research','',
           'Window: 2026-03-25..2026-09-24. Three fixed discovery families; no grid or return-driven retuning.',
           'All returns are simulated separate native-currency accounts, never actual fills or independent OOS.',
           '', '| Lane | Family | Theme filter | Candidates | Accepted | Win % | Return % | MTM MDD % | Fixed cost stress % | Resized cost stress % |',
           '|---|---|---|---:|---:|---:|---:|---:|---:|---:|']
    def pc(x):return 'NA' if x is None else f'{x*100:.3f}'
    for r in summaries:
        n=r['normal'];lines.append(f'| {r["lane"]} | {r["family"]} | {r["themeFilter"]} | {r["rawCandidates"]} | {n["metrics"]["trades"]} | {pc(n["metrics"]["winRate"])} | {pc(n["netReturn"])} | {pc(n["barSampledMtmMdd"])} | {pc(r["fixedPositionStress"]["netReturn"])} | {pc(r["policyResizedStress"]["netReturn"])} |')
    lines+=['',f'Pinned source SHA256: {SNAPSHOT_SHA}',f'Policy SHA256: {result["policySha256"]}',
            'Decision: RESEARCH_HOLD. Zero trades is not a winning strategy. No selected champion.',
            'No Telegram / Paper activation / private API / real order / deploy / Replit.','']
    (output/'result.md').write_text('\n'.join(lines))
    return result


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--snapshot',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    args=p.parse_args()
    result=run(args.snapshot,args.output)
    print((args.output/'result.md').read_text())
    print('V3_OFFLINE_DISCOVERY_FINISHED',len(result['summary']))


if __name__=='__main__':main()
