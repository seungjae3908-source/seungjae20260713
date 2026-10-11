import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { researchOwnerMarketCriteria, researchOwnerExposureBounds, buildOwnerApprovedReferenceDsl } from '../src/research-owner-criteria.mjs';
import { createSafeStrategyDslV1 } from '../../market-prediction-lab/src/autonomous-strategy-formula-generator-v1.js';

test('owner scope permits only 1x LONG in stocks and spot, and 7x LONG/SHORT in futures', () => {
  for (const market of ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT']) {
    const c = researchOwnerMarketCriteria(market, 'LONG');
    assert.equal(c.requestedLeverage, 1); assert.equal(c.maximumLeverage, 1);
    assert.throws(() => researchOwnerMarketCriteria(market, 'SHORT'), /NOT_APPROVED/);
  }
  for (const direction of ['LONG', 'SHORT']) {
    const c = researchOwnerMarketCriteria('CRYPTO_FUTURES', direction);
    assert.equal(c.requestedLeverage, 7); assert.equal(c.maximumLeverage, 7);
    assert.equal(c.entryOperator, direction === 'SHORT' ? 'CROSSUNDER' : 'CROSSOVER');
    assert.equal(c.executionAuthority, 'NONE'); assert.equal(c.orderAllowed, false);
    assert.equal(c.fastEmaPeriod, 20); assert.equal(c.slowEmaPeriod, 60); assert.equal(c.timeExitBars, 4);
  }
  assert.throws(() => researchOwnerMarketCriteria('UNKNOWN', 'LONG'));
  assert.throws(() => researchOwnerMarketCriteria('CRYPTO_FUTURES', 'BUY'));
});

test('approved reference compiles for exactly five market/direction pairs, without search or evidence authority', () => {
  for (const [market, direction] of [['KR_STOCK', 'LONG'], ['US_STOCK', 'LONG'], ['CRYPTO_SPOT', 'LONG'], ['CRYPTO_FUTURES', 'LONG'], ['CRYPTO_FUTURES', 'SHORT']]) {
    const raw = buildOwnerApprovedReferenceDsl(market, direction);
    const dsl = createSafeStrategyDslV1(raw);
    assert.equal(dsl.market, market); assert.equal(dsl.direction, direction);
    assert.equal(dsl.timeframe, '15m');
    assert.equal(dsl.entryDsl.rules[0].operator, direction === 'SHORT' ? 'CROSSUNDER' : 'CROSSOVER');
    for (const parameter of raw.parameterSpace) assert.equal(parameter.min, parameter.max);
    assert.equal(raw.parameterSpace.find(p => p.name === 'fast').min, 20);
    assert.equal(raw.parameterSpace.find(p => p.name === 'slow').min, 60);
    assert.equal(raw.parameterSpace.find(p => p.name === 'holding').min, 4);
    assert.equal(raw.parameterSpace.find(p => p.name === 'stop').min, 0.01);
    assert.equal('leverage' in raw, false, 'leverage must stay in canonical risk sizing, not the DSL');
    assert.equal('dataset' in raw, false); assert.equal('backtest' in raw, false);
  }
  for (const market of ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT']) assert.throws(() => buildOwnerApprovedReferenceDsl(market, 'SHORT'));
});

test('7x never expands exposure beyond the approved 0.5% capital risk bound', () => {
  const bounds = researchOwnerExposureBounds('CRYPTO_FUTURES', 'SHORT', 1_000_000);
  assert.equal(bounds.maximumRiskKrw, 5_000);
  assert.equal(bounds.maximumNotionalKrw, 500_000);
  assert.equal(bounds.maximumMarginKrw, 500_000 / 7);
  assert.equal(bounds.isExecutableSizingReceipt, false);
  assert.equal(bounds.feesAndSlippageNotIncluded, true);
  assert.equal(researchOwnerExposureBounds('KR_STOCK', 'LONG', 1_000_000).maximumNotionalKrw, 250_000);
  for (const value of [0, -1, NaN, Infinity]) assert.throws(() => researchOwnerExposureBounds('CRYPTO_FUTURES', 'LONG', value));
});

test('approval artifact matches market rules but grants no fabricated runtime evidence', () => {
  const p = JSON.parse(readFileSync(new URL('../../docs/research-center-criteria-draft.json', import.meta.url)));
  assert.equal(p.approval.channel, 'DIRECT_HUMAN_CONVERSATION');
  assert.equal(p.runtimeActivationAllowed, false); assert.equal(p.evidenceCredit, 0);
  assert.equal(p.approval.githubApprovalCommentId, null);
  for (const [market, rule] of Object.entries(p.proposedPaperRisk.marketRules)) {
    for (const direction of rule.directions) {
      const c = researchOwnerMarketCriteria(market, direction);
      assert.equal(rule.requestedLeverage, c.requestedLeverage);
      assert.equal(rule.maximumLeverage, c.maximumLeverage);
    }
  }
});
