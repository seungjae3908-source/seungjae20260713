import { spawnSync } from 'node:child_process';
import path from 'node:path';

function runStagingScript(root: string, relativePath: string, fallback: string) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, relativePath)],
    {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || fallback)
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_DATABASE_URL]')
      .replace(/\b(?:sb_publishable|sb_secret|service_role|anon)_[A-Za-z0-9._-]+\b/gi, '[REDACTED_KEY]')
      .slice(0, 2_000);
    throw new Error(detail);
  }
  process.stdout.write(result.stdout || `${fallback}\n`);
}

export default async function stagingBootstrapGlobalSetup() {
  if (process.env.PHASE10_STAGING_E2E !== 'true') return;

  const root = path.resolve(process.cwd(), '..');
  runStagingScript(
    root,
    'api-server/scripts/apply-staging-supabase-bootstrap.mjs',
    '[staging-bootstrap] completed',
  );
  runStagingScript(
    root,
    'api-server/scripts/verify-staging-watchlist-store.mjs',
    '[staging-watchlist] verification completed',
  );
}
