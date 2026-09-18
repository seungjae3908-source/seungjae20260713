import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const IMPACT_RULES = Object.freeze({
  shared: /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|packages\/)/u,
  frontend: /^(stock-analyzer\/|packages\/|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)/u,
  backend: /^(api-server\/|packages\/|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)/u,
  phase2: /^(api-server\/.*(futures|bitget|market|scanner)|packages\/)/u,
  phase5: /^(api-server\/.*(backtest|research|strategy|candidate)|stock-analyzer\/.*backtest)/u,
  phase6: /^(api-server\/.*(paper|position|settlement|scanner)|stock-analyzer\/.*(paper|scanner))/u,
  phase7: /^(api-server\/.*(journal|portfolio)|stock-analyzer\/.*(journal|portfolio))/u,
  phase8: /^(api-server\/.*(auth|member|account|security|migration|rls)|stock-analyzer\/.*(account|admin|auth))/u,
  phase9: /^(api-server\/.*(ai|privacy|prompt)|stock-analyzer\/.*(ai-|ai\/))/u,
  phase12: /^(api-server\/.*(trade|approval|execution|order|automation)|stock-analyzer\/.*(trade|approval|auto-trading))/u,
  ci: /^\.github\//u,
});

export function normalizeChangedFiles(files) {
  return [...new Set(files.map((file) => String(file).trim()).filter(Boolean))].sort();
}

export function classifyChangedFiles(files) {
  const normalized = normalizeChangedFiles(files);
  return Object.fromEntries(Object.entries(IMPACT_RULES).map(([name, matcher]) => [
    name,
    normalized.some((file) => matcher.test(file)),
  ]));
}

export function commandsForImpact(impact, { includeBuild = true } = {}) {
  const commands = [
    'node .github/scripts/connection-graph-auditor.mjs --json-output /tmp/connection-graph.json --markdown-output /tmp/connection-graph.md',
    'node .github/scripts/product-integrity-auditor.mjs --json-output /tmp/product-integrity.json --markdown-output /tmp/product-integrity.md',
  ];
  if (impact.frontend) commands.push('pnpm --dir stock-analyzer run typecheck');
  if (impact.phase5 || impact.shared) commands.push('node --test .github/tests/backtest-paper-handoff-ui.test.mjs');
  if (impact.backend) {
    commands.push('pnpm --dir api-server run typecheck');
    commands.push('pnpm --dir api-server run test:unit');
  }
  for (const phase of ['phase2', 'phase5', 'phase6', 'phase7', 'phase8', 'phase9', 'phase12']) {
    if (impact[phase]) commands.push(`pnpm --dir api-server run test:${phase}`);
  }
  if (impact.backend) commands.push('pnpm --dir api-server run test:smoke');
  if (includeBuild && impact.frontend) commands.push('pnpm --dir stock-analyzer run build');
  if (includeBuild && impact.backend) commands.push('pnpm --dir api-server run build:server');
  if (impact.ci) {
    commands.push('node --test .github/tests/pr-exact-head-*.test.mjs');
    commands.push('node --test .github/tests/connection-graph-auditor.test.mjs');
    commands.push('node --test .github/tests/product-integrity-auditor.test.mjs');
  }
  return commands;
}

function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function changedFilesBetween(base, head, cwd = process.cwd()) {
  return normalizeChangedFiles(git(['diff', '--name-only', base, head, '--'], cwd).split(/\r?\n/u));
}

function parseArgs(argv) {
  const options = { base: null, head: 'HEAD', changedFiles: null, githubOutput: null, jsonOutput: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') options.base = argv[++index] ?? null;
    else if (arg === '--head') options.head = argv[++index] ?? 'HEAD';
    else if (arg === '--changed-files') options.changedFiles = argv[++index] ?? null;
    else if (arg === '--github-output') options.githubOutput = argv[++index] ?? null;
    else if (arg === '--json-output') options.jsonOutput = argv[++index] ?? null;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let files;
  if (options.changedFiles) {
    files = normalizeChangedFiles((await readFile(options.changedFiles, 'utf8')).split(/\r?\n/u));
  } else {
    if (!options.base) throw new Error('--base is required when --changed-files is not supplied');
    files = changedFilesBetween(options.base, options.head);
  }
  const impact = classifyChangedFiles(files);
  const plan = {
    schemaVersion: 1,
    base: options.base,
    head: options.head,
    changedFiles: files,
    impact,
    commands: commandsForImpact(impact),
  };

  if (options.githubOutput) {
    for (const [name, value] of Object.entries(impact)) {
      await appendFile(options.githubOutput, `${name}=${value ? 'true' : 'false'}\n`, 'utf8');
    }
    await appendFile(options.githubOutput, `changed_count=${files.length}\n`, 'utf8');
  }
  const json = `${JSON.stringify(plan, null, 2)}\n`;
  if (options.jsonOutput) await writeFile(options.jsonOutput, json, 'utf8');
  process.stdout.write(json);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`[CI_IMPACT_PLAN_FAILED] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
