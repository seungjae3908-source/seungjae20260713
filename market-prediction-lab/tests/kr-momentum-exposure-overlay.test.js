import test from "node:test";
import assert from "node:assert/strict";
import {
  optimizeKrMomentumExposureOverlay,
  simulateKrMomentumExposureOverlay,
} from "../src/kr-momentum-exposure-overlay.js";
import {
  KR_MOMENTUM_SIGNAL_CANDIDATE,
  KR_MOMENTUM_SIGNAL_CANDIDATE_SHA256,
} from "../src/kr-momentum-risk-overlay-candidate.js";

const DAY = 24 * 60 * 60 * 1000;

function dataset(symbol, drift, count = 900) {
  const candles = [];
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const cycle = Math.sin(index / 23) * 0.45 + Math.sin(index / 71) * 0.25;
    const open = close;
    close = Math.max(10, open * (1 + drift + cycle / 100));
    candles.push({
      timestamp: Date.UTC(2020, 0, 1) + index * DAY,
      open,
      high: Math.max(open, close) * 1.006,
      low: Math.min(open, close) * 0.994,
      close,
      volume: 1_000_000 + index * 100,
    });
  }
  return { symbol, candles };
}

function makeRegistered(symbols, baseDrift = 0.0005) {
  return symbols.map((symbol, index) => dataset(symbol, baseDrift + (symbols.length - index) * 0.00008));
}

test("risk overlay manifest freezes the signal and preregisters a fresh universe", () => {
  assert.equal(KR_MOMENTUM_SIGNAL_CANDIDATE.sourceStatus, "research_hold");
  assert.equal(KR_MOMENTUM_SIGNAL_CANDIDATE.frozenSignalParams.momentumLookback, 120);
  assert.equal(KR_MOMENTUM_SIGNAL_CANDIDATE.frozenSignalParams.trendMaPeriod, 100);
  assert.equal(KR_MOMENTUM_SIGNAL_CANDIDATE.frozenSignalParams.topCount, 2);
  assert.equal(KR_MOMENTUM_SIGNAL_CANDIDATE_SHA256.length, 64);
  const prior = new Set(KR_MOMENTUM_SIGNAL_CANDIDATE.priorResearchSymbols);
  assert.ok(KR_MOMENTUM_SIGNAL_CANDIDATE.overlayDesignSymbols.every((symbol) => !prior.has(symbol)));
  assert.ok(KR_MOMENTUM_SIGNAL_CANDIDATE.overlayHoldoutSymbols.every((symbol) => !prior.has(symbol)));
  const design = new Set(KR_MOMENTUM_SIGNAL_CANDIDATE.overlayDesignSymbols);
  assert.ok(KR_MOMENTUM_SIGNAL_CANDIDATE.overlayHoldoutSymbols.every((symbol) => !design.has(symbol)));
});

test("cash reserve changes capital exposure without retuning the frozen signal", () => {
  const datasets = makeRegistered(KR_MOMENTUM_SIGNAL_CANDIDATE.overlayDesignSymbols.slice(0, 6));
  const full = simulateKrMomentumExposureOverlay({ datasets, grossExposureFraction: 1, costRatePerSide: 0.0025 });
  const half = simulateKrMomentumExposureOverlay({ datasets, grossExposureFraction: 0.5, costRatePerSide: 0.0025 });
  assert.equal(full.candidateManifestSha256, KR_MOMENTUM_SIGNAL_CANDIDATE_SHA256);
  assert.deepEqual(full.signalParams, KR_MOMENTUM_SIGNAL_CANDIDATE.frozenSignalParams);
  assert.deepEqual(half.signalParams, KR_MOMENTUM_SIGNAL_CANDIDATE.frozenSignalParams);
  assert.ok(full.trades.length > 10);
  assert.equal(full.trades.length, half.trades.length);
  assert.ok(half.metrics.averageGrossExposure < full.metrics.averageGrossExposure);
  assert.ok(Math.abs(half.metrics.netReturn) <= Math.abs(full.metrics.netReturn) + 1e-9);
  assert.ok(half.metrics.maxDrawdown <= full.metrics.maxDrawdown + 1e-9);
  assert.equal(half.safeguards.actualOrders, 0);
});

test("optimizer searches only gross exposure and never selects on the preregistered holdout", () => {
  const designDatasets = makeRegistered(KR_MOMENTUM_SIGNAL_CANDIDATE.overlayDesignSymbols, 0.00055);
  const holdoutDatasets = makeRegistered(KR_MOMENTUM_SIGNAL_CANDIDATE.overlayHoldoutSymbols, 0.00050);
  const result = optimizeKrMomentumExposureOverlay({ designDatasets, holdoutDatasets });
  assert.equal(result.candidateManifestSha256, KR_MOMENTUM_SIGNAL_CANDIDATE_SHA256);
  assert.deepEqual(result.signalParams, KR_MOMENTUM_SIGNAL_CANDIDATE.frozenSignalParams);
  assert.equal(result.selectionContract.signalParametersRetuned, false);
  assert.equal(result.selectionContract.searchedDimension, "grossExposureFraction_only");
  assert.equal(result.selectionContract.sourceHoldoutUsedForSelection, false);
  assert.equal(result.selectionContract.overlayHoldoutUsedForSelection, false);
  assert.equal(result.selectionContract.designTestUsedForSelection, false);
  assert.ok(KR_MOMENTUM_SIGNAL_CANDIDATE.overlaySearch.grossExposureFraction.includes(result.selectedGrossExposureFraction));
  assert.equal(result.safeguards.liveExecutionAllowed, false);
  assert.equal(result.safeguards.actualOrders, 0);
});

test("optimizer rejects any attempt to reuse the prior momentum research universe", () => {
  const designSymbols = [...KR_MOMENTUM_SIGNAL_CANDIDATE.overlayDesignSymbols];
  designSymbols[0] = KR_MOMENTUM_SIGNAL_CANDIDATE.priorResearchSymbols[0];
  const designDatasets = makeRegistered(designSymbols);
  const holdoutDatasets = makeRegistered(KR_MOMENTUM_SIGNAL_CANDIDATE.overlayHoldoutSymbols);
  assert.throws(() => optimizeKrMomentumExposureOverlay({ designDatasets, holdoutDatasets }), /must not reuse prior KR research symbols/);
});
