#!/usr/bin/env node

import {
  FORWARD_NATURAL_SAMPLE,
  PUBLIC_LIQUIDITY_CALIBRATION_READINESS,
  PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
  collectBitgetForwardLiquidityObservationBatch,
  persistLiquidityCalibrationBatch,
  probeBitgetPublicCalibrationCapability,
} from '../src/public-forward-liquidity-calibration.mjs';

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`ARGUMENT_INVALID:${token}`);
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next == null || next.startsWith('--')) parsed[key] = true;
    else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function delays(value) {
  if (value == null) return [1_000, 5_000];
  const parsed = String(value).split(',').map((item) => Number(item.trim()));
  if (!parsed.length || parsed.some((item) => !Number.isFinite(item) || item < 0)) {
    throw new Error('POST_OBSERVATION_DELAYS_INVALID');
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const symbol = String(args.symbol ?? 'BTCUSDT').trim().toUpperCase();
  const capability = await probeBitgetPublicCalibrationCapability({ symbol });
  if (!capability.PUBLIC_CALIBRATION_DATA_CAPABLE) {
    process.stdout.write(`${JSON.stringify({
      ...capability,
      LIQUIDITY_CALIBRATION_DATA_COLLECTOR_READY: false,
      LIQUIDITY_IMPACT_STATUS: 'BLOCKED_DATA',
      FULL_COST_READY: false,
    })}\n`);
    process.exitCode = 2;
    return;
  }
  if (args['capability-only'] === true) {
    process.stdout.write(`${JSON.stringify({ ...capability, privateRequests: 0, realOrders: 0 })}\n`);
    return;
  }
  if (!args['state-root']) throw new Error('BLOCKED_STORAGE');
  const batch = await collectBitgetForwardLiquidityObservationBatch({
    symbol,
    collectorCodeSha: args['collector-sha'],
    sampleClass: args['sample-class'] ?? FORWARD_NATURAL_SAMPLE,
    eventObservationDelayMs: args['event-window-ms'] == null ? 2_000 : Number(args['event-window-ms']),
    postObservationDelaysMs: delays(args['post-delays-ms']),
  });
  const persisted = await persistLiquidityCalibrationBatch({
    stateRoot: args['state-root'],
    storeContract: PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
    batch,
  });
  process.stdout.write(`${JSON.stringify({
    PUBLIC_CALIBRATION_DATA_CAPABLE: true,
    ...PUBLIC_LIQUIDITY_CALIBRATION_READINESS,
    sampleClass: batch.sampleClass,
    observed: batch.observations.length,
    dropped: batch.droppedEvents.length,
    inserted: persisted.insertedObservationCount,
    duplicates: persisted.duplicateObservationCount,
    datasetDigest: persisted.dataset.datasetDigest,
    rawDigest: persisted.dataset.datasetProvenance.rawDigest,
    normalizedDigest: persisted.dataset.datasetProvenance.normalizedDigest,
    durableStoreReused: persisted.durableStoreReused,
    storeContract: persisted.storeContract,
    privateRequests: 0,
    realOrders: 0,
  })}\n`);
}

main().catch((error) => {
  const message = String(error?.message ?? 'PUBLIC_LIQUIDITY_CALIBRATION_FAILED');
  process.stderr.write(`${JSON.stringify({
    status: message === 'BLOCKED_STORAGE' ? 'BLOCKED_STORAGE' : 'BLOCKED_DATA',
    reason: message,
    LIQUIDITY_CALIBRATION_DATA_COLLECTOR_READY: false,
    LIQUIDITY_IMPACT_PRESENT: false,
    CALIBRATION_SAMPLE_SUFFICIENT: false,
    LIQUIDITY_IMPACT_STATUS: 'BLOCKED_DATA',
    FULL_COST_READY: false,
    privateRequests: 0,
    realOrders: 0,
  })}\n`);
  process.exitCode = 2;
});
