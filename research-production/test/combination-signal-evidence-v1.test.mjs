import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RESEARCH_LANES_V2 } from '../src/autonomous-research-discovery-v2.mjs';
import { COMBINATION_ATOM_LIBRARY_VERSION } from '../src/combination-atoms-v1.mjs';
import {
  buildCombinationSignalEvidenceV1,
  combinationSignalEvidencePathV1,
  combinationSignalRulesForLaneV1,
  writeCombinationSignalEvidenceV1,
} from '../src/combination-signal-evidence-v1.mjs';

const SHA = 'c'.repeat(40);
const KR = RESEARCH_LANES_V2.find((lane) => lane.id === 'KR_STOCK_LONG');
const SPOT = RESEARCH_LANES_V2.find((lane) => lane.id === 'CRYPTO_SPOT_LONG');
const SHORT = RESEARCH_LANES_V2.find((lane) => lane.id === 'CRYPTO_FUTURES_SHORT');

function laneState({ holdoutPass = true, validationMean = 0.006, holdoutMean = 0.004 } = {}) {
  const base = { status: 'WATCH', exitId: 'X1', validation: { trades: 60, profitFactor: 1.6, meanReturn: validationMean, winRate: 0.6 },
    symbolBreadth: 1, walkForward: { positiveWindows: 4 } };
  const trials = { a: { ...base, trialId: 'a', atoms: ['T_SMA20_ABOVE_SMA50', 'P_DONCHIAN20_BREAKOUT'], pValue: 0.0001 } };
  for (let k = 0; k < 10; k += 1) trials[`r${k}`] = { ...base, trialId: `r${k}`, atoms: ['T_SMA20_ABOVE_SMA50'], status: 'REJECT', pValue: 1 };
  return {
    atomLibraryVersion: COMBINATION_ATOM_LIBRARY_VERSION,
    symbolKey: '069500,229200,005930,000660,035420|1825d',
    baselines: { X1: { validation: { meanReturn: 0.001 } } },
    trials,
    holdout: { a: { pass: holdoutPass, result: { trades: 15, meanReturn: holdoutMean, winRate: 0.6 }, period: { start: '2026-01-01', end: '2026-08-09' } } },
  };
}

test('only holdout-passed survivors become scanner rules, with the conservative edge', () => {
  const [rule] = combinationSignalRulesForLaneV1({ lane: KR, laneState: laneState() });
  assert.equal(rule.market, 'KR_STOCK');
  assert.equal(rule.direction, 'BUY');
  assert.equal(rule.scannerTimeframe, '1D');
  assert.equal(rule.edgeR, 0.4); // min(0.6%, 0.4%) / 1% risk
  assert.equal(rule.sampleSize, 75);
  assert.equal(rule.costPolicy.taxPercent, 0.15);
  assert.equal(rule.executionAuthority, 'NONE');
  assert.equal(combinationSignalRulesForLaneV1({ lane: KR, laneState: laneState({ holdoutPass: false }) }).length, 0);
  assert.equal(combinationSignalRulesForLaneV1({ lane: KR, laneState: { ...laneState(), holdout: {} } }).length, 0);
  assert.equal(combinationSignalRulesForLaneV1({ lane: KR, laneState: { ...laneState(), atomLibraryVersion: 'old' } }).length, 0);
});

test('directions map to scanner lists: cash = BUY, futures keep LONG/SHORT', () => {
  assert.equal(combinationSignalRulesForLaneV1({ lane: SPOT, laneState: laneState() })[0].direction, 'BUY');
  assert.equal(combinationSignalRulesForLaneV1({ lane: SHORT, laneState: laneState() })[0].direction, 'SHORT');
  assert.equal(combinationSignalRulesForLaneV1({ lane: SHORT, laneState: laneState() })[0].scannerTimeframe, '60m');
});

test('evidence file is built from every lane state and carries no authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'combo-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'combination-research', 'lanes', 'KR_STOCK_LONG'), { recursive: true });
  await writeFile(join(root, 'combination-research', 'lanes', 'KR_STOCK_LONG', 'state.json'), JSON.stringify(laneState()));
  const evidence = await buildCombinationSignalEvidenceV1({ stateRoot: root, researchCodeSha: SHA, observedAt: '2026-10-15T12:00:00.000Z' });
  assert.equal(evidence.rules.length, 1);
  assert.equal(evidence.safety.executionAuthority, 'NONE');
  await writeCombinationSignalEvidenceV1(root, evidence);
  const read = JSON.parse(await readFile(combinationSignalEvidencePathV1(root), 'utf8'));
  assert.equal(read.contract, 'combination-signal-evidence/v1');
  assert.equal(read.researchCodeSha, SHA);
});
