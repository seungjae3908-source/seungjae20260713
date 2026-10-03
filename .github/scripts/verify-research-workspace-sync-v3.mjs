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
const original=git('diff','--name-only',BASE,OWNER).split('\n');
const portfolioReviewed=[
 'api-server/src/features/account-readonly/account-readonly.journal-history.test.ts',
 'api-server/src/features/account-readonly/account-readonly.journal-history.ts',
 'api-server/src/features/account-readonly/account-readonly.portfolio-adapter.test.ts',
 'api-server/src/features/account-readonly/account-readonly.portfolio-adapter.ts',
 'api-server/src/features/account-readonly/account-readonly.portfolio-source.test.ts',
 'api-server/src/features/account-readonly/account-readonly.portfolio-source.ts',
 'api-server/src/features/account-readonly/account-readonly.runtime-service.ts',
 'api-server/src/features/account-readonly/providers/kiwoom-readonly.provider.ts',
 'api-server/src/routes/index.ts',
 'api-server/src/routes/paper-journal.ts',
 'api-server/src/routes/portfolio-intelligence.ts',
 'api-server/src/routes/unified-trade-journal.route.test.ts',
 'api-server/src/services/portfolio-intelligence.service.ts',
 'api-server/src/services/trade-exchange-adapters.service.ts',
 'api-server/src/services/unified-trade-journal.service.test.ts',
 'api-server/src/services/unified-trade-journal.service.ts',
 'stock-analyzer/e2e/phase7-journal-sync.spec.ts',
 'stock-analyzer/playwright.critical.config.ts',
 'stock-analyzer/src/components/unified-trade-journal-panel.tsx',
 'stock-analyzer/src/lib/labels.ts',
 'stock-analyzer/src/lib/paper-journal-sync.ts',
 'stock-analyzer/src/lib/unified-journal-safety.test.ts',
 'stock-analyzer/src/lib/unified-journal-safety.ts',
 'stock-analyzer/src/pages/phase7-journal-sync-e2e.tsx',
 'stock-analyzer/src/pages/portfolio-v2.tsx',
];
const researchCenterIntegrationReviewed=[
 '.github/tests/pr-exact-head-workflows.test.mjs',
 '.github/workflows/fast-profitability-v1-activation.yml',
 '.github/workflows/fast-profitability-v1-collector.yml',
 '.github/workflows/fast-profitability-v1-preactivation-watch.yml',
 '.github/workflows/prediction-lab-52d-validation.yml',
 '.github/workflows/prediction-lab-canonical-shadow-cycle.yml',
 '.github/workflows/research-center-predeploy-validation.yml',
 'market-prediction-lab/tests/canonical-shadow-runtime-activation-v1.test.js',
 'api-server/scripts/verify-fast-profitability-bounded-artifact-discovery-contract.mjs',
 'api-server/scripts/verify-fast-profitability-preactivation-watch-contract.mjs',
 'api-server/scripts/verify-research-center-predeploy-contract.mjs',
 'api-server/src/routes/market-summary-availability.smoke.test.ts',
 'api-server/src/routes/video-research-source-evidence.ts',
 'api-server/src/services/research-center-readonly-contract.service.ts',
 'api-server/src/services/fast-profitability-activation.service.ts',
 'api-server/src/services/fast-profitability-evidence-runtime.service.ts',
 'api-server/src/services/forward-recommendation-observer.service.ts',
 'api-server/src/services/unified-trade-journal-canonical-binding.service.ts',
 'api-server/src/scripts/run-fast-profitability-collector.ts',
 'market-prediction-lab/src/frozen-candidate-performance-publisher-v1.js',
 'market-prediction-lab/tests/frozen-candidate-performance-publisher-v1.test.js',
 'research-dashboard/server.py',
 'research-dashboard/test/test_server.py',
 'stock-analyzer/src/lib/research-center.ts',
 'stock-analyzer/src/lib/excel-export.ts',
 'stock-analyzer/src/lib/backtest.ts',
 'stock-analyzer/src/components/backtest-research-panel.tsx',
 'stock-analyzer/src/pages/research-center.tsx',
 'stock-analyzer/e2e/research-video-intelligence.spec.ts',
 'stock-analyzer/src/components/research-video-source-panel.tsx',
 'stock-analyzer/src/components/research-center-general.tsx',
 'stock-analyzer/src/pages/research-center-workspace.tsx',
 'stock-analyzer/e2e/research-center-professional-hierarchy.spec.ts',
 'stock-analyzer/e2e/production-research-center-readonly-qa.spec.ts',
];
const researchBacktestPaperReviewed=[
 '.github/tests/trading-ops-consolidated-preflight.test.mjs',
 '.github/workflows/production-automatic-trading-gate.yml',
 '.github/workflows/paper-forward-schedule-validation.yml',
 'api-server/scripts/verify-production-automatic-trading-gate.mjs',
 'ops/deploy-production.sh',
 'api-server/src/routes/backtests.ts',
 'api-server/src/routes/paper-trading.ts',
 'api-server/src/services/backtest-data.service.ts',
 'api-server/src/services/backtest-engine.service.ts',
 'api-server/src/services/backtest-paper-handoff.service.ts',
 'api-server/src/services/futures-market-data.service.ts',
 'api-server/src/services/member-auto-trading-background-worker.service.ts',
 'api-server/src/services/member-auto-trading-background-worker.service.test.ts',
 'api-server/src/services/paper-trading.types.ts',
 'packages/strategy-hypothesis/src/backtest-paper-handoff.js',
 'packages/strategy-hypothesis/src/backtest-paper-handoff.d.ts',
 'stock-analyzer/src/pages/auto-trading.tsx',
 'stock-analyzer/e2e/phase6-paper-trading.spec.ts',
 'stock-analyzer/src/pages/phase5-backtest-e2e.tsx',
 'api-server/src/services/backtest-engine.service.test.ts',
 'api-server/src/services/backtest-paper-handoff.service.test.ts',
 'stock-analyzer/e2e/backtester-korean-result-ui.spec.ts',
 'stock-analyzer/e2e/phase5-backtest.spec.ts',
 'stock-analyzer/e2e/auto-trading-professional-ui.spec.ts',
];
const allowed=new Set([...original,...added,...supplemental,...portfolioReviewed,...researchCenterIntegrationReviewed,...researchBacktestPaperReviewed]);
const changed=git('diff','--name-only',MAIN,'HEAD').split('\n').filter(Boolean);
const researchCenterChanged=changed.filter((p)=>researchCenterIntegrationReviewed.includes(p));
if(researchCenterChanged.length>0){
 const requiredIntegrationGuards=[
  '.github/workflows/research-center-predeploy-validation.yml',
  'api-server/scripts/verify-research-center-predeploy-contract.mjs',
 ];
 for(const p of requiredIntegrationGuards)if(!changed.includes(p))throw new Error('RESEARCH_CENTER_INTEGRATION_GUARD_MISSING:'+p);
}
for(const p of changed)if(!allowed.has(p))throw new Error('UNREVIEWED_PATH:'+p);
git('merge-base','--is-ancestor',MAIN,'HEAD');
git('merge-base','--is-ancestor',OWNER,'HEAD');
if(!isAncestor(OWNER,MAIN))for(const p of git('diff','--diff-filter=A','--name-only',BASE,OWNER).split('\n').filter(Boolean)){
 let existed=false;try{git('cat-file','-e',`${MAIN}:${p}`);existed=true;}catch{}
 if(existed)throw new Error('UNREVIEWED_ADD_ADD_CONFLICT:'+p);
}
const mount="\n\n// Read pre-existing sanitized research only; the nested workspace requires admin access.\nrouter.use('/research/video/evidence', requireCapability('canAccessBasicInfo'), videoResearchEvidenceRouter);";
let current=git('show','HEAD:api-server/src/routes/index.ts');
const mainRoute=git('show',`${MAIN}:api-server/src/routes/index.ts`);
// Older owner history may not be an ancestor after squash/integration merges. Only
// normalize away the legacy video mount when the exact current main itself does
// not contain that reviewed mount. Never delete content that main now owns.
if(!isAncestor(OWNER,MAIN) && !mainRoute.includes("import videoResearchEvidenceRouter from './video-research-evidence';"))current=current
 .replace("\nimport videoResearchEvidenceRouter from './video-research-evidence';",'').replace(mount,'');
// #1463 intentionally shares one existing READ_ONLY account service instance.
// Only normalize that reviewed refactor when exact current main still uses the
// older constructor form. If current main already owns accountReadonlyRuntimeService,
// preserving main means leaving it byte-for-byte unchanged.
if(!mainRoute.includes("import { accountReadonlyRuntimeService } from '../features/account-readonly/account-readonly.runtime-service';"))current=current
 .replace(
   "import { createAccountReadonlyRouter } from '../features/account-readonly/account-readonly.route';\nimport { accountReadonlyRuntimeService } from '../features/account-readonly/account-readonly.runtime-service';",
   "import { createAccountReadonlyRouter, accountReadFlags } from '../features/account-readonly/account-readonly.route';\nimport { AccountReadonlyService } from '../features/account-readonly/account-readonly.service';\nimport { createVaultBackedAccountReaders } from '../features/account-readonly/account-readonly.runtime';\nimport { accountReadonlyCredentialConfigured } from '../features/account-readonly/account-readonly.repository';",
 )
 .replace(
   "  createAccountReadonlyRouter(accountReadonlyRuntimeService),",
   "  createAccountReadonlyRouter(new AccountReadonlyService(\n    createVaultBackedAccountReaders(),\n    accountReadFlags(),\n    () => new Date(),\n    accountReadonlyCredentialConfigured,\n  )),",
 );
if(current!==mainRoute)throw new Error('MAIN_ROUTE_CHANGE_NOT_PRESERVED');
const protectedPaths=['market-prediction-lab','research-production','research-dashboard','api-server/src/middleware/auth.ts','stock-analyzer/src/pages/research-center.tsx','stock-analyzer/vite.config.ts','packages/member-access','pnpm-lock.yaml'];
const protectedPathExceptions=new Map([
 ['market-prediction-lab',new Set([
  'market-prediction-lab/tests/canonical-shadow-runtime-activation-v1.test.js',
  'market-prediction-lab/src/frozen-candidate-performance-publisher-v1.js',
  'market-prediction-lab/tests/frozen-candidate-performance-publisher-v1.test.js',
 ])],
 ['research-dashboard',new Set([
  'research-dashboard/server.py',
  'research-dashboard/test/test_server.py',
 ])],
 ['stock-analyzer/src/pages/research-center.tsx',new Set([
  'stock-analyzer/src/pages/research-center.tsx',
 ])],
]);
for(const p of protectedPaths){
 const exceptions=protectedPathExceptions.get(p);
 if(exceptions){
  const unexpected=git('diff','--name-only',MAIN,'HEAD','--',p).split('\n').filter(Boolean).filter((item)=>!exceptions.has(item));
  if(unexpected.length>0)throw new Error('PROTECTED_PATH_CHANGED:'+p+':'+unexpected.join(','));
  continue;
 }
 if(git('rev-parse',`HEAD:${p}`)!==git('rev-parse',`${MAIN}:${p}`))throw new Error('PROTECTED_PATH_CHANGED:'+p);
}
const proof={schemaVersion:'workspace-main-preservation-v3',head:git('rev-parse','HEAD'),main:MAIN,previousOwner:OWNER,
  reviewedChangedPaths:changed,researchCenterIntegrationReviewed:researchCenterChanged,researchBacktestPaperReviewed:changed.filter((p)=>researchBacktestPaperReviewed.includes(p)),protectedPaths,
  protectedPathExceptions:Object.fromEntries([...protectedPathExceptions].map(([key,value])=>[key,[...value]])),
  ancestryPreserved:true,mainUpdated:false,
  liveOrders:0,providerCalls:0,fixtureResultsAreEconomicEvidence:false};
const output=process.argv[2];if(output)writeFileSync(output,JSON.stringify(proof,null,2)+'\n');
console.log(JSON.stringify(proof,null,2));
