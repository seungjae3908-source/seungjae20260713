/**
 * The shared api-server/test.mjs is release-wide, and must not be modified
 * for Telegram-only test scope. Bundle exactly two Telegram V3 source tests
 * using the same established esbuild harness as the existing test runner.
 */
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const app=path.join(root,'api-server');
const require=createRequire(path.join(app,'package.json'));
const {build}=require('esbuild');
const input=[
 'src/services/telegram-v3-current-source.service.test.ts',
 'src/services/signal-intelligence-telegram-subscriber.service.test.ts',
];
const dir=await mkdtemp(path.join(tmpdir(),'telegram-v3-mock-only-'));
try{
 const output=[];
 for(const [i,relative] of input.entries()){
   const outfile=path.join(dir,`telegram-v3-${i}.test.cjs`);
   await build({entryPoints:[path.join(app,relative)],outfile,
     bundle:true,platform:'node',format:'cjs',target:'node20',
     logLevel:'warning',define:{'import.meta.env':'{}'}});
   output.push(outfile);
 }
 const run=spawnSync(process.execPath,['--test',...output],{
   cwd:root,stdio:'inherit',
 });
 if(run.error)throw run.error;
 process.exitCode=run.status??1;
}finally{
 await rm(dir,{recursive:true,force:true});
}
