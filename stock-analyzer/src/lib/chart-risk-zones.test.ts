import test from 'node:test';
import assert from 'node:assert/strict';
import type { AnalysisPricePlan } from './analysis-selection';
import { buildEvidenceBackedRiskZones } from './chart-risk-zones';

function plan(overrides: Partial<AnalysisPricePlan> = {}): AnalysisPricePlan {
  return {
    entryZone: { from: 100, to: 102 },
    stopLoss: 95,
    invalidation: 92,
    targets: [108, 112],
    riskReward: 2,
    ...overrides,
  };
}

test('long risk zones reuse only existing entry, stop, and invalidation boundaries', () => {
  const zones = buildEvidenceBackedRiskZones(plan(), 'BUY');
  assert.deepEqual([zones.entry.from, zones.entry.to], [100, 102]);
  assert.deepEqual([zones.caution.from, zones.caution.to], [95, 100]);
  assert.deepEqual([zones.invalidation.from, zones.invalidation.to], [92, 95]);
  assert.equal(zones.entry.source, 'PRICE_PLAN');
  assert.equal(zones.caution.source, 'PRICE_PLAN');
  assert.equal(zones.invalidation.source, 'PRICE_PLAN');
});

test('short risk zones mirror the risk-side ordering without generating new levels', () => {
  const zones = buildEvidenceBackedRiskZones(plan({
    entryZone: { from: 100, to: 102 },
    stopLoss: 106,
    invalidation: 109,
  }), 'SHORT');
  assert.deepEqual([zones.entry.from, zones.entry.to], [100, 102]);
  assert.deepEqual([zones.caution.from, zones.caution.to], [102, 106]);
  assert.deepEqual([zones.invalidation.from, zones.invalidation.to], [106, 109]);
});

test('missing price plan fails every zone closed', () => {
  const zones = buildEvidenceBackedRiskZones(null, 'BUY');
  assert.equal(zones.entry.state, 'UNAVAILABLE');
  assert.equal(zones.caution.state, 'UNAVAILABLE');
  assert.equal(zones.invalidation.state, 'UNAVAILABLE');
  assert.equal(zones.entry.from, null);
  assert.equal(zones.invalidation.to, null);
});

test('missing direction preserves entry evidence but refuses directional risk shading', () => {
  const zones = buildEvidenceBackedRiskZones(plan(), 'NONE');
  assert.equal(zones.entry.state, 'READY');
  assert.equal(zones.caution.state, 'UNAVAILABLE');
  assert.equal(zones.invalidation.state, 'UNAVAILABLE');
});

test('stop on the wrong side of entry does not become a caution zone', () => {
  const zones = buildEvidenceBackedRiskZones(plan({ stopLoss: 105, invalidation: 92 }), 'LONG');
  assert.equal(zones.caution.state, 'UNAVAILABLE');
  assert.deepEqual([zones.invalidation.from, zones.invalidation.to], [92, 92]);
});

test('invalid or non-positive boundaries remain unavailable', () => {
  const zones = buildEvidenceBackedRiskZones(plan({
    entryZone: { from: -1, to: 102 },
    stopLoss: Number.NaN,
    invalidation: 0,
  }), 'BUY');
  assert.equal(zones.entry.state, 'UNAVAILABLE');
  assert.equal(zones.caution.state, 'UNAVAILABLE');
  assert.equal(zones.invalidation.state, 'UNAVAILABLE');
});
