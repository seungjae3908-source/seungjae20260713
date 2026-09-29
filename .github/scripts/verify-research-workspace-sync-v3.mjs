import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const MAIN=process.env.EXPECTED_BASE_SHA;
const OWNER='adfcb23baf956bcaa025f0846313faf8db7a4e4a';
const BASE='9057c4a3767db0f81e595fc481f5066bda6c9e43';
if(!/^[0-9a-f]{40}$/i.test(MAIN??''))throw new Error('EXPECTED_BASE_SHA_REQUIRED');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trimEnd();
const isAncestor=(ancestor,descendant)=>{try{git('merge-base','--is-ancestor',ancestor,descendant);return true}catch{return false}};
const added=[
 'packages/external-research/src/research-workspace-canonical-evaluation-one-shot-v18.js',
 'packages/external-research/src/research-workspace-canonical-evaluation-one-shot-v18.d.ts',
 'packages/external-research/test/research-workspace-canonical-evaluation-one-shot-v18.test.js',
 'packages/external-research/docs/research-workspace-phase18.md',
 '.github/workflows/research-workspace-canonical-evaluation-contract-v18.yml',
 '.github/workflows/research-workspace-current-main-runtime-proof-v18.yml',
 'packages/external-research/scripts/verify-current-main-runtime-proof-v18.mjs',
 'packages/external-research/src/research-workspace-canonical-evaluation-readiness-v17.js',
 'packages/external-research/src/research-workspace-canonical-evaluation-readiness-v17.d.ts',
 'packages/external-research/test/research-workspace-canonical-evaluation-readiness-v17.test.js',
 'packages/external-research/docs/research-workspace-phase17.md',
 'api-server/scripts/run-research-workspace-canonical-evaluation-preflight-v17.ts',
 '.github/workflows/research-workspace-canonical-evaluation-preflight-v17.yml',
 'packages/external-research/src/research-workspace-one-shot-bind-v16.js',
 'packages/external-research/src/research-workspace-one-shot-bind-v16.d.ts',
 'packages/external-research/test/research-workspace-one-shot-bind-v16.test.js',
 'packages/external-research/docs/research-workspace-phase16.md',
 'api-server/scripts/run-research-workspace-one-shot-bind-v16.ts',
 '.github/workflows/research-workspace-human-rule-digest-binding-v16.yml',
 'packages/external-research/src/research-workspace-one-shot-review-v15.js',
 'packages/external-research/src/research-workspace-one-shot-review-v15.d.ts',
 'packages/external-research/test/research-workspace-one-shot-review-v15.test.js',
 'packages/external-research/docs/research-workspace-phase15.md',
 'stock-analyzer/src/lib/research-one-shot-review.js',
 'stock-analyzer/src/lib/research-one-shot-review.d.ts',
 'stock-analyzer/src/components/research-workspace-one-shot-review.tsx',
 '.github/workflows/research-workspace-one-shot-execution-v14.yml',
 'packages/external-research/docs/research-workspace-phase14.md',
 'api-server/src/services/market-intelligence-ai-analysis.service.test.ts',
 'api-server/scripts/research-workspace-one-shot-preflight-v13.cjs',
 'api-server/scripts/research-workspace-one-shot-preflight-v13.test.cjs',
 '.github/workflows/research-workspace-one-shot-preflight-v13.yml',
 'packages/external-research/docs/research-workspace-phase13.md',
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
const supplemental=[
 'stock-analyzer/playwright.config.ts',
 'stock-analyzer/e2e/support/start-vite-e2e-server.mjs',
 '.github/workflows/research-workspace-integration-v1.yml',
];
const resourceGovernorReviewed=[
 'research-production/bin/research-resource-budget.mjs',
 'research-production/src/research-resource-budget.mjs',
 'research-production/test/research-resource-budget.test.mjs',
 'research-production/src/engine.mjs',
 'research-production/test/research-engine.test.mjs',
 '.github/workflows/paper-forward-schedule-validation.yml',
];
const original=git('diff','--name-only',BASE,OWNER).split('\n');
const allowed=new Set([...original,...added,...supplemental,...resourceGovernorReviewed]);
const changed=git('diff','--name-only',MAIN,'HEAD').split('\n').filter(Boolean);
for(const p of changed)if(!allowed.has(p))throw new Error('UNREVIEWED_PATH:'+p);
git('merge-base','--is-ancestor',MAIN,'HEAD');
git('merge-base','--is-ancestor',OWNER,'HEAD');
if(!isAncestor(OWNER,MAIN))for(const p of git('diff','--diff-filter=A','--name-only',BASE,OWNER).split('\n').filter(Boolean)){
 let existed=false;try{git('cat-file','-e',`${MAIN}:${p}`);existed=true;}catch{}
 if(existed)throw new Error('UNREVIEWED_ADD_ADD_CONFLICT:'+p);
}
const mount="\n\n// Read pre-existing sanitized research only; the nested workspace requires admin access.\nrouter.use('/research/video/evidence', requireCapability('canAccessBasicInfo'), videoResearchEvidenceRouter);";
let current=git('show','HEAD:api-server/src/routes/index.ts');
if(!isAncestor(OWNER,MAIN))current=current
 .replace("\nimport videoResearchEvidenceRouter from './video-research-evidence';",'').replace(mount,'');
if(current!==git('show',`${MAIN}:api-server/src/routes/index.ts`))throw new Error('MAIN_ROUTE_CHANGE_NOT_PRESERVED');
const protectedPaths=['market-prediction-lab','research-dashboard','api-server/src/middleware/auth.ts','stock-analyzer/src/pages/research-center.tsx','stock-analyzer/vite.config.ts','packages/member-access','pnpm-lock.yaml'];
for(const p of protectedPaths)if(git('rev-parse',`HEAD:${p}`)!==git('rev-parse',`${MAIN}:${p}`))throw new Error('PROTECTED_PATH_CHANGED:'+p);
const researchProductionChanges=git('diff','--name-only',MAIN,'HEAD','--','research-production').split('\n').filter(Boolean);
for(const p of researchProductionChanges)if(!resourceGovernorReviewed.includes(p))throw new Error('UNREVIEWED_RESEARCH_PRODUCTION_PATH:'+p);
const proof={schemaVersion:'workspace-main-preservation-v3',head:git('rev-parse','HEAD'),main:MAIN,previousOwner:OWNER,
  reviewedChangedPaths:changed,protectedPaths,ancestryPreserved:true,mainUpdated:false,
  liveOrders:0,providerCalls:0,fixtureResultsAreEconomicEvidence:false};
const output=process.argv[2];if(output)writeFileSync(output,JSON.stringify(proof,null,2)+'\n');
console.log(JSON.stringify(proof,null,2));
