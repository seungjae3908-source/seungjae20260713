import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  changedFilesBetween,
  classifyChangedFiles,
  commandsForImpact,
  normalizeChangedFiles,
} from './ci-impact-plan.mjs';

function exec(command, args, cwd, options = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...options.env },
  }).trim();
}

function git(args, cwd) {
  return exec('git', args, cwd);
}

function runShell(command, cwd) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`command failed (${result.status}): ${command}`);
}

function parseArgs(argv) {
  const options = {
    base: process.env.PRE_CI_BASE_REF || 'origin/main',
    head: 'HEAD',
    virtualMerge: false,
    readyGate: false,
    gateOnly: false,
    planOnly: false,
    skipInstall: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') options.base = argv[++index] ?? options.base;
    else if (arg === '--head') options.head = argv[++index] ?? options.head;
    else if (arg === '--virtual-merge') options.virtualMerge = true;
    else if (arg === '--ready-gate') options.readyGate = true;
    else if (arg === '--gate-only') options.gateOnly = true;
    else if (arg === '--plan-only') options.planOnly = true;
    else if (arg === '--skip-install') options.skipInstall = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function ensureCommit(ref, cwd) {
  const sha = git(['rev-parse', '--verify', `${ref}^{commit}`], cwd);
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error(`[INVALID_COMMIT] ${ref}`);
  return sha;
}

async function runAuditors(cwd, requireZeroLedger) {
  const temp = await mkdtemp(path.join(tmpdir(), 'ci-v3-audit-'));
  try {
    const graphJson = path.join(temp, 'connection-graph.json');
    const graphMd = path.join(temp, 'connection-graph.md');
    const integrityJson = path.join(temp, 'product-integrity.json');
    const integrityMd = path.join(temp, 'product-integrity.md');
    runShell(`node .github/scripts/connection-graph-auditor.mjs --json-output "${graphJson}" --markdown-output "${graphMd}"`, cwd);
    runShell(`node .github/scripts/product-integrity-auditor.mjs --json-output "${integrityJson}" --markdown-output "${integrityMd}"`, cwd);
    const integrity = JSON.parse(await readFile(integrityJson, 'utf8'));
    if (requireZeroLedger && (integrity.counts?.p0Open !== 0 || integrity.counts?.p1Open !== 0)) {
      throw new Error(`[READY_PRODUCT_INTEGRITY_BLOCKED] P0=${integrity.counts?.p0Open ?? 'UNKNOWN'} P1=${integrity.counts?.p1Open ?? 'UNKNOWN'}`);
    }
    return integrity;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function runVirtualMergeGate(root, base, head, requireZeroLedger) {
  const worktree = await mkdtemp(path.join(tmpdir(), 'ci-v3-virtual-merge-'));
  try {
    runShell(`git worktree add --detach "${worktree}" "${head}"`, root);
    try {
      runShell(`git merge --no-commit --no-ff "${base}"`, worktree);
    } catch (error) {
      throw new Error(`[VIRTUAL_MERGE_CONFLICT] ${error instanceof Error ? error.message : String(error)}`);
    }
    await runAuditors(worktree, requireZeroLedger);
    process.stdout.write(`[VIRTUAL_MERGE_PASS] base=${base} head=${head}\n`);
  } finally {
    try { runShell(`git worktree remove --force "${worktree}"`, root); } catch {}
    await rm(worktree, { recursive: true, force: true });
  }
}

function workingTreeChangedFiles(base, root) {
  const tracked = git(['diff', '--name-only', base, '--'], root).split(/\r?\n/u);
  const untracked = git(['ls-files', '--others', '--exclude-standard'], root).split(/\r?\n/u);
  return normalizeChangedFiles([...tracked, ...untracked]);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = git(['rev-parse', '--show-toplevel'], process.cwd());
  ensureCommit(options.base, root);
  ensureCommit(options.head, root);

  if (options.readyGate) {
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', options.base, options.head], { cwd: root });
    if (ancestor.status !== 0) {
      throw new Error(`[READY_BASE_STALE] ${options.head} does not contain latest base ${options.base}`);
    }
  }

  if (options.virtualMerge || options.readyGate) {
    await runVirtualMergeGate(root, options.base, options.head, options.readyGate);
  }

  if (options.gateOnly) {
    process.stdout.write('[PRE_CI_V3_GATE_PASS]\n');
    return;
  }

  const headSha = git(['rev-parse', options.head], root);
  const currentSha = git(['rev-parse', 'HEAD'], root);
  const dirty = git(['status', '--porcelain=v1'], root).trim().length > 0;
  const files = headSha === currentSha && dirty
    ? workingTreeChangedFiles(options.base, root)
    : changedFilesBetween(options.base, options.head, root);
  const impact = classifyChangedFiles(files);
  const commands = commandsForImpact(impact);

  process.stdout.write(`${JSON.stringify({ base: options.base, head: options.head, changedFiles: files, impact, commands }, null, 2)}\n`);
  if (options.planOnly) return;

  if (!options.skipInstall && (impact.frontend || impact.backend)) {
    runShell('pnpm install --frozen-lockfile --prefer-offline', root);
  }
  for (const command of commands) runShell(command, root);
  process.stdout.write('[PRE_CI_V3_PASS]\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`[PRE_CI_V3_FAILED] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
