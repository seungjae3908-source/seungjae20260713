import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compiledMomentumFormula } from '../../market-prediction-lab/tests/research-bundle-formula-fixture.js';
import {
  exportResearchFormulaComponentsV1,
} from '../src/research-formula-component-store.mjs';

function fixture(){
  const {formula,generated}=compiledMomentumFormula();
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


test('relative and symlink component roots are rejected',async()=>{
  const f=fixture();
  await assert.rejects(
    exportResearchFormulaComponentsV1({
      componentRoot:'relative-formula-root',
      candidate:f.candidate,
    }),
    /componentRoot must be absolute/,
  );

  const target=await mkdtemp(join(tmpdir(),'formula-component-target-'));
  const holder=await mkdtemp(join(tmpdir(),'formula-component-holder-'));
  const linkRoot=join(holder,'formula-link');
  await symlink(target,linkRoot,'dir');
  await assert.rejects(
    exportResearchFormulaComponentsV1({
      componentRoot:linkRoot,
      candidate:f.candidate,
    }),
    /componentRoot must not contain symbolic links/,
  );
});

test('formula-components symlink output is rejected',async()=>{
  const f=fixture();
  const root=await mkdtemp(join(tmpdir(),'formula-component-safe-root-'));
  const outside=await mkdtemp(join(tmpdir(),'formula-component-outside-'));
  await symlink(outside,join(root,'formula-components'),'dir');
  await assert.rejects(
    exportResearchFormulaComponentsV1({
      componentRoot:root,
      candidate:f.candidate,
    }),
    /formula-components must be a regular non-symlink directory|must not traverse symbolic links/,
  );
});
