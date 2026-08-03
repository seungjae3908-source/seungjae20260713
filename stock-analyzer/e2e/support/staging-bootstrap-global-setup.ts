import { spawnSync } from 'node:child_process';
import path from 'node:path';

export default async function stagingBootstrapGlobalSetup() {
  if (process.env.PHASE10_STAGING_E2E !== 'true') return;

  const root = path.resolve(process.cwd(), '..');
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'api-server/scripts/apply-staging-supabase-bootstrap.mjs')],
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
    const detail = (result.stderr || result.stdout || 'staging bootstrap failed')
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_DATABASE_URL]')
      .slice(0, 2_000);
    throw new Error(detail);
  }
  process.stdout.write(result.stdout || '[staging-bootstrap] completed\n');
}
