import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createResearchWorkspaceReader } from '../src/research-workspace-reader-v1.js';
function harness(overrides={}) {
  const calls=[];
  const read=createResearchWorkspaceReader({authorize:async()=>{calls.push('auth');return true;},loadPolicy:async()=>{calls.push('policy');return {expectedSourceHeadSha:'a'.repeat(40),maxAgeMs:3600000};},loadVideoSnapshot:async()=>{calls.push('video');return null;},loadRegistry:async()=>{calls.push('registry');return null;},clock:()=> '2026-09-25T06:00:00.000Z',...overrides});
  const res={headers:{},code:200,body:null,setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.body=v;return this;}};
  return {calls,read,res};
}
test('reader requires all explicit dependencies',()=>assert.throws(()=>createResearchWorkspaceReader({}),/DEPENDENCIES/));
for(const method of ['POST','PUT','PATCH','DELETE']) test(`${method} cannot load or mutate research state`,async()=>{const h=harness();await h.read({method},h.res);assert.equal(h.res.code,405);assert.equal(h.res.headers.Allow,'GET');assert.deepEqual(h.calls,[]);});
test('unauthorized GET never reads a snapshot',async()=>{const h=harness({authorize:async()=>false});await h.read({method:'GET'},h.res);assert.equal(h.res.code,403);assert.deepEqual(h.calls,[]);});
test('authorization exception never leaks message or reads state',async()=>{const h=harness({authorize:async()=>{throw new Error('private auth detail');}});await h.read({method:'GET'},h.res);assert.equal(h.res.code,403);assert.ok(!JSON.stringify(h.res.body).includes('private'));assert.deepEqual(h.calls,[]);});
test('query arrays fail closed instead of widening access',async()=>{const h=harness();await h.read({method:'GET',query:{group:['ALL','CRYPTO']}},h.res);assert.equal(h.res.code,400);assert.deepEqual(h.calls,['auth']);});
test('missing trust policy is not derived from untrusted input',async()=>{const h=harness({loadPolicy:async()=>null});await h.read({method:'GET',query:{expectedSourceHeadSha:'a'.repeat(40)}},h.res);assert.equal(h.res.body.reason,'TRUST_POLICY_MISSING');assert.deepEqual(h.calls,['auth']);});
test('missing snapshot avoids registry access and preserves null',async()=>{const h=harness();await h.read({method:'GET'},h.res);assert.equal(h.res.body.workspace.sourceCount,null);assert.equal(h.res.body.workspace.sourceState,'MISSING');assert.deepEqual(h.calls,['auth','policy','video']);});
test('I/O exception redacted',async()=>{const h=harness({loadVideoSnapshot:async()=>{throw new Error('/private/key-value');}});await h.read({method:'GET'},h.res);assert.equal(h.res.body.reason,'VIDEO_SNAPSHOT_UNAVAILABLE');assert.ok(!JSON.stringify(h.res.body).includes('/private'));});
test('response cannot be cached across users',async()=>{const h=harness();await h.read({method:'GET'},h.res);assert.match(h.res.headers['Cache-Control'],/no-store/);assert.equal(h.res.headers.Vary,'Authorization, Cookie');});
