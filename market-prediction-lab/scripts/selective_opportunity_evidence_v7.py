#!/usr/bin/env python3
"""Source-inspired candle/confirmed-structure/numerical ML research; no network/orders.
Neither paper replication nor untouched OOS. No price targets supplied by an LLM.
"""
from __future__ import annotations
import argparse, bisect, collections, copy, datetime as dt, hashlib, importlib.util
import json, math, os, statistics, warnings
from pathlib import Path

BAR=14_400_000; DAY=86_400_000
V6_SHA='40df983e59b2685439d8c54341c5c66ba928171688c099e5ec3bbbfa04358288'
ARMS=('V5_REFERENCE','CANDLE_RECOVERY','CONFIRMED_STRUCTURE_BREAK','UNION_CONTROL','PAST_ONLY_ML_GATE')
FEATURES=('body_atr','lower_atr','upper_atr','close_location','engulfing','hammer','higher_low',
          'pivot_gap_atr','rsi14','macd_atr','macd_hist_atr','atr_fraction','rvol','return3','return18',
          'ema20_distance','btc_relative18','daily_close_sma20','daily_slope5','daily_missing',
          'source_retest','source_candle','source_structure')
CONTRACT={
 'id':'selective-opportunity-source-evidence-v7','registeredHubComment':5826876950,'v6Sha256':V6_SHA,
 'arms':ARMS,'newHypotheses':3,'unionIsPairedControl':True,
 'candle':{'engulf':'previous down/current up/body fully covered','hammer':'lower>=2body;upper<=body;body>0;up',
           'prior3BarReturnBelow':0,'rsi14Maximum':55,'rsiMustRise':True,'rvolMinimum':1},
 'structure':{'left':2,'right':2,'strictExtrema':True,'higherLow':True,'confirmedOnly':True,'rvolMinimum':1.2},
 'features':FEATURES,'rsi':'Wilder SMA14 seed then alpha1/14','macd':'EMA12-EMA26,EMA9 signal,first-close seed',
 'daily':'6complete4hbars,25continuousUTCdays,not mandatory gate',
 'ml':{'implementation':'sklearn.ensemble.HistGradientBoostingClassifier','sklearnVersion':'1.8.0',
       'max_iter':100,'max_leaf_nodes':7,'min_samples_leaf':25,'l2_regularization':5.,'learning_rate':.05,
       'early_stopping':False,'random_state':42,'scoreCutoff':.55,'minTrainingRows':150,'minEachClass':40,
       'horizonBars':18,'embargoBars':1,'refit':'at first candidate of each UTC calendar month using data before month start',
       'training':'only current evaluation window; label-end strictly before cutoff minus one bar; nonoverlap per symbol',
       'label':'next-open to18thbarclose net positive at .15%/side; NOT probability of actual runner profit',
       'calibration':'NOT_CALIBRATED_OR_CERTIFIED','trainingEventWeight':'inverse same-knownAt count,normalized mean1'},
 'riskOrExitChanges':False,'costPerSide':.0015,'stressMultiplier':1.5,'exit':'V5_FULL_RUNNER_AFTER_2R',
 'monthlyTarget':[.03,.05,.10],'screenNotUserRiskPermission':True,
 'classification':'POST_SELECTION_EXPLORATORY_SOURCE_INSPIRED_NOT_PAPER_REPLICATION',
 'pretrainedModelUsed':False,'independentOos':False,'profitabilityProven':False,'selectedChampion':None,
 'providerCalls':0,'actualOrders':0,'telegramSent':0,'canonicalSampleDelta':0,'executionAuthority':'NONE',
}
def packed(x):return json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
def sha(x):return hashlib.sha256(x).hexdigest()
def save(path,x):Path(path).write_bytes(packed(x)+b'\n')
def v6_module():
 p=Path(__file__).with_name('selective_opportunity_entry_priority_v6.py')
 if sha(p.read_bytes())!=V6_SHA:raise ValueError('FROZEN_V6_CHANGED')
 s=importlib.util.spec_from_file_location('pinned_v6_for_v7',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def candle_shape(current,previous):
 o,h,l,c=[current[k] for k in ('open','high','low','close')]
 if not all(math.isfinite(x) for x in (o,h,l,c)) or min(o,h,l,c)<=0 or h<max(o,c) or l>min(o,c):raise ValueError('INVALID_CANDLE')
 body=abs(c-o);lower=min(o,c)-l;upper=h-max(o,c);span=h-l
 eng=previous['close']<previous['open'] and c>o and o<=previous['close'] and c>=previous['open']
 hammer=c>o and body>0 and lower>=2*body and upper<=body
 return {'body':body,'lower':lower,'upper':upper,'location':(c-l)/span if span>0 else .5,
         'engulfing':eng,'hammer':hammer}

def technical_series(rows):
 """Every state at i only reads rows[:i+1]; pivots retain confirmation time."""
 result=[];hi=[];lo=[];gain=loss=None;ema12=ema26=signal=ema20=rows[0]['close']
 signal=0.
 for i,r in enumerate(rows):
  c=r['close']
  if i:
   ema12+=2/13*(c-ema12);ema26+=2/27*(c-ema26);ema20+=2/21*(c-ema20)
  macd=ema12-ema26;signal+=2/10*(macd-signal)
  rsi=None
  if i==14:
   diffs=[rows[j]['close']-rows[j-1]['close'] for j in range(1,15)]
   gain=sum(max(x,0) for x in diffs)/14;loss=sum(max(-x,0) for x in diffs)/14
  elif i>14:
   diff=c-rows[i-1]['close'];gain=(gain*13+max(diff,0))/14;loss=(loss*13+max(-diff,0))/14
  if i>=14:rsi=50. if gain==0 and loss==0 else 100. if loss==0 else 100-100/(1+gain/loss)
  if i>=4:
   j=i-2;other=rows[j-2:j]+rows[j+1:j+3]
   p={'index':j,'confirmedIndex':i,'availableAt':r['timestamp']+BAR}
   if all(rows[j]['high']>x['high'] for x in other):hi.append(p|{'price':rows[j]['high']})
   if all(rows[j]['low']<x['low'] for x in other):lo.append(p|{'price':rows[j]['low']})
  higher=len(lo)>=2 and lo[-1]['price']>lo[-2]['price']
  between=[x for x in hi if len(lo)>=2 and lo[-2]['index']<x['index']<lo[-1]['index']]
  resistance=max(between,key=lambda x:x['price']) if higher and between else None
  shape=candle_shape(r,rows[max(0,i-1)])
  result.append({'rsi':rsi,'macd':macd,'hist':macd-signal,'ema20':ema20,'shape':shape,'higherLow':higher,
                 'lastLow':dict(lo[-1]) if lo else None,'resistance':dict(resistance) if resistance else None,
                 'knownAt':r['timestamp']+BAR})
 return result

def source_candidates(v,rows,symbol,ind,tech):
 out=[]
 for i in range(60,len(rows)):
  r=rows[i];x=tech[i];prev=tech[i-1]
  if not v.START<=r['timestamp']<v.END:continue
  family=[]
  recovery=(x['shape']['engulfing'] or x['shape']['hammer']) and rows[i-1]['close']<rows[i-4]['close'] and r['close']>rows[i-1]['close'] and x['rsi']>prev['rsi'] and x['rsi']<55 and ind[i]['rvol']>=1
  if recovery:family.append('CANDLE_RECOVERY')
  level=x['resistance']
  if level and level['availableAt']<=x['knownAt'] and r['close']>level['price'] and rows[i-1]['close']<=level['price'] and ind[i]['rvol']>=1.2:
   family.append('CONFIRMED_STRUCTURE_BREAK')
  for f in family:
   out.append({'id':f'CRYPTO_THEME:{symbol}:{f}:{int(r["timestamp"])}','lane':'CRYPTO_THEME','market':'CRYPTO','symbol':symbol,
     'family':f,'signalIndex':i,'signalTimestamp':r['timestamp'],'knownAt':r['timestamp']+BAR,'originIndex':i,
     'atr':ind[i]['atr'],'rvol':ind[i]['rvol']})
 return out

def feature_vector(c,rows,tech,btc,btc_indexes,days,v6):
 i=c['signalIndex'];t=tech[i];r=rows[i];a=c['atr'];s=t['shape'];known=c['knownAt']
 if a<=0 or t['knownAt']>known:raise ValueError('NONCAUSAL_FEATURE')
 d=v6.daily_context(days,known)
 if d['availableAt'] is not None and d['availableAt']>known:raise ValueError('FUTURE_DAILY_FEATURE')
 j=btc_indexes.get(r['timestamp'])
 if j is None or j<18 or [x['timestamp'] for x in rows[i-18:i+1]]!=[x['timestamp'] for x in btc[j-18:j+1]]:
  return None
 ret18=math.log(r['close']/rows[i-18]['close']);br=math.log(btc[j]['close']/btc[j-18]['close'])
 res=t['resistance'];families=c.get('sourceFamilies',[c['family']])
 x=[(r['close']-r['open'])/a,s['lower']/a,s['upper']/a,s['location'],float(s['engulfing']),float(s['hammer']),
    float(t['higherLow']),max(-10,min(10,(r['close']-res['price'])/a)) if res else 0.,
    t['rsi']/100,t['macd']/a,t['hist']/a,a/r['close'],min(c['rvol'],20),
    math.log(r['close']/rows[i-3]['close']),ret18,(r['close']-t['ema20'])/a,ret18-br,
    d['close']/d['sma20']-1 if d['availableAt'] is not None else 0.,
    d['sma20']/d['sma20Lag5']-1 if d['availableAt'] is not None else 0.,float(d['availableAt'] is None),
    float('FIRST_RETEST' in families),float('CANDLE_RECOVERY' in families),float('CONFIRMED_STRUCTURE_BREAK' in families)]
 if len(x)!=len(FEATURES) or not all(math.isfinite(v) for v in x):raise ValueError('INVALID_FEATURE_VECTOR')
 return x

def union_candidates(cs):
 groups=collections.defaultdict(list)
 for c in cs:groups[(c['symbol'],c['knownAt'])].append(c)
 out=[]
 for (s,t),items in sorted(groups.items()):
  c=copy.deepcopy(sorted(items,key=lambda c:c['family'])[0]);c['sourceFamilies']=sorted({x['family'] for x in items})
  c['family']='UNION';c['id']=f'CRYPTO_THEME:{s}:UNION:{int(c["signalTimestamp"])}';out.append(c)
 return sorted(out,key=lambda c:(c['knownAt'],c['symbol']))

def outcome_label(c,rows):
 """Evaluation-only label; never added to candidate feature data."""
 i=c['signalIndex'];end=i+18
 if end>=len(rows):return None
 start=rows[i+1];last=rows[end]
 if start['timestamp']<c['knownAt'] or last['timestamp']-start['timestamp']!=17*BAR:return None
 ret=last['close']*(1-.0015)/(start['open']*(1+.0015))-1
 return {'id':c['id'],'symbol':c['symbol'],'knownAt':c['knownAt'],'entryAt':start['timestamp'],
         'labelEnd':last['timestamp']+BAR,'label':int(ret>0),'net18Return':ret,'features':c['features']}

def training_rows(pool,cutoff):
 eligible=sorted((p for p in pool if p['features'] is not None and p['labelEnd']<cutoff-BAR),key=lambda p:(p['knownAt'],p['symbol']))
 last={};selected=[]
 for p in eligible:
  if p['entryAt']<last.get(p['symbol'],-1):continue
  last[p['symbol']]=p['labelEnd'];selected.append(p)
 return selected

def month_floor(t):
 d=dt.datetime.fromtimestamp(t/1000,dt.timezone.utc);return int(d.replace(day=1,hour=0,minute=0,second=0,microsecond=0).timestamp()*1000)

def fit_gate(pool,cutoff):
 import numpy as np
 import sklearn
 from sklearn.ensemble import HistGradientBoostingClassifier
 from threadpoolctl import threadpool_limits
 if sklearn.__version__!=CONTRACT['ml']['sklearnVersion']:raise ValueError('SKLEARN_VERSION_MISMATCH')
 train=training_rows(pool,cutoff);classes=collections.Counter(p['label'] for p in train)
 meta={'cutoff':cutoff,'trainCount':len(train),'classCounts':dict(classes),'maxLabelEnd':max((p['labelEnd'] for p in train),default=None),
       'trainDigest':sha(packed(train)),'features':FEATURES,'status':'INSUFFICIENT_TRAINING'}
 if len(train)<150 or min(classes.get(0,0),classes.get(1,0))<40:return None,meta
 counts=collections.Counter(p['knownAt'] for p in train);weights=np.array([1/counts[p['knownAt']] for p in train]);weights/=weights.mean()
 model=HistGradientBoostingClassifier(max_iter=100,max_leaf_nodes=7,min_samples_leaf=25,l2_regularization=5.,learning_rate=.05,
                                      early_stopping=False,random_state=42)
 with threadpool_limits(limits=1):model.fit(np.array([p['features'] for p in train]),np.array([p['label'] for p in train]),sample_weight=weights)
 meta.update(status='FIT_PAST_ONLY',climatology=float(np.average([p['label'] for p in train],weights=weights)),modelParameters=model.get_params())
 return model,meta

def score_candidates(candidates,pool):
 from threadpoolctl import threadpool_limits
 import numpy as np
 by_month=collections.defaultdict(list)
 for c in candidates:by_month[month_floor(c['knownAt'])].append(c)
 decisions={};models=[]
 for cutoff,cs in sorted(by_month.items()):
  model,meta=fit_gate(pool,cutoff);models.append(meta)
  valid=[c for c in cs if c['features'] is not None]
  scores={}
  if model is not None and valid:
   with threadpool_limits(limits=1):p=model.predict_proba(np.array([c['features'] for c in valid]))[:,1]
   scores={c['id']:float(y) for c,y in zip(valid,p)}
  for c in cs:
   s=scores.get(c['id']);decisions[c['id']]={'score':s,'modelCutoff':cutoff,'trainingMaxLabelEnd':meta['maxLabelEnd'],
     'passed':s is not None and s>=.55,'reason':'ML_FEATURE_MISSING' if c['features'] is None else 'ML_TRAINING_INSUFFICIENT' if model is None else 'ML_SCORE_BELOW_FIXED_CUTOFF' if s<.55 else None,
     'climatology':meta.get('climatology'),'calibratedTradeWinProbability':None}
 return decisions,models

def calibration_diagnostic(decisions,pool):
 matched=[(decisions[p['id']],p) for p in pool if p['id'] in decisions and decisions[p['id']]['score'] is not None]
 if not matched:return {'n':0,'brier':None,'label':'18bar_return_not_runner_win','certified':False}
 brier=sum((d['score']-p['label'])**2 for d,p in matched)/len(matched)
 base=sum((d['climatology']-p['label'])**2 for d,p in matched)/len(matched)
 bins=[]
 for lo,hi in [(0,.4),(.4,.55),(.55,.7),(.7,1.00000001)]:
  x=[(d,p) for d,p in matched if lo<=d['score']<hi]
  bins.append({'from':lo,'to':hi,'n':len(x),'meanScore':sum(d['score'] for d,p in x)/len(x) if x else None,
               'observed18barPositiveRate':sum(p['label'] for d,p in x)/len(x) if x else None})
 return {'n':len(matched),'brier':brier,'historicalClimatologyBrier':base,'bins':bins,
   'label':'18bar_net_return_not_runner_win','overlappingEvaluationLabels':True,'certified':False}

def run(inputs,baseline_path,output):
 output.mkdir(parents=True,exist_ok=True);save(output/'preregistration.json',CONTRACT)
 v6=v6_module();v5=v6.frozen_v5();adapter=v5.transfer_module();contents=v5.read_archives(inputs)
 saved=json.loads(Path(baseline_path).read_bytes())
 if sha(Path(baseline_path).read_bytes())!='715f504d19648bd3d06b8d445e0021905ef145a49fe006ba00d7e6db8cca035b':raise ValueError('BASELINE_LEDGER_HASH')
 saved_ref=next(x['normal'] for x in saved if x['period']=='RECENT_6M' and x['family']=='FIRST_RETEST' and x['exitArm']=='FULL_RUNNER_AFTER_2R')
 summary=[];detail=[];coverage={};ai=[];candidate_hashes={};reference_ok=False
 for name,start,end in v6.WINDOWS:
  v,data,inds,base,_,cov=v6.prepare(v5,adapter,contents,name,start,end);coverage[name]=cov
  technical={s:technical_series(r) for s,r in data.items()};days={s:v6.complete_days(r) for s,r in data.items()}
  indexes={s:{r['timestamp']:i for i,r in enumerate(rs)} for s,rs in data.items()}
  new=[]
  for symbol,rows in data.items():
   cs=source_candidates(v,rows,symbol,inds[symbol],technical[symbol])
   for c in cs:c['theme']=v.theme_context(c,data,inds,indexes)
   new+=cs
  union=union_candidates(base+new)
  for c in union:c['features']=feature_vector(c,data[c['symbol']],technical[c['symbol']],data.get('BTC',[]),indexes.get('BTC',{}),days[c['symbol']],v6)
  save(output/f'{name}-candidates.json',{'baseline':base,'new':new,'union':union})
  candidate_hashes[name]=sha((output/f'{name}-candidates.json').read_bytes())
  # Targets are segregated from candidates and only accessed by mature-label gate.
  pool=[p for c in union if (p:=outcome_label(c,data[c['symbol']])) is not None]
  decisions,models=score_candidates(union,pool)
  ai.append({'window':name,'models':models,'decisions':decisions,'diagnostic':calibration_diagnostic(decisions,pool)})
  for arm in ARMS:
   cs=base if arm=='V5_REFERENCE' else [c for c in new if c['family']==arm] if arm in ('CANDLE_RECOVERY','CONFIRMED_STRUCTURE_BREAK') else union
   plans=[]
   for c in cs:
    p=v.make_plan(c,data[c['symbol']])
    if arm=='PAST_ONLY_ML_GATE' and not decisions[c['id']]['passed']:p['blockers'].append(decisions[c['id']]['reason'])
    plans.append(p)
   paths={p['candidate']['id']:v5.exit_path(v,p,data[p['candidate']['symbol']],inds[p['candidate']['symbol']],'FULL_RUNNER_AFTER_2R') for p in plans}
   normal=v.replay(plans,paths,data,'CRYPTO_THEME',False,.0015);stress=v.replay(plans,paths,data,'CRYPTO_THEME',False,.00225)
   if arm=='V5_REFERENCE' and name=='RECENT_6M':v6.compare_saved_baseline(normal,saved_ref);reference_ok=True
   for portfolio in (normal,stress):
    portfolio['monthly']=adapter.monthly_from_curve(portfolio['equityCurve'],portfolio['initialCapital'],start,end)
    if portfolio['minCash']<-.00001 or portfolio['maxGrossObserved']>1.000001 or portfolio['maxPositionsObserved']>5:raise ValueError('PORTFOLIO_INVARIANT')
   fixed=v.fixed_position_stress(normal);target=v6.target_metrics(normal,start,end);st=v6.target_metrics(stress,start,end)
   row={'window':name,'arm':arm,'start':start,'endExclusive':end,'rawCandidates':len(cs),'normal':v.compact(normal),
       'policyResizedStress':v.compact(stress),'fixedPositionStress':fixed,'target':target,'stressTarget':st,'concentration':v6.concentration(normal),
       'researchScreenPass':normal['metrics']['trades']>=30 and normal['barSampledMtmMdd']<=.12 and target['sixMonthCompound3Percent'] and st['sixMonthCompound3Percent'] and fixed['netReturn']>=1.03**6-1,
       'decision':'TARGET_UNMET' if not target['sixMonthCompound3Percent'] else 'NUMBER_ONLY_NOT_STABILITY_OR_OOS'}
   summary.append(row);detail.append({'window':name,'arm':arm,'normal':normal,'policyResizedStress':stress})
   print(name,arm,'N',normal['metrics']['trades'],'net',round(normal['netReturn']*100,3),'MDD',round(normal['barSampledMtmMdd']*100,3),flush=True)
 if not reference_ok:raise ValueError('BASELINE_PROOF_REQUIRED')
 result={'contract':CONTRACT,'contractSha256':sha(packed(CONTRACT)),'summary':summary,'coverage':coverage,'candidateHashes':candidate_hashes,
      'baselineReproduced':reference_ok,'inputArchiveHashes':v5.ARCHIVES,'allWindowScreenPassingArms':[a for a in ARMS if all(r['researchScreenPass'] for r in summary if r['arm']==a)],
      'selectedChampion':None,'profitabilityProven':False,'independentOos':False,'canonicalSampleDelta':0,'executionAuthority':'NONE','actualOrders':0,'providerCalls':0,'combinedReturn':None}
 save(output/'result.json',result);save(output/'portfolio-ledgers.json',detail);save(output/'ml-audit.json',ai)
 save(output/'provenance.json',{'codeSha256':sha(Path(__file__).read_bytes()),'resultSha256':sha((output/'result.json').read_bytes()),
      'contractSha256':result['contractSha256'],'baselineReproduced':True,'localOnlyUnlessCiVerified':True})
 return result
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__)
 for k in ('v2','v3','v4'):p.add_argument('--'+k+'-zip',type=Path,required=True)
 p.add_argument('--v5-ledger',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
 a=p.parse_args();run({k:getattr(a,k+'_zip') for k in ('v2','v3','v4')},a.v5_ledger,a.output)
