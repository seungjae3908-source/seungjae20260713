import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat, rename, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { runSignalIntelligenceV3 } from '../src/engine.mjs';

const SHA = 'a'.repeat(40);

function candidate() {
  return {
    market: 'KR_STOCK', symbol: '005930', strategy: 'SWING', timeframe: '1D', direction: 'BUY',
    dataStatus: 'READY', quantEligible: true, profitEligible: true, riskReady: true,
    evidence: { expectedNetEdgeR: 1.1, tailLossPenaltyR: 0.1, uncertaintyPenaltyR: 0.1, executionPenaltyR: 0.1 },
  };
}

async function startServer(stateFile, port, producerPath = '', maxStateAge = '600000') {
  const child = spawn(process.execPath, ['signal-intelligence-v3/src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SIGNAL_INTELLIGENCE_SERVICE_SHA: SHA,
      SIGNAL_INTELLIGENCE_HOST: '127.0.0.1',
      SIGNAL_INTELLIGENCE_PORT: String(port),
      SIGNAL_INTELLIGENCE_STATE_FILE: stateFile,
      SIGNAL_INTELLIGENCE_MAX_STATE_AGE_MS: maxStateAge,
      SIGNAL_INTELLIGENCE_PRODUCER_PATH: producerPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return { child, stdout: () => stdout, stderr: () => stderr };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`server did not start: ${stderr}`);
}

test('server exposes read-only fresh snapshot and safety health', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'signal-v3-'));
  const state = join(dir, 'snapshot.json');
  const port = 18000 + Math.floor(Math.random() * 1000);
  const snapshot = { ...runSignalIntelligenceV3([candidate()]), serviceSha: SHA };
  await writeFile(state, `${JSON.stringify(snapshot)}\n`);
  const server = await startServer(state, port);
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.serviceSha, SHA);
    assert.equal(health.executionAuthority, 'NONE');
    assert.equal(health.privateTradingApiAllowed, false);
    assert.equal(health.realOrderAllowed, false);
    assert.equal(health.snapshotReady, true);
    assert.equal(health.snapshotClockReady, true);
    assert.equal(health.snapshotPublicationReady,false);
    assert.equal(health.snapshotBlockedReason,'FULL_STRATEGY_SOURCE_NOT_VERIFIED');

    const kr = await (await fetch(`http://127.0.0.1:${port}/v1/signals/kr`)).json();
    assert.equal(kr.ok, true);
    assert.equal(kr.candidates.length, 1);
    assert.equal(kr.candidates[0].symbol, '005930');

    const post = await fetch(`http://127.0.0.1:${port}/v1/signals`, { method: 'POST' });
    assert.equal(post.status, 405);
  } finally {
    server.child.kill('SIGTERM');
    await new Promise((resolve) => server.child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('server fails signal reads closed when snapshot is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'signal-v3-'));
  const state = join(dir, 'missing.json');
  const port = 19000 + Math.floor(Math.random() * 1000);
  const server = await startServer(state, port);
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.snapshotReady, false);
    assert.equal(health.snapshotClockReady,false);
    assert.equal(health.snapshotPublicationReady,false);
    assert.equal(health.snapshotBlockedReason,'SNAPSHOT_NOT_READY');
    const unknown = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
    assert.equal(unknown.status,404);
    assert.equal((await unknown.json()).error,'NOT_FOUND');
    const response = await fetch(`http://127.0.0.1:${port}/v1/signals/kr`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.executionAuthority, 'NONE');
  } finally {
    server.child.kill('SIGTERM');
    await new Promise((resolve) => server.child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('server never attributes a previous release snapshot to the current service SHA', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'signal-v3-sha-mismatch-'));
  const file = join(dir, 'previous-release.json');
  const port = 20100 + Math.floor(Math.random() * 500);
  const mismatched = { ...runSignalIntelligenceV3([candidate()]), serviceSha: 'b'.repeat(40) };
  await writeFile(file, JSON.stringify(mismatched) + '\n');
  const server = await startServer(file, port);
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.serviceSha, SHA);
    assert.equal(health.snapshotReady, false);
    assert.equal(health.snapshotFresh, false);
    assert.equal(health.snapshotError, 'SNAPSHOT_SERVICE_SHA_MISMATCH');
    assert.equal(health.executionAuthority, 'NONE');
    const response = await fetch(`http://127.0.0.1:${port}/v1/signals`);
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.error, 'SNAPSHOT_SERVICE_SHA_MISMATCH');
    assert.equal(payload.executionAuthority, 'NONE');
    assert.equal('snapshot' in payload, false);
  } finally {
    server.child.kill('SIGTERM');
    await new Promise(resolve => server.child.once('exit', resolve));
    await rm(dir, {recursive: true, force: true});
  }
});

test('non-loopback bind is rejected', async () => {
  const child = spawn(process.execPath, ['signal-intelligence-v3/src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SIGNAL_INTELLIGENCE_SERVICE_SHA: SHA,
      SIGNAL_INTELLIGENCE_HOST: '0.0.0.0',
      SIGNAL_INTELLIGENCE_PORT: '19999',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /SIGNAL_INTELLIGENCE_LOOPBACK_ONLY/);
});

test('full-profile blocked source data cannot masquerade as fresh server health',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'signal-v3-'));
  const state=join(dir,'partial-snapshot.json');
  const port=23000+Math.floor(Math.random()*1000);
  const base={...runSignalIntelligenceV3([candidate()]),serviceSha:SHA};
  await writeFile(state,JSON.stringify({...base,serviceSha:SHA,
    profile:{fullStrategyCoverage:true},coverage:[]})+'\n');
  const server=await startServer(state,port);
  try{
    const health=await(await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.snapshotReady,true);
    assert.equal(health.snapshotCurrentPageSourceReady,false);
    assert.equal(health.snapshotClockReady,true);
    assert.equal(health.snapshotPublicationReady,false);
    assert.equal(health.snapshotBlockedReason,'CURRENT_SOURCE_PAGES_BLOCKED');
    assert.equal(health.snapshotFresh,false);
    assert.equal(health.executionAuthority,'NONE');
  }finally{
    server.child.kill('SIGTERM');
    await new Promise(resolve=>server.child.once('exit',resolve));
    await rm(dir,{recursive:true,force:true});
  }
});

test('manual read-only public rescan inherits the same writable state directory as timer',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'signal-v3-rescan-'));
  const state=join(dir,'latest-snapshot.json');
  const output=join(dir,'fake-producer-result.json');
  const producer=join(dir,'fake-public-producer.mjs');
  await writeFile(producer,"import {writeFile} from 'node:fs/promises';\n"+
    "await writeFile("+JSON.stringify(output)+",JSON.stringify({"+
    "stateDir:process.env.SIGNAL_INTELLIGENCE_STATE_DIR,"+
    "stateFile:process.env.SIGNAL_INTELLIGENCE_STATE_FILE,"+
    "executionAuthority:process.env.SIGNAL_INTELLIGENCE_EXECUTION_AUTHORITY,"+
    "publicOnly:process.env.SIGNAL_INTELLIGENCE_PUBLIC_ONLY_UNIVERSE,"+
    "live:process.env.LIVE_TRADING}));");
  const port=25000+Math.floor(Math.random()*1000);
  const instance=await startServer(state,port,producer);
  try{
    const crossOrigin=await fetch('http://127.0.0.1:'+port+'/internal/rescan',{
      method:'POST',headers:{Origin:'https://unrelated.example'},
    });
    assert.equal(crossOrigin.status,403);
    assert.equal((await crossOrigin.json()).error,'INTERNAL_RESCAN_ORIGIN_FORBIDDEN');
    const crossSite=await fetch('http://127.0.0.1:'+port+'/internal/rescan',{
      method:'POST',headers:{'Sec-Fetch-Site':'cross-site'},
    });
    assert.equal(crossSite.status,403);
    const noLaunch=await(await fetch('http://127.0.0.1:'+port+'/health')).json();
    assert.equal(noLaunch.rescan.lastStartedAt,null);
    const response=await fetch(`http://127.0.0.1:${port}/internal/rescan`,{method:'POST'});
    assert.equal(response.status,202);
    assert.equal((await response.json()).publicDataRescan,true);
    let result=null;
    for(let i=0;i<35;i++){
      try{result=JSON.parse(await readFile(output,'utf8'));break;}catch{
        await new Promise(resolve=>setTimeout(resolve,50));
      }
    }
    assert.ok(result,'mock producer finished');
    assert.equal(result.stateDir,dir);
    assert.equal(result.stateFile,state);
    assert.equal(result.executionAuthority,'NONE');
    assert.equal(result.publicOnly,'true');
    assert.equal(result.live,'false');
  }finally{
    instance.child.kill('SIGTERM');
    await new Promise(resolve=>instance.child.once('exit',resolve));
    await rm(dir,{recursive:true,force:true});
  }
});

test('future-dated snapshot and invalid max-age cannot produce a fresh signal',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'signal-v3-future-'));
  const state=join(dir,'future-snapshot.json');
  const port=26500+Math.floor(Math.random()*1000);
  const base={...runSignalIntelligenceV3([candidate()]),serviceSha:SHA};
  await writeFile(state,JSON.stringify({
    ...base,generatedAt:new Date(Date.now()+10*60_000).toISOString(),
  }));
  const instance=await startServer(state,port);
  try{
    const health=await(await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.snapshotReady,true);
    assert.equal(health.snapshotFresh,false);
    assert.equal(health.snapshotBlockedReason,'SNAPSHOT_AGE_EXPIRED');
    const s=await fetch(`http://127.0.0.1:${port}/v1/signals`);
    assert.equal(s.status,503);
    assert.equal((await s.json()).executionAuthority,'NONE');
  }finally{
    instance.child.kill('SIGTERM');
    await new Promise(resolve=>instance.child.once('exit',resolve));
    await rm(dir,{recursive:true,force:true});
  }
  const invalid=spawn(process.execPath,['signal-intelligence-v3/src/server.mjs'],{
    cwd:process.cwd(),env:{...process.env,
      SIGNAL_INTELLIGENCE_SERVICE_SHA:SHA,
      SIGNAL_INTELLIGENCE_HOST:'127.0.0.1',
      SIGNAL_INTELLIGENCE_PORT:'29999',
      SIGNAL_INTELLIGENCE_MAX_STATE_AGE_MS:'NaN',
    },stdio:['ignore','pipe','pipe'],
  });
  let stderr='';invalid.stderr.on('data',v=>{stderr+=v;});
  const result=await new Promise(resolve=>invalid.once('exit',resolve));
  assert.notEqual(result,0);
  assert.match(stderr,/SIGNAL_INTELLIGENCE_MAX_STATE_AGE_INVALID/);
});


test('atomic snapshot with same mtime and different inode must never replay a cached older candidate',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'signal-v3-atomic-'));
  const state=join(dir,'latest-snapshot.json');
  const staged=join(dir,'replacement.json');
  const port=27000+Math.floor(Math.random()*500);
  const first={...runSignalIntelligenceV3([candidate()]),serviceSha:SHA};
  const second={...runSignalIntelligenceV3([{...candidate(),symbol:'000660'}]),serviceSha:SHA};
  await writeFile(state,JSON.stringify(first)+'\n');
  const instance=await startServer(state,port);
  try{
    const endpoint='http://127.0.0.1:'+port+'/v1/signals/kr';
    const before=await(await fetch(endpoint)).json();
    assert.equal(before.candidates[0].symbol,'005930');
    const metadata=await stat(state);
    await writeFile(staged,JSON.stringify(second)+'\n');
    await utimes(staged,metadata.atime,metadata.mtime);
    await rename(staged,state);
    const after=await(await fetch(endpoint)).json();
    assert.equal(after.candidates[0].symbol,'000660');
    assert.equal(after.executionAuthority,'NONE');
  }finally{
    instance.child.kill('SIGTERM');
    await new Promise(resolve=>instance.child.once('exit',resolve));
    await rm(dir,{recursive:true,force:true});
  }
});

test('corrupt JSON cannot leak raw error data into health or 503 responses',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'signal-v3-malformed-'));
  const state=join(dir,'bad.json');
  const port=27500+Math.floor(Math.random()*500);
  await writeFile(state,'{"secret":"DONT_EXPORT",');
  const instance=await startServer(state,port);
  try{
    const root='http://127.0.0.1:'+port;
    const health=await(await fetch(root+'/health')).json();
    assert.equal(health.snapshotReady,false);
    assert.equal(health.snapshotError,'SNAPSHOT_INVALID_JSON');
    assert.equal(health.snapshotBlockedReason,'SNAPSHOT_INVALID_JSON');
    const response=await fetch(root+'/v1/signals/spot');
    assert.equal(response.status,503);
    const payload=await response.json();
    assert.equal(payload.error,'SNAPSHOT_INVALID_JSON');
    assert.equal(payload.executionAuthority,'NONE');
    assert.equal(JSON.stringify({health,payload}).includes('DONT_EXPORT'),false);
  }finally{
    instance.child.kill('SIGTERM');
    await new Promise(resolve=>instance.child.once('exit',resolve));
    await rm(dir,{recursive:true,force:true});
  }
});
