import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compileStrategyHypothesisToFormulaCandidatesV1,
  generateBoundedFormulaCandidatesV1,
} from '../../market-prediction-lab/src/autonomous-strategy-formula-generator-v1.js';
import { createStrategyHypothesisV1, createHypothesisDecisionV1 } from '../../packages/strategy-hypothesis/src/index.js';
import {
  exportResearchFormulaComponentsV1,
} from '../src/research-formula-component-store.mjs';

function fixture(){
  const hypothesis=createStrategyHypothesisV1({
    title:'component export hypothesis',
    statement:'bounded momentum may persist in research.',
    marketScope:['US'],
    assetClass:'EQUITY',
    timeframeScope:['15m'],
    directionality:'POSITIVE',
    rationale:'test research-only provenance',
    supportingPaperIds:[],
    contradictoryPaperIds:[],
    evidenceStrength:{supporting:'NONE',contradictory:'NONE'},
    expectedEffect:{observable:'NEXT_WINDOW_EXCESS_RETURN',direction:'INCREASE',minimumMagnitude:null,unit:'DECIMAL_RETURN',evaluationWindow:'15m'},
    falsificationCriteria:{observable:'NEXT_WINDOW_EXCESS_RETURN',metric:'MEAN_CONDITIONAL_EXCESS_RETURN',operator:'LTE',threshold:0,unit:'DECIMAL_RETURN',evaluationWindow:'15m',minimumObservations:10,rejectionStatement:'reject'},
    requiredData:[{dataset:'BARS',fields:['close'],frequency:'15m',provenanceRequired:true,licenseRequired:false}],
    knownLimitations:['test'],
    createdAt:'2026-09-20T00:00:00.000Z',
    generator:{name:'component-test',version:'1.0.0'},
    evidencePolicy:{requireKnownContentLicense:false,requireResolvedCorrections:true},
  },[]);
  const decision=createHypothesisDecisionV1({
    hypothesis,papers:[],verdict:'APPROVE_FOR_RESEARCH',rationale:'test',
    decidedAt:'2026-09-20T00:01:00.000Z',
    committee:{name:'test',version:'1.0.0',members:['a']},
  });
  const template={
    templateId:'component-template',
    hypothesisBinding:{
      hypothesisId:hypothesis.hypothesisId,
      hypothesisConfigHash:hypothesis.configHash,
      decisionId:decision.decisionId,
      decisionHash:decision.decisionHash,
    },
    strategyFamily:'MOMENTUM',
    market:'US_STOCK',
    timeframe:'15m',
    direction:'LONG',
    entryDsl:{action:'LONG',rules:[{kind:'OPERATOR',operator:'GT',operands:[
      {kind:'INDICATOR',name:'SMA',input:'close',parameters:{period:'lookback'}},
      {kind:'INDICATOR',name:'EMA',input:'close',parameters:{period:'lookback'}},
    ]}]},
    exitDsl:{rules:[{type:'TIME_EXIT',barsParameter:'bars'}]},
    parameterSpace:[
      {name:'bars',domain:'BAR_COUNT',valueType:'INTEGER',min:2,max:2,step:1},
      {name:'lookback',domain:'PERIOD',valueType:'INTEGER',min:5,max:5,step:1},
    ],
    limits:{maxAstDepth:6,maxIndicatorCount:8,maxRuleCount:8,maxAstNodes:64},
  };
  const budget={
    maxCandidatesPerRun:4,maxCandidatesPerHypothesis:4,maxGenerations:1,
    maxParameterCombinations:10,maxAstNodes:64,maxRuntimeMs:10000,maxCpuMs:5000,
    maxMemoryBytes:1024*1024,
  };
  const formula=compileStrategyHypothesisToFormulaCandidatesV1({
    hypothesis,decision,templates:[template],
    policy:{
      compilerId:'safe',compilerVersion:'1.0.0',
      costPolicyIdentity:'COST_V1',riskPolicyIdentity:'RISK_V1',
      datasetIdentity:'dataset:train:v1',datasetRole:'TRAIN',budget,
    },
  })[0];
  const generated=generateBoundedFormulaCandidatesV1({
    formulaCandidates:[formula],budget,
    search:{method:'BOUNDED_GRID',seed:1,requestedCandidates:1,datasetIdentity:'dataset:train:v1',finalHoldoutAccess:false},
  }).generatedCandidates[0];
  return {
    formula,generated,
    candidate:{
      formulaCandidate:formula,
      generatedCandidate:generated,
      formulaCandidateId:formula.candidateId,
      generatedCandidateId:generated.generatedCandidateId,
      strategyHash:formula.formulaHash,
      parameterIdentity:generated.parameterIdentity,
      terminalState:'RESEARCH_SURVIVOR',
      failure:null,
      researchSurvivor:true,
      profitable:false,
      provisionalChampion:false,
      validatedChampion:false,
      tradingAuthority:false,
      safety:{executionAuthority:'NONE'},
    },
  };
}

test('exports dsl formula and generated candidate from preserved tournament snapshots only',async()=>{
  const root=await mkdtemp(join(tmpdir(),'formula-component-store-'));
  const f=fixture();
  const result=await exportResearchFormulaComponentsV1({componentRoot:root,candidate:f.candidate});
  assert.equal(result.status,'exported');
  assert.equal(result.formulaHash,f.formula.formulaHash);
  assert.equal(result.parameterIdentity,f.generated.parameterIdentity);
  const dsl=JSON.parse(await readFile(result.paths.dsl,'utf8'));
  const formula=JSON.parse(await readFile(result.paths.formulaCandidate,'utf8'));
  const generated=JSON.parse(await readFile(result.paths.generatedCandidate,'utf8'));
  assert.deepEqual(formula,f.formula);
  assert.deepEqual(generated,f.generated);
  assert.deepEqual(dsl,{
    market:f.formula.market,timeframe:f.formula.timeframe,direction:f.formula.direction,
    availableDataFields:f.formula.availableDataFields,entryDsl:f.formula.entryDsl,exitDsl:f.formula.exitDsl,
    parameterSpace:f.formula.parameterSpace,limits:f.formula.dslLimits,
  });
  const repeated=await exportResearchFormulaComponentsV1({componentRoot:root,candidate:f.candidate});
  assert.equal(repeated.status,'already_present');
});

test('non-survivor or mutated generated candidate is rejected',async()=>{
  const root=await mkdtemp(join(tmpdir(),'formula-component-store-'));
  const f=fixture();
  await assert.rejects(
    exportResearchFormulaComponentsV1({componentRoot:root,candidate:{...f.candidate,researchSurvivor:false}}),
    /SURVIVOR_REQUIRED/,
  );
  await assert.rejects(
    exportResearchFormulaComponentsV1({
      componentRoot:root,
      candidate:{...f.candidate,generatedCandidate:{...f.generated,parameterIdentity:'f'.repeat(64)}},
    }),
    /PROVENANCE_INVALID/,
  );
});

test('existing component mutation causes conflict instead of overwrite',async()=>{
  const root=await mkdtemp(join(tmpdir(),'formula-component-store-'));
  const f=fixture();
  const result=await exportResearchFormulaComponentsV1({componentRoot:root,candidate:f.candidate});
  const formula=JSON.parse(await readFile(result.paths.formulaCandidate,'utf8'));
  formula.strategyFamily='TAMPERED';
  await writeFile(result.paths.formulaCandidate,JSON.stringify(formula));
  await assert.rejects(
    exportResearchFormulaComponentsV1({componentRoot:root,candidate:f.candidate}),
    /CONTENT_CONFLICT/,
  );
});
