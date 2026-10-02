#!/usr/bin/env node
import { resolve } from 'node:path';

import {
  preflightResearchVideoDiscovery,
  runResearchVideoDiscoveryScan,
} from '../src/research-video-discovery-worker.mjs';

function parse(argv) {
  const command = argv[2] ?? 'preflight';
  const options = {};
  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    options[key] = value;
    index += 1;
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
  let result;
  if (command === 'preflight') result = await preflightResearchVideoDiscovery(config);
  else if (command === 'run') result = await runResearchVideoDiscoveryScan(config);
  else throw new Error(`unsupported command: ${command}`);
  console.log(JSON.stringify(result, null, 2));
  if (command === 'run' && result.status === 'BLOCKED') process.exitCode = 2;
  if (command === 'run' && result.status === 'WAITING_CONFIGURATION') process.exitCode = 3;
} catch (error) {
  console.error(JSON.stringify({
    status: 'failed_closed',
    error: String(error?.message ?? error).slice(0, 200),
    economicEvidenceCredit: 0,
    profitabilityCredit: 0,
    executionAuthority: 'NONE',
    liveTrading: false,
    privateTradingApiAllowed: false,
    realOrderEnabled: false,
  }, null, 2));
  process.exitCode = 1;
}
