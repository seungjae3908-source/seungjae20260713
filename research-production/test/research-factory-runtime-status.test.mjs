import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  ADAPTIVE_MULTI_MARKET_PROFILES_V1,
  ADAPTIVE_TOURNAMENT_STAGES_V1,
} from '../../market-prediction-lab/src/adaptive-multi-market-tournament-orchestrator-v1.js';
import { createAdaptivePolicyRecordV1 } from '../src/adaptive-policy-record.mjs';
import { buildResearchFactoryRuntimeStatusV1 } from '../src/research-factory-runtime-status.mjs';

const SHA='a'.repeat(40);
const AT='2026-09-19T11:10:00.000Z';
const execFileAsync=promisify(execFile);
const FACTORY_STATUS_CLI=join(dirname(fileURLToPath(import.meta.url)),'../bin/research-factory-status.mjs');

function readyProfileEvidence(profileId='CRYPTO_FUTURES:SHORT'){
  const profile=ADAPTIVE_MULTI_MARKET_PROFILES_V1.find((row)=>row.profileId===profileId);
  return {
    profile,
    evidenceCatalog:{
      [profile.profileId]:Object.fromEntries(profile.requiredEvidence.map((requirement)=>[
        requirement,
        {status:'PRESENT',evidenceId:`fixture:${profile.profileId}:${requirement}`,observedAt:AT},
      ])),
    },
  };
}

function approvedPolicyRecord(){
  return createAdaptivePolicyRecordV1({
    policy:policy(),
    approvedAt:'2026-09-19T11:00:00.000Z',
    approvalEvidenceId:'github-comment:123456',
  });
}

function policy(){
  const caps=[16,16,12,10,6,4,3,2,2,1,1,1,1];
  const ratios=[1,1,0.75,0.625,0.375,0.25,0.1875,0.125,0.125,0.0625,0.0625,0.0625,0.0625];
  return {
    policyId:'fixture-policy-v1',
    totalCandidateBudget:16,
    minimumCandidatesPerReadyProfile:16,
    maximumCandidatesPerReadyProfile:16,
    diagnosticWeights:{dataCompleteness:0.3,signalCoverage:0.2,costCoverage:0.2,familyDiversity:0.2,computeCapacity:0.1},
    stagePolicy:ADAPTIVE_TOURNAMENT_STAGES_V1.map((stage,index)=>({stage,retentionRatio:ratios[index],maximumPerProfile:caps[index]})),
    maximumParetoSurvivorsPerSpecialist:2,
  };
}

test('missing policy is a stable blocker, not a runtime failure or invented budget',()=>{
  const result=buildResearchFactoryRuntimeStatusV1({researchSha:SHA,observedAt:AT});
  assert.equal(result.status,'BLOCKED_POLICY_MISSING');
  assert.equal(result.firstZero,'HUMAN_APPROVED_ADAPTIVE_POLICY_MISSING');
  assert.equal(result.policy.present,false);
  assert.equal(result.policy.policyDigest,null);
  assert.equal(result.canonicalAdaptive.readyProfileCount,null);
  assert.equal(result.safety.runtimeExecutionAttempted,false);
  assert.equal(result.safety.executionAuthority,'NONE');
});

test('tampered configured policy fails closed and exposes no policy values',()=>{
  const record=createAdaptivePolicyRecordV1({
    policy:policy(),
    approvedAt:'2026-09-19T11:00:00.000Z',
    approvalEvidenceId:'github-comment:123456',
  });
  const tampered={...record,policy:{...record.policy,totalCandidateBudget:999}};
  const result=buildResearchFactoryRuntimeStatusV1({
    researchSha:SHA,observedAt:AT,policyRecord:tampered,
  });
  assert.equal(result.status,'BLOCKED_POLICY_INVALID');
  assert.equal(result.policy.present,true);
  assert.equal(result.policy.valid,false);
  assert.equal(result.policy.policyDigest,null);
  assert.equal(JSON.stringify(result).includes('999'),false);
  assert.equal(result.safety.runtimeExecutionAttempted,false);
});

test('valid approved policy with no profile evidence stays blocked on canonical data readiness',()=>{
  const record=createAdaptivePolicyRecordV1({
    policy:policy(),
    approvedAt:'2026-09-19T11:00:00.000Z',
    approvalEvidenceId:'github-comment:123456',
  });
  const result=buildResearchFactoryRuntimeStatusV1({
    researchSha:SHA,observedAt:AT,policyRecord:record,
  });
  assert.equal(result.policy.valid,true);
  assert.equal(result.status,'BLOCKED_NO_READY_PROFILES');
  assert.equal(result.canonicalAdaptive.readyProfileCount,0);
  assert.equal(result.canonicalAdaptive.runtimeStatus,'BLOCKED_NO_READY_PROFILES');
  assert.equal(result.safety.executionAuthority,'NONE');
});

test('ready profile with no development diagnostic becomes explicit missing-diagnostic blocker',()=>{
  const {profile,evidenceCatalog}=readyProfileEvidence();
  const result=buildResearchFactoryRuntimeStatusV1({
    researchSha:SHA,
    observedAt:AT,
    policyRecord:approvedPolicyRecord(),
    adaptiveEvidenceCatalog:evidenceCatalog,
    developmentDiagnostics:{},
  });
  assert.equal(result.status,'BLOCKED_DEVELOPMENT_DIAGNOSTICS_MISSING');
  assert.equal(result.firstZero,'DEVELOPMENT_DIAGNOSTIC_REQUIRED');
  assert.equal(result.canonicalAdaptive.readyProfileCount,1);
  assert.equal(result.canonicalAdaptive.blockedProfileCount,11);
  assert.equal(result.canonicalAdaptive.runtimeStatus,'BLOCKED_DEVELOPMENT_DIAGNOSTICS_MISSING');
  assert.match(result.diagnostic,new RegExp(profile.profileId));
  assert.equal(result.controlPlaneDigest,null);
  assert.equal(result.safety.runtimeExecutionAttempted,false);
  assert.equal(result.safety.executionAuthority,'NONE');
});

test('development diagnostic containing forbidden hindsight feedback is explicit INVALID blocker',()=>{
  const {profile,evidenceCatalog}=readyProfileEvidence();
  const result=buildResearchFactoryRuntimeStatusV1({
    researchSha:SHA,
    observedAt:AT,
    policyRecord:approvedPolicyRecord(),
    adaptiveEvidenceCatalog:evidenceCatalog,
    developmentDiagnostics:{
      [profile.profileId]:{
        sourceRole:'DEVELOPMENT_ONLY',
        evidenceId:'development-diagnostic:unsafe',
        dataCompleteness:1,
        signalCoverage:0.8,
        costCoverage:1,
        familyDiversity:0.7,
        computeCapacity:0.9,
        oosWinRate:0.99,
      },
    },
  });
  assert.equal(result.status,'BLOCKED_DEVELOPMENT_DIAGNOSTICS_INVALID');
  assert.equal(result.firstZero,'DEVELOPMENT_DIAGNOSTIC_INVALID');
  assert.equal(result.canonicalAdaptive.readyProfileCount,1);
  assert.match(result.diagnostic,/HINDSIGHT_FEEDBACK_FORBIDDEN/);
  assert.equal(JSON.stringify(result).includes('0.99'),false);
  assert.equal(result.safety.runtimeExecutionAttempted,false);
  assert.equal(result.safety.executionAuthority,'NONE');
});

test('complete development-only diagnostic advances past diagnostic blocker and leaves next gate truthful',()=>{
  const {profile,evidenceCatalog}=readyProfileEvidence();
  const result=buildResearchFactoryRuntimeStatusV1({
    researchSha:SHA,
    observedAt:AT,
    policyRecord:approvedPolicyRecord(),
    adaptiveEvidenceCatalog:evidenceCatalog,
    developmentDiagnostics:{
      [profile.profileId]:{
        sourceRole:'DEVELOPMENT_ONLY',
        evidenceId:'development-diagnostic:safe',
        dataCompleteness:1,
        signalCoverage:0.8,
        costCoverage:1,
        familyDiversity:0.7,
        computeCapacity:0.9,
      },
    },
    runtimeBindings:{},
  });
  assert.equal(result.status,'BLOCKED_RUNTIME_BINDINGS');
  assert.equal(result.firstZero,'RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_PORT_MISSING');
  assert.equal(result.canonicalAdaptive.readyProfileCount,1);
  assert.equal(result.safety.executionAuthority,'NONE');
});

test('Factory runtime timestamp is canonical and rejects impossible dates',()=>{
  const wholeSecond=buildResearchFactoryRuntimeStatusV1({
    researchSha:SHA,
    observedAt:'2026-09-19T11:10:00Z',
  });
  assert.equal(wholeSecond.generatedAt,'2026-09-19T11:10:00.000Z');

  assert.throws(
    ()=>buildResearchFactoryRuntimeStatusV1({
      researchSha:SHA,
      observedAt:'2026-02-30T00:00:00Z',
    }),
    /observedAt invalid/,
  );
});

test('Factory status CLI rejects relative and symlink state roots',async()=>{
  await assert.rejects(
    execFileAsync(process.execPath,[FACTORY_STATUS_CLI],{
      env:{...process.env,RESEARCH_CODE_SHA:SHA,RESEARCH_STATE_ROOT:'relative-factory-state'},
    }),
    (error)=>{
      assert.match(String(error.stderr??''),/RESEARCH_STATE_ROOT must be absolute/);
      return true;
    },
  );

  const target=await mkdtemp(join(tmpdir(),'factory-status-target-'));
  const holder=await mkdtemp(join(tmpdir(),'factory-status-holder-'));
  const linkRoot=join(holder,'state-link');
  await symlink(target,linkRoot,'dir');
  await assert.rejects(
    execFileAsync(process.execPath,[FACTORY_STATUS_CLI],{
      env:{...process.env,RESEARCH_CODE_SHA:SHA,RESEARCH_STATE_ROOT:linkRoot},
    }),
    (error)=>{
      assert.match(String(error.stderr??''),/Factory state root must not contain symbolic links/);
      return true;
    },
  );
});

test('Factory status CLI rejects symlink latest output directory',async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-status-safe-'));
  const outside=await mkdtemp(join(tmpdir(),'factory-status-outside-'));
  await symlink(outside,join(root,'latest'),'dir');
  await assert.rejects(
    execFileAsync(process.execPath,[FACTORY_STATUS_CLI],{
      env:{...process.env,RESEARCH_CODE_SHA:SHA,RESEARCH_STATE_ROOT:root},
    }),
    (error)=>{
      assert.match(String(error.stderr??''),/Factory latest must be a regular non-symlink directory|must not traverse symbolic links/);
      return true;
    },
  );
});

test('Factory status CLI auto-discovers default development diagnostics path and fails closed on tamper',async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-status-default-diagnostic-'));
  const latest=join(root,'latest');
  await mkdir(latest,{recursive:true});
  await writeFile(join(latest,'adaptive-development-diagnostics.json'),'{not-json');
  await assert.rejects(
    execFileAsync(process.execPath,[FACTORY_STATUS_CLI],{
      env:{
        ...process.env,
        RESEARCH_CODE_SHA:SHA,
        RESEARCH_STATE_ROOT:root,
        RESEARCH_ADAPTIVE_DEVELOPMENT_DIAGNOSTICS_PATH:'',
        RESEARCH_ADAPTIVE_RUNTIME_BINDINGS_PATH:'',
      },
    }),
    (error)=>{
      assert.match(String(error.stderr??''),/FACTORY_RUNTIME_STATUS_INPUT_INVALID/);
      return true;
    },
  );
});

test('Factory status CLI auto-discovers default runtime bindings path and fails closed on tamper',async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-status-default-bindings-'));
  const latest=join(root,'latest');
  await mkdir(latest,{recursive:true});
  await writeFile(join(latest,'adaptive-development-diagnostics.json'),'{}');
  await writeFile(join(latest,'adaptive-runtime-bindings.json'),'{not-json');
  await assert.rejects(
    execFileAsync(process.execPath,[FACTORY_STATUS_CLI],{
      env:{
        ...process.env,
        RESEARCH_CODE_SHA:SHA,
        RESEARCH_STATE_ROOT:root,
        RESEARCH_ADAPTIVE_DEVELOPMENT_DIAGNOSTICS_PATH:'',
        RESEARCH_ADAPTIVE_RUNTIME_BINDINGS_PATH:'',
      },
    }),
    (error)=>{
      assert.match(String(error.stderr??''),/FACTORY_RUNTIME_STATUS_INPUT_INVALID/);
      return true;
    },
  );
});

test('Factory status CLI rejects symlinked default diagnostics and runtime bindings files',async()=>{
  for(const fileName of ['adaptive-development-diagnostics.json','adaptive-runtime-bindings.json']){
    const root=await mkdtemp(join(tmpdir(),'factory-status-default-symlink-'));
    const latest=join(root,'latest');
    const outside=await mkdtemp(join(tmpdir(),'factory-status-default-symlink-outside-'));
    await mkdir(latest,{recursive:true});
    const outsideFile=join(outside,'payload.json');
    await writeFile(outsideFile,'{}');
    if(fileName==='adaptive-runtime-bindings.json'){
      await writeFile(join(latest,'adaptive-development-diagnostics.json'),'{}');
    }
    await symlink(outsideFile,join(latest,fileName),'file');
    await assert.rejects(
      execFileAsync(process.execPath,[FACTORY_STATUS_CLI],{
        env:{
          ...process.env,
          RESEARCH_CODE_SHA:SHA,
          RESEARCH_STATE_ROOT:root,
          RESEARCH_ADAPTIVE_DEVELOPMENT_DIAGNOSTICS_PATH:'',
          RESEARCH_ADAPTIVE_RUNTIME_BINDINGS_PATH:'',
        },
      }),
      (error)=>{
        assert.match(String(error.stderr??''),/FACTORY_RUNTIME_STATUS_INPUT_INVALID/);
        return true;
      },
    );
  }
});

test('adaptive policy record accepts whole-second UTC and rejects impossible approval dates',()=>{
  const record=createAdaptivePolicyRecordV1({
    policy:policy(),
    approvedAt:'2026-09-19T11:00:00Z',
    approvalEvidenceId:'github-comment:123456',
  });
  assert.equal(record.approvedAt,'2026-09-19T11:00:00.000Z');

  assert.throws(()=>createAdaptivePolicyRecordV1({
    policy:policy(),
    approvedAt:'2026-02-30T11:00:00Z',
    approvalEvidenceId:'github-comment:123456',
  }),/approvedAt must be canonical ISO-8601 UTC/);
});
