#!/usr/bin/env node
import { resolve } from 'node:path';
import { buildMicrocapResearchTaskPlan, preflightMicrocapResearchTask, runMicrocapResearchTask } from '../src/microcap-task.mjs';

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
  return {
    repoRoot: resolve(options['repo-root'] ?? process.env.RESEARCH_REPO_ROOT ?? process.cwd()),
    stateRoot: resolve(options['state-root'] ?? process.env.RESEARCH_STATE_ROOT ?? '/var/lib/investment-research-production'),
    researchSha: options['research-sha'] ?? process.env.RESEARCH_CODE_SHA ?? process.env.GITHUB_SHA ?? '',
  };
}

try {
  const { command, options } = parse(process.argv);
  const config = settings(options);
  if (command === 'plan') {
    console.log(JSON.stringify(buildMicrocapResearchTaskPlan(config), null, 2));
  } else if (command === 'preflight') {
    console.log(JSON.stringify(await preflightMicrocapResearchTask(config), null, 2));
  } else if (command === 'run') {
    console.log(JSON.stringify(await runMicrocapResearchTask(config), null, 2));
  } else {
    throw new Error(`unsupported command: ${command}`);
  }
} catch (error) {
  console.error(JSON.stringify({
    status: 'failed_closed',
    error: String(error?.message ?? error),
    canonicalSampleDelta: 0,
    liveTrading: false,
    privateApi: false,
    orderAuthority: false,
  }, null, 2));
  process.exitCode = 1;
}
