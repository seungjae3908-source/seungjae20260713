#!/usr/bin/env node
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { assertResearchSafety, buildTaskPlan, preflightResearchProduction, runResearchCycle } from '../src/engine.mjs';

function parse(argv) {
  const command = argv[2] ?? 'plan';
  const options = {};
  for (let i = 3; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    options[key] = value;
    i += 1;
  }
  return { command, options };
}

function settings(options) {
  const repoRoot = resolve(options['repo-root'] ?? process.env.RESEARCH_REPO_ROOT ?? process.cwd());
  const stateRoot = resolve(options['state-root'] ?? process.env.RESEARCH_STATE_ROOT ?? '/var/lib/investment-research-production');
  const researchSha = options['research-sha'] ?? process.env.RESEARCH_CODE_SHA ?? process.env.GITHUB_SHA ?? '';
  const profile = options.profile ?? process.env.RESEARCH_PROFILE ?? 'fast-historical';
  const concurrency = Number(options.concurrency ?? process.env.RESEARCH_CONCURRENCY ?? Math.max(1, Math.min(4, cpus().length)));
  return { repoRoot, stateRoot, researchSha, profile, concurrency };
}

try {
  const { command, options } = parse(process.argv);
  const config = settings(options);
  if (command === 'plan') {
    assertResearchSafety({ stateRoot: config.stateRoot, repoRoot: config.repoRoot });
    const tasks = buildTaskPlan({ profile: config.profile, stateRoot: config.stateRoot, researchSha: config.researchSha });
    console.log(JSON.stringify({ status: 'planned', profile: config.profile, researchSha: config.researchSha, taskCount: tasks.length, tasks: tasks.map(({ id, kind, args, timeoutMs }) => ({ id, kind: kind ?? 'historical', args, timeoutMs })), liveTrading: false, privateApi: false, orderAuthority: false }, null, 2));
  } else if (command === 'preflight') {
    const result = await preflightResearchProduction(config);
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'run') {
    const result = await runResearchCycle(config);
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'partial_failure') process.exitCode = 1;
  } else {
    throw new Error(`unsupported command: ${command}`);
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'failed_closed', error: String(error?.message ?? error), liveTrading: false, privateApi: false, orderAuthority: false }, null, 2));
  process.exitCode = 1;
}
