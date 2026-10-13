#!/usr/bin/env node
// Explicitly operator-gated research-only one-shot. No timer/daemon/activation.
import { execFileSync } from 'node:child_process';
import { lstat, readFile, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MINUTE_ARCHIVE_LIMITS, runMinuteArchiveIntakeV1 } from
  '../src/four-market-minute-archive-intake-v1.mjs';

const output = data => process.stdout.write(JSON.stringify(data) + '\n');
const die = code => { throw new Error(code); };
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.length === 1 && args[0] === '--dry-run') {
    return output({ status: 'DISABLED', mode: 'DRY_RUN', providerCalls: 0,
      filesWritten: 0, executionAuthority: 'NONE' });
  }
  if (args.length !== 1 || args[0] !== '--execute'
    || process.env.RESEARCH_MINUTE_ARCHIVE_ENABLED !== 'true')
    die('MINUTE_OWNER_ACTIVATION_REQUIRED');
  const { RESEARCH_CODE_SHA: researchSha, RESEARCH_MINUTE_ARCHIVE_ROOT: root,
    RESEARCH_MINUTE_ARCHIVE_MANIFEST: file } = process.env;
  if (!/^[0-9a-f]{40}$/u.test(researchSha ?? '')
    || !isAbsolute(root ?? '') || !isAbsolute(file ?? ''))
    die('MINUTE_OWNER_CONFIGURATION_INVALID');
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const actual = execFileSync('git', ['rev-parse', 'HEAD'],
    { cwd: repo, encoding: 'utf8', timeout: 5000 }).trim();
  if (actual !== researchSha) die('MINUTE_CURRENT_SHA_MISMATCH');
  const manifestStat = await lstat(file);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()
    || manifestStat.nlink !== 1 || (manifestStat.mode & 0o077)
    || manifestStat.size < 1 || manifestStat.size > 64 * 1024)
    die('MINUTE_TASK_MANIFEST_UNSAFE');
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  if (parsed?.schemaVersion !== 'minute-archive-operator-task-manifest/v1'
    || !Array.isArray(parsed.tasks) || !parsed.tasks.length
    || parsed.tasks.length > MINUTE_ARCHIVE_LIMITS.maxTasks)
    die('MINUTE_TASK_MANIFEST_INVALID');
  const fs = await statfs(root);
  const freeBytes = Number(fs.bavail) * Number(fs.bsize);
  if (!Number.isSafeInteger(freeBytes)) die('MINUTE_DISK_READBACK_INVALID');
  const status = await runMinuteArchiveIntakeV1({
    enabled: true, root, tasks: parsed.tasks, researchSha, freeBytes,
  });
  output(status);
  if (status.status !== 'ARCHIVED_OR_REUSED') process.exitCode = 2;
}
main().catch(e => {
  // Never print environment variables, paths, provider bodies or credentials.
  const safe = /^MINUTE_[A-Z0-9_]{1,80}$/u.test(e?.message ?? '')
    ? e.message : 'MINUTE_OPERATOR_PRECONDITION_FAILED';
  output({ status: 'BLOCKED', reason: safe, providerCalls: 0,
    executionAuthority: 'NONE' });
  process.exitCode = 2;
});
