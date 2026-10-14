#!/usr/bin/env node
import { resolve } from 'node:path';

import { runAutonomousResearchCycleV2 } from '../src/autonomous-research-cycle-v2.mjs';
import { runResearchAiReviewScan } from '../src/research-ai-review-worker.mjs';

function parse(argv) {
  const options = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${token}`);
    options[token.slice(2)] = value;
    index += 1;
  }
  return options;
}

function safeError(error) {
  return String(error?.message ?? error ?? 'FAILED_CLOSED').trim().slice(0, 240);
}

const options = parse(process.argv);
const stateRoot = resolve(options['state-root'] ?? process.env.RESEARCH_STATE_ROOT ?? '/var/lib/investment-research-production');
const researchCodeSha = options['research-sha'] ?? process.env.RESEARCH_CODE_SHA ?? process.env.GITHUB_SHA ?? '';
const repoRoot = resolve(options['repo-root'] ?? process.env.RESEARCH_REPO_ROOT ?? process.cwd());
const maximumStrategiesPerCycle = Number(options['maximum-strategies'] ?? process.env.RESEARCH_AUTONOMOUS_MAX_STRATEGIES_PER_CYCLE ?? 4);
const maxReviewCalls = Number(options['max-review-calls'] ?? process.env.RESEARCH_AI_MAX_CALLS_PER_SCAN ?? 3);

let cycle = null;
let cycleError = null;
let review = null;
let reviewError = null;

try {
  cycle = await runAutonomousResearchCycleV2({ stateRoot, researchCodeSha, maximumStrategiesPerCycle });
} catch (error) {
  cycleError = safeError(error);
}

// Always execute the pre-existing bounded review worker, even when the new
// discovery cycle is waiting or unavailable. One lane must not hide or skip
// the status of the other, and the coordinator returns a combined exit code.
try {
  review = await runResearchAiReviewScan({ repoRoot, stateRoot, researchSha: researchCodeSha, maxCalls: maxReviewCalls });
} catch (error) {
  reviewError = safeError(error);
}

const failed = cycleError != null || reviewError != null;
const unavailable = ['PARTIAL_AI_DISCOVERY_UNAVAILABLE', 'WAITING_FREE_AI_CONFIGURATION'].includes(cycle?.status)
  || ['PARTIAL_AI_UNAVAILABLE', 'WAITING_FOR_FREE_AI', 'DEFERRED_RETRY'].includes(review?.status);
const result = Object.freeze({
  schemaVersion: 2,
  contract: 'autonomous-research-coordinator/v2',
  status: failed ? 'FAILED_CLOSED' : unavailable ? 'WAITING_OR_PARTIAL_AI' : 'COMPLETE',
  researchCodeSha,
  cycleStatus: cycle?.status ?? null,
  reviewStatus: review?.status ?? null,
  cycleError,
  reviewError,
  actualDiscoveryProviderCalls: cycle?.actualProviderCalls ?? { attempted: 0, succeeded: 0, failed: 0 },
  actualReviewProviderCalls: Number(review?.providerNetworkCalls ?? 0),
  liveTrading: false,
  privateTradingApi: false,
  realOrder: false,
  executionAuthority: 'NONE',
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = failed ? 1 : unavailable ? 75 : 0;
