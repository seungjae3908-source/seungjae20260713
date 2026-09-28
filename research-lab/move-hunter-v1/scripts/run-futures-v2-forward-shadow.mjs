import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BitgetPublicClient } from '../../../market-prediction-lab/src/bitget-public-client.js';
import { collectBitgetCandles } from '../../../market-prediction-lab/src/bitget-candle-collector.js';
import {
  FUTURES_V2_COST_RISK_DECLARATION_V1,
} from '../src/futures-v2-cost-risk-preregistration.mjs';
import {
  consumeFuturesV2ForwardState,
} from '../src/futures-v2-forward-state-consumer.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function argument(name) {
  const prefix = '--' + name + '=';
  const direct = process.argv.find((item) => item.startsWith(prefix));
  if (direct) return direct.slice(prefix.length).trim();
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() : null;
}
function requiredArgument(name) {
  const value = argument(name);
  if (!value) throw new Error('MOVE_HUNTER_' + name.toUpperCase().replaceAll('-', '_') + '_REQUIRED');
  return value;
}
function finiteArg(name) {
  const value = Number(requiredArgument(name));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('MOVE_HUNTER_' + name.toUpperCase().replaceAll('-', '_') + '_INVALID');
  }
  return value;
}
function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}
function stableJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

const stateInput = path.resolve(requiredArgument('state-input'));
const outputDir = path.resolve(requiredArgument('output-dir'));
const sourceObserverRunId = requiredArgument('observer-run-id');
if (!/^\d+$/u.test(sourceObserverRunId)) throw new Error('OBSERVER_RUN_ID_INVALID');

const costModel = Object.freeze({
  modelId: requiredArgument('cost-model-id'),
  feeBps: finiteArg('fee-bps'),
  slippageBps: finiteArg('slippage-bps'),
  spreadBps: finiteArg('spread-bps'),
  canonicalFullCostProven: false,
});

const stateBytes = await readFile(stateInput);
const state = JSON.parse(stateBytes.toString('utf8'));
const freezeMs = Date.parse(FUTURES_V2_COST_RISK_DECLARATION_V1.freezeBoundary.preregisteredAt);
if (!Number.isFinite(freezeMs)) throw new Error('FUTURES_V2_COST_RISK_FREEZE_INVALID');
const startTime = freezeMs - 30 * DAY_MS;
const endTime = Date.now();
const client = new BitgetPublicClient({
  timeoutMs: 20_000,
  maxRetries: 4,
  minIntervalMs: 140,
});

const result = await consumeFuturesV2ForwardState({
  state,
  costModel,
  loadCandles: async ({ symbol }) => {
    const history = await collectBitgetCandles({
      client,
      market: 'CRYPTO_FUTURES',
      symbol,
      timeframe: '1h',
      startTime,
      endTime,
      productType: 'usdt-futures',
      maxCandles: 2000,
    });
    return history.candles;
  },
  maxHistoryBars: 300,
});

await mkdir(outputDir, { recursive: true });
const recordsText = stableJson(result.records);
const summaryText = stableJson(result.summary);
await writeFile(path.join(outputDir, 'records.json'), recordsText, 'utf8');
await writeFile(path.join(outputDir, 'summary.json'), summaryText, 'utf8');

const manifest = Object.freeze({
  schemaVersion: 1,
  kind: 'move-hunter-futures-v2-forward-shadow',
  sourceObserverRunId: Number(sourceObserverRunId),
  sourceObserverResearchCodeSha: state.researchCodeSha ?? null,
  sourceStateSha256: sha256(stateBytes),
  recordsSha256: sha256(recordsText),
  summarySha256: sha256(summaryText),
  freezeBoundary: result.freezeBoundary ?? FUTURES_V2_COST_RISK_DECLARATION_V1.freezeBoundary.preregisteredAt,
  sourceObservationCount: result.sourceObservationCount ?? 0,
  candidateObservationCount: result.candidateObservationCount ?? 0,
  costModel,
  sourceStateMutated: false,
  canonicalStateWriteAllowed: false,
  publicDataOnly: true,
  artifactOnly: true,
  historicalBackfillAllowed: false,
  observedHistoryMayCountAsOos: false,
  observedHistoryMayCountAsForward: false,
  performanceWinner: null,
  winnerSelectionAllowed: false,
  automaticScannerAdoptionAllowed: false,
  automaticPromotionAllowed: false,
  positionSizeOrLeverageOverrideAllowed: false,
  economicSampleCredit: 0,
  profitabilityClaimAllowed: false,
  executionAuthority: 'NONE',
});
await writeFile(path.join(outputDir, 'manifest.json'), stableJson(manifest), 'utf8');

console.log(JSON.stringify({
  ok: true,
  status: result.status,
  sourceObserverRunId: manifest.sourceObserverRunId,
  freezeBoundary: manifest.freezeBoundary,
  sourceObservationCount: manifest.sourceObservationCount,
  candidateObservationCount: manifest.candidateObservationCount,
  acceptedN: result.summary?.acceptedN ?? 0,
  settledN: result.summary?.settledN ?? 0,
  pendingN: result.summary?.pendingN ?? 0,
  blockedN: result.summary?.blockedN ?? 0,
  costRisk: result.summary?.costRisk ?? null,
  performanceWinner: null,
  safety: {
    sourceStateMutated: false,
    canonicalStateWriteAllowed: false,
    publicDataOnly: true,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    executionAuthority: 'NONE',
  },
}, null, 2));
