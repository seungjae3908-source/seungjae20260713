import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const requireMatch = (text, pattern, message) => {
  if (!pattern.test(text)) throw new Error(message);
};
const forbid = (text, pattern, message) => {
  if (pattern.test(text)) throw new Error(message);
};

const workflow = read('.github/workflows/staging-diagnostic-sweep.yml');
const runner = read('api-server/scripts/run-staging-diagnostic-sweep.mjs');
const report = read('api-server/scripts/build-staging-diagnostic-report.mjs');
const config = read('stock-analyzer/playwright.staging-diagnostic.config.ts');
const canonical = read('stock-analyzer/e2e/phase10-staging-readiness.spec.ts');
const certificationWorkflow = read('.github/workflows/staging-readiness.yml');

requireMatch(workflow, /on:\s*\n\s*workflow_dispatch:/u, 'Diagnostic workflow must remain explicit manual dispatch only.');
forbid(workflow, /\n\s*schedule:/u, 'Diagnostic workflow must not acquire a schedule trigger.');
forbid(workflow, /\n\s*issue_comment:/u, 'Diagnostic workflow must not acquire an issue-comment activation surface.');
requireMatch(workflow, /permissions:\s*\n\s*contents:\s*read/u, 'Diagnostic workflow must keep contents read-only permission.');
forbid(workflow, /statuses:\s*write|contents:\s*write|actions:\s*write/u, 'Diagnostic workflow must not gain write permissions.');
requireMatch(workflow, /environment:\s*staging/u, 'Diagnostic workflow must remain isolated to the staging environment.');
forbid(workflow, /environment:\s*production/u, 'Diagnostic workflow must never use the production environment.');
forbid(workflow, /PROD_(?:SSH|DATABASE|SUPABASE|API|SECRET|ENV)/u, 'Diagnostic workflow must not consume Production credentials.');
requireMatch(workflow, /actual_main="\$\(git rev-parse refs\/remotes\/origin\/main\)"/u, 'Diagnostic workflow must bind to exact current main.');
requireMatch(workflow, /\[\[ "\$target" == "\$actual_main" \]\]/u, 'Diagnostic workflow must reject stale target SHA.');
requireMatch(workflow, /STAGING_TARGET_NOT_DEPLOYED/u, 'Diagnostic workflow must refuse a target that is not already deployed to staging.');
requireMatch(workflow, /staging-diagnostic-\$\{\{ steps\.exact_main\.outputs\.sha \}\}-\$\{\{ github\.run_id \}\}/u, 'Diagnostic evidence must use its own immutable artifact namespace.');
forbid(workflow, /name:\s*staging-verdict-/u, 'Diagnostic evidence must never masquerade as canonical staging-verdict evidence.');
forbid(workflow, /deploy-staging\.sh|production-deploy\.yml|run-production-app|activate-natural-paper/u, 'Diagnostic workflow must not deploy or activate runtime schedules.');

requireMatch(config, /globalSetup:\s*undefined/u, 'Diagnostic Playwright config must disable canonical staging global bootstrap.');
requireMatch(config, /workers:\s*1/u, 'Diagnostic Playwright config must remain single-worker.');
requireMatch(config, /retries:\s*0/u, 'Diagnostic Playwright config must not retry-to-pass.');

requireMatch(canonical, /test\.describe\.configure\(\{ mode: 'serial' \}\);/u, 'Canonical certification suite must remain serial/fail-closed.');
requireMatch(runner, /source\s*\.replace\(serialMarker, serialReplacement\)/u, 'Diagnostic runner must derive its non-serial suite from the canonical source.');
requireMatch(runner, /test\.describe\.configure\(\{ mode: 'default' \}\);/u, 'Diagnostic runner must override serial mode only in the generated diagnostic copy.');
requireMatch(runner, /fs\.rmSync\(generatedSpec, \{ force: true \}\)/u, 'Generated diagnostic source must be removed after execution.');
requireMatch(runner, /'--workers=1'/u, 'Diagnostic runner must remain single-worker.');
requireMatch(runner, /'--retries=0'/u, 'Diagnostic runner must keep retries disabled.');
requireMatch(runner, /'--max-failures=0'/u, 'Diagnostic runner must collect all failures rather than stop at a failure count.');
requireMatch(runner, /staging-browser-results-\$\{process\.pid\}\.json/u, 'Diagnostic runner must preserve browser evidence across Playwright worker restarts.');

requireMatch(report, /certification_eligible:\s*false/u, 'Diagnostic report must never claim certification eligibility.');
requireMatch(report, /release_ready_claim:\s*false/u, 'Diagnostic report must never claim release_ready.');
requireMatch(report, /INCOMPLETE/u, 'Missing diagnostic evidence must remain explicit INCOMPLETE.');
requireMatch(report, /PRIMARY_ROOT_CAUSE_CANDIDATE/u, 'Diagnostic report must identify a primary root-cause candidate.');
requireMatch(report, /SECONDARY_FAILURE_CLUSTER/u, 'Diagnostic report must retain secondary failure clusters.');
requireMatch(report, /staging-browser-results-\\d\+\\\.json/u, 'Diagnostic report must aggregate browser diagnostics from restarted workers.');

requireMatch(certificationWorkflow, /Build final staging release verdict/u, 'Canonical certification workflow must retain its final release verdict step.');
requireMatch(certificationWorkflow, /node api-server\/scripts\/build-staging-verdict\.mjs/u, 'Canonical certification workflow must continue using build-staging-verdict.mjs.');

console.log(JSON.stringify({
  contract: 'FULL_RELEASE_DIAGNOSTIC_CERTIFICATION_SYSTEM',
  diagnosticAuthority: 'DIAGNOSTIC_ONLY',
  certificationAuthority: 'CANONICAL_STAGING_READINESS_ONLY',
  productionMutationAuthority: 0,
  liveTradingAuthority: 0,
  realOrderAuthority: 0,
  pass: true,
}));
