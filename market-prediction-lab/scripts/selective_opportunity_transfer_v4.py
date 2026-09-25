#!/usr/bin/env python3
"""Frozen V3 historical transfer and stock-risk audit. Research-only, no activation.

Only --collect uses the public Upbit candle endpoint. All evaluation is offline.
V3 file bytes and all trading algorithms stay unchanged; only evaluation window
and monthly reporting are adapted in an isolated module instance.
"""
from __future__ import annotations
import argparse
import collections
import copy
import datetime as dt
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request

DAY = 86_400_000
BAR = 4 * 3_600_000
UTC = dt.timezone.utc
V3_BLOB = '8245eb79ab18c955eb7c9a80d314e94b286e3c05'
V3_SHA256 = 'ad69253f5a8e075bcd8c36563c33705224d2fe0d5fec74ebd41df496e264a72b'
ORIGINAL_SNAPSHOT = 'fabcae6eabe257f0e02bfd1af1f9dabb0b5e1e79494768dd08cb589166a13702'
ENDPOINT = 'https://api.upbit.com/v1/candles/minutes/240'
START = 1742860800000  # 2025-03-25T00:00:00Z
END = 1774396800000    # 2026-03-25T00:00:00Z
MID = 1758758400000    # 2025-09-25T00:00:00Z
WARMUP = START - 30 * DAY
WINDOWS = [('FULL_YEAR', START, END), ('FIRST_HALF', START, MID), ('SECOND_HALF', MID, END)]
CONTRACT = {
    'id': 'selective-opportunity-frozen-transfer-v4',
    'engineSha256': V3_SHA256, 'originalObservedSnapshotSha256': ORIGINAL_SNAPSHOT,
    'evaluationWindow': [START, END], 'subwindows': WINDOWS, 'warmupStart': WARMUP,
    'classification': 'HISTORICAL_TRANSFER_EXPLORATORY',
    'historicalExposure': 'UNKNOWN_PRIOR_RESEARCH_MAY_HAVE_USED_THIS_HISTORY',
    'prospective': False, 'independentOos': False, 'pristineOosClaimAllowed': False,
    'universe': 'ALL_25_EXISTING_V3_REQUESTED_CRYPTO_SYMBOLS_NO_SUBSTITUTION',
    'arms': 'ALL_THREE_V3_FAMILIES_X_THEME_OFF_ON', 'parameterSearch': False,
    'riskAndEntryAndExitAndPriorityChanged': False, 'selectedChampion': None,
    'missingBars': 'BLOCK_WHOLE_SERIES_FOR_WINDOW_DO_NOT_FILL',
    'minimumWarmupBars': 60, 'sourceRawPagesArchived': True,
    'temporalNote': 'Earlier history is not forward OOS for a strategy designed after later outcomes.',
    'actualOrders': 0, 'telegramSent': 0, 'executionAuthority': 'NONE',
    'paperActivation': False, 'canonicalSampleDelta': 0, 'profitabilityProven': False,
}


def packed(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def write_json(path, value):
    Path(path).write_bytes(packed(value) + b'\n')


def now():
    return dt.datetime.now(UTC).isoformat()


def load_v3(start=None, end=None):
    path = Path(__file__).with_name('selective_opportunity_discovery_v3.py')
    raw = path.read_bytes()
    if sha(raw) != V3_SHA256:
        raise ValueError('FROZEN_V3_SOURCE_CHANGED')
    spec = importlib.util.spec_from_file_location('frozen_v3_isolated', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if start is not None:
        module.START, module.END = start, end
        module.POLICY = copy.deepcopy(module.POLICY)
        module.POLICY['window'] = [start, end]
    return module


def known_symbols():
    v3 = load_v3()
    return list(dict.fromkeys(s for members in v3.THEMES['CRYPTO'].values() for s in members))


def verify_contract(record):
    if record != json.loads(packed(CONTRACT)):
        raise ValueError('EVALUATION_CONTRACT_MISMATCH')
    return True


def parse_row(row, symbol):
    if row.get('market') != 'KRW-' + symbol:
        raise ValueError('PROVIDER_SYMBOL_MISMATCH')
    timestamp = dt.datetime.fromisoformat(row['candle_date_time_utc'].replace('Z', '+00:00'))
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=UTC)
    if timestamp.utcoffset() != dt.timedelta():
        raise ValueError('NON_UTC_CANDLE_BOUNDARY')
    result = {'timestamp': int(timestamp.timestamp()*1000)}
    for out, key in [('open','opening_price'),('high','high_price'),('low','low_price'),('close','trade_price'),('volume','candle_acc_trade_volume')]:
        value = row.get(key)
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError('NONFINITE_PROVIDER_CANDLE')
        result[out] = value
    if result['timestamp'] % BAR:
        raise ValueError('OFF_GRID_CANDLE')
    return result


def collect(output):
    output.mkdir(parents=True, exist_ok=True)
    # Write before the first request or economic evaluation, not retroactively.
    write_json(output/'preregistration.json', {'contract': CONTRACT, 'contractSha256':sha(packed(CONTRACT)),
        'recordedAt':now(), 'v3KnownLaterPeriodResults':True})
    if (output/'source.json').exists():
        raise ValueError('REFUSE_TO_OVERWRITE_HISTORICAL_SNAPSHOT')
    pages_dir = output/'raw-pages'; pages_dir.mkdir(exist_ok=True)
    symbols = known_symbols(); data = {}; failures = []; requests = []
    last_request = 0.0
    for symbol in symbols:
        cursor = END; by_time = {}; total_pages = 0
        try:
            for page in range(1, 21):
                query = urllib.parse.urlencode({'market':'KRW-'+symbol, 'to':dt.datetime.fromtimestamp(cursor/1000,UTC).isoformat(), 'count':200})
                url = ENDPOINT + '?' + query
                raw = None
                for attempt in range(3):
                    time.sleep(max(0, .14-(time.monotonic()-last_request)))
                    last_request = time.monotonic()
                    req = urllib.request.Request(url, headers={'accept':'application/json', 'user-agent':'selective-opportunity-research/4'})
                    try:
                        with urllib.request.urlopen(req, timeout=20) as response:
                            raw = response.read()
                            status = response.status
                        break
                    except urllib.error.HTTPError as exc:
                        if exc.code not in (429, 500, 502, 503, 504) or attempt == 2:
                            raise
                        retry = exc.headers.get('Retry-After', '1')
                        time.sleep(min(5, max(1, float(retry) if retry.isdigit() else 1)))
                name = f'{symbol}-{page:02d}.json'
                (pages_dir/name).write_bytes(raw)
                requests.append({'symbol':symbol, 'page':page, 'url':url, 'fetchedAt':now(),
                                 'status':status, 'rawSha256':sha(raw), 'file':'raw-pages/'+name})
                payload = json.loads(raw)
                if not isinstance(payload, list):
                    raise ValueError('INVALID_PROVIDER_PAYLOAD')
                if not payload:
                    break
                rows = [parse_row(r,symbol) for r in payload]
                oldest = min(r['timestamp'] for r in rows)
                if any(r['timestamp'] >= cursor for r in rows):
                    raise ValueError('PROVIDER_EXCLUSIVE_TO_VIOLATION')
                for r in rows:
                    if WARMUP <= r['timestamp'] < END:
                        old = by_time.get(r['timestamp'])
                        if old is not None and old != r:
                            raise ValueError('CONFLICTING_DUPLICATE_CANDLE')
                        by_time[r['timestamp']] = r
                total_pages = page
                if oldest <= WARMUP:
                    break
                if oldest >= cursor:
                    raise ValueError('NONPROGRESSING_CURSOR')
                cursor = oldest  # to is exclusive; no missing boundary candle.
            else:
                raise ValueError('PAGE_LIMIT_EXCEEDED')
            data[symbol] = [by_time[k] for k in sorted(by_time)]
        except (ValueError, KeyError, TypeError, OSError, urllib.error.URLError) as exc:
            failures.append({'symbol':symbol, 'status':'DATA_UNAVAILABLE', 'reason':str(exc), 'pagesCompleted':total_pages})
        print('SOURCE', symbol, 'bars',len(data.get(symbol,[])),flush=True)
    snapshot = {'contract':CONTRACT,'collectedAt':now(),'requested':symbols,'data':data,'failures':failures,'requests':requests,
                'privateApiCalled':False,'actualOrders':0}
    write_json(output/'source.json',snapshot)
    write_json(output/'source-manifest.json',{'sha256':sha((output/'source.json').read_bytes()),'requestCount':len(requests),
                                              'rawPages':{r['file']:r['rawSha256'] for r in requests}})
    return snapshot


def usable_series(rows, start, end):
    # Validation depends on this window and prehistory only. Later rows cannot select survivors.
    window = [r for r in rows if start-30*DAY <= r['timestamp'] < end]
    if not window:
        raise ValueError('EMPTY_WINDOW')
    v = load_v3(start,end)
    warnings = v.validate_rows(window,'CRYPTO')
    if warnings:
        raise ValueError('PRICE_SCALE_REVIEW_REQUIRED')
    before = sum(r['timestamp'] < start for r in window)
    actual = [r for r in window if start <= r['timestamp'] < end]
    expected = (end-start)//BAR
    if before < CONTRACT['minimumWarmupBars']:
        raise ValueError('WARMUP_INSUFFICIENT')
    if len(actual)!=expected or actual[0]['timestamp']!=start or actual[-1]['timestamp']+BAR!=end:
        raise ValueError('EVALUATION_PATH_INCOMPLETE')
    return window


def monthly_from_curve(curve, initial, start, end):
    result=[]; previous=initial
    d=dt.datetime.fromtimestamp(start/1000,UTC).replace(day=1,hour=0,minute=0,second=0,microsecond=0)
    while int(d.timestamp()*1000) < end:
        next_d=d.replace(year=d.year+1,month=1) if d.month==12 else d.replace(month=d.month+1)
        left=max(start,int(d.timestamp()*1000));right=min(end,int(next_d.timestamp()*1000))
        rows=[x for x in curve if x['timestamp']<right or x['timestamp']==right and x['phase']==0]
        value=rows[-1]['equity'] if rows else previous
        result.append({'month':d.strftime('%Y-%m'),'start':left,'endExclusive':right,
                       'partial':left!=int(d.timestamp()*1000) or right!=int(next_d.timestamp()*1000),
                       'return':value/previous-1})
        previous=value;d=next_d
    return result


def evaluate(snapshot, output):
    verify_contract(snapshot['contract'])
    if snapshot['requested']!=known_symbols():
        raise ValueError('UNIVERSE_SUBSTITUTION_FORBIDDEN')
    if any(k not in snapshot['requested'] for k in snapshot['data']):
        raise ValueError('EXTRA_SYMBOL_FORBIDDEN')
    output.mkdir(parents=True,exist_ok=True)
    summary=[];detail=[];coverage={}
    for name,start,end in WINDOWS:
        v=load_v3(start,end); data={};blocked=[]
        for symbol,rows in snapshot['data'].items():
            try:data[symbol]=usable_series(rows,start,end)
            except ValueError as exc:blocked.append({'symbol':symbol,'reason':str(exc)})
        coverage[name]={'requested':len(snapshot['requested']),'accepted':len(data),'blocked':blocked,
                        'providerFailures':snapshot['failures'],'symbolNames':sorted(data)}
        if not data:
            raise ValueError('ALL_SYMBOLS_BLOCKED:'+name)
        inds={s:v.indicators(r) for s,r in data.items()}
        indexes={s:{r['timestamp']:i for i,r in enumerate(rs)} for s,rs in data.items()}
        candidates=[]
        for symbol,rows in sorted(data.items()):
            cs,_=v.discover(rows,symbol,'CRYPTO','CRYPTO_THEME')
            for c in cs:c['theme']=v.theme_context(c,data,inds,indexes)
            candidates+=cs
        write_json(output/(name+'-candidates.json'),candidates)
        for family in v.FAMILIES:
            cs=[c for c in candidates if c['family']==family]
            plans=[v.make_plan(c,data[c['symbol']]) for c in cs]
            paths={p['candidate']['id']:v.price_path(p,data[p['candidate']['symbol']],inds[p['candidate']['symbol']]) for p in plans}
            for theme in (False,True):
                n=v.replay(plans,paths,data,'CRYPTO_THEME',theme,.0015)
                r=v.replay(plans,paths,data,'CRYPTO_THEME',theme,.00225)
                for p in (n,r):
                    p['monthly']=monthly_from_curve(p['equityCurve'],p['initialCapital'],start,end)
                    if not (p['minCash']>=-1e-5 and p['maxGrossObserved']<=1.000001):
                        raise ValueError('CASH_OR_GROSS_INVARIANT')
                f=v.fixed_position_stress(n)
                if f['netReturn']>n['netReturn']+1e-9:raise ValueError('COST_STRESS_INVARIANT')
                common={'window':name,'start':start,'endExclusive':end,'family':family,'themeFilter':theme,'rawCandidates':len(cs)}
                summary.append(common | {'normal':v.compact(n),'fixedPositionStress':f,'policyResizedStress':v.compact(r)})
                detail.append(common | {'normal':n,'policyResizedStress':r})
    result={'contract':CONTRACT,'contractSha256':sha(packed(CONTRACT)),'engineSha256':V3_SHA256,'coverage':coverage,
            'summary':summary,'decision':'RESEARCH_HOLD_HISTORICAL_TRANSFER_NOT_OOS','combinedReturn':None,
            'independentOos':False,'profitabilityProven':False,'actualOrders':0,'executionAuthority':'NONE',
            'noSelectedChampion':True,'canonicalSampleDelta':0,
            'limitations':['STATIC_SURVIVOR_UNIVERSE','PRIOR_HISTORY_EXPOSURE_UNKNOWN','BEFORE_NOT_FORWARD_OOS',
               'NO_PIT_NEWS_UNIVERSE_OR_ACTUAL_FILL','MISSING_SERIES_BLOCKED_SELECTION_BIAS_REMAINS',
               'BAR_SAMPLED_MDD','OVERLAPPING_FULL_AND_HALF_WINDOWS_NOT_INDEPENDENT_SAMPLES',
               'EACH_SUBWINDOW_STARTS_FLAT_NOT_AN_ADDITIVE_SPLIT']}
    write_json(output/'result.json',result);write_json(output/'portfolio-ledgers.json',detail)
    lines=['# Frozen V3 historical transfer — no independent OOS claim','',
           'Rules unchanged. 2025-03-25..2026-03-24. All six arms retained; no selected winner.',
           'Full-year and half-year windows overlap; each starts flat with KRW10m. Do not add returns or sample counts.','',
           '| Window | Family | Theme | Trades | Win % | Net % | MTM MDD % | Fixed cost stress % | Resized stress % |',
           '|---|---|---|---:|---:|---:|---:|---:|---:|']
    pc=lambda x:'NA' if x is None else f'{x*100:.3f}'
    for x in summary:
        n=x['normal'];lines.append(f'| {x["window"]} | {x["family"]} | {x["themeFilter"]} | {n["metrics"]["trades"]} | {pc(n["metrics"]["winRate"])} | {pc(n["netReturn"])} | {pc(n["barSampledMtmMdd"])} | {pc(x["fixedPositionStress"]["netReturn"])} | {pc(x["policyResizedStress"]["netReturn"])} |')
    lines+=['', 'Decision: RESEARCH_HOLD. Not prospective, not actual fills, no activation.','']
    (output/'result.md').write_text('\n'.join(lines),encoding='utf8')
    print('\n'.join(lines))
    return result


def stock_audit(snapshot_path, output):
    raw=Path(snapshot_path).read_bytes()
    if sha(raw)!=ORIGINAL_SNAPSHOT:raise ValueError('ORIGINAL_SNAPSHOT_CHANGED')
    snap=json.loads(raw);v=load_v3();records=[];series=[];summary=[]
    for key,market,lane,benchmark in [('kr','KR','KR_THEME','069500'),('us','US','US_THEME','SPY')]:
        for symbol,rows in snap['lanes'][key]['data'].items():
            warnings=v.validate_rows(rows,market)
            ratios=[rows[i]['open']/rows[i-1]['close'] for i in range(1,len(rows))]
            extreme=[{'timestamp':rows[i]['timestamp'],'openPreviousCloseRatio':ratios[i-1]} for i in range(1,len(rows)) if not .5<ratios[i-1]<2]
            series.append({'market':market,'symbol':symbol,'warnings':warnings,'scaleDiscontinuityCandidates':extreme,
                           'corporateActionsVerified':False,'rawRowsSha256':sha(packed(rows))})
            if symbol==benchmark:continue
            candidates,_=v.discover(rows,symbol,market,lane)
            for c in candidates:
                p=v.make_plan(c,rows)
                if 'entryPrice' not in p:continue
                i=c['signalIndex'];e=p['entryPrice'];a=c['atr'];low=min(r['low'] for r in rows[i-4:i+1])
                structural=(e-low+.25*a)/e;floor=a/e
                scale=1000.; scaled=[dict(r,**{k:r[k]*scale for k in ('open','high','low','close')}) for r in rows]
                scaled_c=dict(c,atr=a*scale)
                check=v.make_plan(scaled_c,scaled)
                invariant=abs(p['stopPercent']-check['stopPercent'])<1e-10
                if not invariant:raise ValueError('UNIFORM_SCALE_RISK_INVARIANT')
                records.append({'market':market,'symbol':symbol,'family':c['family'],'knownAt':c['knownAt'],
                    'stopPercent':p['stopPercent'],'structureDistancePercent':structural,'atrFloorPercent':floor,
                    'bindingComponent':'STRUCTURE' if structural>=floor else 'ATR_FLOOR','entryGapAtr':(e-rows[i]['close'])/a,
                    'blockers':p['blockers'],'uniformPriceScalingLeavesRiskPercentUnchanged':invariant})
        xs=[r for r in records if r['market']==market]
        quantile=lambda name:sorted(r[name] for r in xs)[len(xs)//2] if xs else None
        summary.append({'market':market,'candidatesWithNextBar':len(xs),
                        'wideStopCount':sum('STRUCTURAL_STOP_TOO_WIDE' in r['blockers'] for r in xs),
                        'bindingComponents':dict(collections.Counter(r['bindingComponent'] for r in xs)),
                        'medianStopPercent':quantile('stopPercent'),'medianAtrFloorPercent':quantile('atrFloorPercent'),
                        'medianStructureDistancePercent':quantile('structureDistancePercent')})
    out={'sourceSnapshotSha256':sha(raw),'engineSha256':V3_SHA256,'summary':summary,'records':records,'series':series,
         'riskCapsChanged':False,'pricesAdjusted':False,'corporateActionProof':False,
         'conclusion':'DECOMPOSITION_ONLY_NOT_PROOF_OF_CORPORATE_ACTION_CORRECTNESS'}
    write_json(output,out);return out


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--collect',action='store_true');p.add_argument('--source',type=Path)
    p.add_argument('--output',type=Path,required=True);p.add_argument('--stock-snapshot',type=Path)
    args=p.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    if args.collect:
        collect(args.output);return
    if args.stock_snapshot:
        audit=stock_audit(args.stock_snapshot,args.output/'stock-risk-audit.json');print(json.dumps(audit['summary'],indent=2))
    if args.source:
        raw=args.source.read_bytes();result=evaluate(json.loads(raw),args.output)
        write_json(args.output/'provenance.json',{'sourceSha256':sha(raw),'engineSha256':V3_SHA256,
            'contractSha256':sha(packed(CONTRACT)),'resultSha256':sha((args.output/'result.json').read_bytes()),
            'privateApiCalled':False,'actualOrders':0,'telegramSent':0,'profitabilityProven':False,'independentOos':False})
    if not args.source and not args.stock_snapshot:p.error('one of --collect, --source, --stock-snapshot is required')


if __name__=='__main__':main()
