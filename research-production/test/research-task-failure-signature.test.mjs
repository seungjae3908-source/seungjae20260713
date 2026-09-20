import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';

import {
  buildSafeResearchTaskFailureSignatureV1,
  formatSafeResearchTaskFailureSignatureV1,
  resolveResearchTaskStderrPathV1,
} from '../../ops/research-production-task-failure-signature.mjs';

const SHA='a'.repeat(40);
const STATE='/var/lib/investment-research-production';

function cycle(stderrPath,overrides={}){
  return {
    researchSha:SHA,
    results:[
      {
        id:'paper-forward',
        status:'failed',
        stderrPath,
      },
      {
        id:'shadow-forward',
        status:'failed',
        stderrPath:join(STATE,'runs','cycle-1','shadow-forward','stderr.log'),
      },
    ],
    ...overrides,
  };
}

test('stderr resolver accepts only failed exact-SHA task paths under the Research runs root',()=>{
  const canonical=join(STATE,'runs','cycle-1','paper-forward','stderr.log');
  assert.equal(resolveResearchTaskStderrPathV1({
    cycle:cycle(canonical),
    stateRoot:STATE,
    taskId:'paper-forward',
    targetSha:SHA,
  }),resolve(canonical));

  assert.equal(resolveResearchTaskStderrPathV1({
    cycle:cycle('/tmp/outside/paper-forward/stderr.log'),
    stateRoot:STATE,
    taskId:'paper-forward',
    targetSha:SHA,
  }),null);

  assert.equal(resolveResearchTaskStderrPathV1({
    cycle:cycle(canonical,{researchSha:'b'.repeat(40)}),
    stateRoot:STATE,
    taskId:'paper-forward',
    targetSha:SHA,
  }),null);

  const notFailed=cycle(canonical);
  notFailed.results[0]={...notFailed.results[0],status:'blocked_data'};
  assert.equal(resolveResearchTaskStderrPathV1({
    cycle:notFailed,
    stateRoot:STATE,
    taskId:'paper-forward',
    targetSha:SHA,
  }),null);
});

test('signature extractor emits allowlisted codes and categories without raw stderr',()=>{
  const secret='super-secret-token-value';
  const raw=[
    'Error [ERR_MODULE_NOT_FOUND]: Cannot find package x',
    'PAPER_FORWARD_AUTHORITATIVE_ACCOUNT_BINDING_REQUIRED',
    'ReferenceError: missingThing is not defined',
    'ENOENT: no such file',
    secret,
  ].join('\n');
  const result=buildSafeResearchTaskFailureSignatureV1({
    profile:'forward',
    taskId:'paper-forward',
    stderrText:raw,
  });

  assert.equal(result.rawLogIncluded,false);
  assert.ok(result.signatures.includes('ERR_MODULE_NOT_FOUND'));
  assert.ok(result.signatures.includes('PAPER_FORWARD_AUTHORITATIVE_ACCOUNT_BINDING_REQUIRED'));
  assert.ok(result.signatures.includes('NODE_REFERENCE_ERROR'));
  assert.ok(result.signatures.includes('FS_ENOENT'));
  assert.ok(result.categories.includes('NODE_RUNTIME'));
  assert.ok(result.categories.includes('PAPER_FORWARD_RUNTIME'));
  assert.ok(result.categories.includes('FILESYSTEM'));
  assert.match(result.stderrTailSha256,/^[0-9a-f]{64}$/u);

  const line=formatSafeResearchTaskFailureSignatureV1(result);
  assert.ok(line.startsWith('TASK_FAILURE_SIGNATURE '));
  assert.ok(line.includes('raw_log_included=false'));
  assert.ok(line.includes('ERR_MODULE_NOT_FOUND'));
  assert.ok(!line.includes(secret));
  assert.ok(!line.includes('Cannot find package'));
});

test('unrecognized stderr is hashed but never echoed',()=>{
  const raw='provider returned a detailed confidential message that must not be copied';
  const result=buildSafeResearchTaskFailureSignatureV1({
    profile:'forward',
    taskId:'shadow-forward',
    stderrText:raw,
  });
  assert.deepEqual(result.signatures,[]);
  assert.deepEqual(result.categories,['UNCLASSIFIED']);
  const line=formatSafeResearchTaskFailureSignatureV1(result);
  assert.ok(line.includes('signatures=NONE'));
  assert.ok(line.includes('categories=UNCLASSIFIED'));
  assert.ok(!line.includes('confidential'));
});

test('resolver rejects malformed identities and task IDs',()=>{
  assert.throws(()=>resolveResearchTaskStderrPathV1({
    cycle:{},
    stateRoot:'relative',
    taskId:'paper-forward',
    targetSha:SHA,
  }),/stateRoot must be absolute/);
  assert.throws(()=>resolveResearchTaskStderrPathV1({
    cycle:{},
    stateRoot:STATE,
    taskId:'../../etc',
    targetSha:SHA,
  }),/taskId invalid/);
  assert.throws(()=>resolveResearchTaskStderrPathV1({
    cycle:{},
    stateRoot:STATE,
    taskId:'paper-forward',
    targetSha:'main',
  }),/targetSha invalid/);
});
