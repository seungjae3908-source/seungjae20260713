import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const targetSha = String(process.env.STAGING_TARGET_SHA ?? process.env.TARGET_SHA ?? '').trim().toLowerCase();
const scope = String(process.env.STAGING_DIAGNOSTIC_SCOPE ?? 'all').trim();
const artifactDir = path.resolve(process.env.STAGING_ARTIFACT_DIR ?? 'staging-artifacts');
const repoRoot = process.cwd();
const sourceSpec = path.join(repoRoot, 'stock-analyzer/e2e/phase10-staging-readiness.spec.ts');
const generatedRelative = 'e2e/phase10-staging-diagnostic.generated.spec.ts';
const generatedSpec = path.join(repoRoot, 'stock-analyzer', generatedRelative);
const marker = "test.describe.configure({ mode: 'serial' });";
const replacement = "test.describe.configure({ mode: 'default' });";

const scopePatterns = {
  all: null,
  'auth-admin': 'login, refresh session retention|bootstrap finite-state|profile timeout abort|retry recovery|pending: approval-waiting|associate: basic stock|regular: futures|admin:',
  'ai-chart': 'regular: futures, scanner, paper trading, and safe AI preview',
  'scanner-paper': 'scanner readiness|regular: futures, scanner, paper trading, and safe AI preview',
  'navigation-mobile': 'admin: full product staging journey|desktop: major screens|mobile [0-9]+x[0-9]+: major screens|mobile: search/detail|bottom navigation and popup menus',
  'account-session': 'desktop: login, refresh session retention|mobile: login, refresh session retention|profile timeout abort|retry recovery|pending: approval-waiting|associate: basic stock|admin:',
  'runtime-data': 'anonymous: health, login boundary, and protected API denial',
};

const fail = (message, code = 2) => {
  console.error(message);
  process.exit(code);
};

if (!/^[0-9a-f]{40}$/.test(targetSha)) fail('STAGING_TARGET_SHA must be an exact 40-character lowercase SHA.');
if (!(scope in scopePatterns)) fail(`Unsupported STAGING_DIAGNOSTIC_SCOPE: ${scope}`);
if (!fs.existsSync(sourceSpec)) fail(`Canonical staging spec is missing: ${sourceSpec}`);

const source = fs.readFileSync(sourceSpec, 'utf8');
const markerCount = source.split(marker).length - 1;
if (markerCount !== 1) {
  fail(`Expected exactly one canonical serial marker, found ${markerCount}. Refusing to generate a diagnostic variant.`);
}

fs.mkdirSync(artifactDir, { recursive: true });
const startedAt = new Date().toISOString();
let exitCode = 2;
let signal = null;

try {
  const generated = [
    '// GENERATED AT RUNTIME FOR DIAGNOSTIC COLLECTION ONLY.',
    '// Canonical certification source remains phase10-staging-readiness.spec.ts.',
    source.replace(marker, replacement),
  ].join('\n');
  fs.writeFileSync(generatedSpec, generated, 'utf8');

  const args = [
    '--dir', 'stock-analyzer',
    'exec', 'playwright', 'test',
    '-c', 'playwright.config.ts',
    generatedRelative,
    '--workers=1',
    '--retries=0',
    '--max-failures=0',
  ];
  const grep = scopePatterns[scope];
  if (grep) args.push('--grep', grep);

  console.log(`[staging-diagnostic] scope=${scope}`);
  console.log(`[staging-diagnostic] target_sha=${targetSha}`);
  console.log('[staging-diagnostic] certification source mutation=false');
  console.log('[staging-diagnostic] generated suite mode=default; workers=1; retries=0; maxFailures=unbounded');

  const result = spawnSync('pnpm', args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      PHASE10_STAGING_E2E: 'true',
      PHASE10_STAGING_DIAGNOSTIC: 'true',
      STAGING_TARGET_SHA: targetSha,
      STAGING_DIAGNOSTIC_SCOPE: scope,
    },
  });
  exitCode = Number.isInteger(result.status) ? result.status : 2;
  signal = result.signal ?? null;
} finally {
  try {
    fs.rmSync(generatedSpec, { force: true });
  } catch (error) {
    console.error(`[staging-diagnostic] generated spec cleanup failed: ${String(error)}`);
    exitCode = 2;
  }

  const metadata = {
    schema: 'FULL_RELEASE_DIAGNOSTIC_CERTIFICATION_SYSTEM',
    target_sha: targetSha,
    scope,
    canonical_certification_source_mutated: false,
    diagnostic_serial_override: 'default',
    workers: 1,
    retries: 0,
    max_failures: 0,
    runner_exit_code: exitCode,
    signal,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(artifactDir, 'staging-diagnostic-run.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf8',
  );
}

process.exitCode = exitCode;
