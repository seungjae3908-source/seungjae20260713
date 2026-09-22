import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildResearchDevelopmentDiagnosticV1,
  persistResearchDevelopmentDiagnosticsV1,
} from '../src/research-development-diagnostics.mjs';

const H=(x)=>x.repeat(64);
const AT='2026-09-20T00:00:00.000Z';

function input(overrides={}){
  return {
    profileId:'CRYPTO_FUTURES:SWING',
    sourceRole:'DEVELOPMENT_ONLY',
    observedAt:AT,
    dataset:{observedCells:900,expectedCells:1000,evidenceDigest:H('1')},
    signals:{evaluableCandidates:8,totalCandidates:10,evidenceDigest:H('2')},
    costs:{readyComponents:7,requiredComponents:8,evidenceDigest:H('3')},
    families:{counts:[5,3,2],evidenceDigest:H('4')},
    compute:{maxConcurrentJobs:2,baseConcurrency:4,evidenceDigest:H('5')},
    ...overrides,
  };
}

test('diagnostic metrics are deterministic ratios or normalized entropy from DEVELOPMENT-only evidence',()=>{
  const result=buildResearchDevelopmentDiagnosticV1(input());
  assert.equal(result.diagnostic.sourceRole,'DEVELOPMENT_ONLY');
  assert.equal(result.diagnostic.dataCompleteness,0.9);
  assert.equal(result.diagnostic.signalCoverage,0.8);
  assert.equal(result.diagnostic.costCoverage,0.875);
  assert.equal(result.diagnostic.computeCapacity,0.5);
  assert.ok(result.diagnostic.familyDiversity>0&&result.diagnostic.familyDiversity<=1);
  assert.match(result.diagnostic.evidenceId,/^development-diagnostic:sha256:[0-9a-f]{64}$/);
  assert.equal(result.safety.performanceMetricInputAllowed,false);
  assert.equal(result.safety.executionAuthority,'NONE');
});

test('single strategy family has zero diversity without fabricating a positive score',()=>{
  const result=buildResearchDevelopmentDiagnosticV1(input({
    signals:{evaluableCandidates:10,totalCandidates:10,evidenceDigest:H('2')},
    families:{counts:[10],evidenceDigest:H('4')},
  }));
  assert.equal(result.diagnostic.familyDiversity,0);
});

test('incomplete, inconsistent, or out-of-range raw counts fail closed',()=>{
  assert.throws(()=>buildResearchDevelopmentDiagnosticV1(input({
    dataset:{observedCells:1001,expectedCells:1000,evidenceDigest:H('1')},
  })),/EXCEEDS_DENOMINATOR/);
  assert.throws(()=>buildResearchDevelopmentDiagnosticV1(input({
    families:{counts:[5,4],evidenceDigest:H('4')},
  })),/FAMILY_COUNT_TOTAL_MISMATCH/);
  assert.throws(()=>buildResearchDevelopmentDiagnosticV1(input({
    compute:{maxConcurrentJobs:5,baseConcurrency:4,evidenceDigest:H('5')},
  })),/EXCEEDS_DENOMINATOR/);
});

test('extra performance/OOS fields are refused by exact input shape',()=>{
  assert.throws(()=>buildResearchDevelopmentDiagnosticV1({
    ...input(),
    oosWinRate:0.99,
  }),/INPUT_SHAPE_INVALID/);
  assert.throws(()=>buildResearchDevelopmentDiagnosticV1({
    ...input(),
    profitFactor:2.5,
  }),/INPUT_SHAPE_INVALID/);
});

test('profile identity and source evidence digests are mandatory',()=>{
  assert.throws(()=>buildResearchDevelopmentDiagnosticV1(input({profileId:'MADE_UP:SWING'})),/PROFILE_UNKNOWN/);
  assert.throws(()=>buildResearchDevelopmentDiagnosticV1(input({
    dataset:{observedCells:900,expectedCells:1000,evidenceDigest:'bad'},
  })),/DATASET_EVIDENCE_DIGEST_INVALID/);
  assert.throws(()=>buildResearchDevelopmentDiagnosticV1(input({sourceRole:'OOS'})),/DEVELOPMENT_ONLY_SOURCE_REQUIRED/);
});

test('diagnostic persistence refuses relative and protected application storage roots',async()=>{
  await assert.rejects(
    persistResearchDevelopmentDiagnosticsV1({
      stateRoot:'relative/research-state',
      profiles:[input()],
    }),
    /stateRoot must be absolute/,
  );
  await assert.rejects(
    persistResearchDevelopmentDiagnosticsV1({
      stateRoot:'/var/lib/stock-app/research',
      profiles:[input()],
    }),
    /overlaps protected app storage/,
  );
});

test('persisted output is exactly the Factory diagnostic map plus a separate provenance record',async()=>{
  const root=await mkdtemp(join(tmpdir(),'development-diagnostics-'));
  const result=await persistResearchDevelopmentDiagnosticsV1({
    stateRoot:root,
    profiles:[input()],
  });
  assert.equal(result.status,'persisted');
  assert.equal(result.profileCount,1);
  const diagnostics=JSON.parse(await readFile(result.diagnosticsPath,'utf8'));
  const record=JSON.parse(await readFile(result.recordPath,'utf8'));
  assert.deepEqual(Object.keys(diagnostics),['CRYPTO_FUTURES:SWING']);
  assert.deepEqual(Object.keys(diagnostics['CRYPTO_FUTURES:SWING']).sort(),[
    'computeCapacity','costCoverage','dataCompleteness','evidenceId','familyDiversity','signalCoverage','sourceRole',
  ]);
  assert.equal(record.safety.developmentOnly,true);
  assert.equal(record.safety.oosInputAllowed,false);
  assert.equal(record.safety.executionAuthority,'NONE');
  assert.match(record.recordDigest,/^[0-9a-f]{64}$/);
});


test('diagnostic observedAt is canonical and rejects impossible calendar dates',()=>{
  const accepted=buildResearchDevelopmentDiagnosticV1(input({
    observedAt:'2026-09-20T00:00:00Z',
  }));
  assert.equal(accepted.observedAt,'2026-09-20T00:00:00.000Z');
  assert.throws(
    ()=>buildResearchDevelopmentDiagnosticV1(input({
      observedAt:'2026-02-30T00:00:00Z',
    })),
    /OBSERVED_AT_INVALID/,
  );
});

test('diagnostic persistence rejects symlink state and latest output roots',async()=>{
  const target=await mkdtemp(join(tmpdir(),'development-diagnostics-target-'));
  const holder=await mkdtemp(join(tmpdir(),'development-diagnostics-holder-'));
  const linkRoot=join(holder,'state-link');
  await symlink(target,linkRoot,'dir');
  await assert.rejects(
    persistResearchDevelopmentDiagnosticsV1({
      stateRoot:linkRoot,
      profiles:[input()],
    }),
    /stateRoot must not contain symbolic links/,
  );

  const root=await mkdtemp(join(tmpdir(),'development-diagnostics-safe-'));
  const outside=await mkdtemp(join(tmpdir(),'development-diagnostics-outside-'));
  await symlink(outside,join(root,'latest'),'dir');
  await assert.rejects(
    persistResearchDevelopmentDiagnosticsV1({
      stateRoot:root,
      profiles:[input()],
    }),
    /development diagnostics latest must be a regular non-symlink directory|must not traverse symbolic links/,
  );
});
