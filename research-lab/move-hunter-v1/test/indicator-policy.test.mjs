import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INDICATOR_RUNNER_STATES,
  classifyCanonicalIndicatorRunnerState,
  buildIndicatorRunnerControlByTs,
} from '../src/indicator-policy.mjs';

function snapshot(overrides = {}) {
  return {
    status: 'READY_FOR_SPECIALIST_RESEARCH_ONLY',
    decisionTime: 1_700_000_000_000,
    contentDigest: 'a'.repeat(64),
    decisionAuthority: 'EVIDENCE_ONLY',
    executionAuthority: 'NONE',
    features: {
      trend: {
        emaDirection: 'UP',
        emaFastSlopePctPerBar: 0.003,
        emaSlowSlopePctPerBar: 0.001,
        adx: 32,
        adxDirection: 'UP',
        structureTrend: 'BULLISH',
      },
      momentum: {
        roc: 0.08,
        rsi: 66,
        macdHistogramPct: 0.003,
        momentumAcceleration: 0.01,
        relativeStrengthRoc: 0.05,
      },
      volume: {
        relativeVolume: 1.8,
        signedVolumeBalance: 0.35,
        priceVolumeDisagreement: false,
      },
      volatility: {
        rangeState: 'EXPANSION',
      },
      priceAction: {
        structureTrend: 'BULLISH',
      },
    },
    ...overrides,
  };
}

test('strong independent indicator families widen runner to acceleration state', () => {
  const result = classifyCanonicalIndicatorRunnerState(snapshot());
  assert.equal(result.state, INDICATOR_RUNNER_STATES.ACCELERATION);
  assert.equal(result.trailAtrMult, 4);
  assert.equal(result.exitNextOpen, false);
  assert.equal(result.automaticEntryAuthority, false);
  assert.equal(result.executionAuthority, 'NONE');
});

test('multiple weakening signals tighten but do not force same-close exit', () => {
  const s = snapshot();
  s.features.momentum.roc = -0.01;
  s.features.momentum.macdHistogramPct = -0.001;
  s.features.momentum.momentumAcceleration = -0.02;
  const result = classifyCanonicalIndicatorRunnerState(s);
  assert.equal(result.state, INDICATOR_RUNNER_STATES.WARNING);
  assert.equal(result.trailAtrMult, 2);
  assert.equal(result.exitNextOpen, false);
});

test('opposite structure invalidates and schedules next-open exit', () => {
  const s = snapshot();
  s.features.trend.structureTrend = 'BEARISH';
  s.features.priceAction.structureTrend = 'BEARISH';
  const result = classifyCanonicalIndicatorRunnerState(s);
  assert.equal(result.state, INDICATOR_RUNNER_STATES.INVALID);
  assert.equal(result.exitNextOpen, true);
  assert.equal(result.trailAtrMult, 1.5);
});

test('short direction mirrors trend and momentum semantics', () => {
  const s = snapshot();
  s.features.trend.emaDirection = 'DOWN';
  s.features.trend.emaFastSlopePctPerBar = -0.003;
  s.features.trend.emaSlowSlopePctPerBar = -0.001;
  s.features.trend.adxDirection = 'DOWN';
  s.features.trend.structureTrend = 'BEARISH';
  s.features.priceAction.structureTrend = 'BEARISH';
  s.features.momentum.roc = -0.08;
  s.features.momentum.rsi = 34;
  s.features.momentum.macdHistogramPct = -0.003;
  s.features.momentum.momentumAcceleration = -0.01;
  s.features.momentum.relativeStrengthRoc = -0.05;
  s.features.volume.signedVolumeBalance = -0.35;
  const result = classifyCanonicalIndicatorRunnerState(s, { direction: 'SHORT' });
  assert.equal(result.state, INDICATOR_RUNNER_STATES.ACCELERATION);
  assert.equal(result.trailAtrMult, 4);
});

test('timeline is keyed by closed candle timestamp and preserves no trading authority', () => {
  const a = snapshot();
  const b = snapshot({ decisionTime: a.decisionTime + 60_000 });
  b.features.momentum = { ...b.features.momentum, roc: -0.01, macdHistogramPct: -0.001, momentumAcceleration: -0.01 };
  const timeline = buildIndicatorRunnerControlByTs({
    snapshots: [
      { ts: a.decisionTime, snapshot: a },
      { ts: b.decisionTime, snapshot: b },
    ],
  });
  assert.equal(timeline[String(a.decisionTime)].state, INDICATOR_RUNNER_STATES.ACCELERATION);
  assert.equal(timeline[String(b.decisionTime)].state, INDICATOR_RUNNER_STATES.WARNING);
  assert.equal(timeline[String(b.decisionTime)].executionAuthority, 'NONE');
});
