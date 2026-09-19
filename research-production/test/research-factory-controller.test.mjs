import test from 'node:test';
import assert from 'node:assert/strict';
import { planResearchFactoryCycle, RESEARCH_FACTORY_STAGE_SEQUENCE } from '../src/research-factory-controller.mjs';

const SHA='a'.repeat(40);
const H1='1'.repeat(64);
const H2='2'.repeat(64);
const H3='3'.repeat(64);
const SNAP='4'.repeat(64);
const base={researchSha:SHA,observedAt:'2026-09-19T18:40:00+09:00'};

function candidate(overrides={}){
  return {
    candidateId:'candidate:A', familyId:'family:trend', market:'CRYPTO_FUTURES', researchSha:SHA,
    strategyHash:H1, parameterHash:H2, datasetSnapshotHash:SNAP, completedStages:[], stageAuthorizations:{}, ...overrides,
  };
}

test('data gaps outrank candidate work and block candidate advancement',()=>{
  const plan=planResearchFactoryCycle({...base,markets:{CRYPTO_FUTURES:{ready:false,missingFeatures:['fundingRate','benchmarkReturn']}},candidates:[candidate()]});
  assert.equal(plan.queue[0].kind,'DATA_EVIDENCE');
  assert.equal(plan.queue[0].priority,100);
  assert.equal(plan.summary.marketReadyCount,0);
  assert.ok(plan.blockers.some((row)=>row.code==='CANDIDATE_DATA_BLOCKED'));
  assert.equal(plan.safety.executionAuthority,'NONE');
});

test('candidate resumes at exactly the next canonical stage',()=>{
  const completed=RESEARCH_FACTORY_STAGE_SEQUENCE.slice(0,6);
  const plan=planResearchFactoryCycle({...base,markets:{CRYPTO_FUTURES:{ready:true,datasetSnapshotHash:SNAP}},candidates:[candidate({completedStages:completed})]});
  const task=plan.queue.find((row)=>row.kind==='RUN_STAGE');
  assert.equal(task.stage,'COST_STRESS');
  assert.equal(task.canonicalOwner,'market-prediction-lab/research-tournament');
});

test('guarded stages never auto-activate without explicit stage authorization',()=>{
  const completed=RESEARCH_FACTORY_STAGE_SEQUENCE.slice(0,9);
  const plan=planResearchFactoryCycle({...base,markets:{CRYPTO_FUTURES:{ready:true,datasetSnapshotHash:SNAP}},candidates:[candidate({completedStages:completed})]});
  assert.equal(plan.queue.some((row)=>row.kind==='RUN_STAGE'),false);
  assert.ok(plan.blockers.some((row)=>row.code==='STAGE_AUTHORIZATION_REQUIRED'&&row.stage==='FINAL_HOLDOUT'));
});

test('known failed strategy is remembered and not re-run',()=>{
  const plan=planResearchFactoryCycle({...base,markets:{CRYPTO_FUTURES:{ready:true,datasetSnapshotHash:SNAP}},candidates:[candidate()],failureMemory:[{strategyHash:H1,failureCode:'OOS_FAILED'}]});
  assert.equal(plan.queue.some((row)=>row.kind==='RUN_STAGE'),false);
  assert.ok(plan.blockers.some((row)=>row.code==='KNOWN_FAILED_STRATEGY'));
});

test('free-only AI proposal is low priority and bounded by research budget',()=>{
  const plan=planResearchFactoryCycle({...base,budget:{maxQueue:2,maxConcurrentJobs:2,maxAiCallsPerCycle:1,maxCandidatesPerFamily:32},markets:{CRYPTO_FUTURES:{ready:true,datasetSnapshotHash:SNAP}},candidates:[candidate({strategyHash:H3})],ai:{enabled:true,freeOnly:true,allowNewHypotheses:true,callsUsed:0}});
  assert.equal(plan.queue.length,2);
  assert.equal(plan.queue[0].kind,'RUN_STAGE');
  assert.equal(plan.queue[1].kind,'AI_PROPOSE');
  assert.equal(plan.queue[1].providerPolicy,'FREE_ONLY');
  assert.equal(plan.queue[1].evidenceCredit,0);
  assert.equal(plan.safety.paidAiFallback,false);
});

test('dataset snapshot mismatch fails closed',()=>{
  const plan=planResearchFactoryCycle({...base,markets:{CRYPTO_FUTURES:{ready:true,datasetSnapshotHash:'5'.repeat(64)}},candidates:[candidate()]});
  assert.equal(plan.queue.some((row)=>row.kind==='RUN_STAGE'),false);
  assert.ok(plan.blockers.some((row)=>row.code==='DATASET_SNAPSHOT_MISMATCH'));
});
