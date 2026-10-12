"""Deterministic causality/accounting tests; no network or real account access."""
import copy
import importlib.util
import math
from pathlib import Path
import tempfile
import unittest

FILE = Path(__file__).resolve().parents[1] / 'scripts' / 'selective_opportunity_discovery_v3.py'
spec = importlib.util.spec_from_file_location('discovery_v3', FILE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
DAY = 86_400_000


def bars(n=100):
    return [{'timestamp':m.START+(i-70)*DAY, 'open':100., 'high':101., 'low':99., 'close':100., 'volume':1000.} for i in range(n)]


def candidate(rows, symbol='AAA', market='US', lane='US_THEME'):
    return {'id':symbol+':70','lane':lane,'market':market,'symbol':symbol,'family':'BREAKOUT20',
            'signalIndex':70,'signalTimestamp':rows[70]['timestamp'],'knownAt':rows[70]['timestamp']+m.bar_ms(market),
            'atr':2.,'rvol':2.,'theme':{'groups':['test'], 'primary':'test','passed':True,'reason':None}}


def prepared(rows,symbol='AAA',stop=95., market='US',lane='US_THEME'):
    c=candidate(rows,symbol,market,lane)
    return {'candidate':c,'entryTimestamp':rows[71]['timestamp'],'entryIndex':71,'entryPrice':100.,
            'initialStop':stop,'stopPercent':(100-stop)/100,'blockers':[]}


class DiscoveryTests(unittest.TestCase):
    def test_policy_has_no_execution_or_invented_probability(self):
        self.assertEqual(m.POLICY['executionAuthority'],'NONE')
        self.assertFalse(m.POLICY['profitabilityProven'])
        self.assertIsNone(m.POLICY['futureProbability'])
        self.assertEqual(len(m.FAMILIES),3)

    def test_epoch_boundaries(self):
        import datetime
        self.assertEqual(datetime.datetime.fromtimestamp(m.START/1000,datetime.timezone.utc).isoformat(),'2026-03-25T00:00:00+00:00')

    def test_boolean_prices_rejected(self):
        r=bars();r[10]['open']=True
        with self.assertRaisesRegex(ValueError,'NONFINITE'):m.validate_rows(r,'US')

    def test_nan_prices_rejected(self):
        r=bars();r[10]['close']=math.nan
        with self.assertRaisesRegex(ValueError,'NONFINITE'):m.validate_rows(r,'US')

    def test_duplicate_candles_rejected(self):
        r=bars();r[10]['timestamp']=r[9]['timestamp']
        with self.assertRaisesRegex(ValueError,'NONMONOTONIC'):m.validate_rows(r,'US')

    def test_invalid_ohlc_rejected(self):
        r=bars();r[10]['low']=102
        with self.assertRaisesRegex(ValueError,'OHLC'):m.validate_rows(r,'US')

    def test_unclosed_boundary_rejected(self):
        r=bars();r[-1]['timestamp']=m.END-1
        with self.assertRaisesRegex(ValueError,'UNCLOSED'):m.validate_rows(r,'US')

    def test_crypto_missing_intervals_not_zero_filled(self):
        r=bars()
        with self.assertRaisesRegex(ValueError,'MISSING_CRYPTO_PATH'):m.validate_rows(r,'CRYPTO')

    def test_breakout_is_independent_of_future_exit(self):
        r=bars();r[70].update(open=102,close=104,high=105,low=101,volume=2000)
        a=m.discover(r,'AAA','US','US_THEME')[0]
        f=copy.deepcopy(r)
        for row in f[71:]:row.update(open=1000,low=900,high=1100,close=1050,volume=999999)
        b=m.discover(f,'AAA','US','US_THEME')[0]
        self.assertEqual([x for x in a if x['signalIndex']<=70],[x for x in b if x['signalIndex']<=70])
        self.assertEqual(a[0]['family'],'BREAKOUT20')

    def test_same_discovery_on_prefix_before_last_signal(self):
        r=bars();r[70].update(open=102,close=104,high=105,low=101,volume=2000)
        full=m.discover(r,'AAA','US','US_THEME')[0]
        short=m.discover(r[:71],'AAA','US','US_THEME')[0]
        self.assertEqual([x for x in full if x['signalIndex']<=70],short)

    def test_first_retest_uses_prior_breakout_level(self):
        r=bars();r[70].update(open=102,close=104,high=105,low=101,volume=2000)
        r[71].update(open=102,close=100.8,high=103,low=100,volume=700)
        r[72].update(open=101,close=102,high=103,low=100.9,volume=1500)
        c=m.discover(r,'AAA','US','US_THEME')[0]
        hits=[x for x in c if x['family']=='FIRST_RETEST']
        self.assertEqual(len(hits),1);self.assertEqual(hits[0]['signalIndex'],72);self.assertEqual(hits[0]['originIndex'],70)

    def test_explosion_never_enters_using_same_day_final_volume(self):
        r=bars()
        for row in r:
            for key in ('open','high','low','close'):row[key]*=.5
        r[70].update(open=54.25,close=56,high=56.5,low=53.5,volume=4_000_000)
        r[71].update(open=56,close=56.5,high=57,low=54.5,volume=2_000_000)
        c=m.discover(r,'AAA','US','US_EXPLOSION_PROXY')[0]
        self.assertTrue(c);self.assertEqual(c[0]['signalIndex'],71);self.assertEqual(c[0]['originIndex'],70)

    def test_radar_keeps_losing_events(self):
        r=bars();r[70].update(open=102,close=106,high=107,low=101,volume=2000)
        cs,radar=m.discover(r,'AAA','US','US_THEME')
        labeled=m.label_radar(radar,cs,{'AAA':r})
        self.assertTrue(labeled);self.assertLess(labeled[0]['outcome20BarCloseReturn'],0)
        self.assertTrue(labeled[0]['exPostOnly'])

    def test_terminal_radar_is_censored_not_zero_success(self):
        r=bars();radar=[{'symbol':'AAA','index':95,'timestamp':r[95]['timestamp']}]
        label=m.label_radar(radar,[],{'AAA':r})[0]
        self.assertTrue(label['outcomeCensored']);self.assertIsNone(label['outcome20BarCloseReturn'])
        self.assertEqual(label['detection'],'DETECTION_WINDOW_CENSORED')

    def test_missing_theme_is_not_positive_evidence(self):
        r=bars();c=candidate(r)
        t=m.theme_context(c,{'AAA':r},{'AAA':m.indicators(r)},{'AAA':{x['timestamp']:i for i,x in enumerate(r)}})
        self.assertEqual(t['reason'],'THEME_UNCLASSIFIED');self.assertFalse(t['passed'])

    def test_risk_cap_rejects_structure_instead_of_tightening_stop(self):
        r=bars()
        for x in r[66:71]:x['low']=80
        p=m.make_plan(candidate(r),r)
        self.assertIn('STRUCTURAL_STOP_TOO_WIDE',p['blockers']);self.assertLess(p['initialStop'],80)

    def test_next_open_only_checks_known_open_not_future_high(self):
        r=bars();c=candidate(r);p=m.make_plan(c,r)
        f=copy.deepcopy(r);f[71].update(high=10000,low=1,close=5000)
        self.assertEqual(m.make_plan(c,f),p)

    def test_last_signal_has_no_fabricated_entry(self):
        r=bars();c=candidate(r);c['signalIndex']=99
        self.assertIn('END_BOUNDARY_NO_NEXT_BAR',m.make_plan(c,r)['blockers'])

    def test_stop_wins_same_bar_target_ambiguity(self):
        r=bars();p=prepared(r);r[71].update(high=130,low=80)
        path=m.price_path(p,r)
        self.assertEqual(len(path),1);self.assertEqual(path[0]['reason'],'STOP_FIRST')

    def test_gap_loss_can_exceed_planned_stop(self):
        r=bars();p=prepared(r);r[72].update(open=80,high=82,low=78,close=81)
        path=m.price_path(p,r)
        self.assertEqual(path[-1]['reason'],'STOP_GAP');self.assertEqual(path[-1]['price'],80)

    def test_trailed_stop_never_applied_to_earlier_low(self):
        r=bars();p=prepared(r);r[71].update(open=100,high=113,low=99,close=112)
        path=m.price_path(p,r)
        self.assertEqual(path[0]['kind'],'T1')
        self.assertFalse(any(f['reason']=='STOP_FIRST' and f['timestamp']==r[71]['timestamp']+m.bar_ms('US') for f in path))

    def test_stock_partial_exits_are_integer_and_sum_to_initial(self):
        r=bars();p=prepared(r);r[71].update(high=125,low=99,close=122)
        path=m.price_path(p,r);v=m.replay([p],{p['candidate']['id']:path},{'AAA':r},'US_THEME',False,.0015)
        buys=[f for f in v['fills'] if f['side']=='BUY'];sells=[f for f in v['fills'] if f['side']=='SELL']
        self.assertEqual(len(buys),1)
        self.assertTrue(all(float(f['quantity']).is_integer() for f in sells))
        self.assertEqual(buys[0]['quantity'],sum(f['quantity'] for f in sells))
        self.assertAlmostEqual(v['finalEquity'],v['initialCapital']+sum(t['pnl'] for t in v['ledger']))

    def test_unaffordable_risk_lot_has_explicit_reason(self):
        r=bars();p=prepared(r,stop=20)
        p['blockers']=[]
        v=m.replay([p],{p['candidate']['id']:m.price_path(p,r)},{'AAA':r},'US_THEME',False,0)
        self.assertEqual(v['audit'][0]['reason'],'LOT_PER_TRADE_RISK')

    def test_same_symbol_double_entry_blocked(self):
        r=bars();p=prepared(r);p2=copy.deepcopy(p);p2['candidate']['id']='different_episode'
        v=m.replay([p,p2],{p['candidate']['id']:m.price_path(p,r),p2['candidate']['id']:m.price_path(p2,r)},{'AAA':r},'US_THEME',False,0)
        self.assertEqual(v['metrics']['trades'],1);self.assertEqual(v['reasons']['SYMBOL_ALREADY_OPEN'],1)

    def test_drawdown_marks_open_positions(self):
        r=bars();p=prepared(r,stop=50);r[71].update(low=75,close=75);r[72].update(open=75,low=75,high=100,close=100)
        # Fractional crypto units avoid whole-share risk rounding in this particular accounting fixture.
        p['candidate']['market']='CRYPTO';p['candidate']['lane']='CRYPTO_THEME'
        v=m.replay([p],{p['candidate']['id']:m.price_path(p,r)},{'AAA':r},'CRYPTO_THEME',False,0)
        self.assertGreater(v['barSampledMtmMdd'],0);self.assertAlmostEqual(v['netReturn'],0)

    def test_theme_filter_does_not_modify_raw_candidates(self):
        r=bars();p=prepared(r);p['candidate']['theme']['passed']=False;p['candidate']['theme']['reason']='THEME_BREADTH_LOW'
        saved=copy.deepcopy(p);paths={p['candidate']['id']:m.price_path(p,r)}
        off=m.replay([p],paths,{'AAA':r},'US_THEME',False,0)
        on=m.replay([p],paths,{'AAA':r},'US_THEME',True,0)
        self.assertEqual(p,saved);self.assertEqual(off['metrics']['trades'],1);self.assertEqual(on['metrics']['trades'],0)

    def test_zero_trades_is_not_perfect_precision(self):
        x=m.stats([]);self.assertIsNone(x['winRate']);self.assertIsNone(x['profitFactor'])

    def test_fixed_quantity_stress_only_subtracts_costs(self):
        r=bars();p=prepared(r);paths={p['candidate']['id']:m.price_path(p,r)}
        normal=m.replay([p],paths,{'AAA':r},'US_THEME',False,.0015)
        before=copy.deepcopy(normal);stressed=m.fixed_position_stress(normal)
        self.assertLessEqual(stressed['netReturn'],normal['netReturn'])
        self.assertEqual(stressed['tradeCount'],normal['metrics']['trades'])
        self.assertEqual(normal,before)
        expected=sum(x['costTurnover']*.0015*.5 for x in normal['ledger'])/normal['initialCapital']
        self.assertAlmostEqual(normal['netReturn']-stressed['netReturn'],expected)

    def test_stress_rejects_invalid_multiplier(self):
        with self.assertRaisesRegex(ValueError,'COST_MULTIPLIER'):
            m.fixed_position_stress({},math.nan)

    def test_intraday_exits_do_not_free_same_opening_position_slot(self):
        data={};plans=[];paths={}
        for symbol in ['A','B','C','D','E','F']:
            r=bars();p=prepared(r,symbol,stop=99)
            p['candidate']['theme']['groups']=[symbol]
            data[symbol]=r;plans.append(p)
            paths[p['candidate']['id']]=[{'timestamp':r[71]['timestamp']+m.bar_ms('US'),'phase':0,'kind':'FINAL','price':100,'reason':'INTRADAY_EXIT'}]
        result=m.replay(plans,paths,data,'US_THEME',False,0)
        self.assertEqual(result['metrics']['trades'],5)
        self.assertEqual(result['reasons']['POSITION_CAP'],1)
        self.assertGreaterEqual(result['minCash'],0)
        self.assertLessEqual(result['maxGrossObserved'],1.0000001)

    def test_source_checksum_cannot_be_bypassed(self):
        with tempfile.TemporaryDirectory() as tmp:
            source=Path(tmp)/'input.json';source.write_text('{}')
            with self.assertRaisesRegex(ValueError,'HASH_MISMATCH'):m.run(source,Path(tmp)/'out')


if __name__=='__main__':unittest.main()
