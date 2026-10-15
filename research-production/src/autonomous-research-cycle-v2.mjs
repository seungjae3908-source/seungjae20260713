import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  loadAutonomousResearchNextDirectiveV1,
  rebindAutonomousResearchNextDirectiveV1,
  runAutonomousResearchClosedLoopV1,
} from './autonomous-research-closed-loop-v1.mjs';
import { runAutonomousResearchDiscoveryV2 } from './autonomous-research-discovery-v2.mjs';
import { runMarketShockReverseLaneV1 } from './market-shock-reverse-lane-v1.mjs';
import { runPublicProviderResearchLaneV1 } from './public-provider-research-lane-v1.mjs';

export const AUTONOMOUS_RESEARCH_CYCLE_CONTRACT_V2 = 'autonomous-research-cycle/v2';

const SAFETY = Object.freeze({
  researchOnly: true,
  paidFallbackAllowed: false,
  paperActivationAllowed: false,
  liveTrading: false,
  autoTrading: false,
  privateTradingApi: false,
  realOrder: false,
  executionAuthority: 'NONE',
});

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

function cycleStatus(discovery) {
  if (discovery.status === 'WAITING_FREE_AI_CONFIGURATION') return 'WAITING_FREE_AI_CONFIGURATION';
  if (discovery.status === 'AI_DISCOVERY_UNAVAILABLE' || discovery.status === 'DEFERRED_RETRY') return 'PARTIAL_AI_DISCOVERY_UNAVAILABLE';
  if (discovery.status === 'WAITING_DIRECTIVE') return 'WAITING_DIRECTIVE';
  return 'COMPLETE';
}

export async function runAutonomousResearchCycleV2({
  stateRoot,
  researchCodeSha,
  maximumStrategiesPerCycle = 4,
  now = () => new Date().toISOString(),
  env = process.env,
  processQueue,
  invoke,
  fetchImpl,
  datasetLoader,
  runLoop = runAutonomousResearchClosedLoopV1,
  runDiscovery = runAutonomousResearchDiscoveryV2,
  runShockLane = runMarketShockReverseLaneV1,
  runProviderLane = runPublicProviderResearchLaneV1,
  verifiedSourceCatalog,
  researchLanes,
} = {}) {
  const observedAt = now();
  const loopOptions = { stateRoot, researchCodeSha, maximumStrategiesPerCycle, now: () => observedAt };
  if (processQueue) loopOptions.processQueue = processQueue;
  // Consume a persisted next-directive before producing another one. Rebuilding
  // it first changes the digest and can silently discard failure-memory intent,
  // especially during an exact-SHA isolated cutover validation.
  const persistedDirective = await loadAutonomousResearchNextDirectiveV1({ stateRoot });
  let pendingDirective = persistedDirective;
  if (persistedDirective != null && persistedDirective.researchCodeSha !== researchCodeSha) {
    const sharedRoot = resolve(stateRoot);
    await atomicJson(join(sharedRoot, 'autonomous-research', 'releases', persistedDirective.researchCodeSha,
      'directives', `${persistedDirective.directiveDigest}.json`), persistedDirective);
    pendingDirective = rebindAutonomousResearchNextDirectiveV1({
      directive: persistedDirective,
      researchCodeSha,
      observedAt,
    });
    await atomicJson(join(sharedRoot, 'autonomous-research', 'releases', researchCodeSha,
      'directives', `${pendingDirective.directiveDigest}.json`), pendingDirective);
    await atomicJson(join(sharedRoot, 'latest', 'autonomous-research-next-directive.json'), pendingDirective);
  }
  const before = pendingDirective == null ? await runLoop(loopOptions) : null;
  const discoveryOptions = { stateRoot, researchCodeSha, env, now: () => observedAt };
  if (invoke) discoveryOptions.invoke = invoke;
  if (fetchImpl) discoveryOptions.fetchImpl = fetchImpl;
  if (datasetLoader) discoveryOptions.datasetLoader = datasetLoader;
  if (verifiedSourceCatalog) discoveryOptions.verifiedSourceCatalog = verifiedSourceCatalog;
  if (researchLanes) discoveryOptions.researchLanes = researchLanes;
  const [discovery, shockLane, providerLane] = await Promise.all([
    runDiscovery(discoveryOptions),
    runShockLane({ stateRoot, researchCodeSha, now: () => observedAt, fetchImpl }),
    runProviderLane({ stateRoot, researchCodeSha, now: () => observedAt, fetchImpl }),
  ]);
  const shouldRunAgain = ['DOSSIER_STAGED', 'ALREADY_DISCOVERED'].includes(discovery.status);
  const after = shouldRunAgain ? await runLoop(loopOptions) : before;
  const summary = after ?? Object.freeze({
    discoveredStrategyCount: 0,
    completedStrategyCount: Number(pendingDirective?.completedDossierCount ?? 0),
    formulaGeneratedCount: 0,
    actualBacktestCount: 0,
    paperRegisteredCount: 0,
    actualPaperEntryCount: 0,
    actualPaperExitCount: 0,
    failureObservationCount: 0,
    dispositions: Object.freeze({ BACKTEST_CANDIDATE: 0, IMPROVE: 0, REJECT: 0 }),
    continueResearch: true,
    waitingForFuturePaperSignalBlocksResearch: false,
  });
  const result = Object.freeze({
    schemaVersion: 2,
    contract: AUTONOMOUS_RESEARCH_CYCLE_CONTRACT_V2,
    status: cycleStatus(discovery),
    observedAt,
    researchCodeSha,
    directiveConsumed: discovery.directiveConsumed === true,
    discoveryStatus: discovery.status,
    actualProviderCalls: discovery.actualProviderCalls,
    actualSourceFetches: discovery.actualSourceFetches,
    selectedNextStrategy: discovery.candidate,
    stagedDossierDigest: discovery.stagedDossierDigest,
    discoveredStrategyCount: summary.discoveredStrategyCount,
    completedStrategyCount: summary.completedStrategyCount,
    formulaGeneratedCount: summary.formulaGeneratedCount,
    actualBacktestCount: summary.actualBacktestCount,
    paperRegisteredCount: summary.paperRegisteredCount,
    actualPaperEntryCount: summary.actualPaperEntryCount,
    actualPaperExitCount: summary.actualPaperExitCount,
    failureObservationCount: summary.failureObservationCount,
    dispositions: summary.dispositions,
    continuousResearch: summary.continueResearch === true && summary.waitingForFuturePaperSignalBlocksResearch === false,
    nextAction: discovery.nextAction,
    reason: discovery.reason,
    retryAfterAt: discovery.retryAfterAt,
    researchLanes: Object.freeze({
      publicStrategyDiscovery: discovery.status,
      marketShockReverseStudy: shockLane.status,
      providerTechnicalResearch: providerLane.status,
      parallelExecution: true,
    }),
    marketShockResearch: Object.freeze({
      actualPublicRequests: shockLane.actualPublicRequestsThisRun,
      studyCount: shockLane.studyCount,
      eventCount: shockLane.eventCount,
      researchHypothesisCount: shockLane.researchHypothesisCount,
      oosSupportedHypothesisCount: shockLane.oosSupportedHypothesisCount,
      formulaCandidateCount: shockLane.formulaCandidateCount,
      backtestCount: shockLane.backtestCount,
      nextAction: shockLane.nextAction,
    }),
    providerTechnicalResearch: Object.freeze({
      actualPublicRequests: providerLane.actualPublicRequestsThisRun,
      probedProviderCount: providerLane.probedProviderCount,
      verifiedProviderCount: providerLane.verifiedProviderCount,
      categoryCounts: providerLane.categoryCounts,
      nextAction: providerLane.nextAction,
    }),
    runtimeActivated: false,
    safety: SAFETY,
  });
  await atomicJson(join(resolve(stateRoot), 'latest', 'autonomous-research-cycle-v2.json'), result);
  return result;
}
