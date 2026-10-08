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
 'packages/external-research/src/research-workspace-canonical-evaluation-executor-v18.js',
 'packages/external-research/test/research-workspace-canonical-evaluation-runtime-v18.test.js',
 'packages/external-research/scripts/run-canonical-evaluation-v18.mjs',
 'packages/external-research/src/research-workspace-canonical-evaluation-runtime-v18.js',
 'packages/external-research/scripts/run-research-one-shot-v12.mjs',
 'packages/external-research/test/research-workspace-one-shot-runtime-v12.test.js',
 'packages/external-research/test/research-workspace-canonical-evaluation-executor-v18.test.js',
 '.github/workflows/research-workspace-canonical-evaluation-execution-v18.yml',
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
 'stock-analyzer/src/pages/research-center.tsx',
 'stock-analyzer/e2e/research-video-intelligence.spec.ts',
 'stock-analyzer/src/components/research-video-source-panel.tsx',
];
const researchProductionClosureReviewed=[
 '.github/workflows/research-ai-production-activation.yml',
 '.github/workflows/research-production-activation.yml',
 'market-prediction-lab/src/video-research-canonical-handoff-v1.js',
 'market-prediction-lab/src/evidence-backed-formula-entry-evaluator-v1.js',
 'market-prediction-lab/tests/evidence-backed-formula-entry-evaluator-v1.test.js',
 'market-prediction-lab/tests/video-research-canonical-handoff-v1.test.js',
 'packages/external-research/src/research-workspace-canonical-evaluation-readiness-v17.js',
 'packages/external-research/src/research-workspace-runtime-binding-v11.js',
 'packages/external-research/src/video-intelligence-phase2.js',
 'packages/external-research/src/video-intelligence-phase3-runtime.js',
 'packages/external-research/src/video-intelligence-phase3-snapshot-caller.js',
 'packages/external-research/test/research-workspace-canonical-evaluation-readiness-v17.test.js',
 'research-production/bin/research-approved-job-intake.mjs',
 'research-production/bin/research-maintenance.mjs',
 'research-production/deploy/activate-ai-research.sh',
 'research-production/deploy/activate-server.sh',
 'research-production/deploy/install-ai-research-units.sh',
 'research-production/deploy/research-production-ai-review.timer',
 'research-production/deploy/research-production-approved-job-intake.service',
 'research-production/deploy/research-production-approved-job-intake.timer',
 'research-production/deploy/research-production-factory-status.timer',
 'research-production/deploy/research-production-fast-historical.timer',
 'research-production/deploy/research-production-forward.timer',
 'research-production/deploy/research-production-long-history.timer',
 'research-production/deploy/research-production-maintenance.service',
 'research-production/deploy/research-production-maintenance.timer',
 'research-production/deploy/research-production-temporal-evidence.timer',
 'research-production/deploy/research-production-video-discovery.timer',
 'research-production/deploy/research-production-workspace-worker.service',
 'research-production/deploy/research-video.env.example',
 'research-production/src/research-ai-review-worker.mjs',
 'research-production/src/research-video-discovery-worker.mjs',
 'research-production/test/research-ai-activation-contract.test.mjs',
 'research-production/test/research-ai-review-worker.test.mjs',
 'research-production/test/research-ai-units-install-contract.test.mjs',
 'research-production/test/research-approved-job-intake.test.mjs',
 'research-production/test/research-maintenance.test.mjs',
 'research-production/test/research-engine.test.mjs', 'research-production/test/server-risk-policy-env-transport.test.mjs',
];
const memberAccessReviewed=[
 '.github/scripts/verify-research-workspace-sync-v3.mjs',
 '.github/workflows/production-deploy.yml',
 '.github/workflows/production-postdeploy-qa.yml',
 '.github/workflows/research-center-predeploy-validation.yml',
 '.github/scripts/run-production-readonly-qa.sh',
 '.github/scripts/production-postdeploy-qa-evidence.cjs',
 '.github/scripts/verify-production-qa-receipt.cjs',
 '.github/scripts/verify-production-postdeploy-qa-contract.mjs',
 'api-server/scripts/apply-staging-supabase-bootstrap.mjs',
 'api-server/scripts/verify-member-permission-audit-contract.mjs',
 'api-server/scripts/verify-phase8-db.sh',
 'api-server/scripts/verify-research-center-predeploy-contract.mjs',
 'api-server/scripts/verify-staging-bootstrap-contract.mjs',
 'api-server/src/middleware/auth.ts',
 'api-server/src/routes/admin.ts',
 'stock-analyzer/src/lib/auth-bootstrap.ts',
 'stock-analyzer/src/lib/auth-bootstrap.test.ts',
 'api-server/supabase/migrations/2026100801_member_security_definer_lockdown.sql',
 'api-server/src/routes/member-access-phase8.smoke.test.ts',
 'api-server/src/routes/index.ts',
 'api-server/src/routes/paper-journal.smoke.test.ts',
 'api-server/src/routes/paper-journal.ts',
 'api-server/src/routes/signal-scanner-auth.smoke.test.ts',
 'api-server/src/routes/trade-automation.smoke.test.ts',
 'api-server/src/routes/trade-automation.ts',
 'api-server/src/services/member-access-phase8.test.ts',
 'api-server/src/services/member-administration.service.test.ts',
 'api-server/src/services/member-administration.service.ts',
 'api-server/src/services/member-auth-admin.service.ts',
 'api-server/src/services/member-auto-trading-background-worker.service.test.ts',
 'api-server/src/services/member-auto-trading-background-worker.service.ts',
 'api-server/src/services/scanner-access-control.service.test.ts',
 'api-server/src/services/scanner-access-control.service.ts',
 'api-server/supabase/bootstrap/staging-bootstrap-assert.sql',
 'api-server/supabase/bootstrap/staging-bootstrap.sql',
 'api-server/supabase/migrations/2026100601_member_access_s_ai_hardening.sql',
 'api-server/supabase/test/member_access_s_ai_hardening_integration.sql',
 'ops/apply-production-member-access-hardening.mjs',
 'ops/verify-production-member-access-hardening.mjs',
 'packages/member-access/src/index.d.ts',
 'packages/member-access/src/index.js',
 'stock-analyzer/e2e/scanner-member-access.spec.ts',
 'stock-analyzer/e2e/app-ui-cleanup-contract.spec.ts',
 'stock-analyzer/e2e/account-touch-korean-ui.spec.ts',
 'stock-analyzer/e2e/account-connection-credentials.spec.ts',
 'stock-analyzer/e2e/production-member-readonly-qa.spec.ts',
 'stock-analyzer/playwright.production-member.config.ts',
 'stock-analyzer/src/App.tsx',
 'stock-analyzer/src/components/capability-gate.tsx',
 'stock-analyzer/src/components/unified-trade-journal-panel.tsx',
 'stock-analyzer/src/lib/app-navigation.ts',
 'stock-analyzer/src/lib/auth-initial-bootstrap.ts',
 'stock-analyzer/src/lib/auth.tsx',
 'stock-analyzer/src/pages/account.tsx',
 'stock-analyzer/src/pages/admin.tsx',
 'stock-analyzer/src/pages/auto-trading.tsx',
 'stock-analyzer/src/pages/portfolio.tsx',
 'stock-analyzer/src/pages/technical-workspace.tsx',
];
const tradingQaReviewed=[
 'api-server/src/services/trade-execution.service.ts',
 'api-server/src/services/trade-execution-toss-verification.test.ts',
 'stock-analyzer/e2e/production-live-credential-reuse-qa.spec.ts',
];
const telegramReleaseReviewed=[
 '.github/workflows/telegram-production-release.yml',
 'api-server/scripts/verify-telegram-production-release-contract.mjs',
];
const formulaAiDriftReviewed=[
 '.github/scripts/verify-research-workspace-sync-v3.mjs',
 '.github/workflows/pr-auto-rehearsal-preview.yml',
 'api-server/src/routes/auto-rehearsal-preview.ts',
 'api-server/src/routes/index.ts',
 'api-server/src/routes/trade-automation.smoke.test.ts',
 'api-server/src/routes/trade-automation.ts',
 'stock-analyzer/e2e/phase12-trade-automation.spec.ts',
 'stock-analyzer/src/App.tsx',
 'stock-analyzer/src/components/formula-ai-auto-rehearsal-panel.tsx',
 'stock-analyzer/src/lib/app-navigation.ts',
 'stock-analyzer/src/pages/auto-rehearsal-preview.tsx',
 'stock-analyzer/src/pages/auto-trading.tsx',
 'api-server/src/services/evidence-backed-auto-strategy-catalog.service.ts',
 'api-server/src/services/formula-ai-auto-rehearsal.service.test.ts',
 'api-server/src/services/formula-ai-auto-rehearsal.service.ts',
 'api-server/src/services/formula-ai-live-exception.service.test.ts',
 'api-server/src/services/formula-ai-live-exception.service.ts',
 'api-server/src/services/trade-automation-optimization.service.ts',
 'api-server/src/services/trade-rule-pack-pilot-capital.service.ts',
 'api-server/test.mjs',
];
const automaticTradingDriftReviewed=[
 '.github/scripts/production-postdeploy-qa-evidence.cjs',
 '.github/scripts/production-postdeploy-qa-evidence.test.cjs',
 '.github/tests/production-telegram-active-readiness.test.mjs',
 '.github/tests/production-trading-core-qa-contract.test.mjs',
 '.github/tests/trading-ops-consolidated-preflight.test.mjs',
 '.github/workflows/production-automatic-trading-gate.yml',
 '.github/workflows/production-futures-live-trading-gate.yml',
 '.github/workflows/production-live-trading-gate.yml',
 '.github/workflows/production-trading-core-qa.yml',
 'api-server/scripts/verify-production-automatic-trading-gate.mjs',
 'api-server/src/features/user-broker-telegram/trade-execution-event-bridge.service.test.ts',
 'api-server/src/features/user-broker-telegram/trade-execution-event-bridge.service.ts',
 'api-server/src/features/user-broker-telegram/user-broker-telegram.repository.ts',
 'api-server/src/features/user-broker-telegram/user-broker-telegram.runtime.test.ts',
 'api-server/src/features/user-broker-telegram/user-broker-telegram.runtime.ts',
 'api-server/src/features/user-broker-telegram/user-broker-telegram.service.test.ts',
 'api-server/src/features/user-broker-telegram/user-broker-telegram.service.ts',
 'api-server/src/features/user-broker-telegram/user-broker-telegram.worker.ts',
 'api-server/src/index.ts',
 'api-server/src/routes/trade-automation.smoke.test.ts',
 'api-server/src/routes/trade-automation.ts',
 'api-server/src/services/formula-ai-live-exception.service.test.ts',
 'api-server/src/services/live-connection-verification.service.ts',
 'api-server/src/services/member-auto-trading-ai-review-evidence.service.ts',
 'api-server/src/services/member-auto-trading-background-worker.service.test.ts',
 'api-server/src/services/member-auto-trading-background-worker.service.ts',
 'api-server/src/services/member-auto-trading-live-arm.service.ts',
 'api-server/src/services/trade-automation-integration.test.ts',
 'api-server/src/services/trade-automation-optimization.service.ts',
 'api-server/src/services/trade-automation-policy-guard.service.test.ts',
 'api-server/src/services/trade-automation-policy-guard.service.ts',
 'api-server/src/services/trade-automation-unified-journal-adapter.ts',
 'api-server/src/services/trade-automation-risk.service.ts',
 'api-server/src/services/trade-automation.service.ts',
 'api-server/src/services/trade-automation.types.ts',
 'api-server/src/services/trade-execution-pre-submission.test.ts',
 'api-server/src/services/trade-execution.service.ts',
 'api-server/src/services/trade-pre-submission-risk.service.ts',
 'api-server/src/services/trade-risk-envelope.service.ts',
 'api-server/src/services/trade-rule-pack-pilot-capital.service.test.ts',
 'api-server/src/services/trade-rule-pack-pilot-capital.service.ts',
 'api-server/test.mjs',
 'stock-analyzer/e2e/auto-trading-professional-ui.spec.ts',
 'stock-analyzer/e2e/platform-canonical-integration-contract.spec.ts',
 'stock-analyzer/e2e/production-trading-core-qa.spec.ts',
 'stock-analyzer/src/components/trade-automation-settings.tsx',
 'stock-analyzer/src/pages/auto-trading.tsx',
 'stock-analyzer/src/pages/phase12-trade-automation-e2e.tsx',
 'ops/deploy-production.sh',
];
const allowed=new Set([
 ...original,
 ...added,
 ...supplemental,
 ...portfolioReviewed,
 ...researchCenterIntegrationReviewed,
 ...researchProductionClosureReviewed,
 ...memberAccessReviewed,
 ...tradingQaReviewed,
 ...telegramReleaseReviewed,
 ...formulaAiDriftReviewed,
 ...automaticTradingDriftReviewed,
]);
const changed=git('diff','--name-only',MAIN,'HEAD').split('\n').filter(Boolean);
const automaticTradingChanged=changed.filter((p)=>automaticTradingDriftReviewed.includes(p));
if(automaticTradingChanged.length>0){
 const requiredAutomaticTradingGuards=[
  '.github/workflows/production-automatic-trading-gate.yml',
  'api-server/scripts/verify-production-automatic-trading-gate.mjs',
 ];
 for(const p of requiredAutomaticTradingGuards)if(!changed.includes(p))throw new Error('AUTOMATIC_TRADING_SCOPE_GUARD_MISSING:'+p);
 // Production deployment is inside this Trading Core Paper-only change only
 // when its existing strict OFF and readback checks are preserved.
 if(changed.includes('ops/deploy-production.sh')){
  const deploy=git('show','HEAD:ops/deploy-production.sh');
  const requiredPaperOnlyDeployProof=[
   '"MEMBER_AUTO_TRADING_PAPER_ONLY_ENABLED",',
   'MEMBER_AUTO_TRADING_PAPER_ONLY_ENABLED=false',
   'bool("MEMBER_AUTO_TRADING_PAPER_ONLY_ENABLED")',
   'member_paper_only',
   '[[ "$member_background" == false && "$member_live_background" == false && "$member_paper_only" == false ]] || return 1',
  ];
  for(const token of requiredPaperOnlyDeployProof)if(!deploy.includes(token))
   throw new Error('AUTOMATIC_TRADING_PAPER_ONLY_DEPLOY_GUARD_MISSING:'+token);
  if(!deploy.includes('assert_live_trading_inactive_before_deploy()') || !deploy.includes('application_runtime_ready()'))
   throw new Error('AUTOMATIC_TRADING_DEPLOY_PREPOSTCHECK_MISSING');
  const deployDiff=git('diff','--unified=0',MAIN,'HEAD','--','ops/deploy-production.sh');
  if(/^\+[^+].*MEMBER_AUTO_TRADING_PAPER_ONLY_ENABLED=(?:true|TRUE|1)\b/m.test(deployDiff))
   throw new Error('AUTOMATIC_TRADING_PAPER_ONLY_DEPLOY_ACTIVATION_FORBIDDEN');
 }
 const forbiddenAutomaticTradingPrefixes=['market-prediction-lab/','research-production/','packages/external-research/'];
 for(const p of changed)if(forbiddenAutomaticTradingPrefixes.some((prefix)=>p.startsWith(prefix)))throw new Error('AUTOMATIC_TRADING_RESEARCH_SCOPE_FORBIDDEN:'+p);
}
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
const memberAccessContractChanged=changed.some((p)=>(
 memberAccessReviewed.includes(p)
 && !formulaAiDriftReviewed.includes(p)
 && !automaticTradingDriftReviewed.includes(p)
));
const memberAccessRouteContractChanged=memberAccessContractChanged
 && changed.includes('api-server/src/routes/index.ts');
if(memberAccessRouteContractChanged){
 const aiChartFuturesGate=`router.use('/crypto/futures', (req, res, next) => {
  const aiChartPublicRead = req.method === 'GET'
    && (
      req.path === '/tickers'
      || req.path === '/candles'
      || /^\\/[^/]+\\/(?:snapshot|flow)$/u.test(req.path)
    );
  return requireCapability(aiChartPublicRead ? 'canAccessAiChart' : 'canAccessFutures')(req, res, next);
});`;
 const canonicalFuturesGate="router.use('/crypto/futures', requireCapability('canAccessFutures'));";
 const journalSplitGate=`router.use('/paper-journal', (req, res, next) => {
  const subpath = req.path;
  if (
    subpath === '/analytics'
    || subpath === '/unified-ledger'
    || subpath === '/unified-ledger/status'
  ) {
    return requireCapability('canAccessTradingAnalytics')(req, res, next);
  }
  if (
    subpath === '/review-dataset'
    || subpath.startsWith('/ai-review/')
    || subpath.startsWith('/portfolio-advisor/')
  ) {
    return requireCapability('canAccessAiTradingReview')(req, res, next);
  }
  return requireCapability('canAccessJournalSync')(req, res, next);
});`;
 const canonicalJournalGate="router.use('/paper-journal', requireCapability('canAccessJournalSync'));";
 if(!current.includes(aiChartFuturesGate))throw new Error('MEMBER_AI_CHART_FUTURES_GATE_MISSING');
 if(!current.includes(journalSplitGate))throw new Error('MEMBER_JOURNAL_CAPABILITY_SPLIT_MISSING');
 current=current
  .replace(aiChartFuturesGate,canonicalFuturesGate)
  .replace(journalSplitGate,canonicalJournalGate)
  .replace("    membership_expires_at: profile.membership_expires_at ?? null,\n",'');
}
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
// PR #1682 adds one runtime-flagged, staging-only public rehearsal endpoint.
// Normalize only these exact reviewed lines before comparing with current main;
// every other main route byte remains protected.
if(!mainRoute.includes("import autoRehearsalPreviewRouter from './auto-rehearsal-preview';"))current=current
 .replace("\nimport autoRehearsalPreviewRouter from './auto-rehearsal-preview';",'')
 .replace(
   "\n// PR-only isolated rehearsal preview. This route is runtime-flagged and only\n// runs synthetic safety gates plus the local Paper engine; it never reads member,\n// credential, Telegram, or production data and is disabled outside staging.\nrouter.use('/', autoRehearsalPreviewRouter);\n",
   '',
 );
if(current!==mainRoute)throw new Error('MAIN_ROUTE_CHANGE_NOT_PRESERVED');
const protectedPaths=['market-prediction-lab','research-production','research-dashboard','api-server/src/middleware/auth.ts','stock-analyzer/src/pages/research-center.tsx','stock-analyzer/vite.config.ts','packages/member-access','pnpm-lock.yaml'];
const protectedPathExceptions=new Map([
 ['market-prediction-lab',new Set([
  'market-prediction-lab/tests/canonical-shadow-runtime-activation-v1.test.js',
  'market-prediction-lab/src/frozen-candidate-performance-publisher-v1.js',
  'market-prediction-lab/tests/frozen-candidate-performance-publisher-v1.test.js',
  'market-prediction-lab/src/video-research-canonical-handoff-v1.js',
  'market-prediction-lab/src/evidence-backed-formula-entry-evaluator-v1.js',
  'market-prediction-lab/tests/evidence-backed-formula-entry-evaluator-v1.test.js',
  'market-prediction-lab/tests/video-research-canonical-handoff-v1.test.js',
 ])],
 ['research-production',new Set([
  'research-production/bin/research-approved-job-intake.mjs',
  'research-production/bin/research-maintenance.mjs',
  'research-production/deploy/activate-ai-research.sh',
  'research-production/deploy/activate-server.sh',
  'research-production/deploy/install-ai-research-units.sh',
  'research-production/deploy/research-production-ai-review.timer',
  'research-production/deploy/research-production-approved-job-intake.service',
  'research-production/deploy/research-production-approved-job-intake.timer',
  'research-production/deploy/research-production-factory-status.timer',
  'research-production/deploy/research-production-fast-historical.timer',
  'research-production/deploy/research-production-forward.timer',
  'research-production/deploy/research-production-long-history.timer',
  'research-production/deploy/research-production-maintenance.service',
  'research-production/deploy/research-production-maintenance.timer',
  'research-production/deploy/research-production-temporal-evidence.timer',
  'research-production/deploy/research-production-video-discovery.timer',
  'research-production/deploy/research-production-workspace-worker.service',
  'research-production/deploy/research-video.env.example',
  'research-production/src/research-ai-review-worker.mjs',
  'research-production/src/research-video-discovery-worker.mjs',
  'research-production/test/research-ai-activation-contract.test.mjs',
  'research-production/test/research-ai-review-worker.test.mjs',
  'research-production/test/research-ai-units-install-contract.test.mjs',
  'research-production/test/research-approved-job-intake.test.mjs',
  'research-production/test/research-maintenance.test.mjs',
  'research-production/test/research-engine.test.mjs',
  'research-production/test/server-risk-policy-env-transport.test.mjs',
 ])],
 ['research-dashboard',new Set([
  'research-dashboard/server.py',
  'research-dashboard/test/test_server.py',
 ])],
 ['stock-analyzer/src/pages/research-center.tsx',new Set([
  'stock-analyzer/src/pages/research-center.tsx',
 ])],
 ['api-server/src/middleware/auth.ts',memberAccessContractChanged
   ? new Set(['api-server/src/middleware/auth.ts'])
   : new Set()],
 ['packages/member-access',memberAccessContractChanged
   ? new Set(['packages/member-access/src/index.js','packages/member-access/src/index.d.ts'])
   : new Set()],
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
  reviewedChangedPaths:changed,researchCenterIntegrationReviewed:researchCenterChanged,protectedPaths,
  protectedPathExceptions:Object.fromEntries([...protectedPathExceptions].map(([key,value])=>[key,[...value]])),
  ancestryPreserved:true,mainUpdated:false,
  liveOrders:0,providerCalls:0,fixtureResultsAreEconomicEvidence:false};
const output=process.argv[2];if(output)writeFileSync(output,JSON.stringify(proof,null,2)+'\n');
console.log(JSON.stringify(proof,null,2));
