import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const workflowPath = path.join(root, '.github/workflows/telegram-production-release.yml');
const source = fs.readFileSync(workflowPath, 'utf8');

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
  .filter(([pattern]) => pattern.test(source))
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
  if (outputPattern.test(source)) {
    console.error(`[telegram-production-release-contract] ${name} must not be written to outputs or summaries`);
    process.exit(1);
  }
}

console.log('[telegram-production-release-contract] owner gate, exact-main CI, staging evidence, existing Production dispatch, runtime identity, worker startup, sanitized Telegram proof, and zero-trading-authority contracts verified');
