"""Deterministic tests: no network, broker, schedule or application writes."""
import copy
import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('entry_v6',ROOT/'scripts/selective_opportunity_entry_priority_v6.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


def series(n=210):
    start=m.WINDOWS[2][1]-30*m.DAY
    return [{'timestamp':start+i*m.BAR,'open':100.,'high':101.,'low':99.,'close':100.,'volume':1000.} for i in range(n)]


def ranked(score,signal=1,rvol=1,available=2):
    return {'signalTimestamp':signal,'rvol':rvol,'knownAt':2,
            'decision':{'momentum':{'score':score,'turnover':100.,'availableAt':available}}}


class EntryPriorityTests(unittest.TestCase):
    def test_frozen_sources_and_three_hypotheses(self):
        v=m.frozen_v5();v.transfer_module()
        self.assertEqual(m.CONTRACT['newHypotheses'],3);self.assertEqual(len(m.ARMS),4)
        self.assertEqual(m.CONTRACT['executionAuthority'],'NONE');self.assertFalse(m.CONTRACT['riskChanged'])

    def test_daily_requires_all_six_bars(self):
        r=series(12);r.pop(2)
        days=m.complete_days(r)
        self.assertEqual(len(days),1);self.assertEqual(days[0]['start'],r[5]['timestamp'])

    def test_duplicate_daily_bar_is_not_complete(self):
        r=series(6);r.append(dict(r[0]));self.assertEqual(m.complete_days(r),[])

    def test_completed_daily_becomes_available_only_at_next_midnight(self):
        r=series(25*6)
        for i,x in enumerate(r):x['close']=100+i//6
        d=m.complete_days(r);last=d[-1]['availableAt']
        self.assertFalse(m.daily_context(d,last-1)['passed'])
        self.assertTrue(m.daily_context(d,last)['passed'])

    def test_future_daily_candle_cannot_change_past_context(self):
        r=series(30*6)
        for i,x in enumerate(r):x['close']=100+i//6
        t=r[25*6]['timestamp'];a=m.daily_context(m.complete_days(r),t)
        rr=copy.deepcopy(r)
        for x in rr:
            if x['timestamp']>=t:x['close']=1000000.
        self.assertEqual(a,m.daily_context(m.complete_days(rr),t))

    def test_daily_gap_history_is_unknown_not_bullish(self):
        r=series(30*6);del r[10*6:11*6]
        d=m.complete_days(r);self.assertEqual(m.daily_context(d,d[-1]['availableAt'])['reason'],'COMPLETE_DAILY_HISTORY_MISSING')

    def test_flat_daily_trend_is_not_confirmed(self):
        d=m.complete_days(series(30*6));self.assertFalse(m.daily_context(d,d[-1]['availableAt'])['passed'])

    def test_same_time_higher_momentum_priority(self):
        a,b=ranked(3,rvol=1),ranked(2,rvol=9)
        self.assertLess(m.entry_priority(a,m.ARMS[2]),m.entry_priority(b,m.ARMS[2]))

    def test_original_time_priority_preserved(self):
        a,b=ranked(-9,signal=0),ranked(9000,signal=1)
        self.assertLess(m.entry_priority(a,m.ARMS[2]),m.entry_priority(b,m.ARMS[2]))

    def test_unknown_ranks_after_known_without_fabricating_zero_score(self):
        a,b=ranked(None,available=None),ranked(-99999)
        self.assertGreater(m.entry_priority(a,m.ARMS[2]),m.entry_priority(b,m.ARMS[2]))
        self.assertIsNone(a['decision']['momentum']['score'])

    def test_future_ranking_input_rejected(self):
        with self.assertRaisesRegex(ValueError,'FUTURE_RANK_INPUT'):m.entry_priority(ranked(1,available=3),m.ARMS[2])

    def test_rank_rejects_unknown_arm(self):
        with self.assertRaisesRegex(ValueError,'UNKNOWN_ARM'):m.entry_priority(ranked(1),'LEVERAGE')

    def test_momentum_ignores_future_rows(self):
        r=series()
        for i,x in enumerate(r):x['close']=100+i*.1+(i%5)*.03
        a=m.momentum_context(r,100,r,100)
        rr=copy.deepcopy(r)
        for x in rr[101:]:x['close']=1000000.
        self.assertEqual(a,m.momentum_context(rr,100,rr,100))
        self.assertEqual(a['score'],0.)

    def test_momentum_cannot_compare_different_times(self):
        r=series();self.assertEqual(m.momentum_context(r,100,r,99)['reason'],'BENCHMARK_TIME_MISMATCH')

    def test_zero_variance_does_not_become_infinite_confidence(self):
        r=series();self.assertIsNone(m.momentum_context(r,100,r,100)['score'])

    def test_baseline_priority_seam_is_exactly_equivalent(self):
        v=m.frozen_v5().transfer_module().load_v3(*m.WINDOWS[2][1:])
        r=series();data={'AAA':r}
        a=v.replay([],{},data,'CRYPTO_THEME',False,.0015)
        b=m.priority_replay(v,'BASELINE')([],{},data,'CRYPTO_THEME',False,.0015)
        self.assertEqual(a,b)

    def test_compression_detects_known_breakout_and_is_future_invariant(self):
        v=m.frozen_v5().transfer_module().load_v3(*m.WINDOWS[2][1:]);r=series(240);i=205
        for x in r[i-24:i-12]:x.update(high=110.,low=90.)
        r[i].update(close=103.,high=104.,volume=3000.)
        a=[c for c in m.compression_candidates(v,r,'AAA',m.complete_days(r)) if c['signalIndex']<=i]
        self.assertTrue(any(c['signalIndex']==i for c in a))
        rr=copy.deepcopy(r)
        for x in rr[i+1:]:x.update(open=50000.,close=50000.,high=50001.,low=49999.,volume=999999.)
        b=[c for c in m.compression_candidates(v,rr,'AAA',m.complete_days(rr)) if c['signalIndex']<=i]
        self.assertEqual(a,b)

    def test_month_boundary_does_not_move_new_month_entry_fee_backwards(self):
        start,end=m.WINDOWS[2][1:]
        import datetime as dt
        curve=[];value=100.
        for month in range(4,10):
            t=int(dt.datetime(2026,month,25,tzinfo=dt.timezone.utc).timestamp()*1000)
            value*=1.03;curve.append({'timestamp':t,'phase':0,'equity':value})
            if t<end:curve.append({'timestamp':t,'phase':3,'equity':value-.1})
        p={'initialCapital':100.,'equityCurve':curve,'netReturn':value/100.-1}
        ms=m.anniversary_months(p,start,end)
        self.assertEqual(len(ms),6)
        for x in ms:self.assertAlmostEqual(x['netReturn'],.03)

    def test_month_product_must_match_account(self):
        start,end=m.WINDOWS[2][1:]
        p={'initialCapital':100.,'equityCurve':[{'timestamp':end,'phase':0,'equity':100.}],'netReturn':.1}
        with self.assertRaisesRegex(ValueError,'MONTHLY_GROWTH'):m.anniversary_months(p,start,end)

    def test_zero_trades_not_target_success(self):
        start,end=m.WINDOWS[2][1:]
        p={'initialCapital':100.,'equityCurve':[{'timestamp':end,'phase':0,'equity':100.}],'netReturn':0.}
        metrics=m.target_metrics(p,start,end)
        self.assertEqual(metrics['month3PercentCount'],0);self.assertFalse(metrics['allMonthsAtLeast3Percent'])


if __name__=='__main__':unittest.main()
