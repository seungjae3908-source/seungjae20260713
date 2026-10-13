import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResearchWorkspaceStore } from '../src/research-workspace-store-v2.js';
const root = new URL('../../../', import.meta.url);
const read = p => readFile(new URL(p, root),'utf8');

test('latest profile bootstrap and trade capability survive route reconciliation',async()=>{
  const source=await read('api-server/src/routes/index.ts');
  assert.match(source,/router\.get\('\/auth\/profile', requireAuthenticatedProfileBootstrap/);
  assert.match(source,/trade-automation', requireCapability\('canAccessAutoTrading'\)/);
  assert.ok(source.indexOf("router.use(requireAuthenticated)")<source.indexOf("router.use('/research/video/evidence'"));
});
test('video E2E uses current summary and video navigation',async()=>{
  const source=await read('stock-analyzer/e2e/research-video-intelligence.spec.ts');
  assert.ok(source.includes("name:'요약',exact:true"));assert.ok(source.includes("name:'영상',exact:true"));
  assert.ok(source.includes("path==='/api/auth/profile'"));
});
test('workspace E2E resolves new profile endpoint and current navigation',async()=>{
  const source=await read('stock-analyzer/e2e/research-workspace-v2.spec.ts');
  assert.ok(source.includes("path==='/api/auth/profile'"));
  assert.ok(source.includes("name:'영상',exact:true"));
  assert.ok(!source.includes("name:'영상 연구',exact:true"));
});
test('full-app test Vite config does not import any Replit plugin',async()=>{
  const source=await read('stock-analyzer/vite.research-workspace.config.ts');
  assert.ok(!source.includes('@replit/'));assert.ok(source.includes('tailwindcss()'));
});
test('nonregular FIFO policy cannot hang the reader', {timeout:2000}, async t=>{
  const dir=await mkdtemp(join(tmpdir(),'workspace-fifo-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  execFileSync('mkfifo',[join(dir,'policy.json')]);
  await assert.rejects(()=>createResearchWorkspaceStore(dir).openSnapshot(),/UNSAFE_STORE_FILE/);
});
test('nonregular FIFO registry cannot hang a pinned read', {timeout:2000}, async t=>{
  const dir=await mkdtemp(join(tmpdir(),'workspace-fifo-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const digest='b'.repeat(64);
  await writeFile(join(dir,'policy.json'),JSON.stringify({schemaVersion:'research-workspace-store-policy-v2',expectedSourceHeadSha:'a'.repeat(40),maxAgeMs:3600000,registrySha256:digest,scope:'ADMIN_RESEARCH_SHARED',executionAuthority:'NONE'}),{mode:0o600});
  execFileSync('mkfifo',[join(dir,`registry-${digest}.json`)]);
  const session=await createResearchWorkspaceStore(dir).openSnapshot();
  await assert.rejects(()=>session.loadRegistry(),/UNSAFE_STORE_FILE/);
});

test('HTTP CI uses the installed pinned compiler rather than unavailable tsx',async()=>{
  const source=await read('.github/workflows/research-workspace-integration-v1.yml');
  assert.ok(source.includes("import { build } from 'esbuild'"));
  assert.ok(source.includes("entryPoints: ['src/routes/market-summary-availability.smoke.test.ts']"));
  assert.ok(source.includes("process.exitCode = result.status ?? 1"));
  assert.ok(!source.includes('exec tsx'));
});
