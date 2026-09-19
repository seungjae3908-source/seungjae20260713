import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildAndPersistResearchRuntimeBindingsV1,
  loadPersistedResearchRuntimeBindingsV1,
} from '../src/research-runtime-bindings-store.mjs';
import {
  createCanonicalBundleOfflinePublicationReceiptV1,
} from '../../market-prediction-lab/src/adaptive-runtime-owner-capabilities-v1.js';

const SHA='a'.repeat(40);
const HASH='b'.repeat(64);
const AT='2026-09-20T00:00:00.000Z';

function publication(overrides={}){
  const raw={
    schemaVersion:'research-canonical-bundle-publication-v1',
    dslDigest:HASH,
    bundleDigest:'c'.repeat(64),
    publicationStatus:'READBACK_VERIFIED',
    evidenceCredit:0,
    profitabilityProven:false,
    executionAuthority:'NONE',
  };
  return {
    ...createCanonicalBundleOfflinePublicationReceiptV1({
      researchCodeSha:SHA,
      publishedAt:AT,
      publication:raw,
    }),
    ...overrides,
  };
}

test('store persists four code capabilities while canonical bundle stays missing without readback publication',async()=>{
  const root=await mkdtemp(join(tmpdir(),'runtime-bindings-store-'));
  const result=await buildAndPersistResearchRuntimeBindingsV1({
    stateRoot:root,
    sourceSha:SHA,
    generatedAt:AT,
  });
  assert.equal(result.status,'persisted');
  assert.equal(result.allBindingsAvailable,false);
  assert.deepEqual(result.missingKeys,['canonicalBundleSource']);
  const raw=JSON.parse(await readFile(join(root,'latest','adaptive-runtime-bindings.json'),'utf8'));
  assert.equal(raw.canonicalBundleSource.status,'MISSING');
  assert.equal(raw.formulaCompiler.status,'AVAILABLE');
  assert.equal(raw.canonicalBacktester.status,'AVAILABLE');
  assert.equal(raw.statisticalFirewall.status,'AVAILABLE');
  assert.equal(raw.stageCheckpointExecutor.status,'AVAILABLE');
  const loaded=await loadPersistedResearchRuntimeBindingsV1({stateRoot:root});
  assert.equal(loaded.record.bindingsDigest,result.bindingsDigest);
});

test('valid durable bundle publication file completes and persists all five bindings',async()=>{
  const root=await mkdtemp(join(tmpdir(),'runtime-bindings-store-'));
  const publicationPath=join(root,'bundle-publication.json');
  await writeFile(publicationPath,JSON.stringify(publication()));
  const result=await buildAndPersistResearchRuntimeBindingsV1({
    stateRoot:root,
    sourceSha:SHA,
    bundlePublicationPath:publicationPath,
    generatedAt:AT,
  });
  assert.equal(result.allBindingsAvailable,true);
  assert.deepEqual(result.missingKeys,[]);
  const raw=JSON.parse(await readFile(join(root,'latest','adaptive-runtime-bindings.json'),'utf8'));
  assert.equal(raw.canonicalBundleSource.status,'AVAILABLE');
  assert.equal(raw.canonicalBundleSource.capability,'AUTHENTIC_CANONICAL_BUNDLE_SOURCE_V1');
});

test('unsafe or economically authoritative bundle publication remains missing instead of becoming available',async()=>{
  for(const bad of [
    publication({evidenceCredit:1}),
    publication({profitabilityProven:true}),
    publication({executionAuthority:'TRADING'}),
  ]){
    const root=await mkdtemp(join(tmpdir(),'runtime-bindings-store-'));
    const result=await buildAndPersistResearchRuntimeBindingsV1({
      stateRoot:root,
      sourceSha:SHA,
      bundlePublication:bad,
      generatedAt:AT,
    });
    assert.equal(result.allBindingsAvailable,false);
    assert.deepEqual(result.missingKeys,['canonicalBundleSource']);
  }
});

test('tampered raw bindings are detected against digest-bound store record',async()=>{
  const root=await mkdtemp(join(tmpdir(),'runtime-bindings-store-'));
  await buildAndPersistResearchRuntimeBindingsV1({
    stateRoot:root,
    sourceSha:SHA,
    generatedAt:AT,
  });
  const rawPath=join(root,'latest','adaptive-runtime-bindings.json');
  const raw=JSON.parse(await readFile(rawPath,'utf8'));
  raw.formulaCompiler.status='MISSING';
  await writeFile(rawPath,JSON.stringify(raw));
  await assert.rejects(
    loadPersistedResearchRuntimeBindingsV1({stateRoot:root}),
    /RAW_DIGEST_MISMATCH/,
  );
});

test('ambiguous publication inputs are rejected',async()=>{
  const root=await mkdtemp(join(tmpdir(),'runtime-bindings-store-'));
  await assert.rejects(
    buildAndPersistResearchRuntimeBindingsV1({
      stateRoot:root,
      sourceSha:SHA,
      bundlePublication:publication(),
      bundlePublicationPath:join(root,'bundle.json'),
      generatedAt:AT,
    }),
    /INPUT_AMBIGUOUS/,
  );
});
