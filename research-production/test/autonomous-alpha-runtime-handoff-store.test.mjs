import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AUTONOMOUS_ALPHA_RUNTIME_HANDOFF_STORE_V1,
  buildAndPersistAutonomousAlphaRuntimeHandoffV1,
} from '../src/autonomous-alpha-runtime-handoff-store.mjs';

const SHA='a'.repeat(40);

function canonical(value){
  if(Array.isArray(value)) return value.map(canonical);
  if(!value||typeof value!=='object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key)=>[key,canonical(value[key])]),
  );
}

function digest(value){
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function chain(bindingsDigest,overrides={}){
  return {
    schemaVersion:1,
    contract:'research-canonical-chain/v1',
    status:'CANONICAL_CHAIN_READY_NON_ACTIVATING',
    researchSha:SHA,
    dslDigest:'b'.repeat(64),
    bundleDigest:'c'.repeat(64),
    publicationStatus:'READBACK_VERIFIED',
    bindingsDigest,
    allBindingsAvailable:true,
    safety:{
      generatedEvidence:false,
      syntheticBundleAllowed:false,
      evidenceCredit:0,
      profitabilityProven:false,
      runtimeExecutionAttempted:false,
      runtimeActivationAllowed:false,
      scheduleMutationAllowed:false,
      deploymentAllowed:false,
      liveTrading:false,
      autoTrading:false,
      privateTradingApi:false,
      realOrder:false,
      executionAuthority:'NONE',
    },
    ...overrides,
  };
}

function bindingRecord(rawBindings){
  const bindingsDigest=digest(rawBindings);
  const core={
    schemaVersion:1,
    contract:'research-runtime-bindings-store/v1',
    generatedAt:'2026-09-20T00:00:00.000Z',
    sourceSha:SHA,
    bindingsDigest,
    availableKeys:['checkpoint','compiler','backtester','statistics','canonicalBundle'],
    missingKeys:[],
    allBindingsAvailable:true,
    safety:{
      rawBindingsAreCanonicalInput:true,
      runtimeExecutionAttempted:false,
      runtimeActivationAllowed:false,
      scheduleMutationAllowed:false,
      deploymentAllowed:false,
      liveTradingAllowed:false,
      executionAuthority:'NONE',
    },
  };
  return {...core,recordDigest:digest(core)};
}

const STAGES=[
  'worldKnowledge',
  'alphaGenome',
  'redTeam',
  'forecast',
  'counterfactual',
  'digitalTwin',
  'championChallenger',
  'certification',
];

async function fixture({writeStages=true}={}){
  const root=await mkdtemp(join(tmpdir(),'alpha-handoff-'));
  const artifactRoot=join(root,'artifacts');
  const paperForwardRoot=join(root,'paper-forward');
  await mkdir(artifactRoot,{recursive:true});
  await mkdir(paperForwardRoot,{recursive:true});

  const rawBindings={
    checkpoint:{status:'AVAILABLE'},
    compiler:{status:'AVAILABLE'},
    backtester:{status:'AVAILABLE'},
    statistics:{status:'AVAILABLE'},
    canonicalBundle:{status:'AVAILABLE'},
  };
  const record=bindingRecord(rawBindings);
  const chainValue=chain(record.bindingsDigest);
  const paths={
    chain:join(artifactRoot,'canonical-chain.json'),
    bindings:join(artifactRoot,'adaptive-runtime-bindings.json'),
    record:join(artifactRoot,'adaptive-runtime-bindings-record.json'),
    stages:{},
  };
  await writeFile(paths.chain,`${JSON.stringify(chainValue)}\n`);
  await writeFile(paths.bindings,`${JSON.stringify(rawBindings)}\n`);
  await writeFile(paths.record,`${JSON.stringify(record)}\n`);

  for(const key of STAGES){
    paths.stages[key]=join(artifactRoot,`${key}.json`);
    if(writeStages){
      await writeFile(paths.stages[key],`${JSON.stringify({
        artifact:key,
        status:'fixture',
        executionAuthority:'NONE',
      })}\n`);
    }
  }

  return {root,artifactRoot,paperForwardRoot,rawBindings,record,chainValue,paths};
}

function readiness({ready=true,blockers=[]}={}){
  return {
    schemaVersion:'autonomous-alpha-certification-v1',
    artifactType:'AUTONOMOUS_ALPHA_ARCHITECTURE_READINESS',
    status:ready
      ? 'ARCHITECTURE_READY_EVIDENCE_PENDING_INACTIVE'
      : 'ARCHITECTURE_BLOCKED',
    blockers,
    lineageChecks:[
      {name:'WORLD_TO_GENOME',passed:ready},
      {name:'GENOME_TO_RED_TEAM',passed:ready},
      {name:'RED_TEAM_TO_FORECAST',passed:ready},
      {name:'FORECAST_TO_COUNTERFACTUAL',passed:ready},
      {name:'COUNTERFACTUAL_TO_DIGITAL_TWIN',passed:ready},
      {name:'DIGITAL_TWIN_TO_CHAMPION',passed:ready},
      {name:'RED_TEAM_TO_CHAMPION_EVIDENCE',passed:ready},
      {name:'CHAMPION_TO_CERTIFICATION',passed:ready},
      {name:'CANDIDATE_ID_CONTINUITY',passed:ready},
    ],
    architectureReady:ready,
    profitabilityProven:false,
    readinessDigest:'d'.repeat(64),
    executionAuthority:'NONE',
    liveTradingAllowed:false,
    autoTradingAllowed:false,
    realOrderAllowed:false,
  };
}

function args(f){
  return {
    sourceSha:SHA,
    artifactRoot:f.artifactRoot,
    paperForwardRoot:f.paperForwardRoot,
    canonicalChainPath:f.paths.chain,
    runtimeBindingsPath:f.paths.bindings,
    runtimeBindingsRecordPath:f.paths.record,
    stagePaths:{...f.paths.stages},
    generatedAt:'2026-09-20T00:00:00.000Z',
    architectureReadinessBuilder:()=>readiness(),
  };
}

test('missing Alpha stage artifacts return WAITING and never fabricate a handoff',async()=>{
  const f=await fixture({writeStages:false});
  const result=await buildAndPersistAutonomousAlphaRuntimeHandoffV1(args(f));

  assert.equal(result.contract,AUTONOMOUS_ALPHA_RUNTIME_HANDOFF_STORE_V1);
  assert.equal(result.status,'WAITING_FOR_CANONICAL_ALPHA_ARTIFACTS');
  assert.equal(result.handoffWritten,false);
  assert.deepEqual(result.missingKeys,[...STAGES].sort());
  assert.equal(result.executionAuthority,'NONE');
  assert.equal(result.liveTrading,false);
  assert.equal(result.autoTrading,false);
  assert.equal(result.economicSampleCredit,0);
  await assert.rejects(
    access(join(f.paperForwardRoot,'autonomous-alpha','handoff-v1.json')),
  );
});

test('publishes exact-source immutable Alpha handoff only after chain bindings and lineage are ready',async()=>{
  const f=await fixture();
  let observedStages=null;
  const result=await buildAndPersistAutonomousAlphaRuntimeHandoffV1({
    ...args(f),
    architectureReadinessBuilder:(value)=>{
      observedStages=value;
      return readiness();
    },
  });

  assert.equal(result.status,'PUBLISHED_ALPHA_RUNTIME_HANDOFF');
  assert.equal(result.handoffWritten,true);
  assert.equal(result.sourceSha,SHA);
  assert.match(result.handoffDigest,/^[0-9a-f]{64}$/u);
  assert.equal(result.executionAuthority,'NONE');
  assert.equal(result.profitabilityProven,false);
  assert.deepEqual(Object.keys(observedStages).sort(),[...STAGES].sort());

  const path=join(f.paperForwardRoot,'autonomous-alpha','handoff-v1.json');
  const handoff=JSON.parse(await readFile(path,'utf8'));
  assert.equal(handoff.schemaVersion,'autonomous-alpha-runtime-handoff-v1');
  assert.equal(handoff.sourceSha,SHA);
  assert.equal(handoff.handoffDigest,result.handoffDigest);
  assert.equal(handoff.canonicalChain.bindingsDigest,f.record.bindingsDigest);
  assert.equal(handoff.runtimeBindingsRecordDigest,f.record.recordDigest);
  assert.equal(handoff.executionAuthority,'NONE');
  assert.equal(handoff.liveTrading,false);
  assert.equal(handoff.autoTrading,false);
  assert.equal(handoff.realOrderEnabled,false);
  assert.equal(handoff.privateTradingApiAllowed,false);
  for(const key of STAGES) assert.equal(handoff[key].artifact,key);
  const mode=(await stat(path)).mode & 0o777;
  assert.equal(mode,0o600);
});

test('tampered raw bindings are blocked and no handoff is written',async()=>{
  const f=await fixture();
  await writeFile(f.paths.bindings,JSON.stringify({tampered:true}));
  const result=await buildAndPersistAutonomousAlphaRuntimeHandoffV1(args(f));

  assert.equal(result.status,'BLOCKED_DATA');
  assert.deepEqual(result.blockers,['ALPHA_RUNTIME_BINDINGS_INVALID']);
  assert.equal(result.handoffWritten,false);
  await assert.rejects(
    access(join(f.paperForwardRoot,'autonomous-alpha','handoff-v1.json')),
  );
});

test('unsafe or wrong-SHA canonical chain is blocked before handoff publication',async()=>{
  const f=await fixture();
  await writeFile(f.paths.chain,JSON.stringify(chain(f.record.bindingsDigest,{
    researchSha:'f'.repeat(40),
  })));
  const result=await buildAndPersistAutonomousAlphaRuntimeHandoffV1(args(f));

  assert.equal(result.status,'BLOCKED_DATA');
  assert.deepEqual(result.blockers,['ALPHA_CANONICAL_CHAIN_INVALID']);
  assert.equal(result.handoffWritten,false);
});

test('lineage failure blocks publication even when all files exist',async()=>{
  const f=await fixture();
  const result=await buildAndPersistAutonomousAlphaRuntimeHandoffV1({
    ...args(f),
    architectureReadinessBuilder:()=>readiness({
      ready:false,
      blockers:['ARCH_LINEAGE_FORECAST_TO_COUNTERFACTUAL_INVALID'],
    }),
  });

  assert.equal(result.status,'BLOCKED_DATA');
  assert.equal(result.handoffWritten,false);
  assert.ok(result.blockers.includes('ALPHA_ARCHITECTURE_READINESS_INVALID'));
  assert.ok(result.blockers.includes('ARCH_LINEAGE_FORECAST_TO_COUNTERFACTUAL_INVALID'));
});

test('artifact inputs cannot escape the explicit artifact root',async()=>{
  const f=await fixture();
  await assert.rejects(
    ()=>buildAndPersistAutonomousAlphaRuntimeHandoffV1({
      ...args(f),
      canonicalChainPath:join(f.root,'outside.json'),
    }),
    /canonicalChainPath must be below its allowed root/,
  );
});
