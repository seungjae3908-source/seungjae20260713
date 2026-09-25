"""Offline verification of freeze, time boundaries, data gaps and reporting."""
import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('transfer_v4', ROOT/'scripts/selective_opportunity_transfer_v4.py')
v = importlib.util.module_from_spec(spec); spec.loader.exec_module(v)


def candles(start,end,warmup=180):
    return [{'timestamp':t,'open':100.,'high':101.,'low':99.,'close':100.,'volume':1000.}
            for t in range(start-warmup*v.BAR,end,v.BAR)]


class TransferTests(unittest.TestCase):
    def test_frozen_engine_checksum(self):
        m=v.load_v3();self.assertEqual(m.POLICY['id'],'selective-opportunity-independent-discovery-v3')

    def test_six_arms_not_champion_selection(self):
        self.assertEqual(len(v.load_v3().FAMILIES)*2,6)
        self.assertIsNone(v.CONTRACT['selectedChampion'])
        self.assertFalse(v.CONTRACT['parameterSearch'])

    def test_reference_universe_has_25_distinct_symbols(self):
        ss=v.known_symbols();self.assertEqual(len(ss),25);self.assertEqual(len(set(ss)),25)
        self.assertTrue({'FET','LDO','BONK'}<=set(ss))

    def test_known_contract_roundtrip(self):
        self.assertTrue(v.verify_contract(json.loads(v.packed(v.CONTRACT))))

    def test_no_historical_oos_relabel(self):
        c=json.loads(v.packed(v.CONTRACT));c['independentOos']=True
        with self.assertRaisesRegex(ValueError,'CONTRACT_MISMATCH'):v.verify_contract(c)

    def test_risk_changes_cannot_relabel_same_contract(self):
        c=json.loads(v.packed(v.CONTRACT));c['riskAndEntryAndExitAndPriorityChanged']=True
        with self.assertRaises(ValueError):v.verify_contract(c)

    def test_requested_universe_no_substitution(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(ValueError,'UNIVERSE_SUBSTITUTION'):
                v.evaluate({'contract':json.loads(v.packed(v.CONTRACT)),'requested':['BTC'],'data':{}},Path(d))

    def test_window_boundary_complete(self):
        r=candles(v.START,v.START+10*v.BAR)
        self.assertEqual(len(v.usable_series(r,v.START,v.START+10*v.BAR)),190)

    def test_no_missing_bar_forward_fill(self):
        r=candles(v.START,v.START+10*v.BAR);r.pop(-3)
        with self.assertRaisesRegex(ValueError,'MISSING_CRYPTO'):v.usable_series(r,v.START,v.START+10*v.BAR)

    def test_no_truncated_test_window(self):
        r=candles(v.START,v.START+10*v.BAR);r.pop()
        with self.assertRaisesRegex(ValueError,'PATH_INCOMPLETE'):v.usable_series(r,v.START,v.START+10*v.BAR)

    def test_no_short_warmup(self):
        r=candles(v.START,v.START+10*v.BAR,warmup=59)
        with self.assertRaisesRegex(ValueError,'WARMUP_INSUFFICIENT'):v.usable_series(r,v.START,v.START+10*v.BAR)

    def test_future_missing_data_cannot_select_earlier_survivors(self):
        r=candles(v.START,v.START+10*v.BAR);future=[{'timestamp':v.START+20*v.BAR,'close':None}]
        self.assertEqual(v.usable_series(r,v.START,v.START+10*v.BAR),v.usable_series(r+future,v.START,v.START+10*v.BAR))

    def test_window_module_isolation(self):
        old=v.load_v3();new=v.load_v3(v.START,v.END)
        self.assertNotEqual(old.START,new.START);self.assertEqual(old.START,1774396800000)
        # Window adapter changes no economic rule.
        a=copy.deepcopy(old.POLICY);b=copy.deepcopy(new.POLICY);a.pop('window');b.pop('window')
        self.assertEqual(a,b)

    def test_candle_parser_does_not_use_last_trade_timestamp(self):
        p={'market':'KRW-BTC','candle_date_time_utc':'2025-03-25T00:00:00','timestamp':9,
           'opening_price':100,'high_price':110,'low_price':90,'trade_price':105,'candle_acc_trade_volume':1}
        self.assertEqual(v.parse_row(p,'BTC')['timestamp'],v.START)

    def test_cross_symbol_payload_rejected(self):
        with self.assertRaisesRegex(ValueError,'SYMBOL_MISMATCH'):v.parse_row({'market':'KRW-ETH'},'BTC')

    def test_numeric_string_not_silently_accepted(self):
        p={'market':'KRW-BTC','candle_date_time_utc':'2025-03-25T00:00:00','opening_price':'100'}
        with self.assertRaisesRegex(ValueError,'NONFINITE'):v.parse_row(p,'BTC')

    def test_months_cross_year_are_not_hardcoded_2026(self):
        start=int(dt.datetime(2025,12,20,tzinfo=v.UTC).timestamp()*1000)
        end=int(dt.datetime(2026,2,2,tzinfo=v.UTC).timestamp()*1000)
        jan=int(dt.datetime(2026,1,1,tzinfo=v.UTC).timestamp()*1000)
        feb=int(dt.datetime(2026,2,1,tzinfo=v.UTC).timestamp()*1000)
        curve=[{'timestamp':jan,'phase':0,'equity':110},{'timestamp':feb,'phase':0,'equity':99}]
        ms=v.monthly_from_curve(curve,100,start,end)
        self.assertEqual([m['month'] for m in ms],['2025-12','2026-01','2026-02'])
        self.assertAlmostEqual(ms[0]['return'],.1);self.assertAlmostEqual(ms[1]['return'],-.1)
        self.assertTrue(ms[0]['partial']);self.assertFalse(ms[1]['partial']);self.assertTrue(ms[2]['partial'])

    def test_half_windows_partition_dates_not_independent_returns(self):
        _,a,b=v.WINDOWS[1];_,c,d=v.WINDOWS[2]
        self.assertEqual(a,v.START);self.assertEqual(b,c);self.assertEqual(d,v.END)
        self.assertFalse(v.CONTRACT['independentOos'])

    def test_uniform_price_scale_leaves_plan_risk_percent_unchanged(self):
        m=v.load_v3();rs=candles(m.START,m.START+30*v.BAR)
        i=185;c={'signalIndex':i,'atr':2.,'knownAt':rs[i]['timestamp']+v.BAR,'market':'CRYPTO'}
        p=m.make_plan(c,rs)
        rr=[dict(r,**{k:r[k]*1e3 for k in ('open','high','low','close')}) for r in rs]
        q=m.make_plan(dict(c,atr=2000.),rr)
        self.assertAlmostEqual(p['stopPercent'],q['stopPercent'])

    def test_stock_audit_refuses_unpinned_source(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'x.json';p.write_text('{}')
            with self.assertRaisesRegex(ValueError,'SNAPSHOT_CHANGED'):v.stock_audit(p,Path(d)/'out.json')


if __name__=='__main__':unittest.main()
