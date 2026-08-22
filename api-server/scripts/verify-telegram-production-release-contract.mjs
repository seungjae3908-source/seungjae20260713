import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const workflowPath = path.join(root, '.github/workflows/telegram-production-release.yml');
const deployPath = path.join(root, 'ops/deploy-production.sh');
const source = fs.readFileSync(workflowPath, 'utf8');
const deploySource = fs.readFileSync(deployPath, 'utf8');

const requiredFragments = [
  'name: Telegram Production Release',
  'issue_comment:',
  'pull_request:',
  'github.event.issue.number == 23',
  "github.event.issue.title == 'Staging Readiness Control'",
  "github.event.comment.user.login == 'seungjae3908-source'",
  "github.event.comment.author_association == 'OWNER'",
  '/run-telegram-production ',
  '^\\/run-telegram-production ([0-9a-fA-F]{40})$',
  'environment: production',
  'actions: write',
  'issues: write',
  'Require exact current main SHA',
  'production-ci-provenance.cjs',
  'application-ci/verified',
  'browser-ui/verified',
  'database-rls/verified',
  'security-integration/verified',
  'ai-privacy/verified',
  'futures-public-network-smoke/verified',
  'staging-postgres-auth-${targetSha}',
  'staging-verdict-${targetSha}',
  'verify-staging-verdict.mjs',
  'Apply and verify Production personal Telegram storage atomically',
  'production-personal-telegram-storage-${{ steps.command.outputs.sha }}',
  'ops/verify-production-personal-telegram-storage.mjs --artifact',
  "workflow_id: 'production-deploy.yml'",
  'return_run_details: true',
  'run.head_sha !== targetSha',
  "run.path !== '.github/workflows/production-deploy.yml'",
  'LIVE_TELEGRAM_ACTIVATION_APPROVED',
  'TELEGRAM_INTELLIGENCE_WORKER_ENABLED',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  '[telegram-intelligence-worker] started',
  'api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage',
  'telegramValue?.ok !== true',
  'orderSubmitted: false',
  'privateTradingApiCount: 0',
  'liveTradingAuthority: false',
  'secretsRecorded: false',
];

const missing = requiredFragments.filter((fragment) => !source.includes(fragment));
if (missing.length > 0) {
  console.error(`[telegram-production-release-contract] missing safeguards: ${missing.join(', ')}`);
  process.exit(1);
}

const storageMigrationIndex = source.indexOf('Apply and verify Production personal Telegram storage atomically');
const productionDispatchIndex = source.indexOf('Dispatch existing Production Deploy and require exact-run success');
if (storageMigrationIndex < 0 || productionDispatchIndex <= storageMigrationIndex) {
  console.error('[telegram-production-release-contract] atomic personal Telegram storage migration must precede Production deployment');
  process.exit(1);
}
if (/\b(?:PROD_DATABASE_URL|DATABASE_URL|POSTGRES_URL)\b/.test(source)) {
  console.error('[telegram-production-release-contract] Production workflow must reuse the server connection without adding a database secret');
  process.exit(1);
}

const deployRequiredFragments = [
  'telegram_runtime_activation_ready()',
  'runtime identity or Telegram activation is stale',
  'LIVE_TELEGRAM_ACTIVATION_APPROVED=false TELEGRAM_INTELLIGENCE_WORKER_ENABLED=false',
  'LIVE_TELEGRAM_ACTIVATION_APPROVED=true',
  'TELEGRAM_INTELLIGENCE_WORKER_ENABLED=true',
  'telegram_runtime_activation_ready',
];
const missingDeploy = deployRequiredFragments.filter((fragment) => !deploySource.includes(fragment));
if (missingDeploy.length > 0) {
  console.error(`[telegram-production-release-contract] missing deployment activation safeguards: ${missingDeploy.join(', ')}`);
  process.exit(1);
}

const canaryStart = deploySource.indexOf('nohup env PORT="$CANARY_PORT"');
const canaryEnd = deploySource.indexOf('CANARY_PID="$(cat "$RELEASE_DIR/.canary.pid")"');
if (canaryStart < 0 || canaryEnd <= canaryStart) {
  console.error('[telegram-production-release-contract] canary process block was not found');
  process.exit(1);
}
const canaryBlock = deploySource.slice(canaryStart, canaryEnd);
if (!canaryBlock.includes('LIVE_TELEGRAM_ACTIVATION_APPROVED=false')
  || !canaryBlock.includes('TELEGRAM_INTELLIGENCE_WORKER_ENABLED=false')
  || canaryBlock.includes('LIVE_TELEGRAM_ACTIVATION_APPROVED=true')) {
  console.error('[telegram-production-release-contract] canary must remain Telegram fail-closed');
  process.exit(1);
}

const sameTargetStart = deploySource.indexOf('if [[ "$CURRENT_SHA" == "$TARGET_SHA" ]]');
const sameTargetEnd = deploySource.indexOf('mkdir -p "$RELEASE_DIR"', sameTargetStart);
if (sameTargetStart < 0 || sameTargetEnd <= sameTargetStart) {
  console.error('[telegram-production-release-contract] same-target refresh block was not found');
  process.exit(1);
}
const sameTargetBlock = deploySource.slice(sameTargetStart, sameTargetEnd);
if (!sameTargetBlock.includes('telegram_runtime_activation_ready')
  || !sameTargetBlock.includes('LIVE_TELEGRAM_ACTIVATION_APPROVED=true')
  || !sameTargetBlock.includes('TELEGRAM_INTELLIGENCE_WORKER_ENABLED=true')) {
  console.error('[telegram-production-release-contract] same-target deployment must repair Telegram activation');
  process.exit(1);
}

const promotionStart = deploySource.lastIndexOf('set +e');
const promotionEnd = deploySource.indexOf('DEPLOY_RESULT=$?', promotionStart);
if (promotionStart < 0 || promotionEnd <= promotionStart) {
  console.error('[telegram-production-release-contract] production promotion block was not found');
  process.exit(1);
}
const promotionBlock = deploySource.slice(promotionStart, promotionEnd);
if (!promotionBlock.includes('LIVE_TELEGRAM_ACTIVATION_APPROVED=true')
  || !promotionBlock.includes('TELEGRAM_INTELLIGENCE_WORKER_ENABLED=true')
  || !promotionBlock.includes('pm2 restart "$PM2_NAME" --update-env')
  || !promotionBlock.includes('telegram_runtime_activation_ready')) {
  console.error('[telegram-production-release-contract] exact production promotion must activate and verify Telegram runtime');
  process.exit(1);
}

const forbiddenPatterns = [
  [/pull_request_target\s*:/, 'pull_request_target is forbidden'],
  [/repository_dispatch\s*:/, 'repository_dispatch is forbidden'],
  [/cancel-in-progress:\s*true/, 'release cancellation is forbidden'],
  [/echo[^\n]*(TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)/i, 'Telegram secrets must never be echoed'],
  [/console\.(log|error)\([^\n]*(botToken|chatId)/, 'Telegram secrets must never be logged'],
  [/core\.(info|notice|warning|error)\([^\n]*(botToken|chatId)/, 'Telegram secrets must never enter GitHub logs'],
  [/pm2\s+(delete|stop)\s+stock-app/, 'Production process destructive control is forbidden'],
  [/\b(order|cancel|amend|withdraw|transfer)\s*\(/i, 'Trading mutations are forbidden'],
];

const violations = forbiddenPatterns
  .filter(([pattern]) => pattern.test(source) || pattern.test(deploySource))
  .map(([, message]) => message);
if (violations.length > 0) {
  console.error(`[telegram-production-release-contract] forbidden behavior: ${violations.join(', ')}`);
  process.exit(1);
}

const exactCommandMatches = source.match(/\^\\\/run-telegram-production \(\[0-9a-fA-F\]\{40\}\)\$/g) ?? [];
if (exactCommandMatches.length !== 1) {
  console.error('[telegram-production-release-contract] exact owner command parser must appear once');
  process.exit(1);
}

const secretNames = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
for (const name of secretNames) {
  const outputPattern = new RegExp(`(?:GITHUB_OUTPUT|GITHUB_STEP_SUMMARY)[^\\n]*${name}`, 'i');
  if (outputPattern.test(source) || outputPattern.test(deploySource)) {
    console.error(`[telegram-production-release-contract] ${name} must not be written to outputs or summaries`);
    process.exit(1);
  }
}

console.log('[telegram-production-release-contract] owner gate, exact-main CI, staging evidence, canary fail-closed behavior, production Telegram activation, runtime identity, worker startup, sanitized Telegram proof, and zero-trading-authority contracts verified');
