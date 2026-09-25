#!/usr/bin/env python3
"""Three preregistered entry/priority hypotheses. Offline research, no execution.

Frozen V3 accounting and V5 full-runner exits are reused. Only a guarded
priority expression is injected into an isolated replay namespace; baseline
must reproduce the pinned V5 ledger before any new result is accepted.
"""
from __future__ import annotations
import argparse
import bisect
import collections
import copy
import datetime as dt
import hashlib
import importlib.util
import inspect
import json
import math
from pathlib import Path
import statistics
import textwrap
import zipfile

BAR = 14_400_000
DAY = 86_400_000
V5_SHA = '4a40304b6143bc95d98bc78ddebba41f6a24cee093864261ae63f794da6ab77c'
V5_RESULT_SHA = 'f326cddc5e2001e6a1a72f33cf76431f8a034faf9280b245aaafe33261167e2e'
WINDOWS = (
    ('PRIOR_H1',1742860800000,1758758400000),
    ('PRIOR_H2',1758758400000,1774396800000),
    ('RECENT_6M',1774396800000,1790294400000),
)
ARMS = ('BASELINE','SYMBOL_DAILY_TREND','RELATIVE_STRENGTH_PRIORITY','COMPRESSION_BREAKOUT')
CONTRACT = {
    'id':'selective-opportunity-entry-priority-v6',
    'registeredHubComment':5826622916,
    'baselineHead':'1eb9e39a670f8a75765ded5f2146c56e31993a90',
    'v5CodeSha256':V5_SHA,'v5ResultSha256':V5_RESULT_SHA,
    'windows':WINDOWS,'arms':ARMS,'newHypotheses':3,
    'dailyTrend':{'completedUtcDaysOnly':True,'smaDays':20,'slopeLagDays':5,
                  'minimumCompleteDailyBars':25,'requireCloseAboveSma':True},
    'priority':{'sameSignalAndEntryTimestampOnly':True,'returnBars':30,
                'score':'(ownLogReturn30-BTCLogReturn30)/ownStdDev30LogReturns',
                'secondary':'mean20ClosedBarCloseTimesVolume',
                'missing':'RANK_AFTER_KNOWN_NOT_ZERO_SIGNAL_OR_INVENTED_SCORE'},
    'compression':{'lookbackBars':12,'precedingRangeRatioMaximum':.8,
                   'firstCrossOnly':True,'minimumRelativeVolume':1.2,'requireDailyTrend':True},
    'exit':'FROZEN_V5_FULL_RUNNER_AFTER_2R','riskChanged':False,'costPerSide':.0015,
    'costStressMultiplier':1.5,'themeEntryGate':False,
    'monthlyTarget':[.03,.05,.10],
    'researchScreen':{'minimumTradesEachWindow':30,'maximumBarMtmMdd':.12,
                      'minimumGeometricMonthlyEachWindowNormalAndStress':.03},
    'screenIsNotUserRiskAuthorization':True,'monthlyConsistencyReportedSeparately':True,
    'classification':'POST_SELECTION_EXPLORATORY_ALL_WINDOWS_ALREADY_OBSERVED',
    'parameterGrid':False,'selectedChampion':None,'independentOos':False,
    'profitabilityProven':False,'canonicalSampleDelta':0,'actualOrders':0,
    'executionAuthority':'NONE','telegramSent':0,'providerCalls':0,
}


def packed(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def save(path,value):
    Path(path).write_bytes(packed(value)+b'\n')


def frozen_v5():
    path=Path(__file__).with_name('selective_opportunity_exit_attribution_v5.py')
    if sha(path.read_bytes())!=V5_SHA:raise ValueError('FROZEN_V5_CHANGED')
    spec=importlib.util.spec_from_file_location('frozen_v5_for_v6',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def complete_days(rows):
    """A daily close becomes visible only after all six constituent bars close."""
    grouped=collections.defaultdict(list)
    for row in rows:grouped[row['timestamp']//DAY*DAY].append(row)
    days=[]
    for start,bars in sorted(grouped.items()):
        bars=sorted(bars,key=lambda r:r['timestamp'])
        if [r['timestamp'] for r in bars]!=list(range(start,start+DAY,BAR)):continue
        if not all(type(r.get('close')) in (int,float) and math.isfinite(r['close']) and r['close']>0 for r in bars):
            raise ValueError('INVALID_DAILY_CLOSE')
        days.append({'start':start,'availableAt':start+DAY,'close':bars[-1]['close']})
    return days


def daily_context(days,known_at):
    end=bisect.bisect_right([d['availableAt'] for d in days],known_at)
    history=days[max(0,end-25):end]
    if len(history)<25 or any(b['start']-a['start']!=DAY for a,b in zip(history,history[1:])):
        return {'passed':False,'reason':'COMPLETE_DAILY_HISTORY_MISSING','availableAt':None}
    sma=sum(d['close'] for d in history[-20:])/20
    old=sum(d['close'] for d in history[:20])/20
    good=history[-1]['close']>sma and sma>old
    return {'passed':good,'reason':None if good else 'SYMBOL_DAILY_TREND_NOT_CONFIRMED',
            'availableAt':history[-1]['availableAt'],'close':history[-1]['close'],'sma20':sma,'sma20Lag5':old}


def momentum_context(rows,index,btc,btc_index):
    if index<30 or btc_index is None or btc_index<30:
        return {'score':None,'turnover':None,'reason':'MOMENTUM_HISTORY_MISSING','availableAt':None}
    own=rows[index-30:index+1];bench=btc[btc_index-30:btc_index+1]
    if [r['timestamp'] for r in own]!=[r['timestamp'] for r in bench]:
        return {'score':None,'turnover':None,'reason':'BENCHMARK_TIME_MISMATCH','availableAt':None}
    rr=[math.log(b['close']/a['close']) for a,b in zip(own,own[1:])]
    sd=statistics.pstdev(rr)
    if not math.isfinite(sd) or sd<=1e-12:
        return {'score':None,'turnover':None,'reason':'ZERO_OR_INVALID_VOLATILITY','availableAt':None}
    score=(math.log(own[-1]['close']/own[0]['close'])-math.log(bench[-1]['close']/bench[0]['close']))/sd
    turn=sum(r['close']*r['volume'] for r in rows[index-19:index+1])/20
    return {'score':score,'turnover':turn,'reason':None,'availableAt':own[-1]['timestamp']+BAR}


def entry_priority(candidate,arm):
    if arm not in ARMS:raise ValueError('UNKNOWN_ARM')
    if arm!='RELATIVE_STRENGTH_PRIORITY':return (candidate['signalTimestamp'],-candidate['rvol'])
    info=candidate['decision']['momentum'];score=info['score']
    if info['availableAt'] is not None and info['availableAt']>candidate['knownAt']:
        raise ValueError('FUTURE_RANK_INPUT')
    if score is None:return (candidate['signalTimestamp'],1,0,0,-candidate['rvol'])
    return (candidate['signalTimestamp'],0,-score,-info['turnover'],-candidate['rvol'])


def priority_replay(v,arm):
    """Replace exactly one priority expression, never accounting or risk logic."""
    source=textwrap.dedent(inspect.getsource(v.replay))
    anchor="(c['signalTimestamp'],-c['rvol'])"
    if source.count(anchor)!=1:raise ValueError('REPLAY_PRIORITY_SEAM_CHANGED')
    namespace=dict(v.__dict__)
    namespace['entry_priority_hook']=lambda c:entry_priority(c,arm)
    exec(compile(source.replace(anchor,'entry_priority_hook(c)'),'<pinned-v3-priority-seam>','exec'),namespace)
    return namespace['replay']


def compression_candidates(v,rows,symbol,days):
    ind=v.indicators(rows);out=[]
    for i in range(60,len(rows)):
        row=rows[i]
        if not v.START<=row['timestamp']<v.END:continue
        recent=rows[i-12:i];old=rows[i-24:i-12]
        level=max(r['high'] for r in recent)
        previous_level=max(r['high'] for r in rows[i-13:i-1])
        recent_range=level-min(r['low'] for r in recent)
        old_range=max(r['high'] for r in old)-min(r['low'] for r in old)
        if not(old_range>0 and recent_range<=.8*old_range and row['close']>level
               and rows[i-1]['close']<=previous_level and ind[i]['rvol']>=1.2):continue
        known=row['timestamp']+BAR
        out.append({'id':f'CRYPTO_THEME:{symbol}:COMPRESSION_BREAKOUT:{int(row["timestamp"])}',
                    'lane':'CRYPTO_THEME','market':'CRYPTO','symbol':symbol,'family':'COMPRESSION_BREAKOUT',
                    'signalIndex':i,'signalTimestamp':row['timestamp'],'knownAt':known,'originIndex':i,
                    'atr':ind[i]['atr'],'rvol':ind[i]['rvol'],
                    'compression':{'recentRange':recent_range,'priorRange':old_range,'level':level},
                    'dailyEntryCheck':daily_context(days,known)})
    return out


def anniversary_months(portfolio,start,end):
    boundaries=[];date=dt.datetime.fromtimestamp(start/1000,dt.timezone.utc)
    while int(date.timestamp()*1000)<=end:
        boundaries.append(int(date.timestamp()*1000))
        date=date.replace(year=date.year+1,month=1) if date.month==12 else date.replace(month=date.month+1)
    if boundaries[-1]!=end:raise ValueError('INCOMPLETE_ANNIVERSARY_MONTH_WINDOW')
    curve=portfolio['equityCurve'];keys=[(r['timestamp'],r['phase']) for r in curve]
    previous=portfolio['initialCapital'];out=[]
    for a,b in zip(boundaries,boundaries[1:]):
        j=bisect.bisect_right(keys,(b,0))-1
        ending=curve[j]['equity'] if j>=0 else previous
        out.append({'start':a,'endExclusive':b,'netReturn':ending/previous-1})
        previous=ending
    if abs(math.prod(1+r['netReturn'] for r in out)-(1+portfolio['netReturn']))>1e-9:
        raise ValueError('MONTHLY_GROWTH_RECONCILIATION')
    return out


def target_metrics(portfolio,start,end):
    months=anniversary_months(portfolio,start,end);n=len(months)
    return {'months':months,'monthCount':n,'geometricMonthlyEquivalent':(1+portfolio['netReturn'])**(1/n)-1,
            'month3PercentCount':sum(m['netReturn']>=.03 for m in months),
            'month5PercentCount':sum(m['netReturn']>=.05 for m in months),
            'month10PercentCount':sum(m['netReturn']>=.10 for m in months),
            'negativeMonthCount':sum(m['netReturn']<0 for m in months),
            'worstMonth':min(m['netReturn'] for m in months),
            'allMonthsAtLeast3Percent':all(m['netReturn']>=.03 for m in months),
            'sixMonthSimple18Percent':portfolio['netReturn']>=.18,
            'sixMonthCompound3Percent':portfolio['netReturn']>=1.03**n-1}


def concentration(portfolio):
    ledger=portfolio['ledger'];best=sorted(ledger,key=lambda r:r['pnl'],reverse=True)[:3]
    return {'top3':[{'symbol':r['symbol'],'pnl':r['pnl']} for r in best],
            'remainingFixedLedgerPnl':sum(r['pnl'] for r in ledger)-sum(r['pnl'] for r in best),
            'reading':'CONTRIBUTION_ONLY_NOT_EXCLUDING_WINNERS_REPLAY'}


def admission_attribution(detail, contexts):
    """Explain changes, never feed retrospective profit back into selection."""
    out=[]
    for name,_,_ in WINDOWS:
        base=next(x['normal'] for x in detail if x['window']==name and x['arm']=='BASELINE')
        original_ids={x['id'] for x in base['ledger']}
        source={x['id']:x for x in contexts[name]}
        for arm in ARMS[1:]:
            other=next(x['normal'] for x in detail if x['window']==name and x['arm']==arm)
            ids={x['id'] for x in other['ledger']}
            row={'window':name,'arm':arm,'sameEntryIds':len(ids&original_ids),
                 'addedEntryIds':len(ids-original_ids),'removedEntryIds':len(original_ids-ids),
                 'reasons':other['reasons'],'exPostDiagnosticOnly':True}
            if arm=='SYMBOL_DAILY_TREND':
                removed=[x for x in base['ledger'] if not source[x['id']]['decision']['daily']['passed']]
                row['baselineEntriesBlockedByDaily']={
                    'count':len(removed),'wins':sum(x['pnl']>0 for x in removed),
                    'losses':sum(x['pnl']<0 for x in removed),'fixedLedgerPnl':sum(x['pnl'] for x in removed),
                    'counterfactualPortfolio':False}
            out.append(row)
    return out


def prepare(v5,adapter,contents,name,start,end):
    v=adapter.load_v3(start,end)
    source=contents['recentSource']['lanes']['crypto']['data'] if name=='RECENT_6M' else contents['oldSource']['data']
    data={};blocked=[]
    for symbol,original in source.items():
        try:
            rows=original if name=='RECENT_6M' else adapter.usable_series(original,start,end)
            if v.validate_rows(rows,'CRYPTO'):raise ValueError('PRICE_SCALE_REVIEW_REQUIRED')
            data[symbol]=rows
        except ValueError as e:blocked.append({'symbol':symbol,'reason':str(e)})
    inds={s:v.indicators(r) for s,r in data.items()}
    indexes={s:{r['timestamp']:i for i,r in enumerate(rows)} for s,rows in data.items()}
    days={s:complete_days(rows) for s,rows in data.items()}
    base=[];compression=[]
    for symbol,rows in sorted(data.items()):
        cs,_=v.discover(rows,symbol,'CRYPTO','CRYPTO_THEME')
        cs=[c for c in cs if c['family']=='FIRST_RETEST']
        new=compression_candidates(v,rows,symbol,days[symbol])
        for c in cs+new:
            c['theme']=v.theme_context(c,data,inds,indexes)
            c['decision']={'daily':daily_context(days[symbol],c['knownAt']),
                           'momentum':momentum_context(rows,c['signalIndex'],data.get('BTC',[]),indexes.get('BTC',{}).get(c['signalTimestamp']))}
        base+=cs;compression+=new
    return v,data,inds,base,compression,{'requested':25,'accepted':len(data),'symbols':sorted(data),
                                       'blocked':blocked,'unavailable':sorted(set(adapter.known_symbols())-set(data))}


def compare_saved_baseline(normal,stored):
    # Decision metadata is not stored in the ledger or fills and cannot change admission.
    for key in ('ledger','fills','audit','equityCurve','netReturn','barSampledMtmMdd','reasons'):
        if normal[key]!=stored[key]:raise ValueError('V5_BASELINE_NOT_REPRODUCED:'+key)


def run(inputs,baseline_path,output):
    output.mkdir(parents=True,exist_ok=True)
    save(output/'preregistration.json',CONTRACT)
    v5=frozen_v5();adapter=v5.transfer_module();contents=v5.read_archives(inputs)
    baseline_raw=Path(baseline_path).read_bytes()
    if sha(baseline_raw)!='715f504d19648bd3d06b8d445e0021905ef145a49fe006ba00d7e6db8cca035b':
        raise ValueError('PINNED_V5_LEDGER_CHANGED')
    baseline=json.loads(baseline_raw)
    stored=next(x['normal'] for x in baseline if x['period']=='RECENT_6M' and x['family']=='FIRST_RETEST' and x['exitArm']=='FULL_RUNNER_AFTER_2R')
    all_rows=[];detail=[];cover={};contexts={};reproduced=False
    for name,start,end in WINDOWS:
        v,data,inds,base,compression,cov=prepare(v5,adapter,contents,name,start,end);cover[name]=cov
        save(output/(name+'-candidate-context.json'),{'baseline':base,'compression':compression});contexts[name]=base
        for arm in ARMS:
            candidates=copy.deepcopy(compression if arm=='COMPRESSION_BREAKOUT' else base)
            plans=[]
            for c in candidates:
                p=v.make_plan(c,data[c['symbol']])
                if arm in ('SYMBOL_DAILY_TREND','COMPRESSION_BREAKOUT') and not c['decision']['daily']['passed']:
                    p['blockers'].append(c['decision']['daily']['reason'])
                plans.append(p)
            paths={p['candidate']['id']:v5.exit_path(v,p,data[p['candidate']['symbol']],inds[p['candidate']['symbol']],'FULL_RUNNER_AFTER_2R') for p in plans}
            replay=priority_replay(v,arm)
            normal=replay(plans,paths,data,'CRYPTO_THEME',False,.0015)
            stress=replay(plans,paths,data,'CRYPTO_THEME',False,.00225)
            if arm=='BASELINE':
                unchanged=v.replay(plans,paths,data,'CRYPTO_THEME',False,.0015)
                if normal!=unchanged:raise ValueError('PRIORITY_DEFAULT_CHANGED_ACCOUNTING')
                if name=='RECENT_6M':compare_saved_baseline(normal,stored);reproduced=True
            for p in (normal,stress):
                p['monthly']=adapter.monthly_from_curve(p['equityCurve'],p['initialCapital'],start,end)
                if p['minCash']<-.00001 or p['maxGrossObserved']>1.000001 or p['maxPositionsObserved']>5:
                    raise ValueError('ACCOUNT_RISK_INVARIANT')
            fixed=v.fixed_position_stress(normal)
            target=target_metrics(normal,start,end);stress_target=target_metrics(stress,start,end)
            good=normal['metrics']['trades']>=30 and normal['barSampledMtmMdd']<=.12 and target['geometricMonthlyEquivalent']>=.03 and stress_target['geometricMonthlyEquivalent']>=.03 and fixed['netReturn']>=1.03**6-1
            row={'window':name,'arm':arm,'start':start,'endExclusive':end,'rawCandidates':len(candidates),
                 'normal':v.compact(normal),'policyResizedStress':v.compact(stress),'fixedPositionStress':fixed,
                 'target':target,'stressTarget':stress_target,'concentration':concentration(normal),
                 'researchScreenPass':good,'monthlyConsistencyPass':target['allMonthsAtLeast3Percent'],
                 'decision':'NUMERIC_TARGET_UNMET' if not target['sixMonthCompound3Percent'] else 'NUMERIC_ONLY_STABILITY_UNPROVEN'}
            all_rows.append(row);detail.append({'window':name,'arm':arm,'normal':normal,'policyResizedStress':stress})
            print(name,arm,'N',normal['metrics']['trades'],'net',round(normal['netReturn']*100,3),'MDD',round(normal['barSampledMtmMdd']*100,3),flush=True)
    if not reproduced:raise ValueError('BASELINE_PROOF_REQUIRED')
    passing=[a for a in ARMS if all(r['researchScreenPass'] for r in all_rows if r['arm']==a)]
    result={'contract':CONTRACT,'contractSha256':sha(packed(CONTRACT)),'inputArchiveHashes':v5.ARCHIVES,
            'baselineLedgerSha256':sha(baseline_raw),'summary':all_rows,'coverage':cover,'baselineReproduced':True,
            'allWindowScreenPassingArms':passing,'selectedChampion':None,'independentOos':False,
            'profitabilityProven':False,'canonicalSampleDelta':0,'executionAuthority':'NONE','actualOrders':0,
            'providerCalls':0,'combinedReturn':None,'decision':'RESEARCH_HOLD_OBSERVED_HISTORY'}
    save(output/'result.json',result);save(output/'portfolio-ledgers.json',detail)
    save(output/'admission-attribution.json',admission_attribution(detail,contexts))
    save(output/'provenance.json',{'contractSha256':result['contractSha256'],'analysisCodeSha256':sha(Path(__file__).read_bytes()),
         'resultSha256':sha((output/'result.json').read_bytes()),'baselineReproduced':True,'inputArchiveHashes':v5.ARCHIVES,
         'independentOos':False,'providerCalls':0,'executionAuthority':'NONE'})
    return result


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for key in ('v2','v3','v4'):p.add_argument('--'+key+'-zip',type=Path,required=True)
    p.add_argument('--v5-ledger',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    args=p.parse_args();run({k:getattr(args,k+'_zip') for k in ('v2','v3','v4')},args.v5_ledger,args.output)
