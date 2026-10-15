#!/usr/bin/env node
import { resolve } from 'node:path';

import { runAutonomousResearchCycleV2 } from '../src/autonomous-research-cycle-v2.mjs';
import { runCombinationSearchLaneV1 } from '../src/combination-search-lane-v1.mjs';
import {
  aiIntervalMinutesV1,
  decideFreeAiRunV1,
  isRateLimitedV1,
  readFreeAiQuotaGateV1,
  recordFreeAiOutcomeV1,
  writeFreeAiQuotaGateV1,
} from '../src/free-ai-quota-gate-v1.mjs';
import { resolveResearchFreeAiPolicy, runResearchAiReviewScan } from '../src/research-ai-review-worker.mjs';

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

// The service runs every 10 minutes (TimeoutStartSec=8m). Free AI work is
// gated to its own interval and quota pause; the deterministic combination
// search uses the remaining wall-clock budget on every tick.
const startedMs = Date.now();
const TOTAL_BUDGET_MS = 7 * 60_000;
let gate = null;
let gateError = null;
try { gate = await readFreeAiQuotaGateV1(stateRoot); } catch (error) { gateError = safeError(error); }
const aiDecision = decideFreeAiRunV1({ gate, nowMs: startedMs, researchCodeSha, intervalMinutes: aiIntervalMinutesV1(process.env) });

let cycle = null;
let cycleError = null;
let review = null;
let reviewError = null;

if (aiDecision.run) {
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

  try {
    const provider = resolveResearchFreeAiPolicy(process.env)?.provider ?? null;
    gate = recordFreeAiOutcomeV1({ gate, nowMs: startedMs, researchCodeSha, provider,
      rateLimited: isRateLimitedV1({ cycle, review, cycleError, reviewError }) });
    await writeFreeAiQuotaGateV1(stateRoot, gate);
  } catch (error) {
    gateError = safeError(error);
  }
}

// Deterministic, no-AI combination research. Its failure is reported but does
// not change the AI lane exit code (activation proofs depend on that code).
let combination = null;
let combinationError = null;
try {
  const remaining = TOTAL_BUDGET_MS - (Date.now() - startedMs) - 30_000;
  const budgetMs = Math.max(20_000, Math.min(remaining, 270_000));
  combination = await runCombinationSearchLaneV1({ stateRoot, researchCodeSha, budgetMs });
} catch (error) {
  combinationError = safeError(error);
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
  freeAi: {
    ran: aiDecision.run,
    decision: aiDecision.reason,
    nextAiAt: new Date(aiDecision.run ? Date.now() : aiDecision.nextAiAt).toISOString(),
    pausedUntil: gate?.pausedUntilIso ?? null,
    pauseReason: gate?.pauseReason ?? null,
    gateError,
  },
  combinationSearch: combination == null ? { error: combinationError } : {
    evaluatedThisTick: combination.evaluatedThisTick,
    elapsedMs: combination.elapsedMs,
    lanes: combination.lanes.map((lane) => ({ laneId: lane.laneId, status: lane.status,
      trialsEvaluated: lane.trialsEvaluated ?? 0, survivors: lane.survivors ?? 0, watch: lane.watch ?? 0 })),
    aiProviderCalls: 0,
  },
  liveTrading: false,
  privateTradingApi: false,
  realOrder: false,
  executionAuthority: 'NONE',
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = failed ? 1 : unavailable ? 75 : 0;
