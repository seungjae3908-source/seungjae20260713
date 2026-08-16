#!/usr/bin/env node
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { assertResearchSafety, buildTaskPlan, preflightResearchProduction, runResearchCycle } from '../src/engine.mjs';
import { buildHistoricalPipelinePlan, preflightHistoricalPipelines, runHistoricalPipelines } from '../src/historical-pipelines.mjs';

function parse(argv) {
  const command = argv[2] ?? 'plan'; const options = {};
  for (let i = 3; i < argv.length; i += 1) { const token = argv[i]; if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`); const key = token.slice(2); const value = argv[i + 1]; if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`); options[key] = value; i += 1; }
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

function legacyRows(profile, config) {
  return buildTaskPlan({ profile, stateRoot: config.stateRoot, researchSha: config.researchSha }).map((task) => ({ id: task.id, kind: task.kind ?? 'historical', stepCount: 1, steps: [{ id: task.id, args: task.args, timeoutMs: task.timeoutMs }] }));
}

function planRows(config) {
  const historical = buildHistoricalPipelinePlan().map((task) => ({ ...task, kind: 'historical' }));
  if (config.profile === 'fast-historical') return historical;
  if (config.profile === 'long-history' || config.profile === 'forward') return legacyRows(config.profile, config);
  if (config.profile === 'all') return [...historical, ...legacyRows('long-history', config), ...legacyRows('forward', config)];
  throw new Error(`unknown research profile: ${config.profile}`);
}

try {
  const { command, options } = parse(process.argv); const config = settings(options);
  if (command === 'plan') {
    assertResearchSafety({ stateRoot: config.stateRoot, repoRoot: config.repoRoot });
    const tasks = planRows(config); const stepCount = tasks.reduce((sum, task) => sum + task.stepCount, 0);
    console.log(JSON.stringify({ status: 'planned', profile: config.profile, researchSha: config.researchSha, taskCount: tasks.length, stepCount, tasks, liveTrading: false, privateApi: false, orderAuthority: false }, null, 2));
  } else if (command === 'preflight') {
    const base = await preflightResearchProduction(config);
    const historical = ['fast-historical', 'all'].includes(config.profile) ? await preflightHistoricalPipelines({ ...config, basePreflight: base }) : null;
    console.log(JSON.stringify({ ...base, historical: historical?.historical ?? null }, null, 2));
  } else if (command === 'run') {
    if (config.profile === 'all') throw new Error('run profile=all is intentionally disabled; run fast-historical, long-history and forward independently');
    const result = config.profile === 'fast-historical' ? await runHistoricalPipelines(config) : await runResearchCycle(config);
    console.log(JSON.stringify(result, null, 2)); if (result.status === 'partial_failure') process.exitCode = 1;
  } else throw new Error(`unsupported command: ${command}`);
} catch (error) {
  console.error(JSON.stringify({ status: 'failed_closed', error: String(error?.message ?? error), liveTrading: false, privateApi: false, orderAuthority: false }, null, 2)); process.exitCode = 1;
}
