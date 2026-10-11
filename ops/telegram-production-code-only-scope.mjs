/** Pure fail-closed scope policy for a Telegram code-only Production deploy.
 * No network, state mutation, order authority or secrets.
 */
export const TELEGRAM_CODE_ONLY_ALLOWED_FILES = Object.freeze([
  '.github/tests/telegram-only-staging-qa.test.mjs',
  '.github/tests/telegram-production-worker-readonly-audit.test.mjs',
  '.github/tests/telegram-sixroom-vault-pm2-binding.test.mjs',
  '.github/workflows/telegram-only-staging-qa.yml',
  '.github/workflows/telegram-production-worker-readonly-audit.yml',
  '.github/workflows/telegram-sixroom-vault-pm2-binding.yml',
  'api-server/src/features/user-broker-telegram/user-broker-telegram.service.test.ts',
  'api-server/src/index.ts',
  'api-server/src/services/signal-intelligence-telegram-subscriber.service.test.ts',
  'api-server/src/services/signal-intelligence-telegram-subscriber.service.ts',
  'api-server/src/services/telegram-intelligence-worker.service.ts',
  'api-server/src/services/telegram-notification.service.test.ts',
  'docs/telegram-only-staging-qa.md',
  'docs/telegram-production-worker-readonly-audit.md',
  'docs/telegram-sixroom-vault-pm2-binding.md',
  'ops/telegram-only-staging-readonly.mjs',
  'ops/telegram-production-worker-readonly-audit.mjs',
  'ops/telegram-sixroom-vault-pm2-binding.mjs',
  '.github/workflows/telegram-production-code-only-deploy.yml',
  '.github/tests/telegram-production-code-only-deploy.test.mjs',
  'ops/telegram-production-code-only-scope.mjs',
  'ops/deploy-production.sh',
  'docs/telegram-production-code-only-deploy.md',
]);
const safe = new Set(TELEGRAM_CODE_ONLY_ALLOWED_FILES);

/** Require exact ancestor relationship, a bounded file list and no other scope. */
export function classifyTelegramCodeOnlyDiff(diff) {
  if (!diff || diff.status !== 'ahead' || diff.behind_by !== 0
    || !Number.isSafeInteger(diff.ahead_by) || diff.ahead_by < 1 || diff.ahead_by > 30
    || !Number.isSafeInteger(diff.total_commits)
    || diff.total_commits !== diff.ahead_by || !Array.isArray(diff.files)
    || diff.files.length < 1 || diff.files.length > 30) {
    return Object.freeze({ ok:false,code:'TELEGRAM_SCOPE_INVALID_COMPARE' });
  }
  const names = diff.files.map(file => file?.filename);
  if (names.some(name => typeof name !== 'string' || name.length > 240)
    || new Set(names).size !== names.length
    || diff.files.some(file => !safe.has(file.filename)
      || !['added','modified'].includes(file.status))) {
    return Object.freeze({ ok:false,code:'TELEGRAM_SCOPE_UNRELATED_CHANGE' });
  }
  const mustContain = [
    'api-server/src/services/telegram-intelligence-worker.service.ts',
    'api-server/src/services/signal-intelligence-telegram-subscriber.service.ts',
    'api-server/src/index.ts',
    '.github/workflows/telegram-production-code-only-deploy.yml',
    'ops/deploy-production.sh',
  ];
  if (!mustContain.every(name => names.includes(name)))
    return Object.freeze({ ok:false,code:'TELEGRAM_SCOPE_REQUIRED_FILE_ABSENT' });
  return Object.freeze({ok:true,code:'TELEGRAM_CODE_ONLY_SCOPE_PASS',changedFileCount:names.length});
}
