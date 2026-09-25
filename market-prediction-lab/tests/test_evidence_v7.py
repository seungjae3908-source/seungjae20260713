import copy, importlib.util, math, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
s=importlib.util.spec_from_file_location('evidencev7',ROOT/'scripts/selective_opportunity_evidence_v7.py');v=importlib.util.module_from_spec(s);s.loader.exec_module(v)
def rows(n=200):
 out=[]
 for i in range(n):
  c=100+math.sin(i/4)*3+i*.02;o=c-.1
  out.append({'timestamp':1742860800000+(i-80)*v.BAR,'open':o,'high':c+1,'low':o-1,'close':c,'volume':1000+(i%5)*100})
 return out
class EvidenceTests(unittest.TestCase):
 def test_frozen_dependency(self):self.assertEqual(v.v6_module().CONTRACT['id'],'selective-opportunity-entry-priority-v6')
 def test_new_hypotheses_and_controls(self):self.assertEqual(len(v.ARMS),5);self.assertEqual(v.CONTRACT['newHypotheses'],3)
 def test_no_execution_authority(self):self.assertEqual(v.CONTRACT['executionAuthority'],'NONE');self.assertFalse(v.CONTRACT['independentOos']);self.assertFalse(v.CONTRACT['pretrainedModelUsed'])
 def test_body_engulfing(self):
  p={'open':102,'close':100};c={'open':99,'close':103,'low':98,'high':104}
  self.assertTrue(v.candle_shape(c,p)['engulfing'])
 def test_not_engulfing_only_wick(self):
  self.assertFalse(v.candle_shape({'open':100.5,'close':101.5,'low':98,'high':104},{'open':102,'close':100})['engulfing'])
 def test_hammer_geometry(self):
  self.assertTrue(v.candle_shape({'open':100,'close':101,'low':97,'high':101.3},{'open':101,'close':100})['hammer'])
 def test_doji_not_hammer(self):
  self.assertFalse(v.candle_shape({'open':100,'close':100,'low':97,'high':101},{'open':101,'close':100})['hammer'])
 def test_invalid_ohlc(self):
  with self.assertRaises(ValueError):v.candle_shape({'open':100,'close':110,'low':99,'high':105},{'open':100,'close':99})
 def test_flat_rsi_neutral(self):
  rs=[{'timestamp':i*v.BAR,'open':100,'high':101,'low':99,'close':100,'volume':1} for i in range(40)]
  self.assertEqual(v.technical_series(rs)[-1]['rsi'],50.)
 def test_rsi_monotonic_up(self):
  rs=[{'timestamp':i*v.BAR,'open':100+i,'high':102+i,'low':99+i,'close':101+i,'volume':1} for i in range(40)]
  self.assertEqual(v.technical_series(rs)[-1]['rsi'],100.)
 def test_indicators_future_invariant(self):
  rs=rows();a=v.technical_series(rs);rr=copy.deepcopy(rs)
  for r in rr[101:]:r['close']*=5;r['open']*=5;r['low']*=5;r['high']*=5
  self.assertEqual(a[:101],v.technical_series(rr)[:101])
 def test_pivot_two_right_confirmation(self):
  rs=[{'timestamp':i*v.BAR,'open':100,'high':101,'low':l,'close':100,'volume':1} for i,l in enumerate([99,98,90,97,98,99])]
  ts=v.technical_series(rs);self.assertIsNone(ts[3]['lastLow']);self.assertEqual(ts[4]['lastLow']['index'],2);self.assertEqual(ts[4]['lastLow']['availableAt'],5*v.BAR)
 def test_equal_lows_not_strict_pivot(self):
  rs=[{'timestamp':i*v.BAR,'open':100,'high':101,'low':l,'close':100,'volume':1} for i,l in enumerate([99,98,90,90,98,99])]
  self.assertIsNone(v.technical_series(rs)[-1]['lastLow'])
 def test_shape_scale_invariant(self):
  rs=rows();a=v.technical_series(rs);rr=[{**r,**{k:r[k]*1000 for k in ('open','high','low','close')}} for r in rs];b=v.technical_series(rr)
  self.assertAlmostEqual(a[-1]['rsi'],b[-1]['rsi']);self.assertAlmostEqual(a[-1]['hist']*1000,b[-1]['hist'],places=7)
 def test_union_dedupe_stable(self):
  a={'id':'a','symbol':'A','knownAt':100,'signalTimestamp':90,'family':'FIRST_RETEST'};b=dict(a,id='b',family='CANDLE_RECOVERY')
  x=v.union_candidates([a,b]);self.assertEqual(len(x),1);self.assertEqual(len(x[0]['sourceFamilies']),2);self.assertEqual(x,v.union_candidates([b,a]));self.assertEqual(a['id'],'a')
 def test_training_label_maturity_embargo(self):
  c=100*v.BAR;p=[{'features':[0.],'labelEnd':98*v.BAR,'entryAt':80*v.BAR,'knownAt':80*v.BAR,'symbol':'A','label':1},
  {'features':[1.],'labelEnd':99*v.BAR,'entryAt':81*v.BAR,'knownAt':81*v.BAR,'symbol':'B','label':0}]
  self.assertEqual(len(v.training_rows(p,c)),1)
 def test_per_symbol_nonoverlap(self):
  p=[{'features':[0.],'labelEnd':i+18*v.BAR,'entryAt':i,'knownAt':i,'symbol':'A','label':1} for i in (0,v.BAR,19*v.BAR)]
  self.assertEqual(len(v.training_rows(p,100*v.BAR)),2)
 def test_training_excludes_future_corruption(self):
  p=[{'features':[0.],'labelEnd':20*v.BAR,'entryAt':0,'knownAt':0,'symbol':'A','label':1}];f=dict(p[0],features=[999.],labelEnd=200*v.BAR,label=0)
  self.assertEqual(v.training_rows(p,100*v.BAR),v.training_rows(p+[f],100*v.BAR))
 def test_model_insufficient_never_invent_score(self):
  model,meta=v.fit_gate([],100*v.BAR);self.assertIsNone(model);self.assertEqual(meta['status'],'INSUFFICIENT_TRAINING')
 def test_one_class_training_blocks(self):
  p=[{'id':str(i),'features':[float(i)],'knownAt':i*v.BAR,'entryAt':i*v.BAR,'labelEnd':(i+1)*v.BAR,'symbol':str(i),'label':1} for i in range(160)]
  model,meta=v.fit_gate(p,200*v.BAR);self.assertIsNone(model)
 def test_label_is_next_open_to_18bar_close(self):
  rs=rows();c={'id':'t','signalIndex':80,'symbol':'A','knownAt':rs[80]['timestamp']+v.BAR,'features':[0.]};p=v.outcome_label(c,rs)
  expected=rs[98]['close']*.9985/(rs[81]['open']*1.0015)-1
  self.assertAlmostEqual(p['net18Return'],expected);self.assertEqual(p['labelEnd'],rs[98]['timestamp']+v.BAR)
 def test_terminal_label_censored(self):
  rs=rows();self.assertIsNone(v.outcome_label({'signalIndex':len(rs)-10},rs))
 def test_features_have_no_label_or_profit_field(self):
  self.assertTrue(all(not any(s in f.lower() for s in ('label','pnl','future','target')) for f in v.FEATURES))
 def test_calendar_refit_cutoff(self):
  t=1774396800000;cut=v.month_floor(t);self.assertLessEqual(cut,t);self.assertEqual(v.month_floor(cut+v.DAY),cut)
 def test_no_calibration_from_zero_predictions(self):
  p=v.calibration_diagnostic({},[]);self.assertEqual(p['n'],0);self.assertIsNone(p['brier']);self.assertFalse(p['certified'])
 def test_model_labels_not_trade_win_probability(self):
  self.assertIn('NOT probability',v.CONTRACT['ml']['label']);self.assertIn('NOT_CALIBRATED',v.CONTRACT['ml']['calibration'])
 def test_feature_vector_prefix_invariance(self):
  v6=v.v6_module();rs=rows();tech=v.technical_series(rs);i=120;c={'signalIndex':i,'knownAt':rs[i]['timestamp']+v.BAR,'symbol':'A','atr':2.,'rvol':1.2,'family':'FIRST_RETEST'};idx={r['timestamp']:j for j,r in enumerate(rs)}
  a=v.feature_vector(c,rs,tech,rs,idx,v6.complete_days(rs),v6)
  prefix=rs[:i+1];b=v.feature_vector(c,prefix,v.technical_series(prefix),prefix,idx,v6.complete_days(prefix),v6)
  self.assertEqual(a,b);self.assertEqual(len(a),len(v.FEATURES))
 def test_fitted_model_deterministic_and_future_labels_excluded(self):
  import numpy as np
  from threadpoolctl import threadpool_limits
  pool=[{'id':str(i),'features':[float((i*j+3)%17)/17 for j in range(1,len(v.FEATURES)+1)],
         'knownAt':i*v.BAR,'entryAt':i*v.BAR,'labelEnd':(i+18)*v.BAR,'symbol':str(i),'label':i%2} for i in range(200)]
  cutoff=250*v.BAR
  a,ma=v.fit_gate(pool,cutoff)
  future=[dict(pool[0],id='future',knownAt=300*v.BAR,entryAt=300*v.BAR,labelEnd=318*v.BAR,label=1)]
  b,mb=v.fit_gate(pool+future,cutoff)
  self.assertEqual(ma,mb);self.assertEqual(ma['status'],'FIT_PAST_ONLY')
  with threadpool_limits(limits=1):
   np.testing.assert_array_equal(a.predict_proba(np.array([p['features'] for p in pool])),b.predict_proba(np.array([p['features'] for p in pool])))
 def test_source_candidates_future_prefix_invariant(self):
  v6=v.v6_module();v5=v6.frozen_v5();vm=v5.transfer_module().load_v3(1742860800000,1790294400000)
  rs=rows();a=v.source_candidates(vm,rs,'A',vm.indicators(rs),v.technical_series(rs))
  prefix=rs[:151];b=v.source_candidates(vm,prefix,'A',vm.indicators(prefix),v.technical_series(prefix))
  self.assertEqual([c for c in a if c['signalIndex']<151],b)
if __name__=='__main__':unittest.main()
