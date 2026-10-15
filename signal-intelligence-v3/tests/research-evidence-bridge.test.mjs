import assert from 'node:assert/strict';
import test from 'node:test';

import { computeCombinationAtomsV1 } from '../../research-production/src/combination-atoms-v1.mjs';
import { adaptCanonicalScannerCard } from '../src/canonical-adapter.mjs';
import { runSignalIntelligenceV3 } from '../src/engine.mjs';
import {
  closedCandles,
  matchResearchRules,
  researchAdapterInputForCard,
  researchInputsForCards,
  validateResearchEvidence,
} from '../src/research-evidence-bridge.mjs';

const SHA = 'b'.repeat(40);
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-15T12:00:00.000Z');

function dailyCandles(count = 300) {
  // Steady uptrend with gentle oscillation; last bar is yesterday's session.
  const lastOpen = Date.parse('2026-10-14T00:00:00.000Z');
  return Array.from({ length: count }, (_, i) => {
    const base = 100 + (i * 0.4) + (Math.sin(i / 3) * 1.5);
    return { timestamp: lastOpen - ((count - 1 - i) * DAY), open: base - 0.3, high: base + 1.2, low: base - 1.1, close: base + 0.4, volume: 1_000 + ((i * 37) % 500) };
  });
}

function firingAtoms(candles) {
  const atoms = computeCombinationAtomsV1(candles, { timeframe: '1d' });
  const index = candles.length - 1;
  const on = [...atoms.entries()].filter(([, values]) => values[index] === 1).map(([id]) => id);
  const off = [...atoms.entries()].filter(([, values]) => values[index] !== 1).map(([id]) => id);
  return { on, off };
}

function rule(atoms, overrides = {}) {
  return {
    ruleId: 'r1', laneId: 'KR_STOCK_LONG', market: 'KR_STOCK', direction: 'BUY', researchTimeframe: '1d', scannerTimeframe: '1D',
    atoms, labels: atoms, exitId: 'X1', stopAtrMultiple: 1.5, targetRiskMultiple: 2, horizonBars: 10,
    strategyId: 'COMBINATION_RESEARCH', strategyVersion: 'COMBINATION:r1', parameterHash: 'f'.repeat(64),
    costPolicy: { id: 'COMBINATION_KR_STOCK_COST_V1', market: 'KR_STOCK', source: 'EXPLICIT_RUNTIME_POLICY', commissionPercent: 0.03,
      taxPercent: 0.15, spreadPercent: 0.05, slippagePercent: 0.1, fundingPercent: 0, latencyPercent: 0, liquidityImpactPercent: 0, partialFillImpactPercent: 0 },
    fundingModelled: false, edgeR: 0.5, sampleSize: 80, qValue: 0.03,
    validation: { trades: 60, meanReturn: 0.00686, winRate: 0.67 }, holdout: { trades: 20, meanReturn: 0.005, winRate: 0.6 },
    researchSymbols: ['069500'], executionAuthority: 'NONE', ...overrides,
  };
}

function evidence(rules, generatedAt = '2026-10-15T11:50:00.000Z') {
  return { schemaVersion: 1, contract: 'combination-signal-evidence/v1', generatedAt, researchCodeSha: SHA, rules,
    safety: { researchEvidenceOnly: true, liveTrading: false, realOrder: false, executionAuthority: 'NONE' } };
}

function card(overrides = {}) {
  return {
    signalId: 'sig-kr-1', symbol: '005930', assetClass: 'stock', market: 'KR', action: 'BUY', direction: 'LONG',
    signalGrade: 'S', strongSignalEligible: true, riskLevel: 'LOW', dataState: 'complete',
    observedAt: '2026-10-15T11:59:00.000Z', expiresAt: '2026-10-16T11:59:00.000Z',
    price: 220, pricePlan: { entryZone: { from: 219, to: 221 }, stopLoss: 212, targets: [235] }, ...overrides,
  };
}

test('evidence is fail-closed: contract, safety, sha and freshness', () => {
  const candles = dailyCandles();
  const { on } = firingAtoms(candles);
  assert.equal(validateResearchEvidence(evidence([rule(on.slice(0, 2))]), NOW).rules.length, 1);
  assert.equal(validateResearchEvidence({ ...evidence([]), contract: 'x' }, NOW).blocker, 'RESEARCH_EVIDENCE_CONTRACT_INVALID');
  assert.equal(validateResearchEvidence({ ...evidence([]), safety: { executionAuthority: 'FULL', realOrder: true } }, NOW).blocker, 'RESEARCH_EVIDENCE_SAFETY_INVALID');
  assert.equal(validateResearchEvidence(evidence([], '2026-10-14T00:00:00.000Z'), NOW).blocker, 'RESEARCH_EVIDENCE_STALE');
  // Invalid rules are dropped, not repaired.
  const bad = [rule(on.slice(0, 2), { edgeR: 0 }), rule(on.slice(0, 2), { executionAuthority: 'LIVE' }),
    rule(on.slice(0, 2), { market: 'CRYPTO_SPOT', scannerTimeframe: '60m' })];
  assert.equal(validateResearchEvidence(evidence(bad), NOW).rules.length, 0);
});

test('an unclosed daily candle is never used', () => {
  const candles = dailyCandles();
  const today = { ...candles.at(-1), timestamp: Date.parse('2026-10-15T00:00:00.000Z') };
  assert.equal(closedCandles([...candles, today], '1D', Date.parse('2026-10-15T05:00:00.000Z')).length, candles.length);
  assert.equal(closedCandles([...candles, today], '1D', Date.parse('2026-10-15T07:00:00.000Z')).length, candles.length + 1);
});

test('a rule supplies profit evidence only when every condition fires on the latest closed bar', () => {
  const candles = dailyCandles();
  const { on, off } = firingAtoms(candles);
  assert.ok(on.length >= 2 && off.length >= 1, 'fixture needs firing and non-firing atoms');
  const valid = validateResearchEvidence(evidence([rule(on.slice(0, 2)), rule([on[0], off[0]], { ruleId: 'r2' })]), NOW);
  const result = matchResearchRules(valid.rules, candles, { timeframe: '1D', nowMs: NOW });
  assert.equal(result.status, 'EVALUATED');
  assert.deepEqual(result.matches.map((m) => m.rule.ruleId), ['r1']);
  const match = result.matches[0];
  assert.ok(match.plan.stopLoss < match.reference && match.plan.target > match.reference);

  const input = researchAdapterInputForCard(card(), '1D', match);
  assert.equal(input.validationTier, 'RESEARCH_CANDIDATE');
  assert.equal(input.paperIdentity.executionAuthority, 'NONE');
  // Net edge in price % = edgeR x research stop % minus KR tax once more.
  assert.equal(input.profitEvidence.expectedNetEdge, Number(((0.5 * match.stopPercent) - 0.15).toFixed(6)));

  const adapted = adaptCanonicalScannerCard(input, { nowMs: NOW });
  assert.equal(adapted.profitEligible, true, JSON.stringify(adapted.provenance.profitBlockers));
  const snapshot = runSignalIntelligenceV3([adapted]);
  assert.equal(snapshot.lists.krBuy.length, 1);
  assert.equal(snapshot.lists.krBuy[0].validationTier, 'RESEARCH_CANDIDATE');
});

test('mismatched market, direction, timeframe or a non-positive edge gives nothing', () => {
  const candles = dailyCandles();
  const { on } = firingAtoms(candles);
  const [match] = matchResearchRules(validateResearchEvidence(evidence([rule(on.slice(0, 2))]), NOW).rules, candles, { timeframe: '1D', nowMs: NOW }).matches;
  assert.equal(researchAdapterInputForCard(card({ market: 'US' }), '1D', match), null);
  assert.equal(researchAdapterInputForCard(card({ action: 'SELL' }), '1D', match), null);
  assert.equal(researchAdapterInputForCard(card(), '60m', match), null);
  const tiny = { ...match, rule: { ...match.rule, edgeR: 0.0001 } };
  assert.equal(researchAdapterInputForCard(card(), '1D', tiny), null);
});

test('stale candles block matching', () => {
  const candles = dailyCandles();
  const { on } = firingAtoms(candles);
  const rules = validateResearchEvidence(evidence([rule(on.slice(0, 2))]), NOW).rules;
  assert.equal(matchResearchRules(rules, candles, { timeframe: '1D', nowMs: NOW + (10 * DAY) }).status, 'STALE_CANDLES');
});

test('batch evaluation is bounded and counts matches per grade', async () => {
  const candles = dailyCandles();
  const { on } = firingAtoms(candles);
  const valid = validateResearchEvidence(evidence([rule(on.slice(0, 2))]), NOW);
  let calls = 0;
  const loader = async () => { calls += 1; return candles; };
  const cards = [card(), card({ signalId: 'a', symbol: '000660', signalGrade: 'A' }), card({ signalId: 'b', symbol: '035420', signalGrade: 'B' })];
  const out = await researchInputsForCards(cards, { market: 'KR_STOCK', timeframe: '1D', evidence: valid, nowMs: NOW, candleLoader: loader, maximumFetches: 8 });
  assert.equal(calls, 2); // B grade is never fetched
  assert.deepEqual(out.diagnostics.matchedByGrade, { S: 1, A: 1 });
  assert.ok(out.inputs.get('sig-kr-1'));
  const capped = await researchInputsForCards(cards, { market: 'KR_STOCK', timeframe: '1D', evidence: valid, nowMs: NOW, candleLoader: loader, maximumFetches: 1 });
  assert.equal(capped.diagnostics.skippedBudget, 1);
  const none = await researchInputsForCards(cards, { market: 'US_STOCK', timeframe: '1D', evidence: valid, nowMs: NOW, candleLoader: loader });
  assert.equal(none.diagnostics.rules, 0);
});

test('a research-backed candidate is never admitted to automatic trading handoff', async () => {
  const { selectSignalAdmittedHandoffEntries } = await import('../src/auto-trading-handoff-bridge.mjs');
  const candles = dailyCandles();
  const { on } = firingAtoms(candles);
  const [match] = matchResearchRules(validateResearchEvidence(evidence([rule(on.slice(0, 2))]), NOW).rules, candles, { timeframe: '1D', nowMs: NOW }).matches;
  const adapted = adaptCanonicalScannerCard(researchAdapterInputForCard(card(), '1D', match), { nowMs: NOW });
  const snapshot = { ...runSignalIntelligenceV3([adapted], { nowMs: NOW }), serviceSha: SHA, publicDataOnly: true, rosterBindingVersion: 1 };
  assert.equal(snapshot.lists.krBuy.length, 1);
  // A canonical handoff for the same symbol but a forward-validated strategy identity.
  const handoff = { status: 'READY', entries: [{ identity: { signalId: 'sig-kr-1', market: 'KR_STOCK', symbol: '005930', timeframe: '1D', direction: 'BUY',
    strategyId: 'forward_strategy', strategyVersion: 'v1', parameterHash: 'p', researchCodeSha: 'a'.repeat(40), costPolicyVersion: 'c', executionAuthority: 'NONE' } }] };
  const selected = selectSignalAdmittedHandoffEntries({ handoff, snapshot: { ...snapshot, generatedAt: new Date(NOW).toISOString() }, nowMs: NOW, expectedServiceSha: SHA });
  assert.equal(selected.entries.length, 0);
});
