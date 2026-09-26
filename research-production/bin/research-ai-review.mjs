#!/usr/bin/env node
import { resolve } from 'node:path';

import { preflightResearchAiReview, runResearchAiReviewScan } from '../src/research-ai-review-worker.mjs';

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
    maxCalls: Number(options['max-calls'] ?? process.env.RESEARCH_AI_MAX_CALLS_PER_SCAN ?? 3),
  };
}

try {
  const { command, options } = parse(process.argv);
  const config = settings(options);
  if (command === 'preflight') {
    const result = await preflightResearchAiReview(config);
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'run') {
    const result = await runResearchAiReviewScan(config);
    console.log(JSON.stringify(result, null, 2));
  } else {
    throw new Error(`unsupported command: ${command}`);
  }
} catch (error) {
  console.error(JSON.stringify({
    status: 'failed_closed',
    error: String(error?.message ?? error).slice(0, 300),
    evidenceCredit: 0,
    profitabilityProven: false,
    executionAuthority: 'NONE',
    liveTrading: false,
    privateTradingApiAllowed: false,
    orderAllowed: false,
  }, null, 2));
  process.exitCode = 1;
}
