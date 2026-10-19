#!/usr/bin/env node
import { resolve } from 'node:path';

import { runAutonomousResearchCycleV2, writeCoordinatorOutcomeV2 } from '../src/autonomous-research-cycle-v2.mjs';
import { runCombinationSearchLaneV1 } from '../src/combination-search-lane-v1.mjs';
import { buildCombinationSignalEvidenceV1, writeCombinationSignalEvidenceV1 } from '../src/combination-signal-evidence-v1.mjs';
import { runExitStrategyComparisonV1 } from '../src/exit-strategy-comparison-v1.mjs';
import { runExploratoryPaperLedgerV1 } from '../src/exploratory-paper-ledger-v1.mjs';
import { runGridDcaResearchV1 } from '../src/grid-dca-research-v1.mjs';
import { runOpsWatchdogV1 } from '../src/ops-watchdog-v1.mjs';
import { runResearchResultsDigestV1 } from '../src/research-results-digest-v1.mjs';
import { runPaperDiscoveryV1 } from '../src/paper-discovery-v1.mjs';
import {
  combinationUniverseFromSnapshotV2,
  readResearchUniverseSnapshotV2,
  refreshResearchUniverseV2,
  watchUniverseFromSnapshotV2,
} from '../src/research-universe-v2.mjs';
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

const enabled = (name) => String(process.env[name] ?? 'true').trim().toLowerCase() !== 'false';
const remainingMs = () => TOTAL_BUDGET_MS - (Date.now() - startedMs);

// Full-market universe (V2): frozen liquid sets where complete, V1 otherwise.
let snapshot = { sources: {} };
let snapshotError = null;
try { if (enabled('RESEARCH_UNIVERSE_V2_ENABLED')) snapshot = await readResearchUniverseSnapshotV2(stateRoot); }
catch (error) { snapshotError = safeError(error); }
const researchUniverse = combinationUniverseFromSnapshotV2(snapshot);

// Deterministic, no-AI combination research. Its failure is reported but does
// not change the AI lane exit code (activation proofs depend on that code).
let combination = null;
let combinationError = null;
try {
  // Later stages (exit comparison, paper ledger, universe, watchdog) need ~3 min.
  const remaining = remainingMs() - 180_000;
  const budgetMs = Math.max(20_000, Math.min(remaining, 240_000));
  combination = await runCombinationSearchLaneV1({ stateRoot, researchCodeSha, budgetMs, universe: researchUniverse });
} catch (error) {
  combinationError = safeError(error);
}

// Read-only evidence for the Signal V3 scanner: only holdout-passed survivors.
let signalEvidence = null;
let signalEvidenceError = null;
try {
  signalEvidence = await buildCombinationSignalEvidenceV1({ stateRoot, researchCodeSha, observedAt: new Date().toISOString() });
  await writeCombinationSignalEvidenceV1(stateRoot, signalEvidence);
} catch (error) {
  signalEvidenceError = safeError(error);
}

// Deterministic exit-strategy comparison on the cached coin datasets. Lanes
// recompute only when code or data changed (or weekly); failure never changes
// the exit code.
let exitComparison = null;
let exitComparisonError = null;
try {
  // Leave room for the paper ledger, universe probes and the watchdog.
  const remaining = remainingMs() - 150_000;
  if (remaining >= 30_000) {
    exitComparison = await runExitStrategyComparisonV1({ stateRoot, researchCodeSha, budgetMs: Math.min(remaining, 120_000) });
  } else {
    exitComparisonError = 'SKIPPED_NO_BUDGET';
  }
} catch (error) {
  exitComparisonError = safeError(error);
}

// Exploratory forward paper ledger (EXPLORATORY lane, paper only).
let exploratory = null;
let exploratoryError = null;
if (enabled('RESEARCH_EXPLORATORY_PAPER_ENABLED')) {
  try {
    exploratory = await runExploratoryPaperLedgerV1({ stateRoot, universe: researchUniverse, watchUniverse: watchUniverseFromSnapshotV2(snapshot),
      budgetMs: Math.max(15_000, Math.min(remainingMs() - 60_000, 90_000)) });
  } catch (error) { exploratoryError = safeError(error); }
}

// Liquidity probes for the next universe snapshot (bounded).
let universe = null;
let universeError = snapshotError;
if (enabled('RESEARCH_UNIVERSE_V2_ENABLED') && remainingMs() > 50_000) {
  try { universe = await refreshResearchUniverseV2({ stateRoot, maximumProbes: 15, budgetMs: Math.min(remainingMs() - 40_000, 60_000) }); }
  catch (error) { universeError = safeError(error); }
}

let papers = null;
let papersError = null;
if (enabled('RESEARCH_PAPER_DISCOVERY_ENABLED') && remainingMs() > 30_000) {
  try { papers = await runPaperDiscoveryV1({ stateRoot }); } catch (error) { papersError = safeError(error); }
}

let gridDca = null;
let gridDcaError = null;
if (remainingMs() > 20_000) {
  try { gridDca = await runGridDcaResearchV1({ stateRoot }); } catch (error) { gridDcaError = safeError(error); }
}

// Watchdog last, so this tick's own outputs count as fresh.
let watchdog = null;
let watchdogError = null;
try { watchdog = await runOpsWatchdogV1({ stateRoot, invoker: 'coordinator' }); } catch (error) { watchdogError = safeError(error); }

// Korean results digest on the ops Telegram channel (daily + new milestones).
let digest = null;
let digestError = null;
if (enabled('RESEARCH_RESULTS_DIGEST_ENABLED')) {
  try { digest = await runResearchResultsDigestV1({ stateRoot }); } catch (error) { digestError = safeError(error); }
}

const failed = cycleError != null || reviewError != null;
const unavailable = ['PARTIAL_AI_DISCOVERY_UNAVAILABLE', 'WAITING_FREE_AI_CONFIGURATION', 'DEFERRED_DURABLE_STATE_BUSY'].includes(cycle?.status)
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
  exitComparison: exitComparison == null ? { error: exitComparisonError } : {
    lanes: exitComparison.lanes.map((lane) => ({ laneId: lane.laneId, status: lane.status, computedAt: lane.computedAt ?? null })),
  },
  scannerEvidence: signalEvidence == null ? { error: signalEvidenceError } : { rules: signalEvidence.rules.length },
  exploratoryPaper: exploratory == null ? { error: exploratoryError, enabled: enabled('RESEARCH_EXPLORATORY_PAPER_ENABLED') }
    : { trades: exploratory.totals.trades, closed: exploratory.totals.closed, rules: exploratory.rules.length,
      promotionEligibleRules: exploratory.totals.promotionEligibleRules, lane: exploratory.lane },
  universeV2: universe == null ? { error: universeError, frozen: Object.keys(snapshot.sources ?? {}) }
    : { log: universe.log, frozen: universe.frozenSources },
  paperDiscovery: papers == null ? { error: papersError } : { status: papers.status, added: papers.added ?? 0, pendingApproval: papers.pendingApproval ?? null },
  gridDca: gridDca == null ? { error: gridDcaError } : { status: gridDca.status ?? 'RAN' },
  opsWatchdog: watchdog == null ? { error: watchdogError } : { healthy: watchdog.healthy, problems: watchdog.problems, alertChannel: watchdog.alertChannel, delivery: watchdog.delivery },
  resultsDigest: digest == null ? { error: digestError, enabled: enabled('RESEARCH_RESULTS_DIGEST_ENABLED') } : { kind: digest.kind, newMilestones: digest.newMilestones, delivery: digest.delivery },
  liveTrading: false,
  privateTradingApi: false,
  realOrder: false,
  executionAuthority: 'NONE',
});
// The systemd exit code is not visible to the watchdog (it runs inside this
// process); persist the outcome so the next tick can tell FAILED from waiting.
try {
  await writeCoordinatorOutcomeV2(stateRoot, {
    observedAt: new Date().toISOString(), researchCodeSha, status: result.status, exitCode: failed ? 1 : unavailable ? 75 : 0,
    cycleStatus: result.cycleStatus, reviewStatus: result.reviewStatus,
    cycleError: result.cycleError, reviewError: result.reviewError,
    discoveryRetryAfterAt: cycle?.retryAfterAt ?? null,
  });
} catch (error) {
  process.stderr.write(`${JSON.stringify({ coordinatorOutcomeWriteError: safeError(error) })}\n`);
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = failed ? 1 : unavailable ? 75 : 0;
