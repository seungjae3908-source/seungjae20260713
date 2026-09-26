import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const MAIN='c1314de8b85e462568750b30120a7967c7af1e8c';
const OWNER='adfcb23baf956bcaa025f0846313faf8db7a4e4a';
const BASE='9057c4a3767db0f81e595fc481f5066bda6c9e43';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trimEnd();
const added=[
 'packages/external-research/src/research-workspace-one-shot-v12.js',
 'packages/external-research/src/video-intelligence.d.ts',
 'packages/external-research/src/research-workspace-video-v7.d.ts',
 'packages/external-research/src/research-workspace-one-shot-v12.d.ts',
 'packages/external-research/test/research-workspace-one-shot-v12.test.js',
 'packages/external-research/docs/research-workspace-phase12.md',
 'packages/external-research/scripts/run-existing-research-providers-v8.d.mts',
 'api-server/src/services/ai-chat.service.ts',
 'api-server/src/services/ai-chat.service.test.ts',
 'stock-analyzer/src/pages/ai-chat.tsx',
 'api-server/src/services/research-groq-one-shot-transport.service.test.ts',
 'api-server/src/services/research-groq-json-transport.service.ts',
 'api-server/src/tools/research-workspace-one-shot-v12.ts',
 'api-server/src/tools/research-workspace-one-shot-v12.test.ts',
 'api-server/scripts/run-research-workspace-one-shot-v12.ts',
 'api-server/test.mjs',
 'packages/external-research/src/research-workspace-runtime-binding-v11.js',
 'packages/external-research/test/research-workspace-runtime-binding-v11.test.js',
 'packages/external-research/docs/research-workspace-phase11.md',
 'packages/external-research/src/research-workspace-orchestrator-v10.js',
 'packages/external-research/src/research-workspace-orchestrator-v10.d.ts',
 'packages/external-research/test/research-workspace-orchestrator-v10.test.js',
 'packages/external-research/docs/research-workspace-phase10.md',
 'stock-analyzer/src/lib/research-orchestrator-status.js',
 'stock-analyzer/src/lib/research-orchestrator-status.d.ts',
 'stock-analyzer/src/components/research-workspace-orchestrator.tsx',
 'packages/external-research/src/research-workspace-worker-v9.js',
 'packages/external-research/src/research-workspace-worker-v9.d.ts',
 'packages/external-research/scripts/run-research-worker-v9.mjs',
 'packages/external-research/test/research-workspace-worker-v9.test.js',
 'packages/external-research/docs/research-workspace-phase9.md',
 'stock-analyzer/src/lib/research-worker-status.js',
 'stock-analyzer/src/lib/research-worker-status.d.ts',
 'stock-analyzer/src/components/research-workspace-worker.tsx',
 'packages/external-research/src/research-workspace-providers-v8.js',
 'packages/external-research/src/research-workspace-providers-v8.d.ts',
 'packages/external-research/scripts/run-existing-research-providers-v8.mjs',
 'packages/external-research/test/research-workspace-providers-v8.test.js',
 'packages/external-research/docs/research-workspace-phase8.md',
 'stock-analyzer/src/lib/research-provider-status.js',
 'stock-analyzer/src/lib/research-provider-status.d.ts',
 'stock-analyzer/src/components/research-workspace-providers.tsx',

 'packages/external-research/src/research-workspace-video-v7.js',
 'packages/external-research/scripts/run-research-video-v7.mjs',
 'packages/external-research/test/research-workspace-video-v7.test.js',
 'packages/external-research/docs/research-workspace-phase7.md',
 'packages/external-research/src/research-workspace-transcript-v6.js',
 'packages/external-research/test/research-workspace-transcript-v6.test.js',
 'packages/external-research/docs/research-workspace-phase6.md',
 'api-server/src/services/research-workspace-transcript-v6.ts',
 'api-server/src/services/research-workspace-transcript-v6.test.ts',
 'packages/external-research/src/research-workspace-archive-v5.js',
 'packages/external-research/src/research-workspace-approval-v5.js',
 'packages/external-research/src/research-workspace-approval-v5.d.ts',
 'packages/external-research/test/research-workspace-archive-v5.test.js',
 'packages/external-research/test/research-workspace-approval-v5.test.js',
 'api-server/src/services/research-workspace-authorization-v5.ts',
 'api-server/src/services/research-workspace-authorization-v5.test.ts',
 'packages/external-research/docs/research-workspace-phase5.md',
 'packages/external-research/src/research-workspace-publisher-v4.js',
 'packages/external-research/test/research-workspace-publisher-v4.test.js',
 'packages/external-research/docs/research-workspace-phase4.md',
 '.github/scripts/verify-research-workspace-sync-v3.mjs',
 'packages/external-research/docs/research-workspace-phase3.md',
 'packages/external-research/test/research-workspace-reconciliation-v3.test.js',
 'packages/external-research/src/research-workspace-v1.d.ts',
 'stock-analyzer/vite.research-workspace.config.ts',
 'stock-analyzer/playwright.research-workspace.config.ts',
];
const original=git('diff','--name-only',BASE,OWNER).split('\n');
const allowed=new Set([...original,...added]);
const changed=git('diff','--name-only',MAIN,'HEAD').split('\n').filter(Boolean);
for(const p of changed)if(!allowed.has(p))throw new Error('UNREVIEWED_PATH:'+p);
git('merge-base','--is-ancestor',MAIN,'HEAD');
git('merge-base','--is-ancestor',OWNER,'HEAD');
for(const p of git('diff','--diff-filter=A','--name-only',BASE,OWNER).split('\n').filter(Boolean)){
 let existed=false;try{git('cat-file','-e',`${MAIN}:${p}`);existed=true;}catch{}
 if(existed)throw new Error('UNREVIEWED_ADD_ADD_CONFLICT:'+p);
}
const mount="\n\n// Read pre-existing sanitized research only; the nested workspace requires admin access.\nrouter.use('/research/video/evidence', requireCapability('canAccessBasicInfo'), videoResearchEvidenceRouter);";
const current=git('show','HEAD:api-server/src/routes/index.ts')
 .replace("\nimport videoResearchEvidenceRouter from './video-research-evidence';",'').replace(mount,'');
if(current!==git('show',`${MAIN}:api-server/src/routes/index.ts`))throw new Error('MAIN_ROUTE_CHANGE_NOT_PRESERVED');
const protectedPaths=['market-prediction-lab','research-production','research-dashboard','api-server/src/middleware/auth.ts','stock-analyzer/src/pages/research-center.tsx','stock-analyzer/vite.config.ts','packages/member-access','pnpm-lock.yaml'];
for(const p of protectedPaths)if(git('rev-parse',`HEAD:${p}`)!==git('rev-parse',`${MAIN}:${p}`))throw new Error('PROTECTED_PATH_CHANGED:'+p);
const proof={schemaVersion:'workspace-main-preservation-v3',head:git('rev-parse','HEAD'),main:MAIN,previousOwner:OWNER,
  reviewedChangedPaths:changed,protectedPaths,ancestryPreserved:true,mainUpdated:false,
  liveOrders:0,providerCalls:0,fixtureResultsAreEconomicEvidence:false};
const output=process.argv[2];if(output)writeFileSync(output,JSON.stringify(proof,null,2)+'\n');
console.log(JSON.stringify(proof,null,2));
