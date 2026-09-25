"""Offline tests. Synthetic fixtures test mechanics, never economic credit."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('exit_v5',ROOT/'scripts/selective_opportunity_exit_attribution_v5.py')
x=importlib.util.module_from_spec(spec);spec.loader.exec_module(x)


def fixture():
    v=x.transfer_module().load_v3()
    rows=[{'timestamp':v.START+(i-80)*x.BAR,'open':100.,'high':101.,'low':99.,'close':100.,'volume':1000.} for i in range(125)]
    c={'id':'fixture','symbol':'BTC','family':'FIRST_RETEST','market':'CRYPTO','lane':'CRYPTO_THEME','signalIndex':80,
       'signalTimestamp':rows[80]['timestamp'],'knownAt':rows[81]['timestamp'],'atr':2.,'rvol':1.5,
       'theme':{'groups':['crypto_l1'],'passed':True,'reason':None}}
    p=v.make_plan(c,rows)
    return v,rows,p


def baseline_record(p,events):
    stub={'id':'fixture','symbol':'BTC','quantity':3.,'entryPrice':p['entryPrice'],'entryTimestamp':p['entryTimestamp']}
    return x.fixed_entry_exit(stub,events,.0015)


class ExitTests(unittest.TestCase):
    def test_four_fixed_arms_no_execution(self):
        self.assertEqual(len(x.ARMS),4);self.assertEqual(len(x.FAMILIES),2)
        self.assertFalse(x.CONTRACT['independentOos']);self.assertFalse(x.CONTRACT['profitabilityProven'])
        self.assertEqual(x.CONTRACT['executionAuthority'],'NONE');self.assertIsNone(x.CONTRACT['selectedChampion'])

    def test_no_risk_or_candidate_changes(self):
        self.assertFalse(x.CONTRACT['discoveryEntryRiskPriorityChanged'])
        self.assertFalse(x.CONTRACT['parameterGrid'])

    def test_bad_archive_fails_before_parsing(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'x.zip';p.write_bytes(b'bad')
            with self.assertRaisesRegex(ValueError,'ARCHIVE_MISMATCH'):x.read_archives({'v2':p})

    def test_unknown_arm_rejected(self):
        v,r,p=fixture()
        with self.assertRaisesRegex(ValueError,'UNKNOWN_EXIT_ARM'):x.exit_path(v,p,r,v.indicators(r),'UNKNOWN')

    def test_preserved_baseline_price_path(self):
        v,r,p=fixture();ind=v.indicators(r)
        self.assertEqual(x.exit_path(v,p,r,ind,x.ARMS[0]),v.price_path(p,r,ind))

    def test_initial_same_bar_stop_wins_over_targets_all_arms(self):
        v,r,p=fixture();r[81].update(low=90.,high=130.,close=110.)
        for arm in x.ARMS:
            es=x.exit_path(v,p,r,v.indicators(r),arm)
            self.assertEqual(len(es),1);self.assertEqual(es[0]['price'],p['initialStop'])
            self.assertEqual(es[0]['reason'],'STOP_FIRST')

    def test_full_2r_sells_all_units(self):
        v,r,p=fixture();r[81].update(high=105.,low=99.,close=104.)
        es=x.exit_path(v,p,r,v.indicators(r),'FULL_EXIT_2R')
        self.assertEqual(len(es),1);self.assertEqual(es[0]['kind'],'FINAL')
        rec=baseline_record(p,es);self.assertEqual(rec['fills'][0]['quantity'],3.)
        self.assertEqual(rec['exitReason'],'FULL_TARGET_2R')

    def test_adverse_gap_at_open(self):
        v,r,p=fixture();r[82].update(open=80.,low=79.,high=81.,close=80.)
        for arm in x.ARMS:
            es=x.exit_path(v,p,r,v.indicators(r),arm)
            self.assertEqual(es[-1]['price'],80.);self.assertEqual(es[-1]['phase'],2)
            self.assertEqual(es[-1]['timestamp'],r[82]['timestamp'])

    def test_full_runner_never_generates_partial_fills(self):
        v,r,p=fixture();r[81].update(high=110.,low=99.,close=108.)
        es=x.exit_path(v,p,r,v.indicators(r),'FULL_RUNNER_AFTER_2R')
        self.assertEqual(len(es),1);self.assertEqual(es[0]['kind'],'FINAL')

    def test_trailing_stop_not_applied_to_same_bar_low(self):
        v,r,p=fixture();r[81].update(high=109.,low=99.,close=108.)
        es=x.exit_path(v,p,r,v.indicators(r),'FULL_RUNNER_AFTER_2R')
        self.assertGreaterEqual(es[-1]['timestamp'],r[81]['timestamp']+x.BAR)
        # Adjacent candles share this timestamp: next open phase 2 is causal, prior close phase 0 is not.
        if es[-1]['timestamp'] == r[81]['timestamp']+x.BAR:
            self.assertEqual(es[-1]['phase'],2)
            self.assertEqual(es[-1]['reason'],'STOP_GAP')

    def test_time_stop_after_six_closed_bars_then_next_open(self):
        v,r,p=fixture()
        es=x.exit_path(v,p,r,v.indicators(r),'PARTIAL_WITH_TIME_STOP')
        self.assertEqual(es[-1]['reason'],'TIME_STOP_NEXT_OPEN')
        self.assertEqual(es[-1]['timestamp'],r[87]['timestamp'])
        self.assertEqual(es[-1]['phase'],2)

    def test_gap_has_priority_when_time_exit_pending(self):
        v,r,p=fixture();r[87].update(open=90.,low=89.,high=91.,close=90.)
        es=x.exit_path(v,p,r,v.indicators(r),'PARTIAL_WITH_TIME_STOP')
        self.assertEqual(es[-1]['reason'],'STOP_GAP');self.assertEqual(es[-1]['price'],90.)

    def test_no_time_stop_when_progress_sufficient(self):
        v,r,p=fixture()
        for i in range(81,len(r)):r[i].update(open=101.5,low=100.5,high=102.,close=101.5)
        es=x.exit_path(v,p,r,v.indicators(r),'PARTIAL_WITH_TIME_STOP')
        self.assertNotEqual(es[-1]['reason'],'TIME_STOP_NEXT_OPEN')

    def test_future_candle_changes_cannot_rewrite_completed_exit(self):
        v,r,p=fixture();r[81].update(low=90.,high=101.,close=95.)
        a=x.exit_path(v,p,r,v.indicators(r),'FULL_EXIT_2R')
        future=copy.deepcopy(r)
        for i in range(82,len(future)):future[i].update(open=1000.,high=1100.,low=999.,close=1050.)
        self.assertEqual(a,x.exit_path(v,p,future,v.indicators(future),'FULL_EXIT_2R'))

    def test_all_partial_quantities_reconcile(self):
        v,r,p=fixture();r[81].update(low=99.,high=110.,close=108.)
        es=x.exit_path(v,p,r,v.indicators(r),'PARTIAL_WITH_TIME_STOP')
        rec=baseline_record(p,es)
        self.assertAlmostEqual(sum(f['quantity'] for f in rec['fills']),rec['quantity'])
        self.assertAlmostEqual(rec['grossPnl']-rec['fees'],rec['pnl'])

    def test_fixed_cost_higher_never_improves_same_fill_pnl(self):
        v,r,p=fixture();es=x.exit_path(v,p,r,v.indicators(r),'FULL_EXIT_2R')
        a=baseline_record(p,es);b=x.fixed_entry_exit(a|{'entryPrice':p['entryPrice']},es,.00225)
        self.assertLess(b['pnl'],a['pnl'])

    def test_loss_diagnosis_excludes_final_exit_bar_close(self):
        v,r,p=fixture();r[81].update(low=90.,high=1000.,close=999.)
        rec={'id':'fixture','symbol':'BTC','exitTimestamp':r[81]['timestamp']+x.BAR,'pnl':-10.,'fees':1.,'fills':[]}
        d=x.closed_path_diagnosis(rec,p,r)
        self.assertEqual(d['closeMfeR'],0);self.assertEqual(d['completedClosesBeforeExit'],0)
        self.assertTrue(d['closeObservationCensored'])

    def test_loss_after_real_prior_closed_profit(self):
        v,r,p=fixture();r[81]['close']=103.
        rec={'id':'fixture','symbol':'BTC','exitTimestamp':r[83]['timestamp'],'pnl':-10.,'fees':1.,'fills':[]}
        d=x.closed_path_diagnosis(rec,p,r)
        self.assertEqual(d['bucket'],'LOSS_AFTER_CLOSE_GE_1R')
        self.assertAlmostEqual(d['closeMfeR'],1.5)

    def test_changed_economic_baseline_fails(self):
        keys=('ledger','fills','audit','equityCurve','netReturn','barSampledMtmMdd','reasons')
        a=dict.fromkeys(keys,[]);b=copy.deepcopy(a);b['ledger']=[{'fake':True}]
        with self.assertRaisesRegex(ValueError,'BASELINE_REPRODUCTION_FAILED'):x.assert_baseline(a,b)

    def test_paired_ledger_is_not_claimed_feasible_account(self):
        rec={'id':'a','pnl':10.,'fees':1.};p=x.paired_summary([rec],[rec],100.)
        self.assertFalse(p['capitalFeasibilityChecked']);self.assertIsNone(p['mdd'])
        self.assertEqual(p['deltaPnlVersusBaseline'],0);self.assertLess(p['costStressFixedQuantityContributionFraction'],.1)


if __name__=='__main__':unittest.main()
