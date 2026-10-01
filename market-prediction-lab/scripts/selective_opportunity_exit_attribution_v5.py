#!/usr/bin/env python3
"""Offline exit attribution on two previously observed snapshots. No live authority.

Four exit arms, frozen V3 discovery/entry/initial risk. Accepted-entry paired
ledgers are NOT feasible portfolios; independent full causal replays are.
"""
from __future__ import annotations
import argparse
import collections
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import zipfile

BAR = 14_400_000
V4_ADAPTER_SHA = '32a775199b59bb03b1cdf75d754af07796324ca5629c8030b8a561fea650b060'
V3_SHA = 'ad69253f5a8e075bcd8c36563c33705224d2fe0d5fec74ebd41df496e264a72b'
SOURCE_OLD = '210c53906ba37b3551cd488fff57d0d20626cad30e2fa1ce463d245fe1003451'
SOURCE_RECENT = 'fabcae6eabe257f0e02bfd1af1f9dabb0b5e1e79494768dd08cb589166a13702'
ARCHIVES = {
    'v2': '3099e78aba40584612702b49ce868c9a6295ea8ca322272f545c1a52bdeeb64e',
    'v3': 'ee6cbdfc22d4ea03c5ff105252751d4add638d4de05cc4f580ce6e296cb7a3bb',
    'v4': '1042df64c7c1b1162d5d6d9a99126ddf27414bd1da89195f0ba733ac74ae7f91',
}
FAMILIES = ('BREAKOUT20', 'FIRST_RETEST')
ARMS = ('ORIGINAL_PARTIAL_RUNNER', 'FULL_EXIT_2R', 'FULL_RUNNER_AFTER_2R', 'PARTIAL_WITH_TIME_STOP')
CONTRACT = {
    'id': 'selective-opportunity-exit-attribution-v5', 'engineSha256': V3_SHA,
    'sources': {'PRIOR_YEAR': SOURCE_OLD, 'RECENT_6M': SOURCE_RECENT},
    'windows': {'PRIOR_YEAR': [1742860800000, 1774396800000], 'RECENT_6M': [1774396800000, 1790294400000]},
    'families': FAMILIES, 'arms': ARMS, 'themeEntryGate': False,
    'discoveryEntryRiskPriorityChanged': False, 'timeStopBars': 6, 'timeStopProgressR': .5,
    'firstTargetR': 2, 'secondTargetR': 4, 'trailingAtr': 3,
    'costPerSide': .0015, 'costStressMultiplier': 1.5,
    'registeredHubComment': 5826210031, 'classification': 'POST_SELECTION_EXPLORATORY',
    'selectedChampion': None, 'parameterGrid': False, 'independentOos': False,
    'pairedEntryReading': 'FIXED_BASELINE_ENTRIES_AND_QUANTITIES_NOT_CAPITAL_FEASIBLE_ACCOUNT',
    'mfeMaeReading': 'COMPLETED_CLOSES_STRICTLY_BEFORE_FINAL_EXIT_NO_HIGH_LOW_PROFIT_CLAIM',
    'actualOrders': 0, 'canonicalSampleDelta': 0, 'executionAuthority': 'NONE',
    'profitabilityProven': False, 'telegramSent': 0, 'providerCalls': 0,
}


def packed(x):
    return json.dumps(x, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def sha(x):
    return hashlib.sha256(x).hexdigest()


def save(path, x):
    Path(path).write_bytes(packed(x) + b'\n')


def transfer_module():
    path = Path(__file__).with_name('selective_opportunity_transfer_v4.py')
    if sha(path.read_bytes()) != V4_ADAPTER_SHA:
        raise ValueError('V4_ADAPTER_CHANGED')
    spec = importlib.util.spec_from_file_location('frozen_transfer_for_exit_v5', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if sha(path.with_name('selective_opportunity_discovery_v3.py').read_bytes()) != V3_SHA:
        raise ValueError('V3_ENGINE_CHANGED')
    return module


def read_archives(paths):
    contents = {}
    for name, path in paths.items():
        raw = Path(path).read_bytes()
        if sha(raw) != ARCHIVES[name]:
            raise ValueError('PINNED_ARCHIVE_MISMATCH:' + name)
        with zipfile.ZipFile(path) as z:
            if name == 'v2':
                contents['recentSource'] = z.read('source-snapshot.json')
            elif name == 'v3':
                contents['recentPortfolios'] = z.read('portfolio-ledgers.json')
            else:
                contents['oldSource'] = z.read('source/source.json')
                contents['oldPortfolios'] = z.read('result/portfolio-ledgers.json')
    if sha(contents['recentSource']) != SOURCE_RECENT or sha(contents['oldSource']) != SOURCE_OLD:
        raise ValueError('PINNED_SOURCE_MISMATCH')
    return {k: json.loads(v) for k, v in contents.items()}


def prepare_period(name, contents, adapter):
    start, end = CONTRACT['windows'][name]
    v = adapter.load_v3(start, end)
    if name == 'PRIOR_YEAR':
        source = contents['oldSource']['data']
        stored = [r for r in contents['oldPortfolios'] if r['window'] == 'FULL_YEAR' and not r['themeFilter']]
    else:
        source = contents['recentSource']['lanes']['crypto']['data']
        stored = [r for r in contents['recentPortfolios'] if r['lane'] == 'CRYPTO_THEME' and not r['themeFilter']]
    data = {}; blocked = []
    for symbol, rows in source.items():
        try:
            if name == 'PRIOR_YEAR':
                rows = adapter.usable_series(rows, start, end)
            elif v.validate_rows(rows, 'CRYPTO'):
                raise ValueError('PRICE_SCALE_REVIEW_REQUIRED')
            data[symbol] = rows
        except ValueError as exc:
            blocked.append({'symbol': symbol, 'reason': str(exc)})
    inds = {s: v.indicators(rows) for s, rows in data.items()}
    indexes = {s: {r['timestamp']: i for i, r in enumerate(rows)} for s, rows in data.items()}
    candidates = []
    for symbol, rows in sorted(data.items()):
        cs, _ = v.discover(rows, symbol, 'CRYPTO', 'CRYPTO_THEME')
        for c in cs:
            c['theme'] = v.theme_context(c, data, inds, indexes)
        candidates.extend(c for c in cs if c['family'] in FAMILIES)
    return v, data, inds, candidates, {x['family']: x['normal'] for x in stored}, blocked


def exit_path(v, plan, rows, ind, arm):
    """No discovery/selection calls. Signals cannot read these future exit paths."""
    if arm not in ARMS:
        raise ValueError('UNKNOWN_EXIT_ARM')
    if arm == ARMS[0]:
        return v.price_path(plan, rows, ind)
    if 'entryIndex' not in plan or not 0 < plan['initialStop'] < plan['entryPrice']:
        return []
    if plan['candidate']['market'] != 'CRYPTO':
        raise ValueError('V5_CRYPTO_ONLY')
    entry = plan['entryPrice']; risk = entry - plan['initialStop']; stop = plan['initialStop']
    start = plan['entryIndex']; last = min(len(rows)-1, start+89)
    highest = entry; hit1 = hit2 = False; pending_time_stop = False; events = []
    def event(ts, phase, kind, price, reason):
        events.append({'timestamp': ts, 'phase': phase, 'kind': kind, 'price': price, 'reason': reason})
    for i in range(start, last+1):
        r = rows[i]; t = r['timestamp']; closed = t+BAR
        if r['open'] <= stop:
            event(t, 2, 'FINAL', r['open'], 'STOP_GAP'); break
        if pending_time_stop:
            event(t, 2, 'FINAL', r['open'], 'TIME_STOP_NEXT_OPEN'); break
        if r['low'] <= stop:
            event(closed, 0, 'FINAL', stop, 'STOP_FIRST'); break
        if not hit1 and r['high'] >= entry+2*risk:
            hit1 = True
            if arm == 'FULL_EXIT_2R':
                event(closed, 0, 'FINAL', entry+2*risk, 'FULL_TARGET_2R'); break
            if arm == 'PARTIAL_WITH_TIME_STOP':
                event(closed, 0, 'T1', entry+2*risk, 'TARGET_1')
        if arm == 'PARTIAL_WITH_TIME_STOP' and not hit2 and r['high'] >= entry+4*risk:
            hit2 = True
            event(closed, 0, 'T2', entry+4*risk, 'TARGET_2')
        highest = max(highest, r['close'])
        if hit1:
            # This updated stop is only tested starting with the NEXT bar.
            stop = max(stop, entry, highest-3*ind[i]['atr'])
        if arm == 'PARTIAL_WITH_TIME_STOP' and i-start+1 >= CONTRACT['timeStopBars']:
            pending_time_stop = (r['close']-entry)/risk < CONTRACT['timeStopProgressR']
        if i == last:
            event(closed, 0, 'FINAL', r['close'], 'END_MARKED_LIQUIDATION' if i == len(rows)-1 else 'MAX_HOLD')
            break
    if not events or events[-1]['kind'] != 'FINAL':
        raise ValueError('PATH_NOT_TERMINATED')
    return events


def fixed_entry_exit(record, events, cost):
    """Same baseline entry and units. May overlap/collide with other paired trades."""
    if not events or events[-1]['kind'] != 'FINAL':
        raise ValueError('FINAL_EXIT_REQUIRED')
    qty = record['quantity']; entry = record['entryPrice']; left = qty
    spent = qty*entry*(1+cost); received = 0.; turnover = qty*entry; fees = qty*entry*cost; fills = []
    for f in events:
        units = left if f['kind'] == 'FINAL' else min(left, qty/3)
        gross = units*f['price']; fee = gross*cost
        left -= units; received += gross-fee; turnover += gross; fees += fee
        fills.append({'timestamp': f['timestamp'], 'quantity': units, 'price': f['price'], 'fee': fee, 'reason': f['reason']})
    if abs(left) > max(1e-8, qty*1e-10):
        raise ValueError('QUANTITY_NOT_CONSERVED')
    pnl = received-spent
    return {'id': record['id'], 'symbol': record['symbol'], 'quantity': qty, 'entryTimestamp': record['entryTimestamp'],
            'exitTimestamp': events[-1]['timestamp'], 'exitReason': events[-1]['reason'],
            'spent': spent, 'received': received, 'fees': fees, 'costTurnover': turnover, 'pnl': pnl,
            'grossPnl': pnl+fees, 'netReturn': pnl/spent, 'fills': fills}


def paired_summary(records, baseline, capital):
    baseline_by_id = {r['id']: r for r in baseline}
    differences = [r['pnl']-baseline_by_id[r['id']]['pnl'] for r in records]
    pnl = sum(r['pnl'] for r in records); fees = sum(r['fees'] for r in records)
    return {'trades': len(records), 'pnl': pnl, 'fees': fees, 'grossPnl': pnl+fees,
            'contributionFractionOfInitialCapital': pnl/capital,
            'deltaPnlVersusBaseline': sum(differences), 'betterTrades': sum(x > 1e-6 for x in differences),
            'worseTrades': sum(x < -1e-6 for x in differences), 'unchangedTrades': sum(abs(x) <= 1e-6 for x in differences),
            'costStressFixedQuantityContributionFraction': (pnl-fees*.5)/capital,
            'interpretation': CONTRACT['pairedEntryReading'], 'capitalFeasibilityChecked': False,
            'mdd': None}


def closed_path_diagnosis(record, plan, rows):
    """Exclude the final exit bar's close. A stop may occur before that close."""
    entry = plan['entryPrice']; risk = entry-plan['initialStop']; exit_time = record['exitTimestamp']
    closes = [r for r in rows[plan['entryIndex']:] if r['timestamp']+BAR < exit_time]
    values = [0.] + [(r['close']-entry)/risk for r in closes]
    peak = max(values); trough = min(values)
    # Lower-bound observation, not a claim about intrabar high/low or attainable exit.
    bucket = 'WIN_OR_FLAT' if record['pnl'] >= 0 else 'LOSS_AFTER_CLOSE_GE_1R' if peak >= 1 else 'LOSS_AFTER_CLOSE_GE_0_5R' if peak >= .5 else 'LOSS_NO_OBSERVED_CLOSE_GE_0_5R'
    return {'id': record['id'], 'symbol': record['symbol'], 'pnl': record['pnl'], 'fees': record['fees'],
            'grossPnl': record['pnl']+record['fees'], 'completedClosesBeforeExit': len(closes),
            'closeMfeR': peak, 'closeMaeR': trough, 'bucket': bucket,
            'closeObservationCensored': not closes,
            'hadActualModeledTarget1Fill': any(f['reason'] == 'TARGET_1' for f in record['fills']),
            'definition': CONTRACT['mfeMaeReading'], 'realizedBestExitClaim': False,
            'exPostDiagnosisOnly': True}


def diagnostic_summary(records):
    groups = collections.defaultdict(list)
    for r in records:
        groups[r['bucket']].append(r)
    return {k: {'trades': len(v), 'netPnl': sum(r['pnl'] for r in v), 'grossPnl': sum(r['grossPnl'] for r in v),
                'fees': sum(r['fees'] for r in v), 'censoredCloses': sum(r['closeObservationCensored'] for r in v)} for k,v in groups.items()}


def assert_baseline(actual, stored):
    # Monthly display differs for past-year adapter; engine and full economic records must not.
    for key in ('ledger', 'fills', 'audit', 'equityCurve', 'netReturn', 'barSampledMtmMdd', 'reasons'):
        if packed(actual[key]) != packed(stored[key]):
            raise ValueError('BASELINE_REPRODUCTION_FAILED:' + key)


def main_run(paths, output):
    output.mkdir(parents=True, exist_ok=True)
    # Outcomes of these new exit arms have not been used to set these rules.
    save(output/'experiment-contract.json', CONTRACT)
    contents = read_archives(paths); adapter = transfer_module(); summary = []; detail = []; diagnoses = []; coverage = {}
    for period in CONTRACT['windows']:
        v, data, inds, candidates, stored, blocked = prepare_period(period, contents, adapter)
        start, end = CONTRACT['windows'][period]
        coverage[period] = {'requested': 25, 'accepted': len(data), 'symbols': sorted(data), 'blocked': blocked,
                            'unavailableSymbols': sorted(set(adapter.known_symbols())-set(data)),
                            'allMarketUniverse': False}
        for family in FAMILIES:
            cs = [c for c in candidates if c['family'] == family]
            plans = [v.make_plan(c, data[c['symbol']]) for c in cs]
            byid = {p['candidate']['id']: p for p in plans}
            base_paths = {p['candidate']['id']: v.price_path(p, data[p['candidate']['symbol']], inds[p['candidate']['symbol']]) for p in plans}
            base = v.replay(plans, base_paths, data, 'CRYPTO_THEME', False, .0015)
            assert_baseline(base, stored[family])
            ds = [closed_path_diagnosis(r, byid[r['id']], data[r['symbol']]) for r in base['ledger']]
            diagnoses.append({'period': period, 'family': family, 'summary': diagnostic_summary(ds), 'records': ds})
            for arm in ARMS:
                paths_for_arm = {p['candidate']['id']: exit_path(v,p,data[p['candidate']['symbol']],inds[p['candidate']['symbol']],arm) for p in plans}
                normal = base if arm == ARMS[0] else v.replay(plans, paths_for_arm, data, 'CRYPTO_THEME', False, .0015)
                stress = v.replay(plans, paths_for_arm, data, 'CRYPTO_THEME', False, .00225)
                paired = [fixed_entry_exit(r, paths_for_arm[r['id']], .0015) for r in base['ledger']]
                if arm == ARMS[0] and any(abs(a['pnl']-b['pnl']) > 1e-6 for a,b in zip(paired,base['ledger'])):
                    raise ValueError('PAIRED_BASELINE_RECONCILIATION_FAILED')
                for p in (normal,stress):
                    p['monthly'] = adapter.monthly_from_curve(p['equityCurve'], p['initialCapital'], start, end)
                    if p['minCash'] < -1e-5 or p['maxGrossObserved'] > 1.000001:
                        raise ValueError('PORTFOLIO_CASH_OR_GROSS_INVARIANT')
                ps = paired_summary(paired, base['ledger'], base['initialCapital'])
                fixed = v.fixed_position_stress(normal)
                if fixed['netReturn'] > normal['netReturn']+1e-10:
                    raise ValueError('FIXED_COST_MONOTONICITY')
                common = {'period': period, 'start': start, 'endExclusive': end, 'family': family, 'exitArm': arm,
                          'rawCandidates': len(cs), 'candidateSha256': sha(packed(cs))}
                summary.append(common | {'normal': v.compact(normal), 'policyResizedStress': v.compact(stress),
                                         'fixedPositionStress': fixed, 'pairedBaselineEntries': ps})
                detail.append(common | {'normal': normal, 'policyResizedStress': stress, 'pairedBaselineEntries': paired})
    result = {'contract': CONTRACT, 'contractSha256': sha(packed(CONTRACT)), 'sourceZipSha256': ARCHIVES,
              'summary': summary, 'coverage': coverage, 'baselineReproduced': True,
              'decision': 'RESEARCH_HOLD_OBSERVED_HISTORY_EXIT_ATTRIBUTION', 'independentOos': False,
              'profitabilityProven': False, 'combinedReturn': None, 'selectedChampion': None,
              'actualOrders': 0, 'canonicalSampleDelta': 0, 'executionAuthority': 'NONE'}
    save(output/'result.json', result); save(output/'portfolio-ledgers.json', detail); save(output/'loss-path-diagnosis.json', diagnoses)
    (output/'result.md').write_text(render(result), encoding='utf8')
    save(output/'provenance.json', {'contractSha256': result['contractSha256'], 'engineSha256': V3_SHA,
         'analysisCodeSha256': sha(Path(__file__).read_bytes()), 'archiveSha256': ARCHIVES,
         'resultSha256': sha((output/'result.json').read_bytes()), 'providerCalls': 0,
         'executionAuthority': 'NONE', 'baselineReproduced': True, 'independentOos': False})
    print(render(result)); return result


def render(r):
    pc=lambda x: 'NA' if x is None else f'{100*x:.3f}'
    lines=['# Exit-only V5 research — both histories already observed', '',
       'Not independent OOS, not live fills, not a chosen champion. V3 discovery/risk/costs unchanged.',
       'Paired baseline-entry figures are attribution ledgers, NOT capital-feasible accounts.', '',
       '| Period | Family | Exit | Trades | Net % | MTM MDD % | Fixed-cost stress % | Resized stress % | Paired contribution % |',
       '|---|---|---|---:|---:|---:|---:|---:|---:|']
    for x in r['summary']:
        n=x['normal']; lines.append(f'| {x["period"]} | {x["family"]} | {x["exitArm"]} | {n["metrics"]["trades"]} | {pc(n["netReturn"])} | {pc(n["barSampledMtmMdd"])} | {pc(x["fixedPositionStress"]["netReturn"])} | {pc(x["policyResizedStress"]["netReturn"])} | {pc(x["pairedBaselineEntries"]["contributionFractionOfInitialCapital"])} |')
    lines+=['','All 16 rows retained; no new data, threshold grid, risk expansion, activation or orders.',
      'Stock research not rerun. Static survivor-biased crypto universe; gaps/listings/actual fill limits remain.',
      'Price signals, initial stops and allocation assumptions remain models; correct code is not profitability proof.','']
    return '\n'.join(lines)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for key in ARCHIVES: parser.add_argument('--'+key+'-zip', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args=parser.parse_args()
    main_run({k:getattr(args,k+'_zip') for k in ARCHIVES},args.output)
